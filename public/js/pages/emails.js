import { api, post, suppr, esc, montant, date, badge, tableau, modale, champ, selecteur, tenter, toast, references, lireFichierTexte, asinLien } from '../outils.js';
import { rafraichir } from '../app.js';
import { synchroniser } from './divers.js';

export async function pageEmails(zone, source) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const filtre = params.get('filtre') || 'a_traiter';
  const emailAOuvrir = Number(params.get('email')) || null;
  const [emails, sources, refs] = await Promise.all([api(`/api/emails?source=${source}&statut=${filtre === 'tous' ? '' : filtre}`), api('/api/emails/sources'), references()]);
  const src = sources.find((s) => s.source === source);
  const estGmail = source === 'gmail';
  zone.innerHTML = `
    <div class="entete"><div><h1>${esc(src.libelle)} · ${estGmail ? 'confirmations fournisseurs' : 'réponses d’autorisation'}</h1>
      <p class="aide">${esc(src.role)}. Chaque email s’associe directement à un ou plusieurs <strong>ASIN</strong>.
      ${src.synchro.configuree
        ? `Connexion IMAP configurée · objet contenant ${src.synchro.mots_cles_objet.map((m) => `« ${esc(m)} »`).join(' ou ')}${src.synchro.expediteurs.length ? ` · expéditeurs ${esc(src.synchro.expediteurs.join(', '))}` : ''} · depuis le ${date(src.synchro.date_depart)}${src.synchro.derniere_synchro ? ` · dernière synchronisation ${new Date(src.synchro.derniere_synchro).toLocaleString('fr-CA')}` : ''}.`
        : 'Aucune connexion active : importez les emails (.eml), collez-les ou saisissez-les.'}</p>
      ${src.synchro.derniere_erreur ? `<div class="message erreur">${esc(src.synchro.derniere_erreur)}</div>` : ''}</div>
      <div class="actions">${src.synchro.configuree ? `<button class="principal" id="synchroniser">Synchroniser</button>` : ''}<button id="importer-eml">Importer des .eml</button><button id="saisir">Saisir / coller un email</button>
      </div></div>
    <input type="file" id="fichiers-eml" accept=".eml,message/rfc822" multiple hidden>
    <div class="onglets">${[['a_traiter', `ASIN à associer (${src.a_traiter})`], ['valide', 'Associés'], ['ignore', 'Ignorés'], ['tous', 'Tous']]
      .map(([f, t]) => `<a href="#/emails/${source}?filtre=${f}" class="${f === filtre ? 'actif' : ''}">${t}</a>`).join('')}</div>
    ${tableau(
      ['Reçu', 'Expéditeur', 'Sujet', 'Références détectées', 'ASIN associés', 'État', ''],
      emails.map((e) => ligne(e, estGmail, refs)),
      'Aucun email.',
    )}`;

  zone.querySelector('#synchroniser')?.addEventListener('click', (ev) => synchroniser(ev.currentTarget, source));
  zone.querySelector('#importer-eml').onclick = () => zone.querySelector('#fichiers-eml').click();
  zone.querySelector('#fichiers-eml').onchange = async (ev) => {
    const fichiers = await Promise.all([...ev.target.files].map(lireFichierTexte));
    const r = await tenter(() => post(`/api/emails/${source}/eml`, { fichiers }));
    if (r) {
      toast(`${r.filter((x) => !x.doublon).length} email(s) importé(s), ${r.filter((x) => x.doublon).length} déjà présent(s).`);
      rafraichir();
    }
  };
  zone.querySelector('#saisir').onclick = async () => {
    const ok = await modale({
      titre: `Ajouter un email ${src.libelle}`,
      contenu: `<p class="aide">Collez l’email complet (source .eml) <em>ou</em> remplissez les champs.</p>
        <label>Source complète (facultatif)</label><textarea name="brut"></textarea>
        <div class="champs">${champ('expediteur', 'Expéditeur')}${champ('sujet', 'Sujet')}${champ('date', 'Date de réception', { type: 'date' })}</div>
        <label>Corps du message</label><textarea name="corps"></textarea>`,
      valider: (d) => (d.brut.trim() ? post(`/api/emails/${source}/eml`, { texte: d.brut }) : post(`/api/emails/${source}/manuel`, d)),
    });
    if (ok) rafraichir();
  };
  zone.querySelectorAll('[data-detail]').forEach((b) => (b.onclick = () => detail(Number(b.dataset.detail))));
  zone.querySelectorAll('[data-lier]').forEach((b) => {
    b.onclick = async () => {
      const corps = JSON.parse(b.dataset.lier);
      if (await tenter(() => post(`/api/emails/${b.dataset.email}/liens`, corps), 'Lien ajouté.')) rafraichir();
    };
  });
  zone.querySelectorAll('[data-delier]').forEach((b) => {
    b.onclick = async () => {
      if ((await tenter(() => suppr(`/api/email-liens/${b.dataset.delier}`), 'Lien retiré.')) !== undefined) rafraichir();
    };
  });
  zone.querySelectorAll('[data-nouveau-lien]').forEach((b) => (b.onclick = () => nouveauLien(Number(b.dataset.nouveauLien))));
  if (emailAOuvrir) detail(emailAOuvrir);
  zone.querySelectorAll('[data-statut]').forEach((b) => {
    b.onclick = async () => {
      const ok = await modale({
        titre: 'Appliquer le statut d’autorisation',
        contenu: `<p>L’autorisation de <strong>${esc(b.dataset.asins)}</strong> passera au statut <strong>${esc(refs.statuts_dossier[b.dataset.statut])}</strong>, confirmé par cette réponse d’Amazon.</p>`,
        libelleValider: 'Appliquer',
        valider: () => post(`/api/emails/${b.dataset.email}/statut`, { statut: b.dataset.statut }),
      });
      if (ok) rafraichir();
    };
  });
}

function ligne(e, estGmail, refs) {
  const r = e.references_extraites;
  const asinsLies = (e.liens || []).filter((l) => l.type === 'asin');
  const refsTxt = estGmail
    ? [r.montantTotal != null ? `total ${montant(r.montantTotal)}` : '', r.domaine || '', r.asins?.length ? r.asins.join(', ') : ''].filter(Boolean).join(' · ')
    : [r.asins?.length ? r.asins.join(', ') : '', r.statut ? `→ ${refs.statuts_dossier[r.statut]}` : ''].filter(Boolean).join(' · ');
  const appliquer =
    !estGmail && r.statut && asinsLies.length
      ? `<button class="petit" data-email="${e.id}" data-statut="${r.statut}" data-asins="${esc(asinsLies.map((l) => l.valeur).join(', '))}">Appliquer « ${esc(refs.statuts_dossier[r.statut])} » à ${asinsLies.length > 1 ? `${asinsLies.length} ASIN` : esc(asinsLies[0].valeur)}</button>`
      : '';
  const etat = e.statut_rapprochement === 'ignore' ? badge('ignoré') : asinsLies.length ? badge('associé', 'ok') : badge('ASIN à associer', 'alerte');
  return `<tr><td>${date(e.date_reception)}</td><td>${esc(e.expediteur || '')}</td><td>${esc(e.sujet || '')}</td><td>${esc(refsTxt || '—')}</td>
    <td>${celluleLiens(e)}</td>
    <td>${etat}${appliquer ? `<div class="actions" style="margin-top:4px">${appliquer}</div>` : ''}</td>
    <td><button class="petit" data-detail="${e.id}">Ouvrir</button></td></tr>`;
}

/** ASIN associés à l'email, suggestions issues des ASIN détectés et ajout manuel. */
function celluleLiens(e) {
  const r = e.references_extraites;
  const liens = (e.liens || []).filter((l) => l.type === 'asin');
  const puces = liens.map(
    (l) => `<div class="lien-email">${asinLien(l.valeur)}${l.mode === 'auto' ? ' ' + badge('auto') : ''}
      <button class="petit" data-delier="${l.id}" title="Retirer cet ASIN" aria-label="Retirer cet ASIN">×</button></div>`,
  );
  const suggestions = (r.asins || [])
    .filter((a) => !liens.some((l) => l.valeur === a))
    .map((a) => `<button class="petit" data-email="${e.id}" data-lier='${esc(JSON.stringify({ type: 'asin', valeur: a }))}' title="Associer cet ASIN">+ ${esc(a)}</button>`);
  return `${puces.join('')}<div class="actions" style="margin-top:4px">${suggestions.join('')}<button class="petit" data-nouveau-lien="${e.id}">+ ASIN</button></div>`;
}

async function nouveauLien(id) {
  const ok = await modale({
    titre: 'Associer l’email à un ASIN',
    contenu: `<div class="champs">${champ('valeur', 'ASIN', { attrs: 'required placeholder="B0…"' })}</div>`,
    libelleValider: 'Associer',
    valider: (d) => post(`/api/emails/${id}/liens`, { type: 'asin', valeur: d.valeur }),
  });
  if (ok) rafraichir();
}

async function detail(id) {
  const e = await api(`/api/emails/${id}`);
  const asinsLies = e.liens.filter((l) => l.type === 'asin');
  const action = await modale({
    titre: e.sujet || 'Email',
    contenu: `<p class="aide">${esc(e.expediteur || '')} · ${date(e.date_reception)} · saisi par ${esc(e.mode_saisie)}</p>
      <pre class="corps">${esc(e.corps || '')}</pre>
      <h3>ASIN associés</h3>
      <p>${asinsLies.length ? asinsLies.map((l) => asinLien(l.valeur)).join(' · ') : '<span class="aide">Aucun.</span>'}</p>
      <div class="champs">${champ('lien_valeur', 'Associer un ASIN (facultatif)', { attrs: 'placeholder="B0…"' })}
      ${selecteur('action', 'Action', [['aucune', 'Associer seulement'], ['ignorer', 'Ignorer cet email'], ...(e.statut_rapprochement === 'ignore' ? [['dissocier', 'Ne plus ignorer']] : [])])}</div>`,
    libelleValider: 'Appliquer',
    valider: async (d) => {
      if (d.lien_valeur.trim()) await post(`/api/emails/${id}/liens`, { type: 'asin', valeur: d.lien_valeur });
      if (d.action === 'dissocier') return post(`/api/emails/${id}/dissocier`);
      if (d.action === 'ignorer') return post(`/api/emails/${id}/ignorer`);
      return true;
    },
  });
  if (action) rafraichir();
}
