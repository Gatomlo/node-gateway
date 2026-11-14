// Coeur des sauvegardes SQLite : decouverte, copie coherente, chiffrement, retention.
// Aucune dependance reseau ici (le stockage est injecte, voir backup-store.js), ce qui
// permet de tester le tout sans MySQL.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const DB_EXT = /\.(db|sqlite|sqlite3)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache']);
const MAX_DEPTH = 3;
const MAX_DB_BYTES = 200 * 1024 * 1024; // garde-fou memoire (la copie est lue en RAM)

function isSqliteFile(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(16);
      fs.readSync(fd, buf, 0, 16, 0);
      return buf.equals(SQLITE_MAGIC);
    } finally { fs.closeSync(fd); }
  } catch (e) { return false; }
}

// Chemin reel contenu dans appDir ? (refuse les liens symboliques qui sortent de l'outil)
function insideDir(dir, file) {
  const rel = path.relative(fs.realpathSync(dir), fs.realpathSync(file));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function walk(dir, depth, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (depth < MAX_DEPTH && !SKIP_DIRS.has(ent.name) && !ent.name.startsWith('.')) walk(full, depth + 1, out);
    } else if (ent.isFile() && DB_EXT.test(ent.name)) {
      out.push(full);
    }
  }
}

// Bases d'un outil : liste explicite "gateway.backup" du package.json (chemins relatifs,
// ou [] pour desactiver), sinon detection automatique *.db / *.sqlite / *.sqlite3.
function discoverAppDbs(appDir) {
  let explicit = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    if (pkg.gateway && Array.isArray(pkg.gateway.backup)) explicit = pkg.gateway.backup.map(String);
  } catch (e) { /* pas de package.json lisible */ }
  let files = [];
  if (explicit) files = explicit.map((rel) => path.resolve(appDir, rel)).filter((f) => fs.existsSync(f));
  else walk(appDir, 0, files);
  return files
    .filter((f) => { try { return insideDir(appDir, f) && isSqliteFile(f); } catch (e) { return false; } })
    .map((f) => ({ file: f, rel: path.relative(appDir, f).split(path.sep).join('/') }));
}

function discoverAll(appsDir) {
  const out = [];
  if (!fs.existsSync(appsDir)) return out;
  for (const name of fs.readdirSync(appsDir).sort()) {
    if (name.startsWith('.')) continue;
    const dir = path.join(appsDir, name);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch (e) { continue; }
    for (const db of discoverAppDbs(dir)) out.push({ app: name, ...db });
  }
  return out;
}

// Copie coherente (compatible WAL) via VACUUM INTO sur une connexion en lecture seule.
function snapshot(file) {
  const { DatabaseSync } = require('node:sqlite');
  const tmp = path.join(os.tmpdir(), `gw-backup-${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally { db.close(); }
  try {
    const size = fs.statSync(tmp).size;
    if (size > MAX_DB_BYTES) throw new Error(`base trop volumineuse (${size} octets > ${MAX_DB_BYTES})`);
    return fs.readFileSync(tmp);
  } finally { try { fs.unlinkSync(tmp); } catch (e) { /* deja supprime */ } }
}

// --- Chiffrement : gzip puis AES-256-GCM. Format : iv(12) | tag(16) | donnees. ---
function parseKey(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('BACKUP_KEY doit etre 64 caracteres hexadecimaux (32 octets). Generer : node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return Buffer.from(hex, 'hex');
}

const aad = (app, rel) => Buffer.from(`${app}\n${rel}`, 'utf8'); // lie le contenu a son origine

function encrypt(plain, key, app, rel) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(app, rel));
  const body = Buffer.concat([c.update(zlib.gzipSync(plain)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

function decrypt(blob, key, app, rel) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAAD(aad(app, rel));
  d.setAuthTag(blob.subarray(12, 28));
  return zlib.gunzipSync(Buffer.concat([d.update(blob.subarray(28)), d.final()]));
}

// Empreinte "keyed" du contenu (dedup) : ne revele rien sur la base sans la cle.
const fingerprint = (plain, key) => crypto.createHmac('sha256', key).update(plain).digest('hex');

const CHUNK = 4 * 1024 * 1024;
function split(buf) {
  const parts = [];
  for (let i = 0; i < buf.length; i += CHUNK) parts.push(buf.subarray(i, i + CHUNK));
  return parts.length ? parts : [Buffer.alloc(0)];
}

// --- Retention : 7 quotidiennes + 4 hebdomadaires + 6 mensuelles (+ la plus recente). ---
function selectKeep(backups, { daily = 7, weekly = 4, monthly = 6 } = {}) {
  const sorted = [...backups].sort((a, b) => new Date(b.taken_at) - new Date(a.taken_at));
  const keep = new Set();
  const seen = { d: new Set(), w: new Set(), m: new Set() };
  const weekKey = (t) => { const d = new Date(t); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  if (sorted[0]) keep.add(sorted[0].id);
  for (const b of sorted) {
    const iso = new Date(b.taken_at).toISOString();
    const day = iso.slice(0, 10), month = iso.slice(0, 7), week = weekKey(b.taken_at);
    if (seen.d.size < daily && !seen.d.has(day)) { seen.d.add(day); keep.add(b.id); }
    if (seen.w.size < weekly && !seen.w.has(week)) { seen.w.add(week); keep.add(b.id); }
    if (seen.m.size < monthly && !seen.m.has(month)) { seen.m.add(month); keep.add(b.id); }
  }
  return keep;
}

// Un cycle complet. `store` : { latestFingerprint, insert, list, remove }.
async function runBackup({ appsDir, store, key, log = console, prune = true }) {
  const result = { saved: 0, unchanged: 0, failed: 0 };
  for (const { app, rel, file } of discoverAll(appsDir)) {
    try {
      const plain = snapshot(file);
      const fp = fingerprint(plain, key);
      if ((await store.latestFingerprint(app, rel)) === fp) { result.unchanged++; continue; }
      const parts = split(encrypt(plain, key, app, rel));
      await store.insert({ app, file: rel, fingerprint: fp, size: plain.length, chunks: parts });
      result.saved++;
      log.log(`[backup] ${app}/${rel} sauvegarde (${plain.length} octets, ${parts.length} morceau(x))`);
      if (prune) {
        const keep = selectKeep(await store.list(app, rel));
        for (const b of await store.list(app, rel)) if (!keep.has(b.id)) await store.remove(b.id);
      }
    } catch (err) {
      result.failed++;
      log.error(`[backup] echec ${app}/${rel} :`, err.message);
    }
  }
  return result;
}

module.exports = { discoverAll, discoverAppDbs, snapshot, parseKey, encrypt, decrypt, fingerprint, split, selectKeep, runBackup };
