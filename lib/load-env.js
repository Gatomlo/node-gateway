// Charge <racine>/.env (KEY=valeur, # commentaires) dans process.env, sans ecraser les variables
// deja definies (le manager de l'hebergement reste prioritaire). Aucune dependance.
const fs = require('fs');
const path = require('path');

function parse(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function loadEnv(file = path.join(__dirname, '..', '.env')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return {}; }
  const vars = parse(text);
  for (const [k, v] of Object.entries(vars)) if (process.env[k] === undefined) process.env[k] = v;
  return vars;
}

module.exports = { loadEnv, parse };
