// Page d'accueil de la passerelle : liste des outils montes depuis apps/.
// La grille est rendue cote serveur (la page reste utilisable sans JavaScript) ; le script
// ajoute la recherche, les favoris, "Reprendre" (derniers outils ouverts) et le theme.
// Favoris, recents et theme sont gardes dans le localStorage du navigateur.

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Couleur stable derivee du nom quand l'outil n'en declare pas.
function colorFor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 52% 46%)`;
}

function tileHtml(tool) {
  const inner = tool.icon
    ? `<img src="${esc(tool.icon)}" alt="" loading="lazy">`
    : `<span>${esc(tool.name.charAt(0).toUpperCase())}</span>`;
  return `<span class="tile" style="--c:${esc(tool.color || colorFor(tool.name))}">${inner}</span>`;
}

function cardHtml(tool) {
  const text = `${tool.name} ${tool.description} ${(tool.tags || []).join(' ')}`.toLowerCase();
  const tags = (tool.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  return `
    <article class="card" data-id="${esc(tool.id)}" data-text="${esc(text)}">
      <div class="top">${tileHtml(tool)}
        <button type="button" class="star" data-fav="${esc(tool.id)}" aria-pressed="false" aria-label="Mettre ${esc(tool.name)} en favori">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9 6.8 19.7l1-5.9L3.5 9.7l5.9-.8L12 3.5z"/></svg>
        </button>
      </div>
      <div><h3><a class="stretch" href="${esc(tool.route)}/">${esc(tool.name)}</a></h3>${tool.description ? `<p>${esc(tool.description)}</p>` : ''}</div>
      <div class="foot"><span class="meta"><i class="dot"></i>en ligne${tags}</span>
        <span class="go" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span></div>
    </article>`;
}

const STYLE = `
  :root {
    --bg: #F5F0F3; --surface: #FFFFFF; --surface-2: #FAF6F9; --line: #E6DAE1;
    --fg: #2A1822; --muted: #76616D; --accent: #8A2145; --accent-ink: #FFFFFF; --accent-soft: rgba(138,33,69,.09);
    --ok: #2F7A5E; --shadow: 0 1px 2px rgba(60,20,40,.06), 0 12px 28px -18px rgba(60,20,40,.35);
    --f-display: "Bricolage Grotesque", "Segoe UI", system-ui, sans-serif;
    --f-body: "Instrument Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #160F14; --surface: #221820; --surface-2: #2B1F28; --line: #3D2C37;
      --fg: #F3E9EE; --muted: #B8A3AF; --accent: #E8668C; --accent-ink: #1F0811; --accent-soft: rgba(232,102,140,.16);
      --ok: #66BB9B; --shadow: 0 1px 2px rgba(0,0,0,.4), 0 14px 30px -18px rgba(0,0,0,.8);
      color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
    --bg: #160F14; --surface: #221820; --surface-2: #2B1F28; --line: #3D2C37;
    --fg: #F3E9EE; --muted: #B8A3AF; --accent: #E8668C; --accent-ink: #1F0811; --accent-soft: rgba(232,102,140,.16);
    --ok: #66BB9B; --shadow: 0 1px 2px rgba(0,0,0,.4), 0 14px 30px -18px rgba(0,0,0,.8);
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 400 15px/1.5 var(--f-body); min-height: 100vh; }
  .page {
    max-width: 1040px; margin: 0 auto; display: flex; flex-direction: column; gap: 28px;
    padding: 28px max(16px, env(safe-area-inset-right, 0px)) 56px max(16px, env(safe-area-inset-left, 0px));
  }
  header { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 18px 24px; }
  .hello { min-width: 0; }
  .hello small { display: block; color: var(--muted); font-size: 13px; letter-spacing: .02em; margin-bottom: 4px; text-transform: capitalize; }
  h1 { margin: 0; font: 700 clamp(2rem, 5vw, 3rem)/1.02 var(--f-display); letter-spacing: -.02em; text-wrap: balance; }
  h1 em { font-style: normal; color: var(--accent); }
  .search { position: relative; flex: 1 1 280px; max-width: 420px; }
  .search svg { position: absolute; left: 14px; top: 50%; translate: 0 -50%; width: 18px; height: 18px; stroke: var(--muted); fill: none; stroke-width: 2; stroke-linecap: round; pointer-events: none; }
  .search input {
    width: 100%; height: 48px; padding: 0 52px 0 42px; border-radius: 14px; border: 1px solid var(--line);
    background: var(--surface); color: var(--fg); font: 500 15px var(--f-body); transition: border-color .15s, box-shadow .15s;
  }
  .search input::placeholder { color: var(--muted); }
  .search input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
  .search kbd {
    position: absolute; right: 12px; top: 50%; translate: 0 -50%; font: 600 12px var(--f-body); color: var(--muted);
    border: 1px solid var(--line); border-radius: 6px; padding: 2px 7px; background: var(--surface-2);
  }
  h2 { margin: 0 0 12px; font: 600 12px var(--f-body); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
  .recents { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: thin; }
  .chip {
    flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 14px 8px 8px; border-radius: 14px;
    border: 1px solid var(--line); background: var(--surface); color: var(--fg); text-decoration: none;
    transition: transform .15s, border-color .15s;
  }
  .chip:hover { border-color: var(--accent); transform: translateY(-1px); }
  .chip .tile { width: 34px; height: 34px; border-radius: 10px; font-size: 15px; }
  .chip b { display: block; font-weight: 600; font-size: 14px; line-height: 1.2; }
  .chip .when { display: block; font-size: 12px; color: var(--muted); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 290px), 1fr)); gap: 14px; }
  .card {
    position: relative; display: flex; flex-direction: column; gap: 14px; min-width: 0; padding: 18px; border-radius: 20px;
    border: 1px solid var(--line); background: var(--surface); box-shadow: var(--shadow);
    transition: transform .18s cubic-bezier(.2,.8,.2,1), border-color .18s;
  }
  .card:hover { transform: translateY(-3px); border-color: var(--accent); }
  .card:active { transform: translateY(-1px) scale(.99); }
  .card:focus-within { border-color: var(--accent); }
  .card[hidden] { display: none; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .tile {
    --c: var(--accent); width: 52px; height: 52px; border-radius: 16px; flex: none; display: grid; place-items: center; overflow: hidden;
    background: color-mix(in srgb, var(--c) 16%, var(--surface)); color: var(--c); font: 700 22px var(--f-display);
  }
  .tile img { width: 100%; height: 100%; object-fit: cover; }
  .star {
    position: relative; z-index: 1; width: 36px; height: 36px; border-radius: 10px; border: 0; background: none; color: var(--muted);
    cursor: pointer; display: grid; place-items: center; transition: color .15s, background .15s;
  }
  .star:hover { background: var(--surface-2); color: var(--fg); }
  .star svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linejoin: round; }
  .star[aria-pressed="true"] { color: var(--accent); }
  .star[aria-pressed="true"] svg { fill: currentColor; }
  .card h3 { margin: 0; font: 700 1.25rem/1.15 var(--f-display); letter-spacing: -.01em; }
  .card h3 a { color: inherit; text-decoration: none; }
  .card h3 a:focus-visible { outline: none; }
  .stretch::after { content: ""; position: absolute; inset: 0; border-radius: 20px; }
  .card p { margin: 4px 0 0; color: var(--muted); font-size: 14px; }
  .foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: auto; }
  .meta { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent); }
  .tag { border: 1px solid var(--line); border-radius: 99px; padding: 1px 8px; background: var(--surface-2); }
  .go { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); transition: background .18s, color .18s, translate .18s; }
  .go svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
  .card:hover .go { background: var(--accent); color: var(--accent-ink); translate: 2px 0; }
  .empty { grid-column: 1 / -1; text-align: center; padding: 44px 16px; border: 1px dashed var(--line); border-radius: 20px; color: var(--muted); }
  .empty b { color: var(--fg); }
  .foot-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; color: var(--muted); font-size: 13px; }
  .theme { border: 1px solid var(--line); background: var(--surface); color: var(--fg); border-radius: 10px; padding: 6px 12px; font: 600 13px var(--f-body); cursor: pointer; }
  a:focus-visible, button:focus-visible, .chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  @media (max-width: 520px) { .card { padding: 16px; } .search { max-width: none; } }
`;

// Applique le theme choisi avant le premier affichage (evite un flash clair/sombre).
const THEME_BOOT = `try{var t=localStorage.getItem('gw_theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

const SCRIPT = `
(function () {
  var TOOLS = window.__TOOLS__ || [];
  var $ = function (s) { return document.querySelector(s); };
  function read(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var byId = {}; TOOLS.forEach(function (t) { byId[t.id] = t; });
  var favs = read('gw_favs', []).filter(function (id) { return byId[id]; });
  var recents = read('gw_recents', []).filter(function (r) { return byId[r.id]; });
  var grid = $('#grid'), q = $('#q');
  var cards = [].slice.call(grid.querySelectorAll('.card'));
  var empty = document.createElement('div'); empty.className = 'empty'; empty.hidden = true; grid.appendChild(empty);

  function ago(t) {
    var m = Math.round((Date.now() - t) / 60000);
    if (m < 2) return "à l'instant";
    if (m < 60) return 'il y a ' + m + ' min';
    var h = Math.round(m / 60);
    if (h < 24) return 'il y a ' + h + ' h';
    var d = Math.round(h / 24);
    return d === 1 ? 'hier' : 'il y a ' + d + ' jours';
  }
  function renderRecents() {
    var box = $('#recents');
    $('#recentsSection').hidden = !recents.length;
    box.innerHTML = recents.map(function (r) {
      var t = byId[r.id];
      var tile = '<span class="tile" style="--c:' + esc(t.color) + '">' + (t.icon ? '<img src="' + esc(t.icon) + '" alt="">' : '<span>' + esc(t.name.charAt(0).toUpperCase()) + '</span>') + '</span>';
      return '<a class="chip" href="' + esc(t.route) + '/" data-open="' + esc(t.id) + '">' + tile + '<span><b>' + esc(t.name) + '</b><span class="when">' + ago(r.t) + '</span></span></a>';
    }).join('');
  }
  function apply() {
    var words = q.value.trim().toLowerCase().split(/\\s+/).filter(Boolean);
    var shown = 0;
    cards.sort(function (a, b) {
      var fa = favs.indexOf(a.dataset.id) !== -1, fb = favs.indexOf(b.dataset.id) !== -1;
      return (fb - fa) || (byId[a.dataset.id].name.localeCompare(byId[b.dataset.id].name, 'fr'));
    });
    cards.forEach(function (c) {
      var ok = words.every(function (w) { return c.dataset.text.indexOf(w) !== -1; });
      c.hidden = !ok; if (ok) shown++;
      var fav = favs.indexOf(c.dataset.id) !== -1, star = c.querySelector('.star');
      star.setAttribute('aria-pressed', String(fav));
      star.setAttribute('aria-label', (fav ? 'Retirer ' : 'Mettre ') + byId[c.dataset.id].name + (fav ? ' des favoris' : ' en favori'));
      grid.insertBefore(c, empty);
    });
    var title = $('#allTitle');
    title.textContent = words.length ? shown + ' résultat' + (shown > 1 ? 's' : '') : 'Tous les outils';
    empty.hidden = shown !== 0 || !TOOLS.length;
    if (!empty.hidden) empty.innerHTML = 'Aucun outil ne correspond à <b>« ' + esc(q.value.trim()) + ' »</b>.<br>Essayez un autre mot, ou videz la recherche.';
  }
  document.addEventListener('click', function (e) {
    var star = e.target.closest('[data-fav]');
    if (star) {
      var id = star.getAttribute('data-fav');
      favs = favs.indexOf(id) !== -1 ? favs.filter(function (f) { return f !== id; }) : favs.concat(id);
      write('gw_favs', favs); apply(); return;
    }
    var link = e.target.closest('a[href]');
    var card = e.target.closest('.card');
    var openId = (card && link && card.dataset.id) || (link && link.getAttribute('data-open'));
    if (openId) {
      recents = [{ id: openId, t: Date.now() }].concat(recents.filter(function (r) { return r.id !== openId; })).slice(0, 4);
      write('gw_recents', recents);
    }
  });
  document.addEventListener('keydown', function (e) {
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (e.key === '/' && tag !== 'INPUT') { e.preventDefault(); q.focus(); }
  });
  q.addEventListener('input', apply);
  q.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var first = cards.filter(function (c) { return !c.hidden; })[0]; if (first) first.querySelector('a.stretch').click(); }
    if (e.key === 'Escape') { q.value = ''; apply(); }
  });
  var modes = ['system', 'light', 'dark'];
  var labels = { system: 'Thème : système', light: 'Thème : clair', dark: 'Thème : sombre' };
  var current = 'system'; try { var saved = localStorage.getItem('gw_theme'); if (saved === 'light' || saved === 'dark') current = saved; } catch (e) {}
  var btn = $('#themeBtn'); btn.textContent = labels[current];
  btn.addEventListener('click', function () {
    current = modes[(modes.indexOf(current) + 1) % 3];
    if (current === 'system') { document.documentElement.removeAttribute('data-theme'); try { localStorage.removeItem('gw_theme'); } catch (e) {} }
    else { document.documentElement.setAttribute('data-theme', current); try { localStorage.setItem('gw_theme', current); } catch (e) {} }
    btn.textContent = labels[current];
  });
  var hr = new Date().getHours();
  $('#greet').textContent = hr < 5 || hr >= 18 ? 'Bonsoir' : 'Bonjour';
  $('#date').textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  renderRecents(); apply();
})();
`;

function renderHome(tools) {
  const list = tools.map((t) => ({ ...t, color: t.color || colorFor(t.name) }));
  // Donnees pour le script : "<" echappe pour qu'un nom ne puisse pas fermer la balise <script>.
  const data = JSON.stringify(list).replace(/</g, '\\u003c');
  const cards = list.length
    ? list.map(cardHtml).join('')
    : '<div class="empty">Aucun outil monté pour le moment.<br>Déposez le dossier d\'un outil dans <b>apps/</b> puis redémarrez la passerelle.</div>';
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Outils</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Instrument+Sans:wght@400;500;600&display=swap">
<style>${STYLE}</style>
<script>${THEME_BOOT}</script>
</head>
<body>
<div class="page">
  <header>
    <div class="hello">
      <small id="date"></small>
      <h1><span id="greet">Bonjour</span>, que voulez-vous <em>ouvrir</em> ?</h1>
    </div>
    <label class="search" for="q">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <input id="q" type="search" placeholder="Rechercher un outil" autocomplete="off" aria-label="Rechercher un outil">
      <kbd aria-hidden="true">/</kbd>
    </label>
  </header>
  <section id="recentsSection" aria-labelledby="recentsTitle" hidden>
    <h2 id="recentsTitle">Reprendre</h2>
    <div class="recents" id="recents"></div>
  </section>
  <section aria-labelledby="allTitle">
    <h2 id="allTitle">Tous les outils</h2>
    <div class="grid" id="grid">${cards}</div>
  </section>
  <div class="foot-bar">
    <span>${list.length} outil${list.length > 1 ? 's' : ''} sur cette passerelle</span>
    <button class="theme" id="themeBtn" type="button">Thème : système</button>
  </div>
</div>
<script>window.__TOOLS__ = ${data};</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}

module.exports = { renderHome };
