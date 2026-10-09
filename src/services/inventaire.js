// Import du fichier d'inventaire. La colonne « cost » = prix d'achat unitaire HT
// (sans livraison, préparation ni transport vers Amazon).
import { ErreurMetier, assurerProduit, journaliser, lireParametre, transaction } from '../db.js';
import { lireTableau } from '../lib/csv.js';
import { CHAMPS_INVENTAIRE, proposerMapping, validerMapping } from '../lib/mapping.js';
import { normaliserAsin, parserMontant, parserQuantite } from '../lib/parse.js';
import { ajouterCout } from './couts.js';

export function analyserInventaire(texte) {
  const { entetes, lignes } = lireTableau(texte);
  if (!entetes.length) throw new ErreurMetier('Fichier vide.');
  return {
    entetes,
    apercu: lignes.slice(0, 20),
    nb_lignes: lignes.length,
    champs: CHAMPS_INVENTAIRE,
    mapping: proposerMapping(entetes, lignes, CHAMPS_INVENTAIRE),
  };
}

export function importerInventaire(db, { texte, mapping, nom }) {
  const { entetes, lignes } = lireTableau(texte);
  let map;
  try {
    map = validerMapping(mapping, entetes, CHAMPS_INVENTAIRE);
  } catch (e) {
    throw new ErreurMetier(e.message);
  }
  return transaction(db, () => {
    const imp = db
      .prepare("INSERT INTO imports (type, nom, mapping, entetes, nb_lignes) VALUES ('inventaire', ?, ?, ?, ?)")
      .run(nom || 'inventaire', JSON.stringify(map), JSON.stringify(entetes), lignes.length);
    const importId = Number(imp.lastInsertRowid);
    const resultat = { import_id: importId, produits: 0, couts_ajoutes: 0, ecarts: [], rejets: [], doublons: [], hors_fba: [] };
    // ASIN → quantité. Plusieurs SKU d'un même ASIN sont additionnés ; une ligne répétée pour le
    // même SKU remplace la précédente (jamais comptée deux fois).
    const parSku = new Map(); // « ASIN | SKU » → quantité
    const lignesParAsin = new Map();
    lignes.forEach((l, i) => {
      const asin = normaliserAsin(l[map.asin]);
      if (!asin) {
        resultat.rejets.push({ ligne: i + 2, motif: `ASIN invalide « ${l[map.asin] || ''} »` });
        return;
      }
      assurerProduit(db, asin);
      const maj = {};
      if (map.sku !== undefined && l[map.sku]) maj.sku = l[map.sku];
      if (map.titre !== undefined && l[map.titre]) maj.titre = l[map.titre];
      // Offre expédiée par le vendeur (mf, merchant) : pas de stock chez Amazon.
      const horsFba = map.expedition !== undefined && /^(mf|mfn|merchant|fbm|default)/i.test(String(l[map.expedition] || '').trim());
      if (horsFba) resultat.hors_fba.push({ ligne: i + 2, asin });
      if (map.quantite !== undefined && !horsFba) {
        // Quantité vide, nulle ou illisible : 0.
        const q = parserQuantite(l[map.quantite]) ?? 0;
        const sku = map.sku !== undefined ? String(l[map.sku] || '').trim() : '';
        const cle = sku ? `${asin}|${sku}` : `${asin}|ligne-${i}`;
        if (sku && parSku.has(cle)) resultat.doublons.push({ ligne: i + 2, asin, sku });
        parSku.set(cle, { asin, q });
        lignesParAsin.set(asin, (lignesParAsin.get(asin) || 0) + 1);
      }
      const cles = Object.keys(maj);
      if (cles.length) {
        db.prepare(`UPDATE produits SET ${cles.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE asin = ?`).run(
          ...cles.map((c) => maj[c]),
          asin,
        );
      }
      resultat.produits++;
      if (map.cost !== undefined && l[map.cost] !== '') {
        const cout = parserMontant(l[map.cost]);
        if (cout === null || cout < 0) {
          resultat.rejets.push({ ligne: i + 2, motif: `cost illisible « ${l[map.cost]} »` });
          return;
        }
        const r = ajouterCout(db, { asin, montant: cout, source: 'inventaire', reference: nom || 'inventaire', importId });
        if (r.nouveau) resultat.couts_ajoutes++;
        if (r.ecart !== null && Math.abs(r.ecart) >= 0.005) {
          resultat.ecarts.push({ asin, importe: cout, retenu: r.retenu.montant_unitaire_ht, ecart: r.ecart });
        }
      }
    });
    const stock = new Map();
    for (const { asin, q } of parSku.values()) stock.set(asin, (stock.get(asin) || 0) + q);
    // ASIN présents sur plusieurs lignes (SKU différents) : quantités additionnées, signalées.
    resultat.asin_plusieurs_lignes = [...lignesParAsin].filter(([, n]) => n > 1).map(([asin, n]) => ({ asin, lignes: n }));
    // Photo du stock de cet import
    const releve = db.prepare('INSERT INTO stock_releves (import_id, asin, quantite) VALUES (?, ?, ?)');
    for (const [asin, q] of stock) {
      releve.run(importId, asin, q);
      db.prepare("UPDATE produits SET quantite_inventaire = ?, updated_at = datetime('now') WHERE asin = ?").run(q, asin);
    }
    if (stock.size) {
      const e = etatStock(db);
      resultat.stock = { total: e.dernier.total, precedent: e.precedent?.total ?? null, ecart: e.precedent ? e.dernier.total - e.precedent.total : null };
    }
    journaliser(db, 'import', importId, 'inventaire', { produits: resultat.produits, ecarts: resultat.ecarts.length, stock: resultat.stock || null });
    return resultat;
  });
}

/** Imports d'inventaire, du plus récent au plus ancien. Le plus ancien avec des quantités = stock initial. */
export function listerImportsInventaire(db) {
  const imports = db
    .prepare(
      `SELECT i.id, i.nom, i.created_at AS date, i.nb_lignes,
         (SELECT COUNT(*) FROM stock_releves s WHERE s.import_id = i.id) AS nb_asin,
         (SELECT COALESCE(SUM(s.quantite), 0) FROM stock_releves s WHERE s.import_id = i.id) AS unites,
         (SELECT COUNT(*) FROM couts_achat c WHERE c.import_id = i.id) AS nb_couts
       FROM imports i WHERE i.type = 'inventaire' ORDER BY i.id DESC`,
    )
    .all();
  const avecStock = imports.filter((i) => i.nb_asin > 0);
  const initial = avecStock[avecStock.length - 1]?.id;
  const dernier = avecStock[0]?.id;
  return imports.map((i) => ({ ...i, stock_initial: i.id === initial, dernier: i.id === dernier }));
}

/**
 * Supprime un import d'inventaire fait par erreur : sa photo du stock et les coûts qu'il a ajoutés.
 * Si un de ces coûts était le coût retenu d'un ASIN, le coût précédent de l'historique est retenu.
 * Le stock redevient celui de l'import précédent ; l'opération est journalisée.
 */
export function supprimerImportInventaire(db, id, { motif = 'suppression' } = {}) {
  const imp = db.prepare("SELECT * FROM imports WHERE id = ? AND type = 'inventaire'").get(id);
  if (!imp) throw new ErreurMetier('Import introuvable.', 404);
  return transaction(db, () => {
    const releves = db.prepare('SELECT asin, quantite FROM stock_releves WHERE import_id = ?').all(id);
    const couts = db.prepare('SELECT id, asin, montant_unitaire_ht FROM couts_achat WHERE import_id = ?').all(id);
    const ids = new Set(couts.map((c) => c.id));
    for (const asin of new Set(couts.map((c) => c.asin))) {
      const p = db.prepare('SELECT cout_retenu_id FROM produits WHERE asin = ?').get(asin);
      if (p && ids.has(p.cout_retenu_id)) {
        const precedent = db
          .prepare(`SELECT id FROM couts_achat WHERE asin = ? AND id NOT IN (${[...ids].map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`)
          .get(asin, ...ids);
        db.prepare("UPDATE produits SET cout_retenu_id = ?, updated_at = datetime('now') WHERE asin = ?").run(precedent?.id ?? null, asin);
      }
    }
    db.prepare('DELETE FROM couts_achat WHERE import_id = ?').run(id);
    db.prepare('DELETE FROM stock_releves WHERE import_id = ?').run(id);
    db.prepare('DELETE FROM imports WHERE id = ?').run(id);
    // Quantité d'inventaire mémorisée sur l'ASIN : celle du dernier import restant.
    for (const { asin } of releves) {
      const r = db
        .prepare(`SELECT s.quantite FROM stock_releves s JOIN imports i ON i.id = s.import_id WHERE s.asin = ? AND i.type = 'inventaire' ORDER BY i.id DESC LIMIT 1`)
        .get(asin);
      db.prepare("UPDATE produits SET quantite_inventaire = ?, updated_at = datetime('now') WHERE asin = ?").run(r?.quantite ?? null, asin);
    }
    // Le contenu supprimé reste lisible dans le journal (quantités et coûts de l'import).
    journaliser(db, 'import', id, motif, { nom: imp.nom, date: imp.created_at, releves, couts });
    return { asin: releves.length, couts: couts.length };
  });
}

/**
 * Remet l'inventaire à zéro : supprime tous les imports d'inventaire (photos du stock Amazon et coûts
 * qu'ils ont ajoutés). Les factures, envois, dépenses et coûts des factures ne sont pas touchés.
 * Le prochain import devient le stock initial.
 */
export function reinitialiserInventaire(db) {
  return transaction(db, () => {
    const ids = db.prepare("SELECT id FROM imports WHERE type = 'inventaire' ORDER BY id DESC").all().map((r) => r.id);
    for (const id of ids) supprimerImportInventaire(db, id, { motif: 'reinitialisation' });
    journaliser(db, 'inventaire', null, 'reinitialisation', { imports_supprimes: ids.length });
    return { imports_supprimes: ids.length };
  });
}

/** Remise à zéro demandée le 9 octobre 2026 : exécutée une seule fois au démarrage. */
export function migrerReinitialisationInventaire(db) {
  if (lireParametre(db, 'migration.reinit_inventaire_20261009') === '1') return null;
  const r = reinitialiserInventaire(db);
  db.prepare("INSERT INTO parametres (cle, valeur) VALUES ('migration.reinit_inventaire_20261009', '1') ON CONFLICT(cle) DO UPDATE SET valeur = '1'").run();
  return r;
}

/* ------------------------------------------------------------------ stock */

/** Imports d'inventaire contenant des quantités, du plus récent au plus ancien. */
export function importsStock(db) {
  return db
    .prepare(
      `SELECT i.id AS import_id, i.nom, i.created_at AS date, SUM(s.quantite) AS total, COUNT(s.id) AS nb_asin
       FROM imports i JOIN stock_releves s ON s.import_id = i.id
       WHERE i.type = 'inventaire' GROUP BY i.id ORDER BY i.id DESC`,
    )
    .all();
}

/**
 * Stock = quantités du dernier import d'inventaire ; écart avec l'import précédent.
 * Un ASIN absent d'un import compte pour 0 dans cet import.
 */
export function etatStock(db) {
  const [dernier, precedent] = importsStock(db);
  const parAsin = new Map();
  if (!dernier) return { dernier: null, precedent: null, parAsin };
  const qte = (importId) => new Map(db.prepare('SELECT asin, quantite FROM stock_releves WHERE import_id = ?').all(importId).map((r) => [r.asin, r.quantite]));
  const actuel = qte(dernier.import_id);
  const avant = precedent ? qte(precedent.import_id) : new Map();
  for (const asin of new Set([...actuel.keys(), ...avant.keys()])) {
    const q = actuel.get(asin) ?? 0;
    const p = precedent ? avant.get(asin) ?? 0 : null;
    parAsin.set(asin, { quantite: q, precedente: p, ecart: p === null ? null : q - p, absent: !actuel.has(asin) });
  }
  return { dernier, precedent: precedent || null, parAsin };
}

const jour = (d) => String(d).slice(0, 10);

/** Envois expédiés à Amazon (hors « en préparation ») : une ligne par ASIN et par jour d'expédition. */
function envoisExpedies(db) {
  return db
    .prepare(
      `SELECT el.asin, COALESCE(e.date_envoi, date(e.created_at)) AS date, SUM(el.quantite) AS unites
       FROM envoi_lignes el JOIN envois e ON e.id = el.envoi_id
       WHERE e.statut <> 'en_preparation' GROUP BY el.asin, date`,
    )
    .all();
}

/**
 * Mouvements du stock Amazon, d'un import d'inventaire au suivant. Chaque import est une photo complète :
 * seule la variation compte (10 → 10 : rien ; 10 → 8 : 2 ventes ; 10 → 15 : restock de 5).
 * Les envois enregistrés expédiés entre deux imports (le jour d'un import compte pour l'intervalle
 * suivant) expliquent une hausse ; une hausse sans envoi enregistré est un restock non saisi.
 *   ventes  = avant + envois enregistrés − après (si positif)
 *   restock non saisi = après − avant − envois enregistrés (si positif)
 * Le premier import est le stock initial : aucune vente avant lui.
 */
export function mouvementsStock(db) {
  const imports = importsStock(db).reverse();
  const qte = db.prepare('SELECT asin, quantite FROM stock_releves WHERE import_id = ?');
  const envois = envoisExpedies(db);
  const mouvements = [];
  for (let i = 1; i < imports.length; i++) {
    const avant = imports[i - 1];
    const apres = imports[i];
    const du = jour(avant.date);
    const au = jour(apres.date);
    const qAvant = new Map(qte.all(avant.import_id).map((r) => [r.asin, r.quantite]));
    const qApres = new Map(qte.all(apres.import_id).map((r) => [r.asin, r.quantite]));
    const entrees = new Map();
    for (const e of envois) if (e.date >= du && e.date < au) entrees.set(e.asin, (entrees.get(e.asin) || 0) + e.unites);
    for (const asin of new Set([...qAvant.keys(), ...qApres.keys(), ...entrees.keys()])) {
      const a = qAvant.get(asin) ?? 0;
      const b = qApres.get(asin) ?? 0;
      const env = entrees.get(asin) ?? 0;
      mouvements.push({
        asin,
        date: au,
        import_id: apres.import_id,
        avant: a,
        apres: b,
        variation: b - a,
        envois: env,
        vendues: Math.max(0, a + env - b),
        restock_non_saisi: Math.max(0, b - a - env),
      });
    }
  }
  return mouvements;
}

/** Ventes estimées (baisses du stock Amazon entre deux imports, envois enregistrés pris en compte). */
export function ventesEstimees(db) {
  return mouvementsStock(db)
    .filter((m) => m.vendues > 0)
    .map((m) => ({ asin: m.asin, date: m.date, vendues: m.vendues, import_id: m.import_id }));
}

/**
 * Bilan par ASIN des unités sorties de chez vous vers Amazon :
 *   stock initial (premier import) + envois enregistrés après lui + restocks non saisis ;
 *   en transit = envois expédiés depuis le dernier import (pas encore visibles chez Amazon).
 * Sans import : tous les envois expédiés sont en transit.
 */
export function bilanStock(db) {
  const imports = importsStock(db).reverse();
  const bilan = new Map();
  const get = (asin) => {
    if (!bilan.has(asin)) bilan.set(asin, { initial: 0, envois_apres_initial: 0, restock_non_saisi: 0, vendues: 0, en_transit: 0 });
    return bilan.get(asin);
  };
  if (imports.length) {
    for (const r of db.prepare('SELECT asin, quantite FROM stock_releves WHERE import_id = ?').all(imports[0].import_id)) get(r.asin).initial = r.quantite;
  }
  const debut = imports.length ? jour(imports[0].date) : null;
  const fin = imports.length ? jour(imports[imports.length - 1].date) : null;
  for (const e of envoisExpedies(db)) {
    if (fin === null || e.date >= fin) get(e.asin).en_transit += e.unites;
    else if (e.date >= debut) get(e.asin).envois_apres_initial += e.unites;
    // Envoi antérieur au premier import : déjà compris dans le stock initial.
  }
  for (const m of mouvementsStock(db)) {
    const b = get(m.asin);
    b.vendues += m.vendues;
    b.restock_non_saisi += m.restock_non_saisi;
  }
  return bilan;
}

/** Évolution du stock d'un ASIN, import par import. */
export function historiqueStockAsin(db, asin) {
  const imports = importsStock(db).reverse();
  const mouvements = new Map(mouvementsStock(db).filter((m) => m.asin === asin).map((m) => [m.import_id, m]));
  const lignes = [];
  let precedente = null;
  for (const [n, i] of imports.entries()) {
    const r = db.prepare('SELECT quantite FROM stock_releves WHERE import_id = ? AND asin = ?').get(i.import_id, asin);
    const q = r ? r.quantite : 0;
    const m = mouvements.get(i.import_id);
    lignes.push({
      import_id: i.import_id,
      nom: i.nom,
      date: i.date,
      quantite: q,
      absent: !r,
      ecart: precedente === null ? null : q - precedente,
      stock_initial: n === 0,
      vendues: m?.vendues ?? 0,
      envois: m?.envois ?? 0,
      restock_non_saisi: m?.restock_non_saisi ?? 0,
    });
    precedente = q;
  }
  return lignes.reverse();
}

/** Rattrapage unique : photo du stock à partir des quantités déjà importées. */
export function migrerRelevesStock(db) {
  if (lireParametre(db, 'migration.stock_releves') === '1') return;
  transaction(db, () => {
    const dejaFait = db.prepare('SELECT 1 FROM stock_releves LIMIT 1').get();
    const dernier = db.prepare("SELECT id FROM imports WHERE type = 'inventaire' ORDER BY id DESC LIMIT 1").get();
    if (!dejaFait && dernier) {
      const ins = db.prepare('INSERT OR IGNORE INTO stock_releves (import_id, asin, quantite) VALUES (?, ?, ?)');
      for (const p of db.prepare('SELECT asin, quantite_inventaire FROM produits WHERE quantite_inventaire IS NOT NULL').all()) ins.run(dernier.id, p.asin, p.quantite_inventaire);
    }
    db.prepare("INSERT INTO parametres (cle, valeur) VALUES ('migration.stock_releves', '1') ON CONFLICT(cle) DO UPDATE SET valeur = '1'").run();
  });
}
