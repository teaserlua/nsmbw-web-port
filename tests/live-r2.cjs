'use strict';
// Sample a live R2 deployment against the private local manifest/packs.
// Usage: node tests/live-r2.cjs [public-worker-base]
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../generated/r2');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
const base=process.argv[2]||'https://nsmbw-game-assets.jmhq20120212.workers.dev/';
const origin='https://teaserlua.github.io';
function entries(){
  const all=Object.keys(manifest.files).sort();
  const required=[...all.filter(k=>/^game\/sys\/(boot\.bin|fst\.bin|main\.dol)$/.test(k)),
    ...all.filter(k=>/\/Sound\//.test(k)).slice(0,5)];
  const extra=[];
  for(let i=0;i<all.length;i+=Math.max(1,Math.floor(all.length/32)))extra.push(all[i]);
  return [...new Set([...required,...extra,all.at(-1)])];
}
async function verify(key){
  const f=manifest.files[key];
  const url=new URL(key.split('/').map(encodeURIComponent).join('/'),base);
  const h=await fetch(url,{method:'HEAD',headers:{Origin:origin},cache:'no-store'});
  assert.equal(h.status,200,key);
  assert.equal(Number(h.headers.get('content-length')),f.length,key);
  assert.equal(h.headers.get('access-control-allow-origin'),origin,key);
  if(f.length===0)return;
  const start=f.length>512?f.length-512:0;
  const end=f.length-1;
  const g=await fetch(url,{headers:{Origin:origin,Range:`bytes=${start}-${end}`},cache:'no-store'});
  assert.equal(g.status,206,key);
  assert.equal(g.headers.get('content-range'),`bytes ${start}-${end}/${f.length}`,key);
  const bytes=Buffer.from(await g.arrayBuffer());
  assert.equal(bytes.length,end-start+1,key);
  const local=fs.openSync(path.join(root,...f.pack.split('/')),'r');
  try{
    const expected=Buffer.alloc(end-start+1);
    assert.equal(fs.readSync(local,expected,0,expected.length,f.offset+start),expected.length);
    assert.deepEqual(bytes,expected,key);
  }finally{fs.closeSync(local);}
}
(async()=>{
  const selected=entries();
  let ok=0;
  for(const key of selected){await verify(key);ok++;console.log(`PASS ${ok}/${selected.length} ${key}`);}
  const invalid=await fetch(new URL('game/sys/boot.bin',base),{headers:{Origin:origin,Range:'bytes=999999-1000000'}});
  assert.equal(invalid.status,416);
  console.log(`PASS ${ok} remote files + invalid range (HEAD/CORS/206/bytes matched local packs)`);
})().catch(e=>{console.error(e);process.exitCode=1;});
