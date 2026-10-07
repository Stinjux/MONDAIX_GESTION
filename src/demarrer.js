// Démarrage du serveur web et de la synchronisation email.
import { ouvrirBase } from './db.js';
import { chargerEnv, cheminBase } from './env.js';
import { estLocal } from './lib/acces.js';
import { creerServeur } from './server.js';
import { planifierSynchro } from './services/synchroEmail.js';

/**
 * L'application est considérée comme exposée sur Internet si elle écoute ailleurs
 * qu'en local, en production, ou derrière Phusion Passenger (cPanel « Setup Node.js App »).
 */
export function estExposee(env = process.env, hote = env.HOST || '127.0.0.1') {
  return !estLocal(hote) || env.NODE_ENV === 'production' || 'PASSENGER_APP_ENV' in env || typeof globalThis.PhusionPassenger !== 'undefined';
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
  const db = ouvrirBase(cheminBase());
  const serveur = creerServeur(db, { acces: { utilisateur: process.env.MONDAIX_UTILISATEUR || 'admin', motDePasse } });
  // Sous Passenger, l'appel à listen() est intercepté : le port et l'hôte sont alors ignorés.
  serveur.listen(port, hote, () => console.log(`Mondaix Gestion : http://${hote}:${port}${motDePasse ? ' (protégé par mot de passe)' : ''}`));
  planifierSynchro(db);
  return serveur;
}
