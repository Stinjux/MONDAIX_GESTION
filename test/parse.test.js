import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parserMontant, normaliserAsin, extraireDomaine, nomDepuisDomaine, parserDate } from '../src/lib/parse.js';
import { lireTableau } from '../src/lib/csv.js';
import { proposerMapping, CHAMPS_SHEETS, CHAMPS_INVENTAIRE } from '../src/lib/mapping.js';
import { parserEml, extraireNumerosCommande, extraireMontantTotal, extraireNumerosCas, detecterStatutAutorisation, domaineExpediteur } from '../src/lib/email.js';

test('montants : formats français et anglais', () => {
  assert.equal(parserMontant('1 234,56 $'), 1234.56);
  assert.equal(parserMontant('$1,234.56'), 1234.56);
  assert.equal(parserMontant('45.99'), 45.99);
  assert.equal(parserMontant('12,5'), 12.5);
  assert.equal(parserMontant('1.234,50 €'), 1234.5);
  assert.equal(parserMontant('1,234'), 1234);
  assert.equal(parserMontant(''), null);
  assert.equal(parserMontant('n/a'), null);
});

test('ASIN : validation et extraction depuis un lien Amazon', () => {
  assert.equal(normaliserAsin(' b0abc12345 '), 'B0ABC12345');
  assert.equal(normaliserAsin('https://www.amazon.ca/dp/B0ABC12345?th=1'), 'B0ABC12345');
  assert.equal(normaliserAsin('ABC'), null);
});

test('lien fournisseur : domaine seul ou page produit', () => {
  assert.equal(extraireDomaine('walmart.ca'), 'walmart.ca');
  assert.equal(extraireDomaine('https://www.walmart.ca/fr/ip/produit/123'), 'walmart.ca');
  assert.equal(extraireDomaine('www.canadiantire.ca/fr/pdp/x.html'), 'canadiantire.ca');
  assert.equal(extraireDomaine('Walmart'), null);
  assert.equal(nomDepuisDomaine('bestbuy.ca'), 'Bestbuy');
  assert.equal(nomDepuisDomaine('shop.example.co.uk'), 'Example');
});

test('dates', () => {
  assert.equal(parserDate('05/03/2026'), '2026-03-05');
  assert.equal(parserDate('2026-3-5'), '2026-03-05');
});

test('CSV / TSV et mapping flexible des colonnes du Google Sheets', () => {
  const texte = 'ASIN\tSite sur lequel j’ai commandé\tQuantité achetée\tPrix total de la commande\nB0ABC12345\twalmart.ca\t3\t"89,97 $"\n';
  const { entetes, lignes } = lireTableau(texte);
  assert.equal(entetes.length, 4);
  assert.equal(lignes[0][3], '89,97 $');
  const m = proposerMapping(entetes, lignes, CHAMPS_SHEETS);
  assert.deepEqual(m, { asin: 0, site: 1, quantite: 2, total: 3 });
});

test('mapping par contenu quand les en-têtes sont inhabituels', () => {
  const { entetes, lignes } = lireTableau('Produit,Où,Combien,Payé\nB0ABC12345,https://www.bestbuy.ca/fr-ca/produit/1,2,50\nB0ABC12346,walmart.ca,1,20\n');
  const m = proposerMapping(entetes, lignes, CHAMPS_SHEETS);
  assert.equal(m.asin, 0);
  assert.equal(m.site, 1);
});

test('mapping inventaire : colonne cost', () => {
  const { entetes, lignes } = lireTableau('sku,asin,title,cost,quantity\nSKU1,B0ABC12345,Truc,4.50,10\n');
  const m = proposerMapping(entetes, lignes, CHAMPS_INVENTAIRE);
  assert.deepEqual(m, { sku: 0, asin: 1, titre: 2, cost: 3, quantite: 4 });
});

test('email .eml multipart quoted-printable', () => {
  const eml = [
    'From: =?UTF-8?Q?Walmart_Canada?= <noreply@walmart.ca>',
    'Subject: =?UTF-8?B?Q29uZmlybWF0aW9uIGRlIGNvbW1hbmRl?=',
    'Date: Mon, 05 Oct 2026 10:00:00 -0400',
    'Message-ID: <abc@walmart.ca>',
    'Content-Type: multipart/alternative; boundary="XX"',
    '',
    '--XX',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Num=C3=A9ro de commande : 200012345678',
    'Total : 89,97 $',
    '--XX--',
    '',
  ].join('\r\n');
  const m = parserEml(eml);
  assert.equal(m.sujet, 'Confirmation de commande');
  assert.equal(m.messageId, 'abc@walmart.ca');
  assert.match(m.corps, /Numéro de commande : 200012345678/);
  assert.deepEqual(extraireNumerosCommande(m.corps), ['200012345678']);
  assert.equal(extraireMontantTotal(m.corps), 89.97);
  assert.equal(domaineExpediteur(m.expediteur), 'walmart.ca');
});

test('références Amazon dans une réponse Neo', () => {
  const texte = 'Hello, regarding Case ID: 12345678901 for ASIN B0ABC12345, your request has not been approved.';
  assert.deepEqual(extraireNumerosCas(texte), ['12345678901']);
  assert.equal(detecterStatutAutorisation(texte), 'refuse');
  assert.equal(detecterStatutAutorisation('You have been approved to sell this product.'), 'approuve');
  assert.equal(detecterStatutAutorisation('Please provide an invoice from your supplier.'), 'documents_requis');
  assert.equal(extraireNumerosCommande('Order Confirmation').length, 0);
});
