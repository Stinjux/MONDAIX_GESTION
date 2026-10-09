import { api, badge, badgeComparaison, date, esc, montant, tableau, asinLien } from '../outils.js';

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
      ${indicateur(montant(i.depenses.courant), 'Dépensé en commandes', i.depenses, { argent: true, precedente })}
      ${indicateur(nombre.format(i.commandes.courant), 'Commandes passées', i.commandes, { precedente })}
      ${indicateur(nombre.format(i.unites_commandees.courant), 'Unités commandées', i.unites_commandees, { precedente })}
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
    <p class="aide">Du ${date(s.du)} (exclu) au ${date(s.au)}. Dépenses : ${montant(i.depenses.dont_commandes)} de commandes (prix total du Google Sheets${
      i.depenses.commandes_sans_total ? `, ou facture pour ${i.depenses.commandes_sans_total} commande(s) sans prix total` : ''
    }) + ${montant(i.depenses.dont_factures)} de ${i.depenses.nb_factures} facture(s) enregistrée(s) seule(s) ; une facture portant le n° d’une commande existante n’est comptée qu’une fois. Les commandes passées et unités commandées incluent ces factures. Stock : dernier import du fichier d’inventaire, comparé à l’import précédent (indépendant de la période).</p>
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
  const [t, s] = await Promise.all([api('/api/tableau-de-bord'), api(`/api/statistiques?periode=${periode}`)]);
  const c = t.compteurs;
  zone.innerHTML = `
    <div class="entete"><div><h1>Tableau de bord</h1></div>
      <div class="segmente" role="group" aria-label="Période">${PERIODES.map(
        ([p, l]) => `<button data-periode="${p}" aria-pressed="${p === periode}" class="${p === periode ? 'actif' : ''}">${l}</button>`,
      ).join('')}</div></div>
    <div id="indicateurs">${rendreIndicateurs(s)}</div>

    <h2>À rapprocher</h2>
    <p class="aide">Chaîne achats : Ligne Google Sheets → commande → confirmation Gmail → facture → réception → envoi Amazon.
      Chaîne autorisations : ASIN → réponse Neo associée à l’ASIN → statut d’autorisation.</p>
    <div class="grille">
      ${tuile(c.commandes_sans_facture, 'Commandes sans facture', '#/commandes?filtre=sans_facture')}
      ${tuile(c.lignes_sans_commande, 'Lignes Sheets sans commande identifiée', '#/import-sheets')}
      ${tuile(c.asin_sans_autorisation_confirmee, 'ASIN sans statut d’autorisation confirmé', '#/autorisations')}
      ${tuile(c.gmail_a_traiter, 'Confirmations Gmail à rapprocher', '#/emails/gmail')}
      ${tuile(c.neo_a_traiter, 'Réponses Neo à associer à un ASIN', '#/emails/neo')}
      ${tuile(c.ecarts_totaux, 'Totaux déclarés à vérifier (écart ou composition)', '#/commandes?filtre=ecart')}
      ${tuile(c.ecarts_couts, 'Écarts de coût d’achat à arbitrer', '#/asins?filtre=ecarts')}
      ${tuile(c.fournisseurs_a_valider, 'Lignes avec fournisseur à valider', '#/import-sheets')}
    </div>

    <h2>Commandes sans facture (${t.commandes_sans_facture.length})</h2>
    ${tableau(
      ['Commande', 'Fournisseur', 'Date', { t: 'Total déclaré', classe: 'num' }],
      t.commandes_sans_facture.map(
        (x) => `<tr><td><a href="#/commandes/${x.id}">${esc(x.numero_commande || `#${x.id} (n° à préciser)`)}</a></td>
          <td>${esc(x.fournisseur || '—')}</td><td>${date(x.date_commande)}</td><td class="num">${montant(x.total_declare)}</td></tr>`,
      ),
      'Toutes les commandes ont une facture.',
    )}

    <h2>Lignes Google Sheets sans commande identifiée (${t.lignes_sans_commande.length})</h2>
    ${tableau(
      ['Import', 'Ligne', 'ASIN', 'Lien d’origine', { t: 'Qté', classe: 'num' }, { t: 'Total déclaré (commande)', classe: 'num' }, 'Suggestion'],
      t.lignes_sans_commande.slice(0, 50).map((l) => {
        const p = t.propositions_lignes.find((x) => x.ligne_id === l.id);
        return `<tr><td>${esc(l.import_nom)}</td><td class="num">${l.numero_ligne}</td><td>${asinLien(l.asin)}</td>
          <td><span class="lien-court" title="${esc(l.lien_original)}">${esc(l.lien_original || '—')}</span></td>
          <td class="num">${l.quantite ?? '?'}</td><td class="num">${montant(l.total_commande_declare)}</td>
          <td>${p ? badge(p.ambigu ? `${p.candidates.length} commandes possibles` : `commande ${p.candidates[0].numero_commande || '#' + p.candidates[0].commande_id}`, p.ambigu ? 'alerte' : 'info') : ''}</td></tr>`;
      }),
      'Aucune ligne en attente.',
    )}
    ${t.lignes_sans_commande.length > 50 ? `<p class="aide">… ${t.lignes_sans_commande.length - 50} autres dans <a href="#/import-sheets">Import Google Sheets</a>.</p>` : ''}

    <h2>ASIN sans statut d’autorisation confirmé (${t.asin_sans_autorisation_confirmee.length})</h2>
    ${tableau(
      ['ASIN', 'Titre', 'Dossier', 'N° de cas', 'Réponses Neo'],
      t.asin_sans_autorisation_confirmee.slice(0, 50).map(
        (a) => `<tr><td>${asinLien(a.asin)}</td><td>${esc(a.titre || '')}</td>
          <td>${a.dossier_id ? `<a href="#/dossiers/${a.dossier_id}">${esc(a.statut)}</a>` : badge('aucun dossier', 'alerte')}</td>
          <td class="mono">${esc(a.numero_cas || '—')}</td><td class="num">${a.reponses_neo}</td></tr>`,
      ),
      'Tous les ASIN ont un statut confirmé.',
    )}

    ${t.ecarts_totaux.length ? `<h2>Totaux déclarés à vérifier face à la facture (${t.ecarts_totaux.length})</h2>
    ${tableau(
      ['Commande', { t: 'Total déclaré', classe: 'num' }, 'État', 'Détail'],
      t.ecarts_totaux.map((x) => `<tr><td><a href="#/commandes/${x.id}">${esc(x.numero_commande || '#' + x.id)}</a></td>
        <td class="num">${montant(x.total_declare)}</td><td>${badgeComparaison(x.comparaison)}</td><td>${esc(x.comparaison.libelle)}</td></tr>`),
    )}` : ''}

    ${t.ecarts_couts.length ? `<h2>Écarts de coût d’achat unitaire (${t.ecarts_couts.length})</h2>
    ${tableau(
      ['ASIN', { t: 'Retenu', classe: 'num' }, { t: 'Autre valeur', classe: 'num' }, 'Source', { t: 'Écart', classe: 'num' }],
      t.ecarts_couts.map((e) => `<tr><td>${asinLien(e.asin)}</td><td class="num">${montant(e.retenu)}</td>
        <td class="num">${montant(e.valeur)}</td><td>${esc(e.source)} ${esc(e.reference || '')}</td><td class="num">${montant(e.ecart)}</td></tr>`),
    )}` : ''}

    ${t.lignes_envoi_sans_commande.length ? `<h2>Lignes d’envoi Amazon sans commande d’origine (${t.lignes_envoi_sans_commande.length})</h2>
      ${tableau(['Envoi', 'ASIN', { t: 'Qté', classe: 'num' }], t.lignes_envoi_sans_commande.map((l) => `<tr><td><a href="#/envois/${l.envoi_id}">${esc(l.numero_envoi || '#' + l.envoi_id)}</a></td><td>${asinLien(l.asin)}</td><td class="num">${l.quantite}</td></tr>`))}` : ''}
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
