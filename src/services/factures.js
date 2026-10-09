// Factures fournisseurs : montants, articles associés aux ASIN (coût unitaire HT), annulation.
import { ErreurMetier, assurerProduit, journaliser, transaction } from '../db.js';
import { arrondir, normaliserAsin, parserDate, parserMontant, parserQuantite } from '../lib/parse.js';
import { ajouterCout } from './couts.js';

export function totalFacture(f) {
  if (f.total !== null && f.total !== undefined) return f.total;
  if (f.sous_total_ht === null || f.sous_total_ht === undefined) return null;
  return arrondir((f.sous_total_ht || 0) + (f.taxes || 0) + (f.livraison || 0) + (f.autres_frais || 0));
}

/** Lignes de facture saisies → { asin, quantite, prix } validés (les lignes sans ASIN sont ignorées). */
function validerLignesFacture(lignes) {
  return (lignes || []).filter((l) => l.asin && String(l.asin).trim()).map((l, i) => {
    const asin = normaliserAsin(l.asin);
    if (!asin) throw new ErreurMetier(`Ligne ${i + 1} : ASIN invalide.`);
    const quantite = parserQuantite(l.quantite);
    if (!quantite) throw new ErreurMetier(`Ligne ${i + 1} : quantité invalide.`);
    return { asin, quantite, prix: l.prix_unitaire_ht === '' || l.prix_unitaire_ht == null ? null : parserMontant(l.prix_unitaire_ht) };
  });
}

function insererLignesFacture(db, facture, lignes) {
  for (const l of lignes) {
    assurerProduit(db, l.asin);
    db.prepare('INSERT INTO facture_lignes (facture_id, asin, quantite, prix_unitaire_ht) VALUES (?, ?, ?, ?)').run(facture.id, l.asin, l.quantite, l.prix);
    if (l.prix !== null) {
      ajouterCout(db, { asin: l.asin, montant: l.prix, source: 'facture', reference: facture.numero_facture || `facture #${facture.id}`, factureId: facture.id, commandeId: facture.commande_id });
    }
  }
}

/**
 * Remplace les articles (ASIN) d'une facture déjà enregistrée. L'historique des coûts n'est
 * jamais effacé : un nouveau prix s'y ajoute (écart signalé), un article retiré y reste.
 */
export function modifierLignesFacture(db, id, lignesSaisies) {
  const f = db.prepare('SELECT * FROM factures WHERE id = ?').get(id);
  if (!f) throw new ErreurMetier('Facture introuvable.', 404);
  const lignes = validerLignesFacture(lignesSaisies);
  return transaction(db, () => {
    const avant = db.prepare('SELECT asin, quantite, prix_unitaire_ht FROM facture_lignes WHERE facture_id = ? ORDER BY id').all(id);
    db.prepare('DELETE FROM facture_lignes WHERE facture_id = ?').run(id);
    insererLignesFacture(db, f, lignes);
    journaliser(db, 'facture', id, 'articles', { avant, apres: lignes });
    return { id, lignes: lignes.length };
  });
}

/** Associe un ASIN à une facture existante (ajout d'un article). */
export function ajouterLigneFacture(db, id, ligne) {
  const existantes = db.prepare('SELECT asin, quantite, prix_unitaire_ht FROM facture_lignes WHERE facture_id = ? ORDER BY id').all(id);
  if (!validerLignesFacture([ligne]).length) throw new ErreurMetier('Indiquez l’ASIN.');
  return modifierLignesFacture(db, id, [...existantes, ligne]);
}

export function retirerLigneFacture(db, ligneId) {
  const l = db.prepare('SELECT * FROM facture_lignes WHERE id = ?').get(ligneId);
  if (!l) throw new ErreurMetier('Article introuvable.', 404);
  db.prepare('DELETE FROM facture_lignes WHERE id = ?').run(ligneId);
  journaliser(db, 'facture', l.facture_id, 'article_retire', l);
}

/**
 * Fraction d'une facture revenant à un ASIN : au prorata du montant HT de ses articles
 * (base = sous-total HT si des articles ne sont pas associés), ou des quantités si un prix manque.
 */
export function ratioFactureAsin(facture, lignes, asin) {
  const siennes = lignes.filter((l) => l.asin === asin);
  if (!siennes.length) return null;
  const prixConnus = lignes.every((l) => l.prix_unitaire_ht !== null && l.prix_unitaire_ht !== undefined);
  const htLignes = (ls) => ls.reduce((s, l) => s + l.quantite * l.prix_unitaire_ht, 0);
  if (prixConnus) {
    const ht = htLignes(siennes);
    const base = Math.max(htLignes(lignes), facture.sous_total_ht || 0);
    return { ratio: base > 0 ? ht / base : 0, ht, estimee: false };
  }
  const unites = siennes.reduce((s, l) => s + l.quantite, 0);
  return { ratio: unites / lignes.reduce((s, l) => s + l.quantite, 0), ht: null, estimee: true };
}

/**
 * Part d'une facture revenant à un ASIN, frais et taxes compris. Une facture n'est donc
 * jamais comptée deux fois quand elle contient plusieurs ASIN. Facture annulée : 0.
 */
export function partFactureAsin(facture, lignes, asin) {
  const r = ratioFactureAsin(facture, lignes, asin);
  if (!r) return null;
  const unites = lignes.filter((l) => l.asin === asin).reduce((s, l) => s + l.quantite, 0);
  if (facture.annulee) return { montant: 0, ht: 0, frais: 0, unites, estimee: false, annulee: true };
  const total = totalFacture(facture);
  if (!r.estimee) {
    const montant = total === null ? r.ht : total * r.ratio;
    return { montant: arrondir(montant), ht: arrondir(r.ht), frais: arrondir(montant - r.ht), unites, estimee: false };
  }
  return { montant: arrondir(total === null ? 0 : total * r.ratio), ht: null, frais: null, unites, estimee: true };
}

/** Dépense totale des factures par ASIN : Map asin → { montant, ht, frais, unites, nb_factures, estimee }. */
export function depensesFacturesParAsin(db) {
  const factures = db.prepare('SELECT * FROM factures WHERE annulee = 0').all();
  const toutesLignes = db.prepare('SELECT facture_id, asin, quantite, prix_unitaire_ht FROM facture_lignes').all();
  const parFacture = new Map();
  for (const l of toutesLignes) {
    if (!parFacture.has(l.facture_id)) parFacture.set(l.facture_id, []);
    parFacture.get(l.facture_id).push(l);
  }
  const resultat = new Map();
  for (const f of factures) {
    const lignes = parFacture.get(f.id) || [];
    for (const asin of new Set(lignes.map((l) => l.asin))) {
      const part = partFactureAsin(f, lignes, asin);
      const a = resultat.get(asin) || { montant: 0, ht: 0, frais: 0, unites: 0, nb_factures: 0, estimee: false };
      a.montant = arrondir(a.montant + part.montant);
      a.ht = arrondir(a.ht + (part.ht ?? 0));
      a.frais = arrondir(a.frais + (part.frais ?? 0));
      a.unites += part.unites;
      a.nb_factures++;
      a.estimee ||= part.estimee;
      resultat.set(asin, a);
    }
  }
  for (const a of resultat.values()) a.cout_moyen_unite = a.unites ? arrondir(a.montant / a.unites) : null;
  return resultat;
}

/**
 * Enregistre une facture : montants, date et articles associés aux ASIN (coût unitaire HT
 * ajouté à l'historique des coûts, écart signalé sans écraser le coût retenu).
 */
export function creerFacture(db, f) {
  const montants = {};
  for (const cle of ['sous_total_ht', 'taxes', 'livraison', 'autres_frais', 'total']) {
    montants[cle] = f[cle] === '' || f[cle] == null ? null : parserMontant(f[cle]);
  }
  if (montants.total === null && montants.sous_total_ht === null) throw new ErreurMetier('Indiquez au moins le sous-total HT ou le total de la facture.');
  const lignes = validerLignesFacture(f.lignes);
  return transaction(db, () => {
    const r = db
      .prepare(
        `INSERT INTO factures (fournisseur_id, numero_facture, numero_commande_ref, date_facture,
           sous_total_ht, taxes, livraison, autres_frais, total, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        f.fournisseur_id || null,
        f.numero_facture || null,
        f.numero_commande_ref || null,
        parserDate(f.date_facture),
        montants.sous_total_ht,
        montants.taxes,
        montants.livraison,
        montants.autres_frais,
        montants.total,
        f.notes || null,
      );
    const id = Number(r.lastInsertRowid);
    insererLignesFacture(db, { id, numero_facture: f.numero_facture, commande_id: null }, lignes);
    journaliser(db, 'facture', id, 'creation', f);
    return { id };
  });
}

/**
 * Facture annulée par le fournisseur (remboursée) : conservée dans l'historique,
 * mais exclue des dépenses, des unités achetées et du coût complet.
 */
export function annulerFacture(db, id, { date_annulation, motif } = {}) {
  const f = db.prepare('SELECT * FROM factures WHERE id = ?').get(id);
  if (!f) throw new ErreurMetier('Facture introuvable.', 404);
  if (f.annulee) throw new ErreurMetier('Cette facture est déjà annulée.', 409);
  const date = parserDate(date_annulation) || new Date().toISOString().slice(0, 10);
  db.prepare('UPDATE factures SET annulee = 1, date_annulation = ?, motif_annulation = ? WHERE id = ?').run(date, motif || null, id);
  journaliser(db, 'facture', id, 'annulation', { date_annulation: date, motif: motif || null });
}

export function retablirFacture(db, id) {
  const f = db.prepare('SELECT * FROM factures WHERE id = ?').get(id);
  if (!f) throw new ErreurMetier('Facture introuvable.', 404);
  db.prepare('UPDATE factures SET annulee = 0, date_annulation = NULL, motif_annulation = NULL WHERE id = ?').run(id);
  journaliser(db, 'facture', id, 'retablissement', { avant: { date_annulation: f.date_annulation, motif: f.motif_annulation } });
}

export function supprimerFacture(db, id) {
  const f = db.prepare('SELECT * FROM factures WHERE id = ?').get(id);
  if (!f) throw new ErreurMetier('Facture introuvable.', 404);
  // Le document déposé (PDF / image) redevient « à valider ».
  db.prepare("UPDATE facture_documents SET statut = 'a_valider', facture_id = NULL WHERE facture_id = ?").run(id);
  db.prepare('DELETE FROM factures WHERE id = ?').run(id);
  journaliser(db, 'facture', id, 'suppression', f);
}

function lireArticles(json) {
  try {
    const a = JSON.parse(json || '[]');
    return Array.isArray(a) ? a.map((l) => ({ description: l.description, quantite: l.quantite, prix_unitaire_ht: l.prix_unitaire_ht, asin: l.asin })) : [];
  } catch {
    return [];
  }
}

export function listerFactures(db) {
  return db
    .prepare(
      `SELECT f.*,
         COALESCE(fo.nom, (SELECT json_extract(d.extraction, '$.fournisseur') FROM facture_documents d WHERE d.facture_id = f.id)) AS fournisseur,
         (SELECT d.id FROM facture_documents d WHERE d.facture_id = f.id) AS document_id,
         (SELECT json_extract(d.extraction, '$.lignes') FROM facture_documents d WHERE d.facture_id = f.id) AS articles_json
       FROM factures f
       LEFT JOIN fournisseurs fo ON fo.id = f.fournisseur_id
       ORDER BY f.id DESC`,
    )
    .all()
    .map(({ articles_json, ...f }) => ({
      ...f,
      total_calcule: totalFacture(f),
      // Articles lus sur le document déposé, pour aider à l'association aux ASIN.
      articles_extraits: lireArticles(articles_json),
      lignes: db.prepare('SELECT id, asin, quantite, prix_unitaire_ht FROM facture_lignes WHERE facture_id = ? ORDER BY id').all(f.id),
    }));
}
