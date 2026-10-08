// Vue d'ensemble des éléments à rapprocher ou à vérifier.
import { lireParametre } from '../db.js';
import { etatParAsin } from './autorisations.js';
import { comparerTotal } from './commandes.js';
import { ecartsCouts } from './couts.js';
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
