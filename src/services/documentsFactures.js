// Factures déposées en PDF ou en image : enregistrement du fichier, extraction des données
// par Claude, propositions d'ASIN par article, puis validation en facture.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { ErreurMetier, journaliser, lireParametre, transaction } from '../db.js';
import { cheminBase } from '../env.js';
import { normaliserAsin, normaliserTexte } from '../lib/parse.js';
import { creerFacture } from './factures.js';

export const TYPES_ACCEPTES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const TAILLE_MAX = 20 * 1024 * 1024;
const MODELE = 'claude-opus-5-5';

/** Dossier des fichiers, à côté de la base (donc sur le volume persistant en production). */
export function dossierDocuments() {
  const base = cheminBase();
  return process.env.MONDAIX_DOCUMENTS || join(base === ':memory:' ? 'data' : dirname(base), 'factures');
}

/* ----------------------------------------------------------------- extraction */

const nombreOuNul = { anyOf: [{ type: 'number' }, { type: 'null' }] };
const texteOuNul = { anyOf: [{ type: 'string' }, { type: 'null' }] };

const SCHEMA_FACTURE = {
  type: 'object',
  additionalProperties: false,
  required: ['fournisseur', 'numero_facture', 'numero_commande', 'date_facture', 'devise', 'sous_total_ht', 'taxes', 'livraison', 'autres_frais', 'total', 'lignes'],
  properties: {
    fournisseur: texteOuNul,
    numero_facture: texteOuNul,
    numero_commande: texteOuNul,
    date_facture: { ...texteOuNul, description: 'Format AAAA-MM-JJ' },
    devise: texteOuNul,
    sous_total_ht: nombreOuNul,
    taxes: nombreOuNul,
    livraison: nombreOuNul,
    autres_frais: nombreOuNul,
    total: nombreOuNul,
    lignes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'reference', 'asin', 'quantite', 'prix_unitaire_ht', 'total_ligne'],
        properties: {
          description: { type: 'string' },
          reference: texteOuNul,
          asin: texteOuNul,
          quantite: nombreOuNul,
          prix_unitaire_ht: nombreOuNul,
          total_ligne: nombreOuNul,
        },
      },
    },
  },
};

const CONSIGNE = `Extrais les données de cette facture fournisseur (achat de marchandises destinées à la revente sur Amazon).
- lignes : une entrée par article acheté (pas de ligne pour la livraison, les taxes ou les remises globales).
- prix_unitaire_ht : prix unitaire avant taxes ; reference : SKU, UPC, modèle ou code article s'il y en a un ; asin : seulement s'il est écrit sur la facture.
- sous_total_ht : total des marchandises avant taxes ; taxes : total de toutes les taxes (TPS, TVQ, TVH…) ; livraison : frais de port ; autres_frais : autres frais éventuels ; total : montant total payé.
- Montants en nombres (point décimal), sans symbole monétaire. date_facture au format AAAA-MM-JJ.
- Mets null pour toute information absente ou illisible ; n'invente rien.`;

/**
 * Extraction par l'API Claude (sortie JSON contrainte par le schéma).
 * Nécessite ANTHROPIC_API_KEY ; sinon la facture se saisit à la main à côté de l'aperçu.
 */
export async function extraireAvecClaude({ donnees, typeMime }, { client = null } = {}) {
  if (!client && !process.env.ANTHROPIC_API_KEY) {
    throw new ErreurMetier('Extraction automatique non configurée : ajoutez ANTHROPIC_API_KEY dans les variables Railway.', 503);
  }
  const c = client || new Anthropic();
  const source = { type: 'base64', media_type: typeMime, data: donnees.toString('base64') };
  const bloc = typeMime === 'application/pdf' ? { type: 'document', source } : { type: 'image', source };
  let reponse;
  try {
    reponse = await c.beta.messages.create({
      model: MODELE,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA_FACTURE } },
      messages: [{ role: 'user', content: [bloc, { type: 'text', text: CONSIGNE }] }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new ErreurMetier('Clé ANTHROPIC_API_KEY refusée.', 502);
    if (e instanceof Anthropic.RateLimitError) throw new ErreurMetier('Limite d’utilisation de l’API atteinte : réessayez dans un moment.', 503);
    if (e instanceof Anthropic.BadRequestError) throw new ErreurMetier(`Document refusé par l’API : ${e.message}`, 422);
    if (e instanceof Anthropic.APIError) throw new ErreurMetier(`Erreur de l’API (${e.status ?? 'réseau'}) : ${e.message}`, 502);
    throw e;
  }
  if (reponse.stop_reason === 'refusal') throw new ErreurMetier('Extraction refusée par le modèle pour ce document : saisissez la facture à la main.', 422);
  if (reponse.stop_reason === 'max_tokens') throw new ErreurMetier('Facture trop longue pour une extraction complète : saisissez-la à la main.', 422);
  const texte = reponse.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(texte);
  } catch {
    throw new ErreurMetier('Réponse d’extraction illisible : réessayez ou saisissez la facture à la main.', 502);
  }
}

/* --------------------------------------------------------------- propositions */

function mots(texte) {
  return new Set(normaliserTexte(texte).split(' ').filter((m) => m.length >= 3));
}

/** Score de ressemblance entre une description de facture et un titre d'ASIN (0 à 1). */
function ressemblance(a, b) {
  const x = mots(a);
  const y = mots(b);
  if (!x.size || !y.size) return 0;
  let communs = 0;
  for (const m of x) if (y.has(m)) communs++;
  return communs / Math.min(x.size, y.size);
}

/**
 * Propositions à valider : ASIN pour chaque article (écrit sur la facture, sinon titre ressemblant).
 * Rien n'est associé sans validation.
 */
export function propositions(db, extraction) {
  const resultat = { lignes: [] };
  if (!extraction) return resultat;
  const produits = db.prepare('SELECT asin, titre FROM produits WHERE titre IS NOT NULL').all();
  for (const l of extraction.lignes || []) {
    let asin = normaliserAsin(l.asin);
    let motif = asin ? 'ASIN écrit sur la facture' : null;
    if (!asin) {
      const meilleurs = produits.map((p) => ({ asin: p.asin, score: ressemblance(`${l.description} ${l.reference || ''}`, p.titre) })).filter((p) => p.score >= 0.5).sort((a, b) => b.score - a.score);
      if (meilleurs.length && (meilleurs.length === 1 || meilleurs[0].score > meilleurs[1].score)) [asin, motif] = [meilleurs[0].asin, 'titre ressemblant'];
    }
    resultat.lignes.push({ asin, motif });
  }
  return resultat;
}

/* ------------------------------------------------------------- enregistrement */

function versObjet(d) {
  return d && { ...d, extraction: d.extraction ? JSON.parse(d.extraction) : null };
}

export function lireDocument(db, id) {
  const d = versObjet(db.prepare('SELECT * FROM facture_documents WHERE id = ?').get(id));
  if (!d) throw new ErreurMetier('Document introuvable.', 404);
  return { ...d, propositions: propositions(db, d.extraction) };
}

export function listerDocuments(db, { statut } = {}) {
  return db
    .prepare(
      `SELECT d.id, d.facture_id, d.nom_fichier, d.type_mime, d.taille, d.statut, d.erreur_extraction, d.created_at, d.extraction,
         f.numero_facture, f.commande_id
       FROM facture_documents d LEFT JOIN factures f ON f.id = d.facture_id
       ${statut ? 'WHERE d.statut = ?' : ''} ORDER BY d.id DESC`,
    )
    .all(...(statut ? [statut] : []))
    .map(versObjet);
}

export function fichierDocument(db, id) {
  const d = db.prepare('SELECT chemin, type_mime, nom_fichier FROM facture_documents WHERE id = ?').get(id);
  if (!d) throw new ErreurMetier('Document introuvable.', 404);
  return { contenu: readFileSync(d.chemin), type: d.type_mime, nom: d.nom_fichier };
}

/** Enregistre le fichier (une seule fois par contenu) et lance l'extraction. */
export async function deposerDocument(db, { nom, type, donnees }, { extraire = extraireAvecClaude } = {}) {
  if (!(type in TYPES_ACCEPTES)) throw new ErreurMetier('Format non pris en charge : PDF, JPEG, PNG, WEBP ou GIF.', 415);
  const contenu = Buffer.from(String(donnees || ''), 'base64');
  if (!contenu.length) throw new ErreurMetier('Fichier vide.');
  if (contenu.length > TAILLE_MAX) throw new ErreurMetier('Fichier trop volumineux (20 Mo maximum).', 413);
  const empreinte = createHash('sha256').update(contenu).digest('hex');
  const existant = db.prepare('SELECT id FROM facture_documents WHERE empreinte = ?').get(empreinte);
  if (existant) return { ...lireDocument(db, existant.id), doublon: true };

  const dossier = dossierDocuments();
  mkdirSync(dossier, { recursive: true });
  const chemin = join(dossier, `${empreinte.slice(0, 24)}.${TYPES_ACCEPTES[type]}`);
  writeFileSync(chemin, contenu);
  const r = db
    .prepare('INSERT INTO facture_documents (nom_fichier, type_mime, taille, chemin, empreinte) VALUES (?, ?, ?, ?, ?)')
    .run(String(nom || 'facture').slice(0, 200), type, contenu.length, chemin, empreinte);
  const id = Number(r.lastInsertRowid);
  journaliser(db, 'facture_document', id, 'depot', { nom, type, taille: contenu.length });
  await extraireDocument(db, id, { extraire });
  return { ...lireDocument(db, id), doublon: false };
}

/** (Re)lance l'extraction ; une erreur est enregistrée sans bloquer la saisie manuelle. */
export async function extraireDocument(db, id, { extraire = extraireAvecClaude } = {}) {
  const d = db.prepare('SELECT * FROM facture_documents WHERE id = ?').get(id);
  if (!d) throw new ErreurMetier('Document introuvable.', 404);
  try {
    const extraction = await extraire({ donnees: readFileSync(d.chemin), typeMime: d.type_mime });
    db.prepare('UPDATE facture_documents SET extraction = ?, erreur_extraction = NULL WHERE id = ?').run(JSON.stringify(extraction), id);
    journaliser(db, 'facture_document', id, 'extraction', { lignes: extraction.lignes?.length ?? 0 });
  } catch (e) {
    if (!(e instanceof ErreurMetier)) console.error(e);
    db.prepare('UPDATE facture_documents SET erreur_extraction = ? WHERE id = ?').run(e instanceof ErreurMetier ? e.message : 'Erreur interne pendant l’extraction.', id);
  }
  return lireDocument(db, id);
}

/**
 * Validation : crée la facture avec les lignes associées à un ASIN (une ligne → un ASIN ;
 * plusieurs lignes → plusieurs ASIN). Les lignes sans ASIN ne sont pas enregistrées.
 */
export function validerDocument(db, id, saisie) {
  const d = lireDocument(db, id);
  if (d.statut === 'valide') throw new ErreurMetier('Cette facture a déjà été enregistrée.', 409);
  const lignes = (saisie.lignes || []).filter((l) => l.asin && String(l.asin).trim());
  return transaction(db, () => {
    const facture = creerFacture(db, {
      numero_facture: saisie.numero_facture,
      // Référence lue sur la facture, conservée telle quelle.
      numero_commande_ref: saisie.numero_commande_ref ?? d.extraction?.numero_commande ?? null,
      date_facture: saisie.date_facture,
      sous_total_ht: saisie.sous_total_ht,
      taxes: saisie.taxes,
      livraison: saisie.livraison,
      autres_frais: saisie.autres_frais,
      total: saisie.total,
      notes: `Document : ${d.nom_fichier}`,
      lignes: lignes.map((l) => ({ asin: l.asin, quantite: l.quantite, prix_unitaire_ht: l.prix_unitaire_ht })),
    });
    db.prepare("UPDATE facture_documents SET facture_id = ?, statut = 'valide' WHERE id = ?").run(facture.id, id);
    journaliser(db, 'facture_document', id, 'valide', { facture_id: facture.id, lignes: lignes.length });
    return { ...facture, document_id: id };
  });
}

export function supprimerDocument(db, id) {
  const d = db.prepare('SELECT * FROM facture_documents WHERE id = ?').get(id);
  if (!d) throw new ErreurMetier('Document introuvable.', 404);
  if (d.statut === 'valide') throw new ErreurMetier('Document lié à une facture enregistrée : supprimez d’abord la facture.', 409);
  db.prepare('DELETE FROM facture_documents WHERE id = ?').run(id);
  try {
    unlinkSync(d.chemin);
  } catch {
    // fichier déjà absent
  }
  journaliser(db, 'facture_document', id, 'suppression', { nom: d.nom_fichier });
}

export function extractionConfiguree() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Rattrapage unique : n° de commande lu sur le document recopié sur les factures déjà
 * enregistrées sans ce numéro (sans rattachement), pour éviter un double comptage des dépenses.
 */
export function migrerReferencesFactures(db) {
  if (lireParametre(db, 'migration.references_factures') === '1') return 0;
  let n = 0;
  transaction(db, () => {
    const lignes = db
      .prepare(
        `SELECT f.id, json_extract(d.extraction, '$.numero_commande') AS numero
         FROM factures f JOIN facture_documents d ON d.facture_id = f.id
         WHERE f.numero_commande_ref IS NULL AND d.extraction IS NOT NULL`,
      )
      .all();
    for (const l of lignes) {
      if (!l.numero) continue;
      db.prepare('UPDATE factures SET numero_commande_ref = ? WHERE id = ?').run(l.numero, l.id);
      n++;
    }
    db.prepare("INSERT INTO parametres (cle, valeur) VALUES ('migration.references_factures', '1') ON CONFLICT(cle) DO UPDATE SET valeur = '1'").run();
  });
  return n;
}
