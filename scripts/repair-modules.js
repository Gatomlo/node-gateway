// Auto-reparation des dependances de la passerelle au demarrage.
//
// Pourquoi : une installation npm interrompue par l'hebergeur (delai, quota) peut laisser
// un package.json a moitie ecrit dans node_modules (ex. celui d'express) ; la passerelle
// plante alors des son demarrage (ERR_INVALID_PACKAGE_CONFIG) et TOUS les outils sont
// coupes. Le verrou .installing ne suffit pas : depuis npm 7, le script « preinstall »
// du projet racine s'execute APRES l'ecriture des dependances, donc trop tard pour
// proteger ce moment-la.
//
// Ce que ca fait : avant de charger express, on verifie que le package.json de chaque
// dependance de la passerelle (node_modules/<nom> et node_modules/@scope/<nom>) est un
// JSON lisible et qu'express est present. Sinon, on supprime les paquets abimes et on
// reinstalle les dependances de la passerelle seulement (--ignore-scripts : pas la
// reinstallation de tous les outils de apps/, beaucoup plus longue), puis on demarre.
// Les node_modules des outils ne sont pas concernes : une erreur au chargement d'un
// outil est deja isolee par mountApps() (l'outil est saute, la passerelle tourne).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Liste les paquets dont le package.json est absent ou illisible.
function findBroken(rootDir, required = ['express']) {
  const nm = path.join(rootDir, 'node_modules');
  const broken = [];
  const check = (dir) => {
    try {
      JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch (e) {
      broken.push(dir);
    }
  };
  if (!fs.existsSync(nm)) return required.map((n) => path.join(nm, n));
  for (const name of fs.readdirSync(nm)) {
    if (name.startsWith('.')) continue; // .bin, .package-lock.json
    const dir = path.join(nm, name);
    let isDir = false;
    try { isDir = fs.statSync(dir).isDirectory(); } catch (e) { /* lien casse */ }
    if (!isDir) continue;
    if (name.startsWith('@')) {
      for (const sub of fs.readdirSync(dir)) check(path.join(dir, sub));
    } else {
      check(dir);
    }
  }
  for (const n of required) {
    const dir = path.join(nm, n);
    if (!fs.existsSync(dir) && !broken.includes(dir)) broken.push(dir);
  }
  return broken;
}

// Repare si besoin. `install` est remplacable pour les tests. Renvoie la liste reparee.
function repairIfNeeded(rootDir, { install, log = console } = {}) {
  const broken = findBroken(rootDir);
  if (!broken.length) return [];
  const names = broken.map((d) => path.relative(path.join(rootDir, 'node_modules'), d));
  log.warn(`Dependances de la passerelle abimees ou manquantes (${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''}) : reinstallation...`);
  for (const dir of broken) fs.rmSync(dir, { recursive: true, force: true });
  const run = install || (() => execSync('npm install --omit=dev --ignore-scripts --no-audit --no-fund', { cwd: rootDir, stdio: 'inherit' }));
  run();
  const still = findBroken(rootDir);
  if (still.length) throw new Error(`Reparation impossible : ${still.map((d) => path.basename(d)).join(', ')}`);
  log.log('Dependances de la passerelle reparees, demarrage.');
  return names;
}

module.exports = { findBroken, repairIfNeeded };
