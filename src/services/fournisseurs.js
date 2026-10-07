import { ErreurMetier, journaliser } from '../db.js';
import { extraireDomaine, nomDepuisDomaine, normaliserTexte } from '../lib/parse.js';

function versObjet(r) {
  return r && { ...r, domaines: JSON.parse(r.domaines || '[]') };
}

export function listerFournisseurs(db) {
  return db.prepare('SELECT * FROM fournisseurs ORDER BY nom COLLATE NOCASE').all().map(versObjet);
}

export function lireFournisseur(db, id) {
  return versObjet(db.prepare('SELECT * FROM fournisseurs WHERE id = ?').get(id));
}

function nettoyerDomaines(domaines) {
  const liste = Array.isArray(domaines) ? domaines : String(domaines || '').split(/[\s,;]+/);
  return [...new Set(liste.map((d) => extraireDomaine(d)).filter(Boolean))];
}

export function creerFournisseur(db, { nom, domaines = [], notes = null }) {
  if (!nom || !String(nom).trim()) throw new ErreurMetier('Le nom du fournisseur est obligatoire.');
  const doms = nettoyerDomaines(domaines);
  for (const d of doms) {
    const existant = trouverParDomaine(db, d);
    if (existant) throw new ErreurMetier(`Le domaine ${d} est déjà associé à ${existant.nom}.`);
  }
  const r = db
    .prepare('INSERT INTO fournisseurs (nom, domaines, notes) VALUES (?, ?, ?)')
    .run(String(nom).trim(), JSON.stringify(doms), notes);
  journaliser(db, 'fournisseur', r.lastInsertRowid, 'creation', { nom, domaines: doms });
  return lireFournisseur(db, r.lastInsertRowid);
}

export function modifierFournisseur(db, id, { nom, domaines, notes }) {
  const f = lireFournisseur(db, id);
  if (!f) throw new ErreurMetier('Fournisseur introuvable.', 404);
  const doms = domaines === undefined ? f.domaines : nettoyerDomaines(domaines);
  for (const d of doms) {
    const existant = trouverParDomaine(db, d);
    if (existant && existant.id !== f.id) throw new ErreurMetier(`Le domaine ${d} est déjà associé à ${existant.nom}.`);
  }
  db.prepare('UPDATE fournisseurs SET nom = ?, domaines = ?, notes = ? WHERE id = ?').run(
    nom ?? f.nom,
    JSON.stringify(doms),
    notes === undefined ? f.notes : notes,
    id,
  );
  journaliser(db, 'fournisseur', id, 'modification', { avant: f, domaines: doms });
  return lireFournisseur(db, id);
}

/** Fournisseur dont un domaine correspond exactement ou en tant que sous-domaine. */
export function trouverParDomaine(db, domaine) {
  if (!domaine) return null;
  for (const f of listerFournisseurs(db)) {
    if (f.domaines.some((d) => domaine === d || domaine.endsWith('.' + d))) return f;
  }
  return null;
}

/**
 * Propose un fournisseur à partir du lien saisi (domaine, page produit ou simple nom).
 * La proposition doit toujours être validée manuellement.
 */
export function proposerFournisseur(db, lien) {
  const domaine = extraireDomaine(lien);
  if (domaine) {
    const f = trouverParDomaine(db, domaine);
    if (f) return { domaine, fournisseur: f, nomPropose: null, motif: `domaine ${domaine}` };
    return { domaine, fournisseur: null, nomPropose: nomDepuisDomaine(domaine), motif: 'nouveau domaine' };
  }
  const nom = normaliserTexte(lien);
  if (!nom) return { domaine: null, fournisseur: null, nomPropose: null, motif: 'lien vide' };
  const f = listerFournisseurs(db).find((x) => normaliserTexte(x.nom) === nom);
  if (f) return { domaine: null, fournisseur: f, nomPropose: null, motif: 'nom identique' };
  return { domaine: null, fournisseur: null, nomPropose: String(lien).trim(), motif: 'nom saisi' };
}
