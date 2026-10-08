import { api, post, suppr, esc, montant, date, badge, tableau, modale, champ, selecteur, selecteurTriEtat, tenter, toast, references, lireFichierTexte, asinLien } from '../outils.js';
import { rafraichir } from '../app.js';
import { synchroniser } from './divers.js';

const STATUTS = {
  non_rapproche: ['non rapproché', 'alerte'],
  propose: ['proposition à valider', 'info'],
  ambigu: ['ambigu : à choisir', 'alerte'],
  valide: ['rapproché', 'ok'],
  ignore: ['ignoré', ''],
};

export async function pageEmails(zone, source) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const filtre = params.get('filtre') || 'a_traiter';
  const emailAOuvrir = Number(params.get('email')) || null;
  const [emails, sources, refs] = await Promise.all([api(`/api/emails?source=${source}&statut=${filtre === 'tous' ? '' : filtre}`), api('/api/emails/sources'), references()]);
  const src = sources.find((s) => s.source === source);
  const estGmail = source === 'gmail';
  zone.innerHTML = `
    <div class="entete"><div><h1>${esc(src.libelle)} · ${estGmail ? 'confirmations de commandes' : 'réponses d’autorisation'}</h1>
      <p class="aide">${esc(src.role)}. Ces emails alimentent uniquement le module <strong>${estGmail ? 'Commandes fournisseurs' : 'Dossiers d’autorisation'}</strong>.
      ${src.synchro.configuree
        ? `Connexion IMAP configurée · objet contenant ${src.synchro.mots_cles_objet.map((m) => `« ${esc(m)} »`).join(' ou ')}${src.synchro.expediteurs.length ? ` · expéditeurs ${esc(src.synchro.expediteurs.join(', '))}` : ''} · depuis le ${date(src.synchro.date_depart)}${src.synchro.derniere_synchro ? ` · dernière synchronisation ${new Date(src.synchro.derniere_synchro).toLocaleString('fr-CA')}` : ''}.`
        : 'Aucune connexion active : importez les emails (.eml), collez-les ou saisissez-les.'}</p>
      ${src.synchro.derniere_erreur ? `<div class="message erreur">${esc(src.synchro.derniere_erreur)}</div>` : ''}</div>
      <div class="actions">${src.synchro.configuree ? `<button class="principal" id="synchroniser">Synchroniser</button>` : ''}<button id="importer-eml">Importer des .eml</button><button id="saisir">Saisir / coller un email</button>
      <button id="relancer">Relancer le rapprochement</button></div></div>
    <input type="file" id="fichiers-eml" accept=".eml,message/rfc822" multiple hidden>
    <div class="onglets">${[['a_traiter', `À traiter (${src.a_traiter})`], ['valide', 'Rapprochés'], ['ignore', 'Ignorés'], ['tous', 'Tous']]
      .map(([f, t]) => `<a href="#/emails/${source}?filtre=${f}" class="${f === filtre ? 'actif' : ''}">${t}</a>`).join('')}</div>
    ${tableau(
      ['Reçu', 'Expéditeur', 'Sujet', 'Références détectées', 'ASIN / cas liés', 'Rapprochement', ''],
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
  zone.querySelector('#relancer').onclick = async () => {
    const r = await tenter(() => post('/api/emails/relancer', { source }));
    if (r) {
      toast(`${r.traites} email(s) réexaminé(s).`);
      rafraichir();
    }
  };
  zone.querySelectorAll('[data-detail]').forEach((b) => (b.onclick = () => detail(Number(b.dataset.detail), refs)));
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
  if (emailAOuvrir) detail(emailAOuvrir, refs);
  zone.querySelectorAll('[data-valider]').forEach((b) => {
    b.onclick = async () => {
      const corps = JSON.parse(b.dataset.valider);
      if (await tenter(() => post(`/api/emails/${b.dataset.email}/valider`, corps), 'Rapprochement validé.')) rafraichir();
    };
  });
  zone.querySelectorAll('[data-statut]').forEach((b) => {
    b.onclick = async () => {
      const ok = await modale({
        titre: 'Appliquer le statut au dossier',
        contenu: `<p>Le dossier passera au statut <strong>${esc(refs.statuts_dossier[b.dataset.statut])}</strong>, confirmé par cette réponse d’Amazon.</p>`,
        libelleValider: 'Appliquer',
        valider: () => post(`/api/emails/${b.dataset.email}/statut`, { statut: b.dataset.statut }),
      });
      if (ok) rafraichir();
    };
  });
}

function ligne(e, estGmail, refs) {
  const r = e.references_extraites;
  const [t, ton] = STATUTS[e.statut_rapprochement];
  const refsTxt = estGmail
    ? [r.numerosCommande?.length ? `n° ${r.numerosCommande.join(', ')}` : '', r.montantTotal != null ? `total ${montant(r.montantTotal)}` : '', r.domaine || '', r.asins?.length ? r.asins.join(', ') : ''].filter(Boolean).join(' · ')
    : [r.numerosCas?.length ? `cas ${r.numerosCas.join(', ')}` : '', r.asins?.length ? r.asins.join(', ') : '', r.statut ? `→ ${refs.statuts_dossier[r.statut]}` : ''].filter(Boolean).join(' · ');
  const cible = estGmail
    ? e.commande_id ? `<a href="#/commandes/${e.commande_id}">${esc(e.numero_commande || 'commande #' + e.commande_id)}</a>` : ''
    : e.dossier_id ? `<a href="#/dossiers/${e.dossier_id}">dossier ${esc(e.dossier_asin)}${e.dossier_cas ? ' · cas ' + esc(e.dossier_cas) : ''}</a>` : '';
  const propositions =
    e.statut_rapprochement === 'propose' || e.statut_rapprochement === 'ambigu'
      ? e.propositions
          .map((p) => {
            const corps = estGmail ? { commande_id: p.commande_id } : { dossier_id: p.dossier_id };
            const libelle = estGmail ? `${p.numero_commande || '#' + p.commande_id}${p.fournisseur ? ' · ' + p.fournisseur : ''}` : `${p.asin}${p.numero_cas ? ' · cas ' + p.numero_cas : ''}`;
            return `<button class="petit" data-email="${e.id}" data-valider='${esc(JSON.stringify(corps))}' title="${esc(p.motifs.join(', '))}">Valider : ${esc(libelle)}</button>${p.conflit_cas ? badge('n° de cas différent', 'erreur') : ''}${p.deja_confirmee ? badge('déjà une confirmation', 'alerte') : ''}`;
          })
          .join(' ')
      : '';
  const appliquer = !estGmail && e.dossier_id && r.statut ? `<button class="petit" data-email="${e.id}" data-statut="${r.statut}">Appliquer « ${esc(refs.statuts_dossier[r.statut])} »</button>` : '';
  return `<tr><td>${date(e.date_reception)}</td><td>${esc(e.expediteur || '')}</td><td>${esc(e.sujet || '')}</td><td>${esc(refsTxt || '—')}</td>
    <td>${celluleLiens(e)}</td>
    <td>${badge(t, ton)}${e.mode_rapprochement === 'auto' ? ' ' + badge('auto') : ''} ${cible}<div class="actions" style="margin-top:4px">${propositions}${appliquer}</div></td>
    <td><button class="petit" data-detail="${e.id}">Ouvrir</button></td></tr>`;
}

/** Liens ASIN / cas de l'email, suggestions issues des références détectées et ajout manuel. */
function celluleLiens(e) {
  const r = e.references_extraites;
  const liens = e.liens || [];
  const dejaLie = (type, valeur) => liens.some((l) => l.type === type && l.valeur === valeur);
  const puces = liens.map(
    (l) => `<div class="lien-email">${l.type === 'asin' ? asinLien(l.valeur) : `<span class="mono">cas ${esc(l.valeur)}</span>`}${l.mode === 'auto' ? ' ' + badge('auto') : ''}
      <button class="petit" data-delier="${l.id}" title="Retirer ce lien" aria-label="Retirer ce lien">×</button></div>`,
  );
  const suggestions = [
    ...(r.asins || []).filter((a) => !dejaLie('asin', a)).map((a) => ({ type: 'asin', valeur: a, libelle: a })),
    ...(r.numerosCas || []).filter((c) => !dejaLie('cas', c)).map((c) => ({ type: 'cas', valeur: c, libelle: `cas ${c}` })),
  ].map((s) => `<button class="petit" data-email="${e.id}" data-lier='${esc(JSON.stringify({ type: s.type, valeur: s.valeur }))}' title="Lier cet email">+ ${esc(s.libelle)}</button>`);
  return `${puces.join('')}<div class="actions" style="margin-top:4px">${suggestions.join('')}<button class="petit" data-nouveau-lien="${e.id}">+ Lier</button></div>`;
}

async function nouveauLien(id) {
  const ok = await modale({
    titre: 'Lier l’email à un ASIN ou à un cas',
    contenu: `<div class="champs">${selecteur('type', 'Type', [['asin', 'ASIN'], ['cas', 'N° de cas Amazon']])}${champ('valeur', 'ASIN ou numéro de cas', { attrs: 'required placeholder="B0… ou 12345678901"' })}</div>`,
    libelleValider: 'Lier',
    valider: (d) => post(`/api/emails/${id}/liens`, d),
  });
  if (ok) rafraichir();
}

async function detail(id, refs) {
  const e = await api(`/api/emails/${id}`);
  const estGmail = e.source === 'gmail';
  const cibles = estGmail ? await api('/api/commandes') : await api('/api/dossiers');
  const options = estGmail
    ? cibles.map((c) => [c.id, `${c.numero_commande || '#' + c.id} · ${c.fournisseur || '?'} · ${montant(c.total_declare)}`])
    : cibles.map((d) => [d.id, `${d.asin} · ${refs.statuts_dossier[d.statut]}${d.numero_cas ? ' · cas ' + d.numero_cas : ''}`]);
  const action = await modale({
    titre: e.sujet || 'Email',
    contenu: `<p class="aide">${esc(e.expediteur || '')} · ${date(e.date_reception)} · saisi par ${esc(e.mode_saisie)}</p>
      <pre class="corps">${esc(e.corps || '')}</pre>
      <h3>ASIN et cas liés</h3>
      <p>${e.liens.length ? e.liens.map((l) => (l.type === 'asin' ? asinLien(l.valeur) : `<span class="mono">cas ${esc(l.valeur)}</span>`)).join(' · ') : '<span class="aide">Aucun.</span>'}</p>
      <div class="champs">${selecteur('lien_type', 'Ajouter un lien', [['asin', 'ASIN'], ['cas', 'N° de cas Amazon']])}${champ('lien_valeur', 'ASIN ou numéro de cas (facultatif)')}</div>
      <h3>${estGmail ? 'Rattacher à une commande' : 'Rattacher à un dossier d’autorisation'}</h3>
      <div class="champs">${selecteur('cible', estGmail ? 'Commande' : 'Dossier', [['', '—'], ...options], estGmail ? e.commande_id || '' : e.dossier_id || '')}
      ${selecteur('action', 'Action', [['aucune', 'Ne pas changer le rattachement'], ['valider', 'Valider le rattachement'], ['dissocier', 'Dissocier'], ['ignorer', 'Ignorer cet email'], ...(estGmail && !e.commande_id ? [['creer', 'Créer une commande depuis cet email']] : [])])}</div>`,
    libelleValider: 'Appliquer',
    valider: async (d) => {
      if (d.lien_valeur.trim()) await post(`/api/emails/${id}/liens`, { type: d.lien_type, valeur: d.lien_valeur });
      if (d.action === 'aucune') return true;
      if (d.action === 'dissocier') return post(`/api/emails/${id}/dissocier`);
      if (d.action === 'ignorer') return post(`/api/emails/${id}/ignorer`);
      if (d.action === 'creer') return 'creer';
      if (!d.cible) throw new Error('Choisissez une cible.');
      return post(`/api/emails/${id}/valider`, estGmail ? { commande_id: Number(d.cible) } : { dossier_id: Number(d.cible) });
    },
  });
  if (action === 'creer') return creerCommande(e);
  if (action) rafraichir();
}

async function creerCommande(e) {
  const r = e.references_extraites;
  const fournisseurs = await api('/api/fournisseurs');
  const res = await modale({
    titre: 'Créer une commande depuis la confirmation',
    contenu: `<div class="champs">${champ('numero_commande', 'N° de commande', { valeur: r.numerosCommande?.[0] || '' })}
      ${champ('date_commande', 'Date', { type: 'date', valeur: (e.date_reception || '').slice(0, 10) })}
      ${selecteur('fournisseur_id', 'Fournisseur', [['', '— à préciser —'], ...fournisseurs.map((f) => [f.id, f.nom])])}
      ${champ('total_declare', 'Total déclaré', { valeur: r.montantTotal ?? '' })}
      ${selecteurTriEtat('total_inclut_taxes', 'Inclut les taxes ?', null)}${selecteurTriEtat('total_inclut_livraison', 'Inclut la livraison ?', null)}</div>
      ${r.asins?.length ? `<p class="aide">ASIN cités : ${r.asins.map((x) => asinLien(x)).join(', ')} (ajoutez les lignes ensuite).</p>` : ''}`,
    libelleValider: 'Créer',
    valider: (d) => post(`/api/emails/${e.id}/creer-commande`, d),
  });
  if (res) location.hash = `#/commandes/${res.id}`;
}
