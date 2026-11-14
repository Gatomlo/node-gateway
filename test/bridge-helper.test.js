// Module commun de rattachement (docs/gateway-bridge.js, copie dans chaque outil) : compte local choisi par
// l'administrateur de la passerelle > e-mail identique > identifiant identique. Jamais plus d'un compte.
const assert = require('assert');
const { identity, matchLocal, behindGateway } = require('../docs/gateway-bridge');

const req = (user, role, local) => ({ gateway: { app: 'x', user, role, local } });
const U = { login: 'thomas', name: 'Thomas', email: 'thomas@perso.be' };
const rows = [
  { id: 1, email: 'thomas@perso.be', username: 'tom' },
  { id: 2, email: 'autre@ex.be', username: 'thomas' },
  { id: 3, email: 'famille@ex.be', username: 'papa' },
];

assert.strictEqual(behindGateway({}), false);
assert.strictEqual(behindGateway(req(null, null)), true);
assert.strictEqual(identity(req(null, null)), null);
assert.strictEqual(identity(req(U, null)), null, 'sans droit : pas d\'identite');
assert.strictEqual(identity(req(U, 'member'), 'admin'), null);
assert.strictEqual(identity(req(U, 'admin', 'papa')).local, 'papa');

// sans choix explicite : e-mail d'abord, puis identifiant (comportement historique)
assert.strictEqual(matchLocal(identity(req(U, 'member')), rows).id, 1);
assert.strictEqual(matchLocal(identity(req({ ...U, email: '' }, 'member')), rows).id, 2);

// choix explicite : par identifiant OU par e-mail du compte local, meme si rien ne ressemble a l'identite
assert.strictEqual(matchLocal(identity(req(U, 'member', 'papa')), rows).id, 3, 'identifiant local');
assert.strictEqual(matchLocal(identity(req(U, 'member', 'FAMILLE@ex.be')), rows).id, 3, 'e-mail local, casse ignoree');
// le choix explicite l'emporte sur l'egalite d'e-mail
assert.strictEqual(matchLocal(identity(req(U, 'member', 'papa')), rows).id, 3);
// choix explicite introuvable : AUCUN repli (sinon une faute de frappe ouvrirait un autre compte)
assert.strictEqual(matchLocal(identity(req(U, 'member', 'inconnu')), rows), null);
// ambigu : jamais plus d'un compte
assert.strictEqual(matchLocal(identity(req(U, 'member', 'thomas')), [...rows, { id: 4, email: 'x@ex.be', username: 'thomas' }]), null);
// colonnes absentes (outil a e-mail seulement / identifiant seulement)
assert.strictEqual(matchLocal(identity(req(U, 'member', 'papa')), rows, { email: null, login: 'username' }).id, 3);
assert.strictEqual(matchLocal(identity(req(U, 'member', 'papa')), rows, { email: 'email', login: null }), null);
console.log('bridge-helper OK');
