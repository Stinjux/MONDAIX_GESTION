import { esc } from './outils.js';
import { pageTableauDeBord } from './pages/tableau.js';
import { pageImportSheets } from './pages/importSheets.js';
import { pageCommandes, pageCommande } from './pages/commandes.js';
import { pageProduits, pageProduit, pageDepenses } from './pages/produits.js';
import { pageEnvois, pageEnvoi } from './pages/envois.js';
import { pageAutorisations, pageDossier } from './pages/autorisations.js';
import { pageEmails } from './pages/emails.js';
import { pageFournisseurs, pageFactures, pageParametres, pageJournal } from './pages/divers.js';

const ROUTES = [
  [/^$/, pageTableauDeBord],
  [/^import-sheets$/, pageImportSheets],
  [/^commandes$/, pageCommandes],
  [/^commandes\/(\d+)$/, pageCommande],
  [/^factures$/, pageFactures],
  [/^produits$/, pageProduits],
  [/^produits\/([A-Z0-9]+)$/, pageProduit],
  [/^depenses$/, pageDepenses],
  [/^envois$/, pageEnvois],
  [/^envois\/(\d+)$/, pageEnvoi],
  [/^autorisations$/, pageAutorisations],
  [/^dossiers\/(\d+)$/, pageDossier],
  [/^emails\/(gmail|neo)$/, pageEmails],
  [/^fournisseurs$/, pageFournisseurs],
  [/^parametres$/, pageParametres],
  [/^journal$/, pageJournal],
];

export async function afficher() {
  const chemin = location.hash.replace(/^#\/?/, '').split('?')[0];
  const zone = document.getElementById('contenu');
  for (const a of document.querySelectorAll('#nav a')) {
    const r = a.dataset.route;
    a.classList.toggle('actif', r === '' ? chemin === '' : chemin === r || chemin.startsWith(r + '/'));
  }
  document.getElementById('nav').classList.remove('ouvert');
  for (const [re, page] of ROUTES) {
    const m = chemin.match(re);
    if (!m) continue;
    try {
      await page(zone, ...m.slice(1));
    } catch (e) {
      zone.innerHTML = `<div class="message erreur">${esc(e.message)}</div>`;
    }
    return;
  }
  zone.innerHTML = '<div class="message erreur">Page introuvable.</div>';
}

/** Recharge la page courante (après une action). */
export const rafraichir = () => afficher();

window.addEventListener('hashchange', afficher);
document.getElementById('menu-mobile').onclick = () => document.getElementById('nav').classList.toggle('ouvert');
afficher();
