// Tableaux : tri par colonne (affichage seulement) et sélection multiple avec actions groupées.
import { icone } from './icones.js';
import { actionsDeSelection, toast } from './outils.js';

const comparateurTexte = new Intl.Collator('fr-CA', { numeric: true, sensitivity: 'base' });

/** Valeur triable d'une cellule : nombre pour les colonnes numériques, date ISO, sinon texte. */
function valeurCellule(td, numerique) {
  const brut = (td?.dataset.tri ?? td?.textContent ?? '').trim();
  if (numerique) {
    const m = brut.replace(/\s| | /g, '').replace(/[^\d,.\-−]/g, '').replace('−', '-').replace(',', '.');
    const n = parseFloat(m);
    return Number.isNaN(n) ? -Infinity : n;
  }
  return brut;
}

function trier(table, th, index) {
  const tbody = table.tBodies[0];
  if (!tbody) return;
  const lignes = [...tbody.rows];
  if (lignes.some((l) => l.cells.length !== table.tHead.rows[0].cells.length)) return; // lignes fusionnées : pas de tri
  if (!tbody.dataset.ordre) lignes.forEach((l, i) => (l.dataset.ordreInitial = i));
  tbody.dataset.ordre = '1';
  const actuel = th.getAttribute('aria-sort');
  const suivant = actuel === 'ascending' ? 'descending' : actuel === 'descending' ? null : 'ascending';
  table.querySelectorAll('th[aria-sort]').forEach((x) => x.removeAttribute('aria-sort'));
  table.querySelectorAll('th .tri').forEach((x) => (x.innerHTML = icone('chevrons-up-down', 14)));
  const numerique = th.classList.contains('num');
  let tries;
  if (!suivant) tries = lignes.sort((a, b) => a.dataset.ordreInitial - b.dataset.ordreInitial);
  else {
    const sens = suivant === 'ascending' ? 1 : -1;
    tries = lignes.sort((a, b) => {
      const va = valeurCellule(a.cells[index], numerique);
      const vb = valeurCellule(b.cells[index], numerique);
      return sens * (numerique ? va - vb : comparateurTexte.compare(va, vb));
    });
    th.setAttribute('aria-sort', suivant);
    th.querySelector('.tri').innerHTML = icone(suivant === 'ascending' ? 'arrow-up' : 'arrow-down', 14);
  }
  tbody.append(...tries);
}

function activerTri(table) {
  const entetes = table.tHead?.rows[0]?.cells;
  if (!entetes || table.tBodies[0]?.rows.length < 2) return;
  [...entetes].forEach((th, index) => {
    if (th.dataset.sansTri !== undefined || !th.textContent.trim()) return;
    th.classList.add('triable');
    th.tabIndex = 0;
    th.title = 'Trier';
    th.insertAdjacentHTML('beforeend', `<span class="tri" aria-hidden="true">${icone('chevrons-up-down', 14)}</span>`);
    th.addEventListener('click', () => trier(table, th, index));
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trier(table, th, index); }
    });
  });
}

function activerSelection(conteneur) {
  const cle = conteneur.dataset.selection;
  const barre = document.querySelector(`[data-barre="${cle}"]`);
  if (!barre) return;
  const cases = () => [...conteneur.querySelectorAll('input[data-ligne-id]')];
  const tout = conteneur.querySelector('input[data-tout]');
  const maj = () => {
    const cochees = cases().filter((c) => c.checked);
    cases().forEach((c) => c.closest('tr').classList.toggle('coche', c.checked));
    barre.hidden = !cochees.length;
    barre.querySelector('[data-compte]').textContent = `${cochees.length} sélectionné(s)`;
    tout.checked = cochees.length && cochees.length === cases().length;
    tout.indeterminate = cochees.length > 0 && !tout.checked;
  };
  conteneur.addEventListener('change', (e) => {
    if (e.target === tout) cases().forEach((c) => (c.checked = tout.checked));
    if (e.target.matches('input[type=checkbox]')) maj();
  });
  barre.querySelector('[data-deselectionner]').onclick = () => {
    cases().forEach((c) => (c.checked = false));
    maj();
  };
  barre.querySelectorAll('[data-action-groupee]').forEach((b) => {
    b.onclick = async () => {
      const ids = cases().filter((c) => c.checked).map((c) => c.dataset.ligneId);
      const action = actionsDeSelection(cle)[Number(b.dataset.actionGroupee)];
      try {
        await action.action(ids);
      } catch (e) {
        toast(e.message, true);
      }
    };
  });
}

/** Applique tri et sélection aux tableaux d'une zone (sans effet sur ceux déjà traités). */
export function ameliorerTableaux(racine = document) {
  racine.querySelectorAll('.tableau:not([data-ameliore])').forEach((c) => {
    c.dataset.ameliore = '1';
    const table = c.querySelector('table');
    // Les dates ne se coupent jamais sur deux lignes.
    table?.querySelectorAll('td').forEach((td) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(td.textContent.trim())) td.classList.add('date');
    });
    if (table) activerTri(table);
    if (c.dataset.selection) activerSelection(c);
  });
}
