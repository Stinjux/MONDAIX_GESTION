import { api, post, put, suppr, esc, montant, date, badge, tableau, modale, champ, selecteur, tenter, toast, definirDomaineAmazon, asinLien } from '../outils.js';
import { rafraichir } from '../app.js';
import { carteDepot, brancherDepot } from './documents.js';

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
  const [factures, docs] = await Promise.all([api('/api/factures'), api('/api/factures/documents?statut=a_valider')]);
  zone.innerHTML = `
    <div class="entete"><div><h1>Factures</h1>
      <p class="aide">Déposez la facture, associez chaque article à un ASIN avec son coût unitaire HT et la date de la facture.
        Si le fournisseur annule et vous rembourse, cliquez sur « Annuler » : la facture reste dans l’historique mais ne compte plus dans les dépenses.</p></div>
      <button id="nouvelle">Saisie manuelle</button></div>
    ${carteDepot(docs)}
    <h2>Factures enregistrées</h2>
    ${tableau(
      ['N°', 'Date', 'Fournisseur', 'Articles (ASIN)', { t: 'Sous-total HT', classe: 'num' }, { t: 'Total', classe: 'num' }, ''],
      factures.map(
        (f) => `<tr class="${f.annulee ? 'facture-annulee' : ''}"><td>${esc(f.numero_facture || '—')}
            ${f.annulee ? `<div>${badge('annulée · remboursée', 'erreur')}</div><div class="aide" style="margin:0">le ${date(f.date_annulation)}${f.motif_annulation ? ' · ' + esc(f.motif_annulation) : ''}</div>` : ''}</td>
          <td>${date(f.date_facture)}</td><td>${esc(f.fournisseur || '—')}</td>
          <td>${f.lignes.map((l) => `${asinLien(l.asin)} × ${l.quantite}${l.prix_unitaire_ht !== null ? ` @ ${montant(l.prix_unitaire_ht)}` : ''}`).join('<br>') || badge('aucun ASIN', f.annulee ? '' : 'alerte')}
            ${f.annulee ? '' : `<div><button class="petit" data-asins="${f.id}">${f.lignes.length ? 'Modifier les ASIN' : 'Associer des ASIN'}</button></div>`}</td>
          <td class="num montant-facture">${montant(f.sous_total_ht)}</td><td class="num montant-facture">${montant(f.total_calcule)}</td>
          <td class="actions">${f.document_id ? `<a class="bouton petit" href="/api/factures/documents/${f.document_id}/fichier" target="_blank" rel="noopener">Document</a>` : ''}
            ${f.annulee ? `<button class="petit" data-retablir="${f.id}">Rétablir</button>` : `<button class="petit" data-annuler="${f.id}">Annuler</button>`}
            <button class="petit danger" data-suppr="${f.id}">Supprimer</button></td></tr>`,
      ),
      'Aucune facture.',
    )}`;
  brancherDepot(zone);
  zone.querySelector('#nouvelle').onclick = async () => {
    const r = await modale({
      titre: 'Nouvelle facture',
      contenu: `<div class="champs">${champ('numero_facture', 'N° de facture')}${champ('date_facture', 'Date', { type: 'date' })}
        ${champ('sous_total_ht', 'Sous-total HT')}${champ('taxes', 'Taxes')}${champ('livraison', 'Livraison')}${champ('autres_frais', 'Autres frais')}${champ('total', 'Total facturé')}</div>
        <p class="aide">Pour associer les articles à des ASIN, déposez plutôt le PDF ou la photo de la facture.</p>`,
      valider: (d) => post('/api/factures', d),
    });
    if (r) rafraichir();
  };
  zone.querySelectorAll('[data-suppr]').forEach((b) => (b.onclick = async () => (await tenter(() => suppr(`/api/factures/${b.dataset.suppr}`))) !== undefined && rafraichir()));
  zone.querySelectorAll('[data-annuler]').forEach((b) => {
    b.onclick = async () => {
      const f = factures.find((x) => x.id === Number(b.dataset.annuler));
      const ok = await modale({
        titre: `Annuler la facture ${f.numero_facture || '#' + f.id} ?`,
        contenu: `<p>Le fournisseur a annulé et vous a remboursé. La facture <strong>reste dans l’historique</strong> (et sur la fiche des ASIN),
          mais ne compte plus dans les dépenses, les unités achetées ni le coût complet. Vous pourrez la rétablir.</p>
          <div class="champs">${champ('date_annulation', 'Date de l’annulation / du remboursement', { type: 'date', valeur: new Date().toISOString().slice(0, 10) })}
          ${champ('motif', 'Motif (facultatif)', { attrs: 'placeholder="ex. rupture de stock, remboursé le…"' })}</div>`,
        libelleValider: 'Annuler la facture',
        valider: (d) => post(`/api/factures/${f.id}/annuler`, d),
      });
      if (ok) rafraichir();
    };
  });
  zone.querySelectorAll('[data-retablir]').forEach((b) => {
    b.onclick = async () => {
      if ((await tenter(() => post(`/api/factures/${b.dataset.retablir}/retablir`), 'Facture rétablie.')) !== undefined) rafraichir();
    };
  });
  zone.querySelectorAll('[data-asins]').forEach((b) => (b.onclick = () => modifierAsinsFacture(factures.find((f) => f.id === Number(b.dataset.asins)))));
}

function ligneArticle(l = {}) {
  return `<tr><td><input name="asin" list="liste-asins-facture" value="${esc(l.asin || '')}" placeholder="ASIN" style="width:130px" aria-label="ASIN"></td>
    <td><input name="quantite" type="number" min="1" step="1" value="${esc(l.quantite ?? '')}" style="width:70px" aria-label="Quantité"></td>
    <td><input name="prix_unitaire_ht" value="${esc(l.prix_unitaire_ht ?? '')}" style="width:90px" aria-label="Prix unitaire HT"></td>
    <td>${l.description ? `<span class="aide">${esc(l.description)}</span>` : ''}</td>
    <td><button type="button" class="petit" data-retirer>×</button></td></tr>`;
}

/** Associe (ou corrige) les ASIN des articles d'une facture enregistrée. */
async function modifierAsinsFacture(f) {
  const produits = await api('/api/produits');
  // Sans article associé : on part des articles lus sur le document, s'il y en a.
  const depart = f.lignes.length ? f.lignes : f.articles_extraits.length ? f.articles_extraits : [{}];
  const ok = await modale({
    titre: `ASIN de la facture ${f.numero_facture || '#' + f.id}`,
    contenu: `<p class="aide">Une ligne par article : ASIN, quantité et prix unitaire HT. La dépense de chaque ASIN est sa part de la facture (taxes, livraison et frais répartis au prorata du montant HT). L’historique des coûts n’est jamais effacé.</p>
      <div class="tableau"><table><thead><tr><th>ASIN</th><th>Qté</th><th>Prix unit. HT</th><th>Article lu</th><th></th></tr></thead>
      <tbody id="articles">${depart.map(ligneArticle).join('')}</tbody></table></div>
      <button type="button" class="petit" id="ajouter-article">+ Article</button>
      <datalist id="liste-asins-facture">${produits.map((p) => `<option value="${esc(p.asin)}">${esc(p.titre || '')}</option>`).join('')}</datalist>`,
    apresOuverture: (form) => {
      const corps = form.querySelector('#articles');
      const brancher = () => corps.querySelectorAll('[data-retirer]').forEach((b) => (b.onclick = () => b.closest('tr').remove()));
      form.querySelector('#ajouter-article').onclick = () => {
        corps.insertAdjacentHTML('beforeend', ligneArticle());
        brancher();
      };
      brancher();
    },
    valider: (_, form) => {
      const lignes = [...form.querySelectorAll('#articles tr')].map((tr) => ({
        asin: tr.querySelector('[name=asin]').value.trim(),
        quantite: tr.querySelector('[name=quantite]').value,
        prix_unitaire_ht: tr.querySelector('[name=prix_unitaire_ht]').value,
      }));
      return put(`/api/factures/${f.id}/lignes`, { lignes: lignes.filter((l) => l.asin) });
    },
  });
  if (ok) rafraichir();
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
    </div>
    <h2>Amazon</h2>
    <div class="carte">
      <p class="aide" style="margin-top:0">Site ouvert quand on clique sur un ASIN (page produit <span class="mono">/dp/ASIN</span>).</p>
      <div class="actions">${champ('amazon_domaine', 'Site Amazon', { valeur: params.amazon_domaine || 'www.amazon.ca', attrs: 'placeholder="www.amazon.ca"' })}
        <button id="enregistrer-amazon" style="align-self:flex-end">Enregistrer</button></div>
    </div>`;
  zone.querySelectorAll('[data-synchro]').forEach((b) => (b.onclick = () => synchroniser(b, b.dataset.synchro)));
  zone.querySelector('#enregistrer-jeton').onclick = async () => {
    if ((await tenter(() => put('/api/parametres', { webhook_token: zone.querySelector('#f-webhook_token').value }), 'Jeton enregistré.')) !== undefined) rafraichir();
  };
  zone.querySelector('#enregistrer-amazon').onclick = async () => {
    const domaine = zone.querySelector('#f-amazon_domaine').value;
    if ((await tenter(() => put('/api/parametres', { amazon_domaine: domaine }), 'Site Amazon enregistré.')) !== undefined) {
      definirDomaineAmazon(domaine.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
    }
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
      <p class="aide" style="margin:2px 0 0">${esc(s.role)} → <a href="#/emails/${s.source}">emails associés aux ASIN</a></p></div>
      ${y.configuree ? `<button data-synchro="${s.source}" ${y.en_cours ? 'disabled' : ''}>${y.en_cours ? 'Synchronisation…' : 'Synchroniser maintenant'}</button>` : ''}</div>
    <div class="champs" style="margin-bottom:0">
      <div><label>Compte</label>${esc(y.utilisateur || 'non configuré')}${y.hote ? ` <span class="aide">(${esc(y.hote)})</span>` : ''}</div>
      ${y.empreinte_mot_de_passe ? `<div><label>Mot de passe chargé</label>${esc(y.empreinte_mot_de_passe)}</div>` : ''}
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
