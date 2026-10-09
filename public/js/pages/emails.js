import { api, post, suppr, esc, montant, date, badge, modale, champ, tenter, toast, references, lireFichierTexte, asinLien, entetePage, icone } from '../outils.js';
import { rafraichir } from '../app.js';
import { synchroniser } from './divers.js';

/* Vue en 3 colonnes : dossiers (boîte + état), liste, lecture.
   « Lu / non lu » est une préférence d'affichage enregistrée dans ce navigateur. */

const DOSSIERS = [
  ['a_traiter', 'ASIN à associer', 'inbox'],
  ['valide', 'Associés', 'circle-check'],
  ['ignore', 'Ignorés', 'ban'],
  ['tous', 'Tous', 'mail'],
];
const A_TRAITER = ['non_rapproche', 'propose', 'ambigu'];
const dansDossier = (e, f) => (f === 'tous' ? true : f === 'a_traiter' ? A_TRAITER.includes(e.statut_rapprochement) : e.statut_rapprochement === f);

function lus() {
  try {
    return new Set(JSON.parse(localStorage.getItem('mondaix.emails_lus') || '[]'));
  } catch {
    return new Set();
  }
}
function marquerLu(id, lu = true) {
  const s = lus();
  if (lu) s.add(id);
  else s.delete(id);
  try {
    localStorage.setItem('mondaix.emails_lus', JSON.stringify([...s].slice(-2000)));
  } catch {
    // stockage indisponible
  }
}

function etatEmail(e) {
  const asins = (e.liens || []).filter((l) => l.type === 'asin');
  return e.statut_rapprochement === 'ignore' ? badge('ignoré') : asins.length ? badge('associé', 'ok') : badge('ASIN à associer', 'alerte');
}

function itemListe(e, actif, estLu) {
  const asins = (e.liens || []).filter((l) => l.type === 'asin');
  return `<li class="email-item${actif ? ' actif' : ''}${estLu ? '' : ' non-lu'}">
    <input type="checkbox" data-coche="${e.id}" aria-label="Sélectionner l’email ${esc(e.sujet || '')}">
    <button type="button" class="email-ouvrir" data-ouvrir="${e.id}" aria-current="${actif ? 'true' : 'false'}">
      <span class="email-ligne1"><span class="email-point" aria-hidden="true"></span><span class="email-exp">${esc(e.expediteur || '(expéditeur inconnu)')}</span><span class="email-date">${date(e.date_reception)}</span></span>
      <span class="email-sujet">${estLu ? '' : '<span class="sr">Non lu : </span>'}${esc(e.sujet || '(sans objet)')}</span>
      <span class="email-ligne3">${etatEmail(e)}${asins.map((l) => `<span class="mono">${esc(l.valeur)}</span>`).join(' ')}</span>
    </button></li>`;
}

function lecture(e, estGmail, refs, produits) {
  if (!e) return `<div class="etat-vide">${icone('mail')} Sélectionnez un email dans la liste.</div>`;
  const r = e.references_extraites;
  const liens = e.liens.filter((l) => l.type === 'asin');
  const suggestions = (r.asins || []).filter((a) => !liens.some((l) => l.valeur === a));
  const statut = !estGmail && r.statut ? refs.statuts_dossier[r.statut] : null;
  return `<article aria-labelledby="email-titre">
    <header class="email-tete">
      <h2 id="email-titre">${esc(e.sujet || '(sans objet)')}</h2>
      <p class="aide sous">${esc(e.expediteur || '')} · reçu le ${date(e.date_reception)} · saisi par ${esc(e.mode_saisie)} · ${etatEmail(e)}</p>
      <div class="actions">
        <button type="button" data-action="non-lu">${icone('mail')}Marquer non lu</button>
        ${e.statut_rapprochement === 'ignore'
          ? `<button type="button" data-action="reactiver">${icone('undo-2')}Ne plus ignorer</button>`
          : `<button type="button" data-action="ignorer">${icone('ban')}Ignorer</button>`}
      </div>
    </header>
    <section class="email-asins">
      <h3>ASIN associés</h3>
      <div class="actions">${liens.map((l) => `<span class="puce">${asinLien(l.valeur)}${l.mode === 'auto' ? ' ' + badge('auto') : ''}
          <button type="button" class="petit icone-seule" data-delier="${l.id}" aria-label="Retirer ${esc(l.valeur)}" title="Retirer cet ASIN">${icone('x')}</button></span>`).join('') || '<span class="aide sous">Aucun ASIN associé.</span>'}</div>
      ${suggestions.length ? `<p class="aide">ASIN détectés dans l’email :</p><div class="actions">${suggestions.map((a) => `<button type="button" class="petit" data-lier="${esc(a)}">${icone('plus')}${esc(a)}</button>`).join('')}</div>` : ''}
      <form class="filtres pile" id="form-asin"><div><label for="asin-email">Associer un ASIN</label>
        <input id="asin-email" name="valeur" list="asins-email" placeholder="B0…" required></div>
        <button type="submit" class="principal">${icone('plus')}Associer</button></form>
      <datalist id="asins-email">${produits.map((p) => `<option value="${esc(p.asin)}">${esc(p.titre || '')}</option>`).join('')}</datalist>
      ${statut && liens.length ? `<div class="message info">Statut lu dans cette réponse d’Amazon : <strong>${esc(statut)}</strong>.
          <button type="button" class="pile" data-action="statut">${icone('shield-check')}Appliquer « ${esc(statut)} » à ${liens.length > 1 ? `${liens.length} ASIN` : esc(liens[0].valeur)}</button></div>` : ''}
      ${estGmail && r.montantTotal != null ? `<p class="aide">Total détecté : ${montant(r.montantTotal)}${r.domaine ? ` · ${esc(r.domaine)}` : ''}</p>` : ''}
    </section>
    <pre class="corps email-corps">${esc(e.corps || '')}</pre>
  </article>`;
}

export async function pageEmails(zone, source) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const filtre = DOSSIERS.some(([f]) => f === params.get('filtre')) ? params.get('filtre') : 'a_traiter';
  let selection = Number(params.get('email')) || null;
  const [gmail, neo, sources, refs, produits] = await Promise.all([
    api('/api/emails?source=gmail&statut='),
    api('/api/emails?source=neo&statut='),
    api('/api/emails/sources'),
    references(),
    api('/api/produits'),
  ]);
  const boites = { gmail, neo };
  const src = sources.find((s) => s.source === source);
  const estGmail = source === 'gmail';
  const liste = boites[source].filter((e) => dansDossier(e, filtre));
  if (!selection && liste.length && window.innerWidth > 1100) selection = liste[0].id;

  const sousTitre = `${esc(src.role)}. ${src.synchro.configuree
    ? `Connexion IMAP · objet contenant ${src.synchro.mots_cles_objet.map((m) => `« ${esc(m)} »`).join(' ou ')}${src.synchro.expediteurs.length ? ` · expéditeurs ${esc(src.synchro.expediteurs.join(', '))}` : ''} · depuis le ${date(src.synchro.date_depart)}${src.synchro.derniere_synchro ? ` · dernière synchro ${new Date(src.synchro.derniere_synchro).toLocaleString('fr-CA')}` : ''}.`
    : 'Aucune connexion active : importez les emails (.eml), collez-les ou saisissez-les.'}`;

  zone.innerHTML = `
    ${entetePage({
      titre: 'Emails',
      sousTitre,
      actions: `<button type="button" id="importer-eml">${icone('upload')}Importer des .eml</button><button type="button" id="saisir">${icone('plus')}Saisir un email</button>
        ${src.synchro.configuree ? `<button type="button" class="principal" id="synchroniser">${icone('refresh-cw')}Synchroniser</button>` : ''}`,
    })}
    ${src.synchro.derniere_erreur ? `<div class="message erreur">${esc(src.synchro.derniere_erreur)}</div>` : ''}
    <input type="file" id="fichiers-eml" accept=".eml,message/rfc822" multiple hidden>
    <div class="emails">
      <nav class="emails-dossiers" aria-label="Dossiers">
        ${[['gmail', 'Gmail · fournisseurs'], ['neo', 'Neo · autorisations']].map(([b, titre]) => `
          <div class="nav-titre">${titre}</div>
          ${DOSSIERS.map(([f, l, ic]) => {
            const n = boites[b].filter((e) => dansDossier(e, f)).length;
            const actif = b === source && f === filtre;
            return `<a href="#/emails/${b}?filtre=${f}" class="${actif ? 'actif' : ''}" ${actif ? 'aria-current="page"' : ''}>${icone(ic)}<span>${l}</span><span class="compte">${n}</span></a>`;
          }).join('')}`).join('')}
      </nav>
      <section class="emails-liste" aria-label="Liste des emails">
        <div class="emails-liste-tete"><label class="sous"><input type="checkbox" id="tout-cocher"> Tout</label>
          <span class="aide sous">${liste.length} email(s)</span></div>
        <div class="barre-selection" id="barre-emails" hidden><strong id="compte-emails"></strong>
          <button type="button" class="petit" data-groupe="lu">${icone('check')}Marquer lus</button>
          <button type="button" class="petit" data-groupe="non-lu">${icone('mail')}Non lus</button>
          <button type="button" class="petit" data-groupe="ignorer">${icone('ban')}Ignorer</button></div>
        <ul id="liste-emails">${liste.length ? '' : '<li class="etat-vide">Aucun email dans ce dossier.</li>'}</ul>
      </section>
      <section class="emails-lecture" id="lecture" aria-label="Lecture" aria-live="polite"></section>
    </div>`;

  const ul = zone.querySelector('#liste-emails');
  const panneau = zone.querySelector('#lecture');
  const rendreListe = () => {
    const l = lus();
    if (liste.length) ul.innerHTML = liste.map((e) => itemListe(e, e.id === selection, l.has(e.id))).join('');
  };
  const ouvrir = async (id, { focus = false } = {}) => {
    selection = id;
    const p = new URLSearchParams(location.hash.split('?')[1] || '');
    p.set('filtre', filtre);
    if (id) p.set('email', id);
    history.replaceState(null, '', `#/emails/${source}?${p}`);
    if (!id) {
      panneau.innerHTML = lecture(null);
      return;
    }
    marquerLu(id);
    rendreListe();
    const e = await api(`/api/emails/${id}`);
    panneau.innerHTML = lecture(e, estGmail, refs, produits);
    brancherLecture(e);
    if (focus) {
      const titre = panneau.querySelector('h2');
      titre.tabIndex = -1;
      titre.focus();
    }
  };
  const brancherLecture = (e) => {
    panneau.querySelector('[data-action="non-lu"]').onclick = () => {
      marquerLu(e.id, false);
      rendreListe();
      toast('Marqué comme non lu.');
    };
    panneau.querySelector('[data-action="ignorer"]')?.addEventListener('click', async () => {
      if ((await tenter(() => post(`/api/emails/${e.id}/ignorer`), 'Email ignoré.')) !== undefined) rafraichir();
    });
    panneau.querySelector('[data-action="reactiver"]')?.addEventListener('click', async () => {
      if ((await tenter(() => post(`/api/emails/${e.id}/dissocier`), 'Email réactivé.')) !== undefined) rafraichir();
    });
    panneau.querySelectorAll('[data-delier]').forEach((b) => {
      b.onclick = async () => {
        if ((await tenter(() => suppr(`/api/email-liens/${b.dataset.delier}`), 'ASIN retiré.')) !== undefined) rafraichir();
      };
    });
    panneau.querySelectorAll('[data-lier]').forEach((b) => {
      b.onclick = async () => {
        if (await tenter(() => post(`/api/emails/${e.id}/liens`, { type: 'asin', valeur: b.dataset.lier }), 'ASIN associé.')) rafraichir();
      };
    });
    panneau.querySelector('#form-asin').onsubmit = async (ev) => {
      ev.preventDefault();
      const valeur = new FormData(ev.target).get('valeur');
      if (await tenter(() => post(`/api/emails/${e.id}/liens`, { type: 'asin', valeur }), 'ASIN associé.')) rafraichir();
    };
    panneau.querySelector('[data-action="statut"]')?.addEventListener('click', async () => {
      const r = e.references_extraites;
      const asins = e.liens.filter((l) => l.type === 'asin').map((l) => l.valeur).join(', ');
      const ok = await modale({
        titre: 'Appliquer le statut d’autorisation',
        contenu: `<p>L’autorisation de <strong>${esc(asins)}</strong> passera au statut <strong>${esc(refs.statuts_dossier[r.statut])}</strong>, confirmé par cette réponse d’Amazon.</p>`,
        libelleValider: 'Appliquer',
        valider: () => post(`/api/emails/${e.id}/statut`, { statut: r.statut }),
      });
      if (ok) rafraichir();
    });
  };

  rendreListe();
  ouvrir(selection);
  ul.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-ouvrir]');
    if (b) ouvrir(Number(b.dataset.ouvrir), { focus: window.innerWidth <= 1100 });
  });
  // Navigation clavier dans la liste : flèches haut / bas
  ul.addEventListener('keydown', (ev) => {
    if (!['ArrowDown', 'ArrowUp'].includes(ev.key) || !ev.target.matches('[data-ouvrir]')) return;
    ev.preventDefault();
    const boutons = [...ul.querySelectorAll('[data-ouvrir]')];
    const i = boutons.indexOf(ev.target) + (ev.key === 'ArrowDown' ? 1 : -1);
    const cible = boutons[Math.max(0, Math.min(boutons.length - 1, i))];
    ouvrir(Number(cible.dataset.ouvrir)).then(() => ul.querySelector(`[data-ouvrir="${cible.dataset.ouvrir}"]`)?.focus());
  });

  // Sélection multiple
  const barre = zone.querySelector('#barre-emails');
  const cochees = () => [...ul.querySelectorAll('[data-coche]:checked')].map((c) => Number(c.dataset.coche));
  const majBarre = () => {
    const n = cochees().length;
    barre.hidden = !n;
    zone.querySelector('#compte-emails').textContent = `${n} sélectionné(s)`;
  };
  ul.addEventListener('change', majBarre);
  zone.querySelector('#tout-cocher').onchange = (ev) => {
    ul.querySelectorAll('[data-coche]').forEach((c) => (c.checked = ev.target.checked));
    majBarre();
  };
  barre.querySelectorAll('[data-groupe]').forEach((b) => {
    b.onclick = async () => {
      const ids = cochees();
      if (b.dataset.groupe === 'ignorer') {
        for (const id of ids) if ((await tenter(() => post(`/api/emails/${id}/ignorer`))) === undefined) break;
        toast(`${ids.length} email(s) ignoré(s).`);
        return rafraichir();
      }
      ids.forEach((id) => marquerLu(id, b.dataset.groupe === 'lu'));
      rendreListe();
      majBarre();
    };
  });

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
        <label for="f-brut">Source complète (facultatif)</label><textarea id="f-brut" name="brut"></textarea>
        <div class="champs">${champ('expediteur', 'Expéditeur')}${champ('sujet', 'Sujet')}${champ('date', 'Date de réception', { type: 'date' })}</div>
        <label for="f-corps">Corps du message</label><textarea id="f-corps" name="corps"></textarea>`,
      valider: (d) => (d.brut.trim() ? post(`/api/emails/${source}/eml`, { texte: d.brut }) : post(`/api/emails/${source}/manuel`, d)),
    });
    if (ok) rafraichir();
  };
}
