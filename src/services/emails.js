// Réception des emails, associés directement aux ASIN.
//   Gmail : confirmations des fournisseurs (achats).
//   Neo   : réponses aux demandes d'autorisation de vente Amazon.
import { createHash } from 'node:crypto';
import { ErreurMetier, assurerProduit, journaliser, lireParametre, transaction } from '../db.js';
import { extraireReferences, parserEml } from '../lib/email.js';
import { normaliserAsin } from '../lib/parse.js';
import { STATUTS_DOSSIER } from './autorisations.js';

export const SOURCES_EMAIL = {
  gmail: { module: 'commandes', libelle: 'Gmail', role: 'Confirmations des fournisseurs (achats)' },
  neo: { module: 'autorisations', libelle: 'Neo', role: 'Réponses aux demandes d’autorisation de vente Amazon' },
};

function verifierSource(source) {
  if (!(source in SOURCES_EMAIL)) throw new ErreurMetier(`Source email inconnue : ${source}. Sources : gmail, neo.`);
  return SOURCES_EMAIL[source].module;
}

function versObjet(e) {
  return e && { ...e, references_extraites: JSON.parse(e.references_extraites || '{}'), propositions: JSON.parse(e.propositions || '[]') };
}

export function lireEmail(db, id) {
  const e = versObjet(db.prepare('SELECT * FROM emails WHERE id = ?').get(id));
  if (!e) throw new ErreurMetier('Email introuvable.', 404);
  return { ...e, liens: db.prepare('SELECT * FROM email_liens WHERE email_id = ? ORDER BY type, valeur').all(id) };
}

export function etatSources(db) {
  return Object.entries(SOURCES_EMAIL).map(([source, def]) => {
    const stats = db
      .prepare(
        `SELECT COUNT(*) AS total,
           SUM(CASE WHEN statut_rapprochement IN ('non_rapproche', 'propose', 'ambigu') THEN 1 ELSE 0 END) AS a_traiter
         FROM emails WHERE source = ?`,
      )
      .get(source);
    return { source, ...def, total: stats.total, a_traiter: stats.a_traiter || 0 };
  });
}

/**
 * Enregistre un email reçu d'une source et lance le rapprochement.
 * message : { messageId, expediteur, sujet, date, corps }
 */
export function ingererEmail(db, source, message, modeSaisie = 'manuel') {
  const module = verifierSource(source);
  if (!message || (!message.sujet && !message.corps)) throw new ErreurMetier('Email vide.');
  const messageId =
    message.messageId ||
    'sans-id-' + createHash('sha1').update(`${message.expediteur}|${message.sujet}|${message.date}|${message.corps}`).digest('hex').slice(0, 16);
  const existant = db.prepare('SELECT id FROM emails WHERE source = ? AND message_id = ?').get(source, messageId);
  if (existant) return { id: existant.id, doublon: true };
  const refs = extraireReferences(module, message);
  const r = db
    .prepare(
      `INSERT INTO emails (source, module, message_id, expediteur, sujet, date_reception, corps, references_extraites, mode_saisie)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(source, module, messageId, message.expediteur || null, message.sujet || null, message.date || new Date().toISOString(), message.corps || null, JSON.stringify(refs), modeSaisie);
  const id = Number(r.lastInsertRowid);
  journaliser(db, 'email', id, 'reception', { source, module, mode: modeSaisie });
  rapprocherEmail(db, id);
  lierReferencesDetectees(db, id);
  return { id, doublon: false };
}

/* ------------------------------------------------- liens email ↔ ASIN / cas */

/**
 * Associe un email (Gmail ou Neo) directement à un ASIN.
 * (Les anciens liens « numéro de cas » restent en base mais ne sont plus créés ni affichés.)
 */
export function lierEmail(db, emailId, { type = 'asin', valeur }, mode = 'manuel') {
  lireEmail(db, emailId);
  if (type !== 'asin') throw new ErreurMetier('Les emails s’associent directement à un ASIN.');
  const v = normaliserAsin(valeur);
  if (!v) throw new ErreurMetier('ASIN invalide.');
  assurerProduit(db, v);
  const r = db.prepare('INSERT OR IGNORE INTO email_liens (email_id, type, valeur, mode) VALUES (?, ?, ?, ?)').run(emailId, 'asin', v, mode);
  if (r.changes) journaliser(db, 'email', emailId, 'lien_ajoute', { type: 'asin', valeur: v, mode });
  majStatutAsin(db, emailId);
  return { type: 'asin', valeur: v };
}

export function delierEmail(db, lienId) {
  const l = db.prepare('SELECT * FROM email_liens WHERE id = ?').get(lienId);
  if (!l) throw new ErreurMetier('Lien introuvable.', 404);
  db.prepare('DELETE FROM email_liens WHERE id = ?').run(lienId);
  journaliser(db, 'email', l.email_id, 'lien_retire', l);
  majStatutAsin(db, l.email_id);
}

/** Email (Gmail ou Neo) : « traité » dès qu'il est associé à au moins un ASIN. */
function majStatutAsin(db, emailId) {
  const e = db.prepare('SELECT source, statut_rapprochement FROM emails WHERE id = ?').get(emailId);
  if (!e || e.statut_rapprochement === 'ignore') return;
  const lien = db.prepare("SELECT mode FROM email_liens WHERE email_id = ? AND type = 'asin' ORDER BY mode = 'manuel' DESC LIMIT 1").get(emailId);
  db.prepare("UPDATE emails SET statut_rapprochement = ?, mode_rapprochement = ?, propositions = '[]' WHERE id = ?").run(
    lien ? 'valide' : 'non_rapproche',
    lien ? lien.mode : null,
    emailId,
  );
}

export function liensEmail(db, emailId) {
  return db.prepare('SELECT * FROM email_liens WHERE email_id = ? ORDER BY type, valeur').all(emailId);
}

/**
 * Liaison automatique d'une référence détectée sans ambiguïté :
 * un seul ASIN cité → lien ASIN ; un seul n° de cas cité → lien cas.
 * Plusieurs références → simples suggestions, à valider dans l'interface.
 */
export function lierReferencesDetectees(db, emailId) {
  const e = lireEmail(db, emailId);
  const refs = e.references_extraites;
  const asins = refs.asins || [];
  if (asins.length === 1) lierEmail(db, emailId, { type: 'asin', valeur: asins[0] }, 'auto');
}

/** Emails liés à un ASIN : lien direct, dossier d'autorisation ou commande contenant l'ASIN. */
export function emailsPourAsin(db, asin) {
  return db
    .prepare(
      `SELECT DISTINCT e.id, e.source, e.expediteur, e.sujet, e.date_reception, e.commande_id, e.dossier_id,
         CASE WHEN l.id IS NOT NULL THEN 'lien direct' WHEN d.id IS NOT NULL THEN 'dossier d’autorisation' ELSE 'import (ancien)' END AS via
       FROM emails e
       LEFT JOIN email_liens l ON l.email_id = e.id AND l.type = 'asin' AND l.valeur = ?
       LEFT JOIN dossiers_autorisation d ON d.id = e.dossier_id AND d.asin = ?
       LEFT JOIN commande_lignes cl ON cl.commande_id = e.commande_id AND cl.asin = ?
       WHERE l.id IS NOT NULL OR d.id IS NOT NULL OR cl.id IS NOT NULL
       ORDER BY e.date_reception DESC`,
    )
    .all(asin, asin, asin);
}

/** Rattrapage unique pour les emails reçus avant l'ajout des liens. */
export function migrerLiensEmails(db) {
  if (lireParametre(db, 'migration.email_liens') === '1') return 0;
  const ids = db.prepare('SELECT id FROM emails').all().map((r) => r.id);
  transaction(db, () => {
    for (const id of ids) lierReferencesDetectees(db, id);
    db.prepare("INSERT INTO parametres (cle, valeur) VALUES ('migration.email_liens', '1') ON CONFLICT(cle) DO UPDATE SET valeur = '1'").run();
  });
  return ids.length;
}

export function ingererEml(db, source, brut, modeSaisie = 'eml') {
  return ingererEmail(db, source, parserEml(brut), modeSaisie);
}

/* ------------------------------------------------------------ rapprochement */

/** Statut d'un email : associé dès qu'il a au moins un ASIN, sinon à traiter. */
export function rapprocherEmail(db, id) {
  majStatutAsin(db, id);
  return lireEmail(db, id);
}

export function relancerRapprochements(db, source = null) {
  const ids = db
    .prepare(`SELECT id FROM emails WHERE statut_rapprochement IN ('non_rapproche', 'propose', 'ambigu') ${source ? 'AND source = ?' : ''}`)
    .all(...(source ? [source] : []))
    .map((r) => r.id);
  for (const id of ids) rapprocherEmail(db, id);
  return ids.length;
}

/** « Ne plus ignorer » : l'email redevient à traiter (ou associé s'il a un ASIN). */
export function dissocierEmail(db, id) {
  lireEmail(db, id);
  db.prepare("UPDATE emails SET statut_rapprochement = 'non_rapproche', mode_rapprochement = NULL WHERE id = ?").run(id);
  journaliser(db, 'email', id, 'reactive');
  return rapprocherEmail(db, id);
}

export function ignorerEmail(db, id) {
  lireEmail(db, id);
  db.prepare("UPDATE emails SET statut_rapprochement = 'ignore' WHERE id = ?").run(id);
  journaliser(db, 'email', id, 'ignore');
}

/**
 * Applique au dossier le statut détecté dans la réponse Neo, après validation.
 * Le statut devient « confirmé » (réponse d'Amazon à l'appui).
 */
/**
 * Applique le statut d'autorisation lu dans une réponse Neo aux ASIN associés à l'email
 * (dernier dossier de chaque ASIN, créé au besoin). Approuvé / refusé = statut confirmé.
 */
export function appliquerStatutNeo(db, id, statut) {
  const e = lireEmail(db, id);
  if (e.source !== 'neo') throw new ErreurMetier('Seules les réponses Neo modifient une autorisation.');
  if (!(statut in STATUTS_DOSSIER)) throw new ErreurMetier('Statut invalide.');
  const asins = e.liens.filter((l) => l.type === 'asin').map((l) => l.valeur);
  if (!asins.length) throw new ErreurMetier('Associez d’abord l’email à un ASIN.');
  const confirme = ['approuve', 'refuse'].includes(statut) ? 1 : 0;
  return transaction(db, () => {
    for (const asin of asins) {
      const d = db.prepare('SELECT * FROM dossiers_autorisation WHERE asin = ? ORDER BY id DESC LIMIT 1').get(asin);
      if (d) {
        db.prepare("UPDATE dossiers_autorisation SET statut = ?, statut_confirme = ?, updated_at = datetime('now') WHERE id = ?").run(statut, confirme, d.id);
        journaliser(db, 'dossier', d.id, 'statut_depuis_neo', { avant: d.statut, apres: statut, email_id: id });
      } else {
        const r = db.prepare('INSERT INTO dossiers_autorisation (asin, statut, statut_confirme) VALUES (?, ?, ?)').run(asin, statut, confirme);
        journaliser(db, 'dossier', r.lastInsertRowid, 'creation_depuis_neo', { asin, statut, email_id: id });
      }
    }
    return { asins };
  });
}

/**
 * Rattrapage unique : une réponse Neo rattachée à un dossier devient associée à l'ASIN
 * de ce dossier ; le statut « à traiter » des réponses Neo est recalculé.
 */
export function migrerNeoVersAsin(db) {
  if (lireParametre(db, 'migration.neo_asin') === '1') return;
  transaction(db, () => {
    const anciens = db
      .prepare(
        `SELECT e.id, d.asin, e.mode_rapprochement FROM emails e JOIN dossiers_autorisation d ON d.id = e.dossier_id
         WHERE e.source = 'neo'`,
      )
      .all();
    const ins = db.prepare("INSERT OR IGNORE INTO email_liens (email_id, type, valeur, mode) VALUES (?, 'asin', ?, ?)");
    for (const a of anciens) ins.run(a.id, a.asin, a.mode_rapprochement === 'auto' ? 'auto' : 'manuel');
    for (const { id } of db.prepare("SELECT id FROM emails WHERE source = 'neo'").all()) majStatutAsin(db, id);
    db.prepare("INSERT INTO parametres (cle, valeur) VALUES ('migration.neo_asin', '1') ON CONFLICT(cle) DO UPDATE SET valeur = '1'").run();
  });
}

/**
 * Rattrapage unique : une confirmation Gmail rattachée à une commande reçoit les ASIN de
 * cette commande ; le statut des emails Gmail est recalculé (associé = au moins un ASIN).
 */
export function migrerGmailVersAsin(db) {
  if (lireParametre(db, 'migration.gmail_asin') === '1') return;
  transaction(db, () => {
    const anciens = db
      .prepare(
        `SELECT DISTINCT e.id, cl.asin, e.mode_rapprochement FROM emails e JOIN commande_lignes cl ON cl.commande_id = e.commande_id
         WHERE e.source = 'gmail'`,
      )
      .all();
    const ins = db.prepare("INSERT OR IGNORE INTO email_liens (email_id, type, valeur, mode) VALUES (?, 'asin', ?, ?)");
    for (const a of anciens) ins.run(a.id, a.asin, a.mode_rapprochement === 'auto' ? 'auto' : 'manuel');
    for (const { id } of db.prepare("SELECT id FROM emails WHERE source = 'gmail'").all()) majStatutAsin(db, id);
    db.prepare("INSERT INTO parametres (cle, valeur) VALUES ('migration.gmail_asin', '1') ON CONFLICT(cle) DO UPDATE SET valeur = '1'").run();
  });
}

export function listerEmails(db, { source, statut } = {}) {
  const conds = [];
  const params = [];
  if (source) {
    verifierSource(source);
    conds.push('e.source = ?');
    params.push(source);
  }
  if (statut === 'a_traiter') conds.push("e.statut_rapprochement IN ('non_rapproche', 'propose', 'ambigu')");
  else if (statut) {
    conds.push('e.statut_rapprochement = ?');
    params.push(statut);
  }
  return db
    .prepare(
      `SELECT e.id, e.source, e.module, e.expediteur, e.sujet, e.date_reception, e.references_extraites, e.propositions,
         e.commande_id, e.dossier_id, e.statut_rapprochement, e.mode_rapprochement, e.mode_saisie,
         c.numero_commande, d.asin AS dossier_asin, d.numero_cas AS dossier_cas
       FROM emails e
       LEFT JOIN commandes c ON c.id = e.commande_id
       LEFT JOIN dossiers_autorisation d ON d.id = e.dossier_id
       ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
       ORDER BY e.date_reception DESC, e.id DESC`,
    )
    .all(...params)
    .map(versObjet)
    .map((e) => ({ ...e, liens: liensEmail(db, e.id) }));
}
