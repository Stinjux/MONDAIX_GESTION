import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { ouvrirBase } from '../src/db.js';
import { deposerDocument, extraireAvecClaude, extraireDocument, validerDocument, supprimerDocument, lireDocument, propositions } from '../src/services/documentsFactures.js';
import { creerCommande, lireCommande, supprimerFacture } from '../src/services/commandes.js';
import { coutRetenu } from '../src/services/couts.js';

const dossier = mkdtempSync(join(tmpdir(), 'mondaix-docs-'));
process.env.MONDAIX_DOCUMENTS = dossier;
after(() => rmSync(dossier, { recursive: true, force: true }));

const PDF = Buffer.from('%PDF-1.4 facture factice').toString('base64');
const EXTRACTION = {
  fournisseur: 'Walmart Canada', numero_facture: 'INV-77', numero_commande: 'W-2001', date_facture: '2026-10-01', devise: 'CAD',
  sous_total_ht: 80, taxes: 11.98, livraison: 5, autres_frais: null, total: 96.98,
  lignes: [
    { description: 'Gourde isotherme 750 ml bleue', reference: null, asin: null, quantite: 2, prix_unitaire_ht: 25, total_ligne: 50 },
    { description: 'Tapis de yoga', reference: 'TY-1', asin: null, quantite: 3, prix_unitaire_ht: 10, total_ligne: 30 },
  ],
};
const extraireFaux = async () => EXTRACTION;

let db;
beforeEach(() => {
  db = ouvrirBase(':memory:');
});

test('dépôt d’un PDF : fichier conservé, extraction, propositions de commande et d’ASIN', async () => {
  const c = creerCommande(db, { numero_commande: 'W-2001', total_declare: 96.98, lignes: [{ asin: 'B0AAAAAAA1', quantite: 2 }, { asin: 'B0AAAAAAA2', quantite: 3 }] });
  const d = await deposerDocument(db, { nom: 'facture.pdf', type: 'application/pdf', donnees: PDF }, { extraire: extraireFaux });
  assert.ok(existsSync(join(dossier, d.chemin.split('/').pop())));
  assert.equal(d.statut, 'a_valider');
  assert.equal(d.extraction.numero_facture, 'INV-77');
  assert.equal(d.propositions.commande.id, c);
  assert.deepEqual(d.propositions.lignes.map((l) => l.asin), ['B0AAAAAAA1', 'B0AAAAAAA2'], 'même quantité que les lignes de la commande');
  const encore = await deposerDocument(db, { nom: 'copie.pdf', type: 'application/pdf', donnees: PDF }, { extraire: extraireFaux });
  assert.equal(encore.doublon, true);
  assert.equal(encore.id, d.id);
});

test('proposition d’ASIN par ressemblance du titre quand aucune commande ne correspond', () => {
  db.prepare("INSERT INTO produits (asin, titre) VALUES ('B0AAAAAAA9', 'Gourde isotherme inox 750 ml')").run();
  const p = propositions(db, { ...EXTRACTION, numero_commande: null, total: 1 });
  assert.equal(p.commande, null);
  assert.deepEqual(p.lignes.map((l) => l.asin), ['B0AAAAAAA9', null]);
});

test('validation : une ligne → un ASIN, plusieurs lignes → plusieurs ASIN ; coût d’achat historisé', async () => {
  const c = creerCommande(db, { numero_commande: 'W-2001', lignes: [{ asin: 'B0AAAAAAA1', quantite: 2 }] });
  const d = await deposerDocument(db, { nom: 'f.pdf', type: 'application/pdf', donnees: PDF }, { extraire: extraireFaux });
  const f = validerDocument(db, d.id, {
    commande_id: c, numero_facture: 'INV-77', date_facture: '2026-10-01', sous_total_ht: 80, taxes: 11.98, livraison: 5, total: 96.98,
    lignes: [
      { asin: 'B0AAAAAAA1', quantite: 2, prix_unitaire_ht: 25 },
      { asin: 'B0AAAAAAA2', quantite: 3, prix_unitaire_ht: 10 },
      { asin: '', quantite: 1, prix_unitaire_ht: 4 },
    ],
  });
  const facture = lireCommande(db, c).factures[0];
  assert.equal(facture.id, f.id);
  assert.equal(facture.document_id, d.id);
  assert.deepEqual(facture.lignes.map((l) => [l.asin, l.quantite, l.prix_unitaire_ht]), [['B0AAAAAAA1', 2, 25], ['B0AAAAAAA2', 3, 10]], 'ligne sans ASIN ignorée');
  assert.equal(coutRetenu(db, 'B0AAAAAAA2').montant_unitaire_ht, 10);
  assert.equal(lireDocument(db, d.id).statut, 'valide');
  assert.throws(() => validerDocument(db, d.id, { total: 1 }), /déjà été enregistrée/);
  assert.throws(() => supprimerDocument(db, d.id), /lié à une facture/);
  supprimerFacture(db, f.id);
  assert.equal(lireDocument(db, d.id).statut, 'a_valider', 'le document redevient à valider');
  supprimerDocument(db, d.id);
});

test('format refusé, et erreur d’extraction enregistrée sans bloquer la saisie', async () => {
  await assert.rejects(deposerDocument(db, { nom: 'x.svg', type: 'image/svg+xml', donnees: PDF }), /Format non pris en charge/);
  const d = await deposerDocument(db, { nom: 'scan.jpg', type: 'image/jpeg', donnees: Buffer.from('jpeg').toString('base64') }, {
    extraire: async () => {
      throw new (await import('../src/db.js')).ErreurMetier('Extraction automatique non configurée');
    },
  });
  assert.match(d.erreur_extraction, /non configurée/);
  assert.equal(d.extraction, null);
  const r = await extraireDocument(db, d.id, { extraire: extraireFaux });
  assert.equal(r.erreur_extraction, null);
  assert.equal(r.extraction.lignes.length, 2);
});

test('appel à l’API Claude : PDF en bloc document, image en bloc image, sortie JSON contrainte, refus géré', async () => {
  const appels = [];
  const client = (reponse) => ({ beta: { messages: { create: async (params) => (appels.push(params), reponse) } } });
  const ok = { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(EXTRACTION) }] };
  const r = await extraireAvecClaude({ donnees: Buffer.from('pdf'), typeMime: 'application/pdf' }, { client: client(ok) });
  assert.equal(r.total, 96.98);
  const p = appels[0];
  assert.equal(p.model, 'claude-opus-5-5');
  assert.equal(p.fallbacks, 'default');
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(p.output_config.format.type, 'json_schema');
  assert.equal(p.messages[0].content[0].type, 'document');
  await extraireAvecClaude({ donnees: Buffer.from('img'), typeMime: 'image/png' }, { client: client(ok) });
  assert.equal(appels[1].messages[0].content[0].type, 'image');
  assert.equal(appels[1].messages[0].content[0].source.media_type, 'image/png');
  await assert.rejects(extraireAvecClaude({ donnees: Buffer.from('x'), typeMime: 'image/png' }, { client: client({ stop_reason: 'refusal', content: [] }) }), /refusée/);
  const enPanne = { beta: { messages: { create: async () => { throw new Anthropic.AuthenticationError(401, { error: {} }, 'invalid x-api-key', new Headers()); } } } };
  await assert.rejects(extraireAvecClaude({ donnees: Buffer.from('x'), typeMime: 'image/png' }, { client: enPanne }), /Clé ANTHROPIC_API_KEY refusée/);
});
