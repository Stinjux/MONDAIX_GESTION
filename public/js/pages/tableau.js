import { api, badge, date, esc, montant, tableau, asinLien, references, entetePage, icone } from '../outils.js';
import { badgeSuivi } from './envois.js';

/* ------------------------------------------------------------ outils partagés avec la page COGS */

export const PERIODES = [
  ['7j', '7 jours'],
  ['30j', 'Mois'],
  ['90j', '3 mois'],
  ['365j', 'Année'],
];

export const nombre = new Intl.NumberFormat('fr-CA');

export function lirePeriode() {
  try {
    return localStorage.getItem('mondaix.periode') || '30j';
  } catch {
    return '30j'; // stockage indisponible : période par défaut
  }
}

function ecrirePeriode(p) {
  try {
    localStorage.setItem('mondaix.periode', p);
  } catch {
    // stockage indisponible
  }
}

export function selecteurPeriode(periode) {
  return `<div class="segmente" role="group" aria-label="Période">${PERIODES.map(
    ([p, l]) => `<button type="button" data-periode="${p}" aria-pressed="${p === periode}" class="${p === periode ? 'actif' : ''}">${l}</button>`,
  ).join('')}</div>`;
}

/** Branche le sélecteur de période : enregistre le choix et appelle majPeriode(p). */
export function brancherPeriode(zone, majPeriode) {
  zone.querySelectorAll('[data-periode]').forEach((b) => {
    b.onclick = async () => {
      const p = b.dataset.periode;
      ecrirePeriode(p);
      zone.querySelectorAll('[data-periode]').forEach((x) => {
        x.classList.toggle('actif', x === b);
        x.setAttribute('aria-pressed', String(x === b));
      });
      await majPeriode(p);
    };
  });
}

export function libellePrecedente(periode) {
  return `les ${{ '7j': '7', '30j': '30', '90j': '90', '365j': '365' }[periode]} jours précédents`;
}

/** Variation par rapport à la période précédente : icône + signe + texte (jamais la couleur seule). */
export function variation(v, { argent = false, stock = false, precedente }) {
  const fmt = (x) => (argent ? montant(x) : nombre.format(x));
  if (stock && !precedente) return '<div class="variation">Premier import : pas encore de comparaison</div>';
  if (v.ecart === 0) return `<div class="variation">= stable ${stock ? `depuis ${precedente}` : `vs ${precedente}`} (${fmt(v.precedent)})</div>`;
  const fleche = icone(v.ecart > 0 ? 'arrow-up' : 'arrow-down', 14);
  const signe = v.ecart > 0 ? '+' : '−';
  if (stock) return `<div class="variation">${fleche}<span>${signe}${nombre.format(Math.abs(v.ecart))} unité(s) depuis ${precedente} (${fmt(v.precedent)})</span></div>`;
  const pct = v.pourcentage === null ? 'nouveau' : `${signe}${nombre.format(Math.abs(v.pourcentage))} %`;
  return `<div class="variation">${fleche}<span>${pct} vs ${precedente} (${fmt(v.precedent)})</span></div>`;
}

export function indicateur(valeur, libelle, v, options, infoFormule = '') {
  return `<div class="tuile indicateur"><div class="libelle">${esc(libelle)} ${infoFormule}</div><div class="valeur">${valeur}</div>${variation(v, options)}</div>`;
}

/* ------------------------------------------------------------ tableau de bord */

function tuileAVerifier(valeur, libelle, lien, ic) {
  const ton = valeur ? 'alerte' : 'ok';
  return `<a class="tuile ${ton}" href="${lien}">
    <div class="tuile-tete"><div class="valeur">${valeur}</div>${icone(valeur ? ic : 'circle-check', 20)}</div>
    <div class="libelle">${esc(libelle)}</div>${valeur ? '' : '<div class="variation">Rien à vérifier</div>'}</a>`;
}

function rendreIndicateurs(s) {
  const i = s.indicateurs;
  const precedente = libellePrecedente(s.periode);
  const top = i.cogs.par_asin.slice(0, 5);
  return `<div class="grille grille-4">
      ${indicateur(montant(i.depenses.courant), 'Dépensé (factures)', i.depenses, { argent: true, precedente })}
      ${indicateur(nombre.format(i.factures.courant), 'Factures', i.factures, { precedente })}
      ${indicateur(nombre.format(i.unites_achetees.courant), 'Unités achetées', i.unites_achetees, { precedente })}
      ${indicateur(nombre.format(i.envois.courant), 'Envois Amazon expédiés', i.envois, { precedente })}
      ${indicateur(nombre.format(i.unites_envoyees.courant), 'Unités envoyées à Amazon', i.unites_envoyees, { precedente })}
      ${indicateur(montant(i.cogs.courant), 'COGS', i.cogs, { argent: true, precedente })}
      ${indicateur(nombre.format(i.cogs.unites_vendues.courant), 'Unités vendues (estimées)', i.cogs.unites_vendues, { precedente })}
      ${i.stock
        ? indicateur(nombre.format(i.stock.courant), `Unités en stock (import du ${date(i.stock.date_import)})`, i.stock, {
            stock: true,
            precedente: i.stock.date_import_precedent ? `l’import du ${date(i.stock.date_import_precedent)}` : null,
          })
        : `<a class="tuile indicateur" href="#/asins"><div class="libelle">Unités en stock</div><div class="valeur">0</div><div class="variation">Aucun import d’inventaire (page Stocks)</div></a>`}
    </div>
    <p class="aide">Du ${date(s.du)} (exclu) au ${date(s.au)}, selon la date de chaque facture. Dépenses = total des factures (taxes, livraison et frais compris)${
      i.depenses.factures_annulees ? ` ; ${i.depenses.factures_annulees} facture(s) annulée(s) et remboursée(s) (${montant(i.depenses.montant_annule)}) non comptée(s)` : ''
    }. Stock : dernier import du fichier d’inventaire, comparé à l’import précédent (indépendant de la période).</p>

    <div class="section-titre"><h2>COGS de la période</h2><a class="bouton" href="#/cogs">${icone('calculator')}Détail COGS</a></div>
    ${tableau(
      ['ASIN', { t: 'Unités vendues', classe: 'num' }, { t: 'Coût d’achat HT / unité', classe: 'num' }, { t: 'COGS', classe: 'num' }],
      top.map((a) => `<tr><td>${asinLien(a.asin)}</td><td class="num">${nombre.format(a.unites)}</td>
        <td class="num">${a.cout_unitaire === null ? badge('sans coût', 'alerte') : montant(a.cout_unitaire)}</td><td class="num">${montant(a.montant)}</td></tr>`),
      'Aucune vente constatée sur la période (il faut au moins deux imports d’inventaire).',
      { videAction: { libelle: 'Importer l’inventaire', href: '#/asins' } },
    )}
    ${i.cogs.par_asin.length > top.length ? `<p class="aide">${i.cogs.par_asin.length - top.length} autre(s) ASIN dans le <a href="#/cogs">détail COGS</a>.</p>` : ''}`;
}

export async function pageTableauDeBord(zone) {
  const periode = lirePeriode();
  const [t, s, refs] = await Promise.all([api('/api/tableau-de-bord'), api(`/api/statistiques?periode=${periode}`), references()]);
  const c = t.compteurs;
  zone.innerHTML = `
    ${entetePage({ titre: 'Tableau de bord', sousTitre: 'Achats, envois, ventes estimées et stock, comparés à la période précédente.', actions: selecteurPeriode(periode) })}
    <div id="indicateurs">${rendreIndicateurs(s)}</div>

    <h2>À vérifier</h2>
    <p class="aide">Facture → ASIN (coût unitaire) → envoi Amazon → réception par Amazon → stock Amazon (import d’inventaire).</p>
    <div class="grille grille-4">
      ${tuileAVerifier(c.envois_a_verifier, `Envois en transit : réception à vérifier (${c.unites_en_transit} unité(s))`, '#/envois?filtre=a_verifier', 'truck')}
      ${tuileAVerifier(c.envois_en_ecart, 'Envois reçus avec un écart', '#/envois?filtre=ecart', 'triangle-alert')}
      ${tuileAVerifier(c.factures_sans_asin, 'Factures sans ASIN associé', '#/factures', 'receipt')}
      ${tuileAVerifier(c.ecarts_couts, 'Écarts de coût d’achat à arbitrer', '#/asins?filtre=ecarts', 'triangle-alert')}
      ${tuileAVerifier(c.asin_sans_autorisation_confirmee, 'ASIN sans statut d’autorisation confirmé', '#/autorisations', 'shield-check')}
      ${tuileAVerifier(c.gmail_a_traiter, 'Emails Gmail à associer à un ASIN', '#/emails/gmail', 'mail')}
      ${tuileAVerifier(c.neo_a_traiter, 'Réponses Neo à associer à un ASIN', '#/emails/neo', 'mail')}
    </div>

    <h2>Envois à vérifier (${t.envois_a_verifier.length})</h2>
    ${tableau(
      ['Envoi', 'Date d’expédition', { t: 'Envoyé', classe: 'num' }, { t: 'Reçu par Amazon', classe: 'num' }, 'Suivi'],
      t.envois_a_verifier.map((e) => `<tr><td><a href="#/envois/${e.id}">${esc(e.numero_envoi || '#' + e.id)}</a></td><td>${date(e.date_envoi)}</td>
        <td class="num">${e.suivi.unites_envoyees}</td><td class="num">${e.suivi.lignes_a_verifier === e.nb_lignes ? '—' : e.suivi.unites_recues}</td>
        <td>${badgeSuivi(e.suivi, refs)}</td></tr>`),
      'Tous les envois expédiés sont bien arrivés chez Amazon.',
    )}

    ${t.factures_sans_asin.length ? `<h2>Factures sans ASIN associé (${t.factures_sans_asin.length})</h2>
    ${tableau(
      ['Facture', 'Date', 'Fournisseur', { t: 'Total', classe: 'num' }],
      t.factures_sans_asin.map((f) => `<tr><td><a href="#/factures">${esc(f.numero_facture || '#' + f.id)}</a></td><td>${date(f.date_facture)}</td>
        <td>${esc(f.fournisseur || '—')}</td><td class="num">${montant(f.total_calcule)}</td></tr>`),
    )}` : ''}

    <h2>ASIN sans statut d’autorisation confirmé (${t.asin_sans_autorisation_confirmee.length})</h2>
    ${tableau(
      ['ASIN', 'Titre', 'Dossier', { t: 'Réponses Neo', classe: 'num' }],
      t.asin_sans_autorisation_confirmee.slice(0, 50).map(
        (a) => `<tr><td>${asinLien(a.asin)}</td><td>${esc(a.titre || '')}</td>
          <td>${a.dossier_id ? `<a href="#/dossiers/${a.dossier_id}">${esc(refs.statuts_dossier[a.statut] || a.statut)}</a>` : badge('aucun dossier', 'alerte')}</td>
          <td class="num">${a.reponses_neo}</td></tr>`,
      ),
      'Tous les ASIN ont un statut confirmé.',
    )}

    ${t.ecarts_couts.length ? `<h2>Écarts de coût d’achat unitaire (${t.ecarts_couts.length})</h2>
    ${tableau(
      ['ASIN', { t: 'Retenu', classe: 'num' }, { t: 'Autre valeur', classe: 'num' }, 'Source', { t: 'Écart', classe: 'num' }],
      t.ecarts_couts.map((e) => `<tr><td>${asinLien(e.asin)}</td><td class="num">${montant(e.retenu)}</td>
        <td class="num">${montant(e.valeur)}</td><td>${esc(e.source)} ${esc(e.reference || '')}</td><td class="num">${montant(e.ecart)}</td></tr>`),
    )}` : ''}
  `;
  brancherPeriode(zone, async (p) => {
    zone.querySelector('#indicateurs').innerHTML = rendreIndicateurs(await api(`/api/statistiques?periode=${p}`));
  });
}
