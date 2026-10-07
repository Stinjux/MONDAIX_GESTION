// Import du Google Sheets de suivi des achats (ASIN, site, quantité, prix total de la commande).
//
// Règles :
// - le prix total est celui de la COMMANDE : il n'est jamais répété comme dépense par ASIN ;
// - aucune ligne n'est regroupée automatiquement (même site ou même montant ne suffit pas) ;
// - les lignes restent « en attente de rapprochement » tant que l'utilisateur ne les a pas
//   rattachées à une commande ;
// - le lien d'origine est conservé tel quel, le fournisseur n'est qu'une proposition à valider.
import { ErreurMetier, assurerProduit, journaliser, transaction } from '../db.js';
import { lireTableau } from '../lib/csv.js';
import { CHAMPS_SHEETS, proposerMapping, validerMapping } from '../lib/mapping.js';
import { normaliserAsin, normaliserReference, parserDate, parserMontant, parserQuantite } from '../lib/parse.js';
import { creerCommande, ajouterLigneCommande } from './commandes.js';
import { creerFournisseur, proposerFournisseur } from './fournisseurs.js';

/** Convertit un lien Google Sheets en lien d'export CSV. */
export function urlExportCsv(url) {
  const m = String(url).match(/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/);
  if (!m) return url;
  const gid = String(url).match(/[#&?]gid=(\d+)/);
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? `&gid=${gid[1]}` : ''}`;
}

export async function telechargerSheets(url) {
  const reponse = await fetch(urlExportCsv(url), { redirect: 'follow' });
  if (!reponse.ok) throw new ErreurMetier(`Téléchargement impossible (${reponse.status}). Vérifiez que la feuille est partagée ou utilisez Fichier › Télécharger › CSV.`);
  const texte = await reponse.text();
  if (/^\s*<!doctype html|<html/i.test(texte)) throw new ErreurMetier('La feuille n’est pas accessible publiquement : exportez-la en CSV puis importez le fichier.');
  return texte;
}

export function analyserSheets(texte) {
  const { entetes, lignes } = lireTableau(texte);
  if (!entetes.length) throw new ErreurMetier('Fichier vide.');
  return {
    entetes,
    apercu: lignes.slice(0, 20),
    nb_lignes: lignes.length,
    champs: CHAMPS_SHEETS,
    mapping: proposerMapping(entetes, lignes, CHAMPS_SHEETS),
  };
}

function cle(l) {
  return [l.asin, (l.lien_original || '').toLowerCase(), l.quantite, l.total_brut].join('|');
}

export function importerSheets(db, { texte, mapping, nom }) {
  const { entetes, lignes } = lireTableau(texte);
  let map;
  try {
    map = validerMapping(mapping, entetes, CHAMPS_SHEETS);
  } catch (e) {
    throw new ErreurMetier(e.message);
  }
  return transaction(db, () => {
    const imp = db
      .prepare("INSERT INTO imports (type, nom, mapping, entetes, nb_lignes) VALUES ('sheets', ?, ?, ?, ?)")
      .run(nom || 'Google Sheets', JSON.stringify(map), JSON.stringify(entetes), lignes.length);
    const importId = Number(imp.lastInsertRowid);
    const existantes = new Map(
      db.prepare('SELECT id, asin, lien_original, quantite, total_brut FROM lignes_import WHERE import_id <> ?').all(importId).map((l) => [cle(l), l.id]),
    );
    const inserer = db.prepare(
      `INSERT INTO lignes_import (import_id, numero_ligne, asin, lien_original, domaine, quantite, total_commande_declare,
         total_brut, numero_commande, date_commande, fournisseur_propose_id, fournisseur_propose_nom, doublon_de_id,
         anomalies, donnees_brutes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const bilan = { import_id: importId, lignes: 0, anomalies: 0, doublons: 0 };
    lignes.forEach((l, i) => {
      const val = (champ) => (map[champ] === undefined ? '' : l[map[champ]]);
      const anomalies = [];
      const asin = normaliserAsin(val('asin'));
      if (!asin) anomalies.push(`ASIN invalide « ${val('asin')} »`);
      else assurerProduit(db, asin); // suivi des autorisations dès l'import
      const quantite = parserQuantite(val('quantite'));
      if (!quantite) anomalies.push('Quantité absente ou invalide');
      const totalBrut = val('total');
      const total = parserMontant(totalBrut);
      if (totalBrut && total === null) anomalies.push(`Total illisible « ${totalBrut} »`);
      const lien = val('site') || null;
      const proposition = lien ? proposerFournisseur(db, lien) : { domaine: null, fournisseur: null, nomPropose: null };
      const ligne = { asin, lien_original: lien, quantite, total_brut: totalBrut || null };
      const doublon = existantes.get(cle(ligne)) || null;
      if (doublon) bilan.doublons++;
      if (anomalies.length) bilan.anomalies++;
      inserer.run(
        importId,
        i + 2, // numéro de ligne dans la feuille (ligne 1 = en-têtes)
        asin,
        lien,
        proposition.domaine,
        quantite,
        total,
        totalBrut || null,
        val('numero_commande') || null,
        parserDate(val('date')),
        proposition.fournisseur?.id ?? null,
        proposition.nomPropose,
        doublon,
        JSON.stringify(anomalies),
        JSON.stringify(Object.fromEntries(entetes.map((h, j) => [h, l[j]]))),
      );
      bilan.lignes++;
    });
    journaliser(db, 'import', importId, 'sheets', bilan);
    return bilan;
  });
}

function versLigne(r) {
  return r && { ...r, anomalies: JSON.parse(r.anomalies || '[]'), donnees_brutes: JSON.parse(r.donnees_brutes || '{}') };
}

export function listerLignesImport(db, { importId, statut } = {}) {
  const conds = [];
  const params = [];
  if (importId) {
    conds.push('li.import_id = ?');
    params.push(importId);
  }
  if (statut) {
    conds.push('li.statut = ?');
    params.push(statut);
  }
  return db
    .prepare(
      `SELECT li.*, fp.nom AS fournisseur_propose, fv.nom AS fournisseur_valide, c.numero_commande AS commande_numero, i.nom AS import_nom
       FROM lignes_import li
       JOIN imports i ON i.id = li.import_id
       LEFT JOIN fournisseurs fp ON fp.id = li.fournisseur_propose_id
       LEFT JOIN fournisseurs fv ON fv.id = li.fournisseur_valide_id
       LEFT JOIN commandes c ON c.id = li.commande_id
       ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
       ORDER BY li.import_id DESC, li.numero_ligne`,
    )
    .all(...params)
    .map(versLigne);
}

export function listerImports(db) {
  return db
    .prepare(
      `SELECT i.*,
         (SELECT COUNT(*) FROM lignes_import WHERE import_id = i.id AND statut = 'en_attente') AS en_attente,
         (SELECT COUNT(*) FROM lignes_import WHERE import_id = i.id AND statut = 'rattachee') AS rattachees
       FROM imports i ORDER BY i.id DESC`,
    )
    .all();
}

function chargerLignes(db, ids) {
  if (!Array.isArray(ids) || !ids.length) throw new ErreurMetier('Sélectionnez au moins une ligne.');
  const lignes = ids.map((id) => versLigne(db.prepare('SELECT * FROM lignes_import WHERE id = ?').get(Number(id))));
  if (lignes.some((l) => !l)) throw new ErreurMetier('Ligne introuvable.', 404);
  return lignes;
}

/** Corrige une ligne importée (ASIN, quantité, total, lien) sans perdre les données brutes. */
export function corrigerLigneImport(db, id, champs) {
  const [l] = chargerLignes(db, [id]);
  if (l.statut === 'rattachee') throw new ErreurMetier('Détachez la ligne de sa commande avant de la corriger.');
  const n = { ...l };
  const anomalies = [];
  if (champs.asin !== undefined) n.asin = normaliserAsin(champs.asin);
  if (champs.quantite !== undefined) n.quantite = parserQuantite(champs.quantite);
  if (champs.total !== undefined) {
    n.total_brut = champs.total || null;
    n.total_commande_declare = parserMontant(champs.total);
  }
  if (champs.lien_original !== undefined && champs.lien_original !== l.lien_original) {
    n.lien_original = champs.lien_original || null;
    const p = n.lien_original ? proposerFournisseur(db, n.lien_original) : { domaine: null, fournisseur: null, nomPropose: null };
    n.domaine = p.domaine;
    n.fournisseur_propose_id = p.fournisseur?.id ?? null;
    n.fournisseur_propose_nom = p.nomPropose;
    n.fournisseur_valide_id = null;
  }
  if (!n.asin) anomalies.push('ASIN invalide');
  else assurerProduit(db, n.asin);
  if (!n.quantite) anomalies.push('Quantité absente ou invalide');
  db.prepare(
    `UPDATE lignes_import SET asin = ?, quantite = ?, total_brut = ?, total_commande_declare = ?, lien_original = ?, domaine = ?,
       fournisseur_propose_id = ?, fournisseur_propose_nom = ?, fournisseur_valide_id = ?, anomalies = ? WHERE id = ?`,
  ).run(n.asin, n.quantite, n.total_brut, n.total_commande_declare, n.lien_original, n.domaine, n.fournisseur_propose_id, n.fournisseur_propose_nom, n.fournisseur_valide_id, JSON.stringify(anomalies), id);
  journaliser(db, 'ligne_import', id, 'correction', { avant: { asin: l.asin, quantite: l.quantite, total: l.total_brut, lien: l.lien_original }, champs });
}

/**
 * Validation manuelle du fournisseur pour des lignes : fournisseur existant,
 * ou création à partir de la proposition (nom + domaine du lien).
 */
export function validerFournisseurLignes(db, { ligne_ids, fournisseur_id, creer }) {
  const lignes = chargerLignes(db, ligne_ids);
  return transaction(db, () => {
    let id = fournisseur_id ? Number(fournisseur_id) : null;
    if (!id && creer) {
      const domaines = creer.domaines ?? [...new Set(lignes.map((l) => l.domaine).filter(Boolean))];
      id = creerFournisseur(db, { nom: creer.nom, domaines }).id;
    }
    if (!id) throw new ErreurMetier('Choisissez un fournisseur.');
    const maj = db.prepare('UPDATE lignes_import SET fournisseur_valide_id = ? WHERE id = ?');
    for (const l of lignes) maj.run(id, l.id);
    // Les commandes déjà créées depuis ces lignes sans fournisseur héritent du choix.
    for (const l of lignes) {
      if (l.commande_id) db.prepare('UPDATE commandes SET fournisseur_id = ? WHERE id = ? AND fournisseur_id IS NULL').run(id, l.commande_id);
    }
    journaliser(db, 'ligne_import', ligne_ids.join(','), 'fournisseur_valide', { fournisseur_id: id });
    return id;
  });
}

function verifierRattachables(lignes) {
  for (const l of lignes) {
    if (l.statut !== 'en_attente') throw new ErreurMetier(`La ligne ${l.numero_ligne} n’est pas en attente de rapprochement.`);
    if (!l.asin || !l.quantite) throw new ErreurMetier(`La ligne ${l.numero_ligne} doit être corrigée (ASIN et quantité requis).`);
  }
}

function fournisseurCommun(lignes, fournisseurId) {
  if (fournisseurId) return Number(fournisseurId);
  const valides = [...new Set(lignes.map((l) => l.fournisseur_valide_id).filter(Boolean))];
  if (valides.length > 1) throw new ErreurMetier('Les lignes sélectionnées ont des fournisseurs validés différents.');
  return valides[0] || null;
}

/** Totaux distincts déclarés sur les lignes sélectionnées (jamais additionnés). */
export function totauxDistincts(lignes) {
  return [...new Set(lignes.map((l) => l.total_commande_declare).filter((t) => t !== null && t !== undefined))];
}

/**
 * Regroupe les lignes sélectionnées dans UNE commande.
 * Le total déclaré est enregistré une seule fois pour la commande.
 */
export function grouperEnCommande(db, params) {
  const lignes = chargerLignes(db, params.ligne_ids);
  verifierRattachables(lignes);
  const avertissements = [];
  const fournisseurId = fournisseurCommun(lignes, params.fournisseur_id);
  if (!fournisseurId) avertissements.push('Fournisseur non validé : à préciser sur la commande.');

  let total = params.total_declare === '' || params.total_declare == null ? undefined : parserMontant(params.total_declare);
  const distincts = totauxDistincts(lignes);
  if (total === undefined) {
    if (distincts.length > 1) {
      throw new ErreurMetier(
        `Les lignes indiquent des totaux différents (${distincts.join(' / ')}). Choisissez le total de la commande : il ne sera pas additionné.`,
      );
    }
    total = distincts.length ? distincts[0] : null;
  } else if (distincts.length && !distincts.some((d) => Math.abs(d - total) < 0.005)) {
    avertissements.push(`Le total saisi (${total}) diffère des totaux des lignes (${distincts.join(' / ')}).`);
  }

  const liens = [...new Set(lignes.map((l) => l.lien_original).filter(Boolean))];
  const numeroIndice = [...new Set(lignes.map((l) => l.numero_commande).filter(Boolean))];
  const dateIndice = [...new Set(lignes.map((l) => l.date_commande).filter(Boolean))];

  return transaction(db, () => {
    const id = creerCommande(db, {
      fournisseur_id: fournisseurId,
      numero_commande: params.numero_commande || (numeroIndice.length === 1 ? numeroIndice[0] : null),
      date_commande: params.date_commande || (dateIndice.length === 1 ? dateIndice[0] : null),
      lien_original: liens.join(' | ') || null,
      total_declare: total,
      total_inclut_taxes: params.total_inclut_taxes,
      total_inclut_livraison: params.total_inclut_livraison,
      source: 'sheets',
      notes: params.notes,
      lignes: lignes.map((l) => ({ asin: l.asin, quantite: l.quantite, ligne_import_id: l.id })),
    });
    return { commande_id: id, avertissements };
  });
}

/** Rattache des lignes à une commande existante, sans modifier son total déclaré. */
export function rattacherLignes(db, { ligne_ids, commande_id }) {
  const lignes = chargerLignes(db, ligne_ids);
  verifierRattachables(lignes);
  const c = db.prepare('SELECT * FROM commandes WHERE id = ?').get(commande_id);
  if (!c) throw new ErreurMetier('Commande introuvable.', 404);
  const avertissements = [];
  for (const l of lignes) {
    if (l.total_commande_declare !== null && c.total_declare !== null && Math.abs(l.total_commande_declare - c.total_declare) >= 0.005) {
      avertissements.push(`Ligne ${l.numero_ligne} : total ${l.total_commande_declare} ≠ total déclaré de la commande (${c.total_declare}).`);
    }
    if (l.fournisseur_valide_id && c.fournisseur_id && l.fournisseur_valide_id !== c.fournisseur_id) {
      throw new ErreurMetier(`Ligne ${l.numero_ligne} : fournisseur différent de celui de la commande.`);
    }
  }
  transaction(db, () => {
    for (const l of lignes) ajouterLigneCommande(db, c.id, { asin: l.asin, quantite: l.quantite, ligne_import_id: l.id });
    if (c.total_declare === null) {
      const distincts = totauxDistincts(lignes);
      if (distincts.length === 1) {
        db.prepare('UPDATE commandes SET total_declare = ? WHERE id = ?').run(distincts[0], c.id);
        journaliser(db, 'commande', c.id, 'total_declare_renseigne', { total_declare: distincts[0], depuis: 'lignes_import' });
        avertissements.push(`Total déclaré de la commande renseigné à ${distincts[0]} (aucun total auparavant).`);
      }
    }
  });
  return { avertissements };
}

/** Retire une ligne de sa commande : elle repasse en attente de rapprochement. */
export function detacherLigne(db, id) {
  const [l] = chargerLignes(db, [id]);
  if (l.statut !== 'rattachee') throw new ErreurMetier('La ligne n’est rattachée à aucune commande.');
  transaction(db, () => {
    if (l.commande_ligne_id) db.prepare('DELETE FROM commande_lignes WHERE id = ?').run(l.commande_ligne_id);
    db.prepare("UPDATE lignes_import SET statut = 'en_attente', commande_id = NULL, commande_ligne_id = NULL WHERE id = ?").run(id);
    journaliser(db, 'ligne_import', id, 'detachee', { commande_id: l.commande_id });
  });
}

export function changerStatutLignes(db, { ligne_ids, statut }) {
  if (!['en_attente', 'ignoree'].includes(statut)) throw new ErreurMetier('Statut invalide.');
  const lignes = chargerLignes(db, ligne_ids);
  for (const l of lignes) {
    if (l.statut === 'rattachee') throw new ErreurMetier(`La ligne ${l.numero_ligne} est rattachée : détachez-la d’abord.`);
    db.prepare('UPDATE lignes_import SET statut = ? WHERE id = ?').run(statut, l.id);
  }
  journaliser(db, 'ligne_import', ligne_ids.join(','), `statut_${statut}`);
}

/**
 * Propose des commandes existantes pour les lignes en attente (même ASIN et quantité
 * sur une ligne de commande non encore rattachée, ou n° de commande identique).
 * Chaque proposition doit être validée ; plusieurs candidates = ambiguïté signalée.
 */
export function propositionsRattachement(db) {
  const lignes = listerLignesImport(db, { statut: 'en_attente' }).filter((l) => l.asin);
  const commandes = db.prepare('SELECT id, numero_commande, fournisseur_id, total_declare, date_commande FROM commandes').all();
  const resultat = [];
  for (const l of lignes) {
    const candidates = [];
    const ref = normaliserReference(l.numero_commande);
    for (const c of commandes) {
      const motifs = [];
      if (ref && normaliserReference(c.numero_commande) === ref) motifs.push('n° de commande identique');
      const libre = db
        .prepare(
          `SELECT cl.id FROM commande_lignes cl
           WHERE cl.commande_id = ? AND cl.asin = ? AND cl.quantite = ?
             AND NOT EXISTS (SELECT 1 FROM lignes_import li WHERE li.commande_ligne_id = cl.id)`,
        )
        .get(c.id, l.asin, l.quantite || 0);
      if (libre) motifs.push('même ASIN et quantité sur une ligne non rattachée');
      if (!motifs.length) continue;
      const fournisseur = l.fournisseur_valide_id || l.fournisseur_propose_id;
      if (fournisseur && c.fournisseur_id && fournisseur !== c.fournisseur_id) continue;
      if (l.total_commande_declare !== null && c.total_declare !== null && Math.abs(l.total_commande_declare - c.total_declare) < 0.005) motifs.push('même total');
      candidates.push({ commande_id: c.id, numero_commande: c.numero_commande, ligne_commande_id: libre?.id ?? null, motifs });
    }
    if (candidates.length) resultat.push({ ligne_id: l.id, numero_ligne: l.numero_ligne, asin: l.asin, ambigu: candidates.length > 1, candidates });
  }
  return resultat;
}

/**
 * Valide une proposition où la commande contient déjà la ligne (saisie manuelle) :
 * relie la ligne Sheets à la ligne de commande existante sans la dupliquer.
 */
export function lierLigneExistante(db, { ligne_id, ligne_commande_id }) {
  const [l] = chargerLignes(db, [ligne_id]);
  verifierRattachables([l]);
  const cl = db.prepare('SELECT * FROM commande_lignes WHERE id = ?').get(ligne_commande_id);
  if (!cl) throw new ErreurMetier('Ligne de commande introuvable.', 404);
  if (cl.asin !== l.asin) throw new ErreurMetier('L’ASIN ne correspond pas.');
  const deja = db.prepare('SELECT id FROM lignes_import WHERE commande_ligne_id = ?').get(ligne_commande_id);
  if (deja) throw new ErreurMetier('Cette ligne de commande est déjà reliée à une ligne Google Sheets.');
  db.prepare("UPDATE lignes_import SET statut = 'rattachee', commande_id = ?, commande_ligne_id = ? WHERE id = ?").run(cl.commande_id, cl.id, l.id);
  journaliser(db, 'ligne_import', l.id, 'liee', { commande_id: cl.commande_id, commande_ligne_id: cl.id });
}
