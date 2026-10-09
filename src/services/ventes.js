// Import du rapport de commandes Amazon (Seller Central › Rapports › Commandes › « Toutes les
// commandes », fichier .txt séparé par des tabulations).
//
// Règles :
// - une ligne = un article commandé, identifié par order-item-id : réimporter une période déjà
//   importée met les lignes à jour (statut, prix) sans jamais les compter deux fois ;
// - les commandes annulées restent visibles mais ne comptent ni dans les ventes ni dans le COGS ;
// - la date retenue est le jour de la commande à l'heure de l'Est (Québec).
import { ErreurMetier, assurerProduit, journaliser, transaction } from '../db.js';
import { lireTableau } from '../lib/csv.js';
import { normaliserAsin, parserMontant, parserQuantite } from '../lib/parse.js';

const COLONNES = {
  commande: ['amazon-order-id', 'order-id', 'order id'],
  article: ['order-item-id', 'order item id'],
  date: ['purchase-date', 'purchase date', 'order-date'],
  asin: ['asin'],
  sku: ['sku', 'seller-sku'],
  quantite: ['quantity', 'quantity-purchased', 'quantity-shipped'],
  statut_commande: ['order-status', 'order status'],
  statut_article: ['item-status', 'item status'],
  canal: ['fulfillment-channel', 'fulfillment channel'],
  montant: ['item-price', 'item price'],
  devise: ['currency'],
};
const OBLIGATOIRES = ['commande', 'date', 'asin', 'quantite'];

const jourEst = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' });

/** « 2026-10-06T16:32:00+00:00 » → « 2026-10-06 » à l'heure de l'Est. */
export function jourCommande(valeur) {
  const v = String(valeur || '').trim();
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  return /T\d{2}:/.test(v) ? jourEst.format(d) : v.slice(0, 10);
}

function colonnes(entetes) {
  const bas = entetes.map((h) => h.trim().toLowerCase());
  const map = {};
  for (const [champ, noms] of Object.entries(COLONNES)) {
    const i = bas.findIndex((h) => noms.includes(h));
    if (i >= 0) map[champ] = i;
  }
  const manquantes = OBLIGATOIRES.filter((c) => map[c] === undefined);
  if (manquantes.length) {
    throw new ErreurMetier(
      `Ce fichier n’est pas un rapport de commandes Amazon : colonnes ${manquantes.map((c) => `« ${COLONNES[c][0]} »`).join(', ')} introuvables. ` +
        'Téléchargez-le depuis Seller Central › Rapports › Commandes › Toutes les commandes.',
    );
  }
  return map;
}

export function importerVentes(db, { texte, nom }) {
  const { entetes, lignes } = lireTableau(texte);
  if (!entetes.length) throw new ErreurMetier('Fichier vide.');
  const map = colonnes(entetes);
  const val = (l, champ) => (map[champ] === undefined ? '' : l[map[champ]]);
  return transaction(db, () => {
    const imp = db.prepare('INSERT INTO imports_ventes (nom, nb_lignes) VALUES (?, ?)').run(nom || 'Rapport de commandes Amazon', lignes.length);
    const importId = Number(imp.lastInsertRowid);
    const existe = db.prepare('SELECT id FROM ventes WHERE cle = ?');
    const ecrire = db.prepare(
      `INSERT INTO ventes (cle, import_id, commande, date_vente, asin, sku, quantite, statut, annulee, canal, montant, devise)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cle) DO UPDATE SET import_id = excluded.import_id, date_vente = excluded.date_vente, asin = excluded.asin,
         sku = excluded.sku, quantite = excluded.quantite, statut = excluded.statut, annulee = excluded.annulee,
         canal = excluded.canal, montant = excluded.montant, devise = excluded.devise`,
    );
    const r = { import_id: importId, lignes: lignes.length, nouvelles: 0, mises_a_jour: 0, annulees: 0, unites: 0, rejets: [], du: null, au: null };
    lignes.forEach((l, i) => {
      const commande = val(l, 'commande');
      const asin = normaliserAsin(val(l, 'asin'));
      const jour = jourCommande(val(l, 'date'));
      const quantite = parserQuantite(val(l, 'quantite'));
      if (!commande || !asin || !jour || quantite === null) {
        r.rejets.push({ ligne: i + 2, motif: !asin ? 'ASIN illisible' : !jour ? 'date illisible' : !commande ? 'n° de commande manquant' : 'quantité illisible' });
        return;
      }
      const sku = val(l, 'sku') || null;
      const cle = val(l, 'article') || `${commande}|${sku || asin}`;
      const statut = val(l, 'statut_article') || val(l, 'statut_commande') || null;
      const annulee = /cancel/i.test(`${val(l, 'statut_commande')} ${val(l, 'statut_article')}`) ? 1 : 0;
      const montant = val(l, 'montant') === '' ? null : parserMontant(val(l, 'montant'));
      assurerProduit(db, asin);
      if (existe.get(cle)) r.mises_a_jour++;
      else r.nouvelles++;
      ecrire.run(cle, importId, commande, jour, asin, sku, quantite, statut, annulee, val(l, 'canal') || null, montant, val(l, 'devise') || null);
      if (annulee) r.annulees++;
      else r.unites += quantite;
      if (!r.du || jour < r.du) r.du = jour;
      if (!r.au || jour > r.au) r.au = jour;
    });
    journaliser(db, 'import_ventes', importId, 'import', { nom, lignes: lignes.length, nouvelles: r.nouvelles, mises_a_jour: r.mises_a_jour, du: r.du, au: r.au });
    return r;
  });
}

/** Rapports importés, du plus récent au plus ancien, avec la période et les unités qu'ils portent encore. */
export function listerImportsVentes(db) {
  return db
    .prepare(
      `SELECT i.id, i.nom, i.nb_lignes, i.created_at,
         MIN(v.date_vente) AS du, MAX(v.date_vente) AS au, COUNT(v.id) AS lignes,
         COALESCE(SUM(CASE WHEN v.annulee = 0 THEN v.quantite END), 0) AS unites
       FROM imports_ventes i LEFT JOIN ventes v ON v.import_id = i.id
       GROUP BY i.id ORDER BY i.id DESC`,
    )
    .all();
}

/** Supprime un rapport importé et les lignes qu'il porte (celles réimportées depuis restent). */
export function supprimerImportVentes(db, id) {
  return transaction(db, () => {
    const imp = db.prepare('SELECT * FROM imports_ventes WHERE id = ?').get(id);
    if (!imp) throw new ErreurMetier('Import introuvable.', 404);
    const lignes = db.prepare('SELECT COUNT(*) AS n FROM ventes WHERE import_id = ?').get(id).n;
    db.prepare('DELETE FROM ventes WHERE import_id = ?').run(id);
    db.prepare('DELETE FROM imports_ventes WHERE id = ?').run(id);
    journaliser(db, 'import_ventes', id, 'suppression', { nom: imp.nom, lignes });
    return { ok: true, lignes };
  });
}

/** Ventes réelles (hors annulations) : { asin, date, unites, montant }. */
export function ventesReelles(db) {
  return db
    .prepare('SELECT asin, date_vente AS date, quantite AS unites, montant FROM ventes WHERE annulee = 0 AND quantite > 0 ORDER BY date_vente')
    .all();
}

/** Premier jour couvert par un rapport de commandes (null si aucun) : à partir de là, les ventes sont réelles. */
export function debutVentesReelles(db) {
  return db.prepare('SELECT MIN(date_vente) AS d FROM ventes').get().d ?? null;
}

/** Dernier jour couvert par un rapport de commandes (null si aucun). */
export function finVentesReelles(db) {
  return db.prepare('SELECT MAX(date_vente) AS d FROM ventes').get().d ?? null;
}
