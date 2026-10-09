// Menu déroulant unique : sélection (select), saisie avec suggestions (combobox) et menu d'actions.
// Les <select> et <input list> existants sont enrichis sans être remplacés : la valeur, le nom,
// FormData et les événements « change » restent ceux du champ d'origine.
import { icone } from './icones.js';

const SEUIL_RECHERCHE = 7;
let ouvert = null; // { fermer }

function normaliser(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Place le menu sous (ou au-dessus de) l'ancre, sans jamais dépasser de l'écran. */
function positionner(menu, ancre) {
  const r = ancre.getBoundingClientRect();
  const marge = 8;
  const hautVue = window.innerHeight;
  const largeVue = window.innerWidth;
  menu.style.minWidth = `${Math.max(200, r.width)}px`;
  menu.style.maxHeight = '';
  const dessous = hautVue - r.bottom - marge;
  const dessus = r.top - marge;
  const haut = Math.min(menu.scrollHeight, 360);
  const versLeHaut = dessous < Math.min(haut, 240) && dessus > dessous;
  const dispo = Math.max(120, (versLeHaut ? dessus : dessous) - 4);
  menu.style.maxHeight = `${Math.min(360, dispo)}px`;
  const hauteur = menu.offsetHeight;
  menu.style.top = `${versLeHaut ? Math.max(marge, r.top - 4 - hauteur) : r.bottom + 4}px`;
  const largeur = menu.offsetWidth;
  menu.style.left = `${Math.max(marge, Math.min(r.left, largeVue - largeur - marge))}px`;
}

/**
 * Ouvre une liste d'options près de l'ancre.
 * options : [{ valeur, libelle, desactive, danger, selectionne }]
 * Retourne via choisir(option). Clavier : flèches, Entrée, Échap, saisie pour filtrer.
 */
export function ouvrirListe(ancre, options, { choisir, recherche = options.length > SEUIL_RECHERCHE, etiquette = 'Options', surFermeture } = {}) {
  ouvert?.fermer();
  const menu = document.createElement('div');
  menu.className = 'menu-flottant';
  const idListe = `menu-${Math.random().toString(36).slice(2, 8)}`;
  menu.innerHTML = `${recherche ? `<input class="menu-recherche" type="search" placeholder="Rechercher…" aria-label="Filtrer les options" aria-controls="${idListe}">` : ''}
    <ul class="menu-liste" role="listbox" id="${idListe}" aria-label="${etiquette.replace(/"/g, '&quot;')}" tabindex="-1"></ul>`;
  document.body.append(menu);
  const liste = menu.querySelector('ul');
  const champ = menu.querySelector('.menu-recherche');
  let visibles = options;
  let actif = Math.max(0, options.findIndex((o) => o.selectionne && !o.desactive));
  let saisie = '';
  let minuteur;

  const rendre = () => {
    liste.innerHTML = visibles.length
      ? visibles
          .map(
            (o, i) => `<li class="menu-option${i === actif ? ' active' : ''}${o.danger ? ' danger' : ''}" role="option" id="${idListe}-${i}" data-i="${i}"
              aria-selected="${o.selectionne ? 'true' : 'false'}"${o.desactive ? ' aria-disabled="true"' : ''}>
              <span class="coche">${o.selectionne ? icone('check') : ''}</span><span>${String(o.libelle).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</span></li>`,
          )
          .join('')
      : '<li class="menu-vide">Aucun résultat</li>';
    (champ || liste).setAttribute('aria-activedescendant', visibles.length ? `${idListe}-${actif}` : '');
    liste.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  const filtrer = (texte) => {
    const t = normaliser(texte);
    visibles = t ? options.filter((o) => normaliser(o.libelle).includes(t)) : options;
    actif = Math.max(0, visibles.findIndex((o) => !o.desactive));
    rendre();
  };
  const deplacer = (pas) => {
    if (!visibles.length) return;
    let i = actif;
    for (let n = 0; n < visibles.length; n++) {
      i = (i + pas + visibles.length) % visibles.length;
      if (!visibles[i].desactive) break;
    }
    actif = i;
    rendre();
  };
  const valider = (i) => {
    const o = visibles[i];
    if (!o || o.desactive) return;
    fermer(true);
    choisir?.(o);
  };
  const fermer = (rendreFocus = true) => {
    if (!menu.isConnected) return;
    menu.remove();
    document.removeEventListener('pointerdown', dehors, true);
    window.removeEventListener('resize', fermerSansFocus);
    window.removeEventListener('scroll', repositionner, true);
    ouvert = null;
    surFermeture?.();
    if (rendreFocus) ancre.focus();
  };
  const fermerSansFocus = () => fermer(false);
  const repositionner = (e) => {
    if (menu.contains(e.target)) return;
    positionner(menu, ancre);
  };
  const dehors = (e) => {
    if (!menu.contains(e.target) && !ancre.contains(e.target)) fermer(false);
  };
  const clavier = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); deplacer(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); deplacer(-1); }
    else if (e.key === 'Home') { e.preventDefault(); actif = -1; deplacer(1); }
    else if (e.key === 'End') { e.preventDefault(); actif = visibles.length; deplacer(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); valider(actif); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fermer(true); }
    else if (e.key === 'Tab') fermer(false);
    else if (!champ && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      // Sans champ de recherche : la saisie amène à la première option correspondante.
      saisie += normaliser(e.key);
      clearTimeout(minuteur);
      minuteur = setTimeout(() => (saisie = ''), 600);
      const i = visibles.findIndex((o) => !o.desactive && normaliser(o.libelle).startsWith(saisie));
      if (i >= 0) { actif = i; rendre(); }
    }
  };

  liste.addEventListener('pointermove', (e) => {
    const li = e.target.closest('.menu-option');
    if (li && Number(li.dataset.i) !== actif) { actif = Number(li.dataset.i); rendre(); }
  });
  liste.addEventListener('click', (e) => {
    const li = e.target.closest('.menu-option');
    if (li) valider(Number(li.dataset.i));
  });
  menu.addEventListener('keydown', clavier);
  champ?.addEventListener('input', () => filtrer(champ.value));
  document.addEventListener('pointerdown', dehors, true);
  window.addEventListener('resize', fermerSansFocus);
  window.addEventListener('scroll', repositionner, true);
  rendre();
  positionner(menu, ancre);
  (champ || liste).focus();
  ouvert = { fermer };
  return { fermer };
}

/* ------------------------------------------------------------ select enrichi */

function libelleSelect(select) {
  const o = select.options[select.selectedIndex];
  return o ? o.textContent : '';
}

export function enrichirSelect(select) {
  if (select.dataset.menu || select.multiple || select.dataset.natif !== undefined) return;
  select.dataset.menu = '1';
  const bouton = document.createElement('button');
  bouton.type = 'button';
  bouton.className = 'menu-declencheur';
  bouton.setAttribute('aria-haspopup', 'listbox');
  bouton.setAttribute('aria-expanded', 'false');
  const lie = select.id ? document.querySelector(`label[for="${CSS.escape(select.id)}"]`) : null;
  if (lie) {
    if (!lie.id) lie.id = `${select.id}-libelle`;
    bouton.setAttribute('aria-labelledby', `${lie.id} ${select.id}-valeur`);
  } else if (select.getAttribute('aria-label')) bouton.setAttribute('aria-label', select.getAttribute('aria-label'));
  const majBouton = () => {
    bouton.innerHTML = `<span class="menu-valeur" id="${select.id || ''}-valeur">${libelleSelect(select).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]) || '—'}</span>${icone('chevron-down')}`;
    bouton.disabled = select.disabled;
  };
  majBouton();
  select.classList.add('menu-natif');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.after(bouton);
  if (lie) lie.addEventListener('click', (e) => { e.preventDefault(); bouton.focus(); });
  select.addEventListener('change', majBouton);
  // Une valeur posée par le code (select.value = …) met aussi le bouton à jour.
  for (const prop of ['value', 'selectedIndex']) {
    const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
    Object.defineProperty(select, prop, {
      configurable: true,
      get() { return d.get.call(this); },
      set(v) { d.set.call(this, v); majBouton(); },
    });
  }
  const ouvrir = () => {
    const options = [...select.options].map((o, i) => ({ valeur: o.value, libelle: o.textContent, desactive: o.disabled, selectionne: i === select.selectedIndex, i }));
    bouton.setAttribute('aria-expanded', 'true');
    ouvrirListe(bouton, options, {
      etiquette: lie?.textContent || select.getAttribute('aria-label') || 'Options',
      surFermeture: () => bouton.setAttribute('aria-expanded', 'false'),
      choisir: (o) => {
        if (select.selectedIndex === o.i) return;
        select.selectedIndex = o.i;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      },
    });
  };
  bouton.addEventListener('click', ouvrir);
  bouton.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); ouvrir(); }
  });
}

/* ------------------------------------------------------------ combobox (input + datalist) */

export function enrichirCombobox(input) {
  if (input.dataset.menu) return;
  const idListe = input.getAttribute('list');
  const datalist = idListe && document.getElementById(idListe);
  if (!datalist) return;
  input.dataset.menu = '1';
  input.removeAttribute('list');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.autocomplete = 'off';
  let menu = null;
  const options = () => [...datalist.options].map((o) => ({ valeur: o.value, libelle: o.textContent ? `${o.value} — ${o.textContent}` : o.value }));
  const afficher = () => {
    const t = normaliser(input.value);
    const liste = options().filter((o) => !t || normaliser(o.libelle).includes(t)).slice(0, 50);
    if (!liste.length) { menu?.fermer(false); return; }
    input.setAttribute('aria-expanded', 'true');
    menu = ouvrirListe(input, liste.map((o) => ({ ...o, selectionne: o.valeur === input.value })), {
      recherche: false,
      etiquette: 'Suggestions',
      surFermeture: () => { input.setAttribute('aria-expanded', 'false'); menu = null; },
      choisir: (o) => {
        input.value = o.valeur;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
    });
    input.focus(); // la saisie continue dans le champ
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && !menu) { e.preventDefault(); afficher(); return; }
    if (menu && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      document.querySelector('.menu-flottant')?.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, bubbles: true }));
    }
  });
  input.addEventListener('input', (e) => { if (e.isTrusted) afficher(); });
}

/* ------------------------------------------------------------ menu d'actions */

/** Menu d'actions sur un bouton : actions = [{ libelle, action, danger, desactive }]. */
export function menuActions(bouton, actions) {
  bouton.setAttribute('aria-haspopup', 'menu');
  bouton.setAttribute('aria-expanded', 'false');
  bouton.addEventListener('click', () => {
    bouton.setAttribute('aria-expanded', 'true');
    ouvrirListe(bouton, actions.map((a, i) => ({ valeur: i, libelle: a.libelle, danger: a.danger, desactive: a.desactive })), {
      etiquette: bouton.textContent.trim() || 'Actions',
      surFermeture: () => bouton.setAttribute('aria-expanded', 'false'),
      choisir: (o) => actions[o.valeur].action(),
    });
  });
}

/** Enrichit tous les menus d'une zone (appelé après chaque rendu). */
export function enrichirMenus(racine = document) {
  racine.querySelectorAll('select:not([data-menu])').forEach(enrichirSelect);
  racine.querySelectorAll('input[list]:not([data-menu])').forEach(enrichirCombobox);
}
