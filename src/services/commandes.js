// Commandes fournisseurs, factures, réceptions et chaîne de rapprochement.
import { ErreurMetier, assurerProduit, journaliser, lireParametre, transaction } from '../db.js';
import { arrondir, normaliserAsin, normaliserReference, parserDate, parserMontant, parserQuantite, parserTriEtat } from '../lib/parse.js';
import { ajouterCout, creerDepense } from './couts.js';

function tolerance(db) {
  return Number(lireParametre(db, 'rapprochement.tolerance') || 0.02);
}

/* ---------------------------------------------------------------- commandes */

export function verifierDoublonNumero(db, numero, fournisseurId, exclureId = null) {
  const ref = normaliserReference(numero);
  if (!ref) return;
  const existantes = db
    .prepare('SELECT id, numero_commande, fournisseur_id FROM commandes WHERE id IS NOT ?')
    .all(exclureId)
    .filter((c) => normaliserReference(c.numero_commande) === ref && (c.fournisseur_id ?? null) === (fournisseurId ?? null));
  if (existantes.length) throw new ErreurMetier(`La commande ${numero} existe déjà pour ce fournisseur (#${existantes[0].id}).`, 409);
}

function lignesValides(lignes) {
  return (lignes || []).map((l, i) => {
    const asin = normaliserAsin(l.asin);
    if (!asin) throw new ErreurMetier(`Ligne ${i + 1} : ASIN invalide.`);
    const quantite = parserQuantite(l.quantite);
    if (!quantite) throw new ErreurMetier(`Ligne ${i + 1} : quantité invalide.`);
    const cout = l.cout_unitaire_ht === '' || l.cout_unitaire_ht == null ? null : parserMontant(l.cout_unitaire_ht);
    return { asin, quantite, cout_unitaire_ht: cout, ligne_import_id: l.ligne_import_id || null };
  });
}

export function creerCommande(db, c) {
  const lignes = lignesValides(c.lignes);
  const fournisseurId = c.fournisseur_id ? Number(c.fournisseur_id) : null;
  verifierDoublonNumero(db, c.numero_commande, fournisseurId);
  return transaction(db, () => {
    const r = db
      .prepare(
        `INSERT INTO commandes (fournisseur_id, numero_commande, date_commande, lien_original, total_declare,
           total_inclut_taxes, total_inclut_livraison, source, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fournisseurId,
        c.numero_commande ? String(c.numero_commande).trim() : null,
        parserDate(c.date_commande),
        c.lien_original || null,
        c.total_declare === '' || c.total_declare == null ? null : parserMontant(c.total_declare),
        parserTriEtat(c.total_inclut_taxes),
        parserTriEtat(c.total_inclut_livraison),
        c.source || 'manuel',
        c.notes || null,
      );
    const id = Number(r.lastInsertRowid);
    for (const l of lignes) ajouterLigneInterne(db, id, l, c.numero_commande);
    journaliser(db, 'commande', id, 'creation', { ...c, lignes });
    return id;
  });
}

function ajouterLigneInterne(db, commandeId, l, numero) {
  assurerProduit(db, l.asin);
  const r = db
    .prepare('INSERT INTO commande_lignes (commande_id, asin, quantite, cout_unitaire_ht) VALUES (?, ?, ?, ?)')
    .run(commandeId, l.asin, l.quantite, l.cout_unitaire_ht);
  if (l.ligne_import_id) {
    db.prepare("UPDATE lignes_import SET statut = 'rattachee', commande_id = ?, commande_ligne_id = ? WHERE id = ?").run(
      commandeId,
      Number(r.lastInsertRowid),
      l.ligne_import_id,
    );
  }
  if (l.cout_unitaire_ht !== null && l.cout_unitaire_ht !== undefined) {
    ajouterCout(db, { asin: l.asin, montant: l.cout_unitaire_ht, source: 'commande', reference: numero || `commande #${commandeId}`, commandeId });
  }
  return Number(r.lastInsertRowid);
}

export function ajouterLigneCommande(db, commandeId, ligne) {
  const c = db.prepare('SELECT * FROM commandes WHERE id = ?').get(commandeId);
  if (!c) throw new ErreurMetier('Commande introuvable.', 404);
  const [l] = lignesValides([ligne]);
  const id = ajouterLigneInterne(db, commandeId, l, c.numero_commande);
  journaliser(db, 'commande', commandeId, 'ligne_ajoutee', l);
  return id;
}

export function modifierLigneCommande(db, ligneId, { quantite, cout_unitaire_ht }) {
  const l = db.prepare('SELECT cl.*, c.numero_commande FROM commande_lignes cl JOIN commandes c ON c.id = cl.commande_id WHERE cl.id = ?').get(ligneId);
  if (!l) throw new ErreurMetier('Ligne introuvable.', 404);
  const q = quantite === undefined ? l.quantite : parserQuantite(quantite);
  if (!q) throw new ErreurMetier('Quantité invalide.');
  const cout = cout_unitaire_ht === undefined ? l.cout_unitaire_ht : cout_unitaire_ht === '' || cout_unitaire_ht === null ? null : parserMontant(cout_unitaire_ht);
  db.prepare('UPDATE commande_lignes SET quantite = ?, cout_unitaire_ht = ? WHERE id = ?').run(q, cout, ligneId);
  let ecart = null;
  if (cout !== null && cout !== l.cout_unitaire_ht) {
    const r = ajouterCout(db, { asin: l.asin, montant: cout, source: 'commande', reference: l.numero_commande || `commande #${l.commande_id}`, commandeId: l.commande_id });
    ecart = r.ecart;
  }
  journaliser(db, 'commande', l.commande_id, 'ligne_modifiee', { ligne_id: ligneId, avant: { quantite: l.quantite, cout: l.cout_unitaire_ht }, apres: { quantite: q, cout } });
  return { ecart };
}

export function supprimerLigneCommande(db, ligneId) {
  const l = db.prepare('SELECT * FROM commande_lignes WHERE id = ?').get(ligneId);
  if (!l) throw new ErreurMetier('Ligne introuvable.', 404);
  transaction(db, () => {
    // La ligne Google Sheets d'origine repasse en attente de rapprochement.
    db.prepare("UPDATE lignes_import SET statut = 'en_attente', commande_id = NULL, commande_ligne_id = NULL WHERE commande_ligne_id = ?").run(ligneId);
    db.prepare('DELETE FROM commande_lignes WHERE id = ?').run(ligneId);
    journaliser(db, 'commande', l.commande_id, 'ligne_supprimee', l);
  });
}

export function modifierCommande(db, id, champs) {
  const c = db.prepare('SELECT * FROM commandes WHERE id = ?').get(id);
  if (!c) throw new ErreurMetier('Commande introuvable.', 404);
  const n = {
    fournisseur_id: champs.fournisseur_id !== undefined ? (champs.fournisseur_id ? Number(champs.fournisseur_id) : null) : c.fournisseur_id,
    numero_commande: champs.numero_commande !== undefined ? String(champs.numero_commande || '').trim() || null : c.numero_commande,
    date_commande: champs.date_commande !== undefined ? parserDate(champs.date_commande) : c.date_commande,
    total_declare:
      champs.total_declare !== undefined ? (champs.total_declare === '' || champs.total_declare === null ? null : parserMontant(champs.total_declare)) : c.total_declare,
    total_inclut_taxes: champs.total_inclut_taxes !== undefined ? parserTriEtat(champs.total_inclut_taxes) : c.total_inclut_taxes,
    total_inclut_livraison: champs.total_inclut_livraison !== undefined ? parserTriEtat(champs.total_inclut_livraison) : c.total_inclut_livraison,
    notes: champs.notes !== undefined ? champs.notes : c.notes,
  };
  verifierDoublonNumero(db, n.numero_commande, n.fournisseur_id, id);
  db.prepare(
    `UPDATE commandes SET fournisseur_id = ?, numero_commande = ?, date_commande = ?, total_declare = ?,
       total_inclut_taxes = ?, total_inclut_livraison = ?, notes = ? WHERE id = ?`,
  ).run(n.fournisseur_id, n.numero_commande, n.date_commande, n.total_declare, n.total_inclut_taxes, n.total_inclut_livraison, n.notes, id);
  journaliser(db, 'commande', id, 'modification', { avant: c, apres: n });
}

export function supprimerCommande(db, id) {
  const c = db.prepare('SELECT * FROM commandes WHERE id = ?').get(id);
  if (!c) throw new ErreurMetier('Commande introuvable.', 404);
  transaction(db, () => {
    db.prepare("UPDATE lignes_import SET statut = 'en_attente', commande_id = NULL, commande_ligne_id = NULL WHERE commande_id = ?").run(id);
    db.prepare("UPDATE emails SET commande_id = NULL, statut_rapprochement = 'non_rapproche', mode_rapprochement = NULL WHERE commande_id = ?").run(id);
    db.prepare('UPDATE couts_achat SET commande_id = NULL WHERE commande_id = ?').run(id);
    db.prepare('DELETE FROM commandes WHERE id = ?').run(id);
    journaliser(db, 'commande', id, 'suppression', c);
  });
}

/* ----------------------------------------------------------------- factures */

export function totalFacture(f) {
  if (f.total !== null && f.total !== undefined) return f.total;
  if (f.sous_total_ht === null || f.sous_total_ht === undefined) return null;
  return arrondir((f.sous_total_ht || 0) + (f.taxes || 0) + (f.livraison || 0) + (f.autres_frais || 0));
}

export function creerFacture(db, f) {
  const montants = {};
  for (const cle of ['sous_total_ht', 'taxes', 'livraison', 'autres_frais', 'total']) {
    montants[cle] = f[cle] === '' || f[cle] == null ? null : parserMontant(f[cle]);
  }
  if (montants.total === null && montants.sous_total_ht === null) throw new ErreurMetier('Indiquez au moins le sous-total HT ou le total de la facture.');
  const lignes = (f.lignes || []).filter((l) => l.asin).map((l, i) => {
    const asin = normaliserAsin(l.asin);
    if (!asin) throw new ErreurMetier(`Ligne ${i + 1} : ASIN invalide.`);
    const quantite = parserQuantite(l.quantite);
    if (!quantite) throw new ErreurMetier(`Ligne ${i + 1} : quantité invalide.`);
    return { asin, quantite, prix: l.prix_unitaire_ht === '' || l.prix_unitaire_ht == null ? null : parserMontant(l.prix_unitaire_ht) };
  });
  return transaction(db, () => {
    let commandeId = f.commande_id ? Number(f.commande_id) : null;
    let proposition = null;
    if (!commandeId && f.numero_commande_ref) {
      const ref = normaliserReference(f.numero_commande_ref);
      const candidates = db.prepare('SELECT id, numero_commande FROM commandes').all().filter((c) => normaliserReference(c.numero_commande) === ref);
      if (candidates.length === 1) commandeId = candidates[0].id;
      else if (candidates.length > 1) proposition = { ambigu: true, candidates: candidates.map((c) => c.id) };
    }
    const commande = commandeId ? db.prepare('SELECT * FROM commandes WHERE id = ?').get(commandeId) : null;
    if (commandeId && !commande) throw new ErreurMetier('Commande introuvable.', 404);
    const r = db
      .prepare(
        `INSERT INTO factures (commande_id, fournisseur_id, numero_facture, numero_commande_ref, date_facture,
           sous_total_ht, taxes, livraison, autres_frais, total, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        commandeId,
        f.fournisseur_id || commande?.fournisseur_id || null,
        f.numero_facture || null,
        f.numero_commande_ref || commande?.numero_commande || null,
        parserDate(f.date_facture),
        montants.sous_total_ht,
        montants.taxes,
        montants.livraison,
        montants.autres_frais,
        montants.total,
        f.notes || null,
      );
    const id = Number(r.lastInsertRowid);
    if (commandeId) creerDepensesFacture(db, id, commandeId, montants, parserDate(f.date_facture));
    for (const l of lignes) {
      assurerProduit(db, l.asin);
      db.prepare('INSERT INTO facture_lignes (facture_id, asin, quantite, prix_unitaire_ht) VALUES (?, ?, ?, ?)').run(id, l.asin, l.quantite, l.prix);
      if (l.prix !== null) {
        ajouterCout(db, { asin: l.asin, montant: l.prix, source: 'facture', reference: f.numero_facture || `facture #${id}`, factureId: id, commandeId });
      }
    }
    journaliser(db, 'facture', id, 'creation', { ...f, commande_id: commandeId });
    return { id, commande_id: commandeId, proposition };
  });
}

/** Les frais détaillés d'une facture deviennent des dépenses de la commande. */
function creerDepensesFacture(db, factureId, commandeId, montants, date) {
  db.prepare('DELETE FROM depenses WHERE facture_id = ?').run(factureId);
  const correspondances = [
    ['livraison', 'livraison_fournisseur', 'Livraison (facture)'],
    ['taxes', 'taxes', 'Taxes (facture)'],
    ['autres_frais', 'autre', 'Autres frais (facture)'],
  ];
  for (const [cle, type, description] of correspondances) {
    if (montants[cle]) creerDepense(db, { type, montant: montants[cle], commande_id: commandeId, facture_id: factureId, date_depense: date, description });
  }
}

export function rattacherFacture(db, factureId, commandeId) {
  const f = db.prepare('SELECT * FROM factures WHERE id = ?').get(factureId);
  if (!f) throw new ErreurMetier('Facture introuvable.', 404);
  const c = commandeId ? db.prepare('SELECT * FROM commandes WHERE id = ?').get(commandeId) : null;
  if (commandeId && !c) throw new ErreurMetier('Commande introuvable.', 404);
  transaction(db, () => {
    db.prepare('UPDATE factures SET commande_id = ? WHERE id = ?').run(commandeId || null, factureId);
    db.prepare('UPDATE couts_achat SET commande_id = ? WHERE facture_id = ?').run(commandeId || null, factureId);
    if (commandeId) creerDepensesFacture(db, factureId, commandeId, f, f.date_facture);
    else db.prepare('DELETE FROM depenses WHERE facture_id = ?').run(factureId);
    journaliser(db, 'facture', factureId, 'rattachement', { avant: f.commande_id, apres: commandeId || null });
  });
}

export function supprimerFacture(db, id) {
  const f = db.prepare('SELECT * FROM factures WHERE id = ?').get(id);
  if (!f) throw new ErreurMetier('Facture introuvable.', 404);
  db.prepare('DELETE FROM factures WHERE id = ?').run(id);
  journaliser(db, 'facture', id, 'suppression', f);
}

export function listerFactures(db, { sansCommande = false } = {}) {
  return db
    .prepare(
      `SELECT f.*, c.numero_commande, fo.nom AS fournisseur FROM factures f
       LEFT JOIN commandes c ON c.id = f.commande_id
       LEFT JOIN fournisseurs fo ON fo.id = f.fournisseur_id
       ${sansCommande ? 'WHERE f.commande_id IS NULL' : ''}
       ORDER BY f.id DESC`,
    )
    .all()
    .map((f) => ({ ...f, total_calcule: totalFacture(f) }));
}

/**
 * Compare le total déclaré d'une commande au détail de ses factures.
 * Le total déclaré et les coûts détaillés représentent la même commande :
 * ils sont comparés, jamais additionnés.
 */
export function comparerTotal(commande, factures, tol = 0.02) {
  const declare = commande.total_declare;
  if (declare === null || declare === undefined) return { statut: 'sans_total', libelle: 'Aucun total déclaré' };
  if (!factures.length) return { statut: 'sans_facture', total_declare: declare, libelle: 'Total déclaré, composition non vérifiée (aucune facture)' };

  const somme = (cle) => factures.reduce((s, f) => s + (f[cle] || 0), 0);
  const sousTotalConnu = factures.every((f) => f.sous_total_ht !== null && f.sous_total_ht !== undefined);
  const totaux = factures.map(totalFacture);
  const totalConnu = totaux.every((t) => t !== null);
  const total = totalConnu ? arrondir(totaux.reduce((s, t) => s + t, 0)) : null;
  const st = sousTotalConnu ? somme('sous_total_ht') : null;
  const taxes = somme('taxes');
  const livraison = somme('livraison');
  const autres = somme('autres_frais');

  const base = (t, l) => {
    if (t && l) return total;
    if (st === null) return null;
    return arrondir(st + autres + (t ? taxes : 0) + (l ? livraison : 0));
  };
  const libelleBase = (t, l) =>
    t && l ? 'total facturé (taxes et livraison incluses)' : `sous-total HT${t ? ' + taxes' : ''}${l ? ' + livraison' : ''}${autres ? ' + autres frais' : ''}`;

  const t = commande.total_inclut_taxes;
  const l = commande.total_inclut_livraison;
  if (t === null || t === undefined || l === null || l === undefined) {
    const correspondances = [];
    for (const ct of [1, 0]) {
      for (const cl of [1, 0]) {
        if ((t !== null && t !== undefined && t !== ct) || (l !== null && l !== undefined && l !== cl)) continue;
        const b = base(ct, cl);
        if (b !== null && Math.abs(b - declare) <= tol) correspondances.push({ inclut_taxes: ct, inclut_livraison: cl, libelle: libelleBase(ct, cl), montant: b });
      }
    }
    return {
      statut: correspondances.length ? 'composition_inconnue' : 'ecart',
      total_declare: declare,
      montant_compare: total,
      base: 'total facturé',
      ecart: total === null ? null : arrondir(declare - total),
      correspondances,
      libelle: correspondances.length
        ? `Composition inconnue : le total déclaré correspond au ${correspondances.map((c) => c.libelle).join(' ou au ')}`
        : 'Composition inconnue et aucune combinaison de la facture ne correspond au total déclaré',
    };
  }
  const attendu = base(t, l);
  if (attendu === null) return { statut: 'detail_insuffisant', total_declare: declare, libelle: 'La facture ne détaille pas le sous-total HT' };
  const ecart = arrondir(declare - attendu);
  return {
    statut: Math.abs(ecart) <= tol ? 'conforme' : 'ecart',
    total_declare: declare,
    montant_compare: attendu,
    base: libelleBase(t, l),
    ecart,
    libelle: Math.abs(ecart) <= tol ? 'Total déclaré conforme à la facture' : `Écart de ${ecart.toFixed(2)} $ avec le ${libelleBase(t, l)}`,
  };
}

/* --------------------------------------------------------------- réceptions */

export function creerReception(db, commandeId, { date_reception, notes, lignes }) {
  const c = db.prepare('SELECT * FROM commandes WHERE id = ?').get(commandeId);
  if (!c) throw new ErreurMetier('Commande introuvable.', 404);
  const lignesCommande = db.prepare('SELECT asin, SUM(quantite) AS quantite FROM commande_lignes WHERE commande_id = ? GROUP BY asin').all(commandeId);
  const lignesRecues = (lignes && lignes.length ? lignes : lignesCommande).map((l) => {
    const asin = normaliserAsin(l.asin);
    const quantite = l.quantite === 0 || l.quantite === '0' ? 0 : parserQuantite(l.quantite);
    if (!asin || quantite === null) throw new ErreurMetier('Ligne de réception invalide.');
    return { asin, quantite };
  });
  return transaction(db, () => {
    const r = db.prepare('INSERT INTO receptions (commande_id, date_reception, notes) VALUES (?, ?, ?)').run(commandeId, parserDate(date_reception), notes || null);
    const id = Number(r.lastInsertRowid);
    for (const l of lignesRecues) {
      if (!l.quantite) continue;
      assurerProduit(db, l.asin);
      db.prepare('INSERT INTO reception_lignes (reception_id, asin, quantite) VALUES (?, ?, ?)').run(id, l.asin, l.quantite);
    }
    journaliser(db, 'reception', id, 'creation', { commande_id: commandeId, lignes: lignesRecues });
    return id;
  });
}

export function supprimerReception(db, id) {
  db.prepare('DELETE FROM receptions WHERE id = ?').run(id);
  journaliser(db, 'reception', id, 'suppression');
}

/* ----------------------------------------------------------------- lecture */

export function lireCommande(db, id) {
  const c = db
    .prepare('SELECT c.*, f.nom AS fournisseur FROM commandes c LEFT JOIN fournisseurs f ON f.id = c.fournisseur_id WHERE c.id = ?')
    .get(id);
  if (!c) throw new ErreurMetier('Commande introuvable.', 404);
  const lignes = db
    .prepare(
      `SELECT cl.*, p.titre, li.id AS ligne_import_id, li.numero_ligne, li.import_id
       FROM commande_lignes cl JOIN produits p ON p.asin = cl.asin
       LEFT JOIN lignes_import li ON li.commande_ligne_id = cl.id
       WHERE cl.commande_id = ? ORDER BY cl.id`,
    )
    .all(id);
  const lignesImport = db.prepare('SELECT * FROM lignes_import WHERE commande_id = ? ORDER BY import_id, numero_ligne').all(id);
  const emails = db.prepare('SELECT id, expediteur, sujet, date_reception, mode_rapprochement, references_extraites FROM emails WHERE commande_id = ?').all(id)
    .map((e) => ({ ...e, references_extraites: JSON.parse(e.references_extraites) }));
  const factures = db.prepare('SELECT * FROM factures WHERE commande_id = ? ORDER BY id').all(id).map((f) => ({
    ...f,
    total_calcule: totalFacture(f),
    lignes: db.prepare('SELECT * FROM facture_lignes WHERE facture_id = ?').all(f.id),
  }));
  const receptions = db.prepare('SELECT * FROM receptions WHERE commande_id = ? ORDER BY id').all(id).map((r) => ({
    ...r,
    lignes: db.prepare('SELECT * FROM reception_lignes WHERE reception_id = ?').all(r.id),
  }));
  const envois = db
    .prepare(
      `SELECT el.*, e.numero_envoi, e.date_envoi, e.statut FROM envoi_lignes el
       JOIN envois e ON e.id = el.envoi_id WHERE el.commande_id = ? ORDER BY e.id`,
    )
    .all(id);
  const depenses = db.prepare('SELECT * FROM depenses WHERE commande_id = ? ORDER BY id').all(id);
  const comparaison = comparerTotal(c, factures, tolerance(db));
  return { ...c, lignes, lignes_import: lignesImport, emails, factures, receptions, envois, depenses, comparaison, chaine: chaine(c, { lignes, lignesImport, emails, factures, receptions, envois }) };
}

function chaine(c, { lignes, lignesImport, emails, factures, receptions, envois }) {
  const commandees = lignes.reduce((s, l) => s + l.quantite, 0);
  const recues = receptions.reduce((s, r) => s + r.lignes.reduce((t, l) => t + l.quantite, 0), 0);
  const envoyees = envois.reduce((s, e) => s + e.quantite, 0);
  const etat = (ok, partiel = false) => (ok ? 'ok' : partiel ? 'partiel' : 'manquant');
  return [
    { etape: 'sheets', libelle: 'Ligne Google Sheets', etat: c.source === 'sheets' || lignesImport.length ? etat(lignesImport.length > 0) : 'non_applicable', detail: `${lignesImport.length} ligne(s)` },
    { etape: 'commande', libelle: 'Commande fournisseur', etat: c.numero_commande ? 'ok' : 'partiel', detail: c.numero_commande || 'numéro de commande à préciser' },
    { etape: 'gmail', libelle: 'Confirmation Gmail', etat: etat(emails.length > 0), detail: `${emails.length} email(s)` },
    { etape: 'facture', libelle: 'Facture', etat: etat(factures.length > 0), detail: `${factures.length} facture(s)` },
    { etape: 'reception', libelle: 'Réception', etat: etat(commandees > 0 && recues >= commandees, recues > 0), detail: `${recues} / ${commandees} unité(s)` },
    { etape: 'envoi', libelle: 'Envoi Amazon', etat: etat(commandees > 0 && envoyees >= commandees, envoyees > 0), detail: `${envoyees} unité(s) envoyée(s)` },
  ];
}

export function listerCommandes(db) {
  const tol = tolerance(db);
  return db
    .prepare(
      `SELECT c.*, f.nom AS fournisseur,
         (SELECT COUNT(*) FROM commande_lignes WHERE commande_id = c.id) AS nb_lignes,
         (SELECT COALESCE(SUM(quantite), 0) FROM commande_lignes WHERE commande_id = c.id) AS unites,
         (SELECT COUNT(*) FROM emails WHERE commande_id = c.id) AS nb_confirmations,
         (SELECT COUNT(*) FROM receptions WHERE commande_id = c.id) AS nb_receptions,
         (SELECT COALESCE(SUM(quantite), 0) FROM envoi_lignes WHERE commande_id = c.id) AS unites_envoyees
       FROM commandes c LEFT JOIN fournisseurs f ON f.id = c.fournisseur_id
       ORDER BY COALESCE(c.date_commande, c.created_at) DESC, c.id DESC`,
    )
    .all()
    .map((c) => {
      const factures = db.prepare('SELECT * FROM factures WHERE commande_id = ?').all(c.id);
      return { ...c, nb_factures: factures.length, comparaison: comparerTotal(c, factures, tol) };
    });
}
