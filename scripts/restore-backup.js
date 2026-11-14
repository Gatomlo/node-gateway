#!/usr/bin/env node
// Restauration MANUELLE d'une sauvegarde, utilisable en SSH (jamais automatique).
//   npm run restore                      -> mode interactif (choix guide)
//   npm run restore -- list [outil]      -> liste les sauvegardes
//   npm run restore -- <id> [--replace]  -> restaure la sauvegarde #id
// Par defaut ecrit <fichier>.restored a cote de la base d'origine (rien n'est ecrase).
// Avec --replace : l'ancienne base est d'abord renommee <fichier>.bak-<date>, puis remplacee.
// ARRETER la passerelle avant --replace. Lit BACKUP_KEY et DB_* depuis l'environnement ou .env.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
require('../lib/load-env').loadEnv();
const { configFromEnv, createMysqlStore } = require('../lib/backup-store');
const core = require('../lib/backup-core');

const APPS_DIR = path.resolve(__dirname, '..', 'apps');
const fmt = (b) => `#${b.id}\t${new Date(b.taken_at).toISOString().replace('T', ' ').slice(0, 19)} UTC\t${b.app}/${b.file}\t${(b.size_plain / 1024).toFixed(1)} Ko`;

// Dechiffre la sauvegarde (echoue si elle a ete alteree) et l'ecrit. Retourne le chemin ecrit.
async function restore(store, id, { replace = false, appsDir = APPS_DIR, key }) {
  const b = await store.get(Number(id));
  if (!b) throw new Error(`sauvegarde #${id} introuvable`);
  const plain = core.decrypt(b.blob, key, b.app, b.file);
  // La base des comptes de la passerelle (app "_gateway") vit dans data/, pas dans apps/.
  const baseDir = b.app === '_gateway' ? path.dirname(require('../lib/gw-db').defaultFile()) : path.resolve(appsDir, b.app);
  const target = b.app === '_gateway' ? require('../lib/gw-db').defaultFile() : path.resolve(appsDir, b.app, b.file);
  const rel = path.relative(baseDir, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('chemin de destination invalide');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!replace) {
    fs.writeFileSync(`${target}.restored`, plain, { mode: 0o600 });
    return `${target}.restored`;
  }
  if (fs.existsSync(target)) fs.renameSync(target, `${target}.bak-${Date.now()}`);
  for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(target + ext); } catch (e) { /* absent */ } }
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, plain, { mode: 0o600 });
  fs.renameSync(tmp, target);
  return target;
}

async function interactive(store, key) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));
  try {
    const all = await store.list();
    if (!all.length) { console.log('Aucune sauvegarde en base.'); return; }
    const apps = [...new Set(all.map((b) => b.app))];
    apps.forEach((a, i) => console.log(`  ${i + 1}) ${a}`));
    const pickApp = apps[Number(await ask('Outil a restaurer (numero) : ')) - 1];
    if (!pickApp) throw new Error('choix invalide');
    const list = all.filter((b) => b.app === pickApp).slice(0, 20);
    list.forEach((b, i) => console.log(`  ${i + 1}) ${fmt(b).split('\t').slice(1).join('  ')}`));
    const b = list[Number(await ask('Sauvegarde (numero, 1 = la plus recente) : ')) - 1];
    if (!b) throw new Error('choix invalide');
    const mode = await ask('Ecrire en <fichier>.restored sans rien ecraser (1) ou REMPLACER la base actuelle (2) ? [1] : ');
    const replace = mode === '2';
    if (replace) {
      console.log('\nATTENTION : la passerelle doit etre ARRETEE. L\'ancienne base sera conservee en .bak-<date>.');
      if ((await ask(`Taper "oui" pour remplacer ${b.app}/${b.file} par la version du ${new Date(b.taken_at).toISOString()} : `)).toLowerCase() !== 'oui') { console.log('Annule.'); return; }
    }
    console.log('Ecrit :', await restore(store, b.id, { replace, key }));
    if (replace) console.log('Redemarre la passerelle pour terminer.');
  } finally { rl.close(); }
}

async function main(argv) {
  const cfg = configFromEnv();
  if (cfg.error) throw new Error(cfg.error);
  const key = core.parseKey(process.env.BACKUP_KEY);
  const store = await createMysqlStore(cfg);
  try {
    const [a, b, c] = argv;
    if (!a) await interactive(store, key);
    else if (a === 'list') (await store.list(b)).forEach((x) => console.log(fmt(x)));
    else if (/^\d+$/.test(a) || a === 'restore') {
      const id = a === 'restore' ? b : a;
      const replace = [b, c].includes('--replace');
      console.log('Ecrit :', await restore(store, id, { replace, key }));
    } else { console.log('Usage : npm run restore | npm run restore -- list [outil] | npm run restore -- <id> [--replace]'); process.exitCode = 1; }
  } finally { await store.close(); }
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error('Erreur :', e.message); process.exit(1); });
module.exports = { restore };
