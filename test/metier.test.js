import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ouvrirBase } from '../src/db.js';
import { importerSheets, listerLignesImport, grouperEnCommande, validerFournisseurLignes, rattacherLignes, detacherLigne, propositionsRattachement, lierLigneExistante } from '../src/services/importSheets.js';
import { importerInventaire } from '../src/services/inventaire.js';
import { creerCommande, lireCommande, creerFacture, comparerTotal, creerReception } from '../src/services/commandes.js';
import { coutComplet, ecartsCouts, historiqueCouts, retenirCout, coutRetenu, creerDepense } from '../src/services/couts.js';
import { creerFournisseur } from '../src/services/fournisseurs.js';
import { ingererEmail, validerRapprochement, appliquerStatutNeo, lireEmail } from '../src/services/emails.js';
import { creerDossier, etatParAsin } from '../src/services/autorisations.js';
import { creerEnvoi } from '../src/services/envois.js';
import { tableauDeBord } from '../src/services/tableauDeBord.js';

let db;
beforeEach(() => {
  db = ouvrirBase(':memory:');
});

const SHEET = [
  'ASIN,Site,Quantité,Prix total',
  'B0AAAAAAA1,https://www.walmart.ca/fr/ip/produit-a/111,2,"120,00 $"',
  'B0AAAAAAA2,walmart.ca,3,"120,00 $"',
  'B0AAAAAAA3,walmart.ca,1,"120,00 $"',
  'B0AAAAAAA4,bestbuy.ca,1,"55,50 $"',
].join('\n');
const MAPPING = { asin: 0, site: 1, quantite: 2, total: 3 };

test('import Sheets : lignes en attente, aucun regroupement automatique, lien conservé', () => {
  creerFournisseur(db, { nom: 'Walmart', domaines: ['walmart.ca'] });
  const bilan = importerSheets(db, { texte: SHEET, mapping: MAPPING, nom: 'test' });
  assert.equal(bilan.lignes, 4);
  const lignes = listerLignesImport(db);
  assert.ok(lignes.every((l) => l.statut === 'en_attente'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commandes').get().n, 0, 'aucune commande créée automatiquement');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM depenses').get().n, 0, 'aucune dépense créée à partir du total');
  const l1 = lignes.find((l) => l.asin === 'B0AAAAAAA1');
  assert.equal(l1.lien_original, 'https://www.walmart.ca/fr/ip/produit-a/111');
  assert.equal(l1.fournisseur_propose, 'Walmart');
  assert.equal(l1.fournisseur_valide_id, null, 'proposition non validée');
  const l4 = lignes.find((l) => l.asin === 'B0AAAAAAA4');
  assert.equal(l4.fournisseur_propose_nom, 'Bestbuy');
});

test('regroupement manuel : total déclaré enregistré une seule fois', () => {
  importerSheets(db, { texte: SHEET, mapping: MAPPING });
  const lignes = listerLignesImport(db);
  const walmart = lignes.filter((l) => l.domaine === 'walmart.ca');
  const fid = validerFournisseurLignes(db, { ligne_ids: walmart.map((l) => l.id), creer: { nom: 'Walmart' } });
  const { commande_id } = grouperEnCommande(db, {
    ligne_ids: walmart.slice(0, 2).map((l) => l.id),
    numero_commande: 'W-1001',
    date_commande: '2026-09-01',
  });
  const c = lireCommande(db, commande_id);
  assert.equal(c.total_declare, 120, 'le total n’est pas additionné (pas 240)');
  assert.equal(c.fournisseur_id, fid);
  assert.equal(c.total_inclut_taxes, null);
  assert.equal(c.lignes.length, 2);
  assert.ok(c.lignes.every((l) => l.cout_unitaire_ht === null), 'aucune ventilation inventée');
  assert.equal(c.comparaison.statut, 'sans_facture');
  // la 3e ligne walmart reste en attente
  const restantes = listerLignesImport(db, { statut: 'en_attente' });
  assert.deepEqual(restantes.map((l) => l.asin).sort(), ['B0AAAAAAA3', 'B0AAAAAAA4']);
});

test('regroupement : totaux différents → choix explicite exigé, jamais de somme', () => {
  importerSheets(db, { texte: SHEET, mapping: MAPPING });
  const lignes = listerLignesImport(db);
  const ids = [lignes.find((l) => l.asin === 'B0AAAAAAA3').id, lignes.find((l) => l.asin === 'B0AAAAAAA4').id];
  assert.throws(() => grouperEnCommande(db, { ligne_ids: ids }), /totaux différents/);
  const { commande_id } = grouperEnCommande(db, { ligne_ids: ids, total_declare: '55,50' });
  assert.equal(lireCommande(db, commande_id).total_declare, 55.5);
});

test('rattacher / détacher : la ligne revient en attente', () => {
  importerSheets(db, { texte: SHEET, mapping: MAPPING });
  const lignes = listerLignesImport(db);
  const [a, b] = lignes;
  const { commande_id } = grouperEnCommande(db, { ligne_ids: [a.id] });
  const r = rattacherLignes(db, { ligne_ids: [b.id], commande_id });
  assert.equal(r.avertissements.length, 0);
  assert.equal(lireCommande(db, commande_id).total_declare, 120);
  detacherLigne(db, b.id);
  assert.equal(listerLignesImport(db).find((l) => l.id === b.id).statut, 'en_attente');
  assert.equal(lireCommande(db, commande_id).lignes.length, 1);
});

test('proposition de rattachement à une commande saisie à la main (validation requise)', () => {
  const id = creerCommande(db, { numero_commande: 'X1', lignes: [{ asin: 'B0AAAAAAA4', quantite: 1 }] });
  importerSheets(db, { texte: SHEET, mapping: MAPPING });
  const props = propositionsRattachement(db);
  const p = props.find((x) => x.asin === 'B0AAAAAAA4');
  assert.ok(p);
  assert.equal(p.candidates[0].commande_id, id);
  assert.equal(listerLignesImport(db).find((l) => l.asin === 'B0AAAAAAA4').statut, 'en_attente', 'pas de rattachement implicite');
  lierLigneExistante(db, { ligne_id: p.ligne_id, ligne_commande_id: p.candidates[0].ligne_commande_id });
  assert.equal(lireCommande(db, id).lignes.length, 1, 'pas de doublon de ligne');
});

test('réimport : doublons signalés, pas ignorés silencieusement', () => {
  importerSheets(db, { texte: SHEET, mapping: MAPPING });
  const bilan = importerSheets(db, { texte: SHEET, mapping: MAPPING });
  assert.equal(bilan.doublons, 4);
});

test('cost d’inventaire : coût d’achat HT conservé, écarts signalés sans écrasement', () => {
  const inv = 'asin,cost\nB0AAAAAAA1,10.00\n';
  importerInventaire(db, { texte: inv, mapping: { asin: 0, cost: 1 }, nom: 'inv1' });
  assert.equal(coutRetenu(db, 'B0AAAAAAA1').montant_unitaire_ht, 10);
  // la facture indique un autre prix unitaire
  const cid = creerCommande(db, { numero_commande: 'C1', total_declare: 30, total_inclut_taxes: 0, total_inclut_livraison: 0, lignes: [{ asin: 'B0AAAAAAA1', quantite: 3 }] });
  creerFacture(db, { commande_id: cid, sous_total_ht: 31.5, lignes: [{ asin: 'B0AAAAAAA1', quantite: 3, prix_unitaire_ht: 10.5 }] });
  assert.equal(coutRetenu(db, 'B0AAAAAAA1').montant_unitaire_ht, 10, 'pas d’écrasement silencieux');
  const ecarts = ecartsCouts(db);
  assert.equal(ecarts.length, 1);
  assert.equal(ecarts[0].ecart, 0.5);
  // choix explicite
  retenirCout(db, 'B0AAAAAAA1', ecarts[0].cout_id);
  assert.equal(coutRetenu(db, 'B0AAAAAAA1').montant_unitaire_ht, 10.5);
  assert.equal(ecartsCouts(db).length, 0);
  assert.equal(historiqueCouts(db, 'B0AAAAAAA1').length, 2, 'historique conservé');
  // réimport du même inventaire : pas de doublon d'historique
  importerInventaire(db, { texte: inv, mapping: { asin: 0, cost: 1 }, nom: 'inv1' });
  assert.equal(historiqueCouts(db, 'B0AAAAAAA1').length, 2);
});

test('coût complet = coût d’achat + dépenses enregistrées ; total déclaré jamais ajouté', () => {
  importerInventaire(db, { texte: 'asin,cost\nB0AAAAAAA1,10\nB0AAAAAAA2,20\n', mapping: { asin: 0, cost: 1 } });
  const cid = creerCommande(db, {
    numero_commande: 'C2',
    total_declare: 999, // montant volontairement absurde : ne doit pas entrer dans le calcul
    lignes: [
      { asin: 'B0AAAAAAA1', quantite: 3 },
      { asin: 'B0AAAAAAA2', quantite: 1 },
    ],
  });
  let cc = coutComplet(db, 'B0AAAAAAA1');
  assert.equal(cc.cout_complet_unitaire, 10, 'sans dépense : coût d’achat seul');
  assert.ok(cc.alertes.some((a) => /Aucune dépense/.test(a)));
  creerDepense(db, { type: 'livraison_fournisseur', montant: 8, commande_id: cid });
  const eid = creerEnvoi(db, { numero_envoi: 'FBA1', lignes: [{ asin: 'B0AAAAAAA1', quantite: 3, commande_id: cid }, { asin: 'B0AAAAAAA2', quantite: 1, commande_id: cid }] });
  creerDepense(db, { type: 'transport_amazon', montant: 4, envoi_id: eid });
  creerDepense(db, { type: 'preparation', montant: 1.5, asin: 'B0AAAAAAA1', quantite_concernee: 3 });
  cc = coutComplet(db, 'B0AAAAAAA1');
  // livraison 8 € répartie 6/2 sur 3 et 1 unités → 2/unité ; transport 4 → 1/unité ; préparation 0,5/unité
  assert.deepEqual(cc.par_unite, { achat: 10, frais_commande: 2, frais_envoi: 1, frais_directs: 0.5 });
  assert.equal(cc.cout_complet_unitaire, 13.5);
});

test('comparaison total déclaré / facture selon la composition', () => {
  const f = [{ sous_total_ht: 100, taxes: 14.98, livraison: 10, autres_frais: null, total: null }];
  assert.equal(comparerTotal({ total_declare: 124.98, total_inclut_taxes: 1, total_inclut_livraison: 1 }, f).statut, 'conforme');
  const ecart = comparerTotal({ total_declare: 120, total_inclut_taxes: 1, total_inclut_livraison: 1 }, f);
  assert.equal(ecart.statut, 'ecart');
  assert.equal(ecart.ecart, -4.98);
  assert.equal(comparerTotal({ total_declare: 100, total_inclut_taxes: 0, total_inclut_livraison: 0 }, f).statut, 'conforme');
  const inconnu = comparerTotal({ total_declare: 110, total_inclut_taxes: null, total_inclut_livraison: null }, f);
  assert.equal(inconnu.statut, 'composition_inconnue');
  assert.equal(inconnu.correspondances[0].inclut_livraison, 1);
  assert.equal(inconnu.correspondances[0].inclut_taxes, 0);
  assert.equal(comparerTotal({ total_declare: 110 }, []).statut, 'sans_facture');
});

test('Gmail → commandes uniquement ; rapprochement automatique sur n° exact', () => {
  const cid = creerCommande(db, { numero_commande: '200012345678', lignes: [{ asin: 'B0AAAAAAA1', quantite: 1 }] });
  const { id } = ingererEmail(db, 'gmail', { expediteur: 'Walmart <noreply@walmart.ca>', sujet: 'Confirmation', corps: 'Numéro de commande : 200012345678\nTotal : 20,00 $' });
  const e = lireEmail(db, id);
  assert.equal(e.module, 'commandes');
  assert.equal(e.commande_id, cid);
  assert.equal(e.mode_rapprochement, 'auto');
  assert.throws(() => validerRapprochement(db, id, { dossier_id: 1 }), /commande, pas à un dossier/);
  // la base refuse aussi un email Gmail lié à un dossier
  assert.throws(() => db.prepare("INSERT INTO emails (source, module) VALUES ('gmail', 'autorisations')").run());
});

test('Gmail : correspondance faible → proposition à valider, jamais automatique', () => {
  const f = creerFournisseur(db, { nom: 'Walmart', domaines: ['walmart.ca'] });
  const c1 = creerCommande(db, { fournisseur_id: f.id, total_declare: 50, date_commande: '2026-10-01', lignes: [{ asin: 'B0AAAAAAA1', quantite: 1 }] });
  creerCommande(db, { fournisseur_id: f.id, total_declare: 50, date_commande: '2026-10-02', lignes: [{ asin: 'B0AAAAAAA2', quantite: 1 }] });
  const { id } = ingererEmail(db, 'gmail', { expediteur: 'orders@walmart.ca', sujet: 'Merci', corps: 'Total : 50,00 $', date: '2026-10-02T12:00:00Z' });
  const e = lireEmail(db, id);
  assert.equal(e.commande_id, null);
  assert.equal(e.statut_rapprochement, 'ambigu');
  validerRapprochement(db, id, { commande_id: c1 });
  assert.equal(lireEmail(db, id).commande_id, c1);
});

test('Neo → dossiers ; statut confirmé seulement après validation', () => {
  const did = creerDossier(db, { asin: 'B0AAAAAAA1', numero_cas: '12345678901' });
  creerDossier(db, { asin: 'B0AAAAAAA2' });
  const { id } = ingererEmail(db, 'neo', { expediteur: 'seller-performance@amazon.ca', sujet: 'Case 12345678901', corps: 'Your request for ASIN B0AAAAAAA1 has been approved.' });
  const e = lireEmail(db, id);
  assert.equal(e.module, 'autorisations');
  assert.equal(e.dossier_id, did);
  assert.equal(e.references_extraites.statut, 'approuve');
  let etat = etatParAsin(db).find((a) => a.asin === 'B0AAAAAAA1');
  assert.equal(etat.confirme, false, 'statut détecté non appliqué sans validation');
  appliquerStatutNeo(db, id, 'approuve');
  etat = etatParAsin(db).find((a) => a.asin === 'B0AAAAAAA1');
  assert.equal(etat.confirme, true);
  assert.throws(() => validerRapprochement(db, id, { commande_id: 1 }), /dossier d’autorisation, pas à une commande/);
});

test('Neo : sans n° de cas connu, ASIN cité → proposition ; validation enregistre le n° de cas', () => {
  const did = creerDossier(db, { asin: 'B0AAAAAAA2' });
  const { id } = ingererEmail(db, 'neo', { sujet: 'Re: approval', corps: 'Case ID: 98765432100 – ASIN B0AAAAAAA2 – please provide additional information.' });
  const e = lireEmail(db, id);
  assert.equal(e.statut_rapprochement, 'propose');
  assert.equal(e.dossier_id, null);
  validerRapprochement(db, id, { dossier_id: did });
  assert.equal(db.prepare('SELECT numero_cas FROM dossiers_autorisation WHERE id = ?').get(did).numero_cas, '98765432100');
});

test('tableau de bord : commandes sans facture, lignes sans commande, ASIN sans autorisation confirmée', () => {
  importerSheets(db, { texte: SHEET, mapping: MAPPING });
  const lignes = listerLignesImport(db);
  const { commande_id } = grouperEnCommande(db, { ligne_ids: [lignes[0].id] });
  creerReception(db, commande_id, {});
  const t = tableauDeBord(db);
  assert.equal(t.compteurs.commandes_sans_facture, 1);
  assert.equal(t.compteurs.lignes_sans_commande, 3);
  assert.equal(t.compteurs.asin_sans_autorisation_confirmee, 4);
  creerFacture(db, { commande_id, total: 120 });
  assert.equal(tableauDeBord(db).compteurs.commandes_sans_facture, 0);
  assert.equal(lireCommande(db, commande_id).chaine.find((e) => e.etape === 'reception').etat, 'ok');
});
