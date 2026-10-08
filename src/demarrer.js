// Démarrage du serveur web et de la synchronisation email.
import { ouvrirBase } from './db.js';
import { relative, isAbsolute } from 'node:path';
import { chargerEnv, cheminBase } from './env.js';
import { estLocal } from './lib/acces.js';
import { creerServeur } from './server.js';
import { planifierSynchro } from './services/synchroEmail.js';
import { migrerLiensEmails, migrerNeoVersAsin } from './services/emails.js';
import { migrerRelevesStock } from './services/inventaire.js';
import { migrerReferencesFactures } from './services/documentsFactures.js';

/**
 * L'application est considérée comme exposée sur Internet si elle écoute ailleurs
 * qu'en local, en production, ou derrière Phusion Passenger (cPanel « Setup Node.js App »).
 */
export function estExposee(env = process.env, hote = env.HOST || '127.0.0.1') {
  return !estLocal(hote) || env.NODE_ENV === 'production' || 'PASSENGER_APP_ENV' in env || typeof globalThis.PhusionPassenger !== 'undefined';
}

/**
 * Sur Railway, la base doit se trouver sur le volume persistant ; sinon elle serait
 * effacée à chaque redéploiement. Retourne un message d'erreur, ou null si tout va bien.
 */
export function verifierStockage(env = process.env, chemin = cheminBase()) {
  if (!('RAILWAY_ENVIRONMENT' in env || 'RAILWAY_PROJECT_ID' in env) || env.MONDAIX_SANS_VOLUME === '1') return null;
  const volume = env.RAILWAY_VOLUME_MOUNT_PATH;
  if (!volume) return 'Aucun volume Railway attaché : ajoutez un volume monté sur /app/data, sinon les données seront perdues à chaque redéploiement.';
  const rel = relative(volume, chemin);
  if (chemin === ':memory:' || rel.startsWith('..') || isAbsolute(rel)) {
    return `La base (${chemin}) n’est pas sur le volume Railway (${volume}) : montez le volume sur /app/data ou ajustez MONDAIX_DB.`;
  }
  return null;
}

export function demarrer() {
  chargerEnv();
  const port = Number(process.env.PORT) || 3000;
  const hote = process.env.HOST || '127.0.0.1';
  const motDePasse = process.env.MONDAIX_MOT_DE_PASSE || '';
  if (estExposee() && !motDePasse && process.env.MONDAIX_SANS_AUTH !== '1') {
    const message = 'Refus de démarrer : application exposée sur Internet sans MONDAIX_MOT_DE_PASSE (à définir dans .env).';
    console.error(message);
    throw new Error(message);
  }
  const erreurStockage = verifierStockage();
  if (erreurStockage) {
    const message = `Refus de démarrer : ${erreurStockage}`;
    console.error(message);
    throw new Error(message);
  }
  const db = ouvrirBase(cheminBase());
  migrerLiensEmails(db);
  migrerNeoVersAsin(db);
  migrerRelevesStock(db);
  migrerReferencesFactures(db);
  const serveur = creerServeur(db, { acces: { utilisateur: process.env.MONDAIX_UTILISATEUR || 'admin', motDePasse } });
  // Sous Passenger, l'appel à listen() est intercepté : le port et l'hôte sont alors ignorés.
  serveur.listen(port, hote, () => console.log(`Mondaix Gestion : http://${hote}:${port}${motDePasse ? ' (protégé par mot de passe)' : ''}`));
  planifierSynchro(db);
  return serveur;
}
