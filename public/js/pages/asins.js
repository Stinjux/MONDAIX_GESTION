import { api, post, put, suppr, confirmer, informer, esc, montant, date, badge, tableau, modale, champ, tenter, references, asinLien, urlAmazon, entetePage, icone, formule } from '../outils.js';
import { rafraichir } from '../app.js';
import { rendreInventaire, brancherInventaire, importEnCours } from './produits.js';

const TONS_DOSSIER = { a_demander: 'alerte', demande_envoyee: 'info', documents_requis: 'alerte', approuve: 'ok', refuse: 'erreur' };
const etat = { recherche: '' };

function paramUrl(nom) {
  return new URLSearchParams(location.hash.split('?')[1] || '').get(nom) || '';
}

function lienListe(filtre, tri) {
  const q = new URLSearchParams();
  if (filtre) q.set('filtre', filtre);
  if (tri) q.set('tri', tri);
  return `#/asins${q.size ? '?' + q : ''}`;
}

// Actif : au moins une unité en stock au dernier import d'inventaire ; inactif : 0 (ou jamais importé).
// Stock total = stock chez Amazon (import) + en transit + à envoyer (acheté sur factures, pas encore expédié).
const total = (p) => p.stock_total?.total ?? 0;
const estActif = (p) => total(p) > 0;

// Seuil d'alerte « stock bas » : préférence d'affichage, enregistrée dans ce navigateur.
const SEUIL_DEFAUT = 5;
function lireSeuil() {
  try {
    const v = Number(localStorage.getItem('mondaix.seuil_stock'));
    return Number.isInteger(v) && v >= 0 && localStorage.getItem('mondaix.seuil_stock') !== null ? v : SEUIL_DEFAUT;
  } catch {
    return SEUIL_DEFAUT;
  }
}
function ecrireSeuil(v) {
  try {
    localStorage.setItem('mondaix.seuil_stock', String(v));
  } catch {
    // stockage indisponible : seuil par défaut
  }
}

/** État du stock : rupture (0), bas (≤ seuil), en stock. */
export function etatStock(quantite, seuil = lireSeuil()) {
  if (!quantite) return { cle: 'rupture', badge: badge('Rupture', 'erreur') };
  if (quantite <= seuil) return { cle: 'bas', badge: badge('Stock bas', 'alerte') };
  return { cle: 'en_stock', badge: badge('En stock', 'ok') };
}

const TRIS = {
  '': ['Dernière facture', null],
  variation: ['Plus grande variation de stock', (a, b) => Math.abs(b.stock?.ecart ?? -1) - Math.abs(a.stock?.ecart ?? -1)],
  cout: ['Coût unitaire le plus bas', (a, b) => (a.cout_retenu ?? Infinity) - (b.cout_retenu ?? Infinity)],
};

/* ------------------------------------------------------------------ liste */

export async function pageAsins(zone) {
  const filtre = paramUrl('filtre');
  const tri = TRIS[paramUrl('tri')] ? paramUrl('tri') : '';
  const seuil = lireSeuil();
  const [liste, ecarts, refs] = await Promise.all([api('/api/produits'), api('/api/ecarts-couts'), references()]);
  const asinsEcart = new Set(ecarts.map((e) => e.asin));
  const filtres = {
    '': ['Tous', () => true],
    actifs: ['Actifs (en stock)', estActif],
    inactifs: ['Inactifs (0 en stock)', (p) => !estActif(p)],
    bas: ['Stock bas', (p) => etatStock(total(p), seuil).cle === 'bas'],
    incoherent: ['Amazon > acheté', (p) => p.stock_total.incoherent],
    ecarts: ['Écarts de coût', (p) => asinsEcart.has(p.asin)],
    sans_cout: ['Sans coût d’achat', (p) => p.cout_retenu === null],
    autorisation: ['Autorisation non confirmée', (p) => !p.autorisation?.confirme],
  };
  const q = etat.recherche.toLowerCase();
  const visibles = liste.filter((p) => (filtres[filtre] || filtres[''])[1](p) && (!q || [p.asin, p.titre, p.sku].some((v) => String(v || '').toLowerCase().includes(q))));
  if (TRIS[tri][1]) visibles.sort(TRIS[tri][1]);

  zone.innerHTML = `
    ${entetePage({
      titre: 'Stocks',
      sousTitre: 'Stock total par ASIN : chez Amazon (votre import d’inventaire Amazon) + en transit + à envoyer (acheté sur vos factures, pas encore expédié). Cliquez sur un ASIN pour sa page Amazon, sur « fiche » pour son historique.',
      actions: `<button type="button" class="principal" id="ouvrir-import">${icone('upload')}Importer l’inventaire</button>`,
    })}
    <div class="filtres">
      <div><label for="recherche-asin">Rechercher</label><input id="recherche-asin" type="search" value="${esc(etat.recherche)}" placeholder="ASIN, titre ou SKU"></div>
      <div><label for="tri-asin">Trier par</label><select id="tri-asin">${Object.entries(TRIS)
        .map(([t, [l]]) => `<option value="${t}" ${t === tri ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
      <div><label for="seuil-stock">Seuil d’alerte (unités) ${formule('« Stock bas » quand le stock est entre 1 et ce seuil ; « Rupture » à 0. Réglage enregistré dans ce navigateur.')}</label>
        <input id="seuil-stock" type="number" min="0" step="1" value="${seuil}" class="champ-court"></div>
    </div>
    <div class="onglets">${Object.entries(filtres)
      .map(([f, [t, fn]]) => `<a href="${lienListe(f, tri)}" class="${f === filtre ? 'actif' : ''}">${t} (${liste.filter(fn).length})</a>`)
      .join('')}</div>
    <p class="aide">${visibles.length} ASIN affiché(s)${q ? ` pour « ${esc(etat.recherche)} »` : ''}.</p>
    ${tableau(
      [
        'ASIN',
        'Titre',
        { t: 'Stock total', classe: 'num' },
        'État',
        { t: 'Chez Amazon', classe: 'num' },
        { t: 'En transit', classe: 'num' },
        { t: 'À envoyer', classe: 'num' },
        { t: 'Coût HT', classe: 'num' },
        { t: 'Acheté', classe: 'num' },
        { t: 'Dépensé', classe: 'num' },
        'Autorisation',
        'Dern. facture',
        { t: 'Emails', classe: 'num' },
      ],
      visibles.map((p) => {
        const a = p.autorisation;
        return `<tr>
          <td>${asinLien(p.asin)}</td>
          <td class="titre">${esc(p.titre || '')}${p.sku ? `<span class="aide sous">SKU ${esc(p.sku)}</span>` : ''}</td>
          <td class="num" data-tri="${total(p)}"><strong>${total(p)}</strong></td>
          <td>${etatStock(total(p), seuil).badge}<span class="aide sous">${estActif(p) ? 'actif' : 'inactif'}</span></td>
          <td class="num" data-tri="${p.stock.quantite}">${celluleStock(p.stock)}${p.stock_total.incoherent
            ? `<span class="sous" title="Chez Amazon + en transit (${p.stock_total.amazon + p.stock_total.en_transit}) dépasse les unités achetées sur vos factures (${p.stock_total.achetees}) : une facture manque probablement.">${badge('> acheté', 'alerte')}</span>` : ''}</td>
          <td class="num">${p.stock_total.en_transit}</td>
          <td class="num">${p.stock_total.a_envoyer}</td>
          <td class="num">${montant(p.cout_retenu)}${asinsEcart.has(p.asin) ? '<br>' + badge('écart', 'alerte') : ''}</td>
          <td class="num">${p.unites_achetees}</td>
          <td class="num">${celluleDepense(p.depenses_factures)}</td>
          <td>${a ? `<a href="#/dossiers/${a.dossier_id}">${badge(refs.statuts_dossier[a.statut] + (a.confirme ? ' ✓' : ''), TONS_DOSSIER[a.statut])}</a>` : badge('aucun dossier')}</td>
          <td>${date(p.derniere_facture)}</td>
          <td class="num">${p.nb_emails}</td></tr>`;
      }),
      q || filtre ? 'Aucun ASIN ne correspond à ces critères.' : 'Aucun ASIN : importez votre fichier d’inventaire ou déposez une facture.',
      { videAction: q || filtre ? { libelle: 'Voir tous les ASIN', href: '#/asins' } : { libelle: 'Déposer une facture', href: '#/factures' } },
    )}
    <p class="aide">Stock total = chez Amazon (dernier import, qui remplace le précédent) + en transit + à envoyer. Le stock chez Amazon fait partie des unités achetées :
      à envoyer = achetées sur factures − unités sorties (envoyées, ou vues chez Amazon, en transit ou vendues). « Amazon > acheté » signale une facture probablement manquante.</p>
    <details class="carte" id="bloc-import" ${importEnCours() ? 'open' : ''}><summary><strong>Importer le fichier d’inventaire</strong> (colonne cost = coût d’achat unitaire HT)</summary>
      <div id="inventaire" class="pile">${rendreInventaire()}</div></details>`;

  const recherche = zone.querySelector('#recherche-asin');
  let delai;
  recherche.oninput = () => {
    clearTimeout(delai);
    delai = setTimeout(async () => {
      etat.recherche = recherche.value;
      await rafraichir();
      const champ = document.getElementById('recherche-asin');
      champ?.focus();
      champ?.setSelectionRange(champ.value.length, champ.value.length);
    }, 300);
  };
  zone.querySelector('#tri-asin').onchange = (e) => (location.hash = lienListe(filtre, e.target.value));
  zone.querySelector('#seuil-stock').onchange = (e) => {
    const v = Math.max(0, Math.floor(Number(e.target.value) || 0));
    ecrireSeuil(v);
    rafraichir();
  };
  zone.querySelector('#ouvrir-import').onclick = () => {
    const bloc = zone.querySelector('#bloc-import');
    bloc.open = true;
    bloc.scrollIntoView({ behavior: 'smooth', block: 'start' });
    bloc.querySelector('summary').focus({ preventScroll: true });
  };
  brancherInventaire(zone);
}

function ecartTexte(ecart) {
  if (ecart === null || ecart === undefined) return '';
  if (ecart === 0) return '= 0';
  return `${icone(ecart > 0 ? 'arrow-up' : 'arrow-down', 14)}${ecart > 0 ? '+' : '−'}${Math.abs(ecart)}`;
}

function celluleDepense(d) {
  if (!d.nb_factures) return '<span class="aide">—</span>';
  return `<strong>${montant(d.montant)}</strong><span class="aide sous">${d.nb_factures} facture(s) · ${d.unites} u.</span>`;
}

function celluleStock(s) {
  return `<strong>${s.quantite}</strong>${s.ecart !== null && s.ecart !== 0 ? `<span class="variation">${ecartTexte(s.ecart)}</span>` : ''}`;
}

/* ------------------------------------------------------------------ fiche */

const TYPES_EVENEMENT = {
  annulation: ['Facture annulée', 'erreur'],
  facture: ['Facture', 'info'],
  reception: ['Réception', 'ok'],
  envoi: ['Envoi Amazon', 'ok'],
  cout: ['Coût', ''],
  autorisation: ['Autorisation', 'alerte'],
  email_gmail: ['Gmail', ''],
  email_neo: ['Neo', ''],
  depense: ['Dépense', ''],
  stock: ['Stock', ''],
};

function tuile(valeur, libelle) {
  return `<div class="tuile"><div class="valeur">${valeur}</div><div class="libelle">${esc(libelle)}</div></div>`;
}

export async function pageAsin(zone, asin) {
  const [p, refs] = await Promise.all([api(`/api/produits/${encodeURIComponent(asin)}`), references()]);
  const cc = p.cout_complet;
  const dernierDossier = p.dossiers[0];
  const df = p.depenses_factures;

  zone.innerHTML = `
    ${entetePage({
      retour: { href: '#/asins', libelle: '← Stocks' },
      titreHtml: asinLien(p.asin, { fiche: false }),
      sousTitre: `${esc(p.titre || 'Sans titre')}${p.sku ? ' · SKU ' + esc(p.sku) : ''} · ${etatStock(p.stock_total.total).badge}`,
      actions: `<a class="bouton" href="${esc(urlAmazon(p.asin))}" target="_blank" rel="noopener noreferrer">${icone('external-link')}Ouvrir sur Amazon</a>
        <button type="button" id="modifier">Titre / SKU</button><button type="button" class="principal" id="cout-manuel">${icone('plus')}Saisir un coût</button>`,
    })}

    <div class="grille grille-4">
      ${tuile(p.stock_total.total, 'Stock total (Amazon + en transit + à envoyer)')}
      ${tuile(`${p.stock.quantite}${p.stock.ecart ? ` <span class="variation">${ecartTexte(p.stock.ecart)}</span>` : ''}`, 'Chez Amazon (dernier import)')}
      ${tuile(p.stock_total.en_transit, `En transit vers Amazon (${p.unites_recues_amazon} reçue(s) au total)`)}
      ${tuile(p.stock_total.a_envoyer, `À envoyer (sur ${p.unites_achetees} achetée(s), hors Amazon, transit et ventes)`)}
      ${tuile(montant(cc.par_unite.achat), 'Coût d’achat HT retenu / unité')}
      ${tuile(montant(df.cout_moyen_unite), `Coût moyen facturé / unité (${df.unites} u.)`)}
      ${tuile(montant(cc.cout_complet_unitaire), 'Coût complet / unité')}
      ${tuile(montant(df.montant), `Dépense totale (${df.nb_factures} facture(s))`)}
    </div>

    ${p.stock_total.incoherent ? `<div class="message alerte">Chez Amazon + en transit (${p.stock_total.amazon + p.stock_total.en_transit} unités) dépasse les unités achetées sur vos factures (${p.stock_total.achetees}).
      Le stock chez Amazon ne peut pas dépasser ce qui a été acheté : une facture manque probablement pour cet ASIN.</div>` : ''}
    <div class="deux-colonnes">
      <div class="carte"><h3 class="sans-marge">Coût complet par unité ${formule('Coût complet = achat HT + frais des factures (au prorata) + frais d’envoi Amazon (au prorata des unités) + dépenses rattachées à l’ASIN.')}</h3>
        <table><tbody>
          <tr><td>Achat HT</td><td class="num">${montant(cc.par_unite.achat)}</td></tr>
          <tr><td>Frais des factures (livraison${cc.taxes_incluses ? ', taxes' : ''}, autres)</td><td class="num">${montant(cc.par_unite.frais_facture)}</td></tr>
          <tr><td>Envoi Amazon (préparation, transport)</td><td class="num">${montant(cc.par_unite.frais_envoi)}</td></tr>
          <tr><td>Dépenses rattachées à l’ASIN</td><td class="num">${montant(cc.par_unite.frais_directs)}</td></tr>
          <tr><td><strong>Total</strong></td><td class="num"><strong>${montant(cc.cout_complet_unitaire)}</strong></td></tr>
        </tbody></table>
        ${cc.alertes.map((a) => `<div class="message alerte pile">${esc(a)}</div>`).join('')}</div>
      <div class="carte"><h3 class="sans-marge">Autorisation de vente</h3>
        ${dernierDossier
          ? `<p>${badge(refs.statuts_dossier[dernierDossier.statut], TONS_DOSSIER[dernierDossier.statut])} ${dernierDossier.confirme ? badge('confirmé', 'ok') : badge('non confirmé', 'alerte')}</p>
             <p>N° de cas : <span class="mono">${esc(dernierDossier.numero_cas || '—')}</span> · <a href="#/dossiers/${dernierDossier.id}">ouvrir le dossier</a></p>`
          : '<p>Aucun dossier. <a href="#/autorisations?filtre=tous">Créer un dossier</a></p>'}
        <p class="aide sous">${p.emails.length} email(s) lié(s) à cet ASIN.</p></div>
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
          <td>${esc(h.reference || '')}</td>
          <td class="num">${montant(h.montant_unitaire_ht)}</td>
          <td class="num">${h.retenu ? badge('retenu', 'ok') : h.ecart ? `<span class="${h.ecart_traite ? '' : 'badge alerte'}">${montant(h.ecart)}</span>` : '='}</td>
          <td>${h.retenu ? '' : `<button class="petit" data-retenir="${h.id}">Retenir cette valeur</button>`}</td></tr>`,
      ),
      'Aucun coût enregistré.',
    )}

    <div class="section-titre"><h2>Factures</h2><button type="button" id="lier-facture">${icone('plus')}Lier une facture</button></div>
    <p class="aide">Dépense totale : ${montant(df.montant)}${df.nb_factures && !df.estimee ? ` = ${montant(df.ht)} d’articles HT + ${montant(df.frais)} de taxes, livraison et frais (part de l’ASIN)` : ''}.
      Quand une facture contient plusieurs ASIN, seule la part de cet ASIN est comptée${df.estimee ? ' ; sans prix unitaire, la part est estimée selon les quantités' : ''}.</p>
    ${tableau(
      ['Date', 'Facture', 'Autres ASIN de la facture', 'Articles de cet ASIN', { t: 'Total facture', classe: 'num' }, { t: 'Part de l’ASIN', classe: 'num' }],
      p.factures.map((f) => `<tr><td>${date(f.date_facture)}</td><td>${esc(f.numero_facture || '#' + f.id)}${f.document_id ? ` · <a href="/api/factures/documents/${f.document_id}/fichier" target="_blank" rel="noopener">document</a>` : ''}
          ${f.annulee ? `<div>${badge('annulée · remboursée', 'erreur')}</div>` : ''}</td>
        <td>${f.autres_asins.length ? `+ ${f.autres_asins.map((a) => asinLien(a)).join(', ')}` : '<span class="aide">ASIN seul</span>'}</td>
        <td>${f.lignes_asin.map((l) => `${l.quantite} × ${montant(l.prix_unitaire_ht)} HT${f.annulee ? '' : ` <button class="petit" data-retirer-ligne="${l.id}" title="Retirer cet article de la facture">retirer</button>`}`).join('<br>')}</td>
        <td class="num">${montant(f.total_calcule)}</td>
        <td class="num">${f.part_asin ? `<strong>${montant(f.part_asin.montant)}</strong>${f.part_asin.estimee ? '<span class="aide sous">estimée (quantités)</span>' : ''}` : '—'}</td></tr>`),
      'Aucune facture liée. Cliquez sur « Lier une facture ».',
    )}

    <h2>Envois Amazon</h2>
    ${tableau(
      ['Date d’expédition', 'Envoi', 'Statut', { t: 'Envoyé', classe: 'num' }, { t: 'Reçu par Amazon', classe: 'num' }],
      p.envois.map((e) => `<tr><td>${date(e.date)}</td><td><a href="#/envois/${e.id}">${esc(e.numero_envoi || '#' + e.id)}</a></td>
        <td>${esc(refs.statuts_envoi[e.statut])}</td><td class="num">${e.quantite}</td>
        <td class="num">${e.quantite_recue === null ? (e.statut === 'en_preparation' ? '—' : badge('à vérifier', 'info'))
          : e.quantite_recue === e.quantite ? `${e.quantite_recue} ${badge('OK', 'ok')}` : `${e.quantite_recue} ${badge(`écart ${e.quantite_recue - e.quantite > 0 ? '+' : '−'}${Math.abs(e.quantite_recue - e.quantite)}`, 'erreur')}`}</td></tr>`),
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

  `;

  zone.querySelectorAll('[data-retenir]').forEach((b) => {
    b.onclick = async () => {
      if (await tenter(() => post(`/api/produits/${asin}/retenir`, { cout_id: Number(b.dataset.retenir) }), 'Coût retenu mis à jour (ancien conservé dans l’historique).')) rafraichir();
    };
  });
  zone.querySelector('#lier-facture').onclick = () => lierFacture(asin, p);
  zone.querySelectorAll('[data-retirer-ligne]').forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmer({ titre: 'Retirer cet article ?', message: 'L’article est retiré de la facture. La facture et l’historique des coûts sont conservés.', libelle: 'Retirer' }))) return;
      if ((await tenter(() => suppr(`/api/facture-lignes/${b.dataset.retirerLigne}`), 'Article retiré.')) !== undefined) rafraichir();
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

/** Associe l'ASIN à une facture déjà enregistrée (ajout d'un article à la facture). */
async function lierFacture(asin, p) {
  const factures = await api('/api/factures');
  if (!factures.length) {
    await informer('Aucune facture', 'Aucune facture enregistrée. Déposez d’abord une facture dans Factures.');
    return;
  }
  const deja = new Set(p.factures.map((f) => f.id));
  factures.sort((a, b) => deja.has(a.id) - deja.has(b.id)); // factures pas encore liées en premier
  const libelle = (f) => `${f.numero_facture || '#' + f.id} · ${f.date_facture || 'sans date'} · ${f.fournisseur || 'fournisseur ?'} · ${montant(f.total_calcule)}${
    f.lignes.length ? ` · ${f.lignes.map((l) => l.asin).join(', ')}` : ' · aucun ASIN'}${deja.has(f.id) ? ' (déjà liée)' : ''}`;
  const ok = await modale({
    titre: `Lier une facture à ${asin}`,
    contenu: `<div class="champs">
        <div class="pleine-largeur"><label for="f-facture">Facture</label><select id="f-facture" name="facture_id" required>
          ${factures.map((f) => `<option value="${f.id}">${esc(libelle(f))}</option>`).join('')}</select></div>
        ${champ('quantite', 'Quantité de cet ASIN', { type: 'number', attrs: 'min="1" step="1" required' })}
        ${champ('prix_unitaire_ht', 'Prix unitaire HT (facultatif)')}</div>
      <div id="articles-facture" class="aide"></div>
      <p class="aide">Si la facture contient d’autres articles, ils restent associés à leurs ASIN : seule la part de cet ASIN (au prorata du montant HT) est comptée dans sa dépense.</p>`,
    libelleValider: 'Lier',
    apresOuverture: (form) => {
      const select = form.querySelector('[name=facture_id]');
      const montrer = () => {
        const f = factures.find((x) => String(x.id) === select.value);
        const articles = f?.articles_extraits || [];
        form.querySelector('#articles-facture').innerHTML = articles.length
          ? `Articles lus sur la facture : ${articles.map((a) => `${esc(a.description || '?')} (${a.quantite ?? '?'} × ${montant(a.prix_unitaire_ht)})`).join(' ; ')}`
          : '';
      };
      select.onchange = montrer;
      montrer();
    },
    valider: (d) => post(`/api/factures/${d.facture_id}/lignes`, { asin, quantite: d.quantite, prix_unitaire_ht: d.prix_unitaire_ht }),
  });
  if (ok) rafraichir();
}
