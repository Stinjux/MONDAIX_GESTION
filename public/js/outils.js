// Outils partagés de l'interface.
import { icone } from './icones.js';

export { icone };

export async function api(chemin, { methode = 'GET', corps } = {}) {
  const options = { method: methode, headers: {} };
  if (corps !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(corps);
  }
  const reponse = await fetch(chemin, options);
  const donnees = await reponse.json().catch(() => ({}));
  if (!reponse.ok) throw new Error(donnees.erreur || `Erreur ${reponse.status}`);
  return donnees;
}
export const post = (chemin, corps = {}) => api(chemin, { methode: 'POST', corps });
export const put = (chemin, corps = {}) => api(chemin, { methode: 'PUT', corps });
export const suppr = (chemin) => api(chemin, { methode: 'DELETE', corps: {} });

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const fmtMontant = new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' });
export function montant(v) {
  return v === null || v === undefined || v === '' ? '—' : fmtMontant.format(v);
}
export function date(v) {
  if (!v) return '—';
  const d = new Date(v.length === 10 ? v + 'T12:00:00' : v);
  return Number.isNaN(d.getTime()) ? esc(v) : d.toLocaleDateString('fr-CA');
}
export function triEtat(v) {
  return v === 1 ? 'oui' : v === 0 ? 'non' : 'inconnu';
}

export function badge(texte, ton = '') {
  return `<span class="badge ${ton}">${esc(texte)}</span>`;
}

/**
 * Notification. toast(message, true) = erreur ; options : { erreur, action: { libelle, fn }, duree }.
 * Avec une action (ex. « Annuler »), la notification reste plus longtemps.
 */
export function toast(message, options = false) {
  const { erreur = false, action = null, duree } = typeof options === 'object' && options ? options : { erreur: Boolean(options) };
  const el = document.createElement('div');
  el.className = 'toast' + (erreur ? ' erreur' : '');
  el.setAttribute('role', erreur ? 'alert' : 'status');
  const texte = document.createElement('span');
  texte.textContent = message;
  el.append(texte);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `${icone('undo-2')}${esc(action.libelle)}`;
    b.onclick = async () => {
      el.remove();
      await action.fn();
    };
    el.append(b);
  }
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), duree ?? (action ? 8000 : erreur ? 7000 : 3500));
}

/** Exécute une action et affiche l'erreur éventuelle ; retourne le résultat ou undefined. */
export async function tenter(fn, succes) {
  try {
    const r = await fn();
    if (succes) toast(typeof succes === 'function' ? succes(r) : succes);
    return r;
  } catch (e) {
    toast(e.message, true);
    return undefined;
  }
}

/**
 * Ouvre une fenêtre modale. `valider(donnees, form)` reçoit les champs du formulaire ;
 * s'il lève une erreur, la fenêtre reste ouverte.
 */
export function modale({ titre, contenu, libelleValider = 'Enregistrer', valider, apresOuverture }) {
  const dlg = document.getElementById('modale');
  const form = document.getElementById('modale-form');
  form.innerHTML = `<h2>${esc(titre)}</h2>${contenu}
    <div class="message erreur" id="modale-erreur" hidden></div>
    <div class="pied-modale"><button type="button" value="annuler" id="modale-annuler">Annuler</button>
    ${valider ? `<button class="principal" value="ok" id="modale-ok">${esc(libelleValider)}</button>` : ''}</div>`;
  return new Promise((resoudre) => {
    const fermer = (r) => {
      dlg.close();
      resoudre(r);
    };
    form.querySelector('#modale-annuler').onclick = () => fermer(undefined);
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      if (!valider) return fermer(true);
      const donnees = Object.fromEntries(new FormData(form).entries());
      const bouton = form.querySelector('#modale-ok');
      bouton.disabled = true;
      try {
        const r = await valider(donnees, form);
        fermer(r === undefined ? true : r);
      } catch (e) {
        const zone = form.querySelector('#modale-erreur');
        zone.textContent = e.message;
        zone.hidden = false;
      } finally {
        bouton.disabled = false;
      }
    };
    dlg.showModal();
    if (apresOuverture) apresOuverture(form);
  });
}

/** Confirmation d'une action (destructrice par défaut) dans la modale de l'application. */
export async function confirmer({ titre, message, libelle = 'Confirmer', danger = true }) {
  const r = await modale({
    titre,
    contenu: `<p>${message}</p>`,
    libelleValider: libelle,
    valider: () => true,
    apresOuverture: (form) => {
      const ok = form.querySelector('#modale-ok');
      if (!danger) return;
      ok.classList.add('principal');
      ok.innerHTML = `${icone('trash-2')}${esc(libelle)}`;
    },
  });
  return r === true;
}

/** Message d'information dans la modale (remplace alert()). */
export function informer(titre, message) {
  return modale({ titre, contenu: `<p>${message}</p>` });
}

/**
 * En-tête commun à toutes les pages : (retour), titre, sous-titre à gauche ; actions principales à droite.
 * retour : { href, libelle } ; actions : HTML des boutons.
 */
export function entetePage({ titre, titreHtml, sousTitre = '', retour = null, actions = '' }) {
  return `<header class="entete">
    <div>${retour ? `<a class="retour" href="${esc(retour.href)}">${esc(retour.libelle)}</a>` : ''}
      <h1>${titreHtml ?? esc(titre)}</h1>${sousTitre ? `<p class="aide">${sousTitre}</p>` : ''}</div>
    ${actions ? `<div class="actions">${actions}</div>` : ''}</header>`;
}

/** Info-bulle de formule (survol et focus clavier). */
export function formule(texte, contenu = icone('info', 14)) {
  return `<span class="formule" tabindex="0" role="note" aria-label="${esc(texte)}" data-formule="${esc(texte)}">${contenu}</span>`;
}

export function champ(nom, libelle, { type = 'text', valeur = '', attrs = '' } = {}) {
  return `<div><label for="f-${nom}">${esc(libelle)}</label><input id="f-${nom}" name="${nom}" type="${type}" value="${esc(valeur)}" ${attrs}></div>`;
}

export function selecteur(nom, libelle, options, valeur = '', attrs = '') {
  const opts = options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(valeur ?? '') ? 'selected' : ''}>${esc(t)}</option>`).join('');
  return `<div><label for="f-${nom}">${esc(libelle)}</label><select id="f-${nom}" name="${nom}" ${attrs}>${opts}</select></div>`;
}

export function selecteurTriEtat(nom, libelle, valeur) {
  const v = valeur === 1 ? '1' : valeur === 0 ? '0' : '';
  return selecteur(nom, libelle, [['', 'Inconnu'], ['1', 'Oui'], ['0', 'Non']], v);
}

const actionsSelection = new Map();

/**
 * Tableau dense. entetes : 'Texte' ou { t, classe, tri: false }.
 * options : { videAction: { libelle, href } , selection: [{ libelle, icone, danger, action(ids) }] }
 * Sélection multiple : chaque ligne porte data-id ; une barre d'actions groupées apparaît.
 * Le tri par colonne est ajouté à l'affichage (voir tableaux.js).
 */
export function tableau(entetes, lignes, vide = 'Aucun élément.', options = {}) {
  if (!lignes.length) {
    const a = options.videAction;
    return `<div class="carte etat-vide"><span>${esc(vide)}</span>${a ? `<a class="bouton" href="${esc(a.href)}">${icone('plus')}${esc(a.libelle)}</a>` : ''}</div>`;
  }
  const th = (e) => {
    const d = typeof e === 'string' ? { t: e } : e;
    return `<th class="${d.classe || ''}" scope="col"${d.tri === false ? ' data-sans-tri' : ''}>${esc(d.t)}</th>`;
  };
  let cle = '';
  let barre = '';
  let corps = lignes.join('');
  let tete = entetes.map(th).join('');
  if (options.selection?.length) {
    cle = `sel-${Math.random().toString(36).slice(2, 8)}`;
    actionsSelection.set(cle, options.selection);
    tete = `<th class="case" data-sans-tri><input type="checkbox" data-tout aria-label="Tout sélectionner"></th>${tete}`;
    corps = lignes
      .map((l) => l.replace(/<tr([^>]*\bdata-id="([^"]+)"[^>]*)>/, (m, attrs, id) => `<tr${attrs}><td class="case"><input type="checkbox" data-ligne-id="${id}" aria-label="Sélectionner la ligne"></td>`))
      .join('');
    barre = `<div class="barre-selection" data-barre="${cle}" hidden><strong data-compte>0 sélectionné(s)</strong>
      ${options.selection.map((a, i) => `<button type="button" class="petit" data-action-groupee="${i}">${a.icone ? icone(a.icone) : ''}${esc(a.libelle)}</button>`).join('')}
      <button type="button" class="petit" data-deselectionner>${icone('x')}Désélectionner</button></div>`;
  }
  return `${barre}<div class="tableau"${cle ? ` data-selection="${cle}"` : ''}><table><thead><tr>${tete}</tr></thead>
    <tbody>${corps}</tbody></table></div>`;
}

export function actionsDeSelection(cle) {
  return actionsSelection.get(cle) || [];
}

/** Chargement : squelette (pas de spinner plein écran). */
export function squelette() {
  return `<div class="squelette" aria-busy="true" aria-label="Chargement"><div class="barre-sq titre-sq"></div>
    <div class="grille">${'<div class="barre-sq bloc-sq"></div>'.repeat(4)}</div>
    ${'<div class="barre-sq"></div>'.repeat(8)}</div>`;
}

/** Erreur : message et bouton « Réessayer » (data-reessayer). */
export function vueErreur(message) {
  return `<div class="etat-erreur" role="alert"><span>${icone('circle-alert')} ${esc(message)}</span>
    <button type="button" data-reessayer>${icone('refresh-cw')}Réessayer</button></div>`;
}

export const ETATS_COMPARAISON = {
  sans_total: ['Sans total déclaré', ''],
  sans_facture: ['Facture manquante', 'alerte'],
  conforme: ['Conforme', 'ok'],
  ecart: ['Écart', 'erreur'],
  composition_inconnue: ['Composition à préciser', 'alerte'],
  detail_insuffisant: ['Détail insuffisant', 'alerte'],
};

export function badgeComparaison(comp) {
  const [t, ton] = ETATS_COMPARAISON[comp.statut] || [comp.statut, ''];
  return `<span title="${esc(comp.libelle || '')}">${badge(t, ton)}</span>`;
}

let referencesCache;
export async function references() {
  if (!referencesCache) referencesCache = await api('/api/references');
  return referencesCache;
}

export function lireFichierTexte(fichier) {
  return new Promise((resoudre, rejeter) => {
    const lecteur = new FileReader();
    lecteur.onload = () => resoudre(lecteur.result);
    lecteur.onerror = () => rejeter(lecteur.error);
    lecteur.readAsText(fichier);
  });
}

let domaineAmazon = 'www.amazon.ca';
export function definirDomaineAmazon(domaine) {
  if (domaine) domaineAmazon = domaine;
}
export function urlAmazon(asin) {
  return `https://${domaineAmazon}/dp/${encodeURIComponent(asin)}`;
}

/** ASIN cliquable : ouvre la page Amazon (nouvel onglet) ; « fiche » ouvre la fiche ASIN interne. */
export function asinLien(asin, { fiche = true } = {}) {
  if (!asin) return '<span class="mono">?</span>';
  const a = esc(asin);
  return `<span class="asin"><a class="mono" href="${esc(urlAmazon(asin))}" target="_blank" rel="noopener noreferrer" title="Ouvrir sur Amazon">${a}${icone('external-link', 14)}<span class="sr">(nouvel onglet)</span></a>${
    fiche ? ` <a class="asin-fiche" href="#/asins/${a}" title="Fiche ASIN : tout l’historique">fiche</a>` : ''
  }</span>`;
}
