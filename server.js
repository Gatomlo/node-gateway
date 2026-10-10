// Passerelle Node.js unique : l'hebergement (Infomaniak) n'autorise qu'une seule
// application Node. Ce serveur est donc CE point d'entree unique, et monte
// automatiquement chaque outil trouve dans apps/ sur une route portant le nom de
// son dossier (ex. apps/repetito -> /repetito). Ajouter un outil = deposer son
// dossier dans apps/ (avec son propre package.json, node_modules, etc.) et
// redemarrer ; aucune configuration a ecrire.
//
// Convention attendue pour chaque sous-application : son fichier d'entree (server.js
// par defaut) doit exporter l'app Express (module.exports = app) plutot que
// d'appeler app.listen() lui-meme quand il est charge par la passerelle. Pour rester
// utilisable seul en developpement, ce fichier garde d'ordinaire son propre
// app.listen(), execute uniquement quand on le lance directement :
//
//   if (require.main === module) app.listen(PORT, () => ...);
//   module.exports = app;

// Une erreur non interceptee laisse le process dans un etat indetermine (requete sans
// reponse, transaction SQLite a moitie faite, voire plus aucun port en ecoute). On log
// puis on sort en erreur pour que l'hebergement relance un process propre, plutot que
// de continuer en silence. Ces handlers sont les seuls du process : un outil monte ne
// doit poser les siens que sous "if (require.main === module)".
const fatal = (kind) => (err) => {
  console.error(`${kind}, arret de la passerelle :`, err);
  process.exit(1);
};
process.on('uncaughtException', fatal('Erreur non interceptee'));
process.on('unhandledRejection', fatal('Promesse rejetee non geree'));

const fs = require('fs');
const path = require('path');

// Si un "npm install" est encore en cours (verrou pose en "preinstall", retire en
// "postinstall" — voir package.json et scripts/install-lock.js), on attend sa fin
// avant de charger le moindre module. Sans ca, l'hebergement peut demarrer l'app
// pendant que npm est encore en train d'ecrire des package.json dans node_modules
// (ex. celui d'express), ce qui declenche des ERR_INVALID_PACKAGE_CONFIG aleatoires
// au boot juste apres un deploiement.
(function waitForInstallLock() {
  const LOCK_PATH = path.join(__dirname, '.installing');
  const MAX_WAIT_MS = 5 * 60 * 1000;
  if (!fs.existsSync(LOCK_PATH)) return;
  console.log('Installation en cours detectee (.installing), attente avant de demarrer...');
  const deadline = Date.now() + MAX_WAIT_MS;
  while (fs.existsSync(LOCK_PATH) && Date.now() < deadline) {
    // Attente synchrone (aucune boucle d'evenements ne tourne encore a ce stade) mais
    // non active : Atomics.wait bloque le thread sans consommer de CPU.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  if (fs.existsSync(LOCK_PATH)) {
    console.warn('Verrou .installing toujours present apres 5 min (install plantee ?), demarrage quand meme.');
  } else {
    console.log('Installation terminee, demarrage.');
  }
})();

// Dependances de la passerelle abimees par une installation interrompue : reparees
// avant de charger express (voir scripts/repair-modules.js), au lieu de planter en boucle.
require('./scripts/repair-modules').repairIfNeeded(__dirname);

const express = require('express');

const PORT = process.env.PORT || 3000;
const APPS_DIR = path.join(__dirname, 'apps');

const app = express();

// Cherche une icone a afficher pour l'outil sur la page d'accueil, en lisant son
// manifest.json (PWA) s'il en a un — convention deja suivie par les outils existants,
// aucune configuration supplementaire a ecrire pour en beneficier.
function findIcon(dir, route) {
  for (const rel of ['public/manifest.json', 'manifest.json']) {
    const manifestPath = path.join(dir, rel);
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const icon = (manifest.icons || [])[0];
      if (icon && icon.src) return route + '/' + icon.src.replace(/^\.?\//, '');
    } catch (e) { /* manifest illisible : pas d'icone */ }
  }
  return null;
}

function findEntry(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.main) return path.join(dir, pkg.main);
    } catch (e) { /* package.json invalide : on retombe sur server.js */ }
  }
  return path.join(dir, 'server.js');
}

function mountApps() {
  const mounted = [];
  if (!fs.existsSync(APPS_DIR)) {
    console.warn(`Aucun dossier apps/ trouve (${APPS_DIR}) — rien a monter.`);
    return mounted;
  }
  // fs.Dirent.isDirectory() ne suit pas les jonctions/liens symboliques sous Windows
  // (utiles en dev pour pointer apps/<nom> vers un dossier de projet existant sans le
  // dupliquer) : on verifie avec statSync, qui les suit.
  const names = fs.readdirSync(APPS_DIR)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => { try { return fs.statSync(path.join(APPS_DIR, name)).isDirectory(); } catch (e) { return false; } })
    .sort();

  for (const name of names) {
    const dir = path.join(APPS_DIR, name);
    const entry = findEntry(dir);
    if (!fs.existsSync(entry)) {
      console.error(`✗ ${name} : point d'entree introuvable (${entry}), ignore.`);
      continue;
    }
    try {
      const subApp = require(entry);
      if (typeof subApp !== 'function') {
        throw new Error(`${entry} doit exporter l'app Express (module.exports = app), pas ${typeof subApp}.`);
      }
      const route = '/' + name;
      app.use(route, subApp);
      mounted.push({ name, route, icon: findIcon(dir, route) });
      console.log(`✓ ${name} monte sur ${route}`);
    } catch (err) {
      console.error(`✗ Echec du montage de "${name}" :`, err.message);
    }
  }
  return mounted;
}

const mounted = mountApps();

function displayName(name) {
  return name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

app.get('/', (req, res) => {
  const items = mounted.map((m) => `
    <a class="card" href="${m.route}/">
      ${m.icon
        ? `<img class="card-icon" src="${m.icon}" alt="">`
        : `<span class="card-icon card-icon-fallback">${displayName(m.name).charAt(0)}</span>`}
      <span class="card-name">${displayName(m.name)}</span>
      <span class="card-arrow">→</span>
    </a>`).join('') || '<p class="empty">Aucun outil monté pour le moment.</p>';
  res.type('html').send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Outils</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f4f2f5; color: #241a1f; padding: 24px;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #17111a; color: #f2e9ec; }
    .card { background: #241a20 !important; border-color: #3a2a31 !important; }
    .empty { color: #b8a6ad !important; }
  }
  .shell { width: 100%; max-width: 420px; }
  h1 { font-size: 20px; font-weight: 700; margin: 0 0 18px; text-align: center; }
  .list { display: flex; flex-direction: column; gap: 10px; }
  .card {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    background: #fff; border: 1px solid #ecdfe4; border-radius: 14px; padding: 16px 18px;
    text-decoration: none; color: inherit; font-weight: 600; font-size: 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04); transition: transform .1s ease, box-shadow .1s ease;
  }
  .card:active { transform: scale(0.98); }
  .card-name { flex: 1; }
  .card-icon {
    width: 32px; height: 32px; border-radius: 8px; object-fit: cover; flex-shrink: 0;
  }
  .card-icon-fallback {
    display: flex; align-items: center; justify-content: center;
    background: #8a2145; color: #fff; font-size: 15px;
  }
  .card-arrow { color: #8a2145; font-weight: 700; flex-shrink: 0; }
  .empty { text-align: center; color: #7a6d72; font-size: 14px; }
</style>
</head>
<body>
<div class="shell">
  <h1>Outils disponibles</h1>
  <div class="list">${items}</div>
</div>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Passerelle disponible sur http://localhost:${PORT}`);
}).on('error', fatal(`Impossible d'ecouter sur le port ${PORT}`));
