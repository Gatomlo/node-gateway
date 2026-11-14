#!/usr/bin/env node
// Installation guidee de la sauvegarde : node scripts/setup-backup.js
//  1. genere BACKUP_KEY si absente ;
//  2. demande ce qui manque (hote, base, utilisateur, mot de passe MASQUE) ;
//  3. ecrit .env (droits 600, ignore par Git, charge au demarrage) ;
//  4. teste la connexion MySQL, cree les tables, liste les bases SQLite detectees.
// Rien n'est affiche en clair sauf la cle generee, une seule fois, pour que tu la sauvegardes.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { loadEnv, parse } = require('../lib/load-env');
const { configFromEnv, createMysqlStore } = require('../lib/backup-store');
const core = require('../lib/backup-core');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const existing = fs.existsSync(ENV_FILE) ? parse(fs.readFileSync(ENV_FILE, 'utf8')) : {};
const value = (k) => process.env[k] || existing[k];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
// Entree redirigee (pas un terminal) : on met les lignes en file d'attente, sinon readline se
// ferme a la fin du flux et les questions suivantes ne recoivent jamais de reponse.
const queued = []; const waiting = [];
if (!process.stdin.isTTY) {
  rl.on('line', (l) => (waiting.length ? waiting.shift()(l) : queued.push(l)));
  rl.on('close', () => { while (waiting.length) waiting.shift()(''); });
}
function ask(label, { hidden = false, def = '' } = {}) {
  return new Promise((resolve) => {
    const suffix = def ? ` [${def}]` : '';
    if (hidden && process.stdin.isTTY) {
      process.stdout.write(`${label}${suffix} (saisie masquee) : `);
      const orig = rl._writeToOutput;
      rl._writeToOutput = () => {};
      rl.question('', (a) => { rl._writeToOutput = orig; process.stdout.write('\n'); resolve(a.trim() || def); });
    } else if (!process.stdin.isTTY) {
      process.stdout.write(`${label}${suffix} : `);
      const done = (a) => resolve(a.trim() || def);
      if (queued.length) done(queued.shift()); else waiting.push(done);
    } else {
      rl.question(`${label}${suffix} : `, (a) => resolve(a.trim() || def));
    }
  });
}

(async () => {
  const out = { ...existing };
  let newKey = null;
  if (!value('BACKUP_KEY')) { newKey = crypto.randomBytes(32).toString('hex'); out.BACKUP_KEY = newKey; }
  const fields = [
    ['DB_HOST', 'Hote MySQL (ex. xxxxx.myd.infomaniak.com)', false, ''],
    ['DB_NAME', 'Nom de la base', false, '9i3yf_backupapps'],
    ['DB_USER', 'Utilisateur', false, '9i3yf_gateway'],
    ['DB_PASSWORD', 'Mot de passe MySQL', true, '']
  ];
  for (const [k, label, hidden, def] of fields) {
    if (value(k)) { out[k] = value(k); continue; }
    out[k] = await ask(label, { hidden, def });
  }
  rl.close();

  const body = '# Genere par scripts/setup-backup.js - NE PAS VERSIONNER (ignore par Git)\n' +
    Object.entries(out).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  fs.writeFileSync(ENV_FILE, body, { mode: 0o600 });
  try { fs.chmodSync(ENV_FILE, 0o600); } catch (e) { /* Windows */ }
  console.log(`\n.env ecrit (${ENV_FILE}).`);
  loadEnv(ENV_FILE);
  Object.assign(process.env, Object.fromEntries(Object.entries(out).filter(([k]) => process.env[k] === undefined)));

  core.parseKey(out.BACKUP_KEY);
  const cfg = configFromEnv();
  if (cfg.error) throw new Error(cfg.error);
  process.stdout.write('Connexion MySQL et creation des tables... ');
  const store = await createMysqlStore(cfg);
  await store.close();
  console.log('OK');

  const found = core.discoverAll(path.join(ROOT, 'apps'));
  console.log(found.length ? `Bases SQLite detectees (${found.length}) :` : 'Aucune base SQLite detectee pour le moment dans apps/.');
  for (const f of found) console.log(`  - ${f.app}/${f.rel}`);

  if (newKey) {
    console.log('\n=== CLE DE CHIFFREMENT (affichee une seule fois) ===\n' + newKey +
      '\nCopie-la MAINTENANT dans ton gestionnaire de mots de passe : sans elle les sauvegardes sont illisibles.\n' +
      '(Ne la colle jamais dans un chat ni dans Git.)');
  }
  console.log('\nTermine : redemarre la passerelle, la sauvegarde demarre 30 s apres le boot.');
})().catch((e) => { console.error('\nErreur :', e.message); process.exit(1); });
