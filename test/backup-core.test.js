// Test du coeur de la sauvegarde (copie WAL, chiffrement, alteration, retention). Lancer : npm test
const fs=require('fs'),path=require('path'),assert=require('assert');
const core=require('../lib/backup-core');
const {DatabaseSync}=require('node:sqlite');
const root=fs.mkdtempSync(path.join(require('os').tmpdir(),'gw-'));
const appDir=path.join(root,'apps','demo','data'); fs.mkdirSync(appDir,{recursive:true});
fs.writeFileSync(path.join(root,'apps','demo','package.json'),'{}');
const f=path.join(appDir,'app.sqlite');
const db=new DatabaseSync(f); db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1),(2);'); // connexion ouverte (WAL)
fs.writeFileSync(path.join(root,'apps','demo','fake.db'),'pas sqlite');
fs.mkdirSync(path.join(root,'apps','demo','node_modules'));fs.writeFileSync(path.join(root,'apps','demo','node_modules','x.db'),'x');
const found=core.discoverAll(path.join(root,'apps')); assert.strictEqual(found.length,1); assert.strictEqual(found[0].rel,'data/app.sqlite');
const key=core.parseKey('ab'.repeat(32));
const mem=[]; const store={
 latestFingerprint:async(a,f)=>(mem.filter(m=>m.app==a&&m.file==f).pop()||{}).fingerprint||null,
 insert:async m=>{mem.push({...m,id:mem.length+1,taken_at:new Date()});},
 list:async()=>mem, remove:async id=>{}};
(async()=>{
 let r=await core.runBackup({appsDir:path.join(root,'apps'),store,key,log:console}); assert.deepStrictEqual(r,{saved:1,unchanged:0,failed:0});
 r=await core.runBackup({appsDir:path.join(root,'apps'),store,key,log:console}); assert.strictEqual(r.unchanged,1);
 db.exec('INSERT INTO t VALUES (3)');
 r=await core.runBackup({appsDir:path.join(root,'apps'),store,key,log:console}); assert.strictEqual(r.saved,1);
 const blob=Buffer.concat(mem[1].chunks); const plain=core.decrypt(blob,key,'demo','data/app.sqlite');
 const out=path.join(root,'r.db'); fs.writeFileSync(out,plain);
 const rows=new DatabaseSync(out).prepare('SELECT count(*) c FROM t').get(); assert.strictEqual(rows.c,3);
 blob[40]^=1; assert.throws(()=>core.decrypt(blob,key,'demo','data/app.sqlite'));
 assert.throws(()=>core.decrypt(Buffer.concat(mem[1].chunks),key,'autre','data/app.sqlite'));
 // retention
 const bs=[];for(let i=0;i<60;i++)bs.push({id:i,taken_at:new Date(Date.now()-i*86400000)});
 const k=core.selectKeep(bs); assert(k.has(0)&&k.size>=7&&k.size<=17,k.size);
 assert.throws(()=>core.parseKey('court'));
 console.log('OK, retention garde',k.size,'/60');
})().catch(e=>{console.error(e);process.exit(1)});
