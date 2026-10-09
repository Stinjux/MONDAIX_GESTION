import { api, badge, date, esc, montant, tableau, asinLien, entetePage, formule } from '../outils.js';
import { indicateur, lirePeriode, selecteurPeriode, brancherPeriode, libellePrecedente, nombre } from './tableau.js';

const F_VENDUES = 'Unités vendues estimées à chaque import d’inventaire : stock précédent + unités expédiées à Amazon entre les deux imports − stock actuel.';
const F_COUT = 'Coût d’achat unitaire HT retenu (facture ou fichier d’inventaire), hors livraison, taxes et frais.';
const F_FACTURE = 'Total des factures de l’ASIN (taxes, livraison et frais compris, au prorata) ÷ unités achetées. Factures annulées exclues.';
const F_COGS = 'COGS = unités vendues × coût d’achat unitaire HT retenu.';

function rendre(s, produits) {
  const i = s.indicateurs;
  const parAsin = new Map(produits.map((p) => [p.asin, p]));
  const precedente = libellePrecedente(s.periode);
  return `<div class="grille grille-4">
      ${indicateur(montant(i.cogs.courant), 'COGS', i.cogs, { argent: true, precedente }, formule(F_COGS))}
      ${indicateur(nombre.format(i.cogs.unites_vendues.courant), 'Unités vendues (estimées)', i.cogs.unites_vendues, { precedente }, formule(F_VENDUES))}
      <div class="tuile indicateur ${i.cogs.unites_sans_cout ? 'alerte' : ''}"><div class="libelle">Unités vendues sans coût d’achat</div>
        <div class="valeur">${nombre.format(i.cogs.unites_sans_cout)}</div><div class="variation">${i.cogs.unites_sans_cout ? 'Non comptées dans le COGS : saisissez un coût sur la fiche ASIN.' : 'Toutes les ventes ont un coût.'}</div></div>
      <div class="tuile indicateur"><div class="libelle">Période</div><div class="valeur" style="font-size:var(--t-l)">${date(s.du)} → ${date(s.au)}</div>
        <div class="variation">Comparée aux ${precedente.replace('les ', '')}</div></div>
    </div>
    ${tableau(
      [
        'ASIN',
        'Titre',
        { t: 'Unités vendues', classe: 'num' },
        { t: 'Coût HT / u', classe: 'num' },
        { t: 'Coût facturé / u', classe: 'num' },
        { t: 'COGS', classe: 'num' },
        { t: 'Stock', classe: 'num' },
      ],
      i.cogs.par_asin.map((a) => {
        const p = parAsin.get(a.asin) || {};
        const facture = p.depenses_factures?.cout_moyen_unite ?? null;
        return `<tr><td>${asinLien(a.asin)}</td><td class="titre">${esc(p.titre || '')}</td>
          <td class="num">${nombre.format(a.unites)}</td>
          <td class="num">${a.cout_unitaire === null ? badge('sans coût', 'alerte') : montant(a.cout_unitaire)}</td>
          <td class="num">${montant(facture)}</td>
          <td class="num"><strong>${montant(a.montant)}</strong></td>
          <td class="num">${p.stock ? nombre.format(p.stock.quantite) : '—'}</td></tr>`;
      }),
      'Aucune vente constatée sur la période : il faut au moins deux imports d’inventaire.',
      { videAction: { libelle: 'Importer l’inventaire', href: '#/asins' } },
    )}
    <p class="aide">Survolez (ou sélectionnez au clavier) l’icône d’information d’un en-tête pour voir sa formule. Pas de marge : le prix de vente n’est pas enregistré dans l’application.</p>`;
}

/** En-têtes du tableau avec leur formule (ajoutée après rendu, le tableau échappe le texte). */
function ajouterFormules(zone) {
  const formules = { 'Unités vendues': F_VENDUES, 'Coût HT / u': F_COUT, 'Coût facturé / u': F_FACTURE, COGS: F_COGS };
  zone.querySelectorAll('th').forEach((th) => {
    const f = formules[th.childNodes[0]?.textContent?.trim()];
    if (f && !th.querySelector('.formule')) th.childNodes[0].after(document.createRange().createContextualFragment(` ${formule(f)}`));
  });
}

export async function pageCogs(zone) {
  const periode = lirePeriode();
  const [s, produits] = await Promise.all([api(`/api/statistiques?periode=${periode}`), api('/api/produits')]);
  zone.innerHTML = `
    ${entetePage({ titre: 'COGS', sousTitre: 'Coût des unités vendues par ASIN : coût unitaire, coût moyen facturé et COGS côte à côte.', actions: selecteurPeriode(periode) })}
    <div id="cogs">${rendre(s, produits)}</div>`;
  ajouterFormules(zone);
  brancherPeriode(zone, async (p) => {
    zone.querySelector('#cogs').innerHTML = rendre(await api(`/api/statistiques?periode=${p}`), produits);
    ajouterFormules(zone);
  });
}
