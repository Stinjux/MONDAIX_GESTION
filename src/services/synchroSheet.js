// Lecture automatique du Google Sheet d'achats : un script Apps Script installé dans le Sheet envoie
// ses onglets à l'application (toutes les 5 minutes et sur demande). Le Sheet reste privé, et les
// couleurs de la légende (vert = reçu, orange = en attente, rouge = annulé) sont lues.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ErreurMetier, ecrireParametre, journaliser, lireParametre } from '../db.js';
import { importerLignesAchats, moisDuFichier } from './achats.js';

const CLE_JETON = 'sheet.webhook_token';
const CLE_SYNCHRO = 'sheet.derniere_synchro';

/** Crée (ou remplace) le jeton du script : l'ancien script cesse alors de fonctionner. */
export function genererJeton(db) {
  const jeton = randomBytes(24).toString('base64url');
  ecrireParametre(db, CLE_JETON, jeton);
  journaliser(db, 'sheet', null, 'jeton_genere');
  return jeton;
}

export function verifierJetonSheet(db, recu) {
  const attendu = lireParametre(db, CLE_JETON) || '';
  if (!attendu) throw new ErreurMetier('Lecture automatique du Sheet non configurée.', 403);
  const a = Buffer.from(String(recu || ''));
  const b = Buffer.from(attendu);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ErreurMetier('Jeton invalide.', 401);
}

/** État de la connexion : configurée, jeton (pour réafficher le script) et dernier envoi reçu. */
export function etatConnexion(db) {
  const jeton = lireParametre(db, CLE_JETON) || null;
  let synchro = null;
  try {
    synchro = JSON.parse(lireParametre(db, CLE_SYNCHRO) || 'null');
  } catch {
    synchro = null;
  }
  const minutes = synchro ? Math.floor((Date.now() - Date.parse(`${synchro.date}Z`)) / 60_000) : null;
  return { configure: Boolean(jeton), jeton, synchro, minutes_depuis: minutes, interrompue: Boolean(jeton && synchro && minutes > 60) };
}

/**
 * Onglets reçus du script : seuls les onglets dont le nom contient un mois (« OCTOBER orders ») sont
 * importés ; un onglet inchangé depuis son dernier import n'est pas réimporté.
 */
export function recevoirSheet(db, { classeur = 'Google Sheet', onglets } = {}) {
  if (!Array.isArray(onglets)) throw new ErreurMetier('Format attendu : { classeur, onglets: [{ nom, lignes, couleurs }] }.');
  const resultat = [];
  for (const o of onglets) {
    const nom = String(o?.nom || '').trim();
    const lignes = Array.isArray(o?.lignes) ? o.lignes.map((l) => (Array.isArray(l) ? l.map((c) => String(c ?? '')) : [])) : [];
    const mois = moisDuFichier(nom);
    if (!nom || !mois || mois.deduit) {
      resultat.push({ onglet: nom, etat: 'ignore', motif: 'pas de mois dans le nom de l’onglet' });
      continue;
    }
    const couleurs = Array.isArray(o.couleurs) ? o.couleurs.map((c) => String(c || '')) : null;
    const empreinte = createHash('sha256').update(JSON.stringify({ lignes, couleurs })).digest('hex');
    try {
      const r = importerLignesAchats(db, { lignes, couleurs, nom: `${classeur} - ${nom}`, empreinte, siIdentique: 'ignorer' });
      resultat.push(r.inchange ? { onglet: nom, etat: 'inchange', mois: r.mois } : { onglet: nom, etat: 'importe', ...r });
    } catch (e) {
      if (!(e instanceof ErreurMetier)) throw e;
      resultat.push({ onglet: nom, etat: 'erreur', motif: e.message });
    }
  }
  const date = new Date().toISOString().slice(0, 19).replace('T', ' ');
  ecrireParametre(
    db,
    CLE_SYNCHRO,
    JSON.stringify({ date, classeur, onglets: resultat.filter((x) => x.etat !== 'ignore').map((x) => ({ onglet: x.onglet, etat: x.etat, motif: x.motif || null })) }),
  );
  const importes = resultat.filter((x) => x.etat === 'importe');
  if (importes.length) journaliser(db, 'sheet', null, 'synchro', { classeur, onglets: importes.map((x) => x.onglet) });
  return { date, onglets: resultat };
}

/** Script Apps Script à coller dans le Sheet (Extensions › Apps Script). */
export function scriptSheet(urlApplication, jeton) {
  const url = `${String(urlApplication).replace(/\/+$/, '')}/api/imports/achats/webhook`;
  return `// Mondaix Gestion : envoi automatique des onglets mensuels (« OCTOBER orders »…) à l'application.
// Installation : Exécuter › installerMondaix (une seule fois), puis autoriser l'accès.
const MONDAIX_URL = ${JSON.stringify(url)};
const MONDAIX_JETON = ${JSON.stringify(jeton)};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Mondaix').addItem('Envoyer maintenant', 'envoyerMondaix').addToUi();
}

/** Envoi toutes les 5 minutes, plus un premier envoi tout de suite. */
function installerMondaix() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'envoyerMondaix')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('envoyerMondaix').timeBased().everyMinutes(5).create();
  envoyerMondaix();
}

function envoyerMondaix() {
  const classeur = SpreadsheetApp.getActiveSpreadsheet();
  const onglets = classeur.getSheets().map((feuille) => {
    const plage = feuille.getDataRange();
    return {
      nom: feuille.getName(),
      lignes: plage.getDisplayValues(),
      couleurs: plage.offset(0, 0, plage.getNumRows(), 1).getBackgrounds().map((l) => l[0]),
    };
  });
  const reponse = UrlFetchApp.fetch(MONDAIX_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Mondaix-Token': MONDAIX_JETON },
    payload: JSON.stringify({ classeur: classeur.getName(), onglets: onglets }),
    muteHttpExceptions: true,
  });
  if (reponse.getResponseCode() >= 300) throw new Error('Mondaix : ' + reponse.getResponseCode() + ' ' + reponse.getContentText());
  return reponse.getContentText();
}
`;
}
