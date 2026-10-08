import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ouvrirBase } from '../src/db.js';
import { ingererEmail, lierEmail, delierEmail, lireEmail, emailsPourAsin, emailsPourCas, migrerLiensEmails } from '../src/services/emails.js';
import { creerCommande, creerFacture, creerReception } from '../src/services/commandes.js';
import { creerEnvoi } from '../src/services/envois.js';
import { creerDossier } from '../src/services/autorisations.js';
import { statistiques, montantCommande } from '../src/services/statistiques.js';
import { listerAsins, ficheAsin } from '../src/services/asins.js';

let db;
beforeEach(() => {
  db = ouvrirBase(':memory:');
});

test('emails Gmail et Neo liés à un ASIN ou un cas : automatique si unique, manuel sinon', () => {
  const { id: n1 } = ingererEmail(db, 'neo', { sujet: 'Brand approval', corps: 'Case ID: 12345678901 for ASIN B0AAAAAAA1' });
  const e1 = lireEmail(db, n1);
  assert.deepEqual(e1.liens.map((l) => [l.type, l.valeur, l.mode]).sort(), [['asin', 'B0AAAAAAA1', 'auto'], ['cas', '12345678901', 'auto']]);

  // Plusieurs ASIN cités : pas de lien automatique, liaison manuelle possible
  const { id: g1 } = ingererEmail(db, 'gmail', { sujet: 'Your order', corps: 'Items B0AAAAAAA2 and B0AAAAAAA3' });
  assert.equal(lireEmail(db, g1).liens.length, 0);
  lierEmail(db, g1, { type: 'asin', valeur: 'b0aaaaaaa2' });
  lierEmail(db, g1, { type: 'cas', valeur: 'Case 98765432100' });
  const e2 = lireEmail(db, g1);
  assert.deepEqual(e2.liens.map((l) => `${l.type}:${l.valeur}:${l.mode}`).sort(), ['asin:B0AAAAAAA2:manuel', 'cas:98765432100:manuel']);
  assert.throws(() => lierEmail(db, g1, { type: 'asin', valeur: 'pas-un-asin' }), /ASIN invalide/);

  assert.deepEqual(emailsPourAsin(db, 'B0AAAAAAA2').map((e) => e.id), [g1]);
  assert.deepEqual(emailsPourCas(db, '12345678901').map((e) => e.id), [n1]);
  delierEmail(db, e2.liens.find((l) => l.type === 'asin').id);
  assert.equal(emailsPourAsin(db, 'B0AAAAAAA2').length, 0);
  assert.ok(db.prepare("SELECT 1 FROM produits WHERE asin = 'B0AAAAAAA2'").get(), 'ASIN lié ajouté au catalogue');
});

test('rattrapage des liens pour les emails existants, exécuté une seule fois', () => {
  const { id } = ingererEmail(db, 'neo', { sujet: 'x', corps: 'ASIN B0AAAAAAA1' });
  db.prepare('DELETE FROM email_liens').run();
  assert.equal(migrerLiensEmails(db), 1);
  assert.equal(lireEmail(db, id).liens.length, 1);
  db.prepare('DELETE FROM email_liens').run();
  assert.equal(migrerLiensEmails(db), 0, 'déjà fait : un lien retiré par l’utilisateur n’est pas recréé');
});

test('montant d’une commande : facture, sinon total déclaré, sinon lignes — jamais additionnés', () => {
  assert.equal(montantCommande({ total_declare: 100 }, [{ total: 120 }], []).montant, 120);
  assert.equal(montantCommande({ total_declare: 100 }, [], [{ quantite: 2, cout_unitaire_ht: 10 }]).montant, 100);
  assert.equal(montantCommande({ total_declare: null }, [], [{ quantite: 2, cout_unitaire_ht: 10 }]).montant, 20);
});

test('statistiques par période et progression par rapport à la période précédente', () => {
  const maintenant = new Date('2026-10-08T12:00:00Z');
  const c1 = creerCommande(db, { numero_commande: 'A', date_commande: '2026-10-05', total_declare: 100, lignes: [{ asin: 'B0AAAAAAA1', quantite: 4 }] });
  creerFacture(db, { commande_id: c1, total: 110 });
  creerCommande(db, { numero_commande: 'B', date_commande: '2026-09-28', total_declare: 50, lignes: [{ asin: 'B0AAAAAAA1', quantite: 2 }] });
  creerReception(db, c1, { date_reception: '2026-10-06' });
  creerEnvoi(db, { numero_envoi: 'FBA1', date_envoi: '2026-10-07', statut: 'expedie', lignes: [{ asin: 'B0AAAAAAA1', quantite: 3, commande_id: c1 }] });
  creerEnvoi(db, { numero_envoi: 'FBA2', date_envoi: '2026-10-07', statut: 'en_preparation', lignes: [{ asin: 'B0AAAAAAA1', quantite: 1 }] });

  const s7 = statistiques(db, '7j', maintenant).indicateurs;
  assert.deepEqual([s7.depenses.courant, s7.depenses.precedent, s7.depenses.pourcentage], [110, 50, 120]);
  assert.deepEqual([s7.unites_commandees.courant, s7.unites_commandees.precedent], [4, 2]);
  assert.deepEqual([s7.envois.courant, s7.unites_envoyees.courant], [1, 3], 'envoi en préparation exclu');
  assert.deepEqual([s7.stock.courant, s7.stock.precedent, s7.stock.ecart], [1, 0, 1], '4 reçues − 3 expédiées');

  const s30 = statistiques(db, '30j', maintenant).indicateurs;
  assert.deepEqual([s30.depenses.courant, s30.depenses.precedent, s30.depenses.pourcentage], [160, 0, null]);
});

test('fiche ASIN : chiffres clés et chronologie complète', () => {
  const c = creerCommande(db, { numero_commande: 'W-1', date_commande: '2026-09-01', total_declare: 30, lignes: [{ asin: 'B0AAAAAAA1', quantite: 3, cout_unitaire_ht: 9 }] });
  creerFacture(db, { commande_id: c, numero_facture: 'F-1', date_facture: '2026-09-02', sous_total_ht: 27, lignes: [{ asin: 'B0AAAAAAA1', quantite: 3, prix_unitaire_ht: 9 }] });
  creerReception(db, c, { date_reception: '2026-09-05' });
  creerEnvoi(db, { numero_envoi: 'FBA9', date_envoi: '2026-09-10', statut: 'expedie', lignes: [{ asin: 'B0AAAAAAA1', quantite: 2, commande_id: c }] });
  creerDossier(db, { asin: 'B0AAAAAAA1', numero_cas: '11122233344', date_demande: '2026-09-01' });
  ingererEmail(db, 'neo', { sujet: 'Brand approval', corps: 'Case ID: 11122233344', date: '2026-09-03T00:00:00Z' });

  const [ligne] = listerAsins(db);
  assert.equal(ligne.asin, 'B0AAAAAAA1');
  assert.deepEqual([ligne.unites_commandees, ligne.unites_recues, ligne.unites_envoyees, ligne.stock], [3, 3, 2, 1]);
  assert.equal(ligne.valeur_achats_estimee, 27);
  assert.equal(ligne.autorisation.numero_cas, '11122233344');

  const f = ficheAsin(db, 'B0AAAAAAA1');
  const types = new Set(f.evenements.map((e) => e.type));
  for (const t of ['commande', 'facture', 'reception', 'envoi', 'cout', 'autorisation', 'email_neo']) assert.ok(types.has(t), `événement ${t}`);
  assert.equal(f.factures[0].lignes_asin[0].prix_unitaire_ht, 9);
  assert.equal(f.cout_complet.par_unite.achat, 9);
  assert.equal(f.evenements[0].type, 'envoi', 'chronologie triée du plus récent au plus ancien');
  assert.throws(() => ficheAsin(db, 'B0ZZZZZZZZ'), /ASIN inconnu/);
});
