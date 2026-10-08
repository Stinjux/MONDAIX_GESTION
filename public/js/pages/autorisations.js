import { api, post, put, suppr, esc, date, badge, tableau, modale, champ, selecteur, tenter, references, asinLien } from '../outils.js';
import { rafraichir } from '../app.js';

const TONS = { a_demander: 'alerte', demande_envoyee: 'info', documents_requis: 'alerte', approuve: 'ok', refuse: 'erreur' };

export async function pageAutorisations(zone) {
  const filtre = new URLSearchParams(location.hash.split('?')[1] || '').get('filtre') || 'non_confirmes';
  const [etat, refs] = await Promise.all([api('/api/autorisations/asin'), references()]);
  const visibles = filtre === 'non_confirmes' ? etat.filter((a) => !a.confirme) : etat;
  zone.innerHTML = `
    <div class="entete"><div><h1>Autorisations de vente Amazon</h1>
      <p class="aide">ASIN → dossier → n° de cas Amazon → réponse Neo. Un statut est <strong>confirmé</strong> lorsqu’une réponse Neo validée (ou une confirmation explicite) l’appuie.</p></div>
      <button class="principal" id="nouveau">Nouveau dossier</button></div>
    <div class="onglets">${[['non_confirmes', `Sans statut confirmé (${etat.filter((a) => !a.confirme).length})`], ['tous', `Tous les ASIN (${etat.length})`]]
      .map(([f, t]) => `<a href="#/autorisations?filtre=${f}" class="${f === filtre ? 'actif' : ''}">${t}</a>`).join('')}</div>
    ${tableau(
      ['ASIN', 'Titre', 'Statut', 'N° de cas', { t: 'Réponses Neo', classe: 'num' }, 'Confirmation', ''],
      visibles.map(
        (a) => `<tr><td>${asinLien(a.asin)}</td><td>${esc(a.titre || '')}</td>
          <td>${a.dossier_id ? `<a href="#/dossiers/${a.dossier_id}">${badge(refs.statuts_dossier[a.statut], TONS[a.statut])}</a>` : badge('aucun dossier', 'alerte')}</td>
          <td class="mono">${esc(a.numero_cas || '—')}</td><td class="num">${a.reponses_neo}</td>
          <td>${a.confirme ? badge('confirmé', 'ok') : badge('non confirmé', 'alerte')}</td>
          <td>${a.dossier_id ? '' : `<button class="petit" data-creer="${a.asin}">Créer le dossier</button>`}</td></tr>`,
      ),
      'Aucun ASIN à afficher.',
    )}`;
  const creer = async (asin = '') => {
    const r = await modale({
      titre: 'Nouveau dossier d’autorisation',
      contenu: `<div class="champs">${champ('asin', 'ASIN', { valeur: asin })}${selecteur('statut', 'Statut', Object.entries(refs.statuts_dossier), 'a_demander')}
        ${champ('numero_cas', 'N° de cas Amazon')}${champ('date_demande', 'Date de la demande', { type: 'date' })}${champ('notes', 'Notes')}</div>`,
      libelleValider: 'Créer',
      valider: (d) => post('/api/dossiers', d),
    });
    if (r) location.hash = `#/dossiers/${r.id}`;
  };
  zone.querySelector('#nouveau').onclick = () => creer();
  zone.querySelectorAll('[data-creer]').forEach((b) => (b.onclick = () => creer(b.dataset.creer)));
}

export async function pageDossier(zone, id) {
  const [d, refs] = await Promise.all([api(`/api/dossiers/${id}`), references()]);
  const etapes = [
    ['ASIN', d.asin, 'ok'],
    ['Dossier', refs.statuts_dossier[d.statut], 'ok'],
    ['N° de cas Amazon', d.numero_cas || 'à renseigner', d.numero_cas ? 'ok' : 'manquant'],
    ['Réponse Neo', `${d.reponses.length} réponse(s)`, d.reponses.length ? 'ok' : 'manquant'],
    ['Statut confirmé', d.statut_confirme ? 'oui' : 'non', d.statut_confirme ? 'ok' : 'partiel'],
  ];
  zone.innerHTML = `
    <div class="entete"><div><a href="#/autorisations">← Autorisations</a><h1>Dossier #${d.id} · ${asinLien(d.asin)}</h1>
      <p class="aide">${esc(d.titre || '')} · demande du ${date(d.date_demande)}</p></div>
      <div class="actions"><button id="modifier">Modifier</button><button class="danger" id="supprimer">Supprimer</button></div></div>
    <div class="chaine">${etapes.map(([n, det, e]) => `<div class="etape ${e}"><div class="nom">${esc(n)}</div><div class="det">${esc(det)}</div></div>`).join('')}</div>
    ${d.notes ? `<div class="carte">${esc(d.notes)}</div>` : ''}
    <h2>Réponses Neo rattachées</h2>
    ${tableau(
      ['Date', 'Expéditeur', 'Sujet', 'Statut détecté', 'Rapprochement'],
      d.reponses.map((r) => `<tr><td>${date(r.date_reception)}</td><td>${esc(r.expediteur || '')}</td><td>${esc(r.sujet || '')}</td>
        <td>${r.references_extraites.statut ? esc(refs.statuts_dossier[r.references_extraites.statut]) : '—'}</td>
        <td>${badge(r.mode_rapprochement === 'auto' ? 'auto (n° de cas)' : 'validé', 'ok')}</td></tr>`),
      'Aucune réponse. Les réponses arrivent dans « Neo · réponses ».',
    )}
    ${d.emails_asin.length ? `<h2>Emails associés à l’ASIN ${esc(d.asin)}</h2>
    ${tableau(['Reçu', 'Boîte', 'Expéditeur', 'Objet'],
      d.emails_asin.map((e) => `<tr><td>${date(e.date_reception)}</td><td>${e.source === 'gmail' ? 'Gmail' : 'Neo'}</td><td>${esc(e.expediteur || '')}</td>
        <td><a href="#/emails/${e.source}?filtre=tous&email=${e.id}">${esc(e.sujet || '(sans objet)')}</a></td></tr>`))}` : ''}`;
  zone.querySelector('#modifier').onclick = async () => {
    const ok = await modale({
      titre: 'Modifier le dossier',
      contenu: `<div class="champs">${selecteur('statut', 'Statut', Object.entries(refs.statuts_dossier), d.statut)}
        ${champ('numero_cas', 'N° de cas Amazon', { valeur: d.numero_cas || '' })}${champ('date_demande', 'Date de la demande', { type: 'date', valeur: d.date_demande || '' })}
        ${champ('notes', 'Notes', { valeur: d.notes || '' })}</div>
        <label><input type="checkbox" name="statut_confirme" value="1" ${d.statut_confirme ? 'checked' : ''}> Statut final confirmé (approuvé ou refusé, réponse d’Amazon à l’appui)</label>`,
      valider: (x) => put(`/api/dossiers/${d.id}`, { ...x, statut_confirme: Boolean(x.statut_confirme) }),
    });
    if (ok) rafraichir();
  };
  zone.querySelector('#supprimer').onclick = async () => {
    const ok = await modale({ titre: 'Supprimer le dossier ?', contenu: '<p>Les réponses Neo rattachées repasseront « à rapprocher ».</p>', libelleValider: 'Supprimer', valider: () => suppr(`/api/dossiers/${d.id}`) });
    if (ok) location.hash = '#/autorisations';
  };
}
