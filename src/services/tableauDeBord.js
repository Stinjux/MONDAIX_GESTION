// Vue d'ensemble des éléments à vérifier : envois à confirmer, factures sans ASIN, autorisations, emails, coûts.
import { etatParAsin } from './autorisations.js';
import { totalFacture } from './factures.js';
import { ecartsCouts } from './couts.js';
import { listerEmails } from './emails.js';
import { listerEnvois } from './envois.js';

export function tableauDeBord(db) {
  const envois = listerEnvois(db).filter((e) => e.statut !== 'cloture');
  const aVerifier = envois.filter((e) => ['en_transit', 'partiel'].includes(e.suivi.etat));
  const enEcart = envois.filter((e) => e.suivi.etat === 'ecart');
  const facturesSansAsin = db
    .prepare(
      `SELECT f.*, (SELECT json_extract(d.extraction, '$.fournisseur') FROM facture_documents d WHERE d.facture_id = f.id) AS fournisseur
       FROM factures f WHERE f.annulee = 0 AND NOT EXISTS (SELECT 1 FROM facture_lignes fl WHERE fl.facture_id = f.id)
       ORDER BY COALESCE(f.date_facture, f.created_at) DESC`,
    )
    .all()
    .map((f) => ({ ...f, total_calcule: totalFacture(f) }));
  const autorisations = etatParAsin(db).filter((a) => !a.confirme);
  const ecarts = ecartsCouts(db);

  return {
    compteurs: {
      envois_a_verifier: aVerifier.length,
      unites_en_transit: aVerifier.reduce((s, e) => s + e.suivi.unites_a_verifier, 0),
      envois_en_ecart: enEcart.length,
      factures_sans_asin: facturesSansAsin.length,
      asin_sans_autorisation_confirmee: autorisations.length,
      gmail_a_traiter: listerEmails(db, { source: 'gmail', statut: 'a_traiter' }).length,
      neo_a_traiter: listerEmails(db, { source: 'neo', statut: 'a_traiter' }).length,
      ecarts_couts: ecarts.length,
    },
    envois_a_verifier: [...aVerifier, ...enEcart],
    factures_sans_asin: facturesSansAsin,
    asin_sans_autorisation_confirmee: autorisations,
    ecarts_couts: ecarts,
  };
}
