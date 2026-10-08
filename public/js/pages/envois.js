import { api, post, put, suppr, esc, montant, date, badge, tableau, modale, champ, selecteur, tenter, toast, references, asinLien } from '../outils.js';
import { rafraichir } from '../app.js';

export async function pageEnvois(zone) {
  const [envois, refs] = await Promise.all([api('/api/envois'), references()]);
  zone.innerHTML = `
    <div class="entete"><div><h1>Envois Amazon</h1><p class="aide">Dernière étape de la chaîne. Ouvrez un envoi pour y glisser-déposer les ASIN, saisir le n° et la date d’expédition, et relier chaque ligne à sa commande fournisseur d’origine.</p></div>
      <button class="principal" id="nouveau">Nouvel envoi</button></div>
    ${tableau(
      ['N° d’expédition', 'Date d’expédition', 'Statut', { t: 'Unités', classe: 'num' }, 'Lignes sans commande', { t: 'Frais', classe: 'num' }],
      envois.map((e) => `<tr><td><a href="#/envois/${e.id}">${esc(e.numero_envoi || '#' + e.id)}</a></td><td>${date(e.date_envoi)}</td><td>${esc(refs.statuts_envoi[e.statut])}</td>
        <td class="num">${e.unites}</td><td>${e.lignes_sans_commande ? badge(e.lignes_sans_commande, 'alerte') : badge('0', 'ok')}</td><td class="num">${montant(e.frais)}</td></tr>`),
      'Aucun envoi.',
    )}`;
  zone.querySelector('#nouveau').onclick = async () => {
    const r = await modale({
      titre: 'Nouvel envoi Amazon',
      contenu: `<div class="champs">${champ('numero_envoi', 'N° d’expédition (facultatif)', { attrs: 'placeholder="ex. FBA15XXXXXXX"' })}${champ('date_envoi', 'Date d’expédition (facultatif)', { type: 'date' })}
        ${selecteur('statut', 'Statut', Object.entries(refs.statuts_envoi))}</div>
        <p class="aide">Vous glisserez ensuite les ASIN dans l’envoi. Le n° et la date d’expédition restent modifiables à tout moment.</p>`,
      libelleValider: 'Créer l’envoi',
      valider: (d) => post('/api/envois', d),
    });
    if (r) location.hash = `#/envois/${r.id}`;
  };
}

const etat = { recherche: '' };

/** Panneau « Expédition » : n° et date saisis directement sur la page. */
function carteExpedition(e, refs) {
  return `<form class="carte" id="expedition">
      <h3 style="margin-top:0">Expédition</h3>
      <div class="champs">
        ${champ('numero_envoi', 'N° d’expédition', { valeur: e.numero_envoi || '', attrs: 'placeholder="ex. FBA15XXXXXXX"' })}
        ${champ('date_envoi', 'Date d’expédition', { type: 'date', valeur: e.date_envoi || '' })}
        ${selecteur('statut', 'Statut', Object.entries(refs.statuts_envoi), e.statut)}
        ${champ('notes', 'Notes', { valeur: e.notes || '' })}
      </div>
      <div class="actions" style="margin-top:10px"><button class="principal" type="submit">Enregistrer</button>
        <span class="aide" id="expedition-etat" style="margin:0"></span></div>
    </form>`;
}

function carteAsin(p, dansEnvoi) {
  return `<li class="asin-glissable${dansEnvoi ? ' deja' : ''}" draggable="true" data-asin="${esc(p.asin)}" data-stock="${p.stock?.quantite ?? 0}">
      <span class="poignee" aria-hidden="true">⋮⋮</span>
      <span class="asin-info"><span class="mono">${esc(p.asin)}</span>${p.titre ? `<span class="aide" style="margin:0">${esc(p.titre)}</span>` : ''}</span>
      <span class="asin-stock">${p.stock?.quantite ?? 0} en stock</span>
      <button type="button" class="petit" data-ajouter-asin="${esc(p.asin)}" aria-label="Ajouter ${esc(p.asin)} à l’envoi">+</button></li>`;
}

export async function pageEnvoi(zone, id) {
  const [e, refs, produits] = await Promise.all([api(`/api/envois/${id}`), references(), api('/api/produits')]);
  const dansEnvoi = new Set(e.lignes.map((l) => l.asin));
  const q = etat.recherche.toLowerCase();
  const visibles = produits.filter((p) => !q || [p.asin, p.titre, p.sku].some((v) => String(v || '').toLowerCase().includes(q)));
  const unites = e.lignes.reduce((s, l) => s + l.quantite, 0);
  zone.innerHTML = `
    <div class="entete"><div><a href="#/envois">← Envois</a><h1>Envoi ${esc(e.numero_envoi || '#' + e.id)}</h1>
      <p class="aide">${e.date_envoi ? `Expédié le ${date(e.date_envoi)}` : 'Date d’expédition à saisir'} · ${esc(refs.statuts_envoi[e.statut])} · ${unites} unité(s)</p></div>
      <div class="actions"><button class="danger" id="supprimer">Supprimer l’envoi</button></div></div>

    ${carteExpedition(e, refs)}

    <div class="envoi-composition">
      <section class="carte zone-depot" id="zone-depot" aria-label="Contenu de l’envoi">
        <h3 style="margin-top:0">Contenu de l’envoi</h3>
        <p class="aide">Glissez les ASIN de la liste de droite ici (ou cliquez sur « + »). Les quantités se modifient directement dans le tableau.</p>
        ${tableau(
          ['ASIN', 'Titre', { t: 'Qté', classe: 'num' }, 'Commande d’origine', ''],
          e.lignes.map((l) => {
            const options = [['', '— non identifiée —'], ...l.commandes_possibles.map((c) => [c.id, `${c.numero_commande || '#' + c.id} · reçues ${c.recues}/${c.commandees} · déjà envoyées ${c.envoyees}`])];
            return `<tr data-ligne-asin="${esc(l.asin)}"><td>${asinLien(l.asin)}</td><td>${esc(l.titre || '')}</td>
              <td class="num"><input type="number" min="1" step="1" value="${l.quantite}" data-qte="${l.id}" style="width:80px" aria-label="Quantité ${esc(l.asin)}"></td>
              <td>${selecteur(`cmd-${l.id}`, '', options, l.commande_id || '', `data-ligne="${l.id}"`)}
              ${!l.commande_id && l.commandes_possibles.length === 1 ? badge('1 commande possible : à confirmer', 'info') : ''}
              ${!l.commande_id && l.commandes_possibles.length > 1 ? badge(`${l.commandes_possibles.length} commandes possibles`, 'alerte') : ''}</td>
              <td><button class="petit danger" data-suppr="${l.id}">Retirer</button></td></tr>`;
          }),
          'Envoi vide : déposez des ASIN ici.',
        )}
        <div class="depot-indice" aria-hidden="true">Déposez l’ASIN ici</div>
      </section>
      <aside class="carte palette-asins" aria-label="ASIN disponibles">
        <h3 style="margin-top:0">ASIN</h3>
        <input id="recherche-asin-envoi" value="${esc(etat.recherche)}" placeholder="Rechercher (ASIN, titre, SKU)" aria-label="Rechercher un ASIN">
        <ul class="liste-asins">${visibles.map((p) => carteAsin(p, dansEnvoi.has(p.asin))).join('') || '<li class="aide">Aucun ASIN.</li>'}</ul>
      </aside>
    </div>

    <h2>Frais de l’envoi</h2>
    <p class="aide">Préparation et transport vers Amazon, répartis au prorata des unités de l’envoi dans le coût complet.</p>
    ${tableau(['Type', 'Description', { t: 'Montant', classe: 'num' }, ''],
      e.depenses.map((d) => `<tr><td>${esc(refs.types_depense[d.type])}</td><td>${esc(d.description || '')}</td><td class="num">${montant(d.montant)}</td>
        <td><button class="petit danger" data-suppr-dep="${d.id}">Supprimer</button></td></tr>`), 'Aucun frais enregistré.')}
    <button id="ajout-frais">+ Ajouter un frais</button>`;

  // Expédition : n°, date, statut. Une date saisie sur un envoi « en préparation » le passe à « expédié ».
  const form = zone.querySelector('#expedition');
  form.querySelector('[name=date_envoi]').onchange = (ev) => {
    const statut = form.querySelector('[name=statut]');
    if (ev.target.value && statut.value === 'en_preparation') {
      statut.value = 'expedie';
      form.querySelector('#expedition-etat').textContent = 'Statut passé à « Expédié » (modifiable avant d’enregistrer).';
    }
  };
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(form).entries());
    if ((await tenter(() => put(`/api/envois/${e.id}`, d), 'Expédition enregistrée.')) !== undefined) rafraichir();
  };

  // Glisser-déposer des ASIN dans l'envoi
  const depot = zone.querySelector('#zone-depot');
  const ajouter = async (asin, stock) => {
    if (dansEnvoi.has(asin)) {
      const champQte = zone.querySelector(`tr[data-ligne-asin="${CSS.escape(asin)}"] [data-qte]`);
      toast(`${asin} est déjà dans l’envoi : modifiez sa quantité.`);
      champQte?.focus();
      champQte?.select();
      return;
    }
    const ok = await modale({
      titre: `Ajouter ${asin} à l’envoi`,
      contenu: `<div class="champs">${champ('quantite', 'Quantité envoyée', { type: 'number', valeur: stock > 0 ? stock : 1, attrs: 'min="1" step="1" required' })}</div>
        <p class="aide">Proposé : le stock du dernier import d’inventaire (${stock} unité(s)).</p>`,
      libelleValider: 'Ajouter',
      apresOuverture: (f) => f.querySelector('[name=quantite]').select(),
      valider: (d) => post(`/api/envois/${e.id}/lignes`, { asin, quantite: d.quantite }),
    });
    if (ok) rafraichir();
  };
  zone.querySelectorAll('.asin-glissable').forEach((li) => {
    li.ondragstart = (ev) => {
      ev.dataTransfer.setData('text/plain', li.dataset.asin);
      ev.dataTransfer.effectAllowed = 'copy';
      li.classList.add('en-glisse');
      depot.classList.add('attente');
    };
    li.ondragend = () => {
      li.classList.remove('en-glisse');
      depot.classList.remove('attente', 'survol');
    };
  });
  depot.ondragover = (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    depot.classList.add('survol');
  };
  depot.ondragleave = (ev) => {
    if (!depot.contains(ev.relatedTarget)) depot.classList.remove('survol');
  };
  depot.ondrop = (ev) => {
    ev.preventDefault();
    depot.classList.remove('attente', 'survol');
    const asin = ev.dataTransfer.getData('text/plain');
    const li = zone.querySelector(`.asin-glissable[data-asin="${CSS.escape(asin)}"]`);
    if (li) ajouter(asin, Number(li.dataset.stock));
  };
  zone.querySelectorAll('[data-ajouter-asin]').forEach((b) => {
    b.onclick = () => ajouter(b.dataset.ajouterAsin, Number(b.closest('li').dataset.stock));
  });
  zone.querySelector('#recherche-asin-envoi').oninput = (ev) => {
    etat.recherche = ev.target.value;
    const t = etat.recherche.toLowerCase();
    zone.querySelectorAll('.asin-glissable').forEach((li) => {
      const p = produits.find((x) => x.asin === li.dataset.asin);
      li.hidden = Boolean(t) && ![p.asin, p.titre, p.sku].some((v) => String(v || '').toLowerCase().includes(t));
    });
  };

  zone.querySelectorAll('[data-qte]').forEach((input) => {
    input.onchange = async () => {
      if ((await tenter(() => put(`/api/envoi-lignes/${input.dataset.qte}`, { quantite: input.value }), 'Quantité mise à jour.')) !== undefined) rafraichir();
    };
  });
  zone.querySelectorAll('select[data-ligne]').forEach((s) => {
    s.onchange = async () => {
      if ((await tenter(() => put(`/api/envoi-lignes/${s.dataset.ligne}`, { commande_id: s.value || null }), 'Ligne rattachée.')) !== undefined) rafraichir();
    };
  });
  zone.querySelectorAll('[data-suppr]').forEach((b) => (b.onclick = async () => (await tenter(() => suppr(`/api/envoi-lignes/${b.dataset.suppr}`))) !== undefined && rafraichir()));
  zone.querySelectorAll('[data-suppr-dep]').forEach((b) => (b.onclick = async () => (await tenter(() => suppr(`/api/depenses/${b.dataset.supprDep}`))) !== undefined && rafraichir()));
  zone.querySelector('#ajout-frais').onclick = async () => {
    const ok = await modale({
      titre: 'Frais de l’envoi',
      contenu: `<div class="champs">${selecteur('type', 'Type', [['transport_amazon', refs.types_depense.transport_amazon], ['preparation', refs.types_depense.preparation], ['autre', refs.types_depense.autre]])}
        ${champ('montant', 'Montant')}${champ('date_depense', 'Date', { type: 'date' })}${champ('description', 'Description')}</div>`,
      valider: (d) => post('/api/depenses', { ...d, envoi_id: e.id }),
    });
    if (ok) rafraichir();
  };
  zone.querySelector('#supprimer').onclick = async () => {
    const ok = await modale({ titre: 'Supprimer l’envoi ?', contenu: '<p>Ses lignes et ses frais seront supprimés.</p>', libelleValider: 'Supprimer', valider: () => suppr(`/api/envois/${e.id}`) });
    if (ok) location.hash = '#/envois';
  };
}
