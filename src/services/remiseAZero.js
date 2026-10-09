// Remise à zéro complète des données (ASIN, factures, fournisseurs, envois, stock, ventes, imports,
// dépenses, emails, autorisations, journal). Les paramètres sont conservés, dont les accès email :
// jeton du webhook et état de la synchronisation Gmail / Neo (les identifiants IMAP sont dans les
// variables d'environnement, jamais dans la base). Une copie complète de la
// base et des documents de factures est faite avant l'effacement (dossier « sauvegardes »).
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { journaliser, lireParametre, ecrireParametre } from '../db.js';
import { cheminBase } from '../env.js';
import { dossierDocuments } from './documentsFactures.js';

/** Tables effacées : toutes sauf « parametres » (réglages, état des synchronisations, drapeaux). */
function tablesDeDonnees(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'parametres'")
    .all()
    .map((t) => t.name);
}

export function toutEffacer(db, { chemin = cheminBase() } = {}) {
  const horodatage = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  let sauvegarde = null;
  if (chemin !== ':memory:') {
    const dossier = join(dirname(chemin), 'sauvegardes', `avant-remise-a-zero-${horodatage}`);
    mkdirSync(dossier, { recursive: true });
    sauvegarde = join(dossier, 'mondaix.sqlite');
    db.exec(`VACUUM INTO '${sauvegarde.replace(/'/g, "''")}'`);
    const documents = dossierDocuments();
    if (existsSync(documents)) renameSync(documents, join(dossier, 'factures'));
  }
  const tables = tablesDeDonnees(db);
  const lignes = {};
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    for (const t of tables) {
      lignes[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
      db.exec(`DELETE FROM "${t}"`);
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get()) db.exec('DELETE FROM sqlite_sequence');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  journaliser(db, 'systeme', null, 'remise_a_zero', { sauvegarde, lignes });
  return { sauvegarde, lignes };
}

const DRAPEAU = 'migration.remise_a_zero_20261009';

/** Remise à zéro demandée le 2026-10-09 : exécutée une seule fois, au démarrage. */
export function migrerRemiseAZero(db, options) {
  if (lireParametre(db, DRAPEAU)) return null;
  const r = toutEffacer(db, options);
  ecrireParametre(db, DRAPEAU, new Date().toISOString());
  return r;
}
