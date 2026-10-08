import { api, post, put, suppr, esc, montant, date, badge, badgeComparaison, tableau, modale, champ, selecteur, selecteurTriEtat, tenter, toast, triEtat, references, asinLien } from '../outils.js';
import { rafraichir } from '../app.js';

function filtreUrl() {
  return new URLSearchParams(location.hash.split('?')[1] || '').get('filtre') || '';
}

export async function pageCommandes(zone) {
  const commandes = await api('/api/commandes');
  const filtre = filtreUrl();
  const visibles = commandes.filter((c) => {
    if (filtre === 'sans_facture') return !c.nb_factures;
    if (filtre === 'ecart') return ['ecart', 'composition_inconnue', 'detail_insuffisant'].includes(c.comparaison.statut);
    if (filtre === 'sans_confirmation') return !c.nb_confirmations;
    return true;
  });
  zone.innerHTML = `
    <div class="entete"><div><h1>Commandes fournisseurs</h1>
      <p class="aide">Le total déclaré est affiché tel quel tant que sa composition n’est pas connue ; il est comparé à la facture, jamais additionné aux coûts détaillés.</p></div>
      <div class="actions"><button class="principal" id="nouvelle">Nouvelle commande</button></div></div>
    <div class="onglets">
      ${[['', 'Toutes'], ['sans_facture', 'Sans facture'], ['sans_confirmation', 'Sans confirmation Gmail'], ['ecart', 'Écarts à vérifier']]
        .map(([f, t]) => `<a href="#/commandes${f ? '?filtre=' + f : ''}" class="${f === filtre ? 'actif' : ''}">${t}</a>`)
        .join('')}
    </div>
    ${tableau(
      ['Commande', 'Fournisseur', 'Date', 'Source', { t: 'Unités', classe: 'num' }, { t: 'Total déclaré', classe: 'num' }, 'Composition', 'Gmail', 'Facture', 'Réception', { t: 'Envoyées', classe: 'num' }],
      visibles.map(
        (c) => `<tr>
          <td><a href="#/commandes/${c.id}">${esc(c.numero_commande || `#${c.id}`)}</a>${c.numero_commande ? '' : ' ' + badge('n° à préciser', 'alerte')}</td>
          <td>${esc(c.fournisseur || '—')}</td><td>${date(c.date_commande)}</td><td>${esc(c.source)}</td>
          <td class="num">${c.unites}</td><td class="num">${montant(c.total_declare)}</td>
          <td>${c.total_declare === null ? '—' : `taxes : ${triEtat(c.total_inclut_taxes)} · livraison : ${triEtat(c.total_inclut_livraison)}`}</td>
          <td>${c.nb_confirmations ? badge('reçue', 'ok') : badge('manquante', 'alerte')}</td>
          <td>${badgeComparaison(c.comparaison)}</td>
          <td>${c.nb_receptions ? badge(`${c.nb_receptions}`, 'ok') : badge('aucune')}</td>
          <td class="num">${c.unites_envoyees}</td></tr>`,
      ),
      'Aucune commande.',
    )}`;
  zone.querySelector('#nouvelle').onclick = () => nouvelleCommande();
}

function lignesSaisie(lignes = [{}], avecCout = true) {
  return `<div id="lignes-saisie">${lignes
    .map(
      (l, i) => `<div class="actions ligne-saisie" style="margin-bottom:6px">
      <input name="asin_${i}" placeholder="ASIN" value="${esc(l.asin || '')}" style="width:140px">
      <input name="quantite_${i}" placeholder="Qté" value="${esc(l.quantite || '')}" style="width:70px" inputmode="numeric">
      ${avecCout ? `<input name="cout_${i}" placeholder="Coût unitaire HT (facultatif)" value="${esc(l.cout ?? '')}" style="width:200px" inputmode="decimal">` : ''}
    </div>`,
    )
    .join('')}</div><button type="button" class="petit" id="ajouter-ligne-saisie">+ ligne</button>`;
}

function brancherLignesSaisie(form, avecCout = true) {
  form.querySelector('#ajouter-ligne-saisie').onclick = () => {
    const n = form.querySelectorAll('.ligne-saisie').length;
    form.querySelector('#lignes-saisie').insertAdjacentHTML(
      'beforeend',
      `<div class="actions ligne-saisie" style="margin-bottom:6px"><input name="asin_${n}" placeholder="ASIN" style="width:140px">
       <input name="quantite_${n}" placeholder="Qté" style="width:70px">${avecCout ? `<input name="cout_${n}" placeholder="Coût unitaire HT (facultatif)" style="width:200px">` : ''}</div>`,
    );
  };
}

function lireLignesSaisie(d, cleCout = 'cout_unitaire_ht') {
  const lignes = [];
  for (let i = 0; `asin_${i}` in d; i++) {
    if (!d[`asin_${i}`].trim()) continue;
    lignes.push({ asin: d[`asin_${i}`], quantite: d[`quantite_${i}`], [cleCout]: d[`cout_${i}`] ?? '' });
  }
  return lignes;
}

async function nouvelleCommande() {
  const fournisseurs = await api('/api/fournisseurs');
  const r = await modale({
    titre: 'Nouvelle commande (saisie manuelle)',
    contenu: `<div class="champs">
        ${champ('numero_commande', 'N° de commande')}${champ('date_commande', 'Date', { type: 'date' })}
        ${selecteur('fournisseur_id', 'Fournisseur', [['', '— à préciser —'], ...fournisseurs.map((f) => [f.id, f.nom])])}
        ${champ('lien_original', 'Lien (domaine ou page produit)')}
        ${champ('total_declare', 'Total déclaré', { attrs: 'inputmode="decimal"' })}
        ${selecteurTriEtat('total_inclut_taxes', 'Inclut les taxes ?', null)}${selecteurTriEtat('total_inclut_livraison', 'Inclut la livraison ?', null)}
      </div><h3>Lignes</h3>${lignesSaisie()}`,
    libelleValider: 'Créer',
    apresOuverture: (f) => brancherLignesSaisie(f),
    valider: (d) => post('/api/commandes', { ...d, lignes: lireLignesSaisie(d) }),
  });
  if (r) location.hash = `#/commandes/${r.id}`;
}

export async function pageCommande(zone, id) {
  const [c, fournisseurs, refs] = await Promise.all([api(`/api/commandes/${id}`), api('/api/fournisseurs'), references()]);
  const comp = c.comparaison;
  zone.innerHTML = `
    <div class="entete"><div><a href="#/commandes">← Commandes</a>
      <h1>Commande ${esc(c.numero_commande || `#${c.id}`)}</h1>
      <p class="aide">${esc(c.fournisseur || 'Fournisseur à préciser')} · ${date(c.date_commande)} · source : ${esc(c.source)}
      ${c.lien_original ? `<br>Lien d’origine : <span class="mono">${esc(c.lien_original)}</span>` : ''}</p></div>
      <div class="actions"><button id="modifier">Modifier</button><button class="danger" id="supprimer">Supprimer</button></div></div>

    <div class="chaine">${c.chaine.map((e) => `<div class="etape ${e.etat}"><div class="nom">${esc(e.libelle)}</div><div class="det">${esc(e.detail)}</div></div>`).join('')}</div>

    <h2>Total déclaré et facture</h2>
    <div class="carte">
      <div class="champs" style="margin-bottom:0">
        <div><label>Total déclaré</label><strong>${montant(c.total_declare)}</strong></div>
        <div><label>Inclut les taxes</label>${triEtat(c.total_inclut_taxes)}</div>
        <div><label>Inclut la livraison</label>${triEtat(c.total_inclut_livraison)}</div>
        <div><label>Vérification</label>${badgeComparaison(comp)}</div>
      </div>
      <p class="aide" style="margin-bottom:0">${esc(comp.libelle || '')}
      ${comp.montant_compare !== undefined && comp.montant_compare !== null ? ` · comparé à : ${montant(comp.montant_compare)} (${esc(comp.base)})` : ''}</p>
      ${comp.correspondances?.length ? `<div class="actions" style="margin-top:8px">${comp.correspondances
        .map((x) => `<button class="petit" data-composition='${JSON.stringify({ t: x.inclut_taxes, l: x.inclut_livraison })}'>Confirmer : ${esc(x.libelle)}</button>`)
        .join('')}</div>` : ''}
      ${c.total_declare !== null && !c.factures.length ? '<p class="aide">Aucune ventilation n’est calculée à partir du total déclaré.</p>' : ''}
    </div>

    <h2>Lignes de commande</h2>
    ${tableau(
      ['ASIN', 'Titre', { t: 'Qté', classe: 'num' }, { t: 'Coût unitaire HT (commande)', classe: 'num' }, 'Origine', ''],
      c.lignes.map(
        (l) => `<tr><td>${asinLien(l.asin)}</td><td>${esc(l.titre || '')}</td>
          <td class="num">${l.quantite}</td><td class="num">${l.cout_unitaire_ht === null ? '<span class="aide">non connu</span>' : montant(l.cout_unitaire_ht)}</td>
          <td>${l.ligne_import_id ? `Sheets ligne ${l.numero_ligne}` : 'saisie'}</td>
          <td class="actions"><button class="petit" data-ligne="${l.id}">Modifier</button><button class="petit danger" data-suppr-ligne="${l.id}">Retirer</button></td></tr>`,
      ),
      'Aucune ligne.',
    )}
    <button id="ajout-ligne">+ Ajouter une ligne</button>

    <h2>Confirmations Gmail</h2>
    ${tableau(
      ['Date', 'Expéditeur', 'Sujet', 'Rapprochement'],
      c.emails.map((e) => `<tr><td>${date(e.date_reception)}</td><td>${esc(e.expediteur)}</td><td>${esc(e.sujet)}</td><td>${badge(e.mode_rapprochement === 'auto' ? 'auto (n° exact)' : 'validé', 'ok')}</td></tr>`),
      'Aucune confirmation rattachée. Voir Gmail · confirmations.',
    )}

    <h2>Factures</h2>
    ${tableau(
      ['N°', 'Date', { t: 'Sous-total HT', classe: 'num' }, { t: 'Taxes', classe: 'num' }, { t: 'Livraison', classe: 'num' }, { t: 'Autres', classe: 'num' }, { t: 'Total', classe: 'num' }, 'Prix unitaires', ''],
      c.factures.map(
        (f) => `<tr><td>${esc(f.numero_facture || '—')}</td><td>${date(f.date_facture)}</td><td class="num">${montant(f.sous_total_ht)}</td>
          <td class="num">${montant(f.taxes)}</td><td class="num">${montant(f.livraison)}</td><td class="num">${montant(f.autres_frais)}</td>
          <td class="num"><strong>${montant(f.total_calcule)}</strong></td>
          <td>${f.lignes.map((l) => `${asinLien(l.asin)} × ${l.quantite} @ ${montant(l.prix_unitaire_ht)}`).join('<br>') || '—'}</td>
          <td><button class="petit danger" data-suppr-facture="${f.id}">Supprimer</button></td></tr>`,
      ),
      'Aucune facture.',
    )}
    <button id="ajout-facture">+ Saisir la facture</button>

    <h2>Réceptions</h2>
    ${tableau(
      ['Date', 'Contenu', 'Notes', ''],
      c.receptions.map((r) => `<tr><td>${date(r.date_reception)}</td><td>${r.lignes.map((l) => `${asinLien(l.asin)} × ${l.quantite}`).join(', ')}</td><td>${esc(r.notes || '')}</td>
        <td><button class="petit danger" data-suppr-reception="${r.id}">Supprimer</button></td></tr>`),
      'Aucune réception.',
    )}
    <button id="ajout-reception">+ Enregistrer une réception</button>

    <h2>Envois Amazon</h2>
    ${tableau(
      ['Envoi', 'Date', 'ASIN', { t: 'Qté', classe: 'num' }, 'Statut'],
      c.envois.map((e) => `<tr><td><a href="#/envois/${e.envoi_id}">${esc(e.numero_envoi || '#' + e.envoi_id)}</a></td><td>${date(e.date_envoi)}</td><td>${asinLien(e.asin)}</td><td class="num">${e.quantite}</td><td>${esc(refs.statuts_envoi[e.statut])}</td></tr>`),
      'Aucune unité de cette commande dans un envoi Amazon.',
    )}

    <h2>Dépenses enregistrées pour cette commande</h2>
    <p class="aide">Base du coût complet (réparties au prorata des quantités). Les frais de la facture y sont ajoutés automatiquement.</p>
    ${tableau(
      ['Type', 'Description', 'Date', { t: 'Montant', classe: 'num' }, ''],
      c.depenses.map((d) => `<tr><td>${esc(refs.types_depense[d.type])}</td><td>${esc(d.description || '')}</td><td>${date(d.date_depense)}</td><td class="num">${montant(d.montant)}</td>
        <td>${d.facture_id ? badge('facture') : `<button class="petit danger" data-suppr-depense="${d.id}">Supprimer</button>`}</td></tr>`),
      'Aucune dépense enregistrée : la livraison et les autres frais restent inconnus.',
    )}
    <button id="ajout-depense">+ Ajouter une dépense</button>

    ${c.lignes_import.length ? `<h2>Lignes Google Sheets d’origine</h2>
    ${tableau(['Import · ligne', 'ASIN', 'Lien d’origine', { t: 'Qté', classe: 'num' }, { t: 'Total déclaré sur la ligne (commande)', classe: 'num' }, ''],
      c.lignes_import.map((l) => `<tr><td>${l.import_id} · ${l.numero_ligne}</td><td>${asinLien(l.asin)}</td><td class="mono">${esc(l.lien_original || '')}</td>
        <td class="num">${l.quantite}</td><td class="num">${montant(l.total_commande_declare)}</td><td><button class="petit" data-detacher="${l.id}">Détacher</button></td></tr>`))}` : ''}
  `;

  zone.querySelector('#modifier').onclick = () => modifierCommande(c, fournisseurs);
  zone.querySelector('#supprimer').onclick = async () => {
    const ok = await modale({ titre: 'Supprimer la commande ?', contenu: '<p>Les lignes Google Sheets rattachées repasseront en attente de rapprochement.</p>', libelleValider: 'Supprimer', valider: () => suppr(`/api/commandes/${c.id}`) });
    if (ok) location.hash = '#/commandes';
  };
  zone.querySelectorAll('[data-composition]').forEach((b) => {
    b.onclick = async () => {
      const x = JSON.parse(b.dataset.composition);
      if (await tenter(() => put(`/api/commandes/${c.id}`, { total_inclut_taxes: x.t, total_inclut_livraison: x.l }), 'Composition enregistrée.')) rafraichir();
    };
  });
  zone.querySelectorAll('[data-ligne]').forEach((b) => {
    b.onclick = async () => {
      const l = c.lignes.find((x) => x.id === Number(b.dataset.ligne));
      const r = await modale({
        titre: `Ligne ${l.asin}`,
        contenu: `<div class="champs">${champ('quantite', 'Quantité', { valeur: l.quantite })}${champ('cout_unitaire_ht', 'Coût unitaire HT indiqué par la commande', { valeur: l.cout_unitaire_ht ?? '' })}</div>
          <p class="aide">Si ce coût diffère du coût retenu pour l’ASIN, l’écart sera signalé ; le coût retenu n’est pas modifié automatiquement.</p>`,
        valider: (d) => put(`/api/commande-lignes/${l.id}`, d),
      });
      if (r) {
        if (r.ecart) toast(`Écart de ${montant(r.ecart)} avec le coût retenu : à arbitrer dans la fiche ASIN.`);
        rafraichir();
      }
    };
  });
  zone.querySelectorAll('[data-suppr-ligne]').forEach((b) => (b.onclick = async () => (await tenter(() => suppr(`/api/commande-lignes/${b.dataset.supprLigne}`))) !== undefined && rafraichir()));
  zone.querySelectorAll('[data-suppr-facture]').forEach((b) => (b.onclick = async () => (await tenter(() => suppr(`/api/factures/${b.dataset.supprFacture}`))) !== undefined && rafraichir()));
  zone.querySelectorAll('[data-suppr-reception]').forEach((b) => (b.onclick = async () => (await tenter(() => suppr(`/api/receptions/${b.dataset.supprReception}`))) !== undefined && rafraichir()));
  zone.querySelectorAll('[data-suppr-depense]').forEach((b) => (b.onclick = async () => (await tenter(() => suppr(`/api/depenses/${b.dataset.supprDepense}`))) !== undefined && rafraichir()));
  zone.querySelectorAll('[data-detacher]').forEach((b) => (b.onclick = async () => (await tenter(() => post(`/api/lignes-import/${b.dataset.detacher}/detacher`))) !== undefined && rafraichir()));

  zone.querySelector('#ajout-ligne').onclick = async () => {
    const ok = await modale({
      titre: 'Ajouter une ligne',
      contenu: `<div class="champs">${champ('asin', 'ASIN')}${champ('quantite', 'Quantité')}${champ('cout_unitaire_ht', 'Coût unitaire HT (facultatif)')}</div>`,
      valider: (d) => post(`/api/commandes/${c.id}/lignes`, d),
    });
    if (ok) rafraichir();
  };
  zone.querySelector('#ajout-facture').onclick = () => saisirFacture(c);
  zone.querySelector('#ajout-reception').onclick = async () => {
    const parAsin = {};
    for (const l of c.lignes) parAsin[l.asin] = (parAsin[l.asin] || 0) + l.quantite;
    const asins = Object.keys(parAsin);
    const ok = await modale({
      titre: 'Réception',
      contenu: `<div class="champs">${champ('date_reception', 'Date', { type: 'date', valeur: new Date().toISOString().slice(0, 10) })}${champ('notes', 'Notes')}</div>
        <h3>Quantités reçues</h3><div class="champs">${asins.map((a, i) => champ(`q_${i}`, `${a} (commandé : ${parAsin[a]})`, { valeur: parAsin[a] })).join('')}</div>`,
      valider: (d) => post(`/api/commandes/${c.id}/receptions`, { date_reception: d.date_reception, notes: d.notes, lignes: asins.map((a, i) => ({ asin: a, quantite: d[`q_${i}`] || 0 })) }),
    });
    if (ok) rafraichir();
  };
  zone.querySelector('#ajout-depense').onclick = async () => {
    const ok = await modale({
      titre: 'Dépense de la commande',
      contenu: `<div class="champs">${selecteur('type', 'Type', Object.entries(refs.types_depense))}${champ('montant', 'Montant')}${champ('date_depense', 'Date', { type: 'date' })}${champ('description', 'Description')}</div>`,
      valider: (d) => post('/api/depenses', { ...d, commande_id: c.id }),
    });
    if (ok) rafraichir();
  };
}

async function modifierCommande(c, fournisseurs) {
  const ok = await modale({
    titre: 'Modifier la commande',
    contenu: `<div class="champs">
      ${champ('numero_commande', 'N° de commande', { valeur: c.numero_commande || '' })}
      ${champ('date_commande', 'Date', { type: 'date', valeur: c.date_commande || '' })}
      ${selecteur('fournisseur_id', 'Fournisseur', [['', '— à préciser —'], ...fournisseurs.map((f) => [f.id, f.nom])], c.fournisseur_id || '')}
      ${champ('total_declare', 'Total déclaré', { valeur: c.total_declare ?? '' })}
      ${selecteurTriEtat('total_inclut_taxes', 'Inclut les taxes ?', c.total_inclut_taxes)}
      ${selecteurTriEtat('total_inclut_livraison', 'Inclut la livraison ?', c.total_inclut_livraison)}
      ${champ('notes', 'Notes', { valeur: c.notes || '' })}</div>`,
    valider: (d) => put(`/api/commandes/${c.id}`, d),
  });
  if (ok) rafraichir();
}

async function saisirFacture(c) {
  const ok = await modale({
    titre: `Facture de la commande ${c.numero_commande || '#' + c.id}`,
    contenu: `<div class="champs">
      ${champ('numero_facture', 'N° de facture')}${champ('date_facture', 'Date', { type: 'date' })}
      ${champ('sous_total_ht', 'Sous-total HT (marchandises)')}${champ('taxes', 'Taxes')}${champ('livraison', 'Livraison')}
      ${champ('autres_frais', 'Autres frais')}${champ('total', 'Total facturé (si différent de la somme)')}</div>
      <h3>Prix unitaires HT (facultatif)</h3>
      <p class="aide">Ils alimentent l’historique des coûts d’achat ; un écart avec le coût retenu sera signalé sans l’écraser.</p>
      ${lignesSaisie(c.lignes.map((l) => ({ asin: l.asin, quantite: l.quantite })))}`,
    apresOuverture: (f) => brancherLignesSaisie(f),
    valider: (d) => post('/api/factures', { ...d, commande_id: c.id, lignes: lireLignesSaisie(d, 'prix_unitaire_ht').filter((l) => l.prix_unitaire_ht !== '') }),
  });
  if (ok) rafraichir();
}

export { lignesSaisie, brancherLignesSaisie, lireLignesSaisie };
