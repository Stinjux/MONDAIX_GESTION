// Vue d'ensemble des éléments à rapprocher ou à vérifier.
import { lireParametre } from '../db.js';
import { etatParAsin } from './autorisations.js';
import { comparerTotal } from './commandes.js';
import { coutRetenu, ecartsCouts } from './couts.js';
import { listerEmails } from './emails.js';
import { listerLignesImport, propositionsRattachement } from './importSheets.js';

export function tableauDeBord(db) {
  const tol = Number(lireParametre(db, 'rapprochement.tolerance') || 0.02);
  const commandes = db.prepare('SELECT c.*, f.nom AS fournisseur FROM commandes c LEFT JOIN fournisseurs f ON f.id = c.fournisseur_id').all();
  const facturesPar = db.prepare('SELECT * FROM factures WHERE commande_id = ?');

  const sansFacture = [];
  const ecartsTotaux = [];
  const sansConfirmation = [];
  const sansFournisseur = [];
  for (const c of commandes) {
    const factures = facturesPar.all(c.id);
    const base = { id: c.id, numero_commande: c.numero_commande, fournisseur: c.fournisseur, date_commande: c.date_commande, total_declare: c.total_declare };
    if (!factures.length) sansFacture.push(base);
    else {
      const comp = comparerTotal(c, factures, tol);
      if (['ecart', 'composition_inconnue', 'detail_insuffisant'].includes(comp.statut)) ecartsTotaux.push({ ...base, comparaison: comp });
    }
    if (!db.prepare('SELECT 1 FROM emails WHERE commande_id = ?').get(c.id)) sansConfirmation.push(base);
    if (!c.fournisseur_id) sansFournisseur.push(base);
  }

  const lignesEnAttente = listerLignesImport(db, { statut: 'en_attente' });
  const fournisseursAValider = db
    .prepare("SELECT COUNT(*) AS n FROM lignes_import WHERE statut <> 'ignoree' AND fournisseur_valide_id IS NULL AND lien_original IS NOT NULL")
    .get().n;
  const autorisations = etatParAsin(db).filter((a) => !a.confirme);
  const facturesOrphelines = db.prepare('SELECT * FROM factures WHERE commande_id IS NULL').all();
  const sansCout = db.prepare('SELECT asin, titre FROM produits WHERE cout_retenu_id IS NULL ORDER BY asin').all();
  const lignesEnvoiSansCommande = db
    .prepare(
      `SELECT el.*, e.numero_envoi FROM envoi_lignes el JOIN envois e ON e.id = el.envoi_id WHERE el.commande_id IS NULL ORDER BY e.id DESC`,
    )
    .all();

  return {
    compteurs: {
      commandes: commandes.length,
      commandes_sans_facture: sansFacture.length,
      lignes_sans_commande: lignesEnAttente.length,
      asin_sans_autorisation_confirmee: autorisations.length,
      gmail_a_traiter: listerEmails(db, { source: 'gmail', statut: 'a_traiter' }).length,
      neo_a_traiter: listerEmails(db, { source: 'neo', statut: 'a_traiter' }).length,
      ecarts_totaux: ecartsTotaux.length,
      ecarts_couts: ecartsCouts(db).length,
      fournisseurs_a_valider: fournisseursAValider,
    },
    commandes_sans_facture: sansFacture,
    lignes_sans_commande: lignesEnAttente,
    propositions_lignes: propositionsRattachement(db),
    asin_sans_autorisation_confirmee: autorisations,
    ecarts_totaux: ecartsTotaux,
    ecarts_couts: ecartsCouts(db),
    commandes_sans_confirmation: sansConfirmation,
    commandes_sans_fournisseur: sansFournisseur,
    factures_sans_commande: facturesOrphelines,
    produits_sans_cout: sansCout,
    lignes_envoi_sans_commande: lignesEnvoiSansCommande,
  };
}

export function listerProduits(db) {
  return db
    .prepare(
      `SELECT p.*, c.montant_unitaire_ht AS cout_retenu, c.source AS source_cout,
         (SELECT COUNT(*) FROM couts_achat x WHERE x.asin = p.asin) AS nb_couts,
         (SELECT COALESCE(SUM(quantite), 0) FROM commande_lignes cl WHERE cl.asin = p.asin) AS unites_commandees
       FROM produits p LEFT JOIN couts_achat c ON c.id = p.cout_retenu_id ORDER BY p.asin`,
    )
    .all();
}

/** ASIN → dossier d'autorisation → n° de cas → réponse Neo, et ASIN → commandes. */
export function ficheProduit(db, asin) {
  const p = db.prepare('SELECT * FROM produits WHERE asin = ?').get(asin);
  if (!p) return null;
  const dossiers = db.prepare('SELECT * FROM dossiers_autorisation WHERE asin = ? ORDER BY id DESC').all(asin).map((d) => ({
    ...d,
    reponses: db.prepare('SELECT id, sujet, date_reception, references_extraites FROM emails WHERE dossier_id = ? ORDER BY date_reception').all(d.id)
      .map((e) => ({ ...e, references_extraites: JSON.parse(e.references_extraites) })),
  }));
  const commandes = db
    .prepare(
      `SELECT c.id, c.numero_commande, c.date_commande, cl.quantite, cl.cout_unitaire_ht, f.nom AS fournisseur
       FROM commande_lignes cl JOIN commandes c ON c.id = cl.commande_id LEFT JOIN fournisseurs f ON f.id = c.fournisseur_id
       WHERE cl.asin = ? ORDER BY c.id DESC`,
    )
    .all(asin);
  return { ...p, cout_retenu: coutRetenu(db, asin), dossiers, commandes };
}
