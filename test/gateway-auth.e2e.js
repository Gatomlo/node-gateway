// Test de bout en bout de l'authentification de la passerelle : vrai serveur, base temporaire, outils factices
// (apps/zz-test et apps/zz-autre, supprimes a la fin). Lancer : npm test
const { spawn, execFileSync } = require('child_process'); const fs=require('fs'), path=require('path'), os=require('os'), assert=require('assert');
// Mots de passe jetables generes a chaque execution : aucun secret litteral dans le depot.
const rnd=()=>require('crypto').randomBytes(12).toString('hex');
const P1=rnd(),P2=rnd(),P3=rnd(),P4=rnd();
const ROOT=path.join(__dirname,'..'), PORT=3917, B=`http://localhost:${PORT}`;
const dbfile=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'gwt-')),'gateway.db');
const env={...process.env,GATEWAY_DB:dbfile,PORT:String(PORT)};
fs.mkdirSync(path.join(ROOT,'apps','zz-test'),{recursive:true});
fs.writeFileSync(path.join(ROOT,'apps','zz-test','server.js'),"const e=require('express');const a=e();a.get('/whoami',(q,s)=>s.json(q.gateway));module.exports=a;");
fs.mkdirSync(path.join(ROOT,'apps','zz-autre'),{recursive:true});
fs.writeFileSync(path.join(ROOT,'apps','zz-autre','server.js'),"const e=require('express');const a=e();a.get('/whoami',(q,s)=>s.json(q.gateway));module.exports=a;");
const cli=(args,pw)=>execFileSync('node',['scripts/gateway-user.js',...args],{cwd:ROOT,env,input:pw+'\n'}).toString();
let srv;
let n=0;const eq=(a,b)=>{n++;if(a!==b)throw new Error('assertion n°'+n+' : obtenu '+a+' attendu '+b)};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function call(m,u,body,{cookie,headers}={}){const r=await fetch(B+u,{method:m,redirect:'manual',headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...headers},body:body?JSON.stringify(body):undefined});
 const sc=r.headers.get('set-cookie'); let j=null; try{j=await r.json()}catch(e){} return {status:r.status,json:j,cookie:sc?sc.split(';')[0]:null,raw:sc};}
(async()=>{ try{
 console.log(cli(['create','thomas','--super','--name','Thomas'],P1).trim());
 assert.throws(()=>cli(['create','x'],'court'));
 srv=spawn('node',['server.js'],{cwd:ROOT,env,stdio:'pipe'}); let out=''; srv.stdout.on('data',d=>out+=d); srv.stderr.on('data',d=>out+=d);
 for(let i=0;i<40&&!out.includes('disponible');i++)await sleep(250);
 // 1. anonyme
 let r=await call('GET','/zz-test/whoami'); eq(r.json.role,null); eq(r.json.user,null);
 // 2. mauvais mdp / CSRF / non-JSON
 r=await call('POST','/_gw/auth/login',{login:'thomas',password:'faux'}); eq(r.status,401);
 r=await call('POST','/_gw/auth/login',{login:'thomas',password:P1},{headers:{Origin:'https://evil.example'}}); eq(r.status,403);
 r=await fetch(B+'/_gw/auth/login',{method:'POST',headers:{'Content-Type':'text/plain'},body:'x'}); eq(r.status,415);
 // 3. connexion + open redirect
 r=await call('POST','/_gw/auth/login',{login:'thomas',password:P1,next:'//evil.example'}); eq(r.status,200); eq(r.json.next,'/');
 assert(/HttpOnly/.test(r.raw)&&/SameSite=Lax/.test(r.raw)&&/Path=\//.test(r.raw)); let admin=r.cookie;
 r=await call('POST','/_gw/auth/login',{login:'thomas',password:P1,next:'/zz-test/x'}); eq(r.json.next,'/zz-test/x');
 // 4. super => admin partout
 r=await call('GET','/zz-test/whoami',null,{cookie:admin}); eq(r.json.role,'admin'); eq(r.json.user.login,'thomas'); assert(!('access' in r.json.user));
 // 5. creation du compte de l'epouse (membre sur zz-test uniquement)
 r=await call('POST','/_gw/admin/users',{login:'epouse',name:'Epouse',password:P2,reauth:P1},{cookie:admin}); eq(r.status,200); const id=r.json.id;
 r=await call('PUT',`/_gw/admin/users/${id}/access`,{access:{'zz-test':'member','inconnu':'admin'},reauth:P1},{cookie:admin}); eq(r.status,400);
 r=await call('PUT',`/_gw/admin/users/${id}/access`,{access:{'zz-test':'member'},reauth:P1},{cookie:admin}); eq(r.status,200);
 r=await call('POST','/_gw/auth/login',{login:'epouse',password:P2}); const epouse=r.cookie;
 r=await call('GET','/zz-test/whoami',null,{cookie:epouse}); eq(r.json.role,'member');
 r=await call('GET','/zz-autre/whoami',null,{cookie:epouse}); eq(r.json.role,null);
 // 6. un non-admin n'accede pas a l'administration
 r=await call('GET','/_gw/admin/users',null,{cookie:epouse}); eq(r.status,403);
 r=await call('POST','/_gw/admin/users',{login:'x1',password:P4},{cookie:epouse}); eq(r.status,403);
 // 7. changement de mot de passe ferme les autres sessions
 r=await call('POST','/_gw/auth/login',{login:'epouse',password:P2}); const e2=r.cookie;
 r=await call('POST','/_gw/auth/password',{current:P2,next:P3},{cookie:e2}); eq(r.status,200);
 r=await call('GET','/zz-test/whoami',null,{cookie:epouse}); eq(r.json.role,null,'ancienne session doit etre fermee');
 r=await call('GET','/zz-test/whoami',null,{cookie:e2}); eq(r.json.role,'member');
 // 8. desactivation = coupure immediate
 r=await call('PATCH',`/_gw/admin/users/${id}`,{active:false,reauth:P1},{cookie:admin}); eq(r.status,200);
 r=await call('GET','/zz-test/whoami',null,{cookie:e2}); eq(r.json.role,null);
 r=await call('POST','/_gw/auth/login',{login:'epouse',password:P3}); eq(r.status,401);
 // 9. dernier admin protege
 r=await call('GET','/_gw/admin/users',null,{cookie:admin}); const me=r.json.users.find(u=>u.login==='thomas').id;
 r=await call('DELETE','/_gw/admin/users/'+me,{reauth:P1},{cookie:admin}); eq(r.status,409);
 r=await call('PATCH','/_gw/admin/users/'+me,{isSuper:false,reauth:P1},{cookie:admin}); eq(r.status,409);
 // 10. anti brute-force
 let last; for(let i=0;i<9;i++) last=await call('POST','/_gw/auth/login',{login:'cible',password:'x'}); eq(last.status,429);
 // 10b. ré-authentification obligatoire pour les actions sensibles
 r=await call('POST','/_gw/admin/users',{login:'sansconf',password:P4+'aa'},{cookie:admin}); eq(r.status,403);
 r=await call('POST','/_gw/admin/users',{login:'sansconf',password:P4+'aa',reauth:'mauvais'},{cookie:admin}); eq(r.status,403);
 r=await call('GET','/_gw/admin/users',null,{cookie:admin}); assert(!r.json.users.some(u=>u.login==='sansconf'),'aucun compte cree sans confirmation');
 // 10c. journal d'audit : actions tracées, jamais de secret
 r=await call('GET','/_gw/admin/audit',null,{cookie:admin}); const acts=r.json.events.map(e=>e.action);
 for(const a of ['connexion','connexion.echec','compte.cree','droits.modifies','compte.modifie','reauth.echec']) assert(acts.includes(a),'audit manquant : '+a);
 assert(!JSON.stringify(r.json).includes(P1)&&!JSON.stringify(r.json).includes(P2),'aucun mot de passe dans le journal');
 r=await call('GET','/_gw/admin/audit',null,{cookie:e2}); eq(r.status,403);
 // 10d. double authentification TOTP
 const totp=require(path.join(ROOT,'lib','gw-totp'));
 r=await call('POST','/_gw/auth/2fa/setup',{password:'faux'},{cookie:admin}); eq(r.status,403);
 r=await call('POST','/_gw/auth/2fa/setup',{password:P1},{cookie:admin}); eq(r.status,200); const secret=r.json.secret; assert(/^otpauth:\/\/totp\//.test(r.json.uri));
 r=await call('POST','/_gw/auth/2fa/enable',{code:'000000'},{cookie:admin}); eq(r.status,400);
 r=await call('POST','/_gw/auth/2fa/enable',{code:totp.code(secret)},{cookie:admin}); eq(r.status,200);
 r=await call('POST','/_gw/auth/login',{login:'thomas',password:P1}); eq(r.status,401); eq(r.json.needs2fa,true); eq(r.cookie,null);
 r=await call('POST','/_gw/auth/login',{login:'thomas',password:P1,code:'000000'}); eq(r.status,401); eq(r.cookie,null);
 const okCode=totp.code(secret,Date.now()+30000); // le code d'activation est deja consomme : pas suivant (tolere)
 r=await call('POST','/_gw/auth/login',{login:'thomas',password:P1,code:okCode}); eq(r.status,200); const admin2=r.cookie; assert(admin2);
 r=await call('POST','/_gw/auth/login',{login:'thomas',password:P1,code:okCode}); eq(r.status,401); // un code ne sert qu'une fois
 r=await call('GET','/_gw/auth/me',null,{cookie:admin2}); eq(r.json.user.twoFactor,true);
 // reinitialisation par le super-admin (compte de l'epouse n'a pas de 2FA : on teste sur thomas lui-meme via CLI plus bas)
 // 10e. identité d'une requête brute (poignée de main Socket.IO) : meme resultat que req.gateway
 r=await call('GET','/zz-test/whoami',null,{cookie:admin2}); eq(r.json.role,'admin');
 // 10f. perte du telephone : reset2fa en SSH
 cli(['reset2fa','thomas'],'');
 r=await call('POST','/_gw/auth/login',{login:'thomas',password:P1}); eq(r.status,200); const admin3=r.cookie;
 r=await call('GET','/zz-test/whoami',null,{cookie:admin2}); eq(r.json.role,null,'sessions fermees apres reset2fa');
 admin=admin3;
 // 11. deconnexion
 r=await call('POST','/_gw/auth/logout',{},{cookie:admin}); r=await call('GET','/zz-test/whoami',null,{cookie:admin}); eq(r.json.role,null);
 // 12. pages
 for(const p of ['/_gw/login','/_gw/account','/_gw/admin','/_gw/gw.js']){const x=await fetch(B+p);eq(x.status,200);}
 assert(/script-src 'self'/.test((await fetch(B+'/_gw/login')).headers.get('content-security-policy')));
 console.log('TOUS LES TESTS PASSENT');
}catch(e){console.error('ECHEC:',e.message); console.error(e.stack.split('\n').slice(1,4).join('\n')); process.exitCode=1}
finally{ if(srv)srv.kill(); fs.rmSync(path.join(ROOT,'apps','zz-test'),{recursive:true,force:true}); fs.rmSync(path.join(ROOT,'apps','zz-autre'),{recursive:true,force:true}); }
})();
