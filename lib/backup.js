// Sauvegarde automatique des bases SQLite des outils (apps/*) dans MySQL, chiffrees.
// Active seulement si BACKUP_KEY et DB_* sont definies ; sinon la passerelle demarre normalement.
// Tout est isole : une erreur ici ne doit JAMAIS atteindre les handlers globaux (process.exit).
const { configFromEnv, createMysqlStore } = require('./backup-store');
const core = require('./backup-core');
const { defaultFile } = require('./gw-db');

function start(appsDir, env = process.env, log = console) {
  if (!env.BACKUP_KEY) { log.log('[backup] desactive (BACKUP_KEY absente).'); return null; }
  let key, cfg;
  try { key = core.parseKey(env.BACKUP_KEY); } catch (e) { log.error('[backup] desactive :', e.message); return null; }
  cfg = configFromEnv(env);
  if (cfg.error) { log.error('[backup] desactive :', cfg.error); return null; }

  const hours = Number(env.BACKUP_INTERVAL_HOURS) > 0 ? Number(env.BACKUP_INTERVAL_HOURS) : 6;
  const prune = env.BACKUP_PRUNE !== '0';
  const alertAfterMs = hours * 6 * 3600 * 1000; // alerte log si rien de nouveau depuis longtemps
  let store = null, running = false, lastOk = Date.now();

  async function cycle() {
    if (running) return;
    running = true;
    try {
      store = store || await createMysqlStore(cfg);
      const r = await core.runBackup({ appsDir, store, key, log, prune, extraDbs: [{ app: '_gateway', rel: 'gateway.db', file: defaultFile() }] });
      if (r.failed === 0) lastOk = Date.now();
      else if (Date.now() - lastOk > alertAfterMs) log.error(`[backup] ALERTE : aucun cycle sans erreur depuis ${Math.round((Date.now() - lastOk) / 3600000)} h`);
    } catch (err) {
      store = null; // reconnexion au prochain cycle
      log.error('[backup] cycle en echec :', err.message);
      if (Date.now() - lastOk > alertAfterMs) log.error(`[backup] ALERTE : aucune sauvegarde reussie depuis ${Math.round((Date.now() - lastOk) / 3600000)} h`);
    } finally { running = false; }
  }

  // Premier passage apres 30 s (laisse le demarrage se terminer), puis toutes les N heures.
  // unref() : ces timers ne retiennent pas le process.
  setTimeout(cycle, 30 * 1000).unref();
  setInterval(cycle, hours * 3600 * 1000).unref();
  log.log(`[backup] actif : toutes les ${hours} h, retention ${prune ? '7j/4s/6m' : 'desactivee'}.`);
  return { cycle };
}

module.exports = { start };
