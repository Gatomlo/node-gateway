// Lance "npm install --omit=dev" dans chaque dossier de apps/ qui a son propre
// package.json. Execute automatiquement apres "npm install" a la racine (voir le
// script "postinstall" dans package.json) : un seul "npm install" a la racine suffit
// a tout installer, meme apres avoir ajoute un nouvel outil dans apps/.
//
// Sur hebergement mutualise (quota disque/CPU/timeout limites), ce hook s'execute
// dans le MEME process npm que l'install racine : enchainer une install complete par
// outil a chaque deploiement allonge d'autant l'operation et rapproche d'un timeout ou
// d'un quota, ce qui peut interrompre une install en plein ecriture et laisser un
// node_modules corrompu. Deux garde-fous : on saute les outils dont le node_modules
// est deja a jour (la plupart des deploiements ne touchent qu'un outil a la fois), et
// on supprime le node_modules d'un outil dont l'install a echoue plutot que de le
// laisser dans un etat corrompu jusqu'au prochain deploiement.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const APPS_DIR = path.join(__dirname, '..', 'apps');

if (!fs.existsSync(APPS_DIR)) process.exit(0);

const names = fs.readdirSync(APPS_DIR).filter((name) => {
  if (name.startsWith('.')) return false;
  try { return fs.statSync(path.join(APPS_DIR, name)).isDirectory(); } catch (e) { return false; }
});

function isUpToDate(dir) {
  const nodeModules = path.join(dir, 'node_modules');
  if (!fs.existsSync(nodeModules)) return false;
  const installedAt = fs.statSync(nodeModules).mtimeMs;
  return ['package.json', 'package-lock.json'].every((file) => {
    const p = path.join(dir, file);
    return !fs.existsSync(p) || fs.statSync(p).mtimeMs <= installedAt;
  });
}

for (const name of names) {
  const dir = path.join(APPS_DIR, name);
  if (!fs.existsSync(path.join(dir, 'package.json'))) continue;
  if (isUpToDate(dir)) {
    console.log(`= apps/${name} : node_modules deja a jour, install ignoree.`);
    continue;
  }
  console.log(`\n--- npm install dans apps/${name} ---`);
  try {
    execSync('npm install --omit=dev --no-audit --no-fund', { cwd: dir, stdio: 'inherit' });
    // Certains outils installent leurs dependances ailleurs (ex. un package.json racine dont le
    // postinstall installe server/) : pas de node_modules a dater dans ce cas, ce n'est pas un echec.
    const modulesDir = path.join(dir, 'node_modules');
    if (fs.existsSync(modulesDir)) fs.utimesSync(modulesDir, new Date(), new Date());
  } catch (err) {
    console.error(`✗ Echec de "npm install" pour apps/${name} — node_modules supprime, sera reinstalle au prochain deploiement.`);
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
  }
}
