// Vue par ASIN : liste avec chiffres clés et fiche avec tout l'historique.
import { ErreurMetier } from '../db.js';
import { arrondir } from '../lib/parse.js';
import { estConfirme, STATUTS_DOSSIER } from './autorisations.js';
import { STATUTS_ENVOI } from './envois.js';
import { depensesFacturesParAsin, partFactureAsin, totalFacture } from './factures.js';
import { coutComplet, coutRetenu, historiqueCouts, LIBELLES_SOURCE_COUT, TYPES_DEPENSE } from './couts.js';
import { emailsPourAsin } from './emails.js';
import { bilanStock, etatStock, historiqueStockAsin } from './inventaire.js';

// Unités achetées = articles des factures non annulées ; reçues = quantités confirmées par Amazon.
const SQL_QUANTITES = `
  (SELECT COALESCE(SUM(fl.quantite), 0) FROM facture_lignes fl JOIN factures f ON f.id = fl.facture_id
     WHERE fl.asin = p.asin AND f.annulee = 0) AS unites_achetees,
  (SELECT COALESCE(SUM(el.quantite), 0) FROM envoi_lignes el JOIN envois e ON e.id = el.envoi_id
     WHERE el.asin = p.asin AND e.statut <> 'en_preparation') AS unites_envoyees,
  (SELECT COALESCE(SUM(el.quantite_recue), 0) FROM envoi_lignes el WHERE el.asin = p.asin) AS unites_recues_amazon,
  (SELECT COALESCE(SUM(el.quantite), 0) FROM envoi_lignes el JOIN envois e ON e.id = el.envoi_id
     WHERE el.asin = p.asin AND e.statut <> 'en_preparation' AND el.quantite_recue IS NULL) AS unites_en_transit,
  (SELECT MAX(COALESCE(f.date_facture, date(f.created_at))) FROM facture_lignes fl JOIN factures f ON f.id = fl.facture_id
     WHERE fl.asin = p.asin AND f.annulee = 0) AS derniere_facture`;

// ASIN jamais présent dans un import d'inventaire : stock 0.
const STOCK_VIDE = { quantite: 0, precedente: null, ecart: null, absent: true };
// ASIN sans facture associée.
const DEPENSES_VIDES = { montant: 0, ht: 0, frais: 0, unites: 0, nb_factures: 0, estimee: false, cout_moyen_unite: null };

const BILAN_VIDE = { initial: 0, envois_apres_initial: 0, restock_non_saisi: 0, vendues: 0, en_transit: 0 };

/**
 * Stock total d'un ASIN, chaque unité comptée une seule fois :
 *   chez Amazon = dernier import (photo complète, remplace la précédente) ;
 *   en transit  = envois expédiés depuis le dernier import ;
 *   sorties de chez vous = stock initial (1er import) + envois enregistrés après lui
 *                          + restocks non saisis (hausses sans envoi) + en transit ;
 *   à envoyer   = unités achetées (factures non annulées) − sorties (jamais négatif) ;
 *   total       = chez Amazon + en transit + à envoyer.
 * Chez Amazon au-delà des achats : une facture manque probablement (signalé).
 */
export function stockTotal(p, stockAmazon, b = BILAN_VIDE) {
  const amazon = stockAmazon.quantite;
  const achetees = p.unites_achetees;
  const sorties = b.initial + b.envois_apres_initial + b.restock_non_saisi + b.en_transit;
  const aEnvoyer = Math.max(0, achetees - sorties);
  return {
    amazon,
    en_transit: b.en_transit,
    a_envoyer: aEnvoyer,
    total: amazon + b.en_transit + aEnvoyer,
    achetees,
    stock_initial: b.initial,
    vendues: b.vendues,
    restocks: b.envois_apres_initial + b.restock_non_saisi,
    incoherent: achetees > 0 && amazon > achetees,
  };
}

export function listerAsins(db) {
  const stock = etatStock(db);
  const bilan = bilanStock(db);
  const depenses = depensesFacturesParAsin(db);
  const dernierDossier = db.prepare('SELECT * FROM dossiers_autorisation WHERE asin = ? ORDER BY id DESC LIMIT 1');
  const nbEmails = db.prepare(
    `SELECT COUNT(DISTINCT e.id) AS n FROM emails e
     LEFT JOIN email_liens l ON l.email_id = e.id AND l.type = 'asin' AND l.valeur = ?
     LEFT JOIN dossiers_autorisation d ON d.id = e.dossier_id AND d.asin = ?
     WHERE l.id IS NOT NULL OR d.id IS NOT NULL`,
  );
  return db
    .prepare(
      `SELECT p.*, c.montant_unitaire_ht AS cout_retenu, c.source AS source_cout, ${SQL_QUANTITES}
       FROM produits p LEFT JOIN couts_achat c ON c.id = p.cout_retenu_id
       ORDER BY derniere_facture DESC NULLS LAST, p.asin`,
    )
    .all()
    .map((p) => {
      const d = dernierDossier.get(p.asin);
      const stockAmazon = stock.parAsin.get(p.asin) || STOCK_VIDE;
      return {
        ...p,
        stock: stockAmazon,
        stock_total: stockTotal(p, stockAmazon, bilan.get(p.asin)),
        depenses_factures: depenses.get(p.asin) || DEPENSES_VIDES,
        autorisation: d ? { dossier_id: d.id, statut: d.statut, confirme: estConfirme(d), numero_cas: d.numero_cas } : null,
        nb_emails: nbEmails.get(p.asin, p.asin).n,
      };
    });
}

/** Date d'un coût : celle de sa facture (ou de son import d'origine), sinon sa date de saisie. */
function dateCout(db, h) {
  if (h.facture_id) {
    const f = db.prepare('SELECT date_facture FROM factures WHERE id = ?').get(h.facture_id);
    if (f?.date_facture) return f.date_facture;
  }
  if (h.commande_id) {
    const c = db.prepare('SELECT date_commande FROM commandes WHERE id = ?').get(h.commande_id);
    if (c?.date_commande) return c.date_commande;
  }
  return String(h.created_at).slice(0, 10);
}

/** Tout ce qui concerne un ASIN, avec une chronologie unifiée. */
export function ficheAsin(db, asin) {
  const produit = db.prepare(`SELECT p.*, ${SQL_QUANTITES} FROM produits p WHERE p.asin = ?`).get(asin);
  if (!produit) throw new ErreurMetier('ASIN inconnu.', 404);

  // Factures contenant l'ASIN (les factures annulées restent visibles dans l'historique).
  const factures = db
    .prepare(
      `SELECT DISTINCT f.*, (SELECT d.id FROM facture_documents d WHERE d.facture_id = f.id) AS document_id,
         (SELECT json_extract(d.extraction, '$.fournisseur') FROM facture_documents d WHERE d.facture_id = f.id) AS fournisseur
       FROM factures f JOIN facture_lignes fl ON fl.facture_id = f.id AND fl.asin = ?
       ORDER BY COALESCE(f.date_facture, date(f.created_at)) DESC`,
    )
    .all(asin)
    .map((f) => {
      const lignes = db.prepare('SELECT id, asin, quantite, prix_unitaire_ht FROM facture_lignes WHERE facture_id = ? ORDER BY id').all(f.id);
      return {
        ...f,
        total_calcule: totalFacture(f),
        lignes_asin: lignes.filter((l) => l.asin === asin),
        autres_asins: [...new Set(lignes.filter((l) => l.asin !== asin).map((l) => l.asin))],
        part_asin: partFactureAsin(f, lignes, asin),
      };
    });

  const envois = db
    .prepare(
      `SELECT e.id, e.numero_envoi, e.statut, COALESCE(e.date_envoi, date(e.created_at)) AS date, e.date_reception, el.quantite, el.quantite_recue
       FROM envoi_lignes el JOIN envois e ON e.id = el.envoi_id
       WHERE el.asin = ? ORDER BY date DESC`,
    )
    .all(asin);

  const dossiers = db.prepare('SELECT * FROM dossiers_autorisation WHERE asin = ? ORDER BY id DESC').all(asin).map((d) => ({ ...d, confirme: estConfirme(d) }));
  const emails = emailsPourAsin(db, asin);
  const depenses = db.prepare('SELECT * FROM depenses WHERE asin = ? ORDER BY COALESCE(date_depense, date(created_at)) DESC').all(asin);
  const historique = historiqueCouts(db, asin);
  const historiqueStock = historiqueStockAsin(db, asin);

  // Chronologie unifiée
  const evenements = [
    ...factures.map((f) => ({
      date: f.date_facture || String(f.created_at).slice(0, 10),
      type: 'facture',
      libelle: `Facture ${f.numero_facture || '#' + f.id}${f.fournisseur ? ' · ' + f.fournisseur : ''}${f.annulee ? ' · annulée (remboursée)' : ''}`,
      detail: f.lignes_asin.map((l) => `${l.quantite} × ${l.prix_unitaire_ht ?? '?'} $ HT`).join(', '),
      lien: '#/factures',
    })),
    ...factures.filter((f) => f.annulee).map((f) => ({
      date: f.date_annulation,
      type: 'annulation',
      libelle: `Facture ${f.numero_facture || '#' + f.id} annulée par le fournisseur (remboursée)`,
      detail: f.motif_annulation || '',
      lien: '#/factures',
    })),
    ...envois.map((e) => ({
      date: e.date,
      type: 'envoi',
      libelle: `Envoi Amazon ${e.numero_envoi || '#' + e.id}`,
      detail: `${e.quantite} unité(s) envoyée(s) · ${STATUTS_ENVOI[e.statut] || e.statut}`,
      lien: `#/envois/${e.id}`,
    })),
    ...envois.filter((e) => e.quantite_recue !== null).map((e) => ({
      date: e.date_reception || e.date,
      type: 'reception',
      libelle: `Reçu par Amazon · envoi ${e.numero_envoi || '#' + e.id}`,
      detail: `${e.quantite_recue} / ${e.quantite} unité(s)${e.quantite_recue === e.quantite ? '' : ` · écart ${e.quantite_recue - e.quantite > 0 ? '+' : '−'}${Math.abs(e.quantite_recue - e.quantite)}`}`,
      lien: `#/envois/${e.id}`,
    })),
    ...historique.map((h) => ({
      date: dateCout(db, h),
      type: 'cout',
      libelle: `Coût d’achat : ${LIBELLES_SOURCE_COUT[h.source]}${h.reference ? ' · ' + h.reference : ''}`,
      detail: `${h.montant_unitaire_ht} $ HT / unité${h.retenu ? ' (retenu)' : ''}`,
      lien: null,
    })),
    ...dossiers.map((d) => ({
      date: d.date_demande || String(d.created_at).slice(0, 10),
      type: 'autorisation',
      libelle: `Dossier d’autorisation #${d.id}${d.numero_cas ? ' · cas ' + d.numero_cas : ''}`,
      detail: `${STATUTS_DOSSIER[d.statut] || d.statut}${d.confirme ? ' (confirmé)' : ''}`,
      lien: `#/dossiers/${d.id}`,
    })),
    ...emails.map((e) => ({
      date: String(e.date_reception || '').slice(0, 10),
      type: e.source === 'gmail' ? 'email_gmail' : 'email_neo',
      libelle: `${e.source === 'gmail' ? 'Gmail' : 'Neo'} · ${e.sujet || '(sans objet)'}`,
      detail: `${e.expediteur || ''} · ${e.via}`,
      lien: `#/emails/${e.source}?email=${e.id}`,
    })),
    ...historiqueStock.map((h, i) => ({
      date: String(h.date).slice(0, 10),
      type: 'stock',
      libelle: `${i === historiqueStock.length - 1 ? 'Stock initial' : 'Stock'} · import ${h.nom || '#' + h.import_id}`,
      detail: `${h.quantite} unité(s)${h.ecart === null ? '' : ` · ${h.ecart > 0 ? '+' : h.ecart < 0 ? '−' : ''}${Math.abs(h.ecart)} depuis l’import précédent`}`,
      lien: null,
    })),
    ...depenses.map((d) => ({ date: d.date_depense || String(d.created_at).slice(0, 10), type: 'depense', libelle: `Dépense : ${TYPES_DEPENSE[d.type]}`, detail: `${d.montant} $ pour ${d.quantite_concernee} unité(s)`, lien: '#/depenses' })),
  ].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  return {
    ...produit,
    stock: etatStock(db).parAsin.get(asin) || STOCK_VIDE,
    stock_total: stockTotal(produit, etatStock(db).parAsin.get(asin) || STOCK_VIDE, bilanStock(db).get(asin)),
    depenses_factures: depensesFacturesParAsin(db).get(asin) || DEPENSES_VIDES,
    historique_stock: historiqueStock,
    cout_retenu: coutRetenu(db, asin),
    cout_complet: coutComplet(db, asin),
    historique_couts: historique,
    factures,
    envois,
    dossiers,
    emails,
    depenses,
    evenements,
  };
}
