import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ouvrirBase } from '../src/db.js';
import { importerVentes, listerImportsVentes, supprimerImportVentes, jourCommande } from '../src/services/ventes.js';
import { importerInventaire } from '../src/services/inventaire.js';
import { statistiques } from '../src/services/statistiques.js';

const ENTETE = 'amazon-order-id\tpurchase-date\torder-status\tfulfillment-channel\tsku\tasin\titem-status\tquantity\tcurrency\titem-price\torder-item-id';
const ligne = (cmd, date, asin, q, prix, statut = 'Shipped', item = `${cmd}-1`) => [cmd, date, statut, 'Amazon', 'SKU-' + asin, asin, statut, q, 'CAD', prix, item].join('\t');
const rapport = (...l) => [ENTETE, ...l].join('\n');
const maintenant = new Date('2026-10-09T12:00:00Z');

let db;
beforeEach(() => {
  db = ouvrirBase(':memory:');
});

test('jour de commande à l’heure de l’Est', () => {
  assert.equal(jourCommande('2026-10-06T16:32:00+00:00'), '2026-10-06');
  assert.equal(jourCommande('2026-10-07T02:10:00+00:00'), '2026-10-06', '22 h 10 à Montréal = la veille en UTC+0');
  assert.equal(jourCommande('2026-10-06'), '2026-10-06');
});

test('rapport de commandes : réimport sans doublon, annulations exclues, COGS sur ventes réelles', () => {
  importerInventaire(db, { texte: 'asin,qty,cost\nB0AAAAAAA1,10,4\nB0AAAAAAA2,5,10', mapping: { asin: 0, quantite: 1, cost: 2 }, nom: 'aura' });
  const r1 = importerVentes(db, {
    texte: rapport(
      ligne('701-1', '2026-10-03T23:47:28+00:00', 'B0AAAAAAA1', 2, '18.00'),
      ligne('701-2', '2026-10-06T14:54:51+00:00', 'B0AAAAAAA2', 1, '36.00', 'Pending'),
    ),
    nom: 'r1',
  });
  assert.deepEqual([r1.nouvelles, r1.mises_a_jour, r1.unites, r1.du, r1.au], [2, 0, 3, '2026-10-03', '2026-10-06']);

  // Le même rapport plus récent : la commande en attente a été annulée, une nouvelle vente s'ajoute.
  const r2 = importerVentes(db, {
    texte: rapport(
      ligne('701-1', '2026-10-03T23:47:28+00:00', 'B0AAAAAAA1', 2, '18.00'),
      ligne('701-2', '2026-10-06T14:54:51+00:00', 'B0AAAAAAA2', 1, '', 'Cancelled'),
      ligne('701-3', '2026-10-07T13:00:00+00:00', 'B0AAAAAAA1', 1, '9.50'),
    ),
    nom: 'r2',
  });
  assert.deepEqual([r2.nouvelles, r2.mises_a_jour, r2.annulees, r2.unites], [1, 2, 1, 3]);

  const c = statistiques(db, '30j', maintenant).indicateurs.cogs;
  assert.equal(c.unites_vendues.courant, 3, '2 + 1 unités, la commande annulée ne compte pas');
  assert.equal(c.courant, 12, '3 × 4 $');
  assert.equal(c.ca.courant, 27.5);
  assert.equal(c.marge_avant_frais.courant, 15.5);
  assert.equal(c.unites_estimees, 0);
  assert.deepEqual(c.ventes_reelles, { du: '2026-10-03', au: '2026-10-07' });

  // Le premier rapport ne porte plus aucune ligne (toutes réimportées) : le supprimer ne change rien.
  const [dernier, premier] = listerImportsVentes(db);
  assert.equal(premier.lignes, 0);
  supprimerImportVentes(db, premier.id);
  assert.equal(statistiques(db, '30j', maintenant).indicateurs.cogs.unites_vendues.courant, 3);
  supprimerImportVentes(db, dernier.id);
  assert.equal(statistiques(db, '30j', maintenant).indicateurs.cogs.unites_vendues.courant, 0);
});

test('ventes estimées par l’inventaire avant le premier rapport, réelles ensuite', () => {
  const inv = (texte, nom) => importerInventaire(db, { texte, mapping: { asin: 0, quantite: 1, cost: 2 }, nom });
  inv('asin,qty,cost\nB0AAAAAAA1,10,4', 'i1');
  db.prepare("UPDATE imports SET created_at = '2026-09-20 10:00:00' WHERE nom = 'i1'").run();
  inv('asin,qty,cost\nB0AAAAAAA1,8,4', 'i2');
  db.prepare("UPDATE imports SET created_at = '2026-09-25 10:00:00' WHERE nom = 'i2'").run();
  importerVentes(db, { texte: rapport(ligne('701-9', '2026-10-05T15:00:00+00:00', 'B0AAAAAAA1', 1, '10')), nom: 'r' });
  const c = statistiques(db, '30j', maintenant).indicateurs.cogs;
  assert.equal(c.unites_vendues.courant, 3, '2 estimées (10 → 8) + 1 réelle');
  assert.equal(c.unites_estimees, 2);
});

test('rapport invalide : message clair', () => {
  assert.throws(() => importerVentes(db, { texte: 'asin,qty\nB0AAAAAAA1,2', nom: 'x' }), /rapport de commandes Amazon/);
});

test('inventaire : offre expédiée par le vendeur (mf) exclue du stock Amazon', () => {
  const r = importerInventaire(db, {
    texte: 'asin,current_quantity,fulfillment_type\nB0AAAAAAA1,4,fba\nB0AAAAAAA2,3,mf',
    mapping: { asin: 0, quantite: 1, expedition: 2 },
    nom: 'aura',
  });
  assert.equal(r.hors_fba.length, 1);
  const q = db.prepare('SELECT asin, quantite FROM stock_releves ORDER BY asin').all().map((x) => [x.asin, x.quantite]);
  assert.deepEqual(q, [['B0AAAAAAA1', 4]]);
});
