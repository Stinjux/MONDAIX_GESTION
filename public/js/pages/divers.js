import { api, post, put, suppr, esc, montant, date, badge, tableau, modale, champ, selecteur, tenter, toast } from '../outils.js';
import { rafraichir } from '../app.js';

export async function pageFournisseurs(zone) {
  const fournisseurs = await api('/api/fournisseurs');
  zone.innerHTML = `
    <div class="entete"><div><h1>Fournisseurs</h1>
      <p class="aide">Les domaines servent à proposer le fournisseur d’un lien Google Sheets (domaine ou page produit) et d’un expéditeur Gmail. Toute proposition reste à valider.</p></div>
      <button class="principal" id="nouveau">Nouveau fournisseur</button></div>
    ${tableau(
      ['Nom', 'Domaines', 'Notes', ''],
      fournisseurs.map((f) => `<tr><td>${esc(f.nom)}</td><td class="mono">${esc(f.domaines.join(', ') || '—')}</td><td>${esc(f.notes || '')}</td>
        <td><button class="petit" data-modifier="${f.id}">Modifier</button></td></tr>`),
      'Aucun fournisseur.',
    )}`;
  const formulaire = (f = {}) =>
    `<div class="champs">${champ('nom', 'Nom', { valeur: f.nom || '' })}${champ('domaines', 'Domaines (ex. walmart.ca, bestbuy.ca)', { valeur: (f.domaines || []).join(', ') })}${champ('notes', 'Notes', { valeur: f.notes || '' })}</div>`;
  zone.querySelector('#nouveau').onclick = async () => {
    if (await modale({ titre: 'Nouveau fournisseur', contenu: formulaire(), valider: (d) => post('/api/fournisseurs', d) })) rafraichir();
  };
  zone.querySelectorAll('[data-modifier]').forEach((b) => {
    b.onclick = async () => {
      const f = fournisseurs.find((x) => x.id === Number(b.dataset.modifier));
      if (await modale({ titre: `Modifier ${f.nom}`, contenu: formulaire(f), valider: (d) => put(`/api/fournisseurs/${f.id}`, d) })) rafraichir();
    };
  });
}

export async function pageFactures(zone) {
  const [factures, commandes] = await Promise.all([api('/api/factures'), api('/api/commandes')]);
  const optionsCommandes = [['', '— aucune —'], ...commandes.map((c) => [c.id, `${c.numero_commande || '#' + c.id} · ${c.fournisseur || '?'} · ${montant(c.total_declare)}`])];
  zone.innerHTML = `
    <div class="entete"><div><h1>Factures</h1>
      <p class="aide">Une facture saisie avec un n° de commande est rattachée automatiquement si ce numéro correspond à une seule commande ; sinon, elle reste à rattacher.</p></div>
      <button class="principal" id="nouvelle">Nouvelle facture</button></div>
    ${tableau(
      ['N°', 'Date', 'Fournisseur', 'Réf. commande', { t: 'Sous-total HT', classe: 'num' }, { t: 'Total', classe: 'num' }, 'Commande', ''],
      factures.map(
        (f) => `<tr><td>${esc(f.numero_facture || '—')}</td><td>${date(f.date_facture)}</td><td>${esc(f.fournisseur || '—')}</td><td class="mono">${esc(f.numero_commande_ref || '—')}</td>
          <td class="num">${montant(f.sous_total_ht)}</td><td class="num">${montant(f.total_calcule)}</td>
          <td>${f.commande_id ? `<a href="#/commandes/${f.commande_id}">${esc(f.numero_commande || '#' + f.commande_id)}</a>` : badge('à rattacher', 'alerte')}</td>
          <td class="actions"><button class="petit" data-rattacher="${f.id}">Rattacher</button><button class="petit danger" data-suppr="${f.id}">Supprimer</button></td></tr>`,
      ),
      'Aucune facture.',
    )}`;
  zone.querySelector('#nouvelle').onclick = async () => {
    const r = await modale({
      titre: 'Nouvelle facture',
      contenu: `<div class="champs">${champ('numero_facture', 'N° de facture')}${champ('numero_commande_ref', 'N° de commande indiqué')}${champ('date_facture', 'Date', { type: 'date' })}
        ${selecteur('commande_id', 'Commande (si connue)', optionsCommandes)}
        ${champ('sous_total_ht', 'Sous-total HT')}${champ('taxes', 'Taxes')}${champ('livraison', 'Livraison')}${champ('autres_frais', 'Autres frais')}${champ('total', 'Total facturé')}</div>`,
      valider: (d) => post('/api/factures', d),
    });
    if (!r) return;
    if (r.proposition?.ambigu) toast('Plusieurs commandes portent ce numéro : rattachez la facture manuellement.');
    else if (!r.commande_id) toast('Aucune commande ne correspond : facture à rattacher.');
    rafraichir();
  };
  zone.querySelectorAll('[data-rattacher]').forEach((b) => {
    b.onclick = async () => {
      const f = factures.find((x) => x.id === Number(b.dataset.rattacher));
      const ok = await modale({
        titre: 'Rattacher la facture',
        contenu: `<div class="champs">${selecteur('commande_id', 'Commande', optionsCommandes, f.commande_id || '')}</div>`,
        valider: (d) => put(`/api/factures/${f.id}/commande`, d),
      });
      if (ok) rafraichir();
    };
  });
  zone.querySelectorAll('[data-suppr]').forEach((b) => (b.onclick = async () => (await tenter(() => suppr(`/api/factures/${b.dataset.suppr}`))) !== undefined && rafraichir()));
}

export async function pageParametres(zone) {
  const [sources, params] = await Promise.all([api('/api/emails/sources'), api('/api/parametres')]);
  zone.innerHTML = `
    <h1>Paramètres &amp; sources</h1>
    <h2>Sources email</h2>
    <p class="aide">Chaque boîte alimente un seul module. Connexion IMAP en lecture seule : aucun message n’est supprimé, déplacé ni marqué comme lu.
    Les identifiants se règlent dans le fichier <span class="mono">.env</span> du serveur, jamais dans l’interface.
    La saisie manuelle, l’import de fichiers .eml et les imports CSV restent disponibles sans connexion.</p>
    ${sources.map(carteSource).join('')}
    <div class="carte">
      <h3 style="margin-top:0">Réception automatique (facultatif)</h3>
      <p class="aide">Un outil externe (Apps Script Gmail, règle de transfert, n8n, Zapier…) peut envoyer chaque email reçu à
      <span class="mono">POST /api/emails/gmail/webhook</span> ou <span class="mono">POST /api/emails/neo/webhook</span>
      avec l’en-tête <span class="mono">X-Mondaix-Token</span> et un corps JSON <span class="mono">{ message_id, from, subject, date, text }</span> ou <span class="mono">{ raw }</span> (source .eml).</p>
      <div class="actions">${champ('webhook_token', 'Jeton du webhook', { type: 'password', valeur: '', attrs: `placeholder="${params.webhook_configure ? '•••••• (défini)' : 'non défini : webhook désactivé'}"` })}
        <button id="enregistrer-jeton" style="align-self:flex-end">Enregistrer le jeton</button></div>
    </div>
    <h2>Calculs</h2>
    <div class="carte">
      <label><input type="checkbox" id="inclure-taxes" ${params.inclure_taxes ? 'checked' : ''}> Inclure les taxes payées dans le coût complet (désactivé si vous les récupérez)</label>
      <div class="actions" style="margin-top:10px">${champ('tolerance', 'Tolérance de rapprochement des montants ($)', { valeur: params.tolerance })}
        <button id="enregistrer-calculs" style="align-self:flex-end">Enregistrer</button></div>
    </div>`;
  zone.querySelectorAll('[data-synchro]').forEach((b) => (b.onclick = () => synchroniser(b, b.dataset.synchro)));
  zone.querySelector('#enregistrer-jeton').onclick = async () => {
    if ((await tenter(() => put('/api/parametres', { webhook_token: zone.querySelector('#f-webhook_token').value }), 'Jeton enregistré.')) !== undefined) rafraichir();
  };
  zone.querySelector('#enregistrer-calculs').onclick = async () => {
    await tenter(() => put('/api/parametres', { inclure_taxes: zone.querySelector('#inclure-taxes').checked, tolerance: zone.querySelector('#f-tolerance').value }), 'Paramètres enregistrés.');
  };
}

function carteSource(s) {
  const y = s.synchro;
  const etat = !y.configuree
    ? badge('non connectée — import manuel', '')
    : y.derniere_erreur
      ? badge('erreur', 'erreur')
      : y.derniere_reussite
        ? badge('connectée', 'ok')
        : badge('configurée, jamais synchronisée', 'info');
  const b = y.dernier_bilan;
  return `<div class="carte">
    <div class="entete" style="margin-bottom:6px"><div><h3 style="margin:0">${esc(s.libelle)} ${etat}</h3>
      <p class="aide" style="margin:2px 0 0">${esc(s.role)} → ${s.module === 'commandes' ? '<a href="#/commandes">Commandes fournisseurs</a>' : '<a href="#/autorisations">Dossiers d’autorisation</a>'}</p></div>
      ${y.configuree ? `<button data-synchro="${s.source}" ${y.en_cours ? 'disabled' : ''}>${y.en_cours ? 'Synchronisation…' : 'Synchroniser maintenant'}</button>` : ''}</div>
    <div class="champs" style="margin-bottom:0">
      <div><label>Compte</label>${esc(y.utilisateur || 'non configuré')}${y.hote ? ` <span class="aide">(${esc(y.hote)})</span>` : ''}</div>
      <div><label>Dossier lu</label>${esc(y.dossier === '\\All' ? 'Tous les messages' : y.dossier)}</div>
      <div><label>Objet contenant</label>${y.mots_cles_objet.map((m) => badge(m, 'info')).join(' ')}</div>
      <div><label>Expéditeurs</label>${y.expediteurs.length ? y.expediteurs.map((d) => badge(d)).join(' ') : 'tous'}</div>
      <div><label>Depuis le</label>${date(y.date_depart)}</div>
      <div><label>Dernière synchronisation</label>${y.derniere_synchro ? new Date(y.derniere_synchro).toLocaleString('fr-CA') : '—'}
        ${b ? `<div class="aide">${b.examines} examiné(s) · ${b.retenus} retenu(s) · ${b.importes} importé(s)</div>` : ''}</div>
      <div><label>Emails reçus</label>${s.total}</div>
    </div>
    ${y.derniere_erreur ? `<div class="message erreur" style="margin:10px 0 0">${esc(y.derniere_erreur)}</div>` : ''}
  </div>`;
}

export async function synchroniser(bouton, source) {
  bouton.disabled = true;
  bouton.textContent = 'Synchronisation…';
  const r = await tenter(() => post('/api/emails/synchroniser', { source }));
  if (r) {
    for (const x of r) {
      if (x.echec) toast(`${x.source} : ${x.echec}`, true);
      else if (x.ignoree) toast(`${x.source} : ${x.motif}`);
      else toast(`${x.source} : ${x.importes} nouvel(s) email(s), ${x.retenus} correspondant aux filtres sur ${x.examines} examiné(s).`);
    }
  }
  rafraichir();
}

export async function pageJournal(zone) {
  const journal = await api('/api/journal?limite=300');
  zone.innerHTML = `<h1>Journal des modifications</h1><p class="aide">Toutes les créations, modifications, validations et rapprochements sont tracés.</p>
    ${tableau(['Date', 'Entité', 'Action', 'Détails'], journal.map((j) => `<tr><td>${esc(j.created_at)}</td><td>${esc(j.entite)} ${esc(j.entite_id || '')}</td><td>${esc(j.action)}</td>
      <td class="mono" style="max-width:520px;overflow:hidden;text-overflow:ellipsis">${esc((j.details || '').slice(0, 300))}</td></tr>`), 'Journal vide.')}`;
}
