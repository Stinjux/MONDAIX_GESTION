import { api, post, suppr, esc, montant, date, badge, tableau, modale, champ, selecteur, tenter, toast, references, lireFichierTexte } from '../outils.js';
import { rafraichir } from '../app.js';

const etatInv = { analyse: null, texte: '', nom: '' };

export async function pageProduits(zone) {
  const filtre = new URLSearchParams(location.hash.split('?')[1] || '').get('filtre') || '';
  const [produits, ecarts] = await Promise.all([api('/api/produits'), api('/api/ecarts-couts')]);
  const asinsEcart = new Set(ecarts.map((e) => e.asin));
  const visibles = produits.filter((p) => (filtre === 'ecarts' ? asinsEcart.has(p.asin) : filtre === 'sans_cout' ? p.cout_retenu === null : true));
  zone.innerHTML = `
    <div class="entete"><div><h1>ASIN &amp; coûts</h1>
      <p class="aide">Le champ <strong>cost</strong> du fichier d’inventaire est le prix d’achat unitaire hors taxes : sans livraison, préparation ni transport vers Amazon.
      Le coût complet est calculé à part, à partir des dépenses effectivement enregistrées.</p></div></div>
    <div class="carte" id="inventaire">${rendreInventaire()}</div>
    <div class="onglets">${[['', 'Tous'], ['ecarts', `Écarts de coût (${asinsEcart.size})`], ['sans_cout', 'Sans coût d’achat']]
      .map(([f, t]) => `<a href="#/produits${f ? '?filtre=' + f : ''}" class="${f === filtre ? 'actif' : ''}">${t}</a>`).join('')}</div>
    ${tableau(
      ['ASIN', 'SKU', 'Titre', { t: 'Coût d’achat HT retenu', classe: 'num' }, 'Source', { t: 'Stock (inventaire)', classe: 'num' }, { t: 'Unités commandées', classe: 'num' }, ''],
      visibles.map(
        (p) => `<tr><td class="mono"><a href="#/produits/${p.asin}">${p.asin}</a></td><td>${esc(p.sku || '')}</td><td>${esc(p.titre || '')}</td>
          <td class="num">${montant(p.cout_retenu)}</td><td>${esc(p.source_cout || '—')}</td><td class="num">${p.quantite_inventaire ?? '—'}</td>
          <td class="num">${p.unites_commandees}</td><td>${asinsEcart.has(p.asin) ? badge('écart à arbitrer', 'alerte') : ''}</td></tr>`,
      ),
      'Aucun ASIN.',
    )}`;
  brancherInventaire(zone);
}

function rendreInventaire() {
  if (!etatInv.analyse) {
    return `<h3 style="margin-top:0">Importer le fichier d’inventaire</h3>
      <div class="actions"><input type="file" id="fichier-inv" accept=".csv,.tsv,.txt"></div>`;
  }
  const a = etatInv.analyse;
  const options = [['', '— non utilisée —'], ...a.entetes.map((h, i) => [i, h])];
  return `<h3 style="margin-top:0">Associer les colonnes · ${a.nb_lignes} ligne(s)</h3>
    <div class="champs">${Object.entries(a.champs).map(([cle, def]) => selecteur(`inv-${cle}`, def.libelle + (def.obligatoire ? ' *' : ''), options, a.mapping[cle] ?? '', `data-champ="${cle}"`)).join('')}</div>
    <div class="message info">Le cost importé est conservé dans l’historique. S’il diffère du coût déjà retenu, l’écart est signalé et c’est à vous de choisir la valeur.</div>
    <div class="actions"><button class="principal" id="importer-inv">Importer</button><button id="annuler-inv">Annuler</button></div>`;
}

function brancherInventaire(zone) {
  const f = zone.querySelector('#fichier-inv');
  if (f) {
    f.onchange = async () => {
      const fichier = f.files[0];
      if (!fichier) return;
      const texte = await lireFichierTexte(fichier);
      const r = await tenter(() => post('/api/imports/inventaire/analyser', { texte }));
      if (!r) return;
      Object.assign(etatInv, { analyse: r, texte, nom: fichier.name });
      rafraichir();
    };
    return;
  }
  zone.querySelectorAll('select[data-champ]').forEach((s) => {
    s.onchange = () => (s.value === '' ? delete etatInv.analyse.mapping[s.dataset.champ] : (etatInv.analyse.mapping[s.dataset.champ] = Number(s.value)));
  });
  zone.querySelector('#annuler-inv').onclick = () => ((etatInv.analyse = null), rafraichir());
  zone.querySelector('#importer-inv').onclick = async () => {
    const r = await tenter(() => post('/api/imports/inventaire', { texte: etatInv.texte, mapping: etatInv.analyse.mapping, nom: etatInv.nom }));
    if (!r) return;
    toast(`${r.produits} ASIN mis à jour, ${r.couts_ajoutes} coût(s) ajouté(s), ${r.ecarts.length} écart(s), ${r.rejets.length} rejet(s).`);
    etatInv.analyse = null;
    rafraichir();
  };
}

export async function pageProduit(zone, asin) {
  const [p, refs] = await Promise.all([api(`/api/produits/${asin}`), references()]);
  const cc = p.cout_complet;
  zone.innerHTML = `
    <div class="entete"><div><a href="#/produits">← ASIN &amp; coûts</a>
      <h1 class="mono">${esc(p.asin)}</h1><p class="aide">${esc(p.titre || 'Sans titre')} ${p.sku ? '· SKU ' + esc(p.sku) : ''}</p></div>
      <div class="actions"><button id="cout-manuel">Saisir un coût</button></div></div>

    <div class="deux-colonnes">
      <div class="carte"><h3 style="margin-top:0">Coût d’achat unitaire HT retenu</h3>
        <div style="font-size:24px;font-weight:700">${montant(cc.par_unite.achat)}</div>
        <p class="aide">${p.cout_retenu ? `Source : ${esc(refs.sources_cout[p.cout_retenu.source])}${p.cout_retenu.reference ? ' · ' + esc(p.cout_retenu.reference) : ''}` : 'Aucun coût connu.'}</p></div>
      <div class="carte"><h3 style="margin-top:0">Coût complet unitaire</h3>
        <div style="font-size:24px;font-weight:700">${montant(cc.cout_complet_unitaire)}</div>
        <table style="margin-top:6px"><tbody>
          <tr><td>Achat HT</td><td class="num">${montant(cc.par_unite.achat)}</td></tr>
          <tr><td>Frais de commande (livraison${cc.taxes_incluses ? ', taxes' : ''}, autres)</td><td class="num">${montant(cc.par_unite.frais_commande)}</td></tr>
          <tr><td>Envoi Amazon (préparation, transport)</td><td class="num">${montant(cc.par_unite.frais_envoi)}</td></tr>
          <tr><td>Dépenses rattachées à l’ASIN</td><td class="num">${montant(cc.par_unite.frais_directs)}</td></tr>
        </tbody></table>
        ${cc.alertes.map((a) => `<div class="message alerte" style="margin:6px 0 0">${esc(a)}</div>`).join('')}</div>
    </div>

    <h2>Historique des coûts d’achat unitaires HT</h2>
    <p class="aide">Aucune valeur n’est écrasée. Choisissez la valeur à retenir en cas d’écart.</p>
    ${tableau(
      ['Date', 'Source', 'Référence', { t: 'Montant HT', classe: 'num' }, { t: 'Écart / retenu', classe: 'num' }, ''],
      p.historique.map(
        (h) => `<tr><td>${date(h.created_at)}</td><td>${esc(refs.sources_cout[h.source])}</td>
          <td>${h.commande_id ? `<a href="#/commandes/${h.commande_id}">${esc(h.reference || '')}</a>` : esc(h.reference || '')}</td>
          <td class="num">${montant(h.montant_unitaire_ht)}</td>
          <td class="num">${h.retenu ? badge('retenu', 'ok') : h.ecart ? `<span class="${h.ecart_traite ? '' : 'badge alerte'}">${montant(h.ecart)}</span>` : '='}</td>
          <td>${h.retenu ? '' : `<button class="petit" data-retenir="${h.id}">Retenir cette valeur</button>`}</td></tr>`,
      ),
      'Aucun coût enregistré.',
    )}

    <h2>Autorisation de vente Amazon</h2>
    ${p.dossiers.length ? tableau(
      ['Dossier', 'Statut', 'Confirmé', 'N° de cas', 'Réponses Neo'],
      p.dossiers.map((d) => `<tr><td><a href="#/dossiers/${d.id}">#${d.id}</a></td><td>${esc(refs.statuts_dossier[d.statut])}</td>
        <td>${d.statut_confirme ? badge('confirmé', 'ok') : badge('non confirmé', 'alerte')}</td><td class="mono">${esc(d.numero_cas || '—')}</td>
        <td>${d.reponses.map((r) => `${date(r.date_reception)} · ${esc(r.sujet || '')}`).join('<br>') || '—'}</td></tr>`),
    ) : `<div class="carte">Aucun dossier. <a href="#/autorisations">Créer un dossier</a></div>`}

    <h2>Commandes</h2>
    ${tableau(
      ['Commande', 'Fournisseur', 'Date', { t: 'Qté', classe: 'num' }, { t: 'Coût unitaire (commande)', classe: 'num' }],
      p.commandes.map((c) => `<tr><td><a href="#/commandes/${c.id}">${esc(c.numero_commande || '#' + c.id)}</a></td><td>${esc(c.fournisseur || '—')}</td>
        <td>${date(c.date_commande)}</td><td class="num">${c.quantite}</td><td class="num">${montant(c.cout_unitaire_ht)}</td></tr>`),
      'Aucune commande.',
    )}`;

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
}

export async function pageDepenses(zone) {
  const [depenses, refs, commandes, envois] = await Promise.all([api('/api/depenses'), references(), api('/api/commandes'), api('/api/envois')]);
  zone.innerHTML = `
    <div class="entete"><div><h1>Dépenses</h1>
      <p class="aide">Seules les dépenses enregistrées ici (ou issues d’une facture) entrent dans le coût complet.
      Une dépense se rattache à une commande, à un envoi Amazon ou directement à un ASIN.</p></div>
      <button class="principal" id="nouvelle">Nouvelle dépense</button></div>
    ${tableau(
      ['Date', 'Type', 'Rattachée à', 'Description', { t: 'Montant', classe: 'num' }, ''],
      depenses.map(
        (d) => `<tr><td>${date(d.date_depense || d.created_at)}</td><td>${esc(refs.types_depense[d.type])}</td>
          <td>${d.commande_id ? `<a href="#/commandes/${d.commande_id}">commande ${esc(d.numero_commande || '#' + d.commande_id)}</a>` : d.envoi_id ? `<a href="#/envois/${d.envoi_id}">envoi ${esc(d.numero_envoi || '#' + d.envoi_id)}</a>` : d.asin ? `<a href="#/produits/${d.asin}">${d.asin}</a> (${d.quantite_concernee} u.)` : '—'}</td>
          <td>${esc(d.description || '')}</td><td class="num">${montant(d.montant)}</td>
          <td>${d.facture_id ? badge('facture') : `<button class="petit danger" data-suppr="${d.id}">Supprimer</button>`}</td></tr>`,
      ),
      'Aucune dépense.',
    )}`;
  zone.querySelectorAll('[data-suppr]').forEach((b) => (b.onclick = async () => (await tenter(() => suppr(`/api/depenses/${b.dataset.suppr}`))) !== undefined && rafraichir()));
  zone.querySelector('#nouvelle').onclick = async () => {
    const ok = await modale({
      titre: 'Nouvelle dépense',
      contenu: `<div class="champs">${selecteur('type', 'Type', Object.entries(refs.types_depense))}${champ('montant', 'Montant')}${champ('date_depense', 'Date', { type: 'date' })}${champ('description', 'Description')}</div>
        <h3>Rattacher à</h3><div class="champs">
        ${selecteur('commande_id', 'Commande', [['', '—'], ...commandes.map((c) => [c.id, c.numero_commande || '#' + c.id])])}
        ${selecteur('envoi_id', 'Envoi Amazon', [['', '—'], ...envois.map((e) => [e.id, e.numero_envoi || '#' + e.id])])}
        ${champ('asin', 'ou ASIN')}${champ('quantite_concernee', 'Unités concernées (si ASIN)')}</div>`,
      valider: (d) => post('/api/depenses', d),
    });
    if (ok) rafraichir();
  };
}
