// Import du fichier d'inventaire. La colonne « cost » = prix d'achat unitaire HT
// (sans livraison, préparation ni transport vers Amazon).
import { ErreurMetier, assurerProduit, journaliser, transaction } from '../db.js';
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
    const resultat = { import_id: importId, produits: 0, couts_ajoutes: 0, ecarts: [], rejets: [] };
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
      if (map.quantite !== undefined) {
        const q = l[map.quantite] === '0' ? 0 : parserQuantite(l[map.quantite]);
        if (q !== null) maj.quantite_inventaire = q;
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
    journaliser(db, 'import', importId, 'inventaire', { produits: resultat.produits, ecarts: resultat.ecarts.length });
    return resultat;
  });
}
