// Import du Google Sheet de suivi des achats (Fichier › Télécharger › CSV), avec ou sans ligne d'en-tête.
// Colonnes : ASIN, site (fournisseur), quantité, total payé TTC, date et, si présente, statut.
//
// Règles :
// - chaque ligne devient une facture (source : Google Sheet) ; réimporter le Sheet met à jour les
//   factures déjà créées (quantité, total, statut) et n'en crée jamais deux pour la même ligne ;
// - une ligne retirée du Sheet ne supprime jamais de facture ;
// - le total est TTC : HT = total ÷ (1 + taux de taxes) ; le prix unitaire n'est pas déduit du
//   Sheet (le coût d'achat HT reste celui du fichier d'inventaire Aura ou d'une facture détaillée) ;
// - statut (les couleurs ne sont pas exportées en CSV) : reçu (par défaut), en attente, annulé / remboursé.
import { ErreurMetier, assurerProduit, journaliser, lireParametre, transaction } from '../db.js';
import { parserCsv } from '../lib/csv.js';
import { arrondir, extraireDomaine, nomDepuisDomaine, normaliserAsin, normaliserTexte, parserDate, parserMontant, parserQuantite } from '../lib/parse.js';
import { annulerFacture, creerFacture, retablirFacture } from './factures.js';
import { creerFournisseur, listerFournisseurs, trouverParDomaine } from './fournisseurs.js';
import { empreinteTexte } from './inventaire.js';

const ENTETES = {
  asin: ['asin'],
  site: ['site', 'fournisseur', 'magasin', 'lien', 'url', 'store', 'source', 'detaillant'],
  quantite: ['quantite', 'qte', 'qt', 'qty', 'quantity', 'unites'],
  total: ['total', 'prix', 'montant', 'cout', 'cout total', 'prix total', 'total ttc', 'price'],
  date: ['date', 'date achat', 'date commande', 'date facture'],
  statut: ['statut', 'etat', 'status'],
};

/** « reçu », « en attente », « annulé / remboursé » → recu | en_attente | annule (null si non reconnu). */
export function statutAchat(valeur) {
  const t = normaliserTexte(valeur);
  if (!t) return null;
  if (/annul|rembours|cancel|refund/.test(t)) return 'annule';
  if (/attente|pending|commande|en route|transit|expedie/.test(t)) return 'en_attente';
  if (/recu|livre|received|delivered|ok/.test(t)) return 'recu';
  return null;
}

/** Repère les colonnes : par l'en-tête s'il existe, sinon par position à partir de la colonne des ASIN. */
function reperer(lignes) {
  const nbCol = Math.max(...lignes.map((l) => l.length));
  let colAsin = -1;
  let meilleur = 0;
  for (let c = 0; c < nbCol; c++) {
    const n = lignes.filter((l) => normaliserAsin(l[c])).length;
    if (n > meilleur) [colAsin, meilleur] = [c, n];
  }
  if (colAsin < 0) throw new ErreurMetier('Aucun ASIN trouvé : ce fichier n’est pas votre Google Sheet d’achats (Fichier › Télécharger › CSV).');
  const premiere = lignes[0].map((h) => normaliserTexte(h));
  const enTete = !normaliserAsin(lignes[0][colAsin]) && premiere.some((h) => ENTETES.asin.includes(h));
  if (enTete) {
    const map = {};
    for (const [champ, noms] of Object.entries(ENTETES)) {
      const i = premiere.findIndex((h) => noms.includes(h));
      if (i >= 0) map[champ] = i;
    }
    for (const champ of ['quantite', 'total']) {
      if (map[champ] === undefined) throw new ErreurMetier(`Colonne « ${ENTETES[champ][0]} » introuvable dans l’en-tête du Sheet.`);
    }
    return { map, debut: 1 };
  }
  // Sans en-tête : ASIN | site | quantité | total | date | statut (si la colonne contient des statuts).
  const map = { asin: colAsin, site: colAsin + 1, quantite: colAsin + 2, total: colAsin + 3, date: colAsin + 4 };
  if (lignes.some((l) => statutAchat(l[colAsin + 5]))) map.statut = colAsin + 5;
  return { map, debut: 0 };
}

function fournisseurPour(db, site, cache) {
  const texte = String(site || '').trim();
  if (!texte) return null;
  if (cache.has(texte)) return cache.get(texte);
  const domaine = extraireDomaine(texte);
  let f = domaine ? trouverParDomaine(db, domaine) : null;
  const nom = domaine ? nomDepuisDomaine(domaine) : texte;
  f ||= listerFournisseurs(db).find((x) => normaliserTexte(x.nom) === normaliserTexte(nom) || normaliserTexte(x.nom) === normaliserTexte(texte));
  f ||= creerFournisseur(db, { nom, domaines: domaine ? [domaine] : [] });
  cache.set(texte, f.id);
  return f.id;
}

export function importerAchats(db, { texte, nom }) {
  const lignes = parserCsv(texte);
  if (!lignes.length) throw new ErreurMetier('Fichier vide.');
  const { map, debut } = reperer(lignes);
  const empreinte = empreinteTexte(texte);
  const dernier = db.prepare("SELECT nom, created_at, empreinte FROM imports WHERE type = 'sheets' ORDER BY id DESC LIMIT 1").get();
  if (dernier?.empreinte === empreinte) {
    throw new ErreurMetier(`Fichier identique au dernier import du Sheet (${dernier.nom}, ${dernier.created_at.slice(0, 10)}) : rien n’a changé.`, 409);
  }
  const taux = Number(lireParametre(db, 'achats.taux_taxes') ?? 14.975) / 100;
  const val = (l, champ) => (map[champ] === undefined ? '' : String(l[map[champ]] ?? '').trim());

  return transaction(db, () => {
    const imp = db
      .prepare("INSERT INTO imports (type, nom, mapping, entetes, nb_lignes, empreinte) VALUES ('sheets', ?, ?, '[]', ?, ?)")
      .run(nom || 'Google Sheet achats', JSON.stringify(map), lignes.length - debut, empreinte);
    const importId = Number(imp.lastInsertRowid);
    const r = { import_id: importId, creees: 0, mises_a_jour: 0, inchangees: 0, en_attente: 0, annulees: 0, a_verifier: [], rejets: [] };
    const fournisseurs = new Map();
    const occurrences = new Map();
    const parCle = db.prepare('SELECT * FROM factures WHERE cle_import = ?');

    // 1er passage : lignes valides et leur clé stable (ASIN, site, date, + rang si répétée).
    const achats = [];
    lignes.slice(debut).forEach((l, i) => {
      const n = i + debut + 1; // n° de ligne dans le Sheet
      const asin = normaliserAsin(val(l, 'asin'));
      if (!asin) return; // ligne vide, légende, totaux…
      const quantite = parserQuantite(val(l, 'quantite'));
      const total = parserMontant(val(l, 'total'));
      const date = parserDate(val(l, 'date'));
      if (!quantite) return void r.rejets.push({ ligne: n, asin, motif: 'quantité vide ou à 0 : ligne ignorée' });
      if (total === null) return void r.rejets.push({ ligne: n, asin, motif: `total illisible « ${val(l, 'total')} » : ligne ignorée` });
      if (total === 0) r.a_verifier.push({ ligne: n, asin, motif: 'total à 0 $' });
      if (!date) r.a_verifier.push({ ligne: n, asin, motif: 'date manquante ou illisible' });
      const statut = map.statut === undefined ? 'recu' : statutAchat(val(l, 'statut')) || 'recu';
      const base = ['sheet', asin, normaliserTexte(val(l, 'site')), date || ''].join('|');
      const rang = (occurrences.get(base) || 0) + 1;
      occurrences.set(base, rang);
      achats.push({ n, asin, quantite, total, date, statut, site: val(l, 'site'), cle: `${base}|${rang}` });
    });
    const clesDuFichier = new Set(achats.map((a) => a.cle));
    // Factures du Sheet dont la clé n'est plus dans le fichier : date ou site corrigé dans le Sheet ?
    const orphelines = db
      .prepare(
        `SELECT f.*, fl.quantite AS q, fl.asin AS a FROM factures f JOIN facture_lignes fl ON fl.facture_id = f.id
         WHERE f.cle_import LIKE 'sheet|%'`,
      )
      .all()
      .filter((f) => !clesDuFichier.has(f.cle_import));

    // 2e passage : création ou mise à jour.
    for (const a of achats) {
      const ht = arrondir(a.total / (1 + taux));
      const taxes = arrondir(a.total - ht);
      let existante = parCle.get(a.cle);
      if (!existante) {
        const k = orphelines.findIndex((f) => f.a === a.asin && f.q === a.quantite && f.total === a.total);
        if (k >= 0) {
          existante = orphelines.splice(k, 1)[0];
          db.prepare('UPDATE factures SET cle_import = ?, date_facture = ? WHERE id = ?').run(a.cle, a.date, existante.id);
          journaliser(db, 'facture', existante.id, 'maj_sheet', { cle_avant: existante.cle_import, cle: a.cle, date: a.date });
          r.mises_a_jour++;
          existante = { ...parCle.get(a.cle), deja_comptee: true };
        }
      }
      let id;
      if (!existante) {
        assurerProduit(db, a.asin);
        ({ id } = creerFacture(db, {
          fournisseur_id: fournisseurPour(db, a.site, fournisseurs),
          numero_facture: `Sheet ${a.asin}${a.date ? ` ${a.date}` : ''}`,
          date_facture: a.date,
          total: a.total,
          sous_total_ht: ht,
          taxes,
          notes: `Importée du Google Sheet d’achats (ligne ${a.n}, site « ${a.site} »).`,
          lignes: [{ asin: a.asin, quantite: a.quantite }],
        }));
        db.prepare('UPDATE factures SET cle_import = ? WHERE id = ?').run(a.cle, id);
        r.creees++;
      } else {
        id = existante.id;
        const ligneFacture = db.prepare('SELECT id, quantite FROM facture_lignes WHERE facture_id = ? AND asin = ?').get(id, a.asin);
        const statutActuel = existante.annulee ? 'annule' : existante.en_attente ? 'en_attente' : 'recu';
        if (existante.total !== a.total || ligneFacture?.quantite !== a.quantite || statutActuel !== a.statut) {
          db.prepare('UPDATE factures SET total = ?, sous_total_ht = ?, taxes = ? WHERE id = ?').run(a.total, ht, taxes, id);
          if (ligneFacture) db.prepare('UPDATE facture_lignes SET quantite = ? WHERE id = ?').run(a.quantite, ligneFacture.id);
          journaliser(db, 'facture', id, 'maj_sheet', {
            avant: { total: existante.total, quantite: ligneFacture?.quantite, statut: statutActuel },
            apres: { total: a.total, quantite: a.quantite, statut: a.statut },
          });
          if (!existante.deja_comptee) r.mises_a_jour++;
        } else if (!existante.deja_comptee) r.inchangees++;
        if (a.statut !== 'annule' && existante.annulee) retablirFacture(db, id);
      }
      // Statut : annulée (gardée dans l'historique), en attente du fournisseur ou reçue.
      if (a.statut === 'annule' && !db.prepare('SELECT annulee FROM factures WHERE id = ?').get(id).annulee) {
        annulerFacture(db, id, { motif: 'Annulée / remboursée (Google Sheet)' });
      }
      db.prepare('UPDATE factures SET en_attente = ? WHERE id = ?').run(a.statut === 'en_attente' ? 1 : 0, id);
      if (a.statut === 'en_attente') r.en_attente++;
      if (a.statut === 'annule') r.annulees++;
    }
    journaliser(db, 'import', importId, 'achats_sheet', { nom, creees: r.creees, mises_a_jour: r.mises_a_jour, rejets: r.rejets.length });
    return r;
  });
}

/** Marque une facture reçue (ou de nouveau en attente) du fournisseur. */
export function marquerRecue(db, id, recue = true) {
  const f = db.prepare('SELECT id FROM factures WHERE id = ?').get(id);
  if (!f) throw new ErreurMetier('Facture introuvable.', 404);
  db.prepare('UPDATE factures SET en_attente = ? WHERE id = ?').run(recue ? 0 : 1, id);
  journaliser(db, 'facture', id, recue ? 'recue' : 'en_attente');
  return { id, en_attente: !recue };
}
