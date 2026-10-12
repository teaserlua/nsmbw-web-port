// NSMBW virtual game files from privately hosted packed R2 objects.
// PUBLIC_GAME_DATA is explicitly false by default. Deploying the worker does
// not expose Nintendo's extracted game files to other visitors.
const allowedOrigins = new Set(['https://teaserlua.github.io','http://127.0.0.1:8992','http://localhost:8992']);
const manifestKey='manifest.json';
let cache=null;
let cacheUntil=0;

function cors(request) {
  const headers=new Headers({
    Vary:'Origin',
    'Cross-Origin-Resource-Policy':'cross-origin',
    'Access-Control-Expose-Headers':'Accept-Ranges, Content-Length, Content-Range, ETag',
    'Accept-Ranges':'bytes',
  });
  const origin=request.headers.get('Origin');
  if(allowedOrigins.has(origin))headers.set('Access-Control-Allow-Origin',origin);
  return headers;
}
function pathKey(request) {
  let path;
  try {path=decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');}
  catch {return null;}
  if(!path||path.includes('\\')||path.split('/').some(segment=>!segment||segment==='.'||segment==='..'||/[\x00-\x1f]/.test(segment)))return null;
  return path;
}
function rangeOf(text,size) {
  if(!text)return {start:0,end:size?size-1:0,partial:false};
  const m=/^bytes=(\d+)-(\d*)$/.exec(text.trim());
  if(!m || !size)return null;
  const start=Number(m[1]), end=m[2]?Number(m[2]):size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start)return null;
  return {start,end:Math.min(end,size-1),partial:true};
}
async function manifest(env) {
  if(cache && Date.now()<cacheUntil)return cache;
  const obj=await env.GAME_DATA.get(manifestKey);
  if(!obj)return null;
  const data=await obj.json();
  if(data.version!==1 || !data.files || !data.packs)throw Error('Invalid pack manifest');
  cache=data;cacheUntil=Date.now()+30000;
  return data;
}
function safeEntry(index,key) {
  const file=index.files[key];
  if(!file || !Object.hasOwn(index.packs,file.pack))return null;
  const pack=index.packs[file.pack];
  if(!/^packs\/\d{4}\.bin$/.test(file.pack))return null;
  if(![file.length,file.offset,pack.length].every(Number.isSafeInteger))return null;
  if(file.offset<0||file.length<0||file.offset+file.length>pack.length)return null;
  return file;
}
async function serveObject(request,env,key,headers) {
  const head=await env.GAME_DATA.head(key);
  if(!head)return new Response('Not found',{status:404,headers});
  const range=rangeOf(request.headers.get('Range'),head.size);
  if(!range){headers.set('Content-Range',`bytes */${head.size}`);return new Response(null,{status:416,headers});}
  if(range.partial)headers.set('Content-Range',`bytes ${range.start}-${range.end}/${head.size}`);
  const length=head.size?range.end-range.start+1:0;
  headers.set('Content-Length',String(length));
  if(request.method==='HEAD'||!length)return new Response(null,{status:range.partial?206:200,headers});
  const obj=await env.GAME_DATA.get(key,{range:{offset:range.start,length}});
  if(!obj)return new Response('Not found',{status:404,headers});
  return new Response(obj.body,{status:range.partial?206:200,headers});
}

export default {
  async fetch(request,env) {
    const headers=cors(request);
    if(request.method==='OPTIONS'){
      if(!allowedOrigins.has(request.headers.get('Origin')))return new Response(null,{status:403,headers});
      headers.set('Access-Control-Allow-Methods','HEAD, GET, OPTIONS');
      headers.set('Access-Control-Allow-Headers','Range');
      headers.set('Access-Control-Max-Age','7200');
      return new Response(null,{status:204,headers});
    }
    if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405,headers});
    const key=pathKey(request);
    if(key==='health')return new Response(request.method==='HEAD'?null:JSON.stringify({ready:true,publicGameData:env.PUBLIC_GAME_DATA==='true'}),
      {status:200,headers:{...Object.fromEntries(headers),'Content-Type':'application/json'}});
    if(!key)return new Response('Not found',{status:404,headers});
    try {
      // Only authored, synthetic test fixtures can be publicly fetched while
      // distribution is disabled. Game data routes remain inaccessible.
      if(key.startsWith('fixtures/'))return await serveObject(request,env,key,headers);
      if(!key.startsWith('game/'))return new Response('Not found',{status:404,headers});
      if(env.PUBLIC_GAME_DATA!=='true')return new Response('Game assets are not public',{status:403,headers});
      const index=await manifest(env);
      if(!index)return new Response('Game data not uploaded',{status:503,headers});
      const file=safeEntry(index,key);
      if(!file)return new Response('Not found',{status:404,headers});
      const range=rangeOf(request.headers.get('Range'),file.length);
      if(!range){headers.set('Content-Range',`bytes */${file.length}`);return new Response(null,{status:416,headers});}
      const count=file.length?range.end-range.start+1:0;
      headers.set('Content-Length',String(count));
      if(range.partial)headers.set('Content-Range',`bytes ${range.start}-${range.end}/${file.length}`);
      if(request.method==='HEAD'||!count)return new Response(null,{status:range.partial?206:200,headers});
      const obj=await env.GAME_DATA.get(file.pack,{range:{offset:file.offset+range.start,length:count}});
      if(!obj)return new Response('Missing pack object',{status:503,headers});
      return new Response(obj.body,{status:range.partial?206:200,headers});
    } catch(error) {
      console.error('R2 error:',error);
      return new Response('Storage temporarily unavailable',{status:503,headers});
    }
  },
};
