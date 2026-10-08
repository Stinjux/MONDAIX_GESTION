// Synchronisation IMAP en lecture seule des boîtes Gmail et Neo.
//   Gmail : messages dont l'objet contient « order » ou « shopping » → module commandes.
//   Neo   : messages d'Amazon dont l'objet contient « brand approval » → module autorisations.
// Les dossiers sont ouverts en lecture seule : rien n'est supprimé, déplacé ni marqué comme lu.
// Les identifiants viennent uniquement des variables d'environnement (fichier .env).
import { ImapFlow } from 'imapflow';
import { ecrireParametre, lireParametre } from '../db.js';
import { domaineExpediteur } from '../lib/email.js';
import { ingererEml, SOURCES_EMAIL } from './emails.js';

const TAILLE_MAX = 25 * 1024 * 1024;
const enCours = new Set();

function liste(valeur, defaut) {
  return String(valeur ?? defaut)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Configuration d'une source, lue dans les variables d'environnement. */
export function configSource(source, env = process.env) {
  const P = source.toUpperCase();
  const hote = env[`${P}_IMAP_HOTE`] || (source === 'gmail' ? 'imap.gmail.com' : '');
  const utilisateur = (env[`${P}_UTILISATEUR`] || '').trim();
  // Google affiche le mot de passe d'application par groupes (« abcd efgh ijkl mnop ») :
  // il ne contient jamais d'espace, on retire donc ceux copiés avec.
  const brut = env[`${P}_MOT_DE_PASSE`] || '';
  const motDePasse = source === 'gmail' ? brut.replace(/\s+/g, '') : brut;
  return {
    source,
    hote,
    port: Number(env[`${P}_IMAP_PORT`] || 993),
    utilisateur,
    motDePasse,
    // Gmail : « Tous les messages » par défaut, pour inclure les emails archivés par un filtre.
    dossier: env[`${P}_DOSSIER`] || (source === 'gmail' ? '\\All' : 'INBOX'),
    motsClesObjet: liste(env[`${P}_MOTS_CLES_OBJET`], source === 'gmail' ? 'order,shopping' : 'brand approval'),
    expediteurs: liste(env[`${P}_EXPEDITEURS`], source === 'gmail' ? '' : 'amazon.com,amazon.ca'),
    dateDepart: env.EMAIL_DATE_DEPART || '2026-08-01',
    configuree: Boolean(hote && utilisateur && motDePasse),
  };
}

function echapper(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Un message est retenu si son objet contient l'un des mots-clés (début de mot,
 * sans tenir compte des majuscules) et, si une liste d'expéditeurs est définie,
 * s'il provient de l'un de ces domaines (sous-domaines compris).
 */
export function correspondFiltre(config, { sujet, expediteur }) {
  const objet = String(sujet || '');
  const motCle = config.motsClesObjet.some((m) => new RegExp(`(^|[^\\p{L}\\p{N}])${echapper(m)}`, 'iu').test(objet));
  if (!motCle) return false;
  if (!config.expediteurs.length) return true;
  const domaine = domaineExpediteur(expediteur) || '';
  return config.expediteurs.some((d) => domaine === d.toLowerCase() || domaine.endsWith('.' + d.toLowerCase()));
}

export function lireEtat(db, source) {
  return JSON.parse(lireParametre(db, `synchro.${source}`) || '{}');
}

function ecrireEtat(db, source, etat) {
  ecrireParametre(db, `synchro.${source}`, JSON.stringify(etat));
}

/** État affichable (sans mot de passe). */
export function etatSynchro(db, source, config = configSource(source)) {
  const etat = lireEtat(db, source);
  return {
    configuree: config.configuree,
    hote: config.hote || null,
    utilisateur: config.utilisateur || null,
    dossier: etat.dossier || config.dossier,
    mots_cles_objet: config.motsClesObjet,
    expediteurs: config.expediteurs,
    date_depart: config.dateDepart,
    en_cours: enCours.has(source),
    derniere_synchro: etat.derniere_synchro || null,
    derniere_reussite: etat.derniere_reussite || null,
    derniere_erreur: etat.derniere_erreur || null,
    dernier_bilan: etat.dernier_bilan || null,
  };
}

function creerClientImap(config) {
  const client = new ImapFlow({
    host: config.hote,
    port: config.port,
    secure: config.port === 993,
    auth: { user: config.utilisateur, pass: config.motDePasse },
    logger: false,
  });
  // Erreur de socket hors commande : elle ne doit pas arrêter le serveur (la commande en cours échoue déjà).
  client.on('error', () => {});
  return client;
}

/** Indices sur les identifiants Gmail, sans jamais révéler le mot de passe. */
export function indicesGmail(config) {
  const indices = [];
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(config.utilisateur)) indices.push('GMAIL_UTILISATEUR doit être l’adresse complète (ex. nom@gmail.com)');
  if (/^["']|["']$/.test(config.motDePasse)) indices.push('GMAIL_MOT_DE_PASSE contient des guillemets : retirez-les');
  else if (config.motDePasse.length !== 16) indices.push(`GMAIL_MOT_DE_PASSE fait ${config.motDePasse.length} caractère(s) sans les espaces, alors qu’un mot de passe d’application Google en compte 16`);
  return indices;
}

function messageErreur(e, config) {
  if (e.authenticationFailed) {
    const detail = e.responseText ? ` Réponse du serveur : « ${e.responseText} »` : '';
    const indices = config?.source === 'gmail' ? indicesGmail(config) : [];
    return `Identifiants refusés par le serveur (vérifiez l’adresse et le mot de passe d’application).${detail}${indices.length ? ` À vérifier : ${indices.join(' ; ')}.` : ''}`;
  }
  if (e.code === 'ENOTFOUND') return 'Serveur IMAP introuvable (vérifiez le nom du serveur).';
  if (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT') return 'Connexion au serveur IMAP impossible.';
  return e.responseText || e.message || 'Erreur inconnue';
}

async function resoudreDossier(client, demande) {
  if (!demande.startsWith('\\')) return demande;
  const dossiers = await client.list();
  const trouve = dossiers.find((d) => d.specialUse === demande);
  return trouve ? trouve.path : 'INBOX';
}

/**
 * Synchronise une source : lit les nouveaux messages depuis la date de départ
 * (puis de façon incrémentale par UID), filtre sur l'objet et l'expéditeur, et
 * transmet les messages retenus au rapprochement.
 */
export async function synchroniserSource(db, source, { config = configSource(source), creerClient = creerClientImap } = {}) {
  if (!(source in SOURCES_EMAIL)) throw new Error(`Source inconnue : ${source}`);
  if (!config.configuree) return { source, ignoree: true, motif: 'Connexion non configurée' };
  if (enCours.has(source)) return { source, ignoree: true, motif: 'Synchronisation déjà en cours' };
  enCours.add(source);
  const etat = lireEtat(db, source);
  const bilan = { source, examines: 0, retenus: 0, importes: 0, doublons: 0, erreurs: [] };
  const maintenant = new Date().toISOString();
  const client = creerClient(config);
  try {
    await client.connect();
    const dossier = await resoudreDossier(client, config.dossier);
    const verrou = await client.getMailboxLock(dossier, { readOnly: true });
    try {
      const uidValidity = String(client.mailbox.uidValidity);
      const reprise = etat.dossier === dossier && etat.uid_validity === uidValidity && etat.dernier_uid;
      const depart = new Date(`${config.dateDepart}T00:00:00Z`);
      const uids = ((await client.search(reprise ? { uid: `${etat.dernier_uid + 1}:*` } : { since: depart }, { uid: true })) || [])
        .filter((u) => !reprise || u > etat.dernier_uid)
        .sort((a, b) => a - b);

      const retenus = [];
      let dernierUid = reprise ? etat.dernier_uid : 0;
      if (uids.length) {
        for await (const m of client.fetch(uids, { uid: true, envelope: true, size: true }, { uid: true })) {
          bilan.examines++;
          dernierUid = Math.max(dernierUid, m.uid);
          const env = m.envelope || {};
          const de = env.from?.[0];
          const expediteur = de ? `${de.name || ''} <${de.address || ''}>` : '';
          if (env.date && new Date(env.date) < depart) continue;
          if (!correspondFiltre(config, { sujet: env.subject, expediteur })) continue;
          if (m.size > TAILLE_MAX) {
            bilan.erreurs.push(`Message trop volumineux ignoré : ${env.subject}`);
            continue;
          }
          retenus.push(m.uid);
        }
      }
      bilan.retenus = retenus.length;
      if (retenus.length) {
        for await (const m of client.fetch(retenus, { uid: true, source: true }, { uid: true })) {
          try {
            const r = ingererEml(db, source, m.source, 'imap');
            r.doublon ? bilan.doublons++ : bilan.importes++;
          } catch (e) {
            bilan.erreurs.push(`UID ${m.uid} : ${e.message}`);
          }
        }
      }
      ecrireEtat(db, source, {
        ...etat,
        dossier,
        uid_validity: uidValidity,
        dernier_uid: dernierUid || etat.dernier_uid || 0,
        derniere_synchro: maintenant,
        derniere_reussite: maintenant,
        derniere_erreur: null,
        dernier_bilan: bilan,
      });
    } finally {
      verrou.release();
    }
    await client.logout();
    return bilan;
  } catch (e) {
    const message = messageErreur(e, config);
    ecrireEtat(db, source, { ...etat, derniere_synchro: maintenant, derniere_erreur: message });
    try {
      client.close?.();
    } catch {
      // connexion déjà fermée
    }
    return { ...bilan, echec: message };
  } finally {
    enCours.delete(source);
  }
}

export async function synchroniserTout(db, options = {}) {
  const resultats = [];
  for (const source of Object.keys(SOURCES_EMAIL)) resultats.push(await synchroniserSource(db, source, options[source] || {}));
  return resultats;
}

/** Lance la synchronisation périodique (EMAIL_SYNCHRO_MINUTES, 10 par défaut ; 0 = désactivée). */
export function planifierSynchro(db, env = process.env, journal = console) {
  const minutes = Number(env.EMAIL_SYNCHRO_MINUTES ?? 10);
  const actives = Object.keys(SOURCES_EMAIL).filter((s) => configSource(s, env).configuree);
  if (!minutes || !actives.length) return null;
  const executer = async () => {
    for (const r of await synchroniserTout(db)) {
      if (r.echec) journal.error(`[synchro ${r.source}] ${r.echec}`);
      else if (!r.ignoree && r.importes) journal.log(`[synchro ${r.source}] ${r.importes} email(s) importé(s)`);
    }
  };
  setTimeout(executer, 15_000).unref();
  const minuterie = setInterval(executer, minutes * 60_000);
  minuterie.unref();
  journal.log(`Synchronisation email toutes les ${minutes} min : ${actives.join(', ')}`);
  return minuterie;
}
