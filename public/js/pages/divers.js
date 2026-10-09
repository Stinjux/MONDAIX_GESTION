import { api, post, put, suppr, confirmer, esc, montant, date, badge, tableau, modale, champ, selecteur, tenter, toast, definirDomaineAmazon, asinLien, entetePage, icone } from '../outils.js';
import { menuActions } from '../menus.js';
import { rafraichir } from '../app.js';
import { carteDepot, brancherDepot } from './documents.js';

export async function pageFournisseurs(zone) {
  const fournisseurs = await api('/api/fournisseurs');
  zone.innerHTML = `
    ${entetePage({
      titre: 'Fournisseurs',
      sousTitre: 'Vos fournisseurs et leurs domaines web (ex. walmart.ca), utilisés pour reconnaître un expéditeur.',
      actions: `<button type="button" class="principal" id="nouveau">${icone('plus')}Nouveau fournisseur</button>`,
    })}
    ${tableau(
      ['Nom', 'Domaines', 'Notes', { t: '', tri: false }],
      fournisseurs.map((f) => `<tr><td><strong>${esc(f.nom)}</strong></td><td class="mono">${esc(f.domaines.join(', ') || '—')}</td><td>${esc(f.notes || '')}</td>
        <td class="actions-ligne"><button type="button" class="petit" data-modifier="${f.id}">Modifier</button></td></tr>`),
      'Aucun fournisseur : ajoutez-en un avec « Nouveau fournisseur ».',
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

const etatFactures = { recherche: '' };

export async function pageFactures(zone) {
  const [factures, docs] = await Promise.all([api('/api/factures'), api('/api/factures/documents?statut=a_valider')]);
  const filtre = new URLSearchParams(location.hash.split('?')[1] || '').get('filtre') || '';
  const filtres = {
    '': ['Toutes', () => true],
    actives: ['Actives', (f) => !f.annulee],
    sans_asin: ['Sans ASIN', (f) => !f.annulee && !f.lignes.length],
    en_attente: ['En attente du fournisseur', (f) => !f.annulee && f.en_attente],
    annulees: ['Annulées', (f) => f.annulee],
  };
  const q = etatFactures.recherche.toLowerCase();
  const visibles = factures.filter(
    (f) => (filtres[filtre] || filtres[''])[1](f) && (!q || [f.numero_facture, f.fournisseur, ...f.lignes.map((l) => l.asin)].some((v) => String(v || '').toLowerCase().includes(q))),
  );
  zone.innerHTML = `
    ${entetePage({
      titre: 'Factures',
      sousTitre: 'Déposez la facture, associez chaque article à un ASIN avec son coût unitaire HT. Fournisseur qui annule et rembourse : « Annuler » (la facture reste dans l’historique).',
      actions: `<button type="button" id="nouvelle">${icone('plus')}Saisie manuelle</button>
        <button type="button" class="principal" id="choisir-fichiers">${icone('upload')}Déposer une facture</button>`,
    })}
    ${carteDepot(docs)}
    <h2>Factures enregistrées</h2>
    <div class="filtres"><div><label for="recherche-facture">Rechercher</label>
      <input id="recherche-facture" type="search" value="${esc(etatFactures.recherche)}" placeholder="N°, fournisseur ou ASIN"></div></div>
    <div class="onglets">${Object.entries(filtres)
      .map(([f, [t, fn]]) => `<a href="#/factures${f ? '?filtre=' + f : ''}" class="${f === filtre ? 'actif' : ''}">${t} (${factures.filter(fn).length})</a>`)
      .join('')}</div>
    ${tableau(
      ['N°', 'Date', 'Fournisseur', { t: 'Articles (ASIN)', tri: false }, { t: 'Sous-total HT', classe: 'num' }, { t: 'Total', classe: 'num' }, { t: '', tri: false }],
      visibles.map(
        (f) => `<tr data-id="${f.id}" class="${f.annulee ? 'facture-annulee' : ''}"><td><strong>${esc(f.numero_facture || '—')}</strong>
            ${f.cle_import ? `<span class="sous">${badge('Google Sheet', 'info')}</span>` : ''}
            ${!f.annulee && f.en_attente ? `<span class="sous">${badge('en attente du fournisseur', 'alerte')}</span>` : ''}
            ${f.annulee ? `<span class="sous">${badge('annulée · remboursée', 'erreur')}</span><span class="aide sous">le ${date(f.date_annulation)}${f.motif_annulation ? ' · ' + esc(f.motif_annulation) : ''}</span>` : ''}</td>
          <td>${date(f.date_facture)}</td><td>${esc(f.fournisseur || '—')}</td>
          <td>${f.lignes.map((l) => `<span class="sous">${asinLien(l.asin)} × ${l.quantite}${l.prix_unitaire_ht !== null ? ` @ ${montant(l.prix_unitaire_ht)}` : ''}</span>`).join('') || badge('aucun ASIN', f.annulee ? '' : 'alerte')}</td>
          <td class="num montant-facture">${montant(f.sous_total_ht)}</td><td class="num montant-facture">${montant(f.total_calcule)}</td>
          <td class="actions-ligne"><button type="button" class="petit" data-menu-facture="${f.id}" aria-label="Actions pour la facture ${esc(f.numero_facture || f.id)}">Actions${icone('chevron-down')}</button></td></tr>`,
      ),
      q || filtre ? 'Aucune facture ne correspond à ces critères.' : 'Aucune facture : déposez votre première facture ci-dessus.',
      {
        videAction: q || filtre ? { libelle: 'Voir toutes les factures', href: '#/factures' } : null,
        selection: [
          { libelle: 'Annuler (remboursées)', icone: 'ban', action: (ids) => annulerFactures(factures.filter((f) => ids.includes(String(f.id)) && !f.annulee)) },
          { libelle: 'Supprimer', icone: 'trash-2', action: (ids) => supprimerFactures(factures.filter((f) => ids.includes(String(f.id)))) },
        ],
      },
    )}`;
  brancherDepot(zone);
  zone.querySelector('#choisir-fichiers').onclick = () => zone.querySelector('#fichiers-factures').click();
  const recherche = zone.querySelector('#recherche-facture');
  let delai;
  recherche.oninput = () => {
    clearTimeout(delai);
    delai = setTimeout(async () => {
      etatFactures.recherche = recherche.value;
      await rafraichir();
      const c = document.getElementById('recherche-facture');
      c?.focus();
      c?.setSelectionRange(c.value.length, c.value.length);
    }, 300);
  };
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
  zone.querySelectorAll('[data-menu-facture]').forEach((b) => {
    const f = factures.find((x) => x.id === Number(b.dataset.menuFacture));
    menuActions(b, [
      ...(f.document_id ? [{ libelle: 'Voir le document', action: () => window.open(`/api/factures/documents/${f.document_id}/fichier`, '_blank', 'noopener') }] : []),
      ...(f.annulee ? [] : [{ libelle: f.lignes.length ? 'Modifier les ASIN' : 'Associer des ASIN', action: () => modifierAsinsFacture(f) }]),
      ...(f.annulee
        ? []
        : [
            f.en_attente
              ? { libelle: 'Marquer reçue du fournisseur', action: async () => (await tenter(() => post(`/api/factures/${f.id}/recue`, { recue: true }), 'Facture marquée reçue.')) !== undefined && rafraichir() }
              : { libelle: 'Remettre en attente du fournisseur', action: async () => (await tenter(() => post(`/api/factures/${f.id}/recue`, { recue: false }), 'Facture en attente du fournisseur.')) !== undefined && rafraichir() },
          ]),
      f.annulee
        ? { libelle: 'Rétablir la facture', action: async () => (await tenter(() => post(`/api/factures/${f.id}/retablir`), 'Facture rétablie.')) !== undefined && rafraichir() }
        : { libelle: 'Annuler (remboursée)…', action: () => annulerFactures([f]) },
      { libelle: 'Supprimer…', danger: true, action: () => supprimerFactures([f]) },
    ]);
  });
}

/** Annulation (fournisseur qui annule et rembourse) d'une ou plusieurs factures. */
async function annulerFactures(liste) {
  if (!liste.length) return;
  const titre = liste.length === 1 ? `Annuler la facture ${liste[0].numero_facture || '#' + liste[0].id} ?` : `Annuler ${liste.length} factures ?`;
  const ok = await modale({
    titre,
    contenu: `<p>Le fournisseur a annulé et vous a remboursé. ${liste.length > 1 ? 'Les factures restent' : 'La facture <strong>reste</strong>'} dans l’historique (et sur la fiche des ASIN),
      mais ne compte${liste.length > 1 ? 'nt' : ''} plus dans les dépenses, les unités achetées ni le coût complet. Vous pourrez rétablir.</p>
      <div class="champs">${champ('date_annulation', 'Date de l’annulation / du remboursement', { type: 'date', valeur: new Date().toISOString().slice(0, 10) })}
      ${champ('motif', 'Motif (facultatif)', { attrs: 'placeholder="ex. rupture de stock, remboursé le…"' })}</div>`,
    libelleValider: liste.length === 1 ? 'Annuler la facture' : `Annuler ${liste.length} factures`,
    valider: async (d) => {
      for (const f of liste) await post(`/api/factures/${f.id}/annuler`, d);
    },
  });
  if (ok) rafraichir();
}

async function supprimerFactures(liste) {
  if (!liste.length) return;
  const ok = await confirmer({
    titre: liste.length === 1 ? `Supprimer la facture ${liste[0].numero_facture || '#' + liste[0].id} ?` : `Supprimer ${liste.length} factures ?`,
    message: 'La suppression est définitive. Le document déposé redevient « à vérifier ». Pour un remboursement, préférez « Annuler », qui garde l’historique.',
    libelle: 'Supprimer',
  });
  if (!ok) return;
  for (const f of liste) if ((await tenter(() => suppr(`/api/factures/${f.id}`))) === undefined) break;
  rafraichir();
}

function ligneArticle(l = {}) {
  return `<tr><td><input name="asin" list="liste-asins-facture" value="${esc(l.asin || '')}" placeholder="ASIN" class="champ-asin" aria-label="ASIN"></td>
    <td><input name="quantite" type="number" min="1" step="1" value="${esc(l.quantite ?? '')}" class="champ-qte" aria-label="Quantité"></td>
    <td><input name="prix_unitaire_ht" value="${esc(l.prix_unitaire_ht ?? '')}" class="champ-prix" aria-label="Prix unitaire HT"></td>
    <td>${l.description ? `<span class="aide">${esc(l.description)}</span>` : ''}</td>
    <td><button type="button" class="petit icone-seule" data-retirer aria-label="Retirer l’article">${icone('x')}</button></td></tr>`;
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
    ${entetePage({ titre: 'Paramètres', sousTitre: 'Sources email, réception automatique, calculs et site Amazon.' })}
    <h2>Sources email</h2>
    <p class="aide">Connexion IMAP en lecture seule : aucun message n’est supprimé, déplacé ni marqué comme lu.
    Les identifiants se règlent dans le fichier <span class="mono">.env</span> du serveur, jamais dans l’interface.
    La saisie manuelle, l’import de fichiers .eml et les imports CSV restent disponibles sans connexion.</p>
    ${sources.map(carteSource).join('')}
    <div class="carte">
      <h3 class="sans-marge">Réception automatique (facultatif)</h3>
      <p class="aide">Un outil externe (Apps Script Gmail, règle de transfert, n8n, Zapier…) peut envoyer chaque email reçu à
      <span class="mono">POST /api/emails/gmail/webhook</span> ou <span class="mono">POST /api/emails/neo/webhook</span>
      avec l’en-tête <span class="mono">X-Mondaix-Token</span> et un corps JSON <span class="mono">{ message_id, from, subject, date, text }</span> ou <span class="mono">{ raw }</span> (source .eml).</p>
      <div class="actions filtres">${champ('webhook_token', 'Jeton du webhook', { type: 'password', valeur: '', attrs: `placeholder="${params.webhook_configure ? '•••••• (défini)' : 'non défini : webhook désactivé'}"` })}
        <button type="button" class="principal" id="enregistrer-jeton">Enregistrer le jeton</button></div>
    </div>
    <h2>Calculs</h2>
    <div class="carte">
      <label><input type="checkbox" id="inclure-taxes" ${params.inclure_taxes ? 'checked' : ''}> Inclure les taxes payées dans le coût complet (désactivé si vous les récupérez)</label>
      <div class="actions filtres pile">${champ('tolerance', 'Tolérance de rapprochement des montants ($)', { valeur: params.tolerance })}
        ${champ('taux_taxes', 'Taxes incluses dans les totaux du Google Sheet (%)', { valeur: String(params.taux_taxes).replace('.', ',') })}
        <button type="button" class="principal" id="enregistrer-calculs">Enregistrer</button></div>
    </div>
    <h2>Amazon</h2>
    <div class="carte">
      <p class="aide sans-marge">Site ouvert quand on clique sur un ASIN (page produit <span class="mono">/dp/ASIN</span>).</p>
      <div class="actions filtres">${champ('amazon_domaine', 'Site Amazon', { valeur: params.amazon_domaine || 'www.amazon.ca', attrs: 'placeholder="www.amazon.ca"' })}
        <button type="button" class="principal" id="enregistrer-amazon">Enregistrer</button></div>
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
    await tenter(() => put('/api/parametres', {
      inclure_taxes: zone.querySelector('#inclure-taxes').checked,
      tolerance: zone.querySelector('#f-tolerance').value,
      taux_taxes: zone.querySelector('#f-taux_taxes').value,
    }), 'Paramètres enregistrés.');
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
    <div class="carte-tete"><div><h3 class="sans-marge">${esc(s.libelle)} ${etat}</h3>
      <p class="aide sous">${esc(s.role)} → <a href="#/emails/${s.source}">emails associés aux ASIN</a></p></div>
      ${y.configuree ? `<button type="button" data-synchro="${s.source}" ${y.en_cours ? 'disabled' : ''}>${icone('refresh-cw')}${y.en_cours ? 'Synchronisation…' : 'Synchroniser maintenant'}</button>` : ''}</div>
    <div class="champs fiche-infos">
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
    ${y.derniere_erreur ? `<div class="message erreur pile">${esc(y.derniere_erreur)}</div>` : ''}
  </div>`;
}

export async function synchroniser(bouton, source) {
  bouton.disabled = true;
  bouton.innerHTML = `${icone('refresh-cw')}Synchronisation…`;
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
  zone.innerHTML = `${entetePage({ titre: 'Journal', sousTitre: 'Toutes les créations, modifications, validations et associations sont tracées (300 dernières).' })}
    ${tableau(['Date', 'Entité', 'Action', 'Détails'], journal.map((j) => `<tr><td class="date">${esc(j.created_at)}</td><td>${esc(j.entite)} ${esc(j.entite_id || '')}</td><td>${esc(j.action)}</td>
      <td class="mono details-journal" title="${esc(j.details || '')}">${esc((j.details || '').slice(0, 300))}</td></tr>`), 'Journal vide.')}`;
}
