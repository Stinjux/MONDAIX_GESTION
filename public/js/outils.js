// Outils partagés de l'interface.

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

export function toast(message, erreur = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (erreur ? ' erreur' : '');
  el.textContent = message;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), erreur ? 7000 : 3500);
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

export function tableau(entetes, lignes, vide = 'Aucun élément.') {
  if (!lignes.length) return `<div class="carte vide">${esc(vide)}</div>`;
  return `<div class="tableau"><table><thead><tr>${entetes.map((e) => (typeof e === 'string' ? `<th>${esc(e)}</th>` : `<th class="${e.classe || ''}">${esc(e.t)}</th>`)).join('')}</tr></thead>
    <tbody>${lignes.join('')}</tbody></table></div>`;
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
  return `<span class="asin"><a class="mono" href="${esc(urlAmazon(asin))}" target="_blank" rel="noopener noreferrer" title="Ouvrir sur Amazon">${a}<span aria-hidden="true"> ↗</span></a>${
    fiche ? ` <a class="asin-fiche" href="#/asins/${a}" title="Fiche ASIN : tout l’historique">fiche</a>` : ''
  }</span>`;
}
