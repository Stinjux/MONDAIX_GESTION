import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ouvrirBase } from '../src/db.js';
import { ingererEmail, lierEmail, delierEmail, lireEmail, emailsPourAsin, migrerLiensEmails, appliquerStatutNeo, listerEmails, migrerNeoVersAsin } from '../src/services/emails.js';
import { creerFacture, annulerFacture, retablirFacture } from '../src/services/factures.js';
import { toutRecu, enregistrerReception, lireEnvoi, listerEnvois } from '../src/services/envois.js';
import { tableauDeBord } from '../src/services/tableauDeBord.js';
import { creerEnvoi } from '../src/services/envois.js';
import { creerDossier } from '../src/services/autorisations.js';
import { statistiques } from '../src/services/statistiques.js';
import { creerFacture as creerFactureSeule } from '../src/services/factures.js';
import { listerAsins, ficheAsin } from '../src/services/asins.js';
import { importerInventaire, etatStock } from '../src/services/inventaire.js';

const inv = (db, texte, nom) => importerInventaire(db, { texte, mapping: { asin: 0, quantite: 1 }, nom });

let db;
beforeEach(() => {
  db = ouvrirBase(':memory:');
});

test('emails Gmail et Neo associés directement aux ASIN : automatique si un seul ASIN, manuel sinon', () => {
  const { id: n1 } = ingererEmail(db, 'neo', { sujet: 'Brand approval', corps: 'Case ID: 12345678901 for ASIN B0AAAAAAA1 has been approved.' });
  const e1 = lireEmail(db, n1);
  assert.deepEqual(e1.liens.map((l) => [l.type, l.valeur, l.mode]), [['asin', 'B0AAAAAAA1', 'auto']], 'aucun lien « numéro de cas »');
  assert.equal(e1.statut_rapprochement, 'valide', 'réponse Neo associée = traitée');
  assert.equal(e1.dossier_id, null, 'pas de rattachement à un dossier');

  const { id: g1 } = ingererEmail(db, 'gmail', { sujet: 'Your order', corps: 'Items B0AAAAAAA2 and B0AAAAAAA3' });
  assert.equal(lireEmail(db, g1).liens.length, 0);
  lierEmail(db, g1, { type: 'asin', valeur: 'b0aaaaaaa2' });
  assert.throws(() => lierEmail(db, g1, { type: 'cas', valeur: '98765432100' }), /directement à un ASIN/);
  assert.throws(() => lierEmail(db, g1, { type: 'asin', valeur: 'pas-un-asin' }), /ASIN invalide/);
  const e2 = lireEmail(db, g1);
  assert.deepEqual(e2.liens.map((l) => `${l.type}:${l.valeur}:${l.mode}`), ['asin:B0AAAAAAA2:manuel']);
  assert.deepEqual(emailsPourAsin(db, 'B0AAAAAAA2').map((e) => e.id), [g1]);
  delierEmail(db, e2.liens[0].id);
  assert.equal(emailsPourAsin(db, 'B0AAAAAAA2').length, 0);

  // Neo sans ASIN détecté : à traiter jusqu'à l'association
  const { id: n2 } = ingererEmail(db, 'neo', { sujet: 'Brand approval', corps: 'Your request has been approved.' });
  assert.equal(listerEmails(db, { source: 'neo', statut: 'a_traiter' }).map((e) => e.id).join(), String(n2));
  lierEmail(db, n2, { valeur: 'B0AAAAAAA3' });
  assert.equal(listerEmails(db, { source: 'neo', statut: 'a_traiter' }).length, 0);
});

test('statut d’autorisation appliqué depuis la réponse Neo aux ASIN associés', () => {
  creerDossier(db, { asin: 'B0AAAAAAA1', numero_cas: '11122233344' });
  const { id } = ingererEmail(db, 'neo', { sujet: 'x', corps: 'ASIN B0AAAAAAA1 approved to sell' });
  lierEmail(db, id, { valeur: 'B0AAAAAAA2' });
  appliquerStatutNeo(db, id, 'approuve');
  const dossiers = db.prepare('SELECT asin, statut, statut_confirme FROM dossiers_autorisation ORDER BY asin').all();
  assert.deepEqual(dossiers.map((d) => [d.asin, d.statut, d.statut_confirme]), [['B0AAAAAAA1', 'approuve', 1], ['B0AAAAAAA2', 'approuve', 1]], 'dossier existant mis à jour, dossier créé au besoin');
  const { id: sans } = ingererEmail(db, 'neo', { sujet: 'y', corps: 'approved' });
  assert.throws(() => appliquerStatutNeo(db, sans, 'approuve'), /Associez d’abord/);
});

test('rattrapage : réponse Neo rattachée à un dossier → associée à l’ASIN du dossier', () => {
  const did = creerDossier(db, { asin: 'B0AAAAAAA5' });
  const { id } = ingererEmail(db, 'neo', { sujet: 'x', corps: 'sans référence' });
  db.prepare("UPDATE emails SET dossier_id = ?, statut_rapprochement = 'valide', mode_rapprochement = 'manuel' WHERE id = ?").run(did, id);
  migrerNeoVersAsin(db);
  assert.deepEqual(lireEmail(db, id).liens.map((l) => l.valeur), ['B0AAAAAAA5']);
  assert.equal(lireEmail(db, id).statut_rapprochement, 'valide');
});

test('rattrapage des liens pour les emails existants, exécuté une seule fois', () => {
  const { id } = ingererEmail(db, 'neo', { sujet: 'x', corps: 'ASIN B0AAAAAAA1' });
  db.prepare('DELETE FROM email_liens').run();
  assert.equal(migrerLiensEmails(db), 1);
  assert.equal(lireEmail(db, id).liens.length, 1);
  db.prepare('DELETE FROM email_liens').run();
  assert.equal(migrerLiensEmails(db), 0, 'déjà fait : un lien retiré par l’utilisateur n’est pas recréé');
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
  creerFacture(db, { numero_facture: 'Z', total: 5, lignes: [{ asin: 'B0AAAAAAA9', quantite: 1 }] });
  assert.equal(listerAsins(db).find((x) => x.asin === 'B0AAAAAAA9').stock.quantite, 0);
  // Un import sans colonne de quantité ne change pas le stock
  importerInventaire(db, { texte: 'asin,cost\nB0AAAAAAA1,5\n', mapping: { asin: 0, cost: 1 } });
  assert.equal(etatStock(db).dernier.total, 6);
});

test('statistiques par période : dépenses = factures, progression vs période précédente', () => {
  const maintenant = new Date('2026-10-08T12:00:00Z');
  creerFacture(db, { numero_facture: 'F-A', date_facture: '2026-10-05', total: 110, lignes: [{ asin: 'B0AAAAAAA1', quantite: 4, prix_unitaire_ht: 25 }] });
  creerFacture(db, { numero_facture: 'F-B', date_facture: '2026-09-28', total: 50, lignes: [{ asin: 'B0AAAAAAA1', quantite: 2, prix_unitaire_ht: 25 }] });
  creerEnvoi(db, { numero_envoi: 'FBA1', date_envoi: '2026-10-07', statut: 'expedie', lignes: [{ asin: 'B0AAAAAAA1', quantite: 3 }] });
  assert.equal(statistiques(db, '7j', maintenant).indicateurs.stock, null, 'pas de stock sans import d’inventaire');
  inv(db, 'asin,qty\nB0AAAAAAA1,10\n', 'inv-1');
  inv(db, 'asin,qty\nB0AAAAAAA1,12\n', 'inv-2');
  creerEnvoi(db, { numero_envoi: 'FBA2', date_envoi: '2026-10-07', statut: 'en_preparation', lignes: [{ asin: 'B0AAAAAAA1', quantite: 1 }] });

  const s7 = statistiques(db, '7j', maintenant).indicateurs;
  assert.deepEqual([s7.depenses.courant, s7.depenses.precedent, s7.depenses.pourcentage], [110, 50, 120]);
  assert.deepEqual([s7.factures.courant, s7.unites_achetees.courant, s7.unites_achetees.precedent], [1, 4, 2]);
  assert.deepEqual([s7.envois.courant, s7.unites_envoyees.courant], [1, 3], 'envoi en préparation exclu');
  assert.deepEqual([s7.stock.courant, s7.stock.precedent, s7.stock.ecart], [12, 10, 2], 'dernier import vs import précédent');
  const s30 = statistiques(db, '30j', maintenant).indicateurs;
  assert.deepEqual([s30.depenses.courant, s30.depenses.precedent, s30.depenses.pourcentage], [160, 0, null]);
});

test('fiche ASIN : chiffres clés et chronologie complète (facture, envoi, réception Amazon, stock)', () => {
  creerFacture(db, { numero_facture: 'F-1', date_facture: '2026-09-02', sous_total_ht: 27, lignes: [{ asin: 'B0AAAAAAA1', quantite: 3, prix_unitaire_ht: 9 }] });
  const e = creerEnvoi(db, { numero_envoi: 'FBA9', date_envoi: '2026-09-10', statut: 'expedie', lignes: [{ asin: 'B0AAAAAAA1', quantite: 2 }] });
  toutRecu(db, e, { date_reception: '2026-09-15' });
  creerDossier(db, { asin: 'B0AAAAAAA1', numero_cas: '11122233344', date_demande: '2026-09-01' });
  ingererEmail(db, 'neo', { sujet: 'Brand approval', corps: 'Case ID: 11122233344 - ASIN B0AAAAAAA1', date: '2026-09-03T00:00:00Z' });

  inv(db, 'asin,qty\nB0AAAAAAA1,5\n', 'inv-1');
  inv(db, 'asin,qty\nB0AAAAAAA1,3\n', 'inv-2');
  const [ligne] = listerAsins(db);
  assert.equal(ligne.asin, 'B0AAAAAAA1');
  assert.deepEqual([ligne.unites_achetees, ligne.unites_envoyees, ligne.unites_recues_amazon, ligne.unites_en_transit], [3, 2, 2, 0]);
  assert.deepEqual([ligne.stock.quantite, ligne.stock.ecart], [3, -2], 'stock du dernier import et écart');
  assert.equal(ligne.derniere_facture, '2026-09-02');

  const f = ficheAsin(db, 'B0AAAAAAA1');
  const types = new Set(f.evenements.map((x) => x.type));
  for (const t of ['facture', 'envoi', 'reception', 'cout', 'autorisation', 'email_neo', 'stock']) assert.ok(types.has(t), `événement ${t}`);
  assert.equal(f.commandes, undefined, 'plus de commandes');
  assert.deepEqual(f.historique_stock.map((h) => [h.quantite, h.ecart]), [[3, -2], [5, null]]);
  assert.equal(f.factures[0].lignes_asin[0].prix_unitaire_ht, 9);
  assert.equal(f.cout_complet.par_unite.achat, 9);
  const dates = f.evenements.map((x) => x.date || '');
  assert.deepEqual(dates, [...dates].sort().reverse(), 'chronologie triée du plus récent au plus ancien');
  assert.throws(() => ficheAsin(db, 'B0ZZZZZZZZ'), /ASIN inconnu/);
});

test('facture annulée (remboursée) : gardée dans l’historique, exclue des dépenses, unités et coût complet', () => {
  const maintenant = new Date('2026-10-08T12:00:00Z');
  creerFacture(db, { numero_facture: 'F-1', date_facture: '2026-10-06', total: 40, lignes: [{ asin: 'B0AAAAAAA2', quantite: 5, prix_unitaire_ht: 8 }] });
  const f2 = creerFacture(db, { numero_facture: 'F-2', date_facture: '2026-10-06', sous_total_ht: 100, livraison: 20, total: 120, lignes: [{ asin: 'B0AAAAAAA2', quantite: 10, prix_unitaire_ht: 10 }] });
  creerFacture(db, { numero_facture: 'F-0', date_facture: '2026-09-28', sous_total_ht: 20, taxes: 3 });
  assert.equal(statistiques(db, '7j', maintenant).indicateurs.depenses.courant, 160);

  annulerFacture(db, f2.id, { date_annulation: '2026-10-07', motif: 'rupture, remboursé' });
  assert.throws(() => annulerFacture(db, f2.id), /déjà annulée/);
  const i = statistiques(db, '7j', maintenant).indicateurs;
  assert.deepEqual([i.depenses.courant, i.depenses.factures_annulees, i.depenses.montant_annule, i.factures.courant, i.unites_achetees.courant], [40, 1, 120, 1, 5]);
  assert.equal(i.depenses.precedent, 23);
  const fiche = ficheAsin(db, 'B0AAAAAAA2');
  assert.equal(fiche.factures.length, 2, 'la facture annulée reste visible');
  assert.equal(fiche.factures.find((f) => f.id === f2.id).part_asin.montant, 0);
  assert.equal(fiche.depenses_factures.montant, 40);
  assert.equal(fiche.unites_achetees, 5);
  assert.ok(fiche.evenements.some((e) => e.type === 'annulation' && e.date === '2026-10-07'));
  assert.equal(fiche.cout_complet.par_unite.frais_facture, 0, 'livraison de la facture annulée non comptée');

  retablirFacture(db, f2.id);
  assert.equal(statistiques(db, '7j', maintenant).indicateurs.depenses.courant, 160);
  assert.equal(ficheAsin(db, 'B0AAAAAAA2').cout_complet.par_unite.frais_facture, 1.33, '20 $ de livraison / 15 unités');
});

test('envois : suivi expédié → reçu par Amazon, écarts signalés au tableau de bord', () => {
  const e1 = creerEnvoi(db, { numero_envoi: 'FBA1', date_envoi: '2026-10-01', statut: 'expedie', lignes: [{ asin: 'B0AAAAAAA1', quantite: 10 }, { asin: 'B0AAAAAAA2', quantite: 4 }] });
  const e2 = creerEnvoi(db, { numero_envoi: 'FBA2', date_envoi: '2026-10-02', statut: 'expedie', lignes: [{ asin: 'B0AAAAAAA1', quantite: 6 }] });
  creerEnvoi(db, { numero_envoi: 'FBA3', lignes: [{ asin: 'B0AAAAAAA1', quantite: 1 }] });
  let t = tableauDeBord(db);
  assert.deepEqual([t.compteurs.envois_a_verifier, t.compteurs.unites_en_transit, t.compteurs.envois_en_ecart], [2, 20, 0]);

  const [l1, l2] = lireEnvoi(db, e1).lignes;
  let suivi = enregistrerReception(db, e1, { lignes: [{ id: l1.id, quantite_recue: 10 }] });
  assert.equal(suivi.etat, 'partiel');
  assert.equal(lireEnvoi(db, e1).statut, 'expedie');
  suivi = enregistrerReception(db, e1, { lignes: [{ id: l2.id, quantite_recue: 3 }], date_reception: '2026-10-06' });
  assert.deepEqual([suivi.etat, suivi.ecart, suivi.unites_recues], ['ecart', -1, 13]);
  const e = lireEnvoi(db, e1);
  assert.deepEqual([e.statut, e.date_reception], ['recu_amazon', '2026-10-06']);
  assert.throws(() => enregistrerReception(db, e1, { lignes: [{ id: l1.id, quantite_recue: -1 }] }), /invalide/);

  toutRecu(db, e2, { date_reception: '2026-10-07' });
  assert.equal(lireEnvoi(db, e2).suivi.etat, 'recu');
  t = tableauDeBord(db);
  assert.deepEqual([t.compteurs.envois_a_verifier, t.compteurs.unites_en_transit, t.compteurs.envois_en_ecart], [0, 0, 1]);
  assert.equal(listerEnvois(db).find((x) => x.id === e1).suivi.etat, 'ecart');
  assert.equal(listerAsins(db).find((p) => p.asin === 'B0AAAAAAA1').unites_recues_amazon, 16);
});

test('dépense par ASIN : part de chaque facture au prorata du HT, frais compris, sans double comptage', async () => {
  const { depensesFacturesParAsin, modifierLignesFacture, ajouterLigneFacture, retirerLigneFacture } = await import('../src/services/factures.js');
  // Facture à deux ASIN : 100 $ HT (A) + 300 $ HT (B), total 460 $ (taxes et livraison comprises)
  creerFactureSeule(db, {
    numero_facture: 'F-1', date_facture: '2026-09-01', sous_total_ht: 400, taxes: 50, livraison: 10, total: 460,
    lignes: [{ asin: 'B0AAAAAAA1', quantite: 10, prix_unitaire_ht: 10 }, { asin: 'B0AAAAAAA2', quantite: 20, prix_unitaire_ht: 15 }],
  });
  // Facture sans article associé : ne compte pour aucun ASIN tant qu'elle n'est pas associée
  const f2 = creerFactureSeule(db, { numero_facture: 'F-2', date_facture: '2026-09-05', total: 115 });
  let d = depensesFacturesParAsin(db);
  assert.deepEqual(d.get('B0AAAAAAA1'), { montant: 115, ht: 100, frais: 15, unites: 10, nb_factures: 1, estimee: false, cout_moyen_unite: 11.5 });
  assert.equal(d.get('B0AAAAAAA2').montant, 345);
  assert.equal(d.get('B0AAAAAAA1').montant + d.get('B0AAAAAAA2').montant, 460, 'la facture est répartie, jamais comptée deux fois');

  // Association après coup depuis la fiche ASIN
  ajouterLigneFacture(db, f2.id, { asin: 'B0AAAAAAA1', quantite: 5, prix_unitaire_ht: 20 });
  d = depensesFacturesParAsin(db);
  assert.equal(d.get('B0AAAAAAA1').montant, 230);
  assert.equal(d.get('B0AAAAAAA1').nb_factures, 2);
  const fiche = ficheAsin(db, 'B0AAAAAAA1');
  assert.equal(fiche.depenses_factures.montant, 230);
  assert.deepEqual(fiche.factures.map((f) => f.part_asin.montant).sort(), [115, 115]);
  assert.equal(listerAsins(db).find((p) => p.asin === 'B0AAAAAAA1').depenses_factures.montant, 230);
  assert.equal(listerAsins(db).find((p) => p.asin === 'B0AAAAAAA2').depenses_factures.nb_factures, 1);

  // Article sans prix : part estimée selon les quantités
  modifierLignesFacture(db, f2.id, [{ asin: 'B0AAAAAAA1', quantite: 1 }, { asin: 'B0AAAAAAA3', quantite: 4 }]);
  d = depensesFacturesParAsin(db);
  assert.equal(d.get('B0AAAAAAA3').montant, 92);
  assert.equal(d.get('B0AAAAAAA3').estimee, true);

  // Sous-total plus grand que les articles associés : un article non associé ne gonfle pas la part
  creerFactureSeule(db, { numero_facture: 'F-3', sous_total_ht: 200, total: 230, lignes: [{ asin: 'B0AAAAAAA4', quantite: 2, prix_unitaire_ht: 50 }] });
  assert.equal(depensesFacturesParAsin(db).get('B0AAAAAAA4').montant, 115);

  // Retirer l'article : la facture reste, l'historique des coûts aussi
  const ligne = db.prepare("SELECT id FROM facture_lignes WHERE asin = 'B0AAAAAAA4'").get();
  retirerLigneFacture(db, ligne.id);
  assert.equal(depensesFacturesParAsin(db).has('B0AAAAAAA4'), false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM factures WHERE numero_facture = 'F-3'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM couts_achat WHERE asin = 'B0AAAAAAA4'").get().n, 1);
});

test('envoi : n° et date d’expédition saisis à la main, ASIN ajoutés puis quantité modifiée', async () => {
  const { modifierEnvoi, ajouterLigneEnvoi, modifierLigneEnvoi, lireEnvoi } = await import('../src/services/envois.js');
  const id = creerEnvoi(db, {});
  ajouterLigneEnvoi(db, id, { asin: 'B0AAAAAAA1', quantite: 3 });
  modifierEnvoi(db, id, { numero_envoi: 'FBA15ABC', date_envoi: '2026-10-01', statut: 'expedie' });
  const ligne = lireEnvoi(db, id).lignes[0];
  modifierLigneEnvoi(db, ligne.id, { quantite: '7' });
  assert.throws(() => modifierLigneEnvoi(db, ligne.id, { quantite: '0' }), /Quantité invalide/);
  const e = lireEnvoi(db, id);
  assert.equal(e.numero_envoi, 'FBA15ABC');
  assert.equal(e.date_envoi, '2026-10-01');
  assert.equal(e.lignes[0].quantite, 7);
  assert.equal(statistiques(db, '30j', new Date('2026-10-08T12:00:00Z')).indicateurs.unites_envoyees.courant, 7);
});

test('COGS : ventes estimées par la baisse du stock entre deux imports × coût d’achat HT retenu', async () => {
  const { modifierEnvoi } = await import('../src/services/envois.js');
  const { ajouterCout } = await import('../src/services/couts.js');
  ajouterCout(db, { asin: 'B0AAAAAAA1', montant: 4, source: 'manuel' });
  inv(db, 'asin,qte\nB0AAAAAAA1,10\nB0AAAAAAA2,5', 'inv1');
  db.prepare("UPDATE imports SET created_at = '2026-10-01 09:00:00' WHERE nom = 'inv1'").run();
  // 6 unités envoyées à Amazon entre les deux imports
  const e = creerEnvoi(db, { lignes: [{ asin: 'B0AAAAAAA1', quantite: 6 }] });
  modifierEnvoi(db, e, { date_envoi: '2026-10-03', statut: 'expedie' });
  inv(db, 'asin,qte\nB0AAAAAAA1,12\nB0AAAAAAA2,7', 'inv2');
  db.prepare("UPDATE imports SET created_at = '2026-10-05 09:00:00' WHERE nom = 'inv2'").run();
  const c = statistiques(db, '30j', new Date('2026-10-08T12:00:00Z')).indicateurs.cogs;
  // A : 10 + 6 − 12 = 4 vendues × 4 $ ; B : stock en hausse sans envoi → aucune vente
  assert.equal(c.unites_vendues.courant, 4);
  assert.equal(c.courant, 16);
  assert.equal(c.unites_sans_cout, 0);
  assert.deepEqual(c.par_asin, [{ asin: 'B0AAAAAAA1', unites: 4, cout_unitaire: 4, montant: 16 }]);
});

test('import d’inventaire supprimé par erreur : stock, coûts et coût retenu reviennent à l’état précédent', async () => {
  const { listerImportsInventaire, supprimerImportInventaire } = await import('../src/services/inventaire.js');
  const { coutRetenu, historiqueCouts } = await import('../src/services/couts.js');
  const im = (t, nom) => importerInventaire(db, { texte: t, mapping: { asin: 0, quantite: 1, cost: 2 }, nom });
  const r1 = im('asin,qty,cost\nB0AAAAAAA1,14,10\n', 'initial.csv');
  const r2 = im('asin,qty,cost\nB0AAAAAAA1,40,99\nB0AAAAAAA2,5,3\n', 'erreur.csv');
  let imports = listerImportsInventaire(db);
  assert.deepEqual(imports.map((i) => [i.nom, i.stock_initial, i.dernier, i.unites]), [['erreur.csv', false, true, 45], ['initial.csv', true, false, 14]]);
  assert.equal(coutRetenu(db, 'B0AAAAAAA1').montant_unitaire_ht, 10, 'l’import fautif n’a pas écrasé le coût retenu');
  assert.equal(coutRetenu(db, 'B0AAAAAAA2').montant_unitaire_ht, 3);

  assert.deepEqual(supprimerImportInventaire(db, r2.import_id), { asin: 2, couts: 2 });
  assert.equal(etatStock(db).dernier.import_id, r1.import_id, 'le stock redevient celui de l’import précédent');
  assert.equal(etatStock(db).parAsin.get('B0AAAAAAA1').quantite, 14);
  assert.equal(historiqueCouts(db, 'B0AAAAAAA1').length, 1);
  assert.equal(coutRetenu(db, 'B0AAAAAAA2'), null, 'coût retenu retiré avec l’import, aucun autre coût');
  imports = listerImportsInventaire(db);
  assert.deepEqual(imports.map((i) => [i.nom, i.stock_initial, i.dernier]), [['initial.csv', true, true]]);
  assert.throws(() => supprimerImportInventaire(db, r2.import_id), /introuvable/);
  // Stock initial supprimé : l'import suivant devient le stock initial
  const r3 = im('asin,qty,cost\nB0AAAAAAA1,12,\n', 'oct.csv');
  supprimerImportInventaire(db, r1.import_id);
  assert.deepEqual(listerImportsInventaire(db).map((i) => [i.id, i.stock_initial]), [[r3.import_id, true]]);
});

test('import : une ligne répétée pour le même SKU ne double pas le stock ; SKU différents additionnés et signalés', () => {
  const r = importerInventaire(db, {
    texte: 'sku,asin,qty\nSKU-A,B0AAAAAAA1,14\nSKU-A,B0AAAAAAA1,14\nSKU-B,B0AAAAAAA2,3\nSKU-C,B0AAAAAAA2,2\n',
    mapping: { sku: 0, asin: 1, quantite: 2 },
    nom: 'inv',
  });
  assert.equal(etatStock(db).parAsin.get('B0AAAAAAA1').quantite, 14, 'même SKU répété : 14, pas 28');
  assert.equal(etatStock(db).parAsin.get('B0AAAAAAA2').quantite, 5);
  assert.equal(r.doublons.length, 1);
  assert.deepEqual(r.asin_plusieurs_lignes, [{ asin: 'B0AAAAAAA1', lignes: 2 }, { asin: 'B0AAAAAAA2', lignes: 2 }]);
});

/** Import d'inventaire daté (chaque import est une photo complète du stock Amazon). */
function invDate(texte, nom, d) {
  const r = importerInventaire(db, { texte, mapping: { asin: 0, quantite: 1 }, nom });
  db.prepare('UPDATE imports SET created_at = ? WHERE id = ?').run(`${d} 10:00:00`, r.import_id);
  return r;
}

test('stock : seule la variation entre deux imports compte (10→10 = 10, 10→8 = −2 ventes, hausse = restock)', () => {
  creerFacture(db, { numero_facture: 'F-1', total: 200, lignes: [{ asin: 'B0AAAAAAA1', quantite: 20, prix_unitaire_ht: 10 }] });
  const t = () => listerAsins(db).find((x) => x.asin === 'B0AAAAAAA1').stock_total;
  const resume = () => [t().amazon, t().en_transit, t().a_envoyer, t().total];
  assert.deepEqual(resume(), [0, 0, 20, 20], 'avant tout import : tout est chez vous');

  invDate('asin,qty\nB0AAAAAAA1,10\n', 'initial', '2026-09-01');
  assert.deepEqual(resume(), [10, 0, 10, 20], 'stock initial : 10 chez Amazon, 10 encore chez vous');
  assert.equal(t().stock_initial, 10);

  invDate('asin,qty\nB0AAAAAAA1,10\n', 'meme', '2026-09-05');
  assert.deepEqual(resume(), [10, 0, 10, 20], '10 → 10 : 10, pas 20');

  invDate('asin,qty\nB0AAAAAAA1,8\n', 'ventes', '2026-09-10');
  assert.deepEqual(resume(), [8, 0, 10, 18], '10 → 8 : 2 ventes');
  assert.equal(t().vendues, 2);
  assert.equal(ficheAsin(db, 'B0AAAAAAA1').historique_stock[0].ecart, -2);

  invDate('asin,qty\nB0AAAAAAA1,13\n', 'restock', '2026-09-15');
  assert.deepEqual(resume(), [13, 0, 5, 18], '8 → 13 sans envoi saisi : restock de 5, pris sur les unités chez vous');
  assert.equal(ficheAsin(db, 'B0AAAAAAA1').historique_stock[0].restock_non_saisi, 5);

  creerEnvoi(db, { numero_envoi: 'FBA1', date_envoi: '2026-09-20', statut: 'expedie', lignes: [{ asin: 'B0AAAAAAA1', quantite: 3 }] });
  assert.deepEqual(resume(), [13, 3, 2, 18], 'envoi saisi après le dernier import : en transit');

  invDate('asin,qty\nB0AAAAAAA1,16\n', 'arrivee', '2026-09-25');
  assert.deepEqual(resume(), [16, 0, 2, 18], '13 → 16 : l’envoi de 3 est arrivé, pas de doublon');
  const h = ficheAsin(db, 'B0AAAAAAA1').historique_stock[0];
  assert.deepEqual([h.ecart, h.envois, h.vendues, h.restock_non_saisi], [3, 3, 0, 0]);
  assert.deepEqual(ficheAsin(db, 'B0AAAAAAA1').stock_total, t());
  assert.deepEqual(statistiques(db, '365j', new Date('2026-10-08T12:00:00Z')).indicateurs.stock_total, { total: 18, amazon: 16, en_transit: 0, a_envoyer: 2 });
});

test('stock : envoi saisi avant le stock initial déjà compris dedans ; Amazon au-delà des achats signalé', () => {
  creerFacture(db, { numero_facture: 'F', total: 140, lignes: [{ asin: 'B0AAAAAAA1', quantite: 14, prix_unitaire_ht: 10 }] });
  creerEnvoi(db, { numero_envoi: 'FBA1', date_envoi: '2026-09-01', statut: 'expedie', lignes: [{ asin: 'B0AAAAAAA1', quantite: 14 }] });
  invDate('asin,qty\nB0AAAAAAA1,14\n', 'initial', '2026-09-03');
  const a = listerAsins(db).find((x) => x.asin === 'B0AAAAAAA1').stock_total;
  assert.deepEqual([a.amazon, a.en_transit, a.a_envoyer, a.total, a.incoherent], [14, 0, 0, 14, false], '14, pas 28');
  creerFacture(db, { numero_facture: 'F2', total: 140, lignes: [{ asin: 'B0AAAAAAA2', quantite: 14, prix_unitaire_ht: 10 }] });
  invDate('asin,qty\nB0AAAAAAA1,14\nB0AAAAAAA2,28\n', 'trop', '2026-09-04');
  const b = listerAsins(db).find((x) => x.asin === 'B0AAAAAAA2').stock_total;
  assert.deepEqual([b.amazon, b.a_envoyer, b.total, b.incoherent], [28, 0, 28, true]);
});

test('remise à zéro de l’inventaire : imports supprimés, factures et envois conservés, une seule fois au démarrage', async () => {
  const { reinitialiserInventaire, migrerReinitialisationInventaire, listerImportsInventaire } = await import('../src/services/inventaire.js');
  const { coutRetenu } = await import('../src/services/couts.js');
  creerFacture(db, { numero_facture: 'F-1', total: 200, lignes: [{ asin: 'B0AAAAAAA1', quantite: 20, prix_unitaire_ht: 10 }] });
  creerEnvoi(db, { numero_envoi: 'FBA1', date_envoi: '2026-09-02', statut: 'expedie', lignes: [{ asin: 'B0AAAAAAA1', quantite: 5 }] });
  importerInventaire(db, { texte: 'asin,qty,cost\nB0AAAAAAA1,40,99\nB0AAAAAAA9,3,7\n', mapping: { asin: 0, quantite: 1, cost: 2 }, nom: 'faux' });
  importerInventaire(db, { texte: 'asin,qty\nB0AAAAAAA1,40\n', mapping: { asin: 0, quantite: 1 }, nom: 'faux-2' });
  assert.deepEqual(migrerReinitialisationInventaire(db), { imports_supprimes: 2 });
  assert.equal(migrerReinitialisationInventaire(db), null, 'une seule fois');
  assert.equal(listerImportsInventaire(db).length, 0);
  assert.equal(etatStock(db).dernier, null);
  assert.equal(coutRetenu(db, 'B0AAAAAAA1').montant_unitaire_ht, 10, 'coût de la facture conservé et retenu');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM factures').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM envois').get().n, 1);
  const t = listerAsins(db).find((x) => x.asin === 'B0AAAAAAA1').stock_total;
  assert.deepEqual([t.amazon, t.en_transit, t.a_envoyer, t.total], [0, 5, 15, 20], 'repart des factures : 20 achetées');
  assert.ok(db.prepare("SELECT COUNT(*) n FROM journal WHERE action = 'reinitialisation'").get().n >= 3, 'contenu supprimé gardé au journal');
  assert.deepEqual(reinitialiserInventaire(db), { imports_supprimes: 0 });
});
