import { api, badge, date, esc, montant, tableau, asinLien, references } from '../outils.js';
import { badgeSuivi } from './envois.js';

function tuile(valeur, libelle, lien, alerte = true) {
  return `<a class="tuile ${valeur ? (alerte ? 'alerte' : '') : 'ok'}" href="${lien}">
    <div class="valeur">${valeur}</div><div class="libelle">${esc(libelle)}</div></a>`;
}

const PERIODES = [
  ['7j', '7 jours'],
  ['30j', 'Mois'],
  ['90j', '3 mois'],
  ['365j', 'Année'],
];

const nombre = new Intl.NumberFormat('fr-CA');

/** Variation par rapport à la période précédente : flèche + signe + texte (jamais la couleur seule). */
function variation(v, { argent = false, stock = false, precedente }) {
  const fmt = (x) => (argent ? montant(x) : nombre.format(x));
  if (stock && !precedente) return '<div class="variation">Premier import : pas encore de comparaison</div>';
  if (v.ecart === 0) return `<div class="variation">= stable ${stock ? `depuis ${precedente}` : `vs ${precedente}`} (${fmt(v.precedent)})</div>`;
  const fleche = v.ecart > 0 ? '▲' : '▼';
  const signe = v.ecart > 0 ? '+' : '−';
  if (stock) return `<div class="variation">${fleche} ${signe}${nombre.format(Math.abs(v.ecart))} unité(s) depuis ${precedente} (${fmt(v.precedent)})</div>`;
  const pct = v.pourcentage === null ? 'nouveau' : `${signe}${nombre.format(Math.abs(v.pourcentage))} %`;
  return `<div class="variation">${fleche} ${pct} vs ${precedente} (${fmt(v.precedent)})</div>`;
}

function indicateur(valeur, libelle, v, options) {
  return `<div class="tuile indicateur"><div class="libelle">${esc(libelle)}</div><div class="valeur">${valeur}</div>${variation(v, options)}</div>`;
}

function rendreIndicateurs(s) {
  const i = s.indicateurs;
  const jours = { '7j': '7', '30j': '30', '90j': '90', '365j': '365' }[s.periode];
  const precedente = `les ${jours} jours précédents`;
  return `<div class="grille">
      ${indicateur(montant(i.depenses.courant), 'Dépensé (factures)', i.depenses, { argent: true, precedente })}
      ${indicateur(nombre.format(i.factures.courant), 'Factures', i.factures, { precedente })}
      ${indicateur(nombre.format(i.unites_achetees.courant), 'Unités achetées', i.unites_achetees, { precedente })}
      ${indicateur(nombre.format(i.envois.courant), 'Envois Amazon expédiés', i.envois, { precedente })}
      ${indicateur(nombre.format(i.unites_envoyees.courant), 'Unités envoyées à Amazon', i.unites_envoyees, { precedente })}
      ${indicateur(montant(i.cogs.courant), 'COGS (coût des unités vendues)', i.cogs, { argent: true, precedente })}
      ${indicateur(nombre.format(i.cogs.unites_vendues.courant), 'Unités vendues (estimées)', i.cogs.unites_vendues, { precedente })}
      ${i.stock
        ? indicateur(nombre.format(i.stock.courant), `Unités en stock (import du ${date(i.stock.date_import)})`, i.stock, {
            stock: true,
            precedente: i.stock.date_import_precedent ? `l’import du ${date(i.stock.date_import_precedent)}` : null,
          })
        : `<a class="tuile indicateur" href="#/asins"><div class="libelle">Unités en stock</div><div class="valeur">0</div><div class="variation">Aucun import d’inventaire (page ASIN)</div></a>`}
    </div>
    <p class="aide">Du ${date(s.du)} (exclu) au ${date(s.au)}, selon la date de chaque facture. Dépenses = total des factures (taxes, livraison et frais compris)${
      i.depenses.factures_annulees ? ` ; ${i.depenses.factures_annulees} facture(s) annulée(s) et remboursée(s) (${montant(i.depenses.montant_annule)}) non comptée(s)` : ''
    }. Stock : dernier import du fichier d’inventaire, comparé à l’import précédent (indépendant de la période).</p>
    <h2>COGS de la période</h2>
    <p class="aide">Unités vendues estimées à chaque import d’inventaire : stock précédent + unités expédiées à Amazon entre les deux imports − stock actuel.
      COGS = unités vendues × coût d’achat unitaire HT retenu. Importez l’inventaire régulièrement (page ASIN) pour un suivi précis.${
      i.cogs.unites_sans_cout ? ` <strong>${i.cogs.unites_sans_cout} unité(s) vendue(s) sans coût d’achat retenu : non comptées dans le COGS.</strong>` : ''}</p>
    ${tableau(
      ['ASIN', { t: 'Unités vendues', classe: 'num' }, { t: 'Coût d’achat HT / unité', classe: 'num' }, { t: 'COGS', classe: 'num' }],
      i.cogs.par_asin.map((a) => `<tr><td>${asinLien(a.asin)}</td><td class="num">${nombre.format(a.unites)}</td>
        <td class="num">${a.cout_unitaire === null ? badge('sans coût', 'alerte') : montant(a.cout_unitaire)}</td><td class="num">${montant(a.montant)}</td></tr>`),
      'Aucune vente constatée sur la période (il faut au moins deux imports d’inventaire).',
    )}`;
}

export async function pageTableauDeBord(zone) {
  let periode = '30j';
  try {
    periode = localStorage.getItem('mondaix.periode') || '30j';
  } catch {
    // stockage indisponible : période par défaut
  }
  const [t, s, refs] = await Promise.all([api('/api/tableau-de-bord'), api(`/api/statistiques?periode=${periode}`), references()]);
  const c = t.compteurs;
  zone.innerHTML = `
    <div class="entete"><div><h1>Tableau de bord</h1></div>
      <div class="segmente" role="group" aria-label="Période">${PERIODES.map(
        ([p, l]) => `<button data-periode="${p}" aria-pressed="${p === periode}" class="${p === periode ? 'actif' : ''}">${l}</button>`,
      ).join('')}</div></div>
    <div id="indicateurs">${rendreIndicateurs(s)}</div>

    <h2>À vérifier</h2>
    <p class="aide">Facture → ASIN (coût unitaire) → envoi Amazon → réception par Amazon → stock Amazon (import d’inventaire).</p>
    <div class="grille">
      ${tuile(c.envois_a_verifier, `Envois en transit : réception à vérifier (${c.unites_en_transit} unité(s))`, '#/envois?filtre=a_verifier')}
      ${tuile(c.envois_en_ecart, 'Envois reçus avec un écart', '#/envois?filtre=ecart')}
      ${tuile(c.factures_sans_asin, 'Factures sans ASIN associé', '#/factures')}
      ${tuile(c.ecarts_couts, 'Écarts de coût d’achat à arbitrer', '#/asins?filtre=ecarts')}
      ${tuile(c.asin_sans_autorisation_confirmee, 'ASIN sans statut d’autorisation confirmé', '#/autorisations')}
      ${tuile(c.gmail_a_traiter, 'Emails Gmail à associer à un ASIN', '#/emails/gmail')}
      ${tuile(c.neo_a_traiter, 'Réponses Neo à associer à un ASIN', '#/emails/neo')}
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
      ['ASIN', 'Titre', 'Dossier', 'Réponses Neo'],
      t.asin_sans_autorisation_confirmee.slice(0, 50).map(
        (a) => `<tr><td>${asinLien(a.asin)}</td><td>${esc(a.titre || '')}</td>
          <td>${a.dossier_id ? `<a href="#/dossiers/${a.dossier_id}">${esc(a.statut)}</a>` : badge('aucun dossier', 'alerte')}</td>
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
  zone.querySelectorAll('[data-periode]').forEach((b) => {
    b.onclick = async () => {
      const p = b.dataset.periode;
      try {
        localStorage.setItem('mondaix.periode', p);
      } catch {
        // stockage indisponible
      }
      zone.querySelectorAll('[data-periode]').forEach((x) => {
        x.classList.toggle('actif', x === b);
        x.setAttribute('aria-pressed', String(x === b));
      });
      zone.querySelector('#indicateurs').innerHTML = rendreIndicateurs(await api(`/api/statistiques?periode=${p}`));
    };
  });
}
