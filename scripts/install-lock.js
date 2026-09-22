// Pose/retire le verrou .installing a la racine du projet. Appele en "preinstall"
// (avant que npm n'ecrive quoi que ce soit dans node_modules, y compris les
// dependances racine comme express) et en "postinstall", apres install-apps.js
// (donc une fois la racine ET tous les sous-outils de apps/ installes). server.js
// attend la disparition de ce verrou avant de charger le moindre module : ca evite
// que l'hebergement ne demarre l'app pendant que npm est encore en train d'ecrire
// des package.json, ce qui provoquait des erreurs ERR_INVALID_PACKAGE_CONFIG
// aleatoires au boot juste apres un deploiement.
const fs = require('fs');
const path = require('path');

const LOCK_PATH = path.join(__dirname, '..', '.installing');
const action = process.argv[2];

if (action === 'start') {
  fs.writeFileSync(LOCK_PATH, String(Date.now()));
} else if (action === 'end') {
  fs.rmSync(LOCK_PATH, { force: true });
} else {
  console.error('Usage: node install-lock.js start|end');
  process.exit(1);
}
