// Vue par ASIN : liste avec chiffres clés et fiche avec tout l'historique.
import { ErreurMetier } from '../db.js';
import { arrondir } from '../lib/parse.js';
import { estConfirme, STATUTS_DOSSIER } from './autorisations.js';
import { STATUTS_ENVOI } from './envois.js';
import { totalFacture } from './commandes.js';
import { coutComplet, coutRetenu, historiqueCouts, LIBELLES_SOURCE_COUT, TYPES_DEPENSE } from './couts.js';
import { emailsPourAsin } from './emails.js';

const SQL_QUANTITES = `
  (SELECT COALESCE(SUM(cl.quantite), 0) FROM commande_lignes cl WHERE cl.asin = p.asin) AS unites_commandees,
  (SELECT COALESCE(SUM(rl.quantite), 0) FROM reception_lignes rl WHERE rl.asin = p.asin) AS unites_recues,
  (SELECT COALESCE(SUM(el.quantite), 0) FROM envoi_lignes el JOIN envois e ON e.id = el.envoi_id
     WHERE el.asin = p.asin AND e.statut <> 'en_preparation') AS unites_envoyees,
  (SELECT COUNT(DISTINCT cl.commande_id) FROM commande_lignes cl WHERE cl.asin = p.asin) AS nb_commandes,
  (SELECT MAX(COALESCE(c.date_commande, date(c.created_at))) FROM commande_lignes cl JOIN commandes c ON c.id = cl.commande_id
     WHERE cl.asin = p.asin) AS derniere_commande`;

export function listerAsins(db) {
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
       ORDER BY derniere_commande DESC NULLS LAST, p.asin`,
    )
    .all()
    .map((p) => {
      const d = dernierDossier.get(p.asin);
      return {
        ...p,
        stock: p.unites_recues - p.unites_envoyees,
        valeur_achats_estimee: p.cout_retenu === null ? null : arrondir(p.cout_retenu * p.unites_commandees),
        autorisation: d ? { dossier_id: d.id, statut: d.statut, confirme: estConfirme(d), numero_cas: d.numero_cas } : null,
        nb_emails: nbEmails.get(p.asin, p.asin).n,
      };
    });
}

/** Date d'un coût : celle de sa facture ou de sa commande d'origine, sinon sa date de saisie. */
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

  const commandes = db
    .prepare(
      `SELECT c.id, c.numero_commande, COALESCE(c.date_commande, date(c.created_at)) AS date, c.total_declare, c.source,
         f.nom AS fournisseur, cl.id AS ligne_id, cl.quantite, cl.cout_unitaire_ht
       FROM commande_lignes cl JOIN commandes c ON c.id = cl.commande_id LEFT JOIN fournisseurs f ON f.id = c.fournisseur_id
       WHERE cl.asin = ? ORDER BY date DESC, c.id DESC`,
    )
    .all(asin);

  // Factures : lignes de facture de l'ASIN, et factures des commandes qui le contiennent.
  const factures = db
    .prepare(
      `SELECT DISTINCT f.*, c.numero_commande FROM factures f
       LEFT JOIN commandes c ON c.id = f.commande_id
       LEFT JOIN facture_lignes fl ON fl.facture_id = f.id AND fl.asin = ?
       LEFT JOIN commande_lignes cl ON cl.commande_id = f.commande_id AND cl.asin = ?
       WHERE fl.id IS NOT NULL OR cl.id IS NOT NULL
       ORDER BY COALESCE(f.date_facture, date(f.created_at)) DESC`,
    )
    .all(asin, asin)
    .map((f) => ({
      ...f,
      total_calcule: totalFacture(f),
      lignes_asin: db.prepare('SELECT quantite, prix_unitaire_ht FROM facture_lignes WHERE facture_id = ? AND asin = ?').all(f.id, asin),
    }));

  const receptions = db
    .prepare(
      `SELECT r.id, r.commande_id, COALESCE(r.date_reception, date(r.created_at)) AS date, rl.quantite, c.numero_commande
       FROM reception_lignes rl JOIN receptions r ON r.id = rl.reception_id JOIN commandes c ON c.id = r.commande_id
       WHERE rl.asin = ? ORDER BY date DESC`,
    )
    .all(asin);

  const envois = db
    .prepare(
      `SELECT e.id, e.numero_envoi, e.statut, COALESCE(e.date_envoi, date(e.created_at)) AS date, el.quantite, el.commande_id, c.numero_commande
       FROM envoi_lignes el JOIN envois e ON e.id = el.envoi_id LEFT JOIN commandes c ON c.id = el.commande_id
       WHERE el.asin = ? ORDER BY date DESC`,
    )
    .all(asin);

  const dossiers = db.prepare('SELECT * FROM dossiers_autorisation WHERE asin = ? ORDER BY id DESC').all(asin).map((d) => ({ ...d, confirme: estConfirme(d) }));
  const emails = emailsPourAsin(db, asin);
  const lignesSheets = db
    .prepare(
      `SELECT li.*, i.nom AS import_nom, c.numero_commande FROM lignes_import li JOIN imports i ON i.id = li.import_id
       LEFT JOIN commandes c ON c.id = li.commande_id WHERE li.asin = ? ORDER BY li.id DESC`,
    )
    .all(asin);
  const depenses = db.prepare('SELECT * FROM depenses WHERE asin = ? ORDER BY COALESCE(date_depense, date(created_at)) DESC').all(asin);
  const historique = historiqueCouts(db, asin);

  // Chronologie unifiée
  const evenements = [
    ...commandes.map((c) => ({
      date: c.date,
      type: 'commande',
      libelle: `Commande ${c.numero_commande || '#' + c.id}${c.fournisseur ? ' · ' + c.fournisseur : ''}`,
      detail: `${c.quantite} unité(s)${c.cout_unitaire_ht !== null ? ` à ${c.cout_unitaire_ht} $ HT` : ''}`,
      lien: `#/commandes/${c.id}`,
    })),
    ...factures.map((f) => ({
      date: f.date_facture || String(f.created_at).slice(0, 10),
      type: 'facture',
      libelle: `Facture ${f.numero_facture || '#' + f.id}${f.numero_commande ? ' · commande ' + f.numero_commande : ''}`,
      detail: f.lignes_asin.length
        ? f.lignes_asin.map((l) => `${l.quantite} × ${l.prix_unitaire_ht ?? '?'} $ HT`).join(', ')
        : `total facture ${f.total_calcule ?? '?'} $`,
      lien: f.commande_id ? `#/commandes/${f.commande_id}` : '#/factures',
    })),
    ...receptions.map((r) => ({ date: r.date, type: 'reception', libelle: `Réception · commande ${r.numero_commande || '#' + r.commande_id}`, detail: `${r.quantite} unité(s) reçue(s)`, lien: `#/commandes/${r.commande_id}` })),
    ...envois.map((e) => ({ date: e.date, type: 'envoi', libelle: `Envoi Amazon ${e.numero_envoi || '#' + e.id}`, detail: `${e.quantite} unité(s) · ${STATUTS_ENVOI[e.statut] || e.statut}`, lien: `#/envois/${e.id}` })),
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
    ...depenses.map((d) => ({ date: d.date_depense || String(d.created_at).slice(0, 10), type: 'depense', libelle: `Dépense : ${TYPES_DEPENSE[d.type]}`, detail: `${d.montant} $ pour ${d.quantite_concernee} unité(s)`, lien: '#/depenses' })),
    ...lignesSheets.map((l) => ({
      date: l.date_commande || null,
      type: 'sheets',
      libelle: `Google Sheets · ${l.import_nom} ligne ${l.numero_ligne}`,
      detail: `${l.quantite ?? '?'} unité(s) · ${l.statut === 'rattachee' ? 'commande ' + (l.numero_commande || '#' + l.commande_id) : l.statut}`,
      lien: '#/import-sheets',
    })),
  ].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  return {
    ...produit,
    stock: produit.unites_recues - produit.unites_envoyees,
    cout_retenu: coutRetenu(db, asin),
    cout_complet: coutComplet(db, asin),
    historique_couts: historique,
    commandes,
    factures,
    receptions,
    envois,
    dossiers,
    emails,
    lignes_sheets: lignesSheets,
    depenses,
    evenements,
  };
}
