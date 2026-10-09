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

/** Modifie la quantité et/ou la commande d'origine d'une ligne d'envoi. */
export function modifierLigneEnvoi(db, ligneId, champs) {
  const l = db.prepare('SELECT * FROM envoi_lignes WHERE id = ?').get(ligneId);
  if (!l) throw new ErreurMetier('Ligne introuvable.', 404);
  transaction(db, () => {
    if (champs.quantite !== undefined) {
      const quantite = parserQuantite(champs.quantite);
      if (!quantite) throw new ErreurMetier('Quantité invalide.');
      db.prepare('UPDATE envoi_lignes SET quantite = ? WHERE id = ?').run(quantite, ligneId);
      journaliser(db, 'envoi', l.envoi_id, 'quantite_modifiee', { ligne_id: ligneId, avant: l.quantite, apres: quantite });
    }
    if (champs.commande_id !== undefined) rattacherLigneEnvoi(db, ligneId, champs.commande_id ? Number(champs.commande_id) : null);
  });
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

/**
 * Réception constatée par Amazon : quantité reçue par ligne. Quand toutes les lignes ont
 * une quantité reçue, l'envoi passe à « Reçu par Amazon » (date de réception enregistrée).
 */
export function enregistrerReception(db, envoiId, { lignes = [], date_reception } = {}) {
  const e = db.prepare('SELECT * FROM envois WHERE id = ?').get(envoiId);
  if (!e) throw new ErreurMetier('Envoi introuvable.', 404);
  return transaction(db, () => {
    for (const l of lignes) {
      const ligne = db.prepare('SELECT * FROM envoi_lignes WHERE id = ? AND envoi_id = ?').get(Number(l.id), envoiId);
      if (!ligne) throw new ErreurMetier('Ligne introuvable dans cet envoi.', 404);
      let recue = null;
      if (l.quantite_recue !== '' && l.quantite_recue !== null && l.quantite_recue !== undefined) {
        recue = Number(l.quantite_recue);
        if (!Number.isInteger(recue) || recue < 0) throw new ErreurMetier(`${ligne.asin} : quantité reçue invalide.`);
      }
      db.prepare('UPDATE envoi_lignes SET quantite_recue = ? WHERE id = ?').run(recue, ligne.id);
    }
    const restantes = db.prepare('SELECT COUNT(*) AS n FROM envoi_lignes WHERE envoi_id = ? AND quantite_recue IS NULL').get(envoiId).n;
    const nbLignes = db.prepare('SELECT COUNT(*) AS n FROM envoi_lignes WHERE envoi_id = ?').get(envoiId).n;
    if (nbLignes && !restantes && (e.statut === 'en_preparation' || e.statut === 'expedie')) {
      const date = parserDate(date_reception) || e.date_reception || new Date().toISOString().slice(0, 10);
      db.prepare("UPDATE envois SET statut = 'recu_amazon', date_reception = ? WHERE id = ?").run(date, envoiId);
    } else if (date_reception !== undefined) {
      db.prepare('UPDATE envois SET date_reception = ? WHERE id = ?').run(parserDate(date_reception), envoiId);
    }
    journaliser(db, 'envoi', envoiId, 'reception', { lignes, date_reception });
    return suiviEnvoi(db, envoiId);
  });
}

/** Tout est arrivé : quantité reçue = quantité envoyée pour chaque ligne. */
export function toutRecu(db, envoiId, { date_reception } = {}) {
  const lignes = db.prepare('SELECT id, quantite AS quantite_recue FROM envoi_lignes WHERE envoi_id = ?').all(envoiId);
  if (!lignes.length) throw new ErreurMetier('Envoi vide.');
  return enregistrerReception(db, envoiId, { lignes, date_reception });
}

/**
 * État de suivi d'un envoi : en_preparation, en_transit (expédié, réception non saisie),
 * partiel (réception saisie pour une partie des lignes), recu (tout reçu), ecart (reçu ≠ envoyé).
 */
export function suiviEnvoi(db, envoiId) {
  const e = db.prepare('SELECT statut FROM envois WHERE id = ?').get(envoiId);
  const lignes = db.prepare('SELECT quantite, quantite_recue FROM envoi_lignes WHERE envoi_id = ?').all(envoiId);
  const envoyees = lignes.reduce((s, l) => s + l.quantite, 0);
  const saisies = lignes.filter((l) => l.quantite_recue !== null);
  const recues = saisies.reduce((s, l) => s + l.quantite_recue, 0);
  const ecart = saisies.reduce((s, l) => s + (l.quantite_recue - l.quantite), 0);
  let etat;
  if (e.statut === 'en_preparation' && !saisies.length) etat = 'en_preparation';
  else if (!saisies.length) etat = 'en_transit';
  else if (saisies.length < lignes.length) etat = 'partiel';
  else etat = ecart === 0 ? 'recu' : 'ecart';
  const aVerifier = lignes.filter((l) => l.quantite_recue === null).reduce((s, l) => s + l.quantite, 0);
  return { etat, unites_envoyees: envoyees, unites_recues: recues, ecart, lignes_a_verifier: lignes.length - saisies.length, unites_a_verifier: aVerifier };
}

export const ETATS_SUIVI = {
  en_preparation: 'En préparation',
  en_transit: 'En transit : réception à vérifier',
  partiel: 'Réception partielle saisie',
  recu: 'Tout reçu par Amazon',
  ecart: 'Écart à la réception',
};

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
         (SELECT COALESCE(SUM(montant), 0) FROM depenses d WHERE d.envoi_id = e.id) AS frais
       FROM envois e LEFT JOIN envoi_lignes el ON el.envoi_id = e.id
       GROUP BY e.id ORDER BY COALESCE(e.date_envoi, e.created_at) DESC, e.id DESC`,
    )
    .all()
    .map((e) => ({ ...e, suivi: suiviEnvoi(db, e.id) }));
}

export function lireEnvoi(db, id) {
  const e = db.prepare('SELECT * FROM envois WHERE id = ?').get(id);
  if (!e) throw new ErreurMetier('Envoi introuvable.', 404);
  const lignes = db
    .prepare(
      `SELECT el.*, p.titre FROM envoi_lignes el JOIN produits p ON p.asin = el.asin
       WHERE el.envoi_id = ? ORDER BY el.id`,
    )
    .all(id);
  const depenses = db.prepare('SELECT * FROM depenses WHERE envoi_id = ? ORDER BY id').all(id);
  return { ...e, lignes, depenses, suivi: suiviEnvoi(db, id) };
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
