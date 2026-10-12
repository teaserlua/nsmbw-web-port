#!/usr/bin/env node
// Upload PACKED assets to a PRIVATE Cloudflare R2 bucket using Wrangler OAuth.
// The NSMBW Worker ships with PUBLIC_GAME_DATA=false. Uploading alone does
// not make Nintendo game files playable/downloadable on the public website.
//
// npm install --no-save --no-package-lock wrangler
// node tools/upload-packed.mjs --source generated/r2 --bucket nsmbw-web-port
// node tools/upload-packed.mjs --source generated/r2 --bucket nsmbw-web-port --execute --private-backup
import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function parse(argv) {
  const opts={execute:false,privateBackup:false};
  for(let i=0;i<argv.length;i++) {
    if(argv[i]==='--execute')opts.execute=true;
    else if(argv[i]==='--private-backup')opts.privateBackup=true;
    else if(['--source','--bucket'].includes(argv[i]))opts[argv[i].slice(2)]=argv[++i];
    else throw Error(`Unknown option ${argv[i]}`);
  }
  if(!opts.source||!opts.bucket)throw Error('Use --source DIR --bucket BUCKET');
  if(!/^[a-z0-9][a-z0-9-]+$/.test(opts.bucket))throw Error('Invalid R2 bucket name');
  if(opts.execute&&!opts.privateBackup)throw Error('Private backup requires --private-backup acknowledgement');
  opts.source=path.resolve(opts.source);
  return opts;
}
async function hashFile(file) {
  const hash=createHash('sha256');
  for await(const part of createReadStream(file))hash.update(part);
  return hash.digest('hex');
}
async function inventory(opts) {
  const manifestPath=path.join(opts.source,'manifest.json');
  const json=JSON.parse(await fs.readFile(manifestPath,'utf8'));
  if(json.version!==1||!json.files||!json.packs)throw Error('Invalid manifest');
  const result=[];
  for(const [name,meta] of Object.entries(json.packs).sort(([a],[b])=>a.localeCompare(b))){
    if(!/^packs\/\d{4}\.bin$/.test(name))throw Error(`Unexpected pack key ${name}`);
    const file=path.join(opts.source,...name.split('/'));
    const stat=await fs.stat(file);
    if(stat.size!==meta.length)throw Error(`Pack size mismatch ${name}`);
    result.push({file,key:name,size:stat.size});
  }
  result.push({file:manifestPath,key:'manifest.json',size:(await fs.stat(manifestPath)).size});
  return result;
}
async function wrangler(args) {
  const cli=path.join(repo,'node_modules','wrangler','bin','wrangler.js');
  await fs.access(cli).catch(()=>{throw Error('Install Wrangler: npm install --no-save --no-package-lock wrangler');});
  const proc=spawn(process.execPath,[cli,...args],{cwd:repo,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';
  for(const stream of [proc.stdout,proc.stderr])stream.on('data',c=>{output=(output+c.toString()).slice(-2000);});
  const code=await new Promise((resolve,reject)=>{proc.once('error',reject);proc.once('close',resolve);});
  if(code!==0)throw Error(`Wrangler exit ${code}: ${output.slice(-700)}`);
}
async function main() {
  const opts=parse(process.argv.slice(2));
  const files=await inventory(opts);
  const total=files.reduce((n,x)=>n+x.size,0);
  console.log(`${files.length} private R2 objects (${(total/1048576).toFixed(1)} MiB) to ${opts.bucket}`);
  if(!opts.execute){for(const f of files)console.log(`DRY ${f.key} (${f.size})`);return;}
  const statePath=path.join(os.homedir(),'.nsmbw-private-r2-upload.json');
  const scope=`${opts.bucket}:${opts.source}`;
  const state=await fs.readFile(statePath,'utf8').then(JSON.parse,()=>({scope,completed:{}}));
  if(state.scope!==scope)throw Error('Resume state belongs to another bucket/source');
  for(let i=0;i<files.length;i++) {
    const f=files[i];
    const digest=await hashFile(f.file);
    if(state.completed?.[f.key]===digest){console.log(`SKIP ${i+1}/${files.length} ${f.key}`);continue;}
    for(let attempt=1;attempt<=8;attempt++){
      try {
        await wrangler(['r2','object','put',`${opts.bucket}/${f.key}`,'--file',f.file,'--remote',
          '--content-type',f.key.endsWith('.json')?'application/json':'application/octet-stream']);
        break;
      }catch(error){if(attempt===8)throw error;console.warn(`Retry ${attempt}/8 ${f.key}: ${error.message}`);await new Promise(r=>setTimeout(r,attempt*1000));}
    }
    state.completed||={};state.completed[f.key]=digest;
    const tmp=statePath+'.tmp';
    await fs.writeFile(tmp,JSON.stringify(state,null,2),{mode:0o600});
    await fs.rename(tmp,statePath);
    console.log(`OK ${i+1}/${files.length} ${f.key}`);
  }
  console.log('Private upload complete. Worker PUBLIC_GAME_DATA remains disabled.');
}
main().catch(e=>{console.error('R2 upload:',e.message);process.exitCode=1;});
