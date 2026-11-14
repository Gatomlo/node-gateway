#!/usr/bin/env node
// Gestion des comptes de la passerelle en SSH (le premier compte ne peut PAS se creer par le web).
//   npm run user -- create <identifiant> [--super] [--name "Nom"] [--email x@y.z]
//   npm run user -- passwd <identifiant>
//   npm run user -- reset2fa <identifiant>   (perte du telephone : desactive la double authentification)
//   npm run user -- list
// Le mot de passe est demande en saisie masquee (ou lu sur stdin s'il est redirige).
require('../lib/load-env').loadEnv();
const readline = require('readline');
const { openGatewayDb } = require('../lib/gw-db');
const { createAuth } = require('../lib/gw-auth');

function askHidden(label) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { // entree redirigee : premiere ligne de stdin
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', () => resolve(data.split(/\r?\n/)[0]));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(`${label} (saisie masquee) : `);
    const orig = rl._writeToOutput; rl._writeToOutput = () => {};
    rl.question('', (a) => { rl._writeToOutput = orig; process.stdout.write('\n'); rl.close(); resolve(a); });
  });
}
const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

(async () => {
  const [cmd, login, ...rest] = process.argv.slice(2);
  const db = openGatewayDb();
  const auth = createAuth({ db });
  if (cmd === 'list') {
    for (const u of db.prepare('SELECT login, name, email, is_super, active FROM gw_users ORDER BY login').all()) {
      const acc = db.prepare('SELECT app, role FROM gw_access a JOIN gw_users u ON u.id = a.user_id WHERE u.login = ?').all(u.login).map((a) => `${a.app}:${a.role}`).join(' ');
      console.log(`${u.login}\t${u.name}\t${u.is_super ? 'ADMIN-PASSERELLE' : ''}\t${u.active ? '' : 'DESACTIVE'}\t${acc}`);
    }
  } else if (cmd === 'create' && login) {
    const pw = await askHidden('Mot de passe (12 caracteres minimum)');
    const id = await auth.createUser({ login, name: flag(rest, '--name') || login, email: flag(rest, '--email'), password: pw, isSuper: rest.includes('--super') });
    console.log(`Compte "${login}" cree (#${id})${rest.includes('--super') ? ' avec les droits d\'administrateur de la passerelle' : ''}. Les droits par outil se donnent sur /_gw/admin.`);
  } else if (cmd === 'passwd' && login) {
    const u = db.prepare('SELECT id FROM gw_users WHERE login = ?').get(login);
    if (!u) throw new Error('compte introuvable');
    const hash = await auth.hashPassword(await askHidden('Nouveau mot de passe (12 caracteres minimum)'));
    db.prepare('UPDATE gw_users SET password_hash = ? WHERE id = ?').run(hash, u.id);
    db.prepare('DELETE FROM gw_sessions WHERE user_id = ?').run(u.id);
    console.log('Mot de passe change, sessions fermees.');
  } else if (cmd === 'reset2fa' && login) {
    const u = db.prepare('SELECT id FROM gw_users WHERE login = ?').get(login);
    if (!u) throw new Error('compte introuvable');
    db.prepare('UPDATE gw_users SET totp_secret = NULL, totp_pending = NULL, totp_last = 0 WHERE id = ?').run(u.id);
    db.prepare('DELETE FROM gw_sessions WHERE user_id = ?').run(u.id);
    db.prepare('INSERT INTO gw_audit (at, actor, action, target, detail) VALUES (?,?,?,?,?)').run(Date.now(), 'ssh', '2fa.reinitialise', login, 'npm run user -- reset2fa');
    console.log('Double authentification desactivee, sessions fermees.');
  } else {
    console.log('Usage : npm run user -- create <identifiant> [--super] [--name "Nom"] [--email x@y.z] | passwd <identifiant> | reset2fa <identifiant> | list');
    process.exitCode = 1;
  }
})().catch((e) => { console.error('Erreur :', e.message); process.exit(1); });
