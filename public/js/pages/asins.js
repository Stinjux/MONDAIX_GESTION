import { api, post, put, esc, montant, date, badge, tableau, modale, champ, tenter, references, asinLien, urlAmazon } from '../outils.js';
import { rafraichir } from '../app.js';
import { rendreInventaire, brancherInventaire } from './produits.js';

const TONS_DOSSIER = { a_demander: 'alerte', demande_envoyee: 'info', documents_requis: 'alerte', approuve: 'ok', refuse: 'erreur' };
const etat = { recherche: '' };

function filtreUrl() {
  return new URLSearchParams(location.hash.split('?')[1] || '').get('filtre') || '';
}

/* ------------------------------------------------------------------ liste */

export async function pageAsins(zone) {
  const filtre = filtreUrl();
  const [liste, ecarts, refs] = await Promise.all([api('/api/produits'), api('/api/ecarts-couts'), references()]);
  const asinsEcart = new Set(ecarts.map((e) => e.asin));
  const filtres = {
    '': ['Tous', () => true],
    stock: ['En stock', (p) => p.stock?.quantite > 0],
    ecarts: ['Écarts de coût', (p) => asinsEcart.has(p.asin)],
    sans_cout: ['Sans coût d’achat', (p) => p.cout_retenu === null],
    autorisation: ['Autorisation non confirmée', (p) => !p.autorisation?.confirme],
  };
  const q = etat.recherche.toLowerCase();
  const visibles = liste.filter((p) => (filtres[filtre] || filtres[''])[1](p) && (!q || [p.asin, p.titre, p.sku].some((v) => String(v || '').toLowerCase().includes(q))));

  zone.innerHTML = `
    <div class="entete"><div><h1>ASIN</h1>
      <p class="aide">Cliquez sur un ASIN pour ouvrir sa page Amazon, ou sur « fiche » pour voir tout son historique : commandes, factures, coûts, réceptions, envois, autorisation et emails.</p></div></div>
    <div class="actions" style="margin-bottom:8px">
      <div><label for="recherche-asin">Rechercher (ASIN, titre, SKU)</label><input id="recherche-asin" value="${esc(etat.recherche)}" placeholder="ex. B0…"></div>
    </div>
    <div class="onglets">${Object.entries(filtres)
      .map(([f, [t, fn]]) => `<a href="#/asins${f ? '?filtre=' + f : ''}" class="${f === filtre ? 'actif' : ''}">${t} (${liste.filter(fn).length})</a>`)
      .join('')}</div>
    ${tableau(
      [
        'ASIN',
        'Titre',
        { t: 'Coût HT retenu', classe: 'num' },
        { t: 'Commandé', classe: 'num' },
        { t: 'Reçu', classe: 'num' },
        { t: 'Envoyé Amazon', classe: 'num' },
        { t: 'En stock', classe: 'num' },
        { t: 'Valeur achats (est.)', classe: 'num' },
        'Autorisation',
        'Dernière commande',
        { t: 'Emails', classe: 'num' },
      ],
      visibles.map((p) => {
        const a = p.autorisation;
        return `<tr>
          <td>${asinLien(p.asin)}</td>
          <td>${esc(p.titre || '')}${p.sku ? `<div class="aide" style="margin:0">SKU ${esc(p.sku)}</div>` : ''}</td>
          <td class="num">${montant(p.cout_retenu)}${asinsEcart.has(p.asin) ? '<br>' + badge('écart', 'alerte') : ''}</td>
          <td class="num">${p.unites_commandees}</td><td class="num">${p.unites_recues}</td><td class="num">${p.unites_envoyees}</td>
          <td class="num">${celluleStock(p.stock)}</td>
          <td class="num">${montant(p.valeur_achats_estimee)}</td>
          <td>${a ? `<a href="#/dossiers/${a.dossier_id}">${badge(refs.statuts_dossier[a.statut] + (a.confirme ? ' ✓' : ''), TONS_DOSSIER[a.statut])}</a>` : badge('aucun dossier')}</td>
          <td>${date(p.derniere_commande)}</td>
          <td class="num">${p.nb_emails}</td></tr>`;
      }),
      'Aucun ASIN.',
    )}
    <p class="aide">Valeur achats (est.) = coût d’achat HT retenu × unités commandées. Stock : quantité du dernier import du fichier d’inventaire, avec l’écart depuis l’import précédent.</p>
    <details class="carte"><summary><strong>Importer le fichier d’inventaire</strong> (colonne cost = coût d’achat unitaire HT)</summary>
      <div id="inventaire" style="margin-top:10px">${rendreInventaire()}</div></details>`;

  zone.querySelector('#recherche-asin').onchange = (e) => ((etat.recherche = e.target.value), rafraichir());
  brancherInventaire(zone);
}

function ecartTexte(ecart) {
  if (ecart === null || ecart === undefined) return '';
  if (ecart === 0) return '= 0';
  return `${ecart > 0 ? '▲ +' : '▼ −'}${Math.abs(ecart)}`;
}

function celluleStock(s) {
  return `<strong>${s.quantite}</strong>${s.ecart !== null && s.ecart !== 0 ? `<div class="variation">${ecartTexte(s.ecart)}</div>` : ''}`;
}

/* ------------------------------------------------------------------ fiche */

const TYPES_EVENEMENT = {
  commande: ['Commande', 'info'],
  facture: ['Facture', 'info'],
  reception: ['Réception', 'ok'],
  envoi: ['Envoi Amazon', 'ok'],
  cout: ['Coût', ''],
  autorisation: ['Autorisation', 'alerte'],
  email_gmail: ['Gmail', ''],
  email_neo: ['Neo', ''],
  depense: ['Dépense', ''],
  sheets: ['Google Sheets', ''],
  stock: ['Stock', ''],
};

function tuile(valeur, libelle) {
  return `<div class="tuile"><div class="valeur">${valeur}</div><div class="libelle">${esc(libelle)}</div></div>`;
}

export async function pageAsin(zone, asin) {
  const [p, refs] = await Promise.all([api(`/api/produits/${encodeURIComponent(asin)}`), references()]);
  const cc = p.cout_complet;
  const dernierDossier = p.dossiers[0];

  zone.innerHTML = `
    <div class="entete"><div><a href="#/asins">← ASIN</a>
      <h1>${asinLien(p.asin, { fiche: false })}</h1>
      <p class="aide">${esc(p.titre || 'Sans titre')}${p.sku ? ' · SKU ' + esc(p.sku) : ''}</p></div>
      <div class="actions">
        <a class="bouton" href="${esc(urlAmazon(p.asin))}" target="_blank" rel="noopener noreferrer">Ouvrir sur Amazon ↗</a>
        <button id="modifier">Titre / SKU</button><button id="cout-manuel">Saisir un coût</button></div></div>

    <div class="grille">
      ${tuile(montant(cc.par_unite.achat), 'Coût d’achat HT retenu / unité')}
      ${tuile(montant(cc.cout_complet_unitaire), 'Coût complet / unité')}
      ${tuile(p.unites_commandees, `Unités commandées (${p.commandes.length} commande(s))`)}
      ${tuile(p.unites_recues, 'Unités reçues')}
      ${tuile(p.unites_envoyees, 'Unités expédiées à Amazon')}
      ${tuile(`${p.stock.quantite}${p.stock.ecart ? ` <span class="variation">${ecartTexte(p.stock.ecart)}</span>` : ''}`, 'Unités en stock (dernier import)')}
    </div>

    <div class="deux-colonnes" style="margin-top:14px">
      <div class="carte"><h3 style="margin-top:0">Coût complet par unité</h3>
        <table><tbody>
          <tr><td>Achat HT</td><td class="num">${montant(cc.par_unite.achat)}</td></tr>
          <tr><td>Frais de commande (livraison${cc.taxes_incluses ? ', taxes' : ''}, autres)</td><td class="num">${montant(cc.par_unite.frais_commande)}</td></tr>
          <tr><td>Envoi Amazon (préparation, transport)</td><td class="num">${montant(cc.par_unite.frais_envoi)}</td></tr>
          <tr><td>Dépenses rattachées à l’ASIN</td><td class="num">${montant(cc.par_unite.frais_directs)}</td></tr>
          <tr><td><strong>Total</strong></td><td class="num"><strong>${montant(cc.cout_complet_unitaire)}</strong></td></tr>
        </tbody></table>
        ${cc.alertes.map((a) => `<div class="message alerte" style="margin:6px 0 0">${esc(a)}</div>`).join('')}</div>
      <div class="carte"><h3 style="margin-top:0">Autorisation de vente</h3>
        ${dernierDossier
          ? `<p>${badge(refs.statuts_dossier[dernierDossier.statut], TONS_DOSSIER[dernierDossier.statut])} ${dernierDossier.confirme ? badge('confirmé', 'ok') : badge('non confirmé', 'alerte')}</p>
             <p>N° de cas : <span class="mono">${esc(dernierDossier.numero_cas || '—')}</span> · <a href="#/dossiers/${dernierDossier.id}">ouvrir le dossier</a></p>`
          : '<p>Aucun dossier. <a href="#/autorisations?filtre=tous">Créer un dossier</a></p>'}
        <p class="aide" style="margin-bottom:0">${p.emails.length} email(s) lié(s) à cet ASIN.</p></div>
    </div>

    <h2>Historique complet</h2>
    ${tableau(
      ['Date', 'Type', 'Événement', 'Détail'],
      p.evenements.map((e) => {
        const [t, ton] = TYPES_EVENEMENT[e.type] || [e.type, ''];
        return `<tr><td>${date(e.date)}</td><td>${badge(t, ton)}</td><td>${e.lien ? `<a href="${esc(e.lien)}">${esc(e.libelle)}</a>` : esc(e.libelle)}</td><td>${esc(e.detail || '')}</td></tr>`;
      }),
      'Aucun événement.',
    )}

    ${p.historique_stock.length ? `<h2>Stock (imports du fichier d’inventaire)</h2>
    ${tableau(['Import', 'Date', { t: 'Quantité', classe: 'num' }, { t: 'Écart avec l’import précédent', classe: 'num' }],
      p.historique_stock.map((h) => `<tr><td>${esc(h.nom || '#' + h.import_id)}</td><td>${date(h.date)}</td>
        <td class="num">${h.quantite}</td><td class="num">${ecartTexte(h.ecart) || '—'}</td></tr>`))}` : ''}

    <h2>Coûts d’achat unitaires HT</h2>
    <p class="aide">Aucune valeur n’est écrasée. Choisissez la valeur à retenir en cas d’écart.</p>
    ${tableau(
      ['Date', 'Source', 'Référence', { t: 'Montant HT', classe: 'num' }, { t: 'Écart / retenu', classe: 'num' }, ''],
      p.historique_couts.map(
        (h) => `<tr><td>${date(h.created_at)}</td><td>${esc(refs.sources_cout[h.source])}</td>
          <td>${h.commande_id ? `<a href="#/commandes/${h.commande_id}">${esc(h.reference || '')}</a>` : esc(h.reference || '')}</td>
          <td class="num">${montant(h.montant_unitaire_ht)}</td>
          <td class="num">${h.retenu ? badge('retenu', 'ok') : h.ecart ? `<span class="${h.ecart_traite ? '' : 'badge alerte'}">${montant(h.ecart)}</span>` : '='}</td>
          <td>${h.retenu ? '' : `<button class="petit" data-retenir="${h.id}">Retenir cette valeur</button>`}</td></tr>`,
      ),
      'Aucun coût enregistré.',
    )}

    <h2>Commandes</h2>
    ${tableau(
      ['Date', 'Commande', 'Fournisseur', { t: 'Qté', classe: 'num' }, { t: 'Coût unitaire (commande)', classe: 'num' }, { t: 'Total déclaré (commande)', classe: 'num' }],
      p.commandes.map((c) => `<tr><td>${date(c.date)}</td><td><a href="#/commandes/${c.id}">${esc(c.numero_commande || '#' + c.id)}</a></td><td>${esc(c.fournisseur || '—')}</td>
        <td class="num">${c.quantite}</td><td class="num">${montant(c.cout_unitaire_ht)}</td><td class="num">${montant(c.total_declare)}</td></tr>`),
      'Aucune commande.',
    )}

    <h2>Factures</h2>
    ${tableau(
      ['Date', 'Facture', 'Commande', 'Lignes de cet ASIN', { t: 'Total facture', classe: 'num' }],
      p.factures.map((f) => `<tr><td>${date(f.date_facture)}</td><td>${esc(f.numero_facture || '#' + f.id)}${f.document_id ? ` · <a href="/api/factures/documents/${f.document_id}/fichier" target="_blank" rel="noopener">document</a>` : ''}</td>
        <td>${f.commande_id ? `<a href="#/commandes/${f.commande_id}">${esc(f.numero_commande || '#' + f.commande_id)}</a>` : badge('à rattacher', 'alerte')}</td>
        <td>${f.lignes_asin.map((l) => `${l.quantite} × ${montant(l.prix_unitaire_ht)} HT`).join('<br>') || '<span class="aide">non détaillé</span>'}</td>
        <td class="num">${montant(f.total_calcule)}</td></tr>`),
      'Aucune facture.',
    )}

    <h2>Réceptions</h2>
    ${tableau(
      ['Date', 'Commande', { t: 'Qté reçue', classe: 'num' }],
      p.receptions.map((r) => `<tr><td>${date(r.date)}</td><td><a href="#/commandes/${r.commande_id}">${esc(r.numero_commande || '#' + r.commande_id)}</a></td><td class="num">${r.quantite}</td></tr>`),
      'Aucune réception.',
    )}

    <h2>Envois Amazon</h2>
    ${tableau(
      ['Date', 'Envoi', 'Statut', 'Commande d’origine', { t: 'Qté', classe: 'num' }],
      p.envois.map((e) => `<tr><td>${date(e.date)}</td><td><a href="#/envois/${e.id}">${esc(e.numero_envoi || '#' + e.id)}</a></td>
        <td>${esc(refs.statuts_envoi[e.statut])}</td><td>${e.commande_id ? `<a href="#/commandes/${e.commande_id}">${esc(e.numero_commande || '#' + e.commande_id)}</a>` : badge('non identifiée', 'alerte')}</td>
        <td class="num">${e.quantite}</td></tr>`),
      'Aucun envoi.',
    )}

    <h2>Emails</h2>
    ${tableau(
      ['Reçu', 'Boîte', 'Expéditeur', 'Objet', 'Lié par'],
      p.emails.map((e) => `<tr><td>${date(e.date_reception)}</td><td>${e.source === 'gmail' ? 'Gmail' : 'Neo'}</td><td>${esc(e.expediteur || '')}</td>
        <td><a href="#/emails/${e.source}?filtre=tous&email=${e.id}">${esc(e.sujet || '(sans objet)')}</a></td><td>${esc(e.via)}</td></tr>`),
      'Aucun email lié. Liez un email depuis Gmail · confirmations ou Neo · réponses.',
    )}

    ${p.dossiers.length > 1 ? `<h2>Dossiers d’autorisation</h2>
    ${tableau(['Dossier', 'Statut', 'N° de cas', 'Confirmé'],
      p.dossiers.map((d) => `<tr><td><a href="#/dossiers/${d.id}">#${d.id}</a></td><td>${esc(refs.statuts_dossier[d.statut])}</td><td class="mono">${esc(d.numero_cas || '—')}</td><td>${d.confirme ? badge('oui', 'ok') : badge('non', 'alerte')}</td></tr>`))}` : ''}

    ${p.depenses.length ? `<h2>Dépenses rattachées à l’ASIN</h2>
    ${tableau(['Date', 'Type', 'Description', { t: 'Unités', classe: 'num' }, { t: 'Montant', classe: 'num' }],
      p.depenses.map((d) => `<tr><td>${date(d.date_depense || d.created_at)}</td><td>${esc(refs.types_depense[d.type])}</td><td>${esc(d.description || '')}</td>
        <td class="num">${d.quantite_concernee}</td><td class="num">${montant(d.montant)}</td></tr>`))}` : ''}

    ${p.lignes_sheets.length ? `<h2>Lignes Google Sheets</h2>
    ${tableau(['Import · ligne', 'Lien d’origine', { t: 'Qté', classe: 'num' }, { t: 'Total déclaré (commande)', classe: 'num' }, 'État'],
      p.lignes_sheets.map((l) => `<tr><td>${esc(l.import_nom)} · ${l.numero_ligne}</td><td><span class="lien-court" title="${esc(l.lien_original || '')}">${esc(l.lien_original || '—')}</span></td>
        <td class="num">${l.quantite ?? '?'}</td><td class="num">${montant(l.total_commande_declare)}</td>
        <td>${l.statut === 'rattachee' ? `<a href="#/commandes/${l.commande_id}">${esc(l.numero_commande || 'commande #' + l.commande_id)}</a>` : badge(l.statut === 'ignoree' ? 'ignorée' : 'en attente', l.statut === 'ignoree' ? '' : 'alerte')}</td></tr>`))}` : ''}
  `;

  zone.querySelectorAll('[data-retenir]').forEach((b) => {
    b.onclick = async () => {
      if (await tenter(() => post(`/api/produits/${asin}/retenir`, { cout_id: Number(b.dataset.retenir) }), 'Coût retenu mis à jour (ancien conservé dans l’historique).')) rafraichir();
    };
  });
  zone.querySelector('#cout-manuel').onclick = async () => {
    const ok = await modale({
      titre: 'Saisir un coût d’achat unitaire HT',
      contenu: `<div class="champs">${champ('montant', 'Montant unitaire HT')}${champ('reference', 'Référence / justification')}</div>
        <label><input type="checkbox" name="retenir" value="1"> Retenir cette valeur</label>`,
      valider: (d) => post(`/api/produits/${asin}/couts`, { montant: d.montant, reference: d.reference, retenir: Boolean(d.retenir) }),
    });
    if (ok) rafraichir();
  };
  zone.querySelector('#modifier').onclick = async () => {
    const ok = await modale({
      titre: 'Titre et SKU',
      contenu: `<div class="champs">${champ('titre', 'Titre', { valeur: p.titre || '' })}${champ('sku', 'SKU', { valeur: p.sku || '' })}</div>`,
      valider: (d) => put(`/api/produits/${asin}`, d),
    });
    if (ok) rafraichir();
  };
}
