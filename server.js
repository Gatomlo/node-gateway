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
const { renderHome } = require('./home');
const http = require('http');

const PORT = process.env.PORT || 3000;
const APPS_DIR = path.join(__dirname, 'apps');

const app = express();
// Serveur HTTP cree explicitement (app.listen() en fait autant en interne) pour pouvoir le
// confier aux outils qui en ont besoin, typiquement Socket.IO (voir attachToServer plus bas).
const httpServer = http.createServer(app);

// Lit les informations d'affichage d'un outil, sans rien a configurer :
// - manifest.json (PWA, a la racine ou dans public/) : name, short_name, description, theme_color, icons ;
// - package.json : description ;
// - bloc facultatif "gateway" du package.json : { "name", "description", "color", "tags": [] } qui
//   l'emporte sur le reste (utile pour un outil sans manifest, ex. nom propre et etiquette "temps reel").
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function readMeta(dir, route) {
  let manifest = null;
  for (const rel of ['public/manifest.json', 'manifest.json']) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) { manifest = readJson(p); if (manifest) break; }
  }
  const pkg = readJson(path.join(dir, 'package.json')) || {};
  const custom = (pkg.gateway && typeof pkg.gateway === 'object') ? pkg.gateway : {};
  const icon = manifest && (manifest.icons || [])[0];
  return {
    icon: icon && icon.src ? route + '/' + icon.src.replace(/^\.?\//, '') : null,
    title: custom.name || (manifest && (manifest.name || manifest.short_name)) || null,
    description: custom.description || (manifest && manifest.description) || pkg.description || '',
    color: custom.color || (manifest && manifest.theme_color) || null,
    tags: Array.isArray(custom.tags) ? custom.tags.map(String) : []
  };
}

// Nom de la route d'un outil : par defaut le nom de son dossier, sauf si son package.json declare
// { "gateway": { "route": "quiz" } }. Utile quand le dossier porte le nom du depot (ex. un
// deploiement git automatique dans apps/TheBigTeamQuiz-V2) mais que l'adresse voulue est /quiz.
function routeNameFor(name, dir) {
  const pkg = readJson(path.join(dir, 'package.json'));
  const wanted = pkg && pkg.gateway && pkg.gateway.route;
  return typeof wanted === 'string' && /^[A-Za-z0-9_-]+$/.test(wanted) ? wanted : name;
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

function displayName(name) {
  return name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
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

  const usedRoutes = new Set();
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
      const routeName = routeNameFor(name, dir);
      if (usedRoutes.has(routeName)) throw new Error(`la route /${routeName} est deja prise par un autre outil.`);
      usedRoutes.add(routeName);
      const route = '/' + routeName;
      app.use(route, subApp);
      // Hook OPTIONNEL : un outil qui exporte aussi attachToServer(httpServer, { mountPath })
      // recoit le serveur HTTP de la passerelle (ex. pour y attacher Socket.IO sous
      // <mountPath>/socket.io). Les outils qui n'ont pas cette fonction sont montes comme avant.
      if (typeof subApp.attachToServer === 'function') {
        try {
          subApp.attachToServer(httpServer, { mountPath: route });
        } catch (err) {
          console.error(`✗ ${name} : attachToServer a echoue (l'outil reste monte, sans temps reel) :`, err.message);
        }
      }
      const meta = readMeta(dir, route);
      mounted.push({ id: routeName, name: meta.title || displayName(routeName), route, ...meta });
      console.log(`✓ ${name} monte sur ${route}`);
    } catch (err) {
      console.error(`✗ Echec du montage de "${name}" :`, err.message);
    }
  }
  return mounted;
}

const mounted = mountApps();

app.get('/', (req, res) => {
  res.type('html').send(renderHome(mounted));
});

httpServer.listen(PORT, () => {
  console.log(`Passerelle disponible sur http://localhost:${PORT}`);
}).on('error', fatal(`Impossible d'ecouter sur le port ${PORT}`));
