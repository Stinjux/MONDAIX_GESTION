import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ouvrirBase } from '../src/db.js';
import { importerInventaire } from '../src/services/inventaire.js';
import { creerFacture } from '../src/services/factures.js';
import { coutComplet, ecartsCouts, historiqueCouts, retenirCout, coutRetenu, creerDepense, listerDepenses } from '../src/services/couts.js';
import { ingererEmail, appliquerStatutNeo, lireEmail, migrerGmailVersAsin } from '../src/services/emails.js';
import { creerDossier, etatParAsin } from '../src/services/autorisations.js';
import { creerEnvoi } from '../src/services/envois.js';
import { tableauDeBord } from '../src/services/tableauDeBord.js';

let db;
beforeEach(() => {
  db = ouvrirBase(':memory:');
});

test('cost d’inventaire : coût d’achat HT conservé, écarts signalés sans écrasement', () => {
  const inv = 'asin,cost\nB0AAAAAAA1,10.00\n';
  importerInventaire(db, { texte: inv, mapping: { asin: 0, cost: 1 }, nom: 'inv1' });
  assert.equal(coutRetenu(db, 'B0AAAAAAA1').montant_unitaire_ht, 10);
  // la facture indique un autre prix unitaire
  creerFacture(db, { numero_facture: 'F-1', sous_total_ht: 31.5, lignes: [{ asin: 'B0AAAAAAA1', quantite: 3, prix_unitaire_ht: 10.5 }] });
  assert.equal(coutRetenu(db, 'B0AAAAAAA1').montant_unitaire_ht, 10, 'pas d’écrasement silencieux');
  const ecarts = ecartsCouts(db);
  assert.equal(ecarts.length, 1);
  assert.equal(ecarts[0].ecart, 0.5);
  // choix explicite
  retenirCout(db, 'B0AAAAAAA1', ecarts[0].cout_id);
  assert.equal(coutRetenu(db, 'B0AAAAAAA1').montant_unitaire_ht, 10.5);
  assert.equal(ecartsCouts(db).length, 0);
  assert.equal(historiqueCouts(db, 'B0AAAAAAA1').length, 2, 'historique conservé');
  // réimport du même fichier : refusé, pas de doublon d'historique
  assert.throws(() => importerInventaire(db, { texte: inv, mapping: { asin: 0, cost: 1 }, nom: 'inv1' }), /identique au dernier import/);
  assert.equal(historiqueCouts(db, 'B0AAAAAAA1').length, 2);
});

test('coût complet = coût d’achat + frais des factures + frais d’envoi + dépenses directes', () => {
  creerFacture(db, {
    numero_facture: 'F-2',
    sous_total_ht: 50,
    livraison: 8,
    taxes: 7.5,
    total: 65.5,
    lignes: [
      { asin: 'B0AAAAAAA1', quantite: 3, prix_unitaire_ht: 10 },
      { asin: 'B0AAAAAAA2', quantite: 1, prix_unitaire_ht: 20 },
    ],
  });
  let cc = coutComplet(db, 'B0AAAAAAA1');
  // livraison 8 $ répartie au prorata du HT : 30/50 → 4,80 $ sur 3 unités = 1,60 $/unité (taxes exclues par défaut)
  assert.deepEqual(cc.par_unite, { achat: 10, frais_facture: 1.6, frais_envoi: 0, frais_directs: 0 });
  assert.ok(cc.alertes.some((a) => /Aucun envoi Amazon/.test(a)));
  const eid = creerEnvoi(db, { numero_envoi: 'FBA1', lignes: [{ asin: 'B0AAAAAAA1', quantite: 3 }, { asin: 'B0AAAAAAA2', quantite: 1 }] });
  creerDepense(db, { type: 'transport_amazon', montant: 4, envoi_id: eid });
  creerDepense(db, { type: 'preparation', montant: 1.5, asin: 'B0AAAAAAA1', quantite_concernee: 3 });
  cc = coutComplet(db, 'B0AAAAAAA1');
  // transport 4 $ sur 4 unités → 1/unité ; préparation 0,5/unité
  assert.deepEqual(cc.par_unite, { achat: 10, frais_facture: 1.6, frais_envoi: 1, frais_directs: 0.5 });
  assert.equal(cc.cout_complet_unitaire, 13.1);
  assert.equal(listerDepenses(db).length, 2);
});

test('Gmail → associé directement aux ASIN : automatique si un seul ASIN cité', () => {
  const { id } = ingererEmail(db, 'gmail', { expediteur: 'Walmart <noreply@walmart.ca>', sujet: 'Your order', corps: 'Item B0AAAAAAA1\nTotal : 20,00 $' });
  const e = lireEmail(db, id);
  assert.deepEqual(e.liens.map((l) => l.valeur), ['B0AAAAAAA1']);
  assert.equal(e.statut_rapprochement, 'valide');
  const { id: id2 } = ingererEmail(db, 'gmail', { expediteur: 'orders@walmart.ca', sujet: 'Merci', corps: 'Total : 50,00 $' });
  assert.equal(lireEmail(db, id2).statut_rapprochement, 'non_rapproche', 'sans ASIN : à associer');
  // la base refuse un email Gmail rangé dans le module des autorisations
  assert.throws(() => db.prepare("INSERT INTO emails (source, module) VALUES ('gmail', 'autorisations')").run());
});

test('rattrapage : confirmation Gmail rattachée à une ancienne commande → associée à ses ASIN', () => {
  const c = db.prepare("INSERT INTO commandes (numero_commande) VALUES ('W-1')").run().lastInsertRowid;
  db.prepare("INSERT INTO produits (asin) VALUES ('B0AAAAAAA5')").run();
  db.prepare("INSERT INTO commande_lignes (commande_id, asin, quantite) VALUES (?, 'B0AAAAAAA5', 2)").run(c);
  const r = db.prepare("INSERT INTO emails (source, module, message_id, sujet, commande_id, statut_rapprochement, mode_rapprochement) VALUES ('gmail', 'commandes', 'x', 'Order', ?, 'valide', 'manuel')").run(c);
  migrerGmailVersAsin(db);
  const e = lireEmail(db, Number(r.lastInsertRowid));
  assert.deepEqual(e.liens.map((l) => [l.valeur, l.mode]), [['B0AAAAAAA5', 'manuel']]);
  assert.equal(e.statut_rapprochement, 'valide');
});

test('Neo → ASIN ; statut confirmé seulement après validation', () => {
  creerDossier(db, { asin: 'B0AAAAAAA1', numero_cas: '12345678901' });
  creerDossier(db, { asin: 'B0AAAAAAA2' });
  const { id } = ingererEmail(db, 'neo', { expediteur: 'seller-performance@amazon.ca', sujet: 'Case 12345678901', corps: 'Your request for ASIN B0AAAAAAA1 has been approved.' });
  const e = lireEmail(db, id);
  assert.equal(e.module, 'autorisations');
  assert.deepEqual(e.liens.map((l) => l.valeur), ['B0AAAAAAA1']);
  assert.equal(e.references_extraites.statut, 'approuve');
  let etat = etatParAsin(db).find((a) => a.asin === 'B0AAAAAAA1');
  assert.equal(etat.confirme, false, 'statut détecté non appliqué sans validation');
  appliquerStatutNeo(db, id, 'approuve');
  etat = etatParAsin(db).find((a) => a.asin === 'B0AAAAAAA1');
  assert.equal(etat.confirme, true);
  assert.equal(etatParAsin(db).find((a) => a.asin === 'B0AAAAAAA2').confirme, false, 'ASIN non associé inchangé');
});

test('tableau de bord : factures sans ASIN, envois à vérifier, ASIN sans autorisation confirmée', () => {
  creerFacture(db, { numero_facture: 'F-1', total: 120 });
  creerFacture(db, { numero_facture: 'F-2', total: 40, lignes: [{ asin: 'B0AAAAAAA1', quantite: 2, prix_unitaire_ht: 20 }] });
  creerEnvoi(db, { numero_envoi: 'FBA1', date_envoi: '2026-10-01', statut: 'expedie', lignes: [{ asin: 'B0AAAAAAA1', quantite: 2 }] });
  const t = tableauDeBord(db);
  assert.equal(t.compteurs.factures_sans_asin, 1);
  assert.equal(t.factures_sans_asin[0].numero_facture, 'F-1');
  assert.deepEqual([t.compteurs.envois_a_verifier, t.compteurs.unites_en_transit], [1, 2]);
  assert.equal(t.compteurs.asin_sans_autorisation_confirmee, 1);
  assert.equal(t.compteurs.commandes_sans_facture, undefined, 'plus aucune notion de commande');
});
