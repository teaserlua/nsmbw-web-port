import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {options,inventory,build} from '../tools/pack-partition.mjs';
import worker from '../cloudflare/nsmbw-assets/src/index.mjs';

const ORIGIN='https://teaserlua.github.io';
test('packing preserves paths, bytes and offsets; worker serves partial virtual files privately until enabled',async(t)=>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'nsmbw-r2-test-'));
  t.after(()=>fs.rm(tmp,{recursive:true,force:true}));
  const src=path.join(tmp,'original');
  for(const dir of ['sys','files/Sound'])await fs.mkdir(path.join(src,dir),{recursive:true});
  const content={
    'sys/boot.bin':Buffer.from(Array.from({length:40},(_,i)=>i)),
    'sys/fst.bin':Buffer.from('TABLE'),
    'sys/main.dol':Buffer.from(Array.from({length:4030},(_,i)=>(i*3)%256)),
    'files/Sound/music.brstm':Buffer.from(Array.from({length:2081},(_,i)=>i%251)),
    'files/Sound/space name.brstm':Buffer.from('SOUND SAMPLE'),
  };
  for(const [rel,buf] of Object.entries(content))await fs.writeFile(path.join(src,...rel.split('/')),buf);
  const out=path.join(tmp,'packed');
  const opts=options(['--source',src,'--output',out,'--execute']);
  const entries=await inventory(opts.source);
  assert.equal(entries.length,5);
  const manifest=await build(opts,entries);
  assert.equal(Object.keys(manifest.files).length,5);
  await assert.rejects(build(opts,entries),/already exists/);
  const data=new Map();
  const manifestBytes=Buffer.from(JSON.stringify(manifest));
  data.set('manifest.json',manifestBytes);
  data.set('fixtures/check.bin',Buffer.from(Array.from({length:256},(_,i)=>i)));
  for(const pack of Object.keys(manifest.packs))data.set(pack,await fs.readFile(path.join(out,...pack.split('/'))));
  for(const [rel,bytes] of Object.entries(content)){
    const entry=manifest.files['game/'+rel];
    const pack=data.get(entry.pack);
    assert.deepEqual(pack.subarray(entry.offset,entry.offset+entry.length),bytes);
  }
  const calls=[];
  const bucket={
    async head(key){calls.push(['head',key]);const file=data.get(key);return file?{size:file.length}:null;},
    async get(key,opts){calls.push(['get',key,opts]);const file=data.get(key);if(!file)return null;
      const bytes=opts?.range?file.subarray(opts.range.offset,opts.range.offset+opts.range.length):file;
      return {size:file.length,body:new Response(bytes).body,json:async()=>JSON.parse(file.toString('utf8'))};},
  };
  const request=(filename,{method='GET',range}={})=>new Request('https://nsmbw-game-assets.test/'+filename,
    {method,headers:{Origin:ORIGIN,...(range?{Range:range}:{})}});
  const env={GAME_DATA:bucket,PUBLIC_GAME_DATA:'false'};
  let res=await worker.fetch(request('health'),env);
  assert.equal(res.status,200);
  assert.deepEqual(await res.json(),{ready:true,publicGameData:false});
  res=await worker.fetch(request('game/sys/boot.bin'),env);
  assert.equal(res.status,403);
  assert.equal(calls.length,0,'Private mode should not access the manifest');
  res=await worker.fetch(request('fixtures/check.bin',{range:'bytes=12-43'}),env);
  assert.equal(res.status,206);
  assert.equal(res.headers.get('Content-Range'),'bytes 12-43/256');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()),data.get('fixtures/check.bin').subarray(12,44));
  env.PUBLIC_GAME_DATA='true';
  for(const [rel,source] of Object.entries(content)){
    const key='game/'+rel;
    res=await worker.fetch(request(key,{method:'HEAD'}),env);
    assert.equal(res.status,200,key);
    assert.equal(Number(res.headers.get('Content-Length')),source.length,key);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'),ORIGIN);
    res=await worker.fetch(request(key,{range:`bytes=2-${source.length+100}`}),env);
    assert.equal(res.status,206,key);
    assert.equal(res.headers.get('Content-Range'),`bytes 2-${source.length-1}/${source.length}`);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()),source.subarray(2));
  }
  res=await worker.fetch(request('game/files/Sound/space%20name.brstm',{range:'bytes=0-3'}),env);
  assert.equal(res.status,206);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()),content['files/Sound/space name.brstm'].subarray(0,4));
  res=await worker.fetch(request('game/sys/boot.bin',{range:'bytes=100-110'}),env);
  assert.equal(res.status,416);
  res=await worker.fetch(request('game/files/absent.bin'),env);
  assert.equal(res.status,404);
  res=await worker.fetch(request('unrelated'),env);
  assert.equal(res.status,404);
});
