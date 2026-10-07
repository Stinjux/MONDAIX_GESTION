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
    <p class="aide">Chaque boîte alimente un seul module. La saisie manuelle, l’import de fichiers .eml et les imports CSV fonctionnent sans aucune connexion email.</p>
    ${tableau(
      ['Boîte', 'Rôle', 'Module alimenté', 'Adresse', 'Connexion', { t: 'Emails', classe: 'num' }, ''],
      sources.map((s) => `<tr><td><strong>${esc(s.libelle)}</strong></td><td>${esc(s.role)}</td>
        <td>${s.module === 'commandes' ? '<a href="#/commandes">Commandes fournisseurs</a>' : '<a href="#/autorisations">Dossiers d’autorisation</a>'}</td>
        <td>${esc(s.adresse || '—')}</td><td>${s.connecte ? badge('connectée', 'ok') : badge('non connectée — import manuel', '')}</td>
        <td class="num">${s.total}</td><td><button class="petit" data-adresse="${s.source}">Adresse</button></td></tr>`),
    )}
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
  zone.querySelectorAll('[data-adresse]').forEach((b) => {
    b.onclick = async () => {
      const s = sources.find((x) => x.source === b.dataset.adresse);
      if (await modale({ titre: `Adresse ${s.libelle}`, contenu: `<div class="champs">${champ('adresse', 'Adresse email', { valeur: s.adresse })}</div>`, valider: (d) => put(`/api/emails/sources/${s.source}`, d) })) rafraichir();
    };
  });
  zone.querySelector('#enregistrer-jeton').onclick = async () => {
    if ((await tenter(() => put('/api/parametres', { webhook_token: zone.querySelector('#f-webhook_token').value }), 'Jeton enregistré.')) !== undefined) rafraichir();
  };
  zone.querySelector('#enregistrer-calculs').onclick = async () => {
    await tenter(() => put('/api/parametres', { inclure_taxes: zone.querySelector('#inclure-taxes').checked, tolerance: zone.querySelector('#f-tolerance').value }), 'Paramètres enregistrés.');
  };
}

export async function pageJournal(zone) {
  const journal = await api('/api/journal?limite=300');
  zone.innerHTML = `<h1>Journal des modifications</h1><p class="aide">Toutes les créations, modifications, validations et rapprochements sont tracés.</p>
    ${tableau(['Date', 'Entité', 'Action', 'Détails'], journal.map((j) => `<tr><td>${esc(j.created_at)}</td><td>${esc(j.entite)} ${esc(j.entite_id || '')}</td><td>${esc(j.action)}</td>
      <td class="mono" style="max-width:520px;overflow:hidden;text-overflow:ellipsis">${esc((j.details || '').slice(0, 300))}</td></tr>`), 'Journal vide.')}`;
}
