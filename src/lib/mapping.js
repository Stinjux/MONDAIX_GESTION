// Détection flexible des colonnes d'un fichier importé.
import { normaliserTexte, normaliserAsin, extraireDomaine, parserMontant, parserQuantite } from './parse.js';

export const CHAMPS_INVENTAIRE = {
  asin: { libelle: 'ASIN', obligatoire: true, synonymes: ['asin'] },
  cost: {
    libelle: 'Coût d’achat unitaire HT (cost)',
    obligatoire: false,
    synonymes: ['cost', 'cout', 'cout unitaire', 'cout achat', 'unit cost', 'cost per unit', 'prix achat', 'buy cost'],
  },
  sku: { libelle: 'SKU', obligatoire: false, synonymes: ['sku', 'seller sku', 'msku', 'merchant sku'] },
  expedition: {
    libelle: 'Mode d’expédition (fba / mf)',
    obligatoire: false,
    synonymes: ['fulfillment type', 'fulfillment channel', 'fulfilment type', 'fulfilled by', 'expedition'],
  },
  titre: { libelle: 'Titre', obligatoire: false, synonymes: ['title', 'titre', 'product name', 'nom', 'item name', 'name', 'description'] },
  quantite: {
    libelle: 'Quantité en inventaire',
    obligatoire: false,
    synonymes: ['quantity', 'quantite', 'qty', 'stock', 'available', 'disponible', 'fulfillable quantity'],
  },
};

const VALIDATEURS_CONTENU = {
  asin: (v) => normaliserAsin(v) !== null,
  site: (v) => extraireDomaine(v) !== null,
  quantite: (v) => parserQuantite(v) !== null,
  total: (v) => parserMontant(v) !== null && /[.,$€]/.test(v),
  cost: (v) => parserMontant(v) !== null,
};

/**
 * Propose un mapping champ → index de colonne.
 * 1) correspondance exacte d'en-tête, 2) en-tête contenant un synonyme,
 * 3) pour les colonnes restantes, analyse du contenu (ASIN, liens).
 */
export function proposerMapping(entetes, lignes, champs) {
  const normes = entetes.map(normaliserTexte);
  const mapping = {};
  const utilisees = new Set();

  const attribuer = (test) => {
    for (const [champ, def] of Object.entries(champs)) {
      if (mapping[champ] !== undefined) continue;
      for (const syn of def.synonymes) {
        const idx = normes.findIndex((h, i) => !utilisees.has(i) && test(h, syn));
        if (idx >= 0) {
          mapping[champ] = idx;
          utilisees.add(idx);
          break;
        }
      }
    }
  };
  attribuer((h, syn) => h === syn);
  attribuer((h, syn) => syn.length >= 3 && (` ${h} `).includes(` ${syn} `));

  const echantillon = lignes.slice(0, 30);
  for (const champ of ['asin', 'site']) {
    if (!(champ in champs) || mapping[champ] !== undefined) continue;
    let meilleur = -1;
    let score = 0;
    entetes.forEach((_, i) => {
      if (utilisees.has(i)) return;
      const valides = echantillon.filter((l) => l[i] && VALIDATEURS_CONTENU[champ](l[i])).length;
      if (valides > score) {
        score = valides;
        meilleur = i;
      }
    });
    if (meilleur >= 0 && score >= Math.max(1, echantillon.length / 2)) {
      mapping[champ] = meilleur;
      utilisees.add(meilleur);
    }
  }
  return mapping;
}

/** Vérifie un mapping fourni par l'utilisateur (indices de colonnes). */
export function validerMapping(mapping, entetes, champs) {
  const propre = {};
  for (const [champ, idx] of Object.entries(mapping || {})) {
    if (!(champ in champs)) continue;
    if (idx === null || idx === '' || idx === undefined) continue;
    const n = Number(idx);
    if (!Number.isInteger(n) || n < 0 || n >= entetes.length) throw new Error(`Colonne invalide pour ${champ}.`);
    propre[champ] = n;
  }
  for (const [champ, def] of Object.entries(champs)) {
    if (def.obligatoire && propre[champ] === undefined) throw new Error(`La colonne « ${def.libelle} » doit être associée.`);
  }
  return propre;
}
