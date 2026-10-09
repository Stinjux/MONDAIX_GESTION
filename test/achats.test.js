import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ouvrirBase } from '../src/db.js';
import { importerAchats, statutAchat, marquerRecue } from '../src/services/achats.js';
import { detecterType, resumeImports } from '../src/services/imports.js';
import { listerAsins } from '../src/services/asins.js';
import { importerInventaire } from '../src/services/inventaire.js';
import { importerVentes } from '../src/services/ventes.js';

let db;
beforeEach(() => {
  db = ouvrirBase(':memory:');
});

// Données fictives, même disposition qu'un Google Sheet sans en-tête : A ASIN, B site, C quantité,
// D total TTC, E date (jj/mm/aaaa) ; colonnes de totaux et de légende à droite.
const SHEET = [
  'B0TEST0001,Exemple.ca,4,"45,99",03/10/2026,,,TOTAL $,TOTAL QT,,legende,',
  'B0TEST0002,https://www.boutique.ca/p/1,2,"22,99",04/10/2026,,,68.98,6,,recu,',
  'B0TEST0003,boutique.ca,0,"19,00",04/10/2026,,,,,,en attente,',
  'B0TEST0004,magasin,3,0,0,,,,,,rembourse,',
].join('\n');
const taxe = (ttc) => Math.round((ttc / 1.14975) * 100) / 100;

test('statuts reconnus', () => {
  assert.equal(statutAchat('Reçu'), 'recu');
  assert.equal(statutAchat('en attente'), 'en_attente');
  assert.equal(statutAchat('Remboursé / annulé'), 'annule');
  assert.equal(statutAchat(''), null);
});

test('Google Sheet sans en-tête : une facture par ligne, HT déduit du TTC, lignes incomplètes signalées', () => {
  const r = importerAchats(db, { texte: SHEET, nom: 'achats.csv' });
  assert.equal(r.creees, 3, 'la ligne à 0 unité est ignorée');
  assert.deepEqual(r.rejets.map((x) => x.asin), ['B0TEST0003']);
  assert.deepEqual(r.a_verifier.map((x) => [x.asin, x.motif]), [['B0TEST0004', 'total à 0 $'], ['B0TEST0004', 'date manquante ou illisible']]);
  const f = db.prepare("SELECT f.*, fo.nom AS fournisseur FROM factures f LEFT JOIN fournisseurs fo ON fo.id = f.fournisseur_id WHERE numero_facture LIKE 'Sheet B0TEST0001%'").get();
  assert.deepEqual([f.date_facture, f.total, f.sous_total_ht, f.fournisseur], ['2026-10-03', 45.99, taxe(45.99), 'Exemple']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fournisseurs').get().n, 3, 'boutique.ca : un seul fournisseur pour le lien et le nom');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM couts_achat').get().n, 0, 'aucun coût unitaire déduit du Sheet');
});

test('réimport du Sheet : aucune facture en double, mises à jour et statut appliqués', () => {
  importerAchats(db, { texte: SHEET, nom: 'achats.csv' });
  assert.throws(() => importerAchats(db, { texte: SHEET, nom: 'copie.csv' }), /identique au dernier import/);
  const v2 = SHEET.replace('B0TEST0002,https://www.boutique.ca/p/1,2,"22,99"', 'B0TEST0002,https://www.boutique.ca/p/1,3,"34,49"')
    .replace('B0TEST0001,Exemple.ca,4,"45,99",03/10/2026', 'B0TEST0001,Exemple.ca,4,"45,99",02/10/2026')
    + '\nB0TEST0005,exemple.ca,1,"9,99",05/10/2026';
  const r = importerAchats(db, { texte: v2, nom: 'achats-2.csv' });
  assert.deepEqual([r.creees, r.mises_a_jour, r.inchangees], [1, 2, 1], 'date corrigée et quantité modifiée : mises à jour, pas de doublon');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM factures WHERE cle_import LIKE 'sheet|%'").get().n, 4);
  assert.equal(db.prepare("SELECT date_facture d FROM factures WHERE numero_facture LIKE 'Sheet B0TEST0001%'").get().d, '2026-10-02');
  assert.equal(listerAsins(db).find((p) => p.asin === 'B0TEST0002').unites_achetees, 3);
});

test('colonne Statut : en attente hors stock « à envoyer », annulée gardée mais non comptée', () => {
  const texte = ['ASIN,Site,Quantité,Total,Date,Statut', 'B0TEST0001,exemple.ca,5,"57,49",2026-10-01,reçu', 'B0TEST0001,exemple.ca,3,"34,49",2026-10-05,en attente', 'B0TEST0002,exemple.ca,2,"20,00",2026-10-05,remboursé'].join('\n');
  const r = importerAchats(db, { texte, nom: 'sheet.csv' });
  assert.deepEqual([r.creees, r.en_attente, r.annulees], [3, 1, 1]);
  let t = listerAsins(db).find((p) => p.asin === 'B0TEST0001').stock_total;
  assert.deepEqual([t.achetees, t.en_attente_fournisseur, t.a_envoyer, t.total], [8, 3, 5, 5]);
  assert.equal(listerAsins(db).find((p) => p.asin === 'B0TEST0002').unites_achetees, 0, 'facture annulée exclue');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM factures WHERE annulee = 1').get().n, 1, 'gardée dans l’historique');

  // Reçue : passe dans « à envoyer »
  const id = db.prepare('SELECT id FROM factures WHERE en_attente = 1').get().id;
  marquerRecue(db, id);
  t = listerAsins(db).find((p) => p.asin === 'B0TEST0001').stock_total;
  assert.deepEqual([t.en_attente_fournisseur, t.a_envoyer], [0, 8]);
  // Le Sheet passe la ligne à « reçu » et la facture remboursée redevient valide
  importerAchats(db, { texte: texte.replace('en attente', 'reçu').replace('remboursé', 'reçu'), nom: 'sheet-2.csv' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM factures WHERE annulee = 1 OR en_attente = 1').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM factures').get().n, 3);
});

test('type de fichier reconnu et date du dernier import de chacun', () => {
  const aura = 'sku,active,current_quantity,cost,fulfillment_type,asin\nAA-1,true,4,5.00,fba,B0TEST0001';
  const commandes = 'amazon-order-id\tpurchase-date\tsku\tasin\tquantity\titem-price\torder-item-id\n1\t2026-10-06T16:32:00+00:00\tAA-1\tB0TEST0001\t1\t20\t9';
  assert.equal(detecterType(aura), 'inventaire');
  assert.equal(detecterType(commandes), 'ventes');
  assert.equal(detecterType(SHEET), 'achats');
  assert.equal(detecterType('bonjour,monde'), null);

  let r = resumeImports(db);
  assert.deepEqual([r.inventaire.date, r.ventes.date, r.achats.date, r.inventaire.en_retard], [null, null, null, true]);
  importerInventaire(db, { texte: aura, mapping: { asin: 5, quantite: 2 }, nom: 'aura.csv' });
  importerVentes(db, { texte: commandes, nom: 'commandes.txt' });
  importerAchats(db, { texte: SHEET, nom: 'achats.csv' });
  r = resumeImports(db);
  assert.deepEqual([r.inventaire.nom, r.inventaire.unites, r.inventaire.jours, r.inventaire.en_retard], ['aura.csv', 4, 0, false]);
  assert.deepEqual([r.ventes.nom, r.ventes.ventes_jusqu_au], ['commandes.txt', '2026-10-06']);
  assert.deepEqual([r.achats.nom, r.achats.factures], ['achats.csv', 3]);
});
