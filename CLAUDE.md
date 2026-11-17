# node-gateway

## Objectif
Point d'entrée Node.js unique (Infomaniak n'autorise qu'une app Node par hébergement). Monte chaque outil de `apps/<nom>` sur la route `/<nom>` dans **un seul process**. Détails d'usage : `README.md`.

## Stack
Node >= 18, Express 4. Aucune autre dépendance, pas de tests.

## Fichiers clés
- `server.js` — tout le code : attente du verrou `.installing`, `mountApps()` (require de chaque entrée, `app.use('/<nom>', sousApp)`), page d'accueil `/`, `app.listen`.
- `scripts/install-lock.js` — pose/retire `.installing` (preinstall/postinstall) pour éviter un boot pendant `npm install`.
- `scripts/install-apps.js` — `npm install` dans chaque `apps/*` en postinstall.
- `apps/` — non versionné. En local : jonctions vers les dépôts des outils (`budget-foyer`, `mylittlelibrary`, `mystere`, `repetito`). En prod : vraies copies.

## Points non évidents
- Process partagé : tout `process.on(...)`, `process.exit()` ou `setInterval` d'un outil s'applique à toute la passerelle. Un outil ne doit poser ses handlers globaux / `app.listen()` que sous `if (require.main === module)`.
- Les erreurs synchrones au montage sont isolées par le try/catch de `mountApps()` ; les erreurs asynchrones ne le sont pas.
- Les handlers `uncaughtException` / `unhandledRejection` en tête de `server.js` (et l'erreur de `app.listen`) loguent puis font `process.exit(1)` : on compte sur l'hébergeur pour relancer. Un outil qui veut refuser de démarrer doit `throw` au chargement (isolé par `mountApps()`), jamais `process.exit()`.

## Commandes
- Lancer : `npm start` (PORT=3000 par défaut ; config de preview dans `.claude/launch.json`).
- Déploiement : envoi SFTP/Git chez Infomaniak, fichier de démarrage `server.js`, puis redémarrage depuis le manager.

## Méthode
Modifier un outil dans son propre dépôt (la jonction le reflète ici). Tester par `curl http://localhost:3000/<nom>/...` avant toute capture d'écran.
