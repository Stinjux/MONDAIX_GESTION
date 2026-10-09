import { api, post, suppr, confirmer, esc, montant, date, badge, tableau, modale, champ, selecteur, tenter, toast, references, lireFichierTexte, asinLien, entetePage, icone } from '../outils.js';
import { rafraichir } from '../app.js';

const etatInv = { analyse: null, texte: '', nom: '' };

/** Une analyse de fichier est en cours (le bloc d'import reste ouvert). */
export const importEnCours = () => Boolean(etatInv.analyse);

export function rendreInventaire() {
  if (!etatInv.analyse) {
    return `<p class="aide">Fichier CSV ou TSV exporté de votre inventaire Amazon : colonnes ASIN, quantité et, si présent, cost (coût d’achat unitaire HT).</p>
      <label class="depot" for="fichier-inv">${icone('upload', 20)}<span>Choisir le fichier d’inventaire (.csv, .tsv)</span>
        <input type="file" id="fichier-inv" accept=".csv,.tsv,.txt"></label>`;
  }
  const a = etatInv.analyse;
  const options = [['', '— non utilisée —'], ...a.entetes.map((h, i) => [i, h])];
  return `<h3 class="sans-marge">Associer les colonnes · ${esc(etatInv.nom)} · ${a.nb_lignes} ligne(s)</h3>
    <div class="champs">${Object.entries(a.champs).map(([cle, def]) => selecteur(`inv-${cle}`, def.libelle + (def.obligatoire ? ' *' : ''), options, a.mapping[cle] ?? '', `data-champ="${cle}"`)).join('')}</div>
    <div class="message info">Le cost importé est conservé dans l’historique. S’il diffère du coût déjà retenu, l’écart est signalé et c’est à vous de choisir la valeur.</div>
    <div class="actions"><button type="button" class="principal" id="importer-inv">${icone('upload')}Importer</button><button type="button" id="annuler-inv">Annuler</button></div>`;
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
  const [depenses, refs, envois] = await Promise.all([api('/api/depenses'), references(), api('/api/envois')]);
  const supprimer = async (liste) => {
    if (!liste.length) return;
    const ok = await confirmer({
      titre: liste.length === 1 ? 'Supprimer cette dépense ?' : `Supprimer ${liste.length} dépenses ?`,
      message: 'La suppression est définitive ; le coût complet des ASIN concernés sera recalculé.',
      libelle: 'Supprimer',
    });
    if (!ok) return;
    for (const id of liste) if ((await tenter(() => suppr(`/api/depenses/${id}`))) === undefined) break;
    rafraichir();
  };
  zone.innerHTML = `
    ${entetePage({
      titre: 'Dépenses',
      sousTitre: 'Dépenses hors facture (préparation, transport vers Amazon, autres) entrant dans le coût complet, rattachées à un envoi Amazon ou à un ASIN. Les frais des factures sont déjà comptés avec la facture.',
      actions: `<button type="button" class="principal" id="nouvelle">${icone('plus')}Nouvelle dépense</button>`,
    })}
    ${tableau(
      ['Date', 'Type', 'Rattachée à', 'Description', { t: 'Montant', classe: 'num' }, { t: '', tri: false }],
      depenses.map(
        (d) => `<tr data-id="${d.id}"><td>${date(d.date_depense || d.created_at)}</td><td>${esc(refs.types_depense[d.type])}</td>
          <td>${d.envoi_id ? `<a href="#/envois/${d.envoi_id}">envoi ${esc(d.numero_envoi || '#' + d.envoi_id)}</a>` : d.asin ? `${asinLien(d.asin)} (${d.quantite_concernee} u.)` : '<span class="aide">non rattachée (non comptée)</span>'}</td>
          <td>${esc(d.description || '')}</td><td class="num">${montant(d.montant)}</td>
          <td class="actions-ligne"><button type="button" class="petit danger" data-suppr="${d.id}">${icone('trash-2')}Supprimer</button></td></tr>`,
      ),
      'Aucune dépense : ajoutez les frais de préparation ou de transport avec « Nouvelle dépense ».',
      { selection: [{ libelle: 'Supprimer', icone: 'trash-2', action: (ids) => supprimer(ids) }] },
    )}`;
  zone.querySelectorAll('[data-suppr]').forEach((b) => (b.onclick = () => supprimer([b.dataset.suppr])));
  zone.querySelector('#nouvelle').onclick = async () => {
    const ok = await modale({
      titre: 'Nouvelle dépense',
      contenu: `<div class="champs">${selecteur('type', 'Type', Object.entries(refs.types_depense))}${champ('montant', 'Montant')}${champ('date_depense', 'Date', { type: 'date' })}${champ('description', 'Description')}</div>
        <h3>Rattacher à</h3><div class="champs">
        ${selecteur('envoi_id', 'Envoi Amazon', [['', '—'], ...envois.map((e) => [e.id, e.numero_envoi || '#' + e.id])])}
        ${champ('asin', 'ou ASIN')}${champ('quantite_concernee', 'Unités concernées (si ASIN)')}</div>`,
      valider: (d) => post('/api/depenses', d),
    });
    if (ok) rafraichir();
  };
}
