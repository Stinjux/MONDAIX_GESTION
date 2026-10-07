// Envois vers les entrepôts Amazon (FBA).
import { ErreurMetier, assurerProduit, journaliser, transaction } from '../db.js';
import { normaliserAsin, parserDate, parserQuantite } from '../lib/parse.js';

export const STATUTS_ENVOI = {
  en_preparation: 'En préparation',
  expedie: 'Expédié',
  recu_amazon: 'Reçu par Amazon',
  cloture: 'Clôturé',
};

function lignesValides(lignes) {
  return (lignes || []).filter((l) => l.asin).map((l, i) => {
    const asin = normaliserAsin(l.asin);
    const quantite = parserQuantite(l.quantite);
    if (!asin || !quantite) throw new ErreurMetier(`Ligne ${i + 1} : ASIN ou quantité invalide.`);
    return { asin, quantite, commande_id: l.commande_id ? Number(l.commande_id) : null };
  });
}

export function creerEnvoi(db, e) {
  const statut = e.statut || 'en_preparation';
  if (!(statut in STATUTS_ENVOI)) throw new ErreurMetier('Statut invalide.');
  const lignes = lignesValides(e.lignes);
  return transaction(db, () => {
    const r = db
      .prepare('INSERT INTO envois (numero_envoi, date_envoi, statut, notes) VALUES (?, ?, ?, ?)')
      .run(e.numero_envoi || null, parserDate(e.date_envoi), statut, e.notes || null);
    const id = Number(r.lastInsertRowid);
    for (const l of lignes) ajouterLigne(db, id, l);
    journaliser(db, 'envoi', id, 'creation', { ...e, lignes });
    return id;
  });
}

function ajouterLigne(db, envoiId, l) {
  assurerProduit(db, l.asin);
  if (l.commande_id) {
    const ok = db.prepare('SELECT 1 FROM commande_lignes WHERE commande_id = ? AND asin = ?').get(l.commande_id, l.asin);
    if (!ok) throw new ErreurMetier(`La commande #${l.commande_id} ne contient pas l’ASIN ${l.asin}.`);
  }
  db.prepare('INSERT INTO envoi_lignes (envoi_id, asin, quantite, commande_id) VALUES (?, ?, ?, ?)').run(envoiId, l.asin, l.quantite, l.commande_id);
}

export function ajouterLigneEnvoi(db, envoiId, ligne) {
  if (!db.prepare('SELECT 1 FROM envois WHERE id = ?').get(envoiId)) throw new ErreurMetier('Envoi introuvable.', 404);
  const [l] = lignesValides([ligne]);
  ajouterLigne(db, envoiId, l);
  journaliser(db, 'envoi', envoiId, 'ligne_ajoutee', l);
}

export function rattacherLigneEnvoi(db, ligneId, commandeId) {
  const l = db.prepare('SELECT * FROM envoi_lignes WHERE id = ?').get(ligneId);
  if (!l) throw new ErreurMetier('Ligne introuvable.', 404);
  if (commandeId) {
    const ok = db.prepare('SELECT 1 FROM commande_lignes WHERE commande_id = ? AND asin = ?').get(commandeId, l.asin);
    if (!ok) throw new ErreurMetier(`La commande #${commandeId} ne contient pas l’ASIN ${l.asin}.`);
  }
  db.prepare('UPDATE envoi_lignes SET commande_id = ? WHERE id = ?').run(commandeId || null, ligneId);
  journaliser(db, 'envoi', l.envoi_id, 'ligne_rattachee', { ligne_id: ligneId, avant: l.commande_id, apres: commandeId || null });
}

export function supprimerLigneEnvoi(db, ligneId) {
  const l = db.prepare('SELECT * FROM envoi_lignes WHERE id = ?').get(ligneId);
  if (!l) throw new ErreurMetier('Ligne introuvable.', 404);
  db.prepare('DELETE FROM envoi_lignes WHERE id = ?').run(ligneId);
  journaliser(db, 'envoi', l.envoi_id, 'ligne_supprimee', l);
}

export function modifierEnvoi(db, id, champs) {
  const e = db.prepare('SELECT * FROM envois WHERE id = ?').get(id);
  if (!e) throw new ErreurMetier('Envoi introuvable.', 404);
  const statut = champs.statut ?? e.statut;
  if (!(statut in STATUTS_ENVOI)) throw new ErreurMetier('Statut invalide.');
  db.prepare('UPDATE envois SET numero_envoi = ?, date_envoi = ?, statut = ?, notes = ? WHERE id = ?').run(
    champs.numero_envoi !== undefined ? champs.numero_envoi || null : e.numero_envoi,
    champs.date_envoi !== undefined ? parserDate(champs.date_envoi) : e.date_envoi,
    statut,
    champs.notes !== undefined ? champs.notes : e.notes,
    id,
  );
  journaliser(db, 'envoi', id, 'modification', { avant: e, champs });
}

export function supprimerEnvoi(db, id) {
  const e = db.prepare('SELECT * FROM envois WHERE id = ?').get(id);
  if (!e) throw new ErreurMetier('Envoi introuvable.', 404);
  db.prepare('DELETE FROM envois WHERE id = ?').run(id);
  journaliser(db, 'envoi', id, 'suppression', e);
}

export function listerEnvois(db) {
  return db
    .prepare(
      `SELECT e.*, COALESCE(SUM(el.quantite), 0) AS unites, COUNT(el.id) AS nb_lignes,
         SUM(CASE WHEN el.commande_id IS NULL THEN 1 ELSE 0 END) AS lignes_sans_commande,
         (SELECT COALESCE(SUM(montant), 0) FROM depenses d WHERE d.envoi_id = e.id) AS frais
       FROM envois e LEFT JOIN envoi_lignes el ON el.envoi_id = e.id
       GROUP BY e.id ORDER BY COALESCE(e.date_envoi, e.created_at) DESC, e.id DESC`,
    )
    .all();
}

export function lireEnvoi(db, id) {
  const e = db.prepare('SELECT * FROM envois WHERE id = ?').get(id);
  if (!e) throw new ErreurMetier('Envoi introuvable.', 404);
  const lignes = db
    .prepare(
      `SELECT el.*, p.titre, c.numero_commande FROM envoi_lignes el
       JOIN produits p ON p.asin = el.asin LEFT JOIN commandes c ON c.id = el.commande_id
       WHERE el.envoi_id = ? ORDER BY el.id`,
    )
    .all(id)
    .map((l) => ({ ...l, commandes_possibles: commandesPourAsin(db, l.asin) }));
  const depenses = db.prepare('SELECT * FROM depenses WHERE envoi_id = ? ORDER BY id').all(id);
  return { ...e, lignes, depenses };
}

/** Commandes contenant l'ASIN, avec les quantités reçues et déjà envoyées. */
export function commandesPourAsin(db, asin) {
  return db
    .prepare(
      `SELECT c.id, c.numero_commande, c.date_commande, SUM(cl.quantite) AS commandees,
         (SELECT COALESCE(SUM(rl.quantite), 0) FROM reception_lignes rl JOIN receptions r ON r.id = rl.reception_id
            WHERE r.commande_id = c.id AND rl.asin = ?) AS recues,
         (SELECT COALESCE(SUM(el.quantite), 0) FROM envoi_lignes el WHERE el.commande_id = c.id AND el.asin = ?) AS envoyees
       FROM commandes c JOIN commande_lignes cl ON cl.commande_id = c.id AND cl.asin = ?
       GROUP BY c.id ORDER BY COALESCE(c.date_commande, c.created_at) DESC`,
    )
    .all(asin, asin, asin);
}
