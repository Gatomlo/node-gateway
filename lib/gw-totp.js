'use strict';
// Double authentification TOTP (RFC 6238, SHA-1, 6 chiffres, pas de 30 s), sans dependance : module crypto natif.
// Compatible Google Authenticator, Aegis, 1Password, Bitwarden, etc.
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_S = 30;

function toBase32(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function fromBase32(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of String(str).toUpperCase().replace(/=+$/, '')) {
    const i = ALPHABET.indexOf(ch); if (i < 0) throw new Error('secret invalide');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(secret, counter, digits = 6) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

const newSecret = () => toBase32(crypto.randomBytes(20));
const code = (secretB32, now = Date.now(), digits = 6) => hotp(fromBase32(secretB32), Math.floor(now / 1000 / STEP_S), digits);

// Retourne le numero de pas accepte (a memoriser : un meme code ne sert qu'une fois), ou null.
// Tolerance : un pas avant / apres (decalage d'horloge). `lastStep` : dernier pas deja utilise.
function verify(secretB32, input, now = Date.now(), lastStep = 0) {
  const given = String(input || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const secret = fromBase32(secretB32);
  const current = Math.floor(now / 1000 / STEP_S);
  let found = null;
  for (const d of [-1, 0, 1]) {
    const step = current + d;
    const ok = crypto.timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(given)) && step > lastStep; // pas de court-circuit
    if (ok && found === null) found = step;
  }
  return found;
}

const uri = (secret, label, issuer = 'Passerelle') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_S}`;

module.exports = { newSecret, code, verify, uri, toBase32, fromBase32, hotp };
