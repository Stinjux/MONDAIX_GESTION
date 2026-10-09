// Recherche globale (Ctrl/Cmd+K) : ASIN, factures, envois, emails et pages, à partir des API existantes.
import { api, esc, date } from './outils.js';
import { icone } from './icones.js';

const PAGES = [
  ['Tableau de bord', '#/', 'layout-dashboard'],
  ['Stocks (ASIN)', '#/asins', 'package'],
  ['COGS', '#/cogs', 'calculator'],
  ['Imports (Google Sheet, Aura, commandes Amazon)', '#/imports', 'upload'],
  ['Factures', '#/factures', 'receipt'],
  ['Fournisseurs', '#/fournisseurs', 'users'],
  ['Dépenses', '#/depenses', 'wallet'],
  ['Envois Amazon', '#/envois', 'truck'],
  ['Autorisations', '#/autorisations', 'shield-check'],
  ['Emails Gmail', '#/emails/gmail', 'mail'],
  ['Emails Neo', '#/emails/neo', 'mail'],
  ['Paramètres', '#/parametres', 'settings'],
  ['Journal', '#/journal', 'history'],
];

let cache = null;
let cacheLe = 0;

async function charger() {
  if (cache && Date.now() - cacheLe < 60_000) return cache;
  const [produits, factures, envois, gmail, neo] = await Promise.all([
    api('/api/produits').catch(() => []),
    api('/api/factures').catch(() => []),
    api('/api/envois').catch(() => []),
    api('/api/emails?source=gmail&statut=').catch(() => []),
    api('/api/emails?source=neo&statut=').catch(() => []),
  ]);
  cache = [
    ...PAGES.map(([t, href, ic]) => ({ groupe: 'Pages', titre: t, detail: '', href, icone: ic })),
    ...produits.map((p) => ({ groupe: 'ASIN', titre: p.asin, detail: [p.titre, p.sku].filter(Boolean).join(' · '), href: `#/asins/${p.asin}`, icone: 'package' })),
    ...factures.map((f) => ({
      groupe: 'Factures',
      titre: f.numero_facture || `Facture #${f.id}`,
      detail: [f.fournisseur, date(f.date_facture), f.lignes.map((l) => l.asin).join(' '), f.annulee ? 'annulée' : ''].filter(Boolean).join(' · '),
      href: '#/factures',
      icone: 'receipt',
    })),
    ...envois.map((e) => ({ groupe: 'Envois', titre: e.numero_envoi || `Envoi #${e.id}`, detail: date(e.date_envoi), href: `#/envois/${e.id}`, icone: 'truck' })),
    ...[...gmail, ...neo].map((e) => ({
      groupe: 'Emails',
      titre: e.sujet || '(sans objet)',
      detail: [e.source === 'gmail' ? 'Gmail' : 'Neo', e.expediteur, (e.liens || []).map((l) => l.valeur).join(' ')].filter(Boolean).join(' · '),
      href: `#/emails/${e.source}?filtre=tous&email=${e.id}`,
      icone: 'mail',
    })),
  ];
  cacheLe = Date.now();
  return cache;
}

const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function ouvrirRecherche() {
  if (document.querySelector('.palette')) return;
  const declencheur = document.activeElement;
  const fond = document.createElement('div');
  fond.className = 'palette-fond';
  fond.innerHTML = `<div class="palette" role="dialog" aria-modal="true" aria-label="Recherche globale">
      <div class="palette-champ">${icone('search', 20)}<input type="search" placeholder="Rechercher un ASIN, une facture, un envoi, un email ou une page…"
        role="combobox" aria-expanded="true" aria-controls="palette-resultats" aria-autocomplete="list"><kbd>Échap</kbd></div>
      <ul class="palette-resultats" id="palette-resultats" role="listbox" aria-label="Résultats"><li class="menu-vide">Chargement…</li></ul>
      <div class="sr" aria-live="polite" id="palette-annonce"></div>
    </div>`;
  document.body.append(fond);
  const champ = fond.querySelector('input');
  const liste = fond.querySelector('ul');
  const annonce = fond.querySelector('#palette-annonce');
  let donnees = [];
  let resultats = [];
  let actif = 0;

  const fermer = () => {
    fond.remove();
    document.removeEventListener('keydown', clavier, true);
    declencheur?.focus?.();
  };
  const aller = (r) => {
    fermer();
    location.hash = r.href;
  };
  const rendre = () => {
    const t = norm(champ.value);
    const mots = t.split(/\s+/).filter(Boolean);
    resultats = (t ? donnees.filter((d) => mots.every((m) => norm(`${d.titre} ${d.detail} ${d.groupe}`).includes(m))) : donnees.filter((d) => d.groupe === 'Pages')).slice(0, 40);
    actif = Math.min(actif, Math.max(0, resultats.length - 1));
    let groupe = '';
    liste.innerHTML = resultats.length
      ? resultats
          .map((r, i) => {
            const titre = r.groupe !== groupe ? `<li class="palette-groupe" role="presentation">${esc(r.groupe)}</li>` : '';
            groupe = r.groupe;
            return `${titre}<li class="menu-option${i === actif ? ' active' : ''}" role="option" id="pal-${i}" data-i="${i}" aria-selected="${i === actif}">
              ${icone(r.icone)}<span class="palette-titre">${esc(r.titre)}</span><span class="palette-detail">${esc(r.detail)}</span></li>`;
          })
          .join('')
      : '<li class="menu-vide">Aucun résultat</li>';
    champ.setAttribute('aria-activedescendant', resultats.length ? `pal-${actif}` : '');
    liste.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    annonce.textContent = `${resultats.length} résultat(s)`;
  };
  const clavier = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); fermer(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); actif = Math.min(resultats.length - 1, actif + 1); rendre(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); actif = Math.max(0, actif - 1); rendre(); }
    else if (e.key === 'Enter' && resultats[actif]) { e.preventDefault(); aller(resultats[actif]); }
    else if (e.key === 'Tab') e.preventDefault(); // le focus reste dans la recherche
  };
  document.addEventListener('keydown', clavier, true);
  fond.addEventListener('pointerdown', (e) => { if (e.target === fond) fermer(); });
  liste.addEventListener('click', (e) => {
    const li = e.target.closest('[data-i]');
    if (li) aller(resultats[Number(li.dataset.i)]);
  });
  liste.addEventListener('pointermove', (e) => {
    const li = e.target.closest('[data-i]');
    if (li && Number(li.dataset.i) !== actif) { actif = Number(li.dataset.i); rendre(); }
  });
  champ.addEventListener('input', () => { actif = 0; rendre(); });
  champ.focus();
  charger().then((d) => { donnees = d; rendre(); });
}

/** Raccourci Ctrl/Cmd+K et bouton de la barre du haut. */
export function installerRecherche() {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const kbd = document.getElementById('raccourci');
  if (kbd) kbd.textContent = mac ? '⌘ K' : 'Ctrl K';
  document.getElementById('recherche-globale')?.addEventListener('click', ouvrirRecherche);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      ouvrirRecherche();
    }
  });
  // Les données changent après une action : la prochaine recherche les recharge.
  window.addEventListener('hashchange', () => (cache = null));
}
