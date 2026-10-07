// Synchronisation email en ligne de commande (pour une tâche planifiée / cron).
//   node src/synchro.js          → Gmail et Neo
//   node src/synchro.js neo      → une seule source
import { existsSync } from 'node:fs';
import { ouvrirBase } from './db.js';
import { synchroniserSource, synchroniserTout } from './services/synchroEmail.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const db = ouvrirBase();
const source = process.argv[2];
const resultats = source ? [await synchroniserSource(db, source)] : await synchroniserTout(db);
let echec = false;
for (const r of resultats) {
  if (r.ignoree) console.log(`${r.source} : ignorée (${r.motif})`);
  else if (r.echec) {
    echec = true;
    console.error(`${r.source} : échec — ${r.echec}`);
  } else console.log(`${r.source} : ${r.examines} examiné(s), ${r.retenus} retenu(s), ${r.importes} importé(s), ${r.doublons} déjà présent(s)${r.erreurs.length ? `, ${r.erreurs.length} erreur(s)` : ''}`);
}
process.exit(echec ? 1 : 0);
