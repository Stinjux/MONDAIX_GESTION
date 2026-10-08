// Indicateurs du tableau de bord par période glissante, comparés à la période précédente.
import { arrondir } from '../lib/parse.js';
import { totalFacture } from './commandes.js';

export const PERIODES = {
  '7j': { jours: 7, libelle: '7 derniers jours' },
  '30j': { jours: 30, libelle: '30 derniers jours' },
  '90j': { jours: 90, libelle: '3 derniers mois' },
  '365j': { jours: 365, libelle: '12 derniers mois' },
};

function jourIso(date) {
  return date.toISOString().slice(0, 10);
}

function decaler(date, jours) {
  return new Date(date.getTime() - jours * 86_400_000);
}

/**
 * Montant d'une commande, sans double comptage : total des factures s'il y en a,
 * sinon total déclaré, sinon somme des lignes dont le coût unitaire est connu.
 */
export function montantCommande(commande, factures, lignes) {
  const totaux = factures.map(totalFacture).filter((t) => t !== null);
  if (totaux.length) return { montant: arrondir(totaux.reduce((s, t) => s + t, 0)), base: 'facture' };
  if (commande.total_declare !== null && commande.total_declare !== undefined) return { montant: commande.total_declare, base: 'total_declare' };
  const connues = lignes.filter((l) => l.cout_unitaire_ht !== null);
  if (connues.length) return { montant: arrondir(connues.reduce((s, l) => s + l.cout_unitaire_ht * l.quantite, 0)), base: 'lignes' };
  return { montant: 0, base: 'inconnu' };
}

function variation(courant, precedent) {
  const ecart = arrondir(courant - precedent);
  return { courant, precedent, ecart, pourcentage: precedent ? arrondir((ecart / precedent) * 100) : null };
}

/** Indicateurs pour une période (« 7j », « 30j », « 90j », « 365j »). */
export function statistiques(db, periode = '30j', maintenant = new Date()) {
  const def = PERIODES[periode] || PERIODES['30j'];
  const fin = jourIso(maintenant);
  const debut = jourIso(decaler(maintenant, def.jours)); // exclu
  const debutPrecedent = jourIso(decaler(maintenant, def.jours * 2)); // exclu
  const dans = (d, de, a) => d > de && d <= a;

  // Commandes
  const commandes = db.prepare('SELECT * FROM commandes').all();
  const facturesPar = db.prepare('SELECT * FROM factures WHERE commande_id = ?');
  const lignesPar = db.prepare('SELECT * FROM commande_lignes WHERE commande_id = ?');
  const agr = { courant: { depenses: 0, unites: 0, commandes: 0, estimees: 0 }, precedent: { depenses: 0, unites: 0, commandes: 0, estimees: 0 } };
  for (const c of commandes) {
    const d = c.date_commande || String(c.created_at).slice(0, 10);
    const cle = dans(d, debut, fin) ? 'courant' : dans(d, debutPrecedent, debut) ? 'precedent' : null;
    if (!cle) continue;
    const lignes = lignesPar.all(c.id);
    const m = montantCommande(c, facturesPar.all(c.id), lignes);
    agr[cle].depenses += m.montant;
    agr[cle].unites += lignes.reduce((s, l) => s + l.quantite, 0);
    agr[cle].commandes++;
    if (m.base !== 'facture') agr[cle].estimees++;
  }

  // Envois Amazon expédiés (ceux encore en préparation ne comptent pas)
  const envois = db
    .prepare(
      `SELECT e.id, COALESCE(e.date_envoi, date(e.created_at)) AS d, COALESCE(SUM(el.quantite), 0) AS unites
       FROM envois e LEFT JOIN envoi_lignes el ON el.envoi_id = e.id
       WHERE e.statut <> 'en_preparation' GROUP BY e.id`,
    )
    .all();
  const env = { courant: { envois: 0, unites: 0 }, precedent: { envois: 0, unites: 0 } };
  for (const e of envois) {
    const cle = dans(e.d, debut, fin) ? 'courant' : dans(e.d, debutPrecedent, debut) ? 'precedent' : null;
    if (!cle) continue;
    env[cle].envois++;
    env[cle].unites += e.unites;
  }

  // Stock chez vous = unités reçues − unités expédiées à Amazon, à une date donnée
  const stockAu = (jour) => {
    const recues = db
      .prepare(
        `SELECT COALESCE(SUM(rl.quantite), 0) AS q FROM reception_lignes rl JOIN receptions r ON r.id = rl.reception_id
         WHERE COALESCE(r.date_reception, date(r.created_at)) <= ?`,
      )
      .get(jour).q;
    const envoyees = db
      .prepare(
        `SELECT COALESCE(SUM(el.quantite), 0) AS q FROM envoi_lignes el JOIN envois e ON e.id = el.envoi_id
         WHERE e.statut <> 'en_preparation' AND COALESCE(e.date_envoi, date(e.created_at)) <= ?`,
      )
      .get(jour).q;
    return recues - envoyees;
  };

  return {
    periode,
    libelle: def.libelle,
    du: debut,
    au: fin,
    indicateurs: {
      depenses: { ...variation(arrondir(agr.courant.depenses), arrondir(agr.precedent.depenses)), commandes_sans_facture: agr.courant.estimees },
      commandes: variation(agr.courant.commandes, agr.precedent.commandes),
      unites_commandees: variation(agr.courant.unites, agr.precedent.unites),
      envois: variation(env.courant.envois, env.precedent.envois),
      unites_envoyees: variation(env.courant.unites, env.precedent.unites),
      stock: variation(stockAu(fin), stockAu(debut)),
    },
  };
}
