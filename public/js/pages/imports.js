import { api, post, badge, date, esc, entetePage, icone, toast, lireFichierTexte } from '../outils.js';
import { rafraichir } from '../app.js';
import { nombre } from './tableau.js';

const FICHIERS = {
  achats: {
    titre: 'Google Sheet d’achats',
    icone: 'receipt',
    source: 'Google Sheets › Fichier › Télécharger › Valeurs séparées par des virgules (.csv)',
    lien: ['#/factures', 'Voir les factures'],
  },
  inventaire: {
    titre: 'Inventaire Aura',
    icone: 'package',
    source: 'Aura › Uploads › Download pre-filled template (.csv)',
    lien: ['#/asins', 'Voir les stocks et l’historique des imports'],
  },
  ventes: {
    titre: 'Rapport de commandes Amazon',
    icone: 'file-text',
    source: 'Seller Central › Rapports › Commandes › Toutes les commandes, 14 derniers jours (.txt)',
    lien: ['#/cogs', 'Voir le COGS et les rapports importés'],
  },
};
const ORDRE = ['achats', 'inventaire', 'ventes']; // achats d'abord, puis stock, puis ventes

// Résultats des imports de la session, affichés jusqu'au rechargement de la page.
const journalSession = [];

function quand(e) {
  if (!e.date) return 'Jamais importé';
  const j = e.jours === 0 ? 'aujourd’hui' : e.jours === 1 ? 'hier' : `il y a ${e.jours} jours`;
  return `${date(e.date)} · ${j}`;
}

function details(type, e) {
  if (!e.date) return '';
  if (type === 'inventaire') return `${esc(e.nom || '')} · ${nombre.format(e.unites)} unité(s) chez Amazon sur ${e.asin} ASIN`;
  if (type === 'ventes') return `${esc(e.nom || '')} · ventes connues du ${date(e.ventes_depuis)} au ${date(e.ventes_jusqu_au)}`;
  return `${e.factures} achat(s) du Sheet${e.en_attente ? `, dont ${e.en_attente} en attente du fournisseur` : ''}`;
}

const NOMS_MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const libelleMois = (p) => `${NOMS_MOIS[Number(p.slice(5, 7)) - 1] || ''} ${p.slice(0, 4)}`;

/** Fichiers mensuels du Sheet : dernier import de chaque mois. */
function listeMois(mois) {
  if (!mois?.length) return '';
  return `<ul class="liste-mois">${mois
    .map((m) => `<li><strong>${esc(libelleMois(m.periode))}</strong><span>${esc(m.nom)}</span><span class="aide">${date(m.date)} · ${m.factures} achat(s)</span></li>`)
    .join('')}</ul>`;
}

function carte(type, e, frequence) {
  const f = FICHIERS[type];
  const etat = !e.date ? badge('jamais importé', 'alerte') : e.en_retard ? badge(`à mettre à jour (plus de ${frequence} jours)`, 'alerte') : badge('à jour', 'ok');
  return `<section class="tuile carte-import" data-type="${type}" aria-labelledby="titre-${type}">
      <div class="tuile-tete"><h2 id="titre-${type}" class="sans-marge">${esc(f.titre)}</h2>${icone(f.icone, 20)}</div>
      <p class="carte-import-date"><strong>${quand(e)}</strong> ${etat}</p>
      <p class="aide">${details(type, e) || '&nbsp;'}</p>
      ${type === 'achats' ? listeMois(e.mois) : ''}
      <label class="depot" for="fichier-${type}" data-depot="${type}">${icone('upload', 20)}<span>Glissez le fichier ici ou cliquez pour le choisir</span>
        <input type="file" id="fichier-${type}" data-type="${type}" accept=".csv,.tsv,.txt" multiple></label>
      <p class="aide">${esc(f.source)}</p>
      <p><a href="${f.lien[0]}">${esc(f.lien[1])}</a></p>
    </section>`;
}

/** Résumé lisible du résultat d'un import. */
function resume(type, r) {
  if (type === 'achats') {
    const lignes = [
      `${r.mois}${r.mois_deduit ? ' (mois déduit des dates)' : ''} : ${r.creees} achat(s) ajouté(s), ${r.mises_a_jour} mis à jour, ${r.inchangees} inchangé(s)`,
      r.retirees ? `${r.retirees} retiré(s) du Sheet : annulé(s), gardé(s) dans l’historique` : '',
      r.en_attente ? `${r.en_attente} en attente du fournisseur` : '',
      r.annulees ? `${r.annulees} annulé(s) / remboursé(s)` : '',
    ].filter(Boolean);
    const alertes = [...r.rejets, ...r.a_verifier].map((x) => `Ligne ${x.ligne} (${x.asin}) : ${x.motif}`);
    return { texte: lignes.join(' · '), alertes };
  }
  if (type === 'inventaire') {
    const texte = [
      `${r.produits} ligne(s) lue(s)`,
      r.stock ? `stock chez Amazon : ${nombre.format(r.stock.total)} unité(s)${r.stock.ecart === null ? ' (stock initial)' : ` (${r.stock.ecart >= 0 ? '+' : '−'}${nombre.format(Math.abs(r.stock.ecart))} depuis l’import précédent)`}` : '',
      r.remplace?.length ? `remplace l’import du jour (${r.remplace.join(', ')})` : '',
      r.couts_ajoutes ? `${r.couts_ajoutes} coût(s) ajouté(s)` : '',
    ].filter(Boolean).join(' · ');
    const alertes = [
      ...r.ecarts.map((x) => `${x.asin} : coût importé ${x.importe} $ ≠ coût retenu ${x.retenu} $ (à arbitrer sur la fiche)`),
      ...r.hors_fba.map((x) => `Ligne ${x.ligne} (${x.asin}) : offre expédiée par vous (mf), pas comptée chez Amazon`),
      ...r.rejets.map((x) => `Ligne ${x.ligne} : ${x.motif}`),
    ];
    return { texte, alertes };
  }
  return {
    texte: `${r.nouvelles} commande(s) ajoutée(s), ${r.mises_a_jour} mise(s) à jour, ${r.annulees} annulée(s) non comptée(s) · ${nombre.format(r.unites)} unité(s) vendue(s)${r.du ? ` du ${date(r.du)} au ${date(r.au)}` : ''}`,
    alertes: r.rejets.map((x) => `Ligne ${x.ligne} : ${x.motif}`),
  };
}

async function importer(type, texte, nom) {
  if (type === 'achats') return post('/api/imports/achats', { texte, nom });
  if (type === 'ventes') return post('/api/imports/ventes', { texte, nom });
  const a = await post('/api/imports/inventaire/analyser', { texte });
  if (a.mapping.asin === undefined || a.mapping.quantite === undefined) {
    throw new Error('Colonnes ASIN et quantité non reconnues : importez ce fichier depuis Stocks pour associer les colonnes à la main.');
  }
  return post('/api/imports/inventaire', { texte, mapping: a.mapping, nom });
}

/** Importe des fichiers déposés : type reconnu à partir du contenu, achats → inventaire → ventes. */
async function traiter(fichiers, attendu = null) {
  const lus = [];
  for (const f of fichiers) {
    const texte = await lireFichierTexte(f);
    const { type } = await post('/api/imports/detecter', { texte }).catch(() => ({ type: null }));
    if (!type) {
      journalSession.unshift({ nom: f.name, erreur: 'Fichier non reconnu : ni Google Sheet d’achats, ni inventaire Aura, ni rapport de commandes Amazon.' });
      continue;
    }
    if (attendu && type !== attendu) {
      journalSession.unshift({ nom: f.name, erreur: `Ce fichier ressemble à : ${FICHIERS[type].titre}. Déposez-le dans la bonne case (ou n’importe où sur la page).` });
      continue;
    }
    lus.push({ type, texte, nom: f.name });
  }
  lus.sort((a, b) => ORDRE.indexOf(a.type) - ORDRE.indexOf(b.type));
  for (const l of lus) {
    try {
      const r = await importer(l.type, l.texte, l.nom);
      journalSession.unshift({ nom: l.nom, type: l.type, ...resume(l.type, r) });
    } catch (e) {
      journalSession.unshift({ nom: l.nom, type: l.type, erreur: e.message });
    }
  }
  const erreurs = journalSession.slice(0, fichiers.length).filter((j) => j.erreur).length;
  toast(erreurs ? `${fichiers.length - erreurs} fichier(s) importé(s), ${erreurs} refusé(s) : voir le détail.` : `${fichiers.length} fichier(s) importé(s).`, erreurs ? { erreur: true } : false);
  rafraichir();
}

function rendreJournal() {
  if (!journalSession.length) return '';
  return `<h2>Résultats</h2><div class="pile-resultats">${journalSession
    .map(
      (j) => `<div class="message ${j.erreur ? 'erreur' : 'ok'}"><strong>${esc(j.nom)}</strong>${j.type ? ` · ${esc(FICHIERS[j.type].titre)}` : ''}
        <div>${esc(j.erreur || j.texte)}</div>
        ${j.alertes?.length ? `<details><summary>${j.alertes.length} ligne(s) à vérifier</summary><ul>${j.alertes.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></details>` : ''}</div>`,
    )
    .join('')}</div>`;
}

export async function pageImports(zone) {
  const r = await api('/api/imports/resume');
  const retard = ORDRE.filter((t) => r[t].en_retard).length;
  zone.innerHTML = `
    ${entetePage({ titre: 'Imports', sousTitre: 'Vos trois fichiers au même endroit : déposez-en un ou plusieurs, n’importe où sur la page ; leur type est reconnu automatiquement.' })}
    <div id="zone-imports" class="zone-depot">
      <p class="depot-indice">Déposez vos fichiers : Google Sheet, Aura et rapport de commandes Amazon</p>
      ${retard ? `<div class="message alerte">${retard} fichier(s) à mettre à jour : chaque lundi, importez le rapport de commandes Amazon (14 derniers jours), l’export Aura et votre Google Sheet d’achats.</div>` : '<div class="message ok">Tout est à jour. Prochaine mise à jour conseillée : lundi prochain.</div>'}
      <div class="grille grille-3">${ORDRE.map((t) => carte(t, r[t], r.frequence_jours)).join('')}</div>
      ${rendreJournal()}
      <h2>Sans doublon</h2>
      <ul class="aide">
        <li><strong>Google Sheet</strong> : un fichier par mois, reconnu à son nom (« AUGUST orders », « SEPTEMBER orders »…). Pour un mois, le dernier fichier importé fait foi : lignes ajoutées → achats créés, lignes modifiées → mises à jour, lignes retirées → achats annulés (gardés dans l’historique) ; jamais de doublon, et les autres mois ne sont pas touchés. Le total est TTC ; le montant HT en est déduit (TPS + TVQ, réglable dans Paramètres). Pour le statut, ajoutez une colonne F « Statut » : reçu, en attente ou annulé (les couleurs ne sont pas exportées en CSV).</li>
        <li><strong>Aura</strong> : chaque import est une photo complète du stock Amazon ; seule la variation avec la photo précédente compte. Un fichier identique au dernier import est refusé, et un nouvel import le même jour remplace celui du jour.</li>
        <li><strong>Rapport de commandes</strong> : une commande déjà importée est mise à jour, jamais comptée deux fois ; des périodes qui se chevauchent ne posent donc aucun problème.</li>
      </ul>
    </div>`;

  const page = zone.querySelector('#zone-imports');
  zone.querySelectorAll('input[type=file][data-type]').forEach((input) => {
    input.onchange = () => input.files.length && traiter([...input.files], input.dataset.type);
  });
  // Dépôt sur une carte : ce type attendu ; ailleurs sur la page : type reconnu automatiquement.
  let profondeur = 0;
  page.ondragenter = (e) => {
    e.preventDefault();
    profondeur++;
    page.classList.add('attente');
  };
  page.ondragleave = () => {
    if (--profondeur <= 0) page.classList.remove('attente');
  };
  page.ondragover = (e) => {
    e.preventDefault();
    zone.querySelectorAll('[data-depot]').forEach((d) => d.classList.toggle('survol', d.contains(e.target)));
  };
  page.ondrop = (e) => {
    e.preventDefault();
    profondeur = 0;
    page.classList.remove('attente');
    zone.querySelectorAll('[data-depot]').forEach((d) => d.classList.remove('survol'));
    const fichiers = [...e.dataTransfer.files];
    if (!fichiers.length) return;
    const carteCible = e.target.closest('[data-depot]');
    traiter(fichiers, carteCible ? carteCible.dataset.depot : null);
  };
}
