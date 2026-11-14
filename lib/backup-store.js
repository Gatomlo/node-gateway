// Stockage MySQL/MariaDB des sauvegardes (mysql2, JS pur : rien a compiler en mutualise).
// Config UNIQUEMENT par variables d'environnement : DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS app_backups (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    app VARCHAR(100) NOT NULL,
    file VARCHAR(255) NOT NULL,
    taken_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fingerprint CHAR(64) NOT NULL,
    size_plain BIGINT UNSIGNED NOT NULL,
    chunks INT UNSIGNED NOT NULL,
    KEY idx_app_file (app, file, taken_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS app_backup_chunks (
    backup_id INT UNSIGNED NOT NULL,
    chunk_no INT UNSIGNED NOT NULL,
    data MEDIUMBLOB NOT NULL,
    PRIMARY KEY (backup_id, chunk_no),
    CONSTRAINT fk_backup FOREIGN KEY (backup_id) REFERENCES app_backups(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`
];

function configFromEnv(env = process.env) {
  const need = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) return { error: `variables manquantes : ${missing.join(', ')}` };
  return { host: env.DB_HOST, port: Number(env.DB_PORT) || 3306, database: env.DB_NAME, user: env.DB_USER, password: env.DB_PASSWORD };
}

async function createMysqlStore(cfg) {
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({ ...cfg, connectionLimit: 2, charset: 'utf8mb4', timezone: 'Z' });

  // Cree les tables si le compte a le droit CREATE ; sinon on suppose qu'elles existent deja
  // (SQL fourni dans le README) et on le verifie par une lecture.
  try { for (const sql of SCHEMA) await pool.query(sql); } catch (e) { /* droit CREATE absent */ }
  await pool.query('SELECT 1 FROM app_backups LIMIT 1');

  return {
    async latestFingerprint(app, file) {
      const [rows] = await pool.query('SELECT fingerprint FROM app_backups WHERE app=? AND file=? ORDER BY taken_at DESC, id DESC LIMIT 1', [app, file]);
      return rows[0] ? rows[0].fingerprint : null;
    },
    async insert({ app, file, fingerprint, size, chunks }) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [r] = await conn.query('INSERT INTO app_backups (app, file, taken_at, fingerprint, size_plain, chunks) VALUES (?,?,UTC_TIMESTAMP(),?,?,?)', [app, file, fingerprint, size, chunks.length]);
        for (let i = 0; i < chunks.length; i++) await conn.query('INSERT INTO app_backup_chunks (backup_id, chunk_no, data) VALUES (?,?,?)', [r.insertId, i, chunks[i]]);
        await conn.commit();
        return r.insertId;
      } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    },
    async list(app, file) {
      const where = []; const args = [];
      if (app) { where.push('app=?'); args.push(app); }
      if (file) { where.push('file=?'); args.push(file); }
      const [rows] = await pool.query(`SELECT id, app, file, taken_at, size_plain, chunks FROM app_backups ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY taken_at DESC, id DESC`, args);
      return rows;
    },
    async remove(id) { await pool.query('DELETE FROM app_backups WHERE id=?', [id]); }, // chunks : ON DELETE CASCADE
    async get(id) {
      const [[meta]] = await pool.query('SELECT id, app, file, taken_at FROM app_backups WHERE id=?', [id]);
      if (!meta) return null;
      const [rows] = await pool.query('SELECT data FROM app_backup_chunks WHERE backup_id=? ORDER BY chunk_no', [id]);
      return { ...meta, blob: Buffer.concat(rows.map((r) => r.data)) };
    },
    async lastBackupTime() {
      const [[row]] = await pool.query('SELECT MAX(taken_at) AS t FROM app_backups');
      return row && row.t ? new Date(row.t) : null;
    },
    close: () => pool.end()
  };
}

module.exports = { SCHEMA, configFromEnv, createMysqlStore };
