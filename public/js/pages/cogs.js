import { api, post, suppr, badge, date, esc, montant, tableau, asinLien, entetePage, formule, icone, tenter, toast, confirmer, lireFichierTexte } from '../outils.js';
import { rafraichir } from '../app.js';
import { indicateur, lirePeriode, selecteurPeriode, brancherPeriode, libellePrecedente, nombre } from './tableau.js';

const F_VENDUES = 'Unités vendues d’après vos rapports de commandes Amazon (commandes annulées exclues). Avant le premier rapport : estimées à chaque import d’inventaire (stock précédent + unités expédiées à Amazon entre les deux imports − stock actuel).';
const F_CA = 'Chiffre d’affaires = prix des articles vendus (item-price du rapport de commandes), hors taxes et hors frais de livraison facturés.';
const F_MARGE = 'Marge avant frais Amazon = chiffre d’affaires − COGS. Les frais Amazon (commissions, FBA, stockage) ne sont pas déduits.';
const F_COUT = 'Coût d’achat unitaire HT retenu (facture ou fichier d’inventaire), hors livraison, taxes et frais.';
const F_FACTURE = 'Total des factures de l’ASIN (taxes, livraison et frais compris, au prorata) ÷ unités achetées. Factures annulées exclues.';
const F_COGS = 'COGS = unités vendues × coût d’achat unitaire HT retenu.';

function rendre(s, produits) {
  const i = s.indicateurs;
  const parAsin = new Map(produits.map((p) => [p.asin, p]));
  const precedente = libellePrecedente(s.periode);
  const vr = i.cogs.ventes_reelles;
  return `<div class="grille grille-4">
      ${indicateur(montant(i.cogs.courant), 'COGS', i.cogs, { argent: true, precedente }, formule(F_COGS))}
      ${indicateur(nombre.format(i.cogs.unites_vendues.courant), i.cogs.unites_estimees ? 'Unités vendues (en partie estimées)' : 'Unités vendues', i.cogs.unites_vendues, { precedente }, formule(F_VENDUES))}
      ${indicateur(montant(i.cogs.ca.courant), 'Chiffre d’affaires', i.cogs.ca, { argent: true, precedente }, formule(F_CA))}
      ${indicateur(montant(i.cogs.marge_avant_frais.courant), 'Marge avant frais Amazon', i.cogs.marge_avant_frais, { argent: true, precedente }, formule(F_MARGE))}
    </div>
    ${i.cogs.unites_sans_cout ? `<div class="message alerte">${nombre.format(i.cogs.unites_sans_cout)} unité(s) vendue(s) sans coût d’achat : non comptées dans le COGS (la marge est donc surestimée). Saisissez un coût sur la fiche ASIN.</div>` : ''}
    <p class="aide">Du ${date(s.du)} (exclu) au ${date(s.au)}. ${vr.du ? `Ventes réelles d’après vos rapports de commandes du ${date(vr.du)} au ${date(vr.au)}${i.cogs.unites_estimees ? ` ; ${nombre.format(i.cogs.unites_estimees)} unité(s) estimée(s) par l’inventaire avant cette date` : ''}.` : 'Aucun rapport de commandes importé : ventes estimées par les imports d’inventaire.'}</p>
    ${tableau(
      [
        'ASIN',
        { t: 'Unités vendues', classe: 'num' },
        { t: 'Coût HT / u', classe: 'num' },
        { t: 'Coût facturé / u', classe: 'num' },
        { t: 'COGS', classe: 'num' },
        { t: 'Ventes', classe: 'num' },
        { t: 'Stock Amazon', classe: 'num' },
      ],
      i.cogs.par_asin.map((a) => {
        const p = parAsin.get(a.asin) || {};
        const facture = p.depenses_factures?.cout_moyen_unite ?? null;
        return `<tr><td>${asinLien(a.asin)}${p.titre ? `<div class="aide titre">${esc(p.titre)}</div>` : ''}</td>
          <td class="num">${nombre.format(a.unites)}${a.unites_estimees ? ` ${badge(a.unites_estimees === a.unites ? 'estimé' : `${a.unites_estimees} estimée(s)`)}` : ''}</td>
          <td class="num">${a.cout_unitaire === null ? badge('sans coût', 'alerte') : montant(a.cout_unitaire)}</td>
          <td class="num">${montant(facture)}</td>
          <td class="num"><strong>${montant(a.montant)}</strong></td>
          <td class="num">${a.ca ? montant(a.ca) : '—'}</td>
          <td class="num">${p.stock ? nombre.format(p.stock.quantite) : '—'}</td></tr>`;
      }),
      'Aucune vente sur la période : importez votre rapport de commandes Amazon ci-dessous.',
    )}
    <p class="aide">Survolez (ou sélectionnez au clavier) l’icône d’information d’un en-tête pour voir sa formule.</p>`;
}

/** En-têtes du tableau avec leur formule (ajoutée après rendu, le tableau échappe le texte). */
function ajouterFormules(zone) {
  const formules = { 'Unités vendues': F_VENDUES, 'Coût HT / u': F_COUT, 'Coût facturé / u': F_FACTURE, COGS: F_COGS, Ventes: F_CA };
  zone.querySelectorAll('th').forEach((th) => {
    const f = formules[th.childNodes[0]?.textContent?.trim()];
    if (f && !th.querySelector('.formule')) th.childNodes[0].after(document.createRange().createContextualFragment(` ${formule(f)}`));
  });
}

function rendreImports(imports) {
  return `<div class="section-titre"><h2>Rapports de commandes Amazon</h2></div>
    <p class="aide">Seller Central › Rapports › Commandes › <strong>Toutes les commandes</strong> (fichier .txt). Choisissez une période qui commence au plus tard au dernier jour déjà importé : les commandes déjà présentes sont mises à jour, jamais comptées deux fois.</p>
    <label class="depot" for="fichier-ventes">${icone('upload', 20)}<span>Choisir le rapport de commandes (.txt, .tsv, .csv)</span>
      <input type="file" id="fichier-ventes" accept=".txt,.tsv,.csv"></label>
    ${tableau(
      ['Importé le', 'Fichier', 'Période', { t: 'Lignes', classe: 'num' }, { t: 'Unités vendues', classe: 'num' }, { t: '', tri: false }],
      imports.map(
        (m) => `<tr><td class="date">${date(m.created_at)}</td><td>${esc(m.nom || '')}</td>
          <td>${m.du ? `${date(m.du)} → ${date(m.au)}` : '<span class="aide">lignes réimportées depuis</span>'}</td>
          <td class="num">${m.lignes}</td><td class="num">${nombre.format(m.unites)}</td>
          <td class="actions-ligne"><button type="button" class="petit danger" data-suppr-ventes="${m.id}">${icone('trash-2')}Supprimer</button></td></tr>`,
      ),
      'Aucun rapport importé : le COGS repose sur les ventes estimées par l’inventaire.',
    )}`;
}

function brancherImports(zone) {
  const f = zone.querySelector('#fichier-ventes');
  f.onchange = async () => {
    const fichier = f.files[0];
    if (!fichier) return;
    const texte = await lireFichierTexte(fichier);
    const r = await tenter(() => post('/api/imports/ventes', { texte, nom: fichier.name }));
    f.value = '';
    if (!r) return;
    toast(
      `Rapport importé${r.du ? ` (${date(r.du)} → ${date(r.au)})` : ''} : ${r.nouvelles} nouvelle(s) ligne(s), ${r.mises_a_jour} mise(s) à jour, ${r.annulees} annulée(s) non comptée(s), ${nombre.format(r.unites)} unité(s) vendue(s)${r.rejets.length ? `, ${r.rejets.length} ligne(s) rejetée(s)` : ''}.`,
      { duree: 10000 },
    );
    rafraichir();
  };
  zone.querySelectorAll('[data-suppr-ventes]').forEach((b) => {
    b.onclick = async () => {
      const ok = await confirmer({
        titre: 'Supprimer ce rapport de commandes ?',
        message: 'Les ventes qu’il contient sont retirées du COGS. Les lignes réimportées par un rapport plus récent sont conservées.',
        libelle: 'Supprimer',
      });
      if (ok && (await tenter(() => suppr(`/api/imports/ventes/${b.dataset.supprVentes}`))) !== undefined) rafraichir();
    };
  });
}

export async function pageCogs(zone) {
  const periode = lirePeriode();
  const [s, produits, imports] = await Promise.all([api(`/api/statistiques?periode=${periode}`), api('/api/produits'), api('/api/imports/ventes')]);
  zone.innerHTML = `
    ${entetePage({ titre: 'COGS', sousTitre: 'Ventes, coût des unités vendues et marge avant frais Amazon, par ASIN.', actions: selecteurPeriode(periode) })}
    <div id="cogs">${rendre(s, produits)}</div>
    ${rendreImports(imports)}`;
  ajouterFormules(zone.querySelector('#cogs'));
  brancherImports(zone);
  brancherPeriode(zone, async (p) => {
    zone.querySelector('#cogs').innerHTML = rendre(await api(`/api/statistiques?periode=${p}`), produits);
    ajouterFormules(zone.querySelector('#cogs'));
  });
}
