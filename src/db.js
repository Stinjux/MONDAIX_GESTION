// Base SQLite (module natif node:sqlite) et schéma.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { cheminBase } from './env.js';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS parametres (
  cle TEXT PRIMARY KEY,
  valeur TEXT
);

CREATE TABLE IF NOT EXISTS fournisseurs (
  id INTEGER PRIMARY KEY,
  nom TEXT NOT NULL,
  domaines TEXT NOT NULL DEFAULT '[]',        -- JSON : domaines web et email du fournisseur
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Catalogue des ASIN. Le coût retenu pointe vers une entrée de l'historique des coûts.
CREATE TABLE IF NOT EXISTS produits (
  asin TEXT PRIMARY KEY,
  titre TEXT,
  sku TEXT,
  quantite_inventaire INTEGER,
  cout_retenu_id INTEGER REFERENCES couts_achat(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Historique des coûts d'achat unitaires HT (jamais écrasé).
-- Coût d'achat seul : sans livraison, préparation ni transport vers Amazon.
CREATE TABLE IF NOT EXISTS couts_achat (
  id INTEGER PRIMARY KEY,
  asin TEXT NOT NULL REFERENCES produits(asin),
  montant_unitaire_ht REAL NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('inventaire', 'commande', 'facture', 'manuel')),
  reference TEXT,
  import_id INTEGER REFERENCES imports(id),
  commande_id INTEGER REFERENCES commandes(id) ON DELETE SET NULL,
  facture_id INTEGER REFERENCES factures(id) ON DELETE SET NULL,
  ecart_traite INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('sheets', 'inventaire')),
  nom TEXT,
  mapping TEXT NOT NULL,                       -- JSON : champ → nom de colonne
  entetes TEXT NOT NULL,                       -- JSON
  nb_lignes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Lignes du Google Sheets en attente de rapprochement avec une commande.
CREATE TABLE IF NOT EXISTS lignes_import (
  id INTEGER PRIMARY KEY,
  import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  numero_ligne INTEGER NOT NULL,
  asin TEXT,
  lien_original TEXT,                          -- domaine ou page produit, conservé tel quel
  domaine TEXT,
  quantite INTEGER,
  total_commande_declare REAL,                 -- total de la COMMANDE, pas de la ligne
  total_brut TEXT,
  numero_commande TEXT,
  date_commande TEXT,
  fournisseur_propose_id INTEGER REFERENCES fournisseurs(id) ON DELETE SET NULL,
  fournisseur_propose_nom TEXT,                -- nom suggéré si aucun fournisseur connu
  fournisseur_valide_id INTEGER REFERENCES fournisseurs(id) ON DELETE SET NULL,
  statut TEXT NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('en_attente', 'rattachee', 'ignoree')),
  commande_id INTEGER REFERENCES commandes(id) ON DELETE SET NULL,
  commande_ligne_id INTEGER REFERENCES commande_lignes(id) ON DELETE SET NULL,
  doublon_de_id INTEGER REFERENCES lignes_import(id) ON DELETE SET NULL,
  anomalies TEXT NOT NULL DEFAULT '[]',
  donnees_brutes TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commandes (
  id INTEGER PRIMARY KEY,
  fournisseur_id INTEGER REFERENCES fournisseurs(id),
  numero_commande TEXT,
  date_commande TEXT,
  lien_original TEXT,
  total_declare REAL,                          -- montant global déclaré (Sheets ou saisie)
  total_inclut_taxes INTEGER,                  -- 1 oui / 0 non / NULL inconnu
  total_inclut_livraison INTEGER,              -- 1 oui / 0 non / NULL inconnu
  source TEXT NOT NULL DEFAULT 'manuel' CHECK (source IN ('sheets', 'manuel', 'gmail')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commande_lignes (
  id INTEGER PRIMARY KEY,
  commande_id INTEGER NOT NULL REFERENCES commandes(id) ON DELETE CASCADE,
  asin TEXT NOT NULL REFERENCES produits(asin),
  quantite INTEGER NOT NULL,
  cout_unitaire_ht REAL                        -- NULL tant qu'il n'est pas connu
);

CREATE TABLE IF NOT EXISTS factures (
  id INTEGER PRIMARY KEY,
  commande_id INTEGER REFERENCES commandes(id) ON DELETE SET NULL,
  fournisseur_id INTEGER REFERENCES fournisseurs(id),
  numero_facture TEXT,
  numero_commande_ref TEXT,
  date_facture TEXT,
  sous_total_ht REAL,
  taxes REAL,
  livraison REAL,
  autres_frais REAL,
  total REAL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS facture_lignes (
  id INTEGER PRIMARY KEY,
  facture_id INTEGER NOT NULL REFERENCES factures(id) ON DELETE CASCADE,
  asin TEXT NOT NULL REFERENCES produits(asin),
  quantite INTEGER NOT NULL,
  prix_unitaire_ht REAL
);

-- Emails reçus. Chaque source est rattachée à un seul module :
-- gmail → commandes fournisseurs ; neo → dossiers d'autorisation.
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('gmail', 'neo')),
  module TEXT NOT NULL CHECK (module IN ('commandes', 'autorisations')),
  message_id TEXT,
  expediteur TEXT,
  sujet TEXT,
  date_reception TEXT,
  corps TEXT,
  references_extraites TEXT NOT NULL DEFAULT '{}',
  propositions TEXT NOT NULL DEFAULT '[]',
  commande_id INTEGER REFERENCES commandes(id) ON DELETE SET NULL,
  dossier_id INTEGER REFERENCES dossiers_autorisation(id) ON DELETE SET NULL,
  statut_rapprochement TEXT NOT NULL DEFAULT 'non_rapproche'
    CHECK (statut_rapprochement IN ('non_rapproche', 'propose', 'ambigu', 'valide', 'ignore')),
  mode_rapprochement TEXT,                     -- auto (référence exacte unique) ou manuel
  mode_saisie TEXT NOT NULL DEFAULT 'manuel',  -- eml, manuel, webhook, imap
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source, message_id),
  CHECK ((source = 'gmail' AND module = 'commandes') OR (source = 'neo' AND module = 'autorisations')),
  CHECK (source = 'gmail' OR commande_id IS NULL),
  CHECK (source = 'neo' OR dossier_id IS NULL)
);

-- Liens libres entre un email (Gmail ou Neo) et un ASIN ou un numéro de cas Amazon.
CREATE TABLE IF NOT EXISTS email_liens (
  id INTEGER PRIMARY KEY,
  email_id INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('asin', 'cas')),
  valeur TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'manuel' CHECK (mode IN ('auto', 'manuel')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (email_id, type, valeur)
);

CREATE TABLE IF NOT EXISTS receptions (
  id INTEGER PRIMARY KEY,
  commande_id INTEGER NOT NULL REFERENCES commandes(id) ON DELETE CASCADE,
  date_reception TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reception_lignes (
  id INTEGER PRIMARY KEY,
  reception_id INTEGER NOT NULL REFERENCES receptions(id) ON DELETE CASCADE,
  asin TEXT NOT NULL REFERENCES produits(asin),
  quantite INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS envois (
  id INTEGER PRIMARY KEY,
  numero_envoi TEXT,                           -- ex. FBA15XXXXXXX
  date_envoi TEXT,
  statut TEXT NOT NULL DEFAULT 'en_preparation'
    CHECK (statut IN ('en_preparation', 'expedie', 'recu_amazon', 'cloture')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS envoi_lignes (
  id INTEGER PRIMARY KEY,
  envoi_id INTEGER NOT NULL REFERENCES envois(id) ON DELETE CASCADE,
  asin TEXT NOT NULL REFERENCES produits(asin),
  quantite INTEGER NOT NULL,
  commande_id INTEGER REFERENCES commandes(id) ON DELETE SET NULL
);

-- Dépenses effectivement enregistrées : base du coût complet.
CREATE TABLE IF NOT EXISTS depenses (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('livraison_fournisseur', 'taxes', 'preparation', 'transport_amazon', 'autre')),
  montant REAL NOT NULL,
  date_depense TEXT,
  commande_id INTEGER REFERENCES commandes(id) ON DELETE CASCADE,
  envoi_id INTEGER REFERENCES envois(id) ON DELETE CASCADE,
  asin TEXT REFERENCES produits(asin),
  quantite_concernee INTEGER,                  -- pour une dépense rattachée directement à un ASIN
  facture_id INTEGER REFERENCES factures(id) ON DELETE CASCADE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((commande_id IS NOT NULL) + (envoi_id IS NOT NULL) + (asin IS NOT NULL) <= 1)
);

CREATE TABLE IF NOT EXISTS dossiers_autorisation (
  id INTEGER PRIMARY KEY,
  asin TEXT NOT NULL REFERENCES produits(asin),
  statut TEXT NOT NULL DEFAULT 'a_demander'
    CHECK (statut IN ('a_demander', 'demande_envoyee', 'documents_requis', 'approuve', 'refuse')),
  statut_confirme INTEGER NOT NULL DEFAULT 0,  -- 1 : confirmé par une réponse Neo validée
  numero_cas TEXT,
  date_demande TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY,
  entite TEXT NOT NULL,
  entite_id TEXT,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lignes_import_statut ON lignes_import(statut);
CREATE INDEX IF NOT EXISTS idx_commande_lignes_commande ON commande_lignes(commande_id);
CREATE INDEX IF NOT EXISTS idx_couts_asin ON couts_achat(asin);
CREATE INDEX IF NOT EXISTS idx_emails_source ON emails(source, statut_rapprochement);
CREATE INDEX IF NOT EXISTS idx_dossiers_asin ON dossiers_autorisation(asin);
CREATE INDEX IF NOT EXISTS idx_email_liens_valeur ON email_liens(type, valeur);
`;

const PARAMETRES_DEFAUT = {
  'email.webhook_token': '',
  'couts.inclure_taxes': '0',
  'rapprochement.tolerance': '0.02',
  'amazon.domaine': 'www.amazon.ca',
};

export function ouvrirBase(chemin = cheminBase()) {
  if (chemin !== ':memory:') mkdirSync(dirname(chemin), { recursive: true });
  const db = new DatabaseSync(chemin);
  // Le site et la tâche planifiée de synchronisation peuvent écrire en même temps.
  db.exec('PRAGMA busy_timeout = 10000;');
  if (chemin !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const inserer = db.prepare('INSERT OR IGNORE INTO parametres (cle, valeur) VALUES (?, ?)');
  for (const [cle, valeur] of Object.entries(PARAMETRES_DEFAUT)) inserer.run(cle, valeur);
  return db;
}

const profondeurs = new WeakMap();

/** Exécute fn dans une transaction (imbrication gérée par points de sauvegarde). */
export function transaction(db, fn) {
  const profondeur = profondeurs.get(db) || 0;
  const nom = `sp${profondeur}`;
  db.exec(profondeur === 0 ? 'BEGIN' : `SAVEPOINT ${nom}`);
  profondeurs.set(db, profondeur + 1);
  try {
    const r = fn();
    db.exec(profondeur === 0 ? 'COMMIT' : `RELEASE ${nom}`);
    return r;
  } catch (e) {
    db.exec(profondeur === 0 ? 'ROLLBACK' : `ROLLBACK TO ${nom}; RELEASE ${nom}`);
    throw e;
  } finally {
    profondeurs.set(db, profondeur);
  }
}

export function journaliser(db, entite, entiteId, action, details = null) {
  db.prepare('INSERT INTO journal (entite, entite_id, action, details) VALUES (?, ?, ?, ?)').run(
    entite,
    entiteId == null ? null : String(entiteId),
    action,
    details == null ? null : JSON.stringify(details),
  );
}

export function lireParametre(db, cle) {
  const r = db.prepare('SELECT valeur FROM parametres WHERE cle = ?').get(cle);
  return r ? r.valeur : null;
}

export function ecrireParametre(db, cle, valeur) {
  db.prepare('INSERT INTO parametres (cle, valeur) VALUES (?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur').run(cle, valeur);
}

/** S'assure que l'ASIN existe dans le catalogue. */
export function assurerProduit(db, asin) {
  db.prepare('INSERT OR IGNORE INTO produits (asin) VALUES (?)').run(asin);
}

export class ErreurMetier extends Error {
  constructor(message, statut = 400) {
    super(message);
    this.statut = statut;
  }
}
