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
const totp = require('./gw-totp');
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

  // Utilisateur d'une session (ou null) ; sans effet de bord.
  function userFromToken(token) {
    const s = q(`SELECT s.expires_at, s.last_seen, u.id, u.login, u.name, u.email, u.is_super, u.totp_secret
                 FROM gw_sessions s JOIN gw_users u ON u.id = s.user_id
                 WHERE s.token_hash = ? AND u.active = 1`).get(sha256(token));
    if (!s || s.expires_at <= Date.now()) return null;
    return { user: { id: s.id, login: s.login, name: s.name, email: s.email, isSuper: !!s.is_super, twoFactor: !!s.totp_secret, access: accessOf(s.id) }, lastSeen: s.last_seen };
  }

  // Renseigne req.gatewayUser. Toute erreur est avalee : un souci ici ne doit jamais faire tomber un outil.
  function attach(req, res, next) {
    try {
      const token = readCookie(req);
      const found = token ? userFromToken(token) : null;
      if (found) {
        req.gatewayUser = found.user;
        if (Date.now() - found.lastSeen > 3600 * 1000) {
          q('UPDATE gw_sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?').run(Date.now(), Date.now() + SESSION_TTL, sha256(token));
          setCookie(req, res, token, SESSION_TTL);
        }
      }
    } catch (e) { console.error('[auth] lecture de session :', e.message); }
    next();
  }

  // Identite d'une requete qui n'est pas passee par Express (poignee de main Socket.IO d'un outil a temps reel).
  // Meme forme que req.gateway : { app, user, role }. Fournie aux outils par attachToServer(..., { identify }).
  function identify(req, slug) {
    try {
      const token = readCookie(req);
      const found = token ? userFromToken(token) : null;
      const u = found && found.user;
      return { app: slug, user: u && { id: u.id, login: u.login, name: u.name, email: u.email, isSuper: u.isSuper }, role: roleFor(u, slug) };
    } catch (e) { return { app: slug, user: null, role: null }; }
  }

  // Journal d'audit : connexions, echecs, actions d'administration, 2FA. Jamais de mot de passe ni de code dedans.
  function audit(req, action, { target = null, detail = null, actor } = {}) {
    try {
      const a = actor || req.gatewayUser || {};
      q('INSERT INTO gw_audit (at, actor_id, actor, action, target, detail, ip) VALUES (?,?,?,?,?,?,?)')
        .run(Date.now(), a.id || null, a.login || null, action, target == null ? null : String(target).slice(0, 120), detail == null ? null : String(detail).slice(0, 300), clientIp(req));
      if (Math.random() < 0.01) q('DELETE FROM gw_audit WHERE at < ?').run(Date.now() - 400 * 24 * 3600 * 1000);
    } catch (e) { console.error('[auth] journal :', e.message); }
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
    res.status(err.status || 500).json(Object.assign({ error: err.status ? err.message : 'Erreur serveur.' }, err.needs2fa ? { needs2fa: true } : {}));
  });
  const requireUser = (req, res, next) => (req.gatewayUser ? next() : res.status(401).json({ error: 'Connexion requise.' }));
  const requireSuper = (req, res, next) => {
    if (!(req.gatewayUser && req.gatewayUser.isSuper)) return res.status(403).json({ error: 'Reserve a l\'administrateur de la passerelle.' });
    if (process.env.GATEWAY_REQUIRE_2FA === '1' && !req.gatewayUser.twoFactor) return res.status(403).json({ error: 'Activez d\'abord la double authentification sur /_gw/account.', needs2faSetup: true });
    next();
  };

  // Confirmation du mot de passe de l'administrateur pour toute action sensible (creation / droits / suppression).
  // Une session volee ou une faille XSS dans un outil ne suffit donc pas a prendre le controle des comptes.
  async function reauth(req) {
    const id = req.gatewayUser.id;
    if (failures.count('re:' + id) >= 5) throw Object.assign(new Error('Trop d\'echecs de confirmation. Reessayez dans 15 minutes.'), { status: 429 });
    const u = q('SELECT password_hash FROM gw_users WHERE id = ?').get(id);
    if (!(await verifyPassword(req.body && req.body.reauth, u && u.password_hash))) {
      failures.hit('re:' + id);
      audit(req, 'reauth.echec');
      await new Promise((r) => setTimeout(r, 600));
      throw Object.assign(new Error('Confirmation du mot de passe incorrecte.'), { status: 403 });
    }
  }
  const pub = (u) => ({ id: u.id, login: u.login, name: u.name, email: u.email, isSuper: !!u.isSuper });

  router.post('/auth/login', wrap(async (req, res) => {
    const login = String((req.body && req.body.login) || '').trim().slice(0, 60);
    const ip = clientIp(req);
    if (failures.count('l:' + login.toLowerCase()) >= 8 || failures.count('ip:' + ip) >= 20) throw Object.assign(new Error('Trop de tentatives. Reessayez dans 15 minutes.'), { status: 429 });
    const u = login ? q('SELECT * FROM gw_users WHERE login = ? AND active = 1').get(login) : null;
    const ok = await verifyPassword(req.body && req.body.password, u && u.password_hash);
    if (!ok || !u) {
      failures.hit('l:' + login.toLowerCase()); failures.hit('ip:' + ip);
      audit(req, 'connexion.echec', { actor: { id: u ? u.id : null, login: login || null }, detail: 'mot de passe' });
      await new Promise((r) => setTimeout(r, 600));
      throw Object.assign(new Error('Identifiant ou mot de passe incorrect.'), { status: 401 });
    }
    if (u.totp_secret) {
      const given = req.body && req.body.code;
      if (!given) return res.status(401).json({ error: 'Code de verification requis.', needs2fa: true });
      const step = totp.verify(u.totp_secret, given, Date.now(), u.totp_last);
      if (step === null) {
        failures.hit('l:' + login.toLowerCase()); failures.hit('ip:' + ip);
        audit(req, 'connexion.echec', { actor: { id: u.id, login: u.login }, detail: 'code 2FA incorrect' });
        await new Promise((r) => setTimeout(r, 600));
        throw Object.assign(new Error('Code de verification incorrect.'), { status: 401, needs2fa: true });
      }
      q('UPDATE gw_users SET totp_last = ? WHERE id = ?').run(step, u.id); // un code ne sert qu'une fois
    }
    startSession(req, res, u.id);
    audit(req, 'connexion', { actor: { id: u.id, login: u.login } });
    res.json({ ok: true, user: pub({ ...u, isSuper: u.is_super }), next: safeNext(req.body.next) });
  }));

  router.post('/auth/logout', (req, res) => {
    if (req.gatewayUser) audit(req, 'deconnexion');
    const token = readCookie(req);
    if (token) q('DELETE FROM gw_sessions WHERE token_hash = ?').run(sha256(token));
    setCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  router.get('/auth/me', (req, res) => {
    const u = req.gatewayUser;
    res.json(u ? { user: Object.assign(pub(u), { twoFactor: !!u.twoFactor }), access: u.isSuper ? Object.fromEntries(listApps().map((a) => [a, 'admin'])) : u.access } : { user: null });
  });

  router.post('/auth/password', requireUser, wrap(async (req, res) => {
    const u = q('SELECT * FROM gw_users WHERE id = ?').get(req.gatewayUser.id);
    if (!(await verifyPassword(req.body.current, u.password_hash))) throw Object.assign(new Error('Mot de passe actuel incorrect.'), { status: 403 });
    q('UPDATE gw_users SET password_hash = ? WHERE id = ?').run(await hashPassword(req.body.next), u.id);
    const keep = sha256(readCookie(req));
    q('DELETE FROM gw_sessions WHERE user_id = ? AND token_hash != ?').run(u.id, keep); // deconnecte les autres appareils
    audit(req, 'mot-de-passe.change');
    res.json({ ok: true });
  }));

  // ----- Administration (super-admin) -----
  const listUsers = () => q('SELECT id, login, name, email, is_super, active, created_at, totp_secret FROM gw_users ORDER BY login').all()
    .map((u) => ({ ...pub({ ...u, isSuper: u.is_super }), active: !!u.active, createdAt: u.created_at, twoFactor: !!u.totp_secret, access: accessOf(u.id) }));

  router.get('/admin/users', requireSuper, (req, res) => res.json({ users: listUsers(), apps: listApps() }));

  async function createUser({ login, name, email, password, isSuper }) {
    login = String(login || '').trim();
    if (!/^[A-Za-z0-9._-]{2,40}$/.test(login)) throw Object.assign(new Error('Identifiant : 2 a 40 caracteres (lettres, chiffres, . _ -).'), { status: 400 });
    if (q('SELECT 1 FROM gw_users WHERE login = ?').get(login)) throw Object.assign(new Error('Cet identifiant existe deja.'), { status: 409 });
    const r = q('INSERT INTO gw_users (login, name, email, password_hash, is_super, created_at) VALUES (?,?,?,?,?,?)')
      .run(login, String(name || login).trim().slice(0, 80), email ? String(email).trim().slice(0, 120) : null, await hashPassword(password), isSuper ? 1 : 0, Date.now());
    return Number(r.lastInsertRowid);
  }

  router.post('/admin/users', requireSuper, wrap(async (req, res) => {
    await reauth(req);
    const id = await createUser(req.body || {});
    audit(req, 'compte.cree', { target: String((req.body || {}).login || ''), detail: (req.body || {}).isSuper ? 'administrateur de la passerelle' : null });
    res.json({ ok: true, id });
  }));

  router.patch('/admin/users/:id', requireSuper, wrap(async (req, res) => {
    await reauth(req);
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
    audit(req, 'compte.modifie', { target: u.login, detail: Object.keys(b).filter((k) => k !== 'reauth' && k !== 'password').join(',') + (b.password ? ',mot-de-passe' : '') });
    res.json({ ok: true });
  }));

  router.put('/admin/users/:id/access', requireSuper, wrap(async (req, res) => {
    await reauth(req);
    const id = Number(req.params.id);
    const target = q('SELECT login FROM gw_users WHERE id = ?').get(id);
    if (!target) throw Object.assign(new Error('Compte introuvable.'), { status: 404 });
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
    audit(req, 'droits.modifies', { target: target.login, detail: Object.entries(next).filter(([, r]) => r).map(([a, r]) => a + ':' + r).join(' ') || 'aucun' });
    res.json({ ok: true });
  }));

  router.delete('/admin/users/:id', requireSuper, wrap(async (req, res) => {
    await reauth(req);
    const id = Number(req.params.id);
    const u = q('SELECT * FROM gw_users WHERE id = ?').get(id);
    if (!u) throw Object.assign(new Error('Compte introuvable.'), { status: 404 });
    if (u.is_super && u.active && q('SELECT COUNT(*) c FROM gw_users WHERE is_super = 1 AND active = 1').get().c <= 1) throw Object.assign(new Error('Il doit rester au moins un administrateur actif.'), { status: 409 });
    q('DELETE FROM gw_users WHERE id = ?').run(id);
    audit(req, 'compte.supprime', { target: u.login });
    res.json({ ok: true });
  }));

  // ----- Double authentification (TOTP) -----
  const selfRow = (req) => q('SELECT * FROM gw_users WHERE id = ?').get(req.gatewayUser.id);

  // Etape 1 : mot de passe -> secret + adresse otpauth:// (a saisir ou scanner dans l'application d'authentification).
  router.post('/auth/2fa/setup', requireUser, wrap(async (req, res) => {
    const u = selfRow(req);
    if (u.totp_secret) throw Object.assign(new Error('La double authentification est deja activee.'), { status: 409 });
    if (!(await verifyPassword(req.body && req.body.password, u.password_hash))) throw Object.assign(new Error('Mot de passe incorrect.'), { status: 403 });
    const secret = totp.newSecret();
    q('UPDATE gw_users SET totp_pending = ? WHERE id = ?').run(secret, u.id);
    res.json({ secret, uri: totp.uri(secret, u.login) });
  }));

  // Etape 2 : un code valide prouve que l'application est bien configuree.
  router.post('/auth/2fa/enable', requireUser, wrap(async (req, res) => {
    const u = selfRow(req);
    if (!u.totp_pending) throw Object.assign(new Error('Demarrez d\'abord la configuration.'), { status: 409 });
    if (failures.count('2fa:' + u.id) >= 8) throw Object.assign(new Error('Trop d\'essais. Reessayez dans 15 minutes.'), { status: 429 });
    const step = totp.verify(u.totp_pending, req.body && req.body.code, Date.now(), 0);
    if (step === null) { failures.hit('2fa:' + u.id); throw Object.assign(new Error('Code incorrect.'), { status: 400 }); }
    q('UPDATE gw_users SET totp_secret = totp_pending, totp_pending = NULL, totp_last = ? WHERE id = ?').run(step, u.id);
    audit(req, '2fa.active');
    res.json({ ok: true });
  }));

  router.post('/auth/2fa/disable', requireUser, wrap(async (req, res) => {
    const u = selfRow(req);
    if (!u.totp_secret) throw Object.assign(new Error('La double authentification n\'est pas activee.'), { status: 409 });
    if (failures.count('2fa:' + u.id) >= 8) throw Object.assign(new Error('Trop d\'essais. Reessayez dans 15 minutes.'), { status: 429 });
    const okPw = await verifyPassword(req.body && req.body.password, u.password_hash);
    const step = okPw ? totp.verify(u.totp_secret, req.body && req.body.code, Date.now(), u.totp_last) : null;
    if (!okPw || step === null) { failures.hit('2fa:' + u.id); throw Object.assign(new Error('Mot de passe ou code incorrect.'), { status: 403 }); }
    q('UPDATE gw_users SET totp_secret = NULL, totp_pending = NULL, totp_last = 0 WHERE id = ?').run(u.id);
    audit(req, '2fa.desactive');
    res.json({ ok: true });
  }));

  // Perte du telephone : l'administrateur reinitialise la 2FA d'un compte (ou `npm run user -- reset2fa <identifiant>` en SSH).
  router.post('/admin/users/:id/2fa/reset', requireSuper, wrap(async (req, res) => {
    await reauth(req);
    const id = Number(req.params.id);
    const t = q('SELECT login FROM gw_users WHERE id = ?').get(id);
    if (!t) throw Object.assign(new Error('Compte introuvable.'), { status: 404 });
    q('UPDATE gw_users SET totp_secret = NULL, totp_pending = NULL, totp_last = 0 WHERE id = ?').run(id);
    q('DELETE FROM gw_sessions WHERE user_id = ?').run(id);
    audit(req, '2fa.reinitialise', { target: t.login });
    res.json({ ok: true });
  }));

  router.get('/admin/audit', requireSuper, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    res.json({ events: q('SELECT id, at, actor, action, target, detail, ip FROM gw_audit ORDER BY id DESC LIMIT ?').all(limit) });
  });

  return { attach, scope, identify, router, createUser, hashPassword, verifyPassword, roleFor, db };
}

module.exports = { createAuth, hashPassword, verifyPassword, safeNext, MIN_PASSWORD };
