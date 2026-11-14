// Authentification de la passerelle : comptes, droits par outil, sessions. PAS un SSO : meme origine,
// un seul cookie de session pose par la passerelle ; les outils lisent simplement req.gateway.
//
//   req.gatewayUser = { id, login, name, email, isSuper }            (si connecte)
//   req.gateway     = { app, user, role }   role = 'admin' | 'member' | null   (dans chaque outil monte)
//
// La passerelle ne BLOQUE rien : chaque outil decide (pages publiques, invites, mode autonome intacts).
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const { addPages } = require('./gw-pages');
const scrypt = promisify(crypto.scrypt);

const COOKIE = 'gw_session';
const SESSION_TTL = 30 * 24 * 3600 * 1000; // glissant : renouvele au plus une fois par heure
const MIN_PASSWORD = 12;
const ROLES = ['admin', 'member'];
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---- Mots de passe : meme format que app-socle, scrypt$<sel hex>$<empreinte hex> ----
function checkPassword(p) {
  if (typeof p !== 'string' || p.length < MIN_PASSWORD) throw Object.assign(new Error(`Mot de passe trop court (${MIN_PASSWORD} caracteres minimum).`), { status: 400 });
  if (p.length > 200) throw Object.assign(new Error('Mot de passe trop long.'), { status: 400 });
}
async function hashPassword(p) {
  checkPassword(p);
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await scrypt(p, salt, 64)).toString('hex')}`;
}
const DUMMY = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`; // meme duree si le compte n'existe pas
async function verifyPassword(p, stored) {
  const [, salt, hash] = String(stored || DUMMY).split('$');
  const expected = Buffer.from(hash, 'hex');
  const actual = await scrypt(String(p || '').slice(0, 200), Buffer.from(salt, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual) && !!stored;
}

// ---- Limiteur d'echecs en memoire (8 par identifiant / 20 par IP sur 15 min) ----
function makeLimiter(windowMs) {
  const hits = new Map();
  const prune = (k) => { const a = (hits.get(k) || []).filter((t) => t > Date.now() - windowMs); a.length ? hits.set(k, a) : hits.delete(k); return a; };
  return { count: (k) => prune(k).length, hit: (k) => { const a = prune(k); a.push(Date.now()); hits.set(k, a); } };
}

// IP du client derriere le proxy de l'hebergeur : derniere entree de X-Forwarded-For (ajoutee par le
// proxy le plus proche, non falsifiable par le client), sinon l'adresse de la socket.
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket && req.socket.remoteAddress) || '?';
}
const isHttps = (req) => req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

// Redirection apres connexion : uniquement un chemin interne (pas d'open redirect).
const safeNext = (n) => (typeof n === 'string' && /^\/(?![/\\])[\x21-\x7e]*$/.test(n) ? n : '/');

function createAuth({ db, listApps = () => [] }) {
  const failures = makeLimiter(15 * 60 * 1000);
  const q = (sql) => db.prepare(sql);

  const accessOf = (userId) => Object.fromEntries(q('SELECT app, role FROM gw_access WHERE user_id = ?').all(userId).map((r) => [r.app, r.role]));
  const roleFor = (user, slug) => (!user ? null : user.isSuper ? 'admin' : (user.access[slug] || null));

  function readCookie(req) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return null;
  }
  function setCookie(req, res, value, maxAge) {
    const parts = [`${COOKIE}=${value}`, 'Path=/', `Max-Age=${Math.floor(maxAge / 1000)}`, 'HttpOnly', 'SameSite=Lax'];
    if (isHttps(req)) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
  }
  function startSession(req, res, userId) {
    const token = crypto.randomBytes(32).toString('base64url'); // nouveau jeton a chaque connexion (pas de fixation)
    const now = Date.now();
    q('DELETE FROM gw_sessions WHERE expires_at < ?').run(now);
    q('INSERT INTO gw_sessions (token_hash, user_id, device, created_at, last_seen, expires_at) VALUES (?,?,?,?,?,?)')
      .run(sha256(token), userId, String(req.headers['user-agent'] || '').slice(0, 120), now, now, now + SESSION_TTL);
    setCookie(req, res, token, SESSION_TTL);
  }

  // Renseigne req.gatewayUser. Toute erreur est avalee : un souci ici ne doit jamais faire tomber un outil.
  function attach(req, res, next) {
    try {
      const token = readCookie(req);
      if (token) {
        const s = q(`SELECT s.expires_at, s.last_seen, u.id, u.login, u.name, u.email, u.is_super
                     FROM gw_sessions s JOIN gw_users u ON u.id = s.user_id
                     WHERE s.token_hash = ? AND u.active = 1`).get(sha256(token));
        if (s && s.expires_at > Date.now()) {
          req.gatewayUser = { id: s.id, login: s.login, name: s.name, email: s.email, isSuper: !!s.is_super, access: accessOf(s.id) };
          if (Date.now() - s.last_seen > 3600 * 1000) {
            q('UPDATE gw_sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?').run(Date.now(), Date.now() + SESSION_TTL, sha256(token));
            setCookie(req, res, token, SESSION_TTL);
          }
        }
      }
    } catch (e) { console.error('[auth] lecture de session :', e.message); }
    next();
  }

  // A mettre devant chaque outil monte : expose req.gateway = { app, user, role }.
  const scope = (slug) => (req, res, next) => {
    const user = req.gatewayUser || null;
    req.gateway = { app: slug, user: user && { id: user.id, login: user.login, name: user.name, email: user.email, isSuper: user.isSuper }, role: roleFor(user, slug) };
    next();
  };

  // ---------- Routes /_gw ----------
  const router = express.Router();
  addPages(router);
  router.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); next(); });
  router.use(express.json({ limit: '20kb' }));

  // Anti-CSRF : requetes qui modifient quelque chose = meme origine uniquement (en plus de SameSite=Lax + JSON).
  router.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.headers.origin;
    if (origin) { try { if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'Origine refusee.' }); } catch (e) { return res.status(403).json({ error: 'Origine refusee.' }); } }
    const site = req.headers['sec-fetch-site'];
    if (site && !['same-origin', 'none'].includes(site)) return res.status(403).json({ error: 'Origine refusee.' });
    // Seul POST peut etre emis par un formulaire d'un autre site ; PUT/PATCH/DELETE exigent un CORS prealable.
    if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'Requete JSON attendue.' });
    next();
  });
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    if (!err.status) console.error('[auth]', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Erreur serveur.' });
  });
  const requireUser = (req, res, next) => (req.gatewayUser ? next() : res.status(401).json({ error: 'Connexion requise.' }));
  const requireSuper = (req, res, next) => (req.gatewayUser && req.gatewayUser.isSuper ? next() : res.status(403).json({ error: 'Reserve a l\'administrateur de la passerelle.' }));
  const pub = (u) => ({ id: u.id, login: u.login, name: u.name, email: u.email, isSuper: !!u.isSuper });

  router.post('/auth/login', wrap(async (req, res) => {
    const login = String((req.body && req.body.login) || '').trim().slice(0, 60);
    const ip = clientIp(req);
    if (failures.count('l:' + login.toLowerCase()) >= 8 || failures.count('ip:' + ip) >= 20) throw Object.assign(new Error('Trop de tentatives. Reessayez dans 15 minutes.'), { status: 429 });
    const u = login ? q('SELECT * FROM gw_users WHERE login = ? AND active = 1').get(login) : null;
    const ok = await verifyPassword(req.body && req.body.password, u && u.password_hash);
    if (!ok || !u) {
      failures.hit('l:' + login.toLowerCase()); failures.hit('ip:' + ip);
      await new Promise((r) => setTimeout(r, 600));
      throw Object.assign(new Error('Identifiant ou mot de passe incorrect.'), { status: 401 });
    }
    startSession(req, res, u.id);
    res.json({ ok: true, user: pub({ ...u, isSuper: u.is_super }), next: safeNext(req.body.next) });
  }));

  router.post('/auth/logout', (req, res) => {
    const token = readCookie(req);
    if (token) q('DELETE FROM gw_sessions WHERE token_hash = ?').run(sha256(token));
    setCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  router.get('/auth/me', (req, res) => {
    const u = req.gatewayUser;
    res.json(u ? { user: pub(u), access: u.isSuper ? Object.fromEntries(listApps().map((a) => [a, 'admin'])) : u.access } : { user: null });
  });

  router.post('/auth/password', requireUser, wrap(async (req, res) => {
    const u = q('SELECT * FROM gw_users WHERE id = ?').get(req.gatewayUser.id);
    if (!(await verifyPassword(req.body.current, u.password_hash))) throw Object.assign(new Error('Mot de passe actuel incorrect.'), { status: 403 });
    q('UPDATE gw_users SET password_hash = ? WHERE id = ?').run(await hashPassword(req.body.next), u.id);
    const keep = sha256(readCookie(req));
    q('DELETE FROM gw_sessions WHERE user_id = ? AND token_hash != ?').run(u.id, keep); // deconnecte les autres appareils
    res.json({ ok: true });
  }));

  // ----- Administration (super-admin) -----
  const listUsers = () => q('SELECT id, login, name, email, is_super, active, created_at FROM gw_users ORDER BY login').all()
    .map((u) => ({ ...pub({ ...u, isSuper: u.is_super }), active: !!u.active, createdAt: u.created_at, access: accessOf(u.id) }));

  router.get('/admin/users', requireSuper, (req, res) => res.json({ users: listUsers(), apps: listApps() }));

  async function createUser({ login, name, email, password, isSuper }) {
    login = String(login || '').trim();
    if (!/^[A-Za-z0-9._-]{2,40}$/.test(login)) throw Object.assign(new Error('Identifiant : 2 a 40 caracteres (lettres, chiffres, . _ -).'), { status: 400 });
    if (q('SELECT 1 FROM gw_users WHERE login = ?').get(login)) throw Object.assign(new Error('Cet identifiant existe deja.'), { status: 409 });
    const r = q('INSERT INTO gw_users (login, name, email, password_hash, is_super, created_at) VALUES (?,?,?,?,?,?)')
      .run(login, String(name || login).trim().slice(0, 80), email ? String(email).trim().slice(0, 120) : null, await hashPassword(password), isSuper ? 1 : 0, Date.now());
    return Number(r.lastInsertRowid);
  }

  router.post('/admin/users', requireSuper, wrap(async (req, res) => { res.json({ ok: true, id: await createUser(req.body || {}) }); }));

  router.patch('/admin/users/:id', requireSuper, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const u = q('SELECT * FROM gw_users WHERE id = ?').get(id);
    if (!u) throw Object.assign(new Error('Compte introuvable.'), { status: 404 });
    const b = req.body || {};
    const superCount = () => q('SELECT COUNT(*) c FROM gw_users WHERE is_super = 1 AND active = 1').get().c;
    if ((b.active === false || b.isSuper === false) && u.is_super && u.active && superCount() <= 1) throw Object.assign(new Error('Il doit rester au moins un administrateur actif.'), { status: 409 });
    if (typeof b.name === 'string') q('UPDATE gw_users SET name = ? WHERE id = ?').run(b.name.trim().slice(0, 80) || u.name, id);
    if (typeof b.email === 'string') q('UPDATE gw_users SET email = ? WHERE id = ?').run(b.email.trim().slice(0, 120) || null, id);
    if (typeof b.isSuper === 'boolean') q('UPDATE gw_users SET is_super = ? WHERE id = ?').run(b.isSuper ? 1 : 0, id);
    if (typeof b.active === 'boolean') { q('UPDATE gw_users SET active = ? WHERE id = ?').run(b.active ? 1 : 0, id); if (!b.active) q('DELETE FROM gw_sessions WHERE user_id = ?').run(id); }
    if (b.password) { q('UPDATE gw_users SET password_hash = ? WHERE id = ?').run(await hashPassword(b.password), id); q('DELETE FROM gw_sessions WHERE user_id = ?').run(id); }
    res.json({ ok: true });
  }));

  router.put('/admin/users/:id/access', requireSuper, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!q('SELECT 1 FROM gw_users WHERE id = ?').get(id)) throw Object.assign(new Error('Compte introuvable.'), { status: 404 });
    const next = req.body && typeof req.body.access === 'object' && req.body.access ? req.body.access : {};
    const apps = new Set(listApps());
    db.exec('BEGIN');
    try {
      q('DELETE FROM gw_access WHERE user_id = ?').run(id);
      for (const [app, role] of Object.entries(next)) {
        if (!role) continue;
        if (!apps.has(app) || !ROLES.includes(role)) throw Object.assign(new Error(`Droit invalide : ${app}`), { status: 400 });
        q('INSERT INTO gw_access (user_id, app, role) VALUES (?,?,?)').run(id, app, role);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.json({ ok: true });
  }));

  router.delete('/admin/users/:id', requireSuper, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const u = q('SELECT * FROM gw_users WHERE id = ?').get(id);
    if (!u) throw Object.assign(new Error('Compte introuvable.'), { status: 404 });
    if (u.is_super && u.active && q('SELECT COUNT(*) c FROM gw_users WHERE is_super = 1 AND active = 1').get().c <= 1) throw Object.assign(new Error('Il doit rester au moins un administrateur actif.'), { status: 409 });
    q('DELETE FROM gw_users WHERE id = ?').run(id);
    res.json({ ok: true });
  }));

  return { attach, scope, router, createUser, hashPassword, verifyPassword, roleFor, db };
}

module.exports = { createAuth, hashPassword, verifyPassword, safeNext, MIN_PASSWORD };
