// Fonctions de normalisation des valeurs saisies ou importées.

/** Retire les accents et met en minuscules (comparaison d'en-têtes, de noms). */
export function normaliserTexte(valeur) {
  return String(valeur ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const ASIN_RE = /^(B0[0-9A-Z]{8}|\d{9}[0-9X])$/;

/** Retourne l'ASIN en majuscules s'il est valide, sinon null. */
export function normaliserAsin(valeur) {
  const brut = String(valeur ?? '').trim().toUpperCase();
  if (ASIN_RE.test(brut)) return brut;
  // ASIN contenu dans une URL Amazon (/dp/B0..., /gp/product/B0...)
  const m = brut.match(/\/(?:DP|GP\/PRODUCT|PRODUCT)\/([A-Z0-9]{10})/);
  if (m && ASIN_RE.test(m[1])) return m[1];
  return null;
}

/** Repère tous les ASIN (format B0XXXXXXXX) présents dans un texte libre. */
export function extraireAsins(texte) {
  const trouves = String(texte ?? '').toUpperCase().match(/\bB0[0-9A-Z]{8}\b/g) || [];
  return [...new Set(trouves)];
}

/**
 * Convertit un montant saisi (« 1 234,56 $ », « $1,234.56 », « 45.99 », « 12,5 »)
 * en nombre. Retourne null si la valeur est vide ou illisible.
 */
export function parserMontant(valeur) {
  if (valeur === null || valeur === undefined) return null;
  if (typeof valeur === 'number') return Number.isFinite(valeur) ? arrondir(valeur) : null;
  let s = String(valeur).trim();
  if (!s) return null;
  const negatif = /^\(.*\)$/.test(s) || /^-/.test(s) || /-\s*$/.test(s);
  s = s.replace(/[^\d.,]/g, '');
  if (!s || !/\d/.test(s)) return null;
  const derniereVirgule = s.lastIndexOf(',');
  const dernierPoint = s.lastIndexOf('.');
  if (derniereVirgule >= 0 && dernierPoint >= 0) {
    // Le dernier séparateur rencontré est le séparateur décimal.
    if (derniereVirgule > dernierPoint) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (derniereVirgule >= 0) {
    const decimales = s.length - derniereVirgule - 1;
    const occurrences = s.split(',').length - 1;
    // « 12,5 » / « 12,50 » : décimales ; « 1,234 » / « 1,234,567 » : milliers
    if (occurrences === 1 && decimales <= 2) s = s.replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (dernierPoint >= 0) {
    const occurrences = s.split('.').length - 1;
    if (occurrences > 1) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return arrondir(negatif ? -n : n);
}

/** Quantité entière positive, ou null. */
export function parserQuantite(valeur) {
  if (valeur === null || valeur === undefined || valeur === '') return null;
  const s = String(valeur).trim().replace(/\s/g, '').replace(',', '.');
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
  return n;
}

/** Date au format AAAA-MM-JJ (accepte JJ/MM/AAAA, AAAA-MM-JJ, AAAA/MM/JJ). */
export function parserDate(valeur) {
  if (!valeur) return null;
  const s = String(valeur).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return formaterDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return formaterDate(+m[3], +m[2], +m[1]);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function formaterDate(a, mo, j) {
  if (mo < 1 || mo > 12 || j < 1 || j > 31) return null;
  return `${a}-${String(mo).padStart(2, '0')}-${String(j).padStart(2, '0')}`;
}

export function arrondir(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Extrait le domaine d'un lien fournisseur. Accepte un domaine seul
 * (« walmart.ca »), une page produit complète ou un lien sans schéma.
 * Retourne null si la valeur ne ressemble pas à un domaine (ex. « Walmart »).
 */
export function extraireDomaine(valeur) {
  let s = String(valeur ?? '').trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = 'https://' + s;
  try {
    const url = new URL(s);
    const hote = url.hostname.replace(/^www\d?\./, '').replace(/^m\./, '');
    if (!/\.[a-z]{2,}$/.test(hote)) return null;
    return hote;
  } catch {
    return null;
  }
}

/** Nom lisible proposé à partir d'un domaine : « canadiantire.ca » → « Canadiantire ». */
export function nomDepuisDomaine(domaine) {
  if (!domaine) return null;
  const parties = domaine.split('.');
  // Retire le TLD et les sous-domaines courts éventuels (shop., store.)
  const base = parties.length >= 2 ? parties[parties.length - 2] : parties[0];
  const racine = ['co', 'com'].includes(base) && parties.length >= 3 ? parties[parties.length - 3] : base;
  return racine.charAt(0).toUpperCase() + racine.slice(1);
}

/** Normalise un numéro de commande pour comparaison (« #ABC-123 » → « ABC123 »). */
export function normaliserReference(valeur) {
  const s = String(valeur ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s || null;
}

/** Valeur tri-état (oui / non / inconnu) → 1 / 0 / null. */
export function parserTriEtat(valeur) {
  if (valeur === true || valeur === 1 || valeur === '1' || valeur === 'oui') return 1;
  if (valeur === false || valeur === 0 || valeur === '0' || valeur === 'non') return 0;
  return null;
}
