// Chemins et variables d'environnement, résolus depuis la racine du projet
// (et non le dossier courant, qui varie selon l'hébergeur).
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RACINE = fileURLToPath(new URL('..', import.meta.url));

/** Charge le fichier .env de la racine s'il existe (les variables déjà définies sont prioritaires). */
export function chargerEnv() {
  const chemin = resolve(RACINE, '.env');
  if (existsSync(chemin)) process.loadEnvFile(chemin);
}

/** Chemin de la base SQLite (MONDAIX_DB, relatif à la racine du projet). */
export function cheminBase() {
  const valeur = process.env.MONDAIX_DB || 'data/mondaix.sqlite';
  return valeur === ':memory:' || isAbsolute(valeur) ? valeur : resolve(RACINE, valeur);
}
