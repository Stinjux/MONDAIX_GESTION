# Mise en ligne sur HostMetro (cPanel)

HostMetro propose de l'hébergement mutualisé avec cPanel. Son site ne mentionne pas Node.js :
**commencez par l'étape 0**, sinon le reste ne s'applique pas.

## 0. Vérifier que l'offre convient (5 minutes)

Dans cPanel, cherchez **« Setup Node.js App »** (section *Logiciels / Software*).

| Ce que vous voyez | Conséquence |
|---|---|
| L'outil existe et propose **Node.js 22.13 ou plus récent** (22.x récent, 24…) | Parfait, suivez ce guide. |
| L'outil existe mais s'arrête à Node 20 ou moins | L'application ne peut pas tourner (elle utilise la base SQLite intégrée à Node 22.13+). Demandez au support s'ils peuvent ajouter Node 22. |
| L'outil n'existe pas | Votre offre n'exécute pas Node.js. Demandez au support ; sinon il faudra un autre hébergement. |

À vérifier aussi :
- **Certificat SSL (HTTPS)** : indispensable, le mot de passe de l'application circule à chaque page.
  D'après HostMetro, le SSL gratuit est inclus dans *Super Max*, pas dans l'offre d'entrée *Mega Max*.
  Dans cPanel : *SSL/TLS Status* ou *Let's Encrypt*.
- **Tâches cron** (*Cron Jobs* dans cPanel) : nécessaires pour la synchronisation email.
- **Port 993 sortant** autorisé (connexion IMAP vers Gmail et Neo) : à confirmer avec le support si la synchronisation échoue avec « Connexion au serveur IMAP impossible ».

Question type à envoyer au support HostMetro :
> Mon offre permet-elle d'héberger une application Node.js via « Setup Node.js App » avec Node.js 22.13 ou plus ?
> Les connexions sortantes vers imap.gmail.com sur le port 993 sont-elles autorisées ? Puis-je créer des tâches cron ?

## 1. Envoyer les fichiers

- Choisissez un sous-domaine, par exemple `gestion.votre-domaine.com` (*Domaines / Subdomains* dans cPanel).
- Téléchargez le projet depuis GitHub (*Code › Download ZIP* sur la branche) puis, dans le
  *Gestionnaire de fichiers* de cPanel, envoyez le ZIP dans un dossier **hors de `public_html`**, par exemple
  `/home/VOTRE_COMPTE/mondaix`, et décompressez-le.
  (Avec un accès SSH : `git clone https://github.com/Stinjux/MONDAIX_GESTION.git mondaix`.)

## 2. Créer l'application Node.js

Dans *Setup Node.js App › Create Application* :

| Champ | Valeur |
|---|---|
| Node.js version | 22.13 ou plus récent |
| Application mode | Production |
| Application root | `mondaix` |
| Application URL | `gestion.votre-domaine.com` |
| Application startup file | `app.cjs` |

Créez l'application, puis cliquez sur **Run NPM Install**.

## 3. Configurer le fichier .env

Dans le Gestionnaire de fichiers, copiez `mondaix/.env.example` en `mondaix/.env` et complétez :

```
MONDAIX_MOT_DE_PASSE=un-mot-de-passe-long
EMAIL_SYNCHRO_MINUTES=0        # la synchronisation passe par le cron (étape 4)
GMAIL_UTILISATEUR=votre.adresse@gmail.com
GMAIL_MOT_DE_PASSE=mot-de-passe-d-application-google
NEO_UTILISATEUR=votre.adresse@votre-domaine
NEO_MOT_DE_PASSE=...
NEO_IMAP_HOTE=...              # serveur IMAP indiqué dans les réglages Neo
```

Les lignes `HOST` et `PORT` sont ignorées sous cPanel. Sans `MONDAIX_MOT_DE_PASSE`, l'application refuse de démarrer.
Puis, dans *Setup Node.js App*, cliquez sur **Restart**.

Ouvrez `https://gestion.votre-domaine.com` : le navigateur demande l'identifiant (`admin`) et le mot de passe.

## 4. Synchronisation email (cron)

Sous cPanel, l'application est mise en veille quand personne ne l'utilise : la synchronisation automatique
passe donc par une tâche cron. En haut de la page *Setup Node.js App*, cPanel affiche la commande
d'activation de l'environnement, du type :

```
source /home/VOTRE_COMPTE/nodevenv/mondaix/22/bin/activate && cd /home/VOTRE_COMPTE/mondaix
```

Dans *Cron Jobs*, ajoutez une tâche **toutes les 15 minutes** (`*/15 * * * *`) avec cette commande, suivie de
` && node src/synchro.js` :

```
source /home/VOTRE_COMPTE/nodevenv/mondaix/22/bin/activate && cd /home/VOTRE_COMPTE/mondaix && node src/synchro.js
```

Le bouton « Synchroniser maintenant » (Paramètres et pages Gmail / Neo) reste disponible.

## 5. Sauvegardes

Toutes les données sont dans `mondaix/data/` (`mondaix.sqlite` et ses fichiers `-wal` / `-shm`).
Incluez ce dossier dans les sauvegardes cPanel, ou téléchargez-le régulièrement.

## Mises à jour

Remplacez les fichiers du dossier `mondaix` (sans toucher à `.env` ni à `data/`), cliquez sur
**Run NPM Install** si `package.json` a changé, puis sur **Restart**.
