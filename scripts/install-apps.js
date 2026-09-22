// Lance "npm install --omit=dev" dans chaque dossier de apps/ qui a son propre
// package.json. Execute automatiquement apres "npm install" a la racine (voir le
// script "postinstall" dans package.json) : un seul "npm install" a la racine suffit
// a tout installer, meme apres avoir ajoute un nouvel outil dans apps/.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const APPS_DIR = path.join(__dirname, '..', 'apps');

if (!fs.existsSync(APPS_DIR)) process.exit(0);

const names = fs.readdirSync(APPS_DIR).filter((name) => {
  if (name.startsWith('.')) return false;
  try { return fs.statSync(path.join(APPS_DIR, name)).isDirectory(); } catch (e) { return false; }
});

for (const name of names) {
  const dir = path.join(APPS_DIR, name);
  if (!fs.existsSync(path.join(dir, 'package.json'))) continue;
  console.log(`\n--- npm install dans apps/${name} ---`);
  try {
    execSync('npm install --omit=dev', { cwd: dir, stdio: 'inherit' });
  } catch (err) {
    console.error(`✗ Echec de "npm install" pour apps/${name} — a corriger manuellement.`);
  }
}
