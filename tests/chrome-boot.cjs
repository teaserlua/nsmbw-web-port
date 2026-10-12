'use strict';
// Requires a Chrome instance listening on port 9333. Defaults to the local
// Python server at 127.0.0.1:8992, with the extracted partition attached.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sleep = (ms) => new Promise(ok=>setTimeout(ok,ms));
async function main() {
  const url=process.argv[2]||'http://127.0.0.1:8992/?noshaderwarm';
  const list=await(await fetch('http://127.0.0.1:9333/json')).json();
  const tab=list.find(p=>p.type==='page'); assert(tab);
  const ws=new WebSocket(tab.webSocketDebuggerUrl);
  const pending=new Map(); let n=0;
  ws.addEventListener('message',({data})=>{const x=JSON.parse(data);if(pending.has(x.id)){pending.get(x.id)(x);pending.delete(x.id);}});
  await new Promise((ok,bad)=>{ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',bad,{once:true});});
  const cdp=(method,params={})=>new Promise(ok=>{const id=++n;pending.set(id,ok);ws.send(JSON.stringify({id,method,params}));});
  try {
    await cdp('Page.enable');await cdp('Runtime.enable');
    await cdp('Page.navigate',{url});
    let status;
    for(let i=0;i<60;i++) {
      await sleep(1500);
      const out=await cdp('Runtime.evaluate',{expression:`({isolated:crossOriginIsolated,title:document.title,
        needsFolder:document.querySelector('#title')?.classList.contains('needs-game'),
        localImage:document.querySelector('#title')?.style.backgroundImage,
        state:document.querySelector('#status')?.textContent,
        workers:window.__rgh?.workers?.length||0,
        frames:window.__renderer?.stats?.xfbCopies||0,
        gameStatus:document.querySelector('#game-status')?.textContent,
        log:document.querySelector('#log')?.textContent.slice(-900)})`,returnByValue:true});
      status=out.result?.result?.value;
      if(i%3===0)console.log(`${(i+1)*1.5}s workers=${status?.workers} frames=${status?.frames} folder=${status?.needsFolder} ${status?.state}`);
      if(url.includes('8992') && status?.workers>2 && status?.frames>(process.argv.includes('--long')?120:0)) break;
      if(!url.includes('8992') && status?.needsFolder) break;
    }
    console.log('Final:',status);
    assert(status?.isolated,'Cross origin isolation failed');
    if(url.includes('8992')){
      assert(status?.workers>2,'Guest did not start threads');
      assert(status?.frames>0,'Guest did not render a frame');
      const capture=await cdp('Page.captureScreenshot',{format:'png'});
      if(capture.result?.data) fs.writeFileSync(path.join(__dirname,'.smoke-boot.png'),Buffer.from(capture.result.data,'base64'));
    }else assert(status?.needsFolder,'Public page failed to request a user-selected game folder');
    console.log('PASS NSMBW browser check');
  }finally{ws.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
