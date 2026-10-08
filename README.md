# Mondaix Gestion

Suivi des achats fournisseurs, des coûts, des envois Amazon et des demandes d’autorisation de vente Amazon.

## Démarrage

Prérequis : Node.js 22.13 ou plus récent (SQLite intégré à Node). Dépendances : `imapflow` (lecture IMAP) et `@anthropic-ai/sdk` (extraction des factures).

```bash
npm install
cp .env.example .env   # puis compléter
npm start              # http://127.0.0.1:3000
npm run synchro        # synchronisation email ponctuelle (Gmail + Neo)
npm test               # tests des règles métier
```

La configuration se fait par variables d'environnement, ou par un fichier `.env` lu au démarrage
(voir `.env.example`) : `PORT`, `HOST`, `MONDAIX_DB`, `MONDAIX_UTILISATEUR`, `MONDAIX_MOT_DE_PASSE`,
`MONDAIX_WEBHOOK_TOKEN`, et les variables `GMAIL_*`, `NEO_*`, `EMAIL_*` de la synchronisation.

## Hébergement

Guide pas à pas pour **Railway** (hébergement retenu) : [docs/HEBERGEMENT-RAILWAY.md](docs/HEBERGEMENT-RAILWAY.md).
Alternative cPanel : [docs/HEBERGEMENT-HOSTMETRO.md](docs/HEBERGEMENT-HOSTMETRO.md).

- Exposée sur Internet (`HOST` autre que `127.0.0.1`), l'application **refuse de démarrer sans
  `MONDAIX_MOT_DE_PASSE`**. L'accès est alors protégé par identifiant / mot de passe (authentification HTTP Basic),
  avec blocage temporaire après 20 échecs en 15 minutes. Servir l'application en **HTTPS** (fourni par l'hébergeur ou un proxy).
- Routes publiques : `GET /sante` (contrôle de santé) et le webhook email (protégé par son propre jeton).
- La base SQLite doit être sur un **disque persistant** (`MONDAIX_DB`, volume `/app/data` dans le conteneur).
  Sur Railway, l'application refuse de démarrer si la base n'est pas sur le volume attaché.
- Un `Dockerfile` est fourni : `docker build -t mondaix .` puis
  `docker run -p 3000:3000 -v mondaix-data:/app/data --env-file .env mondaix`.
- La synchronisation email tourne dans le serveur toutes les `EMAIL_SYNCHRO_MINUTES` minutes (10 par défaut).
  Sur un hébergement qui met l'application en veille (cPanel / Passenger), mettre `EMAIL_SYNCHRO_MINUTES=0`
  et planifier `node src/synchro.js` (cron).
- Point d'entrée unique : `app.cjs` (npm start, Docker, cPanel « Setup Node.js App »). Sous Passenger ou avec
  `NODE_ENV=production`, l'application est considérée comme exposée et exige le mot de passe.


## Règles appliquées

### 1. Sources email

| Boîte | Contenu | Module alimenté |
|-------|---------|-----------------|
| Gmail | Confirmations de commandes fournisseurs | Commandes fournisseurs |
| Neo   | Réponses aux demandes d’autorisation de vente Amazon | Dossiers d’autorisation |

- Un email Gmail ne peut être rattaché qu’à une commande, une réponse Neo qu’à un dossier.
  Cette règle est vérifiée par l’application **et** par des contraintes de la base.
- **Connexion IMAP en lecture seule** (dossiers ouverts en lecture seule : rien n’est supprimé, déplacé ni marqué comme lu) :
  - Gmail : messages dont l’**objet contient « order » ou « shopping »** (début de mot, majuscules indifférentes),
    dans « Tous les messages » pour inclure les emails archivés. Connexion par mot de passe d’application Google.
  - Neo : messages **envoyés par amazon.com ou amazon.ca** (sous-domaines compris) dont l’**objet contient « brand approval »**.
  - Uniquement les emails reçus **depuis le 1er août 2026** (`EMAIL_DATE_DEPART`), puis de façon incrémentale.
  - Filtres modifiables par variables d’environnement (`*_MOTS_CLES_OBJET`, `*_EXPEDITEURS`, `*_DOSSIER`).
  - État, filtres actifs, dernière synchronisation et erreurs visibles dans Paramètres ; bouton « Synchroniser maintenant ».
- Sans connexion, tout reste utilisable : import de fichiers `.eml`, copier-coller ou saisie manuelle.
  Les imports CSV et la saisie manuelle des commandes fonctionnent indépendamment des emails.
- Réception par webhook (alternative) : `POST /api/emails/{gmail|neo}/webhook` avec l’en-tête
  `X-Mondaix-Token` et un corps JSON `{ message_id, from, subject, date, text }` ou `{ raw }` (source .eml).
  À brancher sur un script Gmail (Apps Script), une règle de transfert, n8n, etc.

### 2. Champ « cost » du fichier d’inventaire

- `cost` = **prix d’achat unitaire hors taxes**, sans livraison, préparation ni transport vers Amazon.
- Il est conservé tel quel dans l’historique des coûts (source « Fichier d’inventaire »).
- Le **coût complet** est calculé séparément à partir des dépenses effectivement enregistrées :
  - frais d’une commande (livraison, autres frais, et taxes si l’option est activée) répartis au prorata des quantités de la commande ;
  - frais d’un envoi Amazon (préparation, transport) répartis au prorata des unités de l’envoi ;
  - dépenses rattachées directement à un ASIN, divisées par le nombre d’unités concernées.
- Si une commande ou une facture indique un autre coût unitaire, il est ajouté à l’historique,
  l’écart est signalé (tableau de bord, fiche ASIN) et **le coût retenu n’est pas modifié** :
  c’est à l’utilisateur de choisir la valeur à retenir. Toute modification est journalisée.

### 3. Import du Google Sheets existant

Colonnes reconnues automatiquement (association modifiable dans l’aperçu) : ASIN, site de commande,
quantité achetée, prix total de la commande ; et, si présents, n° de commande et date.
Sources acceptées : fichier CSV/TSV exporté, copier-coller des cellules, lien d’une feuille partagée.

- Le prix total est celui de la **commande** : il n’est jamais réparti ni répété comme dépense par ASIN.
- **Aucun regroupement automatique** : même site ou même montant ne suffit pas.
- Chaque ligne importée est enregistrée **en attente de rapprochement**, avec ses données brutes.
- Outils de l’aperçu : sélection des lignes d’une même commande → « Regrouper en une commande »
  (n° de commande, date, fournisseur, total déclaré, composition), « Une commande par ligne »,
  « Rattacher à une commande existante », « Valider le fournisseur », « Ignorer », « Corriger », « Détacher ».
- Si les lignes sélectionnées portent des totaux différents, le total de la commande doit être choisi explicitement ;
  les montants ne sont jamais additionnés.
- Pour chaque commande : **total déclaré** + composition (inclut les taxes ? la livraison ? oui / non / inconnu).
  Tant que la composition est inconnue, le total est affiché tel quel, sans ventilation.
- À la saisie de la facture, le total déclaré est **comparé** au détail (sous-total HT, taxes, livraison, autres frais) :
  écart signalé ; si la composition est inconnue, l’application indique quelle combinaison correspond et propose de la confirmer.
  Le total déclaré n’est jamais ajouté aux coûts détaillés.
- Le lien fournisseur (domaine ou page produit) est conservé tel quel ; le fournisseur correspondant est seulement **proposé**
  (domaine connu → fournisseur existant, sinon nom suggéré) et doit être validé manuellement.
- Un réimport signale les lignes identiques déjà importées (« doublon possible ») sans les écarter silencieusement.

### Factures déposées (PDF, JPEG, PNG)

- Page **Factures** : déposez un ou plusieurs fichiers (glisser-déposer). Le fichier est conservé (sur le volume,
  à côté de la base) et un même fichier n'est enregistré qu'une fois.
- Si `ANTHROPIC_API_KEY` est définie, les données sont extraites par l'API Claude (sortie JSON contrainte) :
  fournisseur, n° de facture, n° de commande, date, sous-total HT, taxes, livraison, total et articles.
  Sans clé, la facture s'affiche à côté du formulaire pour une saisie manuelle.
- Écran de vérification : aperçu du document et, pour chaque article, un **ASIN proposé** (ASIN écrit sur la
  facture, commande portant le même n° de commande, titre ressemblant) — toujours modifiable. Un article = un ASIN ;
  un article sans ASIN n'est pas enregistré. **Aucune commande n'est demandée** : la facture est enregistrée seule.
- À l'enregistrement : facture créée avec ses lignes par ASIN (coûts unitaires ajoutés à l'historique sans écraser
  le coût retenu). Le document reste consultable depuis la liste des factures et la fiche ASIN. Les factures déjà
  rattachées à une commande auparavant le restent.

### 4. Rapprochement

- Chaîne achats : ligne Google Sheets → commande fournisseur → confirmation Gmail → facture → réception → envoi Amazon
  (visible sur chaque commande).
- Chaîne autorisations : ASIN → dossier d’autorisation → n° de cas Amazon → réponse Neo.
- Rapprochement automatique **uniquement** sur une référence exacte et unique (n° de commande pour Gmail et les factures,
  n° de cas pour Neo). Sinon des propositions sont faites (fournisseur de l’expéditeur, montant, date, ASIN cité…)
  et doivent être validées ; plusieurs candidates = « ambigu ».
- Le statut détecté dans une réponse Neo (approuvé, refusé, documents requis) n’est appliqué au dossier qu’après validation ;
  un statut final appuyé par une réponse validée devient « confirmé ».
- Le tableau de bord liste : commandes sans facture, lignes Sheets sans commande identifiée, ASIN sans statut d’autorisation confirmé,
  emails à rapprocher, totaux déclarés à vérifier, écarts de coût, factures et lignes d’envoi non rattachées.

## Organisation du code

```
src/
  server.js              API JSON + fichiers statiques, protection par mot de passe
  synchro.js             synchronisation email en ligne de commande
  db.js                  schéma SQLite, transactions, journal
  lib/                   lecture CSV, montants/dates/ASIN/domaines, emails .eml, mapping des colonnes
  services/
    importSheets.js      import Google Sheets, regroupement manuel, propositions
    inventaire.js        import du fichier d’inventaire (cost)
    couts.js             historique des coûts, dépenses, coût complet
    commandes.js         commandes, factures, comparaison du total déclaré, réceptions, chaîne
    envois.js            envois Amazon
    autorisations.js     dossiers d’autorisation
    emails.js            sources Gmail / Neo, rapprochement
    synchroEmail.js      synchronisation IMAP (filtres, incrémental, lecture seule)
    documentsFactures.js factures déposées : fichier, extraction (API Claude), propositions, validation
    asins.js             liste et fiche ASIN (historique complet)
    statistiques.js      indicateurs du tableau de bord par période
    tableauDeBord.js     éléments à rapprocher
public/                  interface web (HTML/CSS/JS sans framework)
test/                    tests node:test
```
