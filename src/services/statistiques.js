// Indicateurs du tableau de bord par période glissante, comparés à la période précédente.
import { arrondir } from '../lib/parse.js';
import { totalFacture } from './factures.js';
import { etatStock, ventesEstimees } from './inventaire.js';
import { listerAsins } from './asins.js';
import { debutVentesReelles, finVentesReelles, ventesReelles } from './ventes.js';

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

  // Achats = factures enregistrées (les factures annulées / remboursées ne comptent pas).
  const vide = () => ({ depenses: 0, unites: 0, factures: 0, annulees: 0, montant_annule: 0 });
  const agr = { courant: vide(), precedent: vide() };
  const factures = db.prepare('SELECT * FROM factures').all();
  const lignesFacture = db.prepare('SELECT quantite FROM facture_lignes WHERE facture_id = ?');
  for (const f of factures) {
    const d = f.date_facture || String(f.created_at).slice(0, 10);
    const cle = dans(d, debut, fin) ? 'courant' : dans(d, debutPrecedent, debut) ? 'precedent' : null;
    if (!cle) continue;
    const montant = totalFacture(f) ?? 0;
    if (f.annulee) {
      agr[cle].annulees++;
      agr[cle].montant_annule += montant;
      continue;
    }
    agr[cle].depenses += montant;
    agr[cle].unites += lignesFacture.all(f.id).reduce((s, l) => s + l.quantite, 0);
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

  // COGS : unités vendues × coût d'achat unitaire HT retenu.
  // Ventes réelles (rapport de commandes Amazon) à partir du premier jour couvert par un rapport ;
  // avant, ventes estimées par la baisse du stock entre deux imports d'inventaire.
  const couts = new Map(
    db.prepare('SELECT p.asin, c.montant_unitaire_ht AS cout FROM produits p JOIN couts_achat c ON c.id = p.cout_retenu_id').all().map((r) => [r.asin, r.cout]),
  );
  const debutReel = debutVentesReelles(db);
  const ventes = [
    ...ventesEstimees(db)
      .filter((v) => !debutReel || v.date < debutReel)
      .map((v) => ({ asin: v.asin, date: v.date, unites: v.vendues, montant: null, reelle: false })),
    ...ventesReelles(db).map((v) => ({ ...v, reelle: true })),
  ];
  const videCogs = () => ({ montant: 0, unites: 0, sans_cout: 0, ca: 0, unites_estimees: 0, parAsin: new Map() });
  const cogs = { courant: videCogs(), precedent: videCogs() };
  for (const v of ventes) {
    const cle = dans(v.date, debut, fin) ? 'courant' : dans(v.date, debutPrecedent, debut) ? 'precedent' : null;
    if (!cle) continue;
    const cout = couts.get(v.asin);
    const a = cogs[cle];
    a.unites += v.unites;
    if (!v.reelle) a.unites_estimees += v.unites;
    a.ca += v.montant ?? 0;
    if (cout === undefined) a.sans_cout += v.unites;
    else a.montant += v.unites * cout;
    const ligne = a.parAsin.get(v.asin) || { asin: v.asin, unites: 0, unites_estimees: 0, cout_unitaire: cout ?? null, montant: 0, ca: 0 };
    ligne.unites += v.unites;
    if (!v.reelle) ligne.unites_estimees += v.unites;
    ligne.ca = arrondir(ligne.ca + (v.montant ?? 0));
    ligne.montant = cout === undefined ? null : arrondir(ligne.unites * cout);
    a.parAsin.set(v.asin, ligne);
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
        factures_annulees: agr.courant.annulees,
        montant_annule: arrondir(agr.courant.montant_annule),
      },
      factures: variation(agr.courant.factures, agr.precedent.factures),
      unites_achetees: variation(agr.courant.unites, agr.precedent.unites),
      envois: variation(env.courant.envois, env.precedent.envois),
      unites_envoyees: variation(env.courant.unites, env.precedent.unites),
      stock,
      // Stock total = chez Amazon + en transit + à envoyer (acheté sur factures, pas encore expédié).
      stock_total: listerAsins(db).reduce(
        (t, p) => ({
          total: t.total + p.stock_total.total,
          amazon: t.amazon + p.stock_total.amazon,
          en_transit: t.en_transit + p.stock_total.en_transit,
          a_envoyer: t.a_envoyer + p.stock_total.a_envoyer,
        }),
        { total: 0, amazon: 0, en_transit: 0, a_envoyer: 0 },
      ),
      cogs: {
        ...variation(arrondir(cogs.courant.montant), arrondir(cogs.precedent.montant)),
        unites_vendues: variation(cogs.courant.unites, cogs.precedent.unites),
        unites_sans_cout: cogs.courant.sans_cout,
        unites_estimees: cogs.courant.unites_estimees,
        // Chiffre d'affaires (item-price des commandes, hors taxes) et marge avant frais Amazon.
        ca: variation(arrondir(cogs.courant.ca), arrondir(cogs.precedent.ca)),
        marge_avant_frais: variation(arrondir(cogs.courant.ca - cogs.courant.montant), arrondir(cogs.precedent.ca - cogs.precedent.montant)),
        ventes_reelles: { du: debutReel, au: finVentesReelles(db) },
        par_asin: [...cogs.courant.parAsin.values()].sort((a, b) => (b.montant ?? -1) - (a.montant ?? -1) || b.unites - a.unites),
      },
    },
  };
}
