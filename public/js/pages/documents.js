import { api, post, suppr, confirmer, esc, montant, date, badge, toast, tenter, modale, entetePage, icone } from '../outils.js';
import { rafraichir } from '../app.js';

const TYPES = 'application/pdf,image/jpeg,image/png,image/webp,image/gif';

/* ------------------------------------------------------------ dépôt (page Factures) */

export function carteDepot({ extraction_configuree: configuree, documents }) {
  return `<div class="carte">
    <h3 class="sans-marge">Déposer une facture (PDF, JPEG, PNG)</h3>
    <p class="aide">${configuree
      ? 'Les données (numéro, date, montants, articles) sont extraites automatiquement ; vous vérifiez puis associez chaque article à un ASIN.'
      : 'Extraction automatique non configurée (variable ANTHROPIC_API_KEY absente) : la facture s’affiche à côté du formulaire pour une saisie manuelle.'}</p>
    <label class="depot" id="zone-depot">
      <input type="file" id="fichiers-factures" accept="${TYPES}" multiple>
      ${icone('upload', 20)}<span>Glissez les fichiers ici ou <u>choisissez-les</u> · plusieurs fichiers acceptés</span>
    </label>
    <div id="etat-depot" class="aide" aria-live="polite"></div>
    ${documents.length ? `<h3>À vérifier (${documents.length})</h3>
      <div class="tableau"><table><thead><tr><th>Fichier</th><th>Déposé le</th><th>Extraction</th><th data-sans-tri></th></tr></thead><tbody>
      ${documents.map((d) => `<tr><td>${esc(d.nom_fichier)}</td><td>${date(d.created_at)}</td>
        <td>${d.erreur_extraction ? badge('à saisir à la main', 'alerte') : d.extraction ? badge(`${d.extraction.lignes?.length ?? 0} article(s) extrait(s)`, 'ok') : badge('—')}</td>
        <td><a class="bouton petit principal" href="#/factures/document/${d.id}">Vérifier</a></td></tr>`).join('')}
      </tbody></table></div>` : ''}
  </div>`;
}

function lireBase64(fichier) {
  return new Promise((resoudre, rejeter) => {
    const lecteur = new FileReader();
    lecteur.onload = () => resoudre(String(lecteur.result).split(',')[1] || '');
    lecteur.onerror = () => rejeter(lecteur.error);
    lecteur.readAsDataURL(fichier);
  });
}

async function deposer(fichiers, etat) {
  const deposes = [];
  for (const [i, f] of [...fichiers].entries()) {
    etat.textContent = `Envoi et lecture de « ${f.name} » (${i + 1}/${fichiers.length})… l’extraction peut prendre jusqu’à une minute.`;
    const d = await tenter(async () => post('/api/factures/documents', { nom: f.name, type: f.type, donnees: await lireBase64(f) }));
    if (d) {
      deposes.push(d);
      if (d.doublon) toast(`« ${f.name} » a déjà été déposé.`);
    }
  }
  etat.textContent = '';
  if (deposes.length === 1) location.hash = `#/factures/document/${deposes[0].id}`;
  else rafraichir();
}

export function brancherDepot(zone) {
  const input = zone.querySelector('#fichiers-factures');
  const etat = zone.querySelector('#etat-depot');
  const cible = zone.querySelector('#zone-depot');
  if (!input) return;
  input.onchange = () => input.files.length && deposer(input.files, etat);
  cible.ondragover = (e) => {
    e.preventDefault();
    cible.classList.add('survol');
  };
  cible.ondragleave = () => cible.classList.remove('survol');
  cible.ondrop = (e) => {
    e.preventDefault();
    cible.classList.remove('survol');
    const fichiers = [...e.dataTransfer.files].filter((f) => TYPES.split(',').includes(f.type));
    if (fichiers.length) deposer(fichiers, etat);
    else toast('Formats acceptés : PDF, JPEG, PNG, WEBP, GIF.', true);
  };
}

/* ------------------------------------------------------------ vérification */

function nombre(v) {
  return v === null || v === undefined ? '' : String(v);
}

function ligneHtml(l, i, prop) {
  return `<tr data-ligne="${i}">
    <td><input name="description" value="${esc(l.description || '')}" aria-label="Description">${l.reference ? `<span class="aide sous">Réf. ${esc(l.reference)}</span>` : ''}</td>
    <td><input name="quantite" value="${esc(nombre(l.quantite))}" inputmode="numeric" class="champ-qte" aria-label="Quantité"></td>
    <td><input name="prix_unitaire_ht" value="${esc(nombre(l.prix_unitaire_ht))}" inputmode="decimal" class="champ-prix" aria-label="Prix unitaire HT"></td>
    <td class="num">${montant(l.total_ligne)}</td>
    <td><input name="asin" list="liste-asins" value="${esc(prop?.asin || '')}" placeholder="ASIN" class="champ-asin" aria-label="ASIN">
      ${prop?.asin ? `<span class="aide sous">proposé : ${esc(prop.motif)}</span>` : ''}</td>
    <td><button type="button" class="petit icone-seule" data-retirer="${i}" aria-label="Retirer la ligne">${icone('x')}</button></td></tr>`;
}

export async function pageDocument(zone, id) {
  const [d, produits] = await Promise.all([api(`/api/factures/documents/${id}`), api('/api/produits')]);
  const x = d.extraction || { lignes: [] };
  const prop = d.propositions;
  const estPdf = d.type_mime === 'application/pdf';
  const url = `/api/factures/documents/${d.id}/fichier`;
  let lignes = (x.lignes || []).map((l, i) => ({ ...l, _prop: prop.lignes[i] }));
  if (!lignes.length) lignes = [{ description: '', quantite: null, prix_unitaire_ht: null, total_ligne: null }];

  zone.innerHTML = `
    ${entetePage({
      retour: { href: '#/factures', libelle: '← Factures' },
      titre: 'Vérifier la facture',
      sousTitre: `${esc(d.nom_fichier)} · déposée le ${date(d.created_at)}${x.fournisseur ? ` · ${esc(x.fournisseur)}` : ''} ${d.statut === 'valide' ? badge('enregistrée', 'ok') : ''}`,
      actions: `<button type="button" id="reextraire" ${d.extraction_configuree ? '' : 'disabled title="Extraction non configurée (ANTHROPIC_API_KEY)"'}>${icone('refresh-cw')}Relancer l’extraction</button>
        ${d.statut === 'valide' ? '' : `<button type="button" class="danger" id="supprimer">${icone('trash-2')}Supprimer le document</button>`}`,
    })}
    ${d.erreur_extraction ? `<div class="message alerte">${esc(d.erreur_extraction)} Saisissez les informations à partir de l’aperçu.</div>` : ''}
    <div class="verif-facture">
      <div class="apercu">${estPdf
        ? `<iframe src="${url}" title="Aperçu de la facture"></iframe>`
        : `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Aperçu de la facture"></a>`}
        <p class="aide"><a href="${url}" target="_blank" rel="noopener">Ouvrir le document dans un nouvel onglet</a></p></div>
      <form id="form-facture" class="carte">
        <h3 class="sans-marge">Facture</h3>
        <div class="champs">
          <div><label for="f-num">N° de facture</label><input id="f-num" name="numero_facture" value="${esc(x.numero_facture || '')}"></div>
          <div><label for="f-date">Date</label><input id="f-date" name="date_facture" type="date" value="${esc(x.date_facture || '')}"></div>
          <div><label for="f-st">Sous-total HT</label><input id="f-st" name="sous_total_ht" inputmode="decimal" value="${esc(nombre(x.sous_total_ht))}"></div>
          <div><label for="f-tx">Taxes</label><input id="f-tx" name="taxes" inputmode="decimal" value="${esc(nombre(x.taxes))}"></div>
          <div><label for="f-liv">Livraison</label><input id="f-liv" name="livraison" inputmode="decimal" value="${esc(nombre(x.livraison))}"></div>
          <div><label for="f-autres">Autres frais</label><input id="f-autres" name="autres_frais" inputmode="decimal" value="${esc(nombre(x.autres_frais))}"></div>
          <div><label for="f-total">Total</label><input id="f-total" name="total" inputmode="decimal" value="${esc(nombre(x.total))}"></div>
        </div>

        <h3>Articles → ASIN</h3>
        <p class="aide">Associez chaque article à un ASIN (plusieurs articles = plusieurs ASIN). Un article sans ASIN n’est pas enregistré. Le prix unitaire HT alimente l’historique des coûts : un écart avec le coût retenu sera signalé, sans l’écraser.</p>
        <div class="tableau"><table><thead><tr><th data-sans-tri>Article</th><th data-sans-tri>Qté</th><th data-sans-tri>Prix unit. HT</th><th class="num" data-sans-tri>Total ligne</th><th data-sans-tri>ASIN</th><th data-sans-tri></th></tr></thead>
          <tbody id="lignes">${lignes.map((l, i) => ligneHtml(l, i, l._prop)).join('')}</tbody></table></div>
        <button type="button" class="petit" id="ajouter-ligne">${icone('plus')}Ajouter un article</button>
        <datalist id="liste-asins">${produits.map((p) => `<option value="${esc(p.asin)}">${esc(p.titre || '')}</option>`).join('')}</datalist>

        <div class="pied-modale">${d.statut === 'valide'
          ? `<a class="bouton" href="#/factures">Facture déjà enregistrée</a>`
          : `<button class="principal" id="enregistrer">${icone('check')}Enregistrer la facture</button>`}</div>
      </form>
    </div>`;

  const form = zone.querySelector('#form-facture');
  const tbody = zone.querySelector('#lignes');

  const brancherRetirer = () =>
    tbody.querySelectorAll('[data-retirer]').forEach((b) => (b.onclick = () => b.closest('tr').remove()));
  brancherRetirer();
  zone.querySelector('#ajouter-ligne').onclick = () => {
    tbody.insertAdjacentHTML('beforeend', ligneHtml({ description: '' }, tbody.children.length + 1000, null));
    brancherRetirer();
  };

  zone.querySelector('#reextraire').onclick = async () => {
    toast('Extraction en cours…');
    if (await tenter(() => post(`/api/factures/documents/${d.id}/extraire`))) rafraichir();
  };
  zone.querySelector('#supprimer')?.addEventListener('click', async () => {
    const ok = await confirmer({ titre: 'Supprimer ce document ?', message: 'Le fichier et les données extraites seront supprimés définitivement.', libelle: 'Supprimer' });
    if (ok && (await tenter(() => suppr(`/api/factures/documents/${d.id}`))) !== undefined) location.hash = '#/factures';
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (d.statut === 'valide') return;
    const donnees = Object.fromEntries(new FormData(form).entries());
    const articles = [...tbody.querySelectorAll('tr')].map((tr) => ({
      description: tr.querySelector('[name=description]').value,
      quantite: tr.querySelector('[name=quantite]').value,
      prix_unitaire_ht: tr.querySelector('[name=prix_unitaire_ht]').value,
      asin: tr.querySelector('[name=asin]').value.trim(),
    }));
    const sansAsin = articles.filter((a) => !a.asin && (a.description || a.quantite)).length;
    if (sansAsin && !(await confirmer({ titre: 'Articles sans ASIN', message: `${sansAsin} article(s) sans ASIN ne seront pas enregistrés. Continuer ?`, libelle: 'Enregistrer quand même', danger: false }))) return;
    const bouton = form.querySelector('#enregistrer');
    bouton.disabled = true;
    const r = await tenter(() => post(`/api/factures/documents/${d.id}/valider`, { ...donnees, lignes: articles.filter((a) => a.asin) }), 'Facture enregistrée.');
    bouton.disabled = false;
    if (!r) return;
    location.hash = '#/factures';
  };
}
