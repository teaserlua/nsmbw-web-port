// rgh-worker.js - runs one guest fiber (a wasi-thread) of the recompiled game.
// All workers share one WebAssembly.Memory; only one of them runs at any moment (see fiber_wasm.c).
'use strict';

let mem, module, cfg, tidBuf, inst;
const td = new TextDecoder();
const lineBuf = { 1: '', 2: '' };

function u8() { return new Uint8Array(mem.buffer); }
function dv() { return new DataView(mem.buffer); }
function str(p, n) { return td.decode(u8().slice(p, p + n)); }

// ---------------------------------------------------------------- game files (HTTP Range, synchronous)
const sizeCache = new Map();
const blockCache = new Map();      // url|block -> Uint8Array
const BLOCK = 262144, MAXBLOCKS = 96;      // 256 KiB per request: fewer round trips while the game loads
let localFiles = null, localReader = null;
function fileUrl(path) { return cfg.base + path.split('/').map(encodeURIComponent).join('/'); }
function fileSize(path) {
  if (localFiles) return localFiles.get(path)?.size ?? -1;
  if (sizeCache.has(path)) return sizeCache.get(path);
  const x = new XMLHttpRequest();
  x.open('HEAD', fileUrl(path), false);
  try { x.send(); } catch (e) { sizeCache.set(path, -1); return -1; }
  const n = x.status === 200 ? Number(x.getResponseHeader('Content-Length')) : -1;
  sizeCache.set(path, n);
  return n;
}
function getBlock(path, b) {
  const key = path + '|' + b;
  let blk = blockCache.get(key);
  if (blk) { blockCache.delete(key); blockCache.set(key, blk); return blk; }
  if (localFiles) {
    const file=localFiles.get(path);
    if (!file) return null;
    blk=new Uint8Array(localReader.readAsArrayBuffer(file.slice(b*BLOCK,(b+1)*BLOCK)));
  } else {
    const x=new XMLHttpRequest();
    x.open('GET',fileUrl(path),false);
    x.responseType='arraybuffer';
    x.setRequestHeader('Range',`bytes=${b*BLOCK}-${b*BLOCK+BLOCK-1}`);
    try{x.send()}catch{return null;}
    if(x.status!==206&&x.status!==200)return null;
    blk=new Uint8Array(x.response);
    if(x.status===200){
      if(blk.length>4*BLOCK) return null;
      blk=blk.slice(b*BLOCK,b*BLOCK+BLOCK);
    }
  }
  blockCache.set(key, blk);
  if (blockCache.size > MAXBLOCKS) blockCache.delete(blockCache.keys().next().value);
  return blk;
}
function fileRead(path, off, dst, n) {
  const size = fileSize(path);
  if (size < 0) return -1;
  if (off >= size) return 0;
  if (off + n > size) n = size - off;
  const m = u8();
  let done = 0;
  while (done < n) {
    const pos = off + done, b = Math.floor(pos / BLOCK), o = pos - b * BLOCK;
    const blk = getBlock(path, b);
    if (!blk) return -1;
    const k = Math.min(blk.length - o, n - done);
    if (k <= 0) break;
    m.set(blk.subarray(o, o + k), dst + done);
    done += k;
  }
  return done;
}

// ---------------------------------------------------------------- WASI (the subset wasi-libc needs)
const ENOSYS = 52, EBADF = 8, ESUCCESS = 0;
function wasi() {
  const env = Object.entries(cfg.env || {}).map(([k, v]) => `${k}=${v}`);
  const args = ['rgh', 'game'];
  const enc = new TextEncoder();
  const putStrings = (list, ptrs, buf) => {
    const d = dv(), m = u8();
    for (const s of list) { d.setUint32(ptrs, buf, true); ptrs += 4; const b = enc.encode(s + '\0'); m.set(b, buf); buf += b.length; }
    return 0;
  };
  const sizes = (list, pc, pb) => { const d = dv(); d.setUint32(pc, list.length, true); d.setUint32(pb, list.reduce((a, s) => a + enc.encode(s).length + 1, 0), true); return 0; };
  return {
    args_sizes_get: (pc, pb) => sizes(args, pc, pb),
    args_get: (p, b) => putStrings(args, p, b),
    environ_sizes_get: (pc, pb) => sizes(env, pc, pb),
    environ_get: (p, b) => putStrings(env, p, b),
    fd_write(fd, iovs, n, nw) {
      const d = dv(); let total = 0, s = '';
      for (let i = 0; i < n; i++) { const p = d.getUint32(iovs + 8 * i, true), l = d.getUint32(iovs + 8 * i + 4, true); s += str(p, l); total += l; }
      d.setUint32(nw, total, true);
      if (fd === 1 || fd === 2) {
        lineBuf[fd] += s;
        let k;
        while ((k = lineBuf[fd].indexOf('\n')) >= 0) { postMessage({ type: 'log', fd, text: lineBuf[fd].slice(0, k) }); lineBuf[fd] = lineBuf[fd].slice(k + 1); }
      }
      return ESUCCESS;
    },
    fd_close: () => ESUCCESS,
    fd_seek: () => EBADF,
    fd_read: () => EBADF,
    fd_fdstat_get(fd, p) { if (fd > 2) return EBADF; const d = dv(); d.setUint8(p, 2); d.setUint16(p + 2, 0, true); d.setBigUint64(p + 8, 0n, true); d.setBigUint64(p + 16, 0n, true); return 0; },
    fd_fdstat_set_flags: () => ESUCCESS,
    fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF,
    path_open: () => 44,           // ENOENT
    path_filestat_get: () => 44,
    clock_time_get(id, prec, out) {
      const ns = BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
      dv().setBigUint64(out, ns, true); return 0;
    },
    clock_res_get(id, out) { dv().setBigUint64(out, 1000n, true); return 0; },
    random_get(p, n) { const b = new Uint8Array(n); crypto.getRandomValues(b); u8().set(b, p); return 0; },
    sched_yield: () => 0,
    poll_oneoff: () => ENOSYS,
    proc_exit(code) { postMessage({ type: 'exit', code }); throw new Error('exit ' + code); },
  };
}

function imports() {
  const w = wasi();
  const imp = { env: { memory: mem }, wasi_snapshot_preview1: w, wasi: {}, rgh: {} };
  imp.wasi['thread-spawn'] = (arg) => {
    const tid = Atomics.add(tidBuf, 0, 1) + 1;
    postMessage({ type: 'spawn', tid, arg });
    return tid;
  };
  imp.rgh.file_size = (p, n) => BigInt(fileSize(str(p, n)));
  imp.rgh.file_read = (p, n, off, dst, len) => fileRead(str(p, n), Number(off), dst, len);
  imp.rgh.ring_ready = (addr) => postMessage({ type: 'ring', addr });
  imp.rgh.dbg_ready = (addr) => postMessage({ type: 'dbg', addr });
  imp.rgh.pad_ready = (addr) => postMessage({ type: 'pad', addr });
  imp.rgh.gcpad_ready = (addr) => postMessage({ type: 'gcpad', addr });
  imp.rgh.nand_size = () => (cfg.nand ? cfg.nand.byteLength : 0);
  imp.rgh.nand_read = (dst) => { u8().set(new Uint8Array(cfg.nand), dst); };
  imp.rgh.nand_save = (src, len) => postMessage({ type: 'nand', data: u8().slice(src, src + len).buffer });
  imp.rgh.audio_ready = (ring, len, wpos, rpos, on) => postMessage({ type: 'audio', ring, len, wpos, rpos, on });
  // anything else the module imports: report "not supported"
  for (const d of WebAssembly.Module.imports(module)) {
    const ns = imp[d.module] || (imp[d.module] = {});
    if (!(d.name in ns) && d.kind === 'function') ns[d.name] = () => { postMessage({ type: 'log', fd: 2, text: `[host] unimplemented import ${d.module}.${d.name}` }); return ENOSYS; };
  }
  return imp;
}

onmessage = async (e) => {
  const m = e.data;
  if (m.type !== 'start') return;
  ({ memory: mem, module, cfg, tidBuf } = m);
  if (cfg.localFiles) { localFiles=new Map(cfg.localFiles); localReader=new FileReaderSync(); }
  try {
    inst = await WebAssembly.instantiate(module, imports());
    if (m.tid === 0) inst.exports._start();
    else inst.exports.wasi_thread_start(m.tid, m.arg);
    postMessage({ type: 'log', fd: 2, text: `[host] thread ${m.tid} finished` });
  } catch (err) {
    postMessage({ type: 'log', fd: 2, text: `[host] thread ${m.tid}: ${err && err.stack || err}` });
    postMessage({ type: 'crash', tid: m.tid, error: String(err) });
  }
};
