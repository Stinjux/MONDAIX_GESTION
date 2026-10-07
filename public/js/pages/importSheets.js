import { api, post, put, esc, montant, badge, toast, tenter, modale, champ, selecteur, selecteurTriEtat, lireFichierTexte, date } from '../outils.js';
import { rafraichir } from '../app.js';

// État conservé entre deux rendus de la page.
const etat = { analyse: null, texte: '', nom: '', selection: new Set(), filtreStatut: 'en_attente', filtreTexte: '', importId: '' };

export async function pageImportSheets(zone) {
  const [lignes, imports, fournisseurs, propositions] = await Promise.all([
    api(`/api/lignes-import?${new URLSearchParams({ statut: etat.filtreStatut, import_id: etat.importId })}`),
    api('/api/imports'),
    api('/api/fournisseurs'),
    api('/api/lignes-import/propositions'),
  ]);
  const importsSheets = imports.filter((i) => i.type === 'sheets');
  const filtre = etat.filtreTexte.toLowerCase();
  const visibles = lignes.filter((l) => !filtre || [l.asin, l.lien_original, l.fournisseur_valide, l.fournisseur_propose, l.fournisseur_propose_nom].some((v) => String(v || '').toLowerCase().includes(filtre)));
  for (const id of [...etat.selection]) if (!lignes.some((l) => l.id === id)) etat.selection.delete(id);

  zone.innerHTML = `
    <div class="entete"><div><h1>Import Google Sheets</h1>
      <p class="aide">Colonnes attendues : ASIN, site de commande, quantité achetée, prix total de la commande.
      Le prix total est celui de la <strong>commande</strong> : il n’est jamais réparti ni répété par ASIN.
      Les lignes ne sont jamais regroupées automatiquement ; sélectionnez celles qui appartiennent à une même commande.</p></div></div>

    <div class="carte" id="zone-chargement">${rendreChargement()}</div>

    <h2>Lignes importées</h2>
    <div class="actions" style="margin-bottom:8px">
      ${selecteur('filtre-statut', 'Statut', [['en_attente', 'En attente de rapprochement'], ['rattachee', 'Rattachées'], ['ignoree', 'Ignorées'], ['', 'Toutes']], etat.filtreStatut)}
      ${selecteur('filtre-import', 'Import', [['', 'Tous les imports'], ...importsSheets.map((i) => [i.id, `${i.nom} (${date(i.created_at)}) · ${i.en_attente} en attente`])], etat.importId)}
      <div><label for="filtre-texte">Filtrer (ASIN, site, fournisseur)</label><input id="filtre-texte" value="${esc(etat.filtreTexte)}" placeholder="ex. walmart"></div>
    </div>
    <div class="barre-outils" id="outils">${rendreOutils(lignes)}</div>
    ${rendreLignes(visibles, propositions)}
  `;

  brancherChargement(zone, fournisseurs);
  zone.querySelector('#f-filtre-statut').onchange = (e) => ((etat.filtreStatut = e.target.value), etat.selection.clear(), rafraichir());
  zone.querySelector('#f-filtre-import').onchange = (e) => ((etat.importId = e.target.value), rafraichir());
  zone.querySelector('#filtre-texte').onchange = (e) => ((etat.filtreTexte = e.target.value), rafraichir());

  const majOutils = () => {
    zone.querySelector('#outils').innerHTML = rendreOutils(lignes);
    brancherOutils(zone, lignes, fournisseurs);
  };
  zone.querySelectorAll('input[data-sel]').forEach((cb) => {
    cb.onchange = () => {
      const id = Number(cb.dataset.sel);
      cb.checked ? etat.selection.add(id) : etat.selection.delete(id);
      cb.closest('tr').classList.toggle('selection', cb.checked);
      majOutils();
    };
  });
  const tout = zone.querySelector('#sel-tout');
  if (tout) {
    tout.onchange = () => {
      zone.querySelectorAll('input[data-sel]').forEach((cb) => {
        if (cb.checked !== tout.checked) {
          cb.checked = tout.checked;
          cb.onchange();
        }
      });
    };
  }
  brancherOutils(zone, lignes, fournisseurs);
  brancherActionsLigne(zone, lignes);
}

/* ------------------------------------------------------------ chargement */

function rendreChargement() {
  if (!etat.analyse) {
    return `<h3 style="margin-top:0">1. Charger la feuille</h3>
      <div class="deux-colonnes">
        <div>
          <label>Fichier CSV / TSV (Google Sheets › Fichier › Télécharger › CSV)</label>
          <input type="file" id="fichier" accept=".csv,.tsv,.txt,text/csv">
          <div style="margin-top:12px"><label>… ou lien de la feuille (si partagée en lecture)</label>
          <div class="actions"><input id="url" style="flex:1" placeholder="https://docs.google.com/spreadsheets/d/…"><button type="button" id="telecharger">Charger</button></div></div>
        </div>
        <div><label>… ou coller les cellules copiées depuis Google Sheets (avec la ligne d’en-tête)</label>
          <textarea id="colle" placeholder="ASIN	Site	Quantité	Prix total"></textarea>
          <button type="button" id="analyser-colle">Analyser le contenu collé</button></div>
      </div>`;
  }
  const a = etat.analyse;
  const options = [['', '— non utilisée —'], ...a.entetes.map((h, i) => [i, h])];
  const champs = Object.entries(a.champs)
    .map(([cle, def]) => selecteur(`map-${cle}`, def.libelle + (def.obligatoire ? ' *' : ''), options, a.mapping[cle] ?? '', `data-champ="${cle}"`))
    .join('');
  return `<h3 style="margin-top:0">2. Vérifier l’association des colonnes · ${a.nb_lignes} ligne(s)</h3>
    <p class="aide">Associations proposées automatiquement à partir des en-têtes et du contenu ; corrigez-les si besoin.</p>
    <div class="champs">${champs}</div>
    <div id="apercu">${rendreApercu()}</div>
    <div class="message info">À l’import, chaque ligne est enregistrée <strong>en attente de rapprochement</strong> avec son lien d’origine.
      Aucune commande ni dépense n’est créée automatiquement.</div>
    <div class="actions">
      ${champ('nom-import', 'Nom de l’import', { valeur: etat.nom })}
      <button type="button" class="principal" id="importer" style="align-self:flex-end">Importer les lignes</button>
      <button type="button" id="annuler-import" style="align-self:flex-end">Annuler</button>
    </div>`;
}

function rendreApercu() {
  const a = etat.analyse;
  const cles = Object.keys(a.champs).filter((c) => a.mapping[c] !== undefined && a.mapping[c] !== '');
  if (!cles.length) return '<p class="aide">Aucune colonne associée.</p>';
  return `<div class="tableau"><table><thead><tr>${cles.map((c) => `<th>${esc(a.champs[c].libelle)}</th>`).join('')}</tr></thead>
    <tbody>${a.apercu.slice(0, 8).map((l) => `<tr>${cles.map((c) => `<td>${esc(l[a.mapping[c]])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function brancherChargement(zone, fournisseurs) {
  const analyser = async (texte, nom) => {
    const r = await tenter(() => post('/api/imports/sheets/analyser', { texte }));
    if (!r) return;
    etat.analyse = r;
    etat.texte = texte;
    etat.nom = nom || `Google Sheets ${new Date().toLocaleDateString('fr-CA')}`;
    rafraichir();
  };
  const fichier = zone.querySelector('#fichier');
  if (fichier) {
    fichier.onchange = async () => {
      const f = fichier.files[0];
      if (f) analyser(await lireFichierTexte(f), f.name);
    };
    zone.querySelector('#analyser-colle').onclick = () => analyser(zone.querySelector('#colle').value, 'Copier-coller');
    zone.querySelector('#telecharger').onclick = async () => {
      const url = zone.querySelector('#url').value.trim();
      if (!url) return;
      const r = await tenter(() => post('/api/imports/sheets/telecharger', { url }));
      if (r) analyser(r.texte, 'Google Sheets (lien)');
    };
    return;
  }
  zone.querySelectorAll('select[data-champ]').forEach((s) => {
    s.onchange = () => {
      const v = s.value;
      if (v === '') delete etat.analyse.mapping[s.dataset.champ];
      else etat.analyse.mapping[s.dataset.champ] = Number(v);
      zone.querySelector('#apercu').innerHTML = rendreApercu();
    };
  });
  zone.querySelector('#annuler-import').onclick = () => ((etat.analyse = null), rafraichir());
  zone.querySelector('#importer').onclick = async () => {
    const nom = zone.querySelector('#f-nom-import').value;
    const r = await tenter(() => post('/api/imports/sheets', { texte: etat.texte, mapping: etat.analyse.mapping, nom }));
    if (!r) return;
    toast(`${r.lignes} ligne(s) importée(s) en attente${r.anomalies ? `, ${r.anomalies} à corriger` : ''}${r.doublons ? `, ${r.doublons} doublon(s) possible(s)` : ''}.`);
    etat.analyse = null;
    etat.importId = String(r.import_id);
    etat.filtreStatut = 'en_attente';
    rafraichir();
  };
}

/* -------------------------------------------------------- lignes / outils */

function rendreLignes(lignes, propositions) {
  if (!lignes.length) return '<div class="carte vide">Aucune ligne.</div>';
  return `<div class="tableau"><table><thead><tr>
      <th><input type="checkbox" id="sel-tout" title="Tout sélectionner"></th><th>Import · ligne</th><th>ASIN</th><th>Lien d’origine</th>
      <th>Fournisseur</th><th class="num">Qté</th><th class="num">Total déclaré (commande)</th><th>État</th><th></th></tr></thead>
    <tbody>${lignes.map((l) => rendreLigne(l, propositions.find((p) => p.ligne_id === l.id))).join('')}</tbody></table></div>`;
}

function rendreLigne(l, prop) {
  const sel = etat.selection.has(l.id);
  const fournisseur = l.fournisseur_valide
    ? `${esc(l.fournisseur_valide)} ${badge('validé', 'ok')}`
    : l.fournisseur_propose
      ? `${esc(l.fournisseur_propose)} ${badge('proposé', 'alerte')}`
      : l.fournisseur_propose_nom
        ? `${esc(l.fournisseur_propose_nom)} ${badge('nouveau ?', 'alerte')}`
        : '—';
  const etatLigne =
    l.statut === 'rattachee'
      ? `<a href="#/commandes/${l.commande_id}">${esc(l.commande_numero || 'commande #' + l.commande_id)}</a>`
      : l.statut === 'ignoree'
        ? badge('ignorée')
        : badge('en attente', 'alerte');
  const alertes = [
    ...l.anomalies.map((a) => badge(a, 'erreur')),
    l.doublon_de_id ? badge('doublon possible d’un import précédent', 'alerte') : '',
    prop
      ? `<div>${prop.candidates
          .map(
            (c) => `<button class="petit" data-proposition='${esc(JSON.stringify({ ligne_id: l.id, ...c }))}' title="${esc(c.motifs.join(', '))}">
              ${c.ligne_commande_id ? 'Relier à' : 'Rattacher à'} ${esc(c.numero_commande || '#' + c.commande_id)}</button>`,
          )
          .join(' ')}${prop.ambigu ? ' ' + badge('ambigu : à choisir', 'alerte') : ''}</div>`
      : '',
  ].join(' ');
  return `<tr class="${sel ? 'selection' : ''}">
    <td>${l.statut === 'rattachee' ? '' : `<input type="checkbox" data-sel="${l.id}" ${sel ? 'checked' : ''}>`}</td>
    <td>${esc(l.import_nom)} · ${l.numero_ligne}</td>
    <td class="mono">${esc(l.asin || '?')}</td>
    <td><span class="lien-court" title="${esc(l.lien_original || '')}">${esc(l.lien_original || '—')}</span></td>
    <td>${fournisseur}</td>
    <td class="num">${l.quantite ?? '?'}</td>
    <td class="num">${montant(l.total_commande_declare)}${l.total_brut && l.total_commande_declare === null ? `<br>${esc(l.total_brut)}` : ''}</td>
    <td>${etatLigne}${alertes ? `<div>${alertes}</div>` : ''}</td>
    <td class="actions">${l.statut === 'rattachee' ? `<button class="petit" data-detacher="${l.id}">Détacher</button>` : `<button class="petit" data-corriger="${l.id}">Corriger</button>`}</td>
  </tr>`;
}

function selectionnees(lignes) {
  return lignes.filter((l) => etat.selection.has(l.id));
}

function rendreOutils(lignes) {
  const sel = selectionnees(lignes);
  if (!sel.length) return '<span class="aide">Sélectionnez les lignes d’une même commande pour les regrouper.</span>';
  const totaux = [...new Set(sel.map((l) => l.total_commande_declare).filter((t) => t !== null))];
  const sites = [...new Set(sel.map((l) => l.domaine || l.lien_original).filter(Boolean))];
  return `<strong>${sel.length} ligne(s)</strong>
    <span class="aide">Totaux déclarés : ${totaux.length ? totaux.map(montant).join(' / ') : 'aucun'} · Sites : ${esc(sites.join(', ') || '—')}</span>
    <button class="principal" data-outil="grouper">Regrouper en une commande</button>
    <button data-outil="une-par-ligne">Une commande par ligne</button>
    <button data-outil="rattacher">Rattacher à une commande existante</button>
    <button data-outil="fournisseur">Valider le fournisseur</button>
    <button data-outil="ignorer">Ignorer</button>
    <button data-outil="attente">Remettre en attente</button>
    <button data-outil="vider">Désélectionner</button>`;
}

function optionsFournisseurs(fournisseurs) {
  return [['', '— à préciser —'], ...fournisseurs.map((f) => [f.id, `${f.nom}${f.domaines.length ? ` (${f.domaines.join(', ')})` : ''}`])];
}

function brancherOutils(zone, lignes, fournisseurs) {
  zone.querySelectorAll('[data-outil]').forEach((b) => {
    b.onclick = async () => {
      const sel = selectionnees(lignes);
      const ids = sel.map((l) => l.id);
      const outil = b.dataset.outil;
      if (outil === 'vider') return etat.selection.clear(), rafraichir();
      if (outil === 'ignorer' || outil === 'attente') {
        if (await tenter(() => post('/api/lignes-import/statut', { ligne_ids: ids, statut: outil === 'ignorer' ? 'ignoree' : 'en_attente' }), 'Statut mis à jour.')) {
          etat.selection.clear();
          rafraichir();
        }
        return;
      }
      if (outil === 'fournisseur') return validerFournisseur(sel, fournisseurs);
      if (outil === 'grouper') return grouper(sel, fournisseurs);
      if (outil === 'une-par-ligne') return uneParLigne(sel);
      if (outil === 'rattacher') return rattacher(sel);
    };
  });
}

async function validerFournisseur(sel, fournisseurs) {
  const propose = sel.find((l) => l.fournisseur_propose_id)?.fournisseur_propose_id ?? '';
  const nomNouveau = sel.find((l) => l.fournisseur_propose_nom)?.fournisseur_propose_nom ?? '';
  const domaines = [...new Set(sel.map((l) => l.domaine).filter(Boolean))];
  const ok = await modale({
    titre: 'Valider le fournisseur',
    contenu: `<p class="aide">Liens d’origine : ${sel.map((l) => `<br><span class="mono">${esc(l.lien_original || '—')}</span>`).join('')}</p>
      <div class="champs">${selecteur('fournisseur_id', 'Fournisseur existant', optionsFournisseurs(fournisseurs), propose)}</div>
      <p class="aide">… ou créer un nouveau fournisseur :</p>
      <div class="champs">${champ('nom', 'Nom', { valeur: propose ? '' : nomNouveau })}${champ('domaines', 'Domaines (séparés par des virgules)', { valeur: domaines.join(', ') })}</div>`,
    libelleValider: 'Valider',
    valider: (d) =>
      post('/api/lignes-import/fournisseur', {
        ligne_ids: sel.map((l) => l.id),
        fournisseur_id: d.fournisseur_id || null,
        creer: !d.fournisseur_id && d.nom ? { nom: d.nom, domaines: d.domaines } : null,
      }),
  });
  if (ok) {
    toast('Fournisseur validé.');
    rafraichir();
  }
}

function contenuTotal(sel) {
  const totaux = [...new Set(sel.map((l) => l.total_commande_declare).filter((t) => t !== null))];
  if (totaux.length <= 1) {
    return `<div class="champs">${champ('total_declare', 'Total déclaré de la commande', { valeur: totaux[0] ?? '', attrs: 'inputmode="decimal"' })}</div>`;
  }
  return `<div class="message alerte">Les lignes indiquent des totaux différents. Choisissez le total de cette commande : les montants ne sont pas additionnés.</div>
    ${totaux.map((t, i) => `<label><input type="radio" name="choix_total" value="${t}" ${i === 0 ? 'checked' : ''}> ${montant(t)}</label>`).join('')}
    <label><input type="radio" name="choix_total" value="autre"> Autre montant : <input name="total_autre" inputmode="decimal" style="width:120px"></label>`;
}

function totalChoisi(d) {
  if (d.choix_total === undefined) return d.total_declare;
  return d.choix_total === 'autre' ? d.total_autre : d.choix_total;
}

async function grouper(sel, fournisseurs) {
  const valides = [...new Set(sel.map((l) => l.fournisseur_valide_id).filter(Boolean))];
  const proposes = [...new Set(sel.map((l) => l.fournisseur_propose_id).filter(Boolean))];
  const defaut = valides.length === 1 ? valides[0] : !valides.length && proposes.length === 1 ? proposes[0] : '';
  const numeros = [...new Set(sel.map((l) => l.numero_commande).filter(Boolean))];
  const dates = [...new Set(sel.map((l) => l.date_commande).filter(Boolean))];
  const r = await modale({
    titre: `Regrouper ${sel.length} ligne(s) en une commande`,
    contenu: `<p class="aide">${sel.map((l) => `<span class="mono">${esc(l.asin)}</span> × ${l.quantite}`).join(' · ')}</p>
      <div class="champs">
        ${champ('numero_commande', 'N° de commande', { valeur: numeros.length === 1 ? numeros[0] : '' })}
        ${champ('date_commande', 'Date de commande', { type: 'date', valeur: dates.length === 1 ? dates[0] : '' })}
        ${selecteur('fournisseur_id', 'Fournisseur', optionsFournisseurs(fournisseurs), defaut)}
      </div>
      ${contenuTotal(sel)}
      <h3>Composition du total déclaré</h3>
      <p class="aide">Laissez « inconnu » si vous ne savez pas : le total sera affiché tel quel, sans ventilation, puis comparé à la facture.</p>
      <div class="champs">${selecteurTriEtat('total_inclut_taxes', 'Inclut les taxes ?', null)}${selecteurTriEtat('total_inclut_livraison', 'Inclut la livraison ?', null)}</div>
      ${!valides.length && defaut ? '<div class="message alerte">Le fournisseur indiqué est une proposition : en l’enregistrant vous le validez pour cette commande.</div>' : ''}`,
    libelleValider: 'Créer la commande',
    valider: async (d) => {
      const res = await post('/api/lignes-import/grouper', {
        ligne_ids: sel.map((l) => l.id),
        numero_commande: d.numero_commande,
        date_commande: d.date_commande,
        fournisseur_id: d.fournisseur_id || null,
        total_declare: totalChoisi(d),
        total_inclut_taxes: d.total_inclut_taxes,
        total_inclut_livraison: d.total_inclut_livraison,
      });
      if (d.fournisseur_id) await post('/api/lignes-import/fournisseur', { ligne_ids: sel.map((l) => l.id), fournisseur_id: d.fournisseur_id });
      return res;
    },
  });
  if (!r) return;
  r.avertissements.forEach((a) => toast(a));
  toast('Commande créée.');
  etat.selection.clear();
  location.hash = `#/commandes/${r.commande_id}`;
}

async function uneParLigne(sel) {
  const ok = await modale({
    titre: `Créer ${sel.length} commande(s) distinctes`,
    contenu: `<p>Chaque ligne deviendra une commande à part entière, avec son propre total déclaré. À utiliser seulement si chaque ligne correspond bien à une commande séparée.</p>`,
    libelleValider: 'Créer',
    valider: async () => {
      for (const l of sel) await post('/api/lignes-import/grouper', { ligne_ids: [l.id], fournisseur_id: l.fournisseur_valide_id || null });
    },
  });
  if (ok) {
    toast(`${sel.length} commande(s) créée(s).`);
    etat.selection.clear();
    rafraichir();
  }
}

async function rattacher(sel) {
  const commandes = await api('/api/commandes');
  const r = await modale({
    titre: 'Rattacher à une commande existante',
    contenu: `<p class="aide">Le total déclaré de la commande n’est pas modifié.</p>
      <div class="champs">${selecteur('commande_id', 'Commande', commandes.map((c) => [c.id, `${c.numero_commande || '#' + c.id} · ${c.fournisseur || 'fournisseur ?'} · ${montant(c.total_declare)}`]))}</div>`,
    libelleValider: 'Rattacher',
    valider: (d) => post('/api/lignes-import/rattacher', { ligne_ids: sel.map((l) => l.id), commande_id: Number(d.commande_id) }),
  });
  if (!r) return;
  r.avertissements.forEach((a) => toast(a));
  etat.selection.clear();
  rafraichir();
}

function brancherActionsLigne(zone, lignes) {
  zone.querySelectorAll('[data-detacher]').forEach((b) => {
    b.onclick = async () => {
      if (await tenter(() => post(`/api/lignes-import/${b.dataset.detacher}/detacher`), 'Ligne remise en attente.')) rafraichir();
    };
  });
  zone.querySelectorAll('[data-corriger]').forEach((b) => {
    b.onclick = async () => {
      const l = lignes.find((x) => x.id === Number(b.dataset.corriger));
      const ok = await modale({
        titre: `Corriger la ligne ${l.numero_ligne}`,
        contenu: `<p class="aide">Valeurs d’origine : ${esc(Object.entries(l.donnees_brutes).map(([k, v]) => `${k} = ${v}`).join(' · '))}</p>
          <div class="champs">${champ('asin', 'ASIN', { valeur: l.asin || '' })}${champ('quantite', 'Quantité', { valeur: l.quantite ?? '' })}
          ${champ('total', 'Total de la commande', { valeur: l.total_brut || '' })}${champ('lien_original', 'Lien d’origine', { valeur: l.lien_original || '' })}</div>`,
        valider: (d) => put(`/api/lignes-import/${l.id}`, d),
      });
      if (ok) rafraichir();
    };
  });
  zone.querySelectorAll('[data-proposition]').forEach((b) => {
    b.onclick = async () => {
      const p = JSON.parse(b.dataset.proposition);
      const ok = await modale({
        titre: 'Valider la correspondance',
        contenu: `<p>Ligne ${esc(p.ligne_id)} → commande <strong>${esc(p.numero_commande || '#' + p.commande_id)}</strong></p>
          <p class="aide">Motifs : ${esc(p.motifs.join(', '))}</p>`,
        libelleValider: 'Valider',
        valider: () =>
          p.ligne_commande_id
            ? post('/api/lignes-import/lier', { ligne_id: p.ligne_id, ligne_commande_id: p.ligne_commande_id })
            : post('/api/lignes-import/rattacher', { ligne_ids: [p.ligne_id], commande_id: p.commande_id }),
      });
      if (ok) rafraichir();
    };
  });
}
