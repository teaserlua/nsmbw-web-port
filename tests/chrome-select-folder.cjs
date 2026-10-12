'use strict';
// Manual/CDP integration check: run only on a machine with the extracted disc.
// Usage: node tests/chrome-select-folder.cjs "C:\\path\\partition"
const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const directory=process.argv[2];
if(!directory) throw new Error('Pass extracted partition directory');
async function main(){
  const tabs=await(await fetch('http://127.0.0.1:9333/json')).json();
  const tab=tabs.find(t=>t.type==='page');assert(tab);
  const ws=new WebSocket(tab.webSocketDebuggerUrl);
  const pending=new Map();let id=0;
  ws.onmessage=({data})=>{const e=JSON.parse(data);if(pending.has(e.id)){pending.get(e.id)(e);pending.delete(e.id);}};
  await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  const send=(method,params={})=>new Promise(r=>{const n=++id;pending.set(n,r);ws.send(JSON.stringify({id:n,method,params}));});
  const evalJS=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true})).result?.result?.value;
  try{
    await send('Page.enable');await send('DOM.enable');await send('Runtime.enable');
    await send('Page.navigate',{url:'https://teaserlua.github.io/nsmbw-web-port/'});
    for(let i=0;i<30;i++) {await sleep(300);if(await evalJS('!!document.querySelector("#game-folder") && crossOriginIsolated'))break;}
    const doc=await send('DOM.getDocument',{depth:-1});
    const node=await send('DOM.querySelector',{nodeId:doc.result.root.nodeId,selector:'#game-folder'});
    assert(node.result.nodeId,'Did not find game file picker');
    const set=await send('DOM.setFileInputFiles',{nodeId:node.result.nodeId,files:[directory]});
    if(set.error) throw new Error(JSON.stringify(set.error));
    let value;
    for(let i=0;i<45;i++){
      await sleep(1500);
      value=await evalJS(`({files:document.querySelector('#game-folder')?.files?.length||0,
        first:document.querySelector('#game-folder')?.files?.[0]?.webkitRelativePath,
        status:document.querySelector('#game-status')?.textContent,
        workers:window.__rgh?.workers?.length||0,
        frames:window.__renderer?.stats?.xfbCopies||0,
        error:document.querySelector('#log')?.textContent.slice(-350)})`);
      if(i%5===0)console.log('Current:',value);
      if(value?.workers>1&&value.frames>0)break;
    }
    console.log('Selected folder result:',value);
    assert(value?.files>100,'Browser did not select extracted game files');
    assert(value?.workers>1,'Game did not start with browser-selected files');
    assert(value?.frames>0,'Game did not render after directory selection');
    console.log('PASS public GitHub Pages browser file selection and game startup');
  }finally{ws.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
