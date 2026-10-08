// Indicateurs du tableau de bord par période glissante, comparés à la période précédente.
import { arrondir, normaliserReference } from '../lib/parse.js';
import { totalFacture } from './commandes.js';
import { etatStock } from './inventaire.js';

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
 * Montant d'une commande, sans double comptage : le prix total venant du Google Sheets
 * (total déclaré) fait foi ; à défaut, le total des factures, sinon la somme des lignes
 * dont le coût unitaire est connu.
 */
export function montantCommande(commande, factures, lignes) {
  if (commande.total_declare !== null && commande.total_declare !== undefined) return { montant: commande.total_declare, base: 'total_declare' };
  const totaux = factures.map(totalFacture).filter((t) => t !== null);
  if (totaux.length) return { montant: arrondir(totaux.reduce((s, t) => s + t, 0)), base: 'facture' };
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
  const vide = () => ({ depenses: 0, unites: 0, commandes: 0, estimees: 0, depenses_commandes: 0, depenses_factures: 0, factures: 0 });
  const agr = { courant: vide(), precedent: vide() };
  for (const c of commandes) {
    const d = c.date_commande || String(c.created_at).slice(0, 10);
    const cle = dans(d, debut, fin) ? 'courant' : dans(d, debutPrecedent, debut) ? 'precedent' : null;
    if (!cle) continue;
    const lignes = lignesPar.all(c.id);
    const m = montantCommande(c, facturesPar.all(c.id), lignes);
    agr[cle].depenses += m.montant;
    agr[cle].depenses_commandes += m.montant;
    agr[cle].unites += lignes.reduce((s, l) => s + l.quantite, 0);
    agr[cle].commandes++;
    if (m.base !== 'total_declare') agr[cle].estimees++;
  }

  // Factures enregistrées seules (sans commande) : ce sont aussi des achats.
  // Une facture portant le n° d'une commande existante est déjà comptée avec cette commande.
  const numerosCommandes = new Set(commandes.map((c) => normaliserReference(c.numero_commande)).filter(Boolean));
  const facturesSeules = db.prepare('SELECT * FROM factures WHERE commande_id IS NULL').all();
  const lignesFacture = db.prepare('SELECT quantite FROM facture_lignes WHERE facture_id = ?');
  for (const f of facturesSeules) {
    const ref = normaliserReference(f.numero_commande_ref);
    if (ref && numerosCommandes.has(ref)) continue;
    const d = f.date_facture || String(f.created_at).slice(0, 10);
    const cle = dans(d, debut, fin) ? 'courant' : dans(d, debutPrecedent, debut) ? 'precedent' : null;
    if (!cle) continue;
    const montant = totalFacture(f) ?? 0;
    agr[cle].depenses += montant;
    agr[cle].depenses_factures += montant;
    agr[cle].unites += lignesFacture.all(f.id).reduce((s, l) => s + l.quantite, 0);
    agr[cle].commandes++;
    agr[cle].factures++;
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

  // Stock : dernier import du fichier d'inventaire, comparé à l'import précédent
  const st = etatStock(db);
  const stock = st.dernier
    ? {
        ...variation(st.dernier.total, st.precedent ? st.precedent.total : st.dernier.total),
        date_import: st.dernier.date,
        date_import_precedent: st.precedent?.date ?? null,
      }
    : null;

  return {
    periode,
    libelle: def.libelle,
    du: debut,
    au: fin,
    indicateurs: {
      depenses: {
        ...variation(arrondir(agr.courant.depenses), arrondir(agr.precedent.depenses)),
        commandes_sans_total: agr.courant.estimees,
        dont_commandes: arrondir(agr.courant.depenses_commandes),
        dont_factures: arrondir(agr.courant.depenses_factures),
        nb_factures: agr.courant.factures,
      },
      commandes: variation(agr.courant.commandes, agr.precedent.commandes),
      unites_commandees: variation(agr.courant.unites, agr.precedent.unites),
      envois: variation(env.courant.envois, env.precedent.envois),
      unites_envoyees: variation(env.courant.unites, env.precedent.unites),
      stock,
    },
  };
}
