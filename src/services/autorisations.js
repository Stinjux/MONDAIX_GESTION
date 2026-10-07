// Dossiers de demande d'autorisation de vente Amazon (ASIN → dossier → n° de cas → réponse Neo).
import { ErreurMetier, assurerProduit, journaliser } from '../db.js';
import { normaliserAsin, parserDate } from '../lib/parse.js';

export const STATUTS_DOSSIER = {
  a_demander: 'À demander',
  demande_envoyee: 'Demande envoyée',
  documents_requis: 'Documents requis',
  approuve: 'Approuvé',
  refuse: 'Refusé',
};

const STATUTS_FINAUX = ['approuve', 'refuse'];

function verifierStatut(statut) {
  if (!(statut in STATUTS_DOSSIER)) throw new ErreurMetier('Statut de dossier invalide.');
}

function nettoyerCas(numero) {
  const s = String(numero ?? '').replace(/\D/g, '');
  return s || null;
}

export function creerDossier(db, d) {
  const asin = normaliserAsin(d.asin);
  if (!asin) throw new ErreurMetier('ASIN invalide.');
  const statut = d.statut || (d.numero_cas ? 'demande_envoyee' : 'a_demander');
  verifierStatut(statut);
  const cas = nettoyerCas(d.numero_cas);
  if (cas) {
    const existant = db.prepare('SELECT id, asin FROM dossiers_autorisation WHERE numero_cas = ?').get(cas);
    if (existant) throw new ErreurMetier(`Le cas ${cas} est déjà rattaché au dossier #${existant.id} (${existant.asin}).`, 409);
  }
  assurerProduit(db, asin);
  const r = db
    .prepare('INSERT INTO dossiers_autorisation (asin, statut, numero_cas, date_demande, notes) VALUES (?, ?, ?, ?, ?)')
    .run(asin, statut, cas, parserDate(d.date_demande), d.notes || null);
  journaliser(db, 'dossier', r.lastInsertRowid, 'creation', { asin, statut, numero_cas: cas });
  return Number(r.lastInsertRowid);
}

/**
 * Modification manuelle. Un statut final (approuvé / refusé) saisi à la main
 * n'est « confirmé » que si l'utilisateur le précise explicitement.
 */
export function modifierDossier(db, id, champs) {
  const d = db.prepare('SELECT * FROM dossiers_autorisation WHERE id = ?').get(id);
  if (!d) throw new ErreurMetier('Dossier introuvable.', 404);
  const statut = champs.statut ?? d.statut;
  verifierStatut(statut);
  const cas = champs.numero_cas !== undefined ? nettoyerCas(champs.numero_cas) : d.numero_cas;
  if (cas && cas !== d.numero_cas) {
    const existant = db.prepare('SELECT id FROM dossiers_autorisation WHERE numero_cas = ? AND id <> ?').get(cas, id);
    if (existant) throw new ErreurMetier(`Le cas ${cas} est déjà rattaché au dossier #${existant.id}.`, 409);
  }
  let confirme = d.statut_confirme;
  if (champs.statut_confirme !== undefined) confirme = champs.statut_confirme ? 1 : 0;
  else if (statut !== d.statut) confirme = 0;
  if (confirme && !STATUTS_FINAUX.includes(statut)) confirme = 0;
  db.prepare(
    `UPDATE dossiers_autorisation SET statut = ?, numero_cas = ?, date_demande = ?, notes = ?, statut_confirme = ?,
       updated_at = datetime('now') WHERE id = ?`,
  ).run(
    statut,
    cas,
    champs.date_demande !== undefined ? parserDate(champs.date_demande) : d.date_demande,
    champs.notes !== undefined ? champs.notes : d.notes,
    confirme,
    id,
  );
  journaliser(db, 'dossier', id, 'modification', { avant: d, champs });
}

export function supprimerDossier(db, id) {
  const d = db.prepare('SELECT * FROM dossiers_autorisation WHERE id = ?').get(id);
  if (!d) throw new ErreurMetier('Dossier introuvable.', 404);
  db.prepare("UPDATE emails SET dossier_id = NULL, statut_rapprochement = 'non_rapproche', mode_rapprochement = NULL WHERE dossier_id = ?").run(id);
  db.prepare('DELETE FROM dossiers_autorisation WHERE id = ?').run(id);
  journaliser(db, 'dossier', id, 'suppression', d);
}

export function listerDossiers(db) {
  return db
    .prepare(
      `SELECT d.*, p.titre,
         (SELECT COUNT(*) FROM emails e WHERE e.dossier_id = d.id) AS nb_reponses,
         (SELECT MAX(e.date_reception) FROM emails e WHERE e.dossier_id = d.id) AS derniere_reponse
       FROM dossiers_autorisation d JOIN produits p ON p.asin = d.asin
       ORDER BY d.updated_at DESC, d.id DESC`,
    )
    .all();
}

export function lireDossier(db, id) {
  const d = db.prepare('SELECT d.*, p.titre FROM dossiers_autorisation d JOIN produits p ON p.asin = d.asin WHERE d.id = ?').get(id);
  if (!d) throw new ErreurMetier('Dossier introuvable.', 404);
  const reponses = db
    .prepare('SELECT id, expediteur, sujet, date_reception, references_extraites, mode_rapprochement FROM emails WHERE dossier_id = ? ORDER BY date_reception')
    .all(id)
    .map((e) => ({ ...e, references_extraites: JSON.parse(e.references_extraites) }));
  return { ...d, reponses };
}

export function estConfirme(d) {
  return Boolean(d && STATUTS_FINAUX.includes(d.statut) && d.statut_confirme);
}

/** État d'autorisation de chaque ASIN connu (dernier dossier). */
export function etatParAsin(db) {
  const produits = db.prepare('SELECT asin, titre FROM produits ORDER BY asin').all();
  const dernier = db.prepare('SELECT * FROM dossiers_autorisation WHERE asin = ? ORDER BY id DESC LIMIT 1');
  const reponses = db.prepare('SELECT COUNT(*) AS n FROM emails WHERE dossier_id = ?');
  return produits.map((p) => {
    const d = dernier.get(p.asin);
    return {
      asin: p.asin,
      titre: p.titre,
      dossier_id: d?.id ?? null,
      statut: d?.statut ?? null,
      numero_cas: d?.numero_cas ?? null,
      reponses_neo: d ? reponses.get(d.id).n : 0,
      confirme: estConfirme(d),
    };
  });
}
