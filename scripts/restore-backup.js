#!/usr/bin/env node
// Restauration MANUELLE d'une sauvegarde (jamais automatique).
//   node scripts/restore-backup.js list [app]
//   node scripts/restore-backup.js restore <id> [--replace]
// Par defaut ecrit <fichier>.restored a cote de la base d'origine (rien n'est ecrase).
// Avec --replace : l'ancienne base est d'abord renommee <fichier>.bak-<date>, puis remplacee.
// ARRETER la passerelle avant --replace. Variables : BACKUP_KEY et DB_* (comme le serveur).
const fs = require('fs');
const path = require('path');
require('../lib/load-env').loadEnv();
const { configFromEnv, createMysqlStore } = require('../lib/backup-store');
const core = require('../lib/backup-core');

(async () => {
  const [cmd, arg, flag] = process.argv.slice(2);
  const cfg = configFromEnv();
  if (cfg.error) throw new Error(cfg.error);
  const store = await createMysqlStore(cfg);
  try {
    if (cmd === 'list') {
      for (const b of await store.list(arg)) console.log(`#${b.id}\t${new Date(b.taken_at).toISOString()}\t${b.app}/${b.file}\t${b.size_plain} o`);
    } else if (cmd === 'restore' && arg) {
      const b = await store.get(Number(arg));
      if (!b) throw new Error(`sauvegarde #${arg} introuvable`);
      const plain = core.decrypt(b.blob, core.parseKey(process.env.BACKUP_KEY), b.app, b.file); // echoue si altere
      const target = path.resolve(__dirname, '..', 'apps', b.app, b.file);
      const rel = path.relative(path.resolve(__dirname, '..', 'apps', b.app), target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('chemin de destination invalide');
      if (flag === '--replace') {
        if (fs.existsSync(target)) fs.renameSync(target, `${target}.bak-${Date.now()}`);
        for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(target + ext); } catch (e) { /* absent */ } }
        const tmp = `${target}.tmp`;
        fs.writeFileSync(tmp, plain, { mode: 0o600 });
        fs.renameSync(tmp, target);
        console.log(`Restaure : ${target} (ancienne base conservee en .bak-*)`);
      } else {
        fs.writeFileSync(`${target}.restored`, plain, { mode: 0o600 });
        console.log(`Ecrit : ${target}.restored (utiliser --replace pour remplacer la base)`);
      }
    } else {
      console.log('Usage : list [app] | restore <id> [--replace]');
      process.exitCode = 1;
    }
  } finally { await store.close(); }
})().catch((e) => { console.error('Erreur :', e.message); process.exit(1); });
