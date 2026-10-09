// Vue d'ensemble des trois imports : inventaire (Aura), rapport de commandes Amazon et Google Sheet d'achats.
import { parserCsv } from '../lib/csv.js';
import { normaliserAsin } from '../lib/parse.js';
import { etatConnexion } from './synchroSheet.js';

/** Fréquence conseillée : chaque lundi pour les trois fichiers (7 jours). */
export const FREQUENCE_JOURS = 7;

/** Type d'un fichier d'après ses en-têtes : 'inventaire', 'ventes', 'achats' ou null. */
export function detecterType(texte) {
  const lignes = parserCsv(String(texte || '').split(/\r?\n/).slice(0, 30).join('\n'));
  if (!lignes.length) return null;
  const entetes = lignes[0].map((h) => String(h).trim().toLowerCase());
  if (entetes.includes('amazon-order-id') || entetes.includes('order-item-id')) return 'ventes';
  const sku = entetes.some((h) => ['sku', 'seller-sku', 'seller sku', 'msku', 'merchant sku'].includes(h));
  if (entetes.includes('asin') && (sku || entetes.includes('current_quantity') || entetes.some((h) => h.includes('fulfillable')))) return 'inventaire';
  if (lignes.some((l) => l.some((c) => normaliserAsin(c)))) return 'achats';
  return null;
}

function etat(dernier) {
  if (!dernier) return { date: null, jours: null, en_retard: true };
  const jours = Math.floor(dernier.jours);
  return { ...dernier, jours, en_retard: jours >= FREQUENCE_JOURS };
}

/** Dernier import de chaque fichier, avec le nombre de jours écoulés et le retard sur la fréquence conseillée. */
export function resumeImports(db) {
  const inventaire = db
    .prepare(
      `SELECT i.id, i.nom, i.created_at AS date, julianday('now') - julianday(i.created_at) AS jours,
         (SELECT COALESCE(SUM(s.quantite), 0) FROM stock_releves s WHERE s.import_id = i.id) AS unites,
         (SELECT COUNT(*) FROM stock_releves s WHERE s.import_id = i.id) AS asin
       FROM imports i WHERE i.type = 'inventaire' AND EXISTS (SELECT 1 FROM stock_releves s WHERE s.import_id = i.id)
       ORDER BY i.id DESC LIMIT 1`,
    )
    .get();
  const ventes = db
    .prepare(
      `SELECT i.id, i.nom, i.created_at AS date, julianday('now') - julianday(i.created_at) AS jours,
         (SELECT MAX(date_vente) FROM ventes) AS ventes_jusqu_au, (SELECT MIN(date_vente) FROM ventes) AS ventes_depuis
       FROM imports_ventes i ORDER BY i.id DESC LIMIT 1`,
    )
    .get();
  const achats = db
    .prepare(
      `SELECT i.id, i.nom, i.created_at AS date, julianday('now') - julianday(i.created_at) AS jours,
         (SELECT COUNT(*) FROM factures WHERE cle_import LIKE 'sheet|%') AS factures,
         (SELECT COUNT(*) FROM factures WHERE cle_import LIKE 'sheet|%' AND en_attente = 1 AND annulee = 0) AS en_attente
       FROM imports i WHERE i.type = 'sheets' AND i.empreinte IS NOT NULL ORDER BY i.id DESC LIMIT 1`,
    )
    .get();
  // Google Sheet : un fichier par mois, dernier import de chaque mois.
  const mois = db
    .prepare(
      `SELECT i.periode, i.nom, i.created_at AS date,
         (SELECT COUNT(*) FROM factures f WHERE f.cle_import LIKE 'sheet|' || i.periode || '|%' AND f.annulee = 0) AS factures
       FROM imports i
       WHERE i.type = 'sheets' AND i.periode IS NOT NULL
         AND i.id = (SELECT MAX(j.id) FROM imports j WHERE j.type = 'sheets' AND j.periode = i.periode)
       ORDER BY i.periode DESC`,
    )
    .all();
  // Lecture automatique : un envoi reçu depuis moins d'un jour suffit à être à jour.
  const c = etatConnexion(db);
  const auto = { configure: c.configure, synchro: c.synchro, minutes_depuis: c.minutes_depuis, interrompue: c.interrompue };
  const etatAchats = etat(achats);
  if (c.configure && c.minutes_depuis !== null && c.minutes_depuis < 24 * 60) etatAchats.en_retard = false;
  return { frequence_jours: FREQUENCE_JOURS, inventaire: etat(inventaire), ventes: etat(ventes), achats: { ...etatAchats, mois, auto } };
}
