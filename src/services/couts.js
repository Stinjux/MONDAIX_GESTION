// Coût d'achat unitaire (historisé) et coût complet calculé à partir des dépenses enregistrées.
import { ErreurMetier, assurerProduit, journaliser, lireParametre } from '../db.js';
import { arrondir, normaliserAsin, parserMontant, parserQuantite } from '../lib/parse.js';

export const LIBELLES_SOURCE_COUT = {
  inventaire: 'Fichier d’inventaire (cost)',
  commande: 'Commande fournisseur',
  facture: 'Facture',
  manuel: 'Saisie manuelle',
};

export const TYPES_DEPENSE = {
  livraison_fournisseur: 'Livraison fournisseur',
  taxes: 'Taxes',
  preparation: 'Préparation',
  transport_amazon: 'Transport vers Amazon',
  autre: 'Autre',
};

const SEUIL_ECART = 0.005;

export function coutRetenu(db, asin) {
  return (
    db
      .prepare('SELECT c.* FROM produits p JOIN couts_achat c ON c.id = p.cout_retenu_id WHERE p.asin = ?')
      .get(asin) || null
  );
}

/**
 * Ajoute une valeur à l'historique des coûts d'achat unitaires HT.
 * - Ne modifie jamais le coût retenu s'il existe déjà : l'écart est signalé.
 * - Le premier coût connu d'un ASIN devient le coût retenu.
 * - Une valeur identique à la dernière de même source et même référence n'est pas dupliquée.
 */
export function ajouterCout(db, { asin, montant, source, reference = null, importId = null, commandeId = null, factureId = null }) {
  const a = normaliserAsin(asin);
  if (!a) throw new ErreurMetier(`ASIN invalide : ${asin}`);
  const m = parserMontant(montant);
  if (m === null || m < 0) throw new ErreurMetier('Montant unitaire invalide.');
  assurerProduit(db, a);

  const dernier = db
    .prepare(
      `SELECT * FROM couts_achat WHERE asin = ? AND source = ?
         AND IFNULL(commande_id, 0) = IFNULL(?, 0) AND IFNULL(facture_id, 0) = IFNULL(?, 0)
       ORDER BY id DESC LIMIT 1`,
    )
    .get(a, source, commandeId, factureId);
  const retenu = coutRetenu(db, a);
  if (dernier && Math.abs(dernier.montant_unitaire_ht - m) < SEUIL_ECART) {
    return { entree: dernier, retenu, ecart: retenu ? arrondir(m - retenu.montant_unitaire_ht) : null, nouveau: false };
  }
  const r = db
    .prepare(
      `INSERT INTO couts_achat (asin, montant_unitaire_ht, source, reference, import_id, commande_id, facture_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(a, m, source, reference, importId, commandeId, factureId);
  const entree = db.prepare('SELECT * FROM couts_achat WHERE id = ?').get(r.lastInsertRowid);
  if (!retenu) {
    db.prepare("UPDATE produits SET cout_retenu_id = ?, updated_at = datetime('now') WHERE asin = ?").run(entree.id, a);
    db.prepare('UPDATE couts_achat SET ecart_traite = 1 WHERE id = ?').run(entree.id);
    journaliser(db, 'produit', a, 'cout_retenu_initial', { cout_id: entree.id, montant: m, source });
    return { entree, retenu: entree, ecart: null, nouveau: true };
  }
  const ecart = arrondir(m - retenu.montant_unitaire_ht);
  if (Math.abs(ecart) < SEUIL_ECART) db.prepare('UPDATE couts_achat SET ecart_traite = 1 WHERE id = ?').run(entree.id);
  journaliser(db, 'produit', a, 'cout_ajoute', { cout_id: entree.id, montant: m, source, ecart });
  return { entree, retenu, ecart, nouveau: true };
}

/** Choix explicite de la valeur retenue parmi l'historique. */
export function retenirCout(db, asin, coutId) {
  const entree = db.prepare('SELECT * FROM couts_achat WHERE id = ? AND asin = ?').get(coutId, asin);
  if (!entree) throw new ErreurMetier('Cette valeur n’appartient pas à l’historique de cet ASIN.', 404);
  const avant = coutRetenu(db, asin);
  db.prepare("UPDATE produits SET cout_retenu_id = ?, updated_at = datetime('now') WHERE asin = ?").run(coutId, asin);
  db.prepare('UPDATE couts_achat SET ecart_traite = 1 WHERE asin = ?').run(asin);
  journaliser(db, 'produit', asin, 'cout_retenu_change', {
    avant: avant && { id: avant.id, montant: avant.montant_unitaire_ht, source: avant.source },
    apres: { id: entree.id, montant: entree.montant_unitaire_ht, source: entree.source },
  });
  return coutRetenu(db, asin);
}

export function historiqueCouts(db, asin) {
  const retenu = coutRetenu(db, asin);
  return db
    .prepare(
      `SELECT c.*, co.numero_commande, f.numero_facture FROM couts_achat c
       LEFT JOIN commandes co ON co.id = c.commande_id
       LEFT JOIN factures f ON f.id = c.facture_id
       WHERE c.asin = ? ORDER BY c.id DESC`,
    )
    .all(asin)
    .map((c) => ({
      ...c,
      retenu: retenu ? c.id === retenu.id : false,
      ecart: retenu ? arrondir(c.montant_unitaire_ht - retenu.montant_unitaire_ht) : null,
    }));
}

/** ASIN dont l'historique contient une valeur différente du coût retenu, non encore arbitrée. */
export function ecartsCouts(db) {
  return db
    .prepare(
      `SELECT c.asin, p.titre, r.montant_unitaire_ht AS retenu, r.source AS source_retenue,
              c.id AS cout_id, c.montant_unitaire_ht AS valeur, c.source, c.reference, c.created_at
       FROM couts_achat c
       JOIN produits p ON p.asin = c.asin
       JOIN couts_achat r ON r.id = p.cout_retenu_id
       WHERE c.ecart_traite = 0 AND ABS(c.montant_unitaire_ht - r.montant_unitaire_ht) >= ?
       ORDER BY c.asin, c.id DESC`,
    )
    .all(SEUIL_ECART)
    .map((e) => ({ ...e, ecart: arrondir(e.valeur - e.retenu) }));
}

/* ------------------------------------------------------------------ dépenses */

export function creerDepense(db, d) {
  if (!(d.type in TYPES_DEPENSE)) throw new ErreurMetier('Type de dépense invalide.');
  const montant = parserMontant(d.montant);
  if (montant === null) throw new ErreurMetier('Montant invalide.');
  const cibles = [d.commande_id, d.envoi_id, d.asin].filter((x) => x !== null && x !== undefined && x !== '');
  if (cibles.length > 1) throw new ErreurMetier('Une dépense se rattache à une seule cible : commande, envoi ou ASIN.');
  let asin = null;
  let quantite = null;
  if (d.asin) {
    asin = normaliserAsin(d.asin);
    if (!asin) throw new ErreurMetier('ASIN invalide.');
    quantite = parserQuantite(d.quantite_concernee);
    if (!quantite) throw new ErreurMetier('Indiquez le nombre d’unités concernées par cette dépense.');
    assurerProduit(db, asin);
  }
  const r = db
    .prepare(
      `INSERT INTO depenses (type, montant, date_depense, commande_id, envoi_id, asin, quantite_concernee, facture_id, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      d.type,
      montant,
      d.date_depense || null,
      d.commande_id || null,
      d.envoi_id || null,
      asin,
      quantite,
      d.facture_id || null,
      d.description || null,
    );
  journaliser(db, 'depense', r.lastInsertRowid, 'creation', { ...d, montant });
  return db.prepare('SELECT * FROM depenses WHERE id = ?').get(r.lastInsertRowid);
}

export function supprimerDepense(db, id) {
  const d = db.prepare('SELECT * FROM depenses WHERE id = ?').get(id);
  if (!d) throw new ErreurMetier('Dépense introuvable.', 404);
  if (d.facture_id) throw new ErreurMetier('Cette dépense provient d’une facture : modifiez la facture.');
  db.prepare('DELETE FROM depenses WHERE id = ?').run(id);
  journaliser(db, 'depense', id, 'suppression', d);
}

export function listerDepenses(db, filtre = {}) {
  const conds = [];
  const params = [];
  for (const cle of ['commande_id', 'envoi_id', 'asin']) {
    if (filtre[cle]) {
      conds.push(`d.${cle} = ?`);
      params.push(filtre[cle]);
    }
  }
  return db
    .prepare(
      `SELECT d.*, c.numero_commande, e.numero_envoi FROM depenses d
       LEFT JOIN commandes c ON c.id = d.commande_id
       LEFT JOIN envois e ON e.id = d.envoi_id
       ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
       ORDER BY COALESCE(d.date_depense, d.created_at) DESC, d.id DESC`,
    )
    .all(...params);
}

/* --------------------------------------------------------------- coût complet */

function typesInclus(db) {
  const inclureTaxes = lireParametre(db, 'couts.inclure_taxes') === '1';
  return Object.keys(TYPES_DEPENSE).filter((t) => inclureTaxes || t !== 'taxes');
}

/**
 * Coût complet unitaire = coût d'achat retenu
 *   + frais de commande répartis au prorata des quantités de chaque commande
 *   + frais d'envoi Amazon répartis au prorata des quantités de chaque envoi
 *   + dépenses rattachées directement à l'ASIN / unités concernées.
 * Seules les dépenses effectivement enregistrées sont utilisées ; le total
 * déclaré d'une commande n'est jamais ajouté (il couvre les mêmes montants).
 */
export function coutComplet(db, asin) {
  const types = typesInclus(db);
  const filtreTypes = `type IN (${types.map(() => '?').join(',')})`;
  const retenu = coutRetenu(db, asin);
  const alertes = [];

  // Frais de commande
  let fraisAchat = 0;
  let unitesAchat = 0;
  const commandes = db
    .prepare(
      `SELECT cl.commande_id, SUM(cl.quantite) AS quantite, c.numero_commande
       FROM commande_lignes cl JOIN commandes c ON c.id = cl.commande_id
       WHERE cl.asin = ? GROUP BY cl.commande_id`,
    )
    .all(asin);
  const commandesSansFrais = [];
  for (const c of commandes) {
    const qteTotale = db.prepare('SELECT SUM(quantite) AS q FROM commande_lignes WHERE commande_id = ?').get(c.commande_id).q || 0;
    const frais = db
      .prepare(`SELECT COALESCE(SUM(montant), 0) AS s, COUNT(*) AS n FROM depenses WHERE commande_id = ? AND ${filtreTypes}`)
      .get(c.commande_id, ...types);
    if (!frais.n) commandesSansFrais.push(c.numero_commande || `#${c.commande_id}`);
    if (qteTotale > 0) fraisAchat += (frais.s * c.quantite) / qteTotale;
    unitesAchat += c.quantite;
  }
  if (commandesSansFrais.length) {
    alertes.push(`Aucune dépense enregistrée pour : ${commandesSansFrais.join(', ')} (livraison inconnue ou nulle).`);
  }

  // Frais d'envoi vers Amazon
  let fraisEnvoi = 0;
  let unitesEnvoyees = 0;
  const envois = db
    .prepare('SELECT envoi_id, SUM(quantite) AS quantite FROM envoi_lignes WHERE asin = ? GROUP BY envoi_id')
    .all(asin);
  for (const e of envois) {
    const qteTotale = db.prepare('SELECT SUM(quantite) AS q FROM envoi_lignes WHERE envoi_id = ?').get(e.envoi_id).q || 0;
    const frais = db
      .prepare(`SELECT COALESCE(SUM(montant), 0) AS s FROM depenses WHERE envoi_id = ? AND ${filtreTypes}`)
      .get(e.envoi_id, ...types);
    if (qteTotale > 0) fraisEnvoi += (frais.s * e.quantite) / qteTotale;
    unitesEnvoyees += e.quantite;
  }
  if (!envois.length) alertes.push('Aucun envoi Amazon enregistré : transport et préparation non inclus.');

  // Dépenses directes
  const directes = db
    .prepare(`SELECT COALESCE(SUM(montant), 0) AS s, COALESCE(SUM(quantite_concernee), 0) AS q FROM depenses WHERE asin = ? AND ${filtreTypes}`)
    .get(asin, ...types);

  const parUnite = {
    achat: retenu ? retenu.montant_unitaire_ht : null,
    frais_commande: unitesAchat ? arrondir(fraisAchat / unitesAchat) : 0,
    frais_envoi: unitesEnvoyees ? arrondir(fraisEnvoi / unitesEnvoyees) : 0,
    frais_directs: directes.q ? arrondir(directes.s / directes.q) : 0,
  };
  if (!retenu) alertes.push('Coût d’achat unitaire inconnu.');
  const total = retenu
    ? arrondir(parUnite.achat + parUnite.frais_commande + parUnite.frais_envoi + parUnite.frais_directs)
    : null;
  return {
    asin,
    cout_achat: retenu,
    par_unite: parUnite,
    cout_complet_unitaire: total,
    unites_achetees: unitesAchat,
    unites_envoyees: unitesEnvoyees,
    taxes_incluses: types.includes('taxes'),
    alertes,
  };
}
