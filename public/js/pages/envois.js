import { api, post, put, suppr, esc, montant, date, badge, tableau, modale, champ, selecteur, tenter, references } from '../outils.js';
import { rafraichir } from '../app.js';
import { lignesSaisie, brancherLignesSaisie, lireLignesSaisie } from './commandes.js';

export async function pageEnvois(zone) {
  const [envois, refs] = await Promise.all([api('/api/envois'), references()]);
  zone.innerHTML = `
    <div class="entete"><div><h1>Envois Amazon</h1><p class="aide">Dernière étape de la chaîne : chaque ligne d’envoi peut être reliée à la commande fournisseur d’origine.</p></div>
      <button class="principal" id="nouveau">Nouvel envoi</button></div>
    ${tableau(
      ['Envoi', 'Date', 'Statut', { t: 'Unités', classe: 'num' }, 'Lignes sans commande', { t: 'Frais', classe: 'num' }],
      envois.map((e) => `<tr><td><a href="#/envois/${e.id}">${esc(e.numero_envoi || '#' + e.id)}</a></td><td>${date(e.date_envoi)}</td><td>${esc(refs.statuts_envoi[e.statut])}</td>
        <td class="num">${e.unites}</td><td>${e.lignes_sans_commande ? badge(e.lignes_sans_commande, 'alerte') : badge('0', 'ok')}</td><td class="num">${montant(e.frais)}</td></tr>`),
      'Aucun envoi.',
    )}`;
  zone.querySelector('#nouveau').onclick = async () => {
    const r = await modale({
      titre: 'Nouvel envoi Amazon',
      contenu: `<div class="champs">${champ('numero_envoi', 'N° d’envoi (FBA…)')}${champ('date_envoi', 'Date', { type: 'date' })}
        ${selecteur('statut', 'Statut', Object.entries(refs.statuts_envoi))}</div><h3>Contenu</h3>${lignesSaisie([{}], false)}
        <p class="aide">La commande d’origine de chaque ligne se choisit ensuite dans la fiche de l’envoi.</p>`,
      apresOuverture: (f) => brancherLignesSaisie(f, false),
      valider: (d) => post('/api/envois', { ...d, lignes: lireLignesSaisie(d) }),
    });
    if (r) location.hash = `#/envois/${r.id}`;
  };
}

export async function pageEnvoi(zone, id) {
  const [e, refs] = await Promise.all([api(`/api/envois/${id}`), references()]);
  zone.innerHTML = `
    <div class="entete"><div><a href="#/envois">← Envois</a><h1>Envoi ${esc(e.numero_envoi || '#' + e.id)}</h1>
      <p class="aide">${date(e.date_envoi)} · ${esc(refs.statuts_envoi[e.statut])}</p></div>
      <div class="actions"><button id="modifier">Modifier</button><button class="danger" id="supprimer">Supprimer</button></div></div>
    <h2>Contenu</h2>
    ${tableau(
      ['ASIN', 'Titre', { t: 'Qté', classe: 'num' }, 'Commande d’origine', ''],
      e.lignes.map((l) => {
        const options = [['', '— non identifiée —'], ...l.commandes_possibles.map((c) => [c.id, `${c.numero_commande || '#' + c.id} · reçues ${c.recues}/${c.commandees} · déjà envoyées ${c.envoyees}`])];
        return `<tr><td class="mono"><a href="#/produits/${l.asin}">${l.asin}</a></td><td>${esc(l.titre || '')}</td><td class="num">${l.quantite}</td>
          <td>${selecteur(`cmd-${l.id}`, '', options, l.commande_id || '', `data-ligne="${l.id}"`)}
          ${!l.commande_id && l.commandes_possibles.length === 1 ? badge('1 commande possible : à confirmer', 'info') : ''}
          ${!l.commande_id && l.commandes_possibles.length > 1 ? badge(`${l.commandes_possibles.length} commandes possibles`, 'alerte') : ''}</td>
          <td><button class="petit danger" data-suppr="${l.id}">Retirer</button></td></tr>`;
      }),
      'Aucune ligne.',
    )}
    <button id="ajout-ligne">+ Ajouter une ligne</button>
    <h2>Frais de l’envoi</h2>
    <p class="aide">Préparation et transport vers Amazon, répartis au prorata des unités de l’envoi dans le coût complet.</p>
    ${tableau(['Type', 'Description', { t: 'Montant', classe: 'num' }, ''],
      e.depenses.map((d) => `<tr><td>${esc(refs.types_depense[d.type])}</td><td>${esc(d.description || '')}</td><td class="num">${montant(d.montant)}</td>
        <td><button class="petit danger" data-suppr-dep="${d.id}">Supprimer</button></td></tr>`), 'Aucun frais enregistré.')}
    <button id="ajout-frais">+ Ajouter un frais</button>`;

  zone.querySelectorAll('select[data-ligne]').forEach((s) => {
    s.onchange = async () => {
      if ((await tenter(() => put(`/api/envoi-lignes/${s.dataset.ligne}`, { commande_id: s.value || null }), 'Ligne rattachée.')) !== undefined) rafraichir();
    };
  });
  zone.querySelectorAll('[data-suppr]').forEach((b) => (b.onclick = async () => (await tenter(() => suppr(`/api/envoi-lignes/${b.dataset.suppr}`))) !== undefined && rafraichir()));
  zone.querySelectorAll('[data-suppr-dep]').forEach((b) => (b.onclick = async () => (await tenter(() => suppr(`/api/depenses/${b.dataset.supprDep}`))) !== undefined && rafraichir()));
  zone.querySelector('#ajout-ligne').onclick = async () => {
    const ok = await modale({ titre: 'Ajouter une ligne', contenu: `<div class="champs">${champ('asin', 'ASIN')}${champ('quantite', 'Quantité')}</div>`, valider: (d) => post(`/api/envois/${e.id}/lignes`, d) });
    if (ok) rafraichir();
  };
  zone.querySelector('#ajout-frais').onclick = async () => {
    const ok = await modale({
      titre: 'Frais de l’envoi',
      contenu: `<div class="champs">${selecteur('type', 'Type', [['transport_amazon', refs.types_depense.transport_amazon], ['preparation', refs.types_depense.preparation], ['autre', refs.types_depense.autre]])}
        ${champ('montant', 'Montant')}${champ('date_depense', 'Date', { type: 'date' })}${champ('description', 'Description')}</div>`,
      valider: (d) => post('/api/depenses', { ...d, envoi_id: e.id }),
    });
    if (ok) rafraichir();
  };
  zone.querySelector('#modifier').onclick = async () => {
    const ok = await modale({
      titre: 'Modifier l’envoi',
      contenu: `<div class="champs">${champ('numero_envoi', 'N° d’envoi', { valeur: e.numero_envoi || '' })}${champ('date_envoi', 'Date', { type: 'date', valeur: e.date_envoi || '' })}
        ${selecteur('statut', 'Statut', Object.entries(refs.statuts_envoi), e.statut)}${champ('notes', 'Notes', { valeur: e.notes || '' })}</div>`,
      valider: (d) => put(`/api/envois/${e.id}`, d),
    });
    if (ok) rafraichir();
  };
  zone.querySelector('#supprimer').onclick = async () => {
    const ok = await modale({ titre: 'Supprimer l’envoi ?', contenu: '<p>Ses lignes et ses frais seront supprimés.</p>', libelleValider: 'Supprimer', valider: () => suppr(`/api/envois/${e.id}`) });
    if (ok) location.hash = '#/envois';
  };
}
