# Mondaix Gestion

Suivi des achats (factures), des coûts, des envois Amazon et des demandes d’autorisation de vente Amazon.

Parcours : **facture** (déposée, articles associés aux ASIN avec le coût unitaire HT et la date) →
**envoi Amazon** (ASIN et quantités envoyées, n° et date d’expédition) → **réception par Amazon** (quantités reçues, écarts) →
**stock Amazon** (import du fichier d’inventaire dans la section ASIN).

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

| Boîte | Contenu |
|-------|---------|
| Gmail | Confirmations des fournisseurs (achats) |
| Neo   | Réponses aux demandes d’autorisation de vente Amazon |

- Chaque email (Gmail ou Neo) s’associe **directement à un ou plusieurs ASIN** : automatiquement quand un seul ASIN
  est cité, sinon à la main. Le statut lu dans une réponse Neo (approuvé, refusé, documents requis) n’est appliqué à
  l’autorisation des ASIN associés qu’après validation ; un statut final devient « confirmé ».
- **Connexion IMAP en lecture seule** (dossiers ouverts en lecture seule : rien n’est supprimé, déplacé ni marqué comme lu) :
  - Gmail : messages dont l’**objet contient « order » ou « shopping »** (début de mot, majuscules indifférentes),
    dans « Tous les messages » pour inclure les emails archivés. Connexion par mot de passe d’application Google.
  - Neo : messages **envoyés par amazon.com ou amazon.ca** (sous-domaines compris) dont l’**objet contient « brand approval »**.
  - Uniquement les emails reçus **depuis le 1er août 2026** (`EMAIL_DATE_DEPART`), puis de façon incrémentale.
  - Filtres modifiables par variables d’environnement (`*_MOTS_CLES_OBJET`, `*_EXPEDITEURS`, `*_DOSSIER`).
  - État, filtres actifs, dernière synchronisation et erreurs visibles dans Paramètres ; bouton « Synchroniser maintenant ».
- Sans connexion, tout reste utilisable : import de fichiers `.eml`, copier-coller ou saisie manuelle.
- Réception par webhook (alternative) : `POST /api/emails/{gmail|neo}/webhook` avec l’en-tête
  `X-Mondaix-Token` et un corps JSON `{ message_id, from, subject, date, text }` ou `{ raw }` (source .eml).

### 2. Factures (PDF, JPEG, PNG)

- Page **Factures** : déposez un ou plusieurs fichiers (glisser-déposer). Le fichier est conservé (sur le volume,
  à côté de la base) et un même fichier n'est enregistré qu'une fois.
- Si `ANTHROPIC_API_KEY` est définie, les données sont extraites par l'API Claude (sortie JSON contrainte) :
  fournisseur, n° de facture, date, sous-total HT, taxes, livraison, total et articles.
  Sans clé, la facture s'affiche à côté du formulaire pour une saisie manuelle.
- Pour chaque article, un **ASIN est proposé** (écrit sur la facture, sinon titre ressemblant), toujours modifiable,
  avec la quantité et le **coût unitaire HT**. Un article sans ASIN n'est pas enregistré.
- Les ASIN d’une facture déjà enregistrée se modifient depuis la page Factures ou la fiche ASIN (« Lier une facture »).
- **Annuler** (fournisseur qui annule et rembourse) : la facture reste dans l’historique (page Factures, fiche ASIN),
  mais ne compte plus dans les dépenses, les unités achetées ni le coût complet. « Rétablir » la fait recompter.
- Dépense d’un ASIN = sa part de chaque facture (taxes, livraison et frais compris), au prorata du montant HT de ses articles.

### 3. Coûts

- `cost` du fichier d’inventaire et prix unitaires des factures = **prix d’achat unitaire hors taxes**.
- Un nouveau prix est ajouté à l’historique ; un écart avec le coût retenu est signalé (tableau de bord, fiche ASIN)
  et **le coût retenu n’est pas modifié** : c’est à l’utilisateur de choisir la valeur à retenir. Tout est journalisé.
- **Coût complet** = coût d’achat retenu + frais des factures (livraison, autres frais, taxes si l’option est activée)
  au prorata de la part de l’ASIN + frais d’envoi Amazon au prorata des unités + dépenses rattachées à l’ASIN.
- **COGS** (tableau de bord, page COGS) = unités vendues × coût d’achat HT retenu.
  - Unités vendues = **rapport de commandes Amazon** (Seller Central › Rapports › Commandes › Toutes les commandes),
    importé sur la page COGS. Une ligne par article (order-item-id) : réimporter une période la met à jour sans doublon ;
    les commandes annulées ne comptent pas ; date = jour de la commande à l’heure de l’Est.
  - Avant le premier jour couvert par un rapport : unités estimées entre deux imports d’inventaire
    (stock précédent + unités expédiées à Amazon entre les deux − stock actuel).
  - Chiffre d’affaires = item-price (hors taxes) ; marge avant frais Amazon = chiffre d’affaires − COGS.

### Stock

- Chaque import du fichier d’inventaire Amazon est une **photo complète** qui remplace la précédente ; seule la
  **variation** avec l’import précédent compte : 10 → 10 = 10 (inchangé) ; 10 → 8 = 2 ventes (−2) ;
  10 → 15 = restock de 5 (envoi arrivé chez Amazon). Un envoi enregistré expédié entre deux imports explique une hausse ;
  une hausse sans envoi enregistré est un « restock non saisi ».
- Le **premier import est le stock initial** : aucune vente n’est comptée avant lui.
- Les offres expédiées par le vendeur (colonne fulfillment_type = mf) ne comptent pas dans le stock Amazon.
- **Stock total** = chez Amazon (dernier import) + en transit (envois expédiés depuis le dernier import)
  + à envoyer (unités des factures non annulées − stock initial − restocks − en transit ; jamais négatif).
  Chaque unité n’est comptée qu’une fois.
- Si le stock chez Amazon dépasse les unités achetées, l’ASIN est signalé « Amazon > acheté » (facture manquante).
- Un import fait par erreur se **supprime** (page Stocks, « Imports d’inventaire Amazon ») ; « Réinitialiser
  l’inventaire » supprime tous les imports (factures, envois et dépenses conservés). Le contenu supprimé reste au Journal.
- Les états En stock / Stock bas / Rupture et Actif / Inactif suivent le stock total.

### 4. Envois Amazon et réception

- Envoi : ASIN glissés-déposés avec les quantités envoyées, n° et date d’expédition saisis à la main.
- Réception : quantité reçue par Amazon pour chaque ligne (ou « Tout est arrivé »). Suivi : en transit
  (réception à vérifier), réception partielle, tout reçu, écart. Quand toutes les lignes sont saisies, l’envoi passe
  à « Reçu par Amazon ».
- Le tableau de bord signale les envois en transit à vérifier, les envois reçus avec un écart, les factures sans ASIN,
  les écarts de coût, les ASIN sans autorisation confirmée et les emails à associer.

### Données des versions précédentes

Les anciennes commandes et lignes Google Sheets restent dans la base mais ne sont plus affichées ni comptées.
Les confirmations Gmail rattachées à une commande ont été associées aux ASIN de cette commande.

## Organisation du code

```
src/
  server.js              API JSON + fichiers statiques, protection par mot de passe
  synchro.js             synchronisation email en ligne de commande
  db.js                  schéma SQLite, transactions, journal
  lib/                   lecture CSV, montants/dates/ASIN/domaines, emails .eml, mapping des colonnes
  services/
    inventaire.js        import du fichier d’inventaire (cost)
    couts.js             historique des coûts, dépenses, coût complet
    factures.js          factures, articles par ASIN, part de chaque ASIN, annulation
    envois.js            envois Amazon, réception par Amazon et écarts
    autorisations.js     dossiers d’autorisation
    emails.js            sources Gmail / Neo, association aux ASIN
    synchroEmail.js      synchronisation IMAP (filtres, incrémental, lecture seule)
    documentsFactures.js factures déposées : fichier, extraction (API Claude), propositions, validation
    asins.js             liste et fiche ASIN (historique complet)
    statistiques.js      indicateurs du tableau de bord par période
    tableauDeBord.js     éléments à vérifier
public/                  interface web (HTML/CSS/JS sans framework)
test/                    tests node:test
```
