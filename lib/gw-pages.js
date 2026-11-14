// Pages de la passerelle (/_gw/login, /_gw/account, /_gw/admin) : HTML statique + un script externe
// (CSP stricte : aucun script en ligne). Tout le texte dynamique passe par textContent.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const CSS = `
:root{--bg:#f6f5f1;--fg:#1d1d1b;--muted:#6b6a64;--card:#fff;--line:#e2e0d8;--acc:#065f46;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#eeeae0;--muted:#a09d92;--card:#1f1f1c;--line:#34332e;--acc:#34d399;--bad:#f97066}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;padding:16px}
main{max-width:760px;margin:6vh auto}h1{font-size:1.4rem;margin:0 0 16px}h2{font-size:1.05rem;margin:24px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px}
label{display:block;font-size:.85rem;color:var(--muted);margin:10px 0 4px}
input,select{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
button{padding:10px 16px;border:0;border-radius:8px;background:var(--acc);color:#fff;font:inherit;cursor:pointer;margin-top:12px}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}button.bad{background:var(--bad)}
.err{color:var(--bad);min-height:1.4em;margin-top:8px}.ok{color:var(--acc)}.muted{color:var(--muted);font-size:.9rem}
table{width:100%;border-collapse:collapse}td,th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;font-size:.92rem}
.row{display:flex;gap:8px;flex-wrap:wrap}.row>*{flex:1 1 140px}.tag{font-size:.75rem;border:1px solid var(--line);border-radius:6px;padding:1px 6px}
`;

const shell = (title, page, body) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>${CSS}</style></head><body data-page="${page}"><main>${body}</main><script src="/_gw/gw.js"></script></body></html>`;

const LOGIN = shell('Connexion', 'login', `<div class="card"><h1>Connexion</h1>
<form id="f"><label for="login">Identifiant</label><input id="login" autocomplete="username" required>
<label for="pw">Mot de passe</label><input id="pw" type="password" autocomplete="current-password" required>
<div id="codebox" hidden><label for="code">Code de vérification (application d'authentification)</label><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8"></div>
<button>Se connecter</button><div class="err" id="err" role="alert"></div></form></div>`);

const ACCOUNT = shell('Mon compte', 'account', `<div class="card"><h1 id="who">Mon compte</h1><div id="apps" class="muted"></div>
<h2>Changer de mot de passe</h2><form id="f"><label for="cur">Mot de passe actuel</label><input id="cur" type="password" autocomplete="current-password" required>
<label for="nw">Nouveau (12 caractères minimum)</label><input id="nw" type="password" autocomplete="new-password" required>
<button>Changer</button><div class="err" id="err" role="alert"></div></form>
<h2>Double authentification</h2><div id="tfa" class="muted">…</div>
<div class="row"><button class="ghost" id="out">Se déconnecter</button><a href="/" style="align-self:end;padding:10px">← Accueil</a></div></div>`);

const ADMIN = shell('Comptes', 'admin', `<div class="card"><h1>Comptes de la passerelle</h1><div id="msg" class="err" role="alert"></div><div id="list"></div>
<p class="muted">Chaque modification demande la confirmation de <b>votre</b> mot de passe.</p></div>
<div class="card"><h2>Nouveau compte</h2><form id="f"><div class="row"><div><label for="nl">Identifiant</label><input id="nl" required></div><div><label for="nn">Nom affiché</label><input id="nn"></div></div>
<div class="row"><div><label for="ne">E-mail (facultatif)</label><input id="ne" type="email"></div><div><label for="np">Mot de passe initial (12 min.)</label><input id="np" type="password" autocomplete="new-password" required></div></div>
<label><input id="ns" type="checkbox" style="width:auto"> Administrateur de la passerelle (tous les droits, gère les comptes)</label><button>Créer</button></form>
<p class="muted">Droits par outil : <b>admin</b> = gère l'outil, <b>membre</b> = utilisateur simple, vide = aucun droit (les pages publiques restent accessibles).</p></div>
<div class="card"><h2>Journal d'audit</h2><div id="audit" class="muted">…</div></div>`);

const JS = `(()=>{'use strict';
const $=(i)=>document.getElementById(i);
const api=async(m,u,b)=>{const r=await fetch('/_gw'+u,{method:m,headers:b?{'Content-Type':'application/json'}:{},body:b?JSON.stringify(b):undefined,credentials:'same-origin'});let j={};try{j=await r.json()}catch(e){}if(!r.ok){const e=new Error(j.error||('Erreur '+r.status));e.data=j;throw e}return j};
const el=(t,props,...kids)=>{const e=document.createElement(t);Object.assign(e,props||{});for(const k of kids)e.append(k);return e};
const page=document.body.dataset.page;
if(page==='login'){
  $('f').addEventListener('submit',async(ev)=>{ev.preventDefault();$('err').textContent='';
    try{const j=await api('POST','/auth/login',{login:$('login').value,password:$('pw').value,code:$('code').value||undefined,next:new URLSearchParams(location.search).get('next')||'/'});location.href=j.next||'/'}
    catch(e){if(e.data&&e.data.needs2fa){$('codebox').hidden=false;$('code').focus()}$('err').textContent=e.message}});
}
if(page==='account'){
  const showTfa=(u)=>{const box=$('tfa');box.replaceChildren();
    if(u.twoFactor){
      const pw=el('input',{type:'password',placeholder:'Mot de passe',autocomplete:'current-password'}),code=el('input',{placeholder:'Code à 6 chiffres',inputMode:'numeric'}),err=el('div',{className:'err'});
      box.append(el('p',{textContent:'Activée : un code est demandé à chaque connexion.'}),pw,code,
        el('button',{className:'ghost',textContent:'Désactiver',onclick:async()=>{try{await api('POST','/auth/2fa/disable',{password:pw.value,code:code.value});location.reload()}catch(e){err.textContent=e.message}}}),err);
    }else{
      const pw=el('input',{type:'password',placeholder:'Mot de passe',autocomplete:'current-password'}),err=el('div',{className:'err'});
      box.append(el('p',{textContent:'Non activée. Recommandé pour les comptes qui gèrent des outils.'}),pw,
        el('button',{textContent:'Activer',onclick:async()=>{err.textContent='';try{const j=await api('POST','/auth/2fa/setup',{password:pw.value});
          const code=el('input',{placeholder:'Code à 6 chiffres',inputMode:'numeric'});
          box.replaceChildren(el('p',{textContent:'1) Dans votre application d\\'authentification (Google Authenticator, Aegis, Bitwarden…), ajoutez un compte avec cette clé :'}),
            el('code',{textContent:j.secret,style:'user-select:all;word-break:break-all'}),el('p',{className:'muted'},'ou ouvrez ',el('a',{href:j.uri,textContent:'ce lien'}),' sur le téléphone.'),
            el('p',{textContent:'2) Saisissez le code affiché pour confirmer :'}),code,
            el('button',{textContent:'Confirmer',onclick:async()=>{try{await api('POST','/auth/2fa/enable',{code:code.value});location.reload()}catch(e){err2.textContent=e.message}}}));
          var err2=el('div',{className:'err'});box.append(err2)}catch(e){err.textContent=e.message}}}),err);
    }};
  api('GET','/auth/me').then((j)=>{if(!j.user){location.href='/_gw/login?next=/_gw/account';return}
    $('who').textContent=j.user.name+(j.user.isSuper?' (administrateur)':'');
    const a=Object.entries(j.access||{});$('apps').textContent=a.length?'Droits : '+a.map(([k,v])=>k+' ('+v+')').join(', '):'Aucun droit par outil.';
    if(j.user.isSuper){$('apps').append(' ',el('a',{href:'/_gw/admin',textContent:'→ Gérer les comptes'}))}
    showTfa(j.user)});
  $('f').addEventListener('submit',async(ev)=>{ev.preventDefault();$('err').className='err';$('err').textContent='';
    try{await api('POST','/auth/password',{current:$('cur').value,next:$('nw').value});$('err').className='err ok';$('err').textContent='Mot de passe changé.';$('f').reset()}catch(e){$('err').textContent=e.message}});
  $('out').addEventListener('click',async()=>{await api('POST','/auth/logout',{});location.href='/_gw/login'});
}
if(page==='admin'){
  const msg=(t,ok)=>{$('msg').className=ok?'err ok':'err';$('msg').textContent=t};
  // Toute action sensible demande le mot de passe de l'administrateur connecte (jamais garde en memoire).
  const act=async(fn,okMsg)=>{const pw=prompt('Confirmez avec VOTRE mot de passe administrateur :');if(pw===null||pw==='')return;
    try{await fn(pw);msg(okMsg||'Enregistré.',true);await load()}catch(e){msg(e.message)}};
  const when=(t)=>new Date(t).toLocaleString('fr-FR');
  async function loadAudit(){try{const j=await api('GET','/admin/audit?limit=60');const tb=el('tbody');
    for(const e of j.events)tb.append(el('tr',{},el('td',{textContent:when(e.at)}),el('td',{textContent:e.actor||'—'}),el('td',{textContent:e.action}),el('td',{textContent:[e.target,e.detail].filter(Boolean).join(' · ')}),el('td',{textContent:e.ip||''})));
    $('audit').replaceChildren(el('table',{},el('thead',{},el('tr',{},el('th',{textContent:'Quand'}),el('th',{textContent:'Qui'}),el('th',{textContent:'Action'}),el('th',{textContent:'Détail'}),el('th',{textContent:'IP'}))),tb))}catch(e){$('audit').textContent=e.message}}
  async function load(){
    let j;try{j=await api('GET','/admin/users')}catch(e){if(/Connexion/.test(e.message)){location.href='/_gw/login?next=/_gw/admin';return}$('list').textContent=e.message;return}
    const tb=el('tbody');
    for(const u of j.users){
      const sels={};const cell=el('td');
      for(const app of j.apps){const s=el('select',{},el('option',{value:'',textContent:'—'}),el('option',{value:'member',textContent:'membre'}),el('option',{value:'admin',textContent:'admin'}));s.value=u.access[app]||'';sels[app]=s;
        cell.append(el('div',{className:'row'},el('span',{textContent:app}),s))}
      const buttons=el('td',{},
        el('button',{className:'ghost',textContent:'Enregistrer les droits',onclick:()=>act((pw)=>api('PUT','/admin/users/'+u.id+'/access',{access:Object.fromEntries(Object.entries(sels).map(([k,s])=>[k,s.value||null])),reauth:pw}))}),
        el('button',{className:'ghost',textContent:'Nouveau mot de passe',onclick:()=>{const p=prompt('Nouveau mot de passe pour '+u.login+' (12 caractères minimum). Ses sessions seront fermées.');if(p)act((pw)=>api('PATCH','/admin/users/'+u.id,{password:p,reauth:pw}),'Mot de passe changé.')}}),
        el('button',{className:'ghost',textContent:u.active?'Désactiver':'Réactiver',onclick:()=>act((pw)=>api('PATCH','/admin/users/'+u.id,{active:!u.active,reauth:pw}))}),
        el('button',{className:'ghost',textContent:u.isSuper?'Retirer admin passerelle':'Rendre admin passerelle',onclick:()=>act((pw)=>api('PATCH','/admin/users/'+u.id,{isSuper:!u.isSuper,reauth:pw}))}),
        u.twoFactor?el('button',{className:'ghost',textContent:'Réinitialiser la 2FA',onclick:()=>act((pw)=>api('POST','/admin/users/'+u.id+'/2fa/reset',{reauth:pw}),'2FA réinitialisée.')}):'',
        el('button',{className:'bad',textContent:'Supprimer',onclick:()=>{if(confirm('Supprimer définitivement '+u.login+' ?'))act((pw)=>api('DELETE','/admin/users/'+u.id,{reauth:pw}),'Compte supprimé.')}}));
      const who=el('td',{},el('b',{textContent:u.name}),el('div',{className:'muted',textContent:u.login+(u.email?' · '+u.email:'')}));
      if(u.isSuper)who.append(el('span',{className:'tag',textContent:'admin passerelle'}));if(!u.active)who.append(el('span',{className:'tag',textContent:'désactivé'}));who.append(el('span',{className:'tag',textContent:u.twoFactor?'2FA':'sans 2FA'}));
      tb.append(el('tr',{},who,cell,buttons));
    }
    $('list').replaceChildren(el('table',{},el('thead',{},el('tr',{},el('th',{textContent:'Compte'}),el('th',{textContent:'Droits par outil'}),el('th',{textContent:'Actions'}))),tb));
    loadAudit();
  }
  $('f').addEventListener('submit',(ev)=>{ev.preventDefault();act((pw)=>api('POST','/admin/users',{login:$('nl').value,name:$('nn').value,email:$('ne').value,password:$('np').value,isSuper:$('ns').checked,reauth:pw}).then(()=>$('f').reset()),'Compte créé : donnez-lui ses droits dans le tableau.')});
  load();
}
})();`;

function addPages(router) {
  const send = (html) => (req, res) => { res.set('Content-Security-Policy', CSP); res.type('html').send(html); };
  router.get('/login', send(LOGIN));
  router.get('/account', send(ACCOUNT));
  router.get('/admin', send(ADMIN));
  router.get('/gw.js', (req, res) => res.type('js').send(JS));
}

module.exports = { addPages };
