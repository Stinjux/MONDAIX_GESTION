import { api, post, suppr, esc, montant, date, badge, tableau, modale, champ, selecteur, tenter, toast, references, lireFichierTexte, asinLien } from '../outils.js';
import { rafraichir } from '../app.js';

const etatInv = { analyse: null, texte: '', nom: '' };

export function rendreInventaire() {
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

export function brancherInventaire(zone) {
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
    const st = r.stock ? ` Stock : ${r.stock.total} unité(s)${r.stock.ecart === null ? '' : ` (${r.stock.ecart >= 0 ? '+' : '−'}${Math.abs(r.stock.ecart)} depuis l’import précédent)`}.` : '';
    toast(`${r.produits} ASIN mis à jour, ${r.couts_ajoutes} coût(s) ajouté(s), ${r.ecarts.length} écart(s), ${r.rejets.length} rejet(s).${st}`);
    etatInv.analyse = null;
    rafraichir();
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
          <td>${d.commande_id ? `<a href="#/commandes/${d.commande_id}">commande ${esc(d.numero_commande || '#' + d.commande_id)}</a>` : d.envoi_id ? `<a href="#/envois/${d.envoi_id}">envoi ${esc(d.numero_envoi || '#' + d.envoi_id)}</a>` : d.asin ? `${asinLien(d.asin)} (${d.quantite_concernee} u.)` : '—'}</td>
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
