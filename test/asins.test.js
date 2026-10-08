import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ouvrirBase } from '../src/db.js';
import { ingererEmail, lierEmail, delierEmail, lireEmail, emailsPourAsin, emailsPourCas, migrerLiensEmails } from '../src/services/emails.js';
import { creerCommande, creerFacture, creerReception } from '../src/services/commandes.js';
import { creerEnvoi } from '../src/services/envois.js';
import { creerDossier } from '../src/services/autorisations.js';
import { statistiques, montantCommande } from '../src/services/statistiques.js';
import { creerFacture as creerFactureSeule } from '../src/services/commandes.js';
import { listerAsins, ficheAsin } from '../src/services/asins.js';
import { importerInventaire, etatStock } from '../src/services/inventaire.js';

const inv = (db, texte, nom) => importerInventaire(db, { texte, mapping: { asin: 0, quantite: 1 }, nom });

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

test('montant d’une commande : prix total du Google Sheets, sinon facture, sinon lignes — jamais additionnés', () => {
  assert.equal(montantCommande({ total_declare: 100 }, [{ total: 120 }], []).montant, 100);
  assert.equal(montantCommande({ total_declare: null }, [{ total: 120 }], []).montant, 120);
  assert.equal(montantCommande({ total_declare: null }, [], [{ quantite: 2, cout_unitaire_ht: 10 }]).montant, 20);
});

test('stock : photo de chaque import d’inventaire et écart avec l’import précédent', () => {
  const r1 = inv(db, 'asin,qty\nB0AAAAAAA1,10\nB0AAAAAAA2,4\nB0AAAAAAA2,1\n', 'inv-1');
  assert.deepEqual(r1.stock, { total: 15, precedent: null, ecart: null }, 'deux SKU du même ASIN additionnés');
  const r2 = inv(db, 'asin,qty\nB0AAAAAAA1,7\nB0AAAAAAA3,0\n', 'inv-2');
  assert.deepEqual(r2.stock, { total: 7, precedent: 15, ecart: -8 });
  const e = etatStock(db);
  assert.deepEqual(e.parAsin.get('B0AAAAAAA1'), { quantite: 7, precedente: 10, ecart: -3, absent: false });
  assert.deepEqual(e.parAsin.get('B0AAAAAAA2'), { quantite: 0, precedente: 5, ecart: -5, absent: true });
  assert.deepEqual(e.parAsin.get('B0AAAAAAA3'), { quantite: 0, precedente: 0, ecart: 0, absent: false });
  // Cellule vide ou illisible : 0
  inv(db, 'asin,qty\nB0AAAAAAA1,\nB0AAAAAAA2,n/a\nB0AAAAAAA3,6\n', 'inv-3');
  const e3 = etatStock(db);
  assert.deepEqual([e3.parAsin.get('B0AAAAAAA1').quantite, e3.parAsin.get('B0AAAAAAA2').quantite, e3.dernier.total], [0, 0, 6]);
  // ASIN jamais présent dans un fichier d'inventaire : 0
  creerCommande(db, { numero_commande: 'Z', lignes: [{ asin: 'B0AAAAAAA9', quantite: 1 }] });
  assert.equal(listerAsins(db).find((x) => x.asin === 'B0AAAAAAA9').stock.quantite, 0);
  // Un import sans colonne de quantité ne change pas le stock
  importerInventaire(db, { texte: 'asin,cost\nB0AAAAAAA1,5\n', mapping: { asin: 0, cost: 1 } });
  assert.equal(etatStock(db).dernier.total, 6);
});

test('statistiques par période et progression par rapport à la période précédente', () => {
  const maintenant = new Date('2026-10-08T12:00:00Z');
  const c1 = creerCommande(db, { numero_commande: 'A', date_commande: '2026-10-05', total_declare: 100, lignes: [{ asin: 'B0AAAAAAA1', quantite: 4 }] });
  creerFacture(db, { commande_id: c1, total: 110 });
  creerCommande(db, { numero_commande: 'B', date_commande: '2026-09-28', total_declare: 50, lignes: [{ asin: 'B0AAAAAAA1', quantite: 2 }] });
  creerReception(db, c1, { date_reception: '2026-10-06' });
  creerEnvoi(db, { numero_envoi: 'FBA1', date_envoi: '2026-10-07', statut: 'expedie', lignes: [{ asin: 'B0AAAAAAA1', quantite: 3, commande_id: c1 }] });
  assert.equal(statistiques(db, '7j', maintenant).indicateurs.stock, null, 'pas de stock sans import d’inventaire');
  inv(db, 'asin,qty\nB0AAAAAAA1,10\n', 'inv-1');
  inv(db, 'asin,qty\nB0AAAAAAA1,12\n', 'inv-2');
  creerEnvoi(db, { numero_envoi: 'FBA2', date_envoi: '2026-10-07', statut: 'en_preparation', lignes: [{ asin: 'B0AAAAAAA1', quantite: 1 }] });

  const s7 = statistiques(db, '7j', maintenant).indicateurs;
  assert.deepEqual([s7.depenses.courant, s7.depenses.precedent, s7.depenses.pourcentage], [100, 50, 100], 'prix total du Sheets, pas la facture');
  assert.deepEqual([s7.unites_commandees.courant, s7.unites_commandees.precedent], [4, 2]);
  assert.deepEqual([s7.envois.courant, s7.unites_envoyees.courant], [1, 3], 'envoi en préparation exclu');
  assert.deepEqual([s7.stock.courant, s7.stock.precedent, s7.stock.ecart], [12, 10, 2], 'dernier import vs import précédent');

  const s30 = statistiques(db, '30j', maintenant).indicateurs;
  assert.deepEqual([s30.depenses.courant, s30.depenses.precedent, s30.depenses.pourcentage], [150, 0, null]);
});

test('fiche ASIN : chiffres clés et chronologie complète', () => {
  const c = creerCommande(db, { numero_commande: 'W-1', date_commande: '2026-09-01', total_declare: 30, lignes: [{ asin: 'B0AAAAAAA1', quantite: 3, cout_unitaire_ht: 9 }] });
  creerFacture(db, { commande_id: c, numero_facture: 'F-1', date_facture: '2026-09-02', sous_total_ht: 27, lignes: [{ asin: 'B0AAAAAAA1', quantite: 3, prix_unitaire_ht: 9 }] });
  creerReception(db, c, { date_reception: '2026-09-05' });
  creerEnvoi(db, { numero_envoi: 'FBA9', date_envoi: '2026-09-10', statut: 'expedie', lignes: [{ asin: 'B0AAAAAAA1', quantite: 2, commande_id: c }] });
  creerDossier(db, { asin: 'B0AAAAAAA1', numero_cas: '11122233344', date_demande: '2026-09-01' });
  ingererEmail(db, 'neo', { sujet: 'Brand approval', corps: 'Case ID: 11122233344', date: '2026-09-03T00:00:00Z' });

  inv(db, 'asin,qty\nB0AAAAAAA1,5\n', 'inv-1');
  inv(db, 'asin,qty\nB0AAAAAAA1,3\n', 'inv-2');
  const [ligne] = listerAsins(db);
  assert.equal(ligne.asin, 'B0AAAAAAA1');
  assert.deepEqual([ligne.unites_commandees, ligne.unites_recues, ligne.unites_envoyees], [3, 3, 2]);
  assert.deepEqual([ligne.stock.quantite, ligne.stock.ecart], [3, -2], 'stock du dernier import et écart');
  assert.equal(ligne.valeur_achats_estimee, 27);
  assert.equal(ligne.autorisation.numero_cas, '11122233344');

  const f = ficheAsin(db, 'B0AAAAAAA1');
  const types = new Set(f.evenements.map((e) => e.type));
  for (const t of ['commande', 'facture', 'reception', 'envoi', 'cout', 'autorisation', 'email_neo', 'stock']) assert.ok(types.has(t), `événement ${t}`);
  assert.deepEqual(f.historique_stock.map((h) => [h.quantite, h.ecart]), [[3, -2], [5, null]]);
  assert.equal(f.factures[0].lignes_asin[0].prix_unitaire_ht, 9);
  assert.equal(f.cout_complet.par_unite.achat, 9);
  const dates = f.evenements.map((e) => e.date || '');
  assert.deepEqual(dates, [...dates].sort().reverse(), 'chronologie triée du plus récent au plus ancien');
  assert.throws(() => ficheAsin(db, 'B0ZZZZZZZZ'), /ASIN inconnu/);
});

test('dépenses : factures enregistrées seules comptées, sans double comptage avec une commande', () => {
  const maintenant = new Date('2026-10-08T12:00:00Z');
  creerCommande(db, { numero_commande: 'W-9', date_commande: '2026-10-05', total_declare: 100, lignes: [{ asin: 'B0AAAAAAA1', quantite: 4 }] });
  // facture seule : comptée (montant, commande, unités)
  creerFactureSeule(db, { numero_facture: 'F-1', date_facture: '2026-10-06', total: 40, lignes: [{ asin: 'B0AAAAAAA2', quantite: 5, prix_unitaire_ht: 8 }] });
  // facture du même achat que la commande W-9 (même n°, non rattachée) : non recomptée
  creerFactureSeule(db, { numero_facture: 'F-2', date_facture: '2026-10-06', total: 100, numero_commande_ref: 'W-9', rattacher_auto: false });
  // facture de la période précédente
  creerFactureSeule(db, { numero_facture: 'F-0', date_facture: '2026-09-28', sous_total_ht: 20, taxes: 3 });
  const i = statistiques(db, '7j', maintenant).indicateurs;
  assert.deepEqual([i.depenses.courant, i.depenses.dont_commandes, i.depenses.dont_factures, i.depenses.nb_factures], [140, 100, 40, 1]);
  assert.equal(i.depenses.precedent, 23);
  assert.deepEqual([i.commandes.courant, i.unites_commandees.courant], [2, 9]);
});
