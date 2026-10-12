#!/usr/bin/env node
// Prepare immutable R2 pack objects for a tree of extracted game files.
// The public Worker can then serve HEAD and GET Range on each virtual file
// without 1,194 individual R2 objects. All output stays local until uploaded.
// Example:
// node tools/pack-partition.mjs --source "C:\\path\\partition" --output generated/r2
// node tools/pack-partition.mjs --source "C:\\path\\partition" --output generated/r2 --execute
import fs from 'node:fs';
import {promises as fsp} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const PACK_LIMIT=64*1024*1024;
export function options(args) {
  const result={execute:false,source:null,output:null};
  for(let i=0;i<args.length;i++) {
    const v=args[i];
    if(v==='--execute') result.execute=true;
    else if(v==='--source'||v==='--output') {if(!args[i+1])throw Error(`Missing value for ${v}`);result[v.slice(2)]=args[++i];}
    else throw Error(`Unknown option ${v}`);
  }
  if(!result.source||!result.output)throw Error('Use --source PATH --output DIRECTORY [--execute]');
  result.source=path.resolve(result.source);
  result.output=path.resolve(result.output);
  if(result.output===result.source || result.output.startsWith(result.source+path.sep))
    throw Error('Output may not be inside the original partition');
  return result;
}
export async function inventory(source) {
  const stat=await fsp.stat(source);
  if(!stat.isDirectory())throw Error('Source is not a directory');
  for(const p of ['sys/boot.bin','sys/fst.bin','sys/main.dol']) {
    if(!(await fsp.stat(path.join(source,...p.split('/')))).isFile())throw Error(`Missing ${p}`);
  }
  const list=[];
  const walk=async(dir)=>{
    for(const entry of (await fsp.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
      if(entry.isSymbolicLink())throw Error(`Refusing symlink: ${entry.name}`);
      const abs=path.join(dir,entry.name);
      if(entry.isDirectory())await walk(abs);
      else if(entry.isFile()) {
        const length=(await fsp.stat(abs)).size;
        if(!Number.isSafeInteger(length)||length>PACK_LIMIT)throw Error(`File exceeds 64 MiB pack limit: ${abs}`);
        const rel=path.relative(source,abs).split(path.sep).join('/');
        if(!rel||rel.split('/').some(s=>!s||s==='.'||s==='..'))throw Error(`Invalid filename ${rel}`);
        list.push({abs,path:'game/'+rel,length});
      }
    }
  };
  await walk(source);
  return list;
}
async function transfer(file,handle,hash) {
  const source=await fsp.open(file,'r');
  const buffer=Buffer.allocUnsafe(1024*1024);
  let count=0;
  try {
    for (;;) {
      const {bytesRead}=await source.read(buffer,0,buffer.length,null);
      if(!bytesRead)break;
      hash.update(buffer.subarray(0,bytesRead));
      let sent=0;
      while(sent<bytesRead) {
        const {bytesWritten}=await handle.write(buffer,sent,bytesRead-sent,null);
        if(!bytesWritten)throw Error('Write made no progress');
        sent+=bytesWritten;
      }
      count+=bytesRead;
    }
  } finally {await source.close();}
  return count;
}
export async function build(opts,files) {
  if(await fsp.stat(opts.output).then(()=>true,()=>false))throw Error('Output already exists; choose an empty new directory');
  const staging=opts.output+'.staging-'+process.pid;
  if(await fsp.stat(staging).then(()=>true,()=>false))throw Error('Staging directory already exists');
  await fsp.mkdir(path.join(staging,'packs'),{recursive:true});
  const manifest={version:1,packSize:PACK_LIMIT,files:{},packs:{}};
  let pack=null, packLength=0, packNo=-1, packName='';
  const closePack=async()=>{
    if(!pack)return;
    await pack.sync();await pack.close();
    manifest.packs[packName]={length:packLength};
    pack=null;
  };
  try {
    for(const file of files) {
      if(!pack || (packLength>0 && packLength+file.length>PACK_LIMIT)) {
        await closePack();packNo++;
        packName=`packs/${String(packNo).padStart(4,'0')}.bin`;
        pack=await fsp.open(path.join(staging,...packName.split('/')),'wx');
        packLength=0;
      }
      const sha=createHash('sha256');
      const written=await transfer(file.abs,pack,sha);
      if(written!==file.length)throw Error(`Source changed during packing: ${file.path}`);
      manifest.files[file.path]={pack:packName,offset:packLength,length:written,sha256:sha.digest('hex')};
      packLength+=written;
    }
    await closePack();
    await fsp.writeFile(path.join(staging,'manifest.json'),JSON.stringify(manifest,null,2),'utf8');
    await fsp.rename(staging,opts.output);
    return manifest;
  } catch(error) {
    if(pack)await pack.close().catch(()=>{});
    await fsp.rm(staging,{recursive:true,force:true});
    throw error;
  }
}
async function main() {
  const opts=options(process.argv.slice(2));
  const files=await inventory(opts.source);
  const bytes=files.reduce((n,x)=>n+x.length,0);
  let packs=1,used=0;
  for(const f of files){if(used && used+f.length>PACK_LIMIT){packs++;used=0;}used+=f.length;}
  console.log(`${files.length} files, ${(bytes/1048576).toFixed(1)} MiB, ${packs} pack objects`);
  if(!opts.execute){console.log('DRY RUN: no files written');return;}
  const manifest=await build(opts,files);
  console.log(`Created ${Object.keys(manifest.packs).length} pack objects + manifest at ${opts.output}`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(e=>{console.error(e.message);process.exitCode=1;});
