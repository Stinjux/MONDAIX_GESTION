# Mise en ligne sur Railway

Railway construit l'application à partir du `Dockerfile` du dépôt GitHub et la garde en marche
en continu : la synchronisation email tourne dans le serveur (toutes les 10 minutes par défaut),
sans tâche cron. Les données SQLite sont stockées sur un **volume persistant**.

Offre conseillée : **Hobby** (volume de 5 Go, largement suffisant).

## 1. Créer le service depuis GitHub

1. Sur railway.com : **New Project › Deploy from GitHub repo** › `Stinjux/MONDAIX_GESTION`.
2. Dans le service : **Settings › Source › Branch** : choisissez la branche à déployer
   (`claude/sweet-planck-mo2qqk`, ou `main` si vous l'avez créée).
3. Railway détecte le `Dockerfile` automatiquement : rien à configurer pour la construction.

Le premier déploiement **échoue volontairement** tant que les étapes 2 et 3 ne sont pas faites :
l'application refuse de démarrer sans volume et sans mot de passe (message clair dans les *Deploy Logs*).

## 2. Ajouter le volume (indispensable)

- Clic droit sur le canevas du projet (ou `⌘K` / `Ctrl+K`) › **Volume** › rattachez-le au service.
- **Mount path : `/app/data`**

Sans volume, toutes les données seraient effacées à chaque redéploiement.

## 3. Variables d'environnement

Service › **Variables** › **Raw Editor**, collez puis complétez :

```
MONDAIX_MOT_DE_PASSE=
MONDAIX_UTILISATEUR=admin
EMAIL_DATE_DEPART=2026-08-01
EMAIL_SYNCHRO_MINUTES=10
GMAIL_UTILISATEUR=
GMAIL_MOT_DE_PASSE=
NEO_UTILISATEUR=
NEO_MOT_DE_PASSE=
NEO_IMAP_HOTE=
```

- `MONDAIX_MOT_DE_PASSE` : mot de passe long, pour accéder à l'application.
- `GMAIL_MOT_DE_PASSE` : **mot de passe d'application** Google (myaccount.google.com/apppasswords,
  validation en deux étapes requise), pas le mot de passe du compte.
- `NEO_IMAP_HOTE` : serveur IMAP indiqué dans les réglages Neo.
- Ne définissez pas `PORT` ni `HOST` : Railway et le Dockerfile s'en chargent.

Les filtres par défaut s'appliquent (Gmail : objet contenant « order » ou « shopping » ;
Neo : expéditeur amazon.com / amazon.ca et objet contenant « brand approval »). Ils se modifient avec
`GMAIL_MOTS_CLES_OBJET`, `NEO_MOTS_CLES_OBJET`, `NEO_EXPEDITEURS` (voir `.env.example`).

Enregistrez : Railway redéploie.

## 4. Adresse publique et contrôle de santé

- **Settings › Networking › Generate Domain** : Railway propose le port écouté par l'application
  (celui affiché dans les logs « Mondaix Gestion : http://0.0.0.0:… »). HTTPS est fourni automatiquement.
- **Settings › Deploy › Healthcheck Path** : `/sante`

Ouvrez l'adresse générée : le navigateur demande l'identifiant (`admin`) et le mot de passe.

## 5. Vérifier la connexion email

Menu **Paramètres & sources** : chaque boîte doit afficher « connectée » après la première synchronisation
(15 secondes après le démarrage, puis toutes les 10 minutes), ou cliquez sur **Synchroniser maintenant**.
En cas d'erreur, le message s'affiche sur la carte de la boîte (identifiants refusés, serveur introuvable…).

## Mises à jour et sauvegardes

- Chaque push sur la branche suivie redéploie automatiquement. Avec un volume, le redéploiement
  entraîne une courte interruption (quelques secondes) : c'est normal.
- Les données sont dans `/app/data` (fichiers `mondaix.sqlite`, `-wal`, `-shm`). Activez les sauvegardes
  du volume dans ses réglages Railway si votre offre le permet.
