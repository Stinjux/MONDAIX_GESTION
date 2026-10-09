import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ouvrirBase, lireParametre, ecrireParametre } from '../src/db.js';
import { creerFacture } from '../src/services/factures.js';
import { importerInventaire } from '../src/services/inventaire.js';
import { creerEnvoi } from '../src/services/envois.js';
import { migrerRemiseAZero } from '../src/services/remiseAZero.js';

test('remise à zéro : toutes les données effacées, paramètres gardés, sauvegarde faite, une seule fois', () => {
  const dossier = mkdtempSync(join(tmpdir(), 'mondaix-'));
  const chemin = join(dossier, 'mondaix.sqlite');
  const documents = join(dossier, 'factures');
  process.env.MONDAIX_DOCUMENTS = documents;
  try {
    const db = ouvrirBase(chemin);
    ecrireParametre(db, 'amazon.domaine', 'www.amazon.ca');
    ecrireParametre(db, 'achats.taux_taxes', '14.975');
    creerFacture(db, { numero_facture: 'F-1', total: 50, lignes: [{ asin: 'B0TEST0001', quantite: 2 }] });
    importerInventaire(db, { texte: 'asin,qty,cost\nB0TEST0001,2,10', mapping: { asin: 0, quantite: 1, cost: 2 }, nom: 'aura' });
    creerEnvoi(db, { numero_envoi: 'FBA1', lignes: [{ asin: 'B0TEST0001', quantite: 1 }] });
    mkdirSync(documents, { recursive: true });
    writeFileSync(join(documents, 'facture.pdf'), 'pdf');

    const r = migrerRemiseAZero(db, { chemin });
    for (const t of ['produits', 'factures', 'facture_lignes', 'couts_achat', 'imports', 'stock_releves', 'envois', 'envoi_lignes', 'fournisseurs', 'ventes']) {
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, t);
    }
    assert.equal(r.lignes.factures, 1);
    assert.equal(lireParametre(db, 'achats.taux_taxes'), '14.975', 'paramètres conservés');
    assert.ok(existsSync(r.sauvegarde), 'copie de la base');
    assert.equal(ouvrirBase(r.sauvegarde).prepare('SELECT COUNT(*) n FROM factures').get().n, 1, 'la sauvegarde contient les anciennes données');
    assert.ok(existsSync(join(r.sauvegarde, '..', 'factures', 'facture.pdf')), 'documents déplacés dans la sauvegarde');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM journal').get().n, 1, 'seule la trace de la remise à zéro');

    creerFacture(db, { numero_facture: 'F-2', total: 10, lignes: [{ asin: 'B0TEST0002', quantite: 1 }] });
    assert.equal(migrerRemiseAZero(db, { chemin }), null, 'une seule fois');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM factures').get().n, 1, 'les nouvelles données restent');
  } finally {
    delete process.env.MONDAIX_DOCUMENTS;
    rmSync(dossier, { recursive: true, force: true });
  }
});
