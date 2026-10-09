import { api, post, put, suppr, confirmer, esc, montant, date, badge, tableau, modale, champ, selecteur, tenter, toast, references, asinLien, entetePage, icone } from '../outils.js';
import { rafraichir } from '../app.js';

export const TONS_SUIVI = { en_preparation: '', en_transit: 'info', partiel: 'alerte', recu: 'ok', ecart: 'erreur' };

export function badgeSuivi(suivi, refs) {
  const ecart = suivi.etat === 'ecart' ? ` (${suivi.ecart > 0 ? '+' : '−'}${Math.abs(suivi.ecart)})` : '';
  return badge(refs.etats_suivi[suivi.etat] + ecart, TONS_SUIVI[suivi.etat]);
}

/* ------------------------------------------------------------------ liste */

export async function pageEnvois(zone) {
  const [envois, refs] = await Promise.all([api('/api/envois'), references()]);
  const filtre = new URLSearchParams(location.hash.split('?')[1] || '').get('filtre') || '';
  const filtres = {
    '': ['Tous', () => true],
    a_verifier: ['À vérifier (en transit)', (e) => ['en_transit', 'partiel'].includes(e.suivi.etat)],
    ecart: ['Écarts', (e) => e.suivi.etat === 'ecart'],
    recu: ['Bien reçus', (e) => e.suivi.etat === 'recu'],
    en_preparation: ['En préparation', (e) => e.suivi.etat === 'en_preparation'],
  };
  const visibles = envois.filter((filtres[filtre] || filtres[''])[1]);
  zone.innerHTML = `
    ${entetePage({
      titre: 'Envois Amazon',
      sousTitre: 'Créez l’envoi, glissez-y les ASIN avec les quantités envoyées, saisissez le n° et la date d’expédition. À la réception par Amazon, saisissez les quantités reçues pour vérifier qu’il ne manque rien.',
      actions: `<button type="button" class="principal" id="nouveau">${icone('plus')}Nouvel envoi</button>`,
    })}
    <div class="onglets">${Object.entries(filtres)
      .map(([f, [t, fn]]) => `<a href="#/envois${f ? '?filtre=' + f : ''}" class="${f === filtre ? 'actif' : ''}">${t} (${envois.filter(fn).length})</a>`).join('')}</div>
    ${tableau(
      ['N° d’expédition', 'Date d’expédition', 'Statut', { t: 'Envoyé', classe: 'num' }, { t: 'Reçu par Amazon', classe: 'num' }, 'Suivi', { t: 'Frais', classe: 'num' }],
      visibles.map((e) => `<tr data-id="${e.id}"><td><a href="#/envois/${e.id}"><strong>${esc(e.numero_envoi || '#' + e.id)}</strong></a></td><td>${date(e.date_envoi)}</td><td>${esc(refs.statuts_envoi[e.statut])}</td>
        <td class="num">${e.suivi.unites_envoyees}</td>
        <td class="num">${e.suivi.lignes_a_verifier === e.nb_lignes ? '—' : e.suivi.unites_recues}${e.date_reception ? `<span class="aide sous">le ${date(e.date_reception)}</span>` : ''}</td>
        <td>${badgeSuivi(e.suivi, refs)}</td><td class="num">${montant(e.frais)}</td></tr>`),
      filtre ? 'Aucun envoi dans cette catégorie.' : 'Aucun envoi : créez votre premier envoi Amazon.',
      {
        videAction: filtre ? { libelle: 'Voir tous les envois', href: '#/envois' } : null,
        selection: [{ libelle: 'Supprimer', icone: 'trash-2', action: (ids) => supprimerEnvois(envois.filter((e) => ids.includes(String(e.id)))) }],
      },
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

async function supprimerEnvois(liste, { apres = rafraichir } = {}) {
  if (!liste.length) return;
  const ok = await confirmer({
    titre: liste.length === 1 ? `Supprimer l’envoi ${liste[0].numero_envoi || '#' + liste[0].id} ?` : `Supprimer ${liste.length} envois ?`,
    message: 'Les lignes et les frais de l’envoi seront supprimés définitivement.',
    libelle: 'Supprimer',
  });
  if (!ok) return;
  for (const e of liste) if ((await tenter(() => suppr(`/api/envois/${e.id}`))) === undefined) return rafraichir();
  apres();
}

/* ------------------------------------------------------------------ fiche d'un envoi */

const etat = { recherche: '' };

/** Panneau « Expédition » : n° et date saisis directement sur la page. */
function carteExpedition(e, refs) {
  return `<form class="carte" id="expedition">
      <h3 class="sans-marge">Expédition</h3>
      <div class="champs">
        ${champ('numero_envoi', 'N° d’expédition', { valeur: e.numero_envoi || '', attrs: 'placeholder="ex. FBA15XXXXXXX"' })}
        ${champ('date_envoi', 'Date d’expédition', { type: 'date', valeur: e.date_envoi || '' })}
        ${selecteur('statut', 'Statut', Object.entries(refs.statuts_envoi), e.statut)}
        ${champ('notes', 'Notes', { valeur: e.notes || '' })}
      </div>
      <div class="actions"><button class="principal" type="submit">${icone('check')}Enregistrer</button>
        <span class="aide sous" id="expedition-etat" aria-live="polite"></span></div>
    </form>`;
}

function carteAsin(p, dansEnvoi, i, total) {
  return `<li class="asin-glissable${dansEnvoi ? ' deja' : ''}" draggable="true" tabindex="${i === 0 ? 0 : -1}" data-asin="${esc(p.asin)}" data-stock="${p.stock?.quantite ?? 0}"
      aria-roledescription="élément déplaçable" aria-describedby="aide-glisser" aria-setsize="${total}" aria-posinset="${i + 1}"
      aria-label="${esc(p.asin)}${p.titre ? ' — ' + esc(p.titre) : ''}, ${p.stock?.quantite ?? 0} en stock${dansEnvoi ? ', déjà dans l’envoi' : ''}">
      <span class="poignee" aria-hidden="true">${icone('grip-vertical')}</span>
      <span class="asin-info"><span class="mono">${esc(p.asin)}</span>${p.titre ? `<span class="aide">${esc(p.titre)}</span>` : ''}</span>
      <span class="asin-stock">${p.stock?.quantite ?? 0} en stock</span>
      <button type="button" class="petit icone-seule" tabindex="-1" data-ajouter-asin="${esc(p.asin)}" aria-label="Ajouter ${esc(p.asin)} à l’envoi">${icone('plus')}</button></li>`;
}

export async function pageEnvoi(zone, id) {
  const [e, refs, produits] = await Promise.all([api(`/api/envois/${id}`), references(), api('/api/produits')]);
  const dansEnvoi = new Set(e.lignes.map((l) => l.asin));
  const unites = e.lignes.reduce((s, l) => s + l.quantite, 0);
  const derniereAjoutee = sessionStorage.getItem('mondaix.ligne-ajoutee');
  sessionStorage.removeItem('mondaix.ligne-ajoutee');
  zone.innerHTML = `
    ${entetePage({
      retour: { href: '#/envois', libelle: '← Envois' },
      titre: `Envoi ${e.numero_envoi || '#' + e.id}`,
      sousTitre: `${e.date_envoi ? `Expédié le ${date(e.date_envoi)}` : 'Date d’expédition à saisir'} · ${esc(refs.statuts_envoi[e.statut])} · ${unites} unité(s) envoyée(s) · ${badgeSuivi(e.suivi, refs)}`,
      actions: `<button type="button" class="danger" id="supprimer">${icone('trash-2')}Supprimer l’envoi</button>`,
    })}

    ${carteExpedition(e, refs)}

    <div class="envoi-composition">
      <section class="carte zone-depot" id="zone-depot" tabindex="-1" aria-label="Contenu de l’envoi : zone de dépôt">
        <h3 class="sans-marge">Contenu de l’envoi</h3>
        <p class="aide">Glissez un ASIN de la liste de droite ici, ou cliquez sur « + ». Les quantités envoyées se modifient dans le tableau.</p>
        ${tableau(
          ['ASIN', 'Titre', { t: 'Envoyé', classe: 'num' }, { t: 'Reçu par Amazon', classe: 'num' }, { t: 'Écart', classe: 'num' }, { t: '', tri: false }],
          e.lignes.map((l) => {
            const ecart = l.quantite_recue === null ? null : l.quantite_recue - l.quantite;
            return `<tr data-id="${l.id}" data-ligne-asin="${esc(l.asin)}" class="${derniereAjoutee === l.asin ? 'apparition' : ''}"><td>${asinLien(l.asin)}</td><td>${esc(l.titre || '')}</td>
              <td class="num" data-tri="${l.quantite}"><input type="number" min="1" step="1" value="${l.quantite}" data-qte="${l.id}" class="champ-qte" aria-label="Quantité envoyée ${esc(l.asin)}"></td>
              <td class="num" data-tri="${l.quantite_recue ?? ''}"><input type="number" min="0" step="1" value="${l.quantite_recue ?? ''}" data-recue="${l.id}" placeholder="à saisir" class="champ-qte" aria-label="Quantité reçue par Amazon ${esc(l.asin)}"></td>
              <td class="num" data-tri="${ecart ?? ''}">${ecart === null ? '<span class="aide">—</span>' : ecart === 0 ? badge('OK', 'ok') : badge(`${ecart > 0 ? '+' : '−'}${Math.abs(ecart)}`, 'erreur')}</td>
              <td class="actions-ligne"><button type="button" class="petit icone-seule" data-suppr="${l.id}" aria-label="Retirer ${esc(l.asin)} de l’envoi" title="Retirer de l’envoi">${icone('x')}</button></td></tr>`;
          }),
          'Envoi vide : déposez des ASIN ici.',
          { selection: [{ libelle: 'Retirer de l’envoi', icone: 'x', action: (ids) => retirerLignes(e.lignes.filter((l) => ids.includes(String(l.id)))) }] },
        )}
        ${e.lignes.length ? `<div class="actions reception-amazon">
          <div><label for="date-reception">Date de réception par Amazon</label><input id="date-reception" type="date" value="${esc(e.date_reception || '')}"></div>
          <button type="button" class="principal" id="enregistrer-reception">${icone('check')}Enregistrer les quantités reçues</button>
          <button type="button" id="tout-recu">${icone('circle-check')}Tout est arrivé</button></div>
          <p class="aide">Saisissez les quantités reçues indiquées par Amazon (Seller Central → Envois). Quand toutes les lignes sont saisies, l’envoi passe à « Reçu par Amazon » ; un écart est signalé ici et dans le tableau de bord.</p>` : ''}
        <div class="depot-indice" aria-hidden="true">${icone('plus')} Déposez l’ASIN ici</div>
      </section>
      <aside class="carte palette-asins" aria-label="ASIN disponibles">
        <h3 class="sans-marge">ASIN</h3>
        <input id="recherche-asin-envoi" type="search" value="${esc(etat.recherche)}" placeholder="Rechercher (ASIN, titre, SKU)" aria-label="Rechercher un ASIN">
        <p class="sr" id="aide-glisser">Espace ou Entrée pour prendre l’ASIN, puis Espace ou Entrée pour le déposer dans l’envoi. Flèches haut et bas pour changer d’ASIN, Échap pour annuler.</p>
        <ul class="liste-asins" role="list">${produits.map((p, i) => carteAsin(p, dansEnvoi.has(p.asin), i, produits.length)).join('') || '<li class="aide">Aucun ASIN : déposez d’abord une facture.</li>'}</ul>
      </aside>
    </div>
    <div class="sr" aria-live="assertive" id="annonce-glisser"></div>

    <div class="section-titre"><h2>Frais de l’envoi</h2><button type="button" id="ajout-frais">${icone('plus')}Ajouter un frais</button></div>
    <p class="aide">Préparation et transport vers Amazon, répartis au prorata des unités de l’envoi dans le coût complet.</p>
    ${tableau(['Type', 'Description', { t: 'Montant', classe: 'num' }, { t: '', tri: false }],
      e.depenses.map((d) => `<tr><td>${esc(refs.types_depense[d.type])}</td><td>${esc(d.description || '')}</td><td class="num">${montant(d.montant)}</td>
        <td class="actions-ligne"><button type="button" class="petit danger" data-suppr-dep="${d.id}">${icone('trash-2')}Supprimer</button></td></tr>`), 'Aucun frais enregistré.')}`;

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

  /* -------------------------------------------------------------- glisser-déposer */
  const depot = zone.querySelector('#zone-depot');
  const annonce = zone.querySelector('#annonce-glisser');
  const items = () => [...zone.querySelectorAll('.asin-glissable:not([hidden])')];
  let pris = null; // ASIN pris au clavier

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
    if (!ok) return;
    sessionStorage.setItem('mondaix.ligne-ajoutee', asin);
    annonce.textContent = `${asin} ajouté à l’envoi.`;
    toast(`${asin} ajouté à l’envoi.`, {
      action: {
        libelle: 'Annuler',
        fn: async () => {
          const frais = await api(`/api/envois/${e.id}`);
          const ligne = frais.lignes.find((l) => l.asin === asin);
          if (ligne && (await tenter(() => suppr(`/api/envoi-lignes/${ligne.id}`), `${asin} retiré de l’envoi.`)) !== undefined) rafraichir();
        },
      },
    });
    await rafraichir();
  };

  const finGlisse = () => {
    zone.querySelectorAll('.en-glisse').forEach((x) => x.classList.remove('en-glisse'));
    zone.querySelectorAll('.asin-glissable[aria-pressed]').forEach((x) => x.removeAttribute('aria-pressed'));
    depot.classList.remove('attente', 'survol');
    document.querySelector('.apercu-glisse')?.remove();
  };

  zone.querySelectorAll('.asin-glissable').forEach((li) => {
    li.ondragstart = (ev) => {
      ev.dataTransfer.setData('text/plain', li.dataset.asin);
      ev.dataTransfer.effectAllowed = 'copy';
      // Aperçu qui suit le curseur
      const apercu = document.createElement('div');
      apercu.className = 'apercu-glisse';
      apercu.innerHTML = `${icone('grip-vertical')}<span class="mono">${esc(li.dataset.asin)}</span>`;
      document.body.append(apercu);
      ev.dataTransfer.setDragImage(apercu, 16, 16);
      requestAnimationFrame(() => {
        li.classList.add('en-glisse');
        depot.classList.add('attente');
      });
    };
    li.ondragend = finGlisse;
    li.onkeydown = (ev) => {
      const liste = items();
      const i = liste.indexOf(li);
      const aller = (j) => {
        const cible = liste[Math.max(0, Math.min(liste.length - 1, j))];
        liste.forEach((x) => (x.tabIndex = -1));
        cible.tabIndex = 0;
        cible.focus();
        annonce.textContent = `${cible.dataset.asin}, ${liste.indexOf(cible) + 1} sur ${liste.length}${pris ? `. ${pris} est pris : Espace pour le déposer ici dans l’envoi.` : ''}`;
      };
      if (ev.key === 'ArrowDown') { ev.preventDefault(); aller(i + 1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); aller(i - 1); }
      else if (ev.key === 'Home') { ev.preventDefault(); aller(0); }
      else if (ev.key === 'End') { ev.preventDefault(); aller(liste.length - 1); }
      else if (ev.key === ' ' || ev.key === 'Enter') {
        ev.preventDefault();
        pris = li.dataset.asin;
        li.classList.add('en-glisse');
        li.setAttribute('aria-pressed', 'true');
        depot.classList.add('attente', 'survol');
        depot.tabIndex = 0;
        depot.focus();
        annonce.textContent = `${pris} pris. Espace ou Entrée pour le déposer dans le contenu de l’envoi, Échap pour annuler.`;
      }
    };
  });
  depot.onkeydown = (ev) => {
    if (!pris) return;
    if (ev.key === ' ' || ev.key === 'Enter') {
      ev.preventDefault();
      const li = zone.querySelector(`.asin-glissable[data-asin="${CSS.escape(pris)}"]`);
      const asin = pris;
      pris = null;
      finGlisse();
      ajouter(asin, Number(li?.dataset.stock || 0));
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      const li = zone.querySelector(`.asin-glissable[data-asin="${CSS.escape(pris)}"]`);
      annonce.textContent = `Déplacement de ${pris} annulé.`;
      pris = null;
      finGlisse();
      li?.removeAttribute('aria-pressed');
      li?.focus();
    }
  };
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
    const asin = ev.dataTransfer.getData('text/plain');
    finGlisse();
    const li = zone.querySelector(`.asin-glissable[data-asin="${CSS.escape(asin)}"]`);
    if (li) ajouter(asin, Number(li.dataset.stock));
  };
  zone.querySelectorAll('[data-ajouter-asin]').forEach((b) => {
    b.onclick = () => ajouter(b.dataset.ajouterAsin, Number(b.closest('li').dataset.stock));
  });
  const filtrerPalette = () => {
    const t = etat.recherche.toLowerCase();
    zone.querySelectorAll('.asin-glissable').forEach((li) => {
      const p = produits.find((x) => x.asin === li.dataset.asin);
      li.hidden = Boolean(t) && ![p.asin, p.titre, p.sku].some((v) => String(v || '').toLowerCase().includes(t));
    });
    const premiers = items();
    zone.querySelectorAll('.asin-glissable').forEach((li) => (li.tabIndex = -1));
    if (premiers[0]) premiers[0].tabIndex = 0;
  };
  zone.querySelector('#recherche-asin-envoi').oninput = (ev) => {
    etat.recherche = ev.target.value;
    filtrerPalette();
  };
  if (etat.recherche) filtrerPalette();

  /* -------------------------------------------------------------- lignes et réception */
  zone.querySelectorAll('[data-qte]').forEach((input) => {
    input.onchange = async () => {
      if ((await tenter(() => put(`/api/envoi-lignes/${input.dataset.qte}`, { quantite: input.value }), 'Quantité mise à jour.')) !== undefined) rafraichir();
    };
  });
  const lireReception = () => ({
    date_reception: zone.querySelector('#date-reception')?.value || undefined,
    lignes: [...zone.querySelectorAll('[data-recue]')].map((i) => ({ id: Number(i.dataset.recue), quantite_recue: i.value })),
  });
  zone.querySelector('#enregistrer-reception')?.addEventListener('click', async () => {
    const r = await tenter(() => post(`/api/envois/${e.id}/reception`, lireReception()), 'Réception enregistrée.');
    if (r) rafraichir();
  });
  zone.querySelector('#tout-recu')?.addEventListener('click', async () => {
    if (!(await confirmer({ titre: 'Tout est arrivé ?', message: 'Amazon a reçu toutes les unités envoyées : les quantités reçues seront égales aux quantités envoyées.', libelle: 'Confirmer la réception', danger: false }))) return;
    const r = await tenter(() => post(`/api/envois/${e.id}/tout-recu`, { date_reception: zone.querySelector('#date-reception')?.value || undefined }), 'Envoi reçu en entier par Amazon.');
    if (r) rafraichir();
  });

  async function retirerLignes(lignes) {
    if (!lignes.length) return;
    const ok = await confirmer({
      titre: lignes.length === 1 ? `Retirer ${lignes[0].asin} de l’envoi ?` : `Retirer ${lignes.length} ASIN de l’envoi ?`,
      message: 'Les lignes sont retirées de l’envoi (quantités envoyées et reçues).',
      libelle: 'Retirer',
    });
    if (!ok) return;
    for (const l of lignes) if ((await tenter(() => suppr(`/api/envoi-lignes/${l.id}`))) === undefined) break;
    rafraichir();
  }
  zone.querySelectorAll('[data-suppr]').forEach((b) => (b.onclick = () => retirerLignes(e.lignes.filter((l) => String(l.id) === b.dataset.suppr))));
  zone.querySelectorAll('[data-suppr-dep]').forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmer({ titre: 'Supprimer ce frais ?', message: 'Le frais ne comptera plus dans le coût complet des ASIN de l’envoi.', libelle: 'Supprimer' }))) return;
      if ((await tenter(() => suppr(`/api/depenses/${b.dataset.supprDep}`))) !== undefined) rafraichir();
    };
  });
  zone.querySelector('#ajout-frais').onclick = async () => {
    const ok = await modale({
      titre: 'Frais de l’envoi',
      contenu: `<div class="champs">${selecteur('type', 'Type', [['transport_amazon', refs.types_depense.transport_amazon], ['preparation', refs.types_depense.preparation], ['autre', refs.types_depense.autre]])}
        ${champ('montant', 'Montant')}${champ('date_depense', 'Date', { type: 'date' })}${champ('description', 'Description')}</div>`,
      valider: (d) => post('/api/depenses', { ...d, envoi_id: e.id }),
    });
    if (ok) rafraichir();
  };
  zone.querySelector('#supprimer').onclick = () => supprimerEnvois([e], { apres: () => (location.hash = '#/envois') });
}
