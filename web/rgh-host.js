// rgh-host.js - page side: loads the recompiled game (rgh.wasm), creates the shared memory and one
// worker per guest fiber, prepares every shader on the loading screen, then runs the game and presents frames.
'use strict';

const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');
const fpsEl = document.getElementById('fps');
const localLauncher = ['localhost','127.0.0.1','[::1]'].includes(location.hostname);
const lines = [];
const T0 = performance.now();
// the log also goes to the launcher, which saves it as nsmbw-log.txt (to look at a crash afterwards)
const logOut = []; let logNew = true, logBusy = false;
function logFlush() {
  if (!localLauncher || logBusy || !logOut.length || location.protocol === 'file:') return;
  logBusy = true;
  const body = logOut.splice(0).join('\n') + '\n';
  fetch('log' + (logNew ? '?new=1' : ''), { method: 'POST', body, keepalive: body.length < 60000 }).catch(() => {}).finally(() => { logBusy = false; });
  logNew = false;
}
setInterval(logFlush, 2000);
addEventListener('pagehide', logFlush);
document.addEventListener('visibilitychange', () => log(`[page] tab ${document.visibilityState === 'visible' ? 'visible' : 'hidden'}`));
function log(text) {
  lines.push(text); if (lines.length > 400) lines.splice(0, lines.length - 400);
  logEl.textContent = lines.join('\n'); logEl.scrollTop = logEl.scrollHeight;
  if (window.__rghLog) window.__rghLog(text);
  if (localLauncher && (!/^\[OSReport\]/.test(text) || logOut.length < 20000)) logOut.push(`[${((performance.now() - T0) / 1000).toFixed(1)}] ${text}`);
}
addEventListener('keydown', (e) => { if (e.code === 'F9' && window.__dbgReq) { e.preventDefault(); window.__dbgReq('F9'); UI.toast('Game state saved to the log'); } });
addEventListener('error', (e) => { log(`[page] error: ${e.message} (${e.filename}:${e.lineno})`); logFlush(); });
addEventListener('unhandledrejection', (e) => { log(`[page] promesa rechazada: ${e.reason && (e.reason.stack || e.reason.message) || e.reason}`); logFlush(); });
log(`[page] ${navigator.userAgent} · ${navigator.hardwareConcurrency} cores · ${Math.round((navigator.deviceMemory || 0))} GB`);

const params = new URLSearchParams(location.search);
const env = {};
for (const [k, v] of params) if (k.startsWith('RGH_')) env[k] = v;
// guest thread switches: spin briefly before sleeping (much faster wake-ups) when there are cores to spare
if (!env.RGH_SPIN) { const n = navigator.hardwareConcurrency || 4; env.RGH_SPIN = String(n >= 8 ? 100000 : n >= 6 ? 50000 : n >= 4 ? 15000 : 0); }
const NORENDER = params.has('norender');

// A user-selected directory becomes a read-only disc without a server upload.
// The File objects are transferred to game workers; their data is read in
// small synchronous slices only when a game thread requests it.
let localGameFiles = null;
const gameStatus = document.getElementById('game-status');
const folderInput = document.getElementById('game-folder');
document.getElementById('choose-game').onclick = () => folderInput.click();
function chooseSource() {
  const files = [...folderInput.files];
  const paths = files.map(f => (f.webkitRelativePath || f.name).replace(/\\/g,'/'));
  const boot = paths.find(p => /(^|\/)sys\/boot\.bin$/i.test(p));
  if (!boot) { gameStatus.textContent = 'Missing sys/boot.bin. Select the extracted partition folder.'; return; }
  const prefix = boot.slice(0, -'sys/boot.bin'.length);
  const candidates = files.flatMap((file,i) => paths[i].startsWith(prefix) ? [['game/'+paths[i].slice(prefix.length),file]] : []);
  if (!['game/sys/fst.bin','game/sys/main.dol'].every(key => candidates.some(([p])=>p===key))) {
    gameStatus.textContent = 'Missing sys/fst.bin or sys/main.dol. Select the folder with sys and files.';
    return;
  }
  localGameFiles = candidates;
  const size = candidates.reduce((n,[,f]) => n+f.size,0);
  gameStatus.textContent = `${candidates.length} files ready (${(size/1048576).toFixed(0)} MiB). Starting…`;
  play();
}
folderInput.addEventListener('change',chooseSource);
const assetBasePromise = fetch('game-config.json',{cache:'no-store'})
  .then(async resp => resp.ok ? resp.json() : null)
  .then(data => {
    if (!data || typeof data.assetBase!=='string') return null;
    const url=new URL(data.assetBase,location.href);
    if (url.protocol!=='https:' && !(location.protocol==='http:' && url.protocol==='http:')) return null;
    if (!url.pathname.endsWith('/')) url.pathname+='/';
    return url.href;
  }).catch(()=>null);
const useLocalFiles=params.has('local');

let modulePromise=null;
function loadModule() {
  const start=performance.now();
  modulePromise = (params.get('wasm') ? WebAssembly.compileStreaming(fetch(params.get('wasm')))
    : RGHModuleLoader.load({onRetry:(n,e)=>log(`[wasm] retry ${n}: ${e?.message||e}`)}))
    .then(m=>{log(`[host] module compiled in ${((performance.now()-start)/1000).toFixed(1)} s`);return m;});
  modulePromise.catch(()=>{});
  return modulePromise;
}
if (crossOriginIsolated) loadModule();
const nandPromise = nandLoad();

// ---- renderer: created on the loading screen so that every shader is compiled before the game starts
let renderer = null;
function makeRenderer() {
  if (renderer || NORENDER) return renderer;
  const canvas = document.getElementById('view');
  const ws = env.RGH_WIDESCREEN !== '0';           // the console is set to 16:9 unless ?RGH_WIDESCREEN=0
  if (!ws) document.body.classList.add('ar43');
  canvas.width = ws ? 1706 : 1280; canvas.height = 960;
  try { renderer = new GXRenderer(canvas, null, 0, { scale: Math.max(1, Math.min(3, Number(env.RGH_SCALE || UI.opts.scale) || 2)) }); }
  catch (e) { log('[render] ' + e.message); return null; }
  renderer.onError = (e) => log('[render] ' + (e.stack || e.message || e));
  try { const gl = renderer.gl, d = gl.getExtension('WEBGL_debug_renderer_info'); log(`[render] GPU: ${d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)} · parallel compile: ${renderer.parallel ? 'yes' : 'no'} · scale ${renderer.scale}`); } catch (e) { /* no info */ }
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); log('[render] WebGL CONTEXT LOST! (the graphics card or its driver was reset)'); logFlush(); UI.toast('The graphics card was reset: reload the page (F5) to continue'); });
  renderer.uberOnly = UI.opts.shaderMode === 'uber';
  if (!renderer.parallel) renderer.compilePerFrame = 1;   // without KHR_parallel_shader_compile (Firefox) every compile blocks
  window.__renderer = renderer;
  log('[render] WebGL2 ready');
  return renderer;
}

// ---- shader cache: the register state of every shader seen is kept in IndexedDB; shipped ones in shaders.bin
async function shaderList() {
  const all = [];
  try {
    const rsp = await fetch('shaders.bin', { cache: 'no-cache' });
    if (rsp.ok) { const b = await rsp.arrayBuffer(); for (let o = 0; o + 353 * 4 <= b.byteLength; o += 353 * 4) all.push(b.slice(o, o + 353 * 4)); }
  } catch (e) { /* optional */ }
  all.ownStart = all.length;
  for (const b of await UI.ownShaders()) all.push(b);
  return all;
}
// this browser's own shader list kept only states that give new code (it used to keep every state: tens of
// thousands that compiled to the same few thousand programs, and loading got slower every session)
async function compactOwnShaders(keep) {
  try {
    const db = await UI.shaderDB(), tx = db.transaction('s', 'readwrite'), os = tx.objectStore('s');
    os.clear(); keep.forEach((b, i) => os.put(b, 'u' + i));
    await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; });
    log(`[render] browser shader list compacted to ${keep.length}`);
  } catch (e) { /* keep the old list */ }
}
async function keepNewShaders(r) {
  let db = null;
  try { db = await UI.shaderDB(); } catch (e) { return; }
  const pending = [];
  r.onNewProgram = (key, st) => { pending.push([key, st.buffer]); };
  setInterval(() => {
    if (!pending.length) return;
    try { const tx = db.transaction('s', 'readwrite'), os = tx.objectStore('s'); for (const [k, v] of pending.splice(0)) os.put(v, k); } catch (e) { /* ignore */ }
  }, 2000);
}
// Compile everything: hand every shader to the driver (it compiles them on its own threads), then draw with each
// finished one once so the driver also builds its final GPU code. onProgress(fraction, text). Resolves when done.
function prepareShaders(r, all, onProgress) {
  return new Promise((resolve) => {
    if (r.uberOnly) { onProgress(1, 'Mode: generic shader only'); resolve(); return; }
    let i = 0, j = 0; const progs = [], seen = new Set(), ownKeep = [], t00 = performance.now();
    const step = () => {
      const t0 = performance.now();
      while (i < all.length && performance.now() - t0 < 12) {
        const idx = i, st = new Uint32Array(all[i++]); const pr = r.warm(st);
        if (pr && !seen.has(pr)) { seen.add(pr); progs.push([pr, st[0]]); if (idx >= (all.ownStart ?? all.length)) ownKeep.push(all[idx]); }
      }
      while (j < progs.length && performance.now() - t0 < 24) { try { if (!r.prime(progs[j][0], progs[j][1])) break; } catch (e) { /* broken entry */ } j++; }
      const frac = 0.35 * (i / Math.max(1, all.length)) + 0.65 * (i < all.length ? 0 : j / Math.max(1, progs.length));
      onProgress(frac, i < all.length ? `Compiling shaders ${i} / ${all.length}` : `Preparing shaders on the GPU ${j} / ${progs.length}`);
      if (i < all.length || j < progs.length) setTimeout(step, 0);
      else {
        log(`[render] ${all.length} states → ${progs.length} shaders ready in ${((performance.now() - t00) / 1000).toFixed(1)} s`);
        const own = all.length - (all.ownStart ?? all.length);
        if (own > ownKeep.length * 1.2 + 50) compactOwnShaders(ownKeep);
        resolve();
      }
    };
    step();
  });
}

// ---- Play: loading screen, then the game
let started = false;
async function play() {
  if (started) return;
  const remoteBase = useLocalFiles ? null : await assetBasePromise;
  const title = document.getElementById('title');
  if (!localGameFiles && (useLocalFiles || (!remoteBase && !localLauncher))) {
    title.classList.add('needs-game');
    return;
  }
  if (!crossOriginIsolated) {
    title.classList.add('needs-game');
    gameStatus.textContent = 'Preparing the browser for WebAssembly. Please wait for the page to reload.';
    return;
  }
  started = true;
  primeAudio();
  title.classList.remove('needs-game');
  title.classList.add('loading');
  const P = (f, t, s) => UI.progress(f, t, s);
  if (!crossOriginIsolated) { P(0, 'Cannot start', 'The page is not isolated (COOP/COEP): open it with the launcher / serve.py.'); log('ERROR: the page is not cross-origin isolated (COOP/COEP). Open it with serve.py.'); return; }
  P(0.02, 'Loading…', 'Preparing the game');
  let skip = false;
  const skipBtn = document.getElementById('skip');
  const skipT = setTimeout(() => { skipBtn.style.display = 'inline-block'; }, 60000);
  skipBtn.onclick = () => { skip = true; };
  let module;
  try { module = await (modulePromise || loadModule()); }
  catch (first) {
    log(`[wasm] previous load failed: ${first?.message||first}`);
    try { module = await loadModule(); }
    catch (e) { P(0, 'Could not load the game', String(e.message || e)); started=false; return; }
  }
  const nand = await nandPromise;
  P(0.08, 'Loading…', 'Reading shaders');
  const r = makeRenderer();
  if (r) {
    try { if (!r.uber) { r.uber = r.buildUber(); r.syncFinish(r.uber); } } catch (e) { log('[render] ubershader: ' + e.message); }
    keepNewShaders(r);
    const all = params.has('noshaderwarm') ? [] : await shaderList();
    log(`[render] precompiling ${all.length} shader states…`);
    await Promise.race([
      prepareShaders(r, all, (f, s) => P(0.08 + 0.9 * f, `Loading… ${Math.round((0.08 + 0.9 * f) * 100)}%`, s + (r.parallel ? '' : ' · loads and runs smoother in Chrome or Edge'))),
      new Promise((res) => { const k = setInterval(() => { if (skip) { clearInterval(k); res(); } }, 100); }),
    ]);
  }
  clearTimeout(skipT);
  if(remoteBase && !localGameFiles && !NORENDER) {
    P(1, 'Starting game…', 'Reading game files from Cloudflare R2');
    runGame(module,nand,remoteBase);
    await new Promise(resolve=>{
      const startAt=performance.now();
      const timer=setInterval(()=>{
        if ((window.__renderer?.stats?.xfbCopies||0)>0 ||
            /^(Stopped|Error)/.test(statusEl.textContent) ||
            performance.now()-startAt>90000){clearInterval(timer);resolve();}
      },100);
    });
  } else {
    P(1, 'Ready!', '');
    await new Promise((res) => setTimeout(res, 350));
    runGame(module,nand,remoteBase);
  }
  title.classList.add('gone');
  setTimeout(() => { title.hidden = true; }, 800);
  document.body.classList.add('playing');
}

function runGame(module, nand, remoteBase) {
  const memory = new WebAssembly.Memory({ initial: 4096, maximum: 16384, shared: true });
  const tidBuf = new Int32Array(new SharedArrayBuffer(4));
  if (nand) log(`[nand] saved game loaded (${nand.byteLength} bytes)`);
  const cfg = { base: remoteBase || new URL('./', location.href).href, env, nand, localFiles: localGameFiles };
  const workers = [];
  function spawn(tid, arg) {
    const w = new Worker('rgh-worker.js');
    w.onmessage = onMsg;
    w.onerror = (e) => { log(`[host] worker ${tid} error: ${e.message}`); logFlush(); };
    w.postMessage({ type: 'start', memory, module, cfg, tidBuf, tid, arg });
    workers.push(w);
  }
  function onMsg(e) {
    const m = e.data;
    if (m.type === 'log') log(m.text);
    else if (m.type === 'spawn') spawn(m.tid, m.arg);
    else if (m.type === 'ring') startRenderer(memory, m.addr);
    else if (m.type === 'dbg') { window.__dbgReq = (why) => { log(`[threads] dump requested (${why})`); Atomics.store(new Int32Array(memory.buffer, m.addr, 1), 0, 1); }; }
    else if (m.type === 'audio') startAudio(memory, m);
    else if (m.type === 'nand') nandSave(m.data);
    else if (m.type === 'pad' && !params.has('RGH_AUTOPRESS')) window.__input = new PadInput(document.getElementById('view'), memory, m.addr);
    else if (m.type === 'gcpad' && window.__input) window.__input.gcAddr = m.addr;
    else if (m.type === 'gcpad') window.__gcAddr = m.addr;
    else if (m.type === 'exit') { log(`[host] exit(${m.code})`); statusEl.textContent = 'Stopped'; logFlush(); UI.crashed(`The game stopped (code ${m.code}).`); }
    else if (m.type === 'crash') { log(`[host] hilo ${m.tid}: ${m.error}`); statusEl.textContent = 'Error (see log)'; logFlush(); UI.crashed('The game hit an error.'); }
  }
  spawn(0, 0);
  window.__rgh = { memory, workers };
  statusEl.textContent = 'Running';
  setInterval(() => {
    const r = window.__renderer;
    let perf = '', fpsLine = '';
    if (r && r.stats) {   // pictures shown per second, draw calls per picture, objects drawn with the ubershader
      const st = r.stats, p = statsEl._p || {}, xf = st.xfbCopies || st.xfb || 0, calls = st.calls || 0, pend = st.pending || 0;
      if (p.t) {
        const dt = (performance.now() - p.t) / 1000, nf = xf - p.xf, fps = nf / dt;
        perf = `${fps.toFixed(0)} fps · ${nf ? Math.round((calls - p.calls) / nf) : 0} calls/frame · `;
        fpsLine = `${fps.toFixed(0)} FPS`;
        if (pend > p.pend) { perf += 'compiling shaders · '; fpsLine += '  · new shader'; }
      }
      statsEl._p = { t: performance.now(), xf, calls, pend };
    }
    if (r && r.stats && window.__dbgReq) {
      const st = r.stats, q = statsEl._q || (statsEl._q = { n: 0, done: 0 });
      const lowDraws = q.d !== undefined && (st.draws - q.d) < 20 * Math.max(1, (st.xfbCopies | 0) - q.c), sameTex = q.t === st.texUploads;
      const quiet = !window.__audioLevel || window.__audioLevel() < 20;
      q.n = lowDraws && sameTex && quiet ? q.n + 1 : 0;
      if (q.n === 40 && q.done < 3) { q.done++; window.__dbgReq('looks stuck: still picture and no sound for 40 s'); }
      q.d = st.draws; q.c = st.xfbCopies | 0; q.t = st.texUploads;
      // total silence for 4 s while the game is running (a cutscene without its sound?): note the audio state once
      // a minute at most, so the log says what was playing
      q.s = quiet ? (q.s | 0) + 1 : 0;
      if (q.s === 4 && (!q.ls || performance.now() - q.ls > 60000) && (q.ns = (q.ns | 0) + 1) <= 20) { q.ls = performance.now(); window.__dbgReq('4 s of silence'); }
    }
    if (!(statsEl._n = (statsEl._n | 0) + 1) || statsEl._n % 10 === 0) {
      const st = r && r.stats ? r.stats : {};
      let ring = '';
      if (r && r.memory && r.ring) { const hh = new Int32Array(r.memory.buffer, r.ring, 8); ring = ` ring=${((Atomics.load(hh, 0) - Atomics.load(hh, 1)) >>> 0) >> 10} KB`; }
      if (window.__audioStat) log('[status] ' + window.__audioStat());
      log(`[status] ${perf}${ring} draws=${st.draws | 0} copies=${st.xfbCopies | 0} skipped=${st.skipped | 0} generic=${st.pending | 0} shaders=${st.progs | 0} new=${st.newShaders | 0} textures=${st.texUploads | 0} memory=${Math.round(memory.buffer.byteLength / 1048576)} MB threads=${workers.length}`);
    }
    statsEl.textContent = perf + `${workers.length} threads` + (r && r.stats ? ` · ${r.stats.draws} draws · ${r.stats.progs} shader states · ${r.stats.newShaders || 0} new · ${r.stats.texUploads} textures` : '');
    if (fpsEl && !fpsEl.hidden) fpsEl.textContent = fpsLine;
  }, 1000);
}
// no start menu: the game loads as soon as the page opens. Sound starts with the first key, click or touch
// (browsers only let a page play sound after the player did something on it).
document.getElementById('start').onclick = () => { UI.pop(660); play(); };
setTimeout(play, 0);   // automatically starts when a remote source or local server is configured

function startRenderer(memory, addr) {
  if (NORENDER) {   // performance tests: drop the GPU stream, only count frames
    const h = new Int32Array(memory.buffer, addr, 8), u32 = new Uint32Array(memory.buffer), size = h[3] >>> 0;
    const st = { frames: 0, draws: 0, progs: 0, texUploads: 0 }; window.__renderer = { stats: st }; Atomics.store(h, 2, 1);
    setInterval(() => { let r = Atomics.load(h, 1) >>> 0; const w = Atomics.load(h, 0) >>> 0;
      while (r !== w) { const b = (addr + 32 + (r % size)) >> 2, hdr = u32[b], t = hdr >>> 24; if (t === 8) { st.frames++; if (st.pend) { st.pend = 0; st.flips = (st.flips || 0) + 1; } } else if (t === 3) st.draws++; else if (t === 7 && u32[b + 1] === 0) { st.xfb = (st.xfb || 0) + 1; st.pend = 1; } else if (t === 10) { const f = new Int32Array(memory.buffer, u32[b + 6] & ~3, 1); Atomics.store(f, 0, 1); Atomics.notify(f, 0); } r = (r + (hdr & 0xFFFFFF) * 4) >>> 0; }
      Atomics.store(h, 1, r | 0); Atomics.notify(h, 1); }, 2);
    return;
  }
  const r = makeRenderer();
  if (!r) return;
  if (!r.uber) { try { r.uber = r.buildUber(); } catch (e) { log('[render] ubershader: ' + e.message); } }
  if (!r.onNewProgram) keepNewShaders(r);
  r.attach(memory, addr);
  // the game waits for EFB copies it reads back with the CPU: draw up to them as soon as it asks (h[5] counts requests)
  if (Atomics.waitAsync) {
    const hh = new Int32Array(memory.buffer, addr, 8);
    const urgent = (v) => { const res = Atomics.waitAsync(hh, 5, v); (res.async ? res.value : Promise.resolve()).then(() => { try { r.pump(30); } catch (e) { /* the frame loop reports errors */ } urgent(Atomics.load(hh, 5)); }); };
    urgent(Atomics.load(hh, 5));
  }
  // the loop must survive an error in one frame (before, one exception stopped the picture for good: 0 fps)
  let nerr = 0, lastRaf = performance.now(), lastPump = performance.now();
  const pumpSafe = (budget) => {
    lastPump = performance.now();
    try { r.pump(budget); }
    catch (e) { if (nerr++ < 30) log('[render] error in the loop: ' + (e.stack || e.message || e)); r.batch = null; r.invalidate(); }
  };
  const loop = () => { lastRaf = performance.now(); pumpSafe(14); requestAnimationFrame(loop); };
  // Watchdog: if the browser stops calling requestAnimationFrame (it does for hidden or covered windows, and
  // sometimes after a fullscreen change) the game would wait for the picture forever: keep the stream moving.
  // It also writes to the log what the picture stream was doing if it ever stops advancing.
  let lastR = -1, stuck = 0;
  setInterval(() => {
    const now = performance.now();
    if (now - lastRaf > 250 && now - lastPump > 100) pumpSafe(30);
    const hh = new Int32Array(memory.buffer, addr, 8), w = Atomics.load(hh, 0) >>> 0, rd = Atomics.load(hh, 1) >>> 0;
    if (w !== rd && rd === lastR) {
      if (++stuck === 30) {
        const off = rd % (hh[3] >>> 0), hdr = new Uint32Array(memory.buffer, addr + 32 + off, 4);
        log(`[render] drawing is not advancing! pending=${((w - rd) >>> 0) >> 10} KB record=${(hdr[0] >>> 24)}/${hdr[0] & 0xFFFFFF} ${hdr[1]} ${hdr[2]} raf=${Math.round(now - lastRaf)} ms pump=${Math.round(now - lastPump)} ms visible=${document.visibilityState} contexto=${r.gl.isContextLost() ? 'perdido' : 'ok'}`);
      }
    } else stuck = 0;
    lastR = rd;
  }, 100);
  requestAnimationFrame(loop);
}

let audioCtx = null;
function primeAudio() {   // created right away (suspended until the player presses something)
  try { audioCtx = new AudioContext({ sampleRate: 32000, latencyHint: 'interactive' }); } catch (e) { log('[audio] ' + e.message); return; }
  const wake = () => { if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {}); if (audioCtx.state === 'running') for (const t of ['pointerdown', 'keydown', 'touchstart']) removeEventListener(t, wake, true); };
  for (const t of ['pointerdown', 'keydown', 'touchstart']) addEventListener(t, wake, true);
  setInterval(() => { if (audioCtx.state !== 'running' && navigator.getGamepads && [...navigator.getGamepads()].some((g) => g && g.buttons.some((b) => b.pressed))) wake(); }, 250);
}
async function startAudio(memory, m) {
  if (!audioCtx) { log('[audio] no audio context (press Play to enable sound)'); return; }
  try {
    await audioCtx.audioWorklet.addModule('audio-worklet.js');
    const node = new AudioWorkletNode(audioCtx, 'rgh-audio', { outputChannelCount: [2], processorOptions: { memory, ring: m.ring, len: m.len, wpos: m.wpos, rpos: m.rpos } });
    node.connect(audioCtx.destination);
    // audio level and underruns, summarised every 10 s in the log
    const au = { rms: [], dry: 0, drop: 0, buf: 0 };
    node.port.onmessage = (e) => { const d = e.data; au.last = d.rms; au.rms.push(d.rms); au.dry += d.dry; au.drop += d.drop; au.buf = d.buf; au.target = d.target; };
    window.__audioLevel = () => au.last | 0;
    window.__audioStat = () => { const t = `audio: level ${au.rms.length ? Math.max(...au.rms) : 0} (min ${au.rms.length ? Math.min(...au.rms) : 0}) underruns=${au.dry} drops=${au.drop} buffer=${au.buf}/${au.target} ms state=${audioCtx.state}`; au.rms = []; au.dry = 0; au.drop = 0; return t; };
    new Int32Array(memory.buffer, m.on, 1)[0] = 1;
    if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
    log(`[audio] ${audioCtx.sampleRate} Hz${audioCtx.state === 'running' ? '' : ' (starts with the first key or click)'}`);
  } catch (e) { log('[audio] ' + e.message); }
}

// ---- NAND (save data, settings) persisted in IndexedDB of this browser
function idb() {
  return new Promise((res, rej) => { const r = indexedDB.open('nsmbw-web', 1); r.onupgradeneeded = () => r.result.createObjectStore('nand'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function nandLoad() {
  try { const db = await idb(); return await new Promise((res) => { const q = db.transaction('nand').objectStore('nand').get('image'); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); }
  catch (e) { return null; }
}
async function nandSave(buf) {
  try { const db = await idb(); db.transaction('nand', 'readwrite').objectStore('nand').put(buf, 'image'); log(`[nand] saved (${buf.byteLength} bytes)`); }
  catch (e) { log('[nand] no se pudo guardar: ' + e.message); }
  nandBackup(buf);
}
// a copy of the save goes to the launcher too (nsmbw-save-backup.bin next to web/): a backup outside the browser
// (clearing the browser data would otherwise delete the game's progress)
let nandBackupT = 0, nandBackupBuf = null;
function nandBackup(buf) {
  if (location.protocol === 'file:' || !buf) return;
  nandBackupBuf = buf; clearTimeout(nandBackupT);
  nandBackupT = setTimeout(() => { fetch('nand', { method: 'POST', body: nandBackupBuf }).catch(() => {}); nandBackupBuf = null; }, 1500);
}
nandPromise.then((b) => { if (b) nandBackup(b); });
