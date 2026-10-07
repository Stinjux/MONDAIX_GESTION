# Mondaix Gestion

Suivi des achats fournisseurs, des coûts, des envois Amazon et des demandes d’autorisation de vente Amazon.

## Démarrage

Prérequis : Node.js 22.5 ou plus récent. Aucune dépendance à installer (SQLite intégré à Node).

```bash
npm start          # http://127.0.0.1:3000
npm test           # tests des règles métier
```

Variables facultatives : `PORT`, `HOST`, `MONDAIX_DB` (chemin de la base, défaut `data/mondaix.sqlite`),
`MONDAIX_WEBHOOK_TOKEN` (jeton du webhook email si non défini dans les paramètres).

## Règles appliquées

### 1. Sources email

| Boîte | Contenu | Module alimenté |
|-------|---------|-----------------|
| Gmail | Confirmations de commandes fournisseurs | Commandes fournisseurs |
| Neo   | Réponses aux demandes d’autorisation de vente Amazon | Dossiers d’autorisation |

- Un email Gmail ne peut être rattaché qu’à une commande, une réponse Neo qu’à un dossier.
  Cette règle est vérifiée par l’application **et** par des contraintes de la base.
- Aucune connexion n’est requise : import de fichiers `.eml`, copier-coller ou saisie manuelle.
  Les imports CSV et la saisie manuelle des commandes fonctionnent indépendamment des emails.
- Réception automatique facultative : `POST /api/emails/{gmail|neo}/webhook` avec l’en-tête
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
  server.js              API JSON + fichiers statiques
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
    tableauDeBord.js     éléments à rapprocher
public/                  interface web (HTML/CSS/JS sans framework)
test/                    tests node:test
```
