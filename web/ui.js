// ui.js - title screen, settings / credits overlays, in-game buttons, toasts. The game itself is started by
// rgh-host.js (window.RGH_UI.onPlay is set there).
'use strict';

const UI = (() => {
  const $ = (id) => document.getElementById(id);
  const KEY = 'nsmbw-ui-v1';
  let opts = { fps: false, info: false, shaderMode: 'hybrid', scale: 2 };
  try { Object.assign(opts, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* defaults */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(opts)); } catch (e) { /* private mode */ } };
  const apply = () => {
    document.body.classList.toggle('show-info', !!opts.info);
    $('fps').hidden = !opts.fps;
    $('opt-fps').checked = !!opts.fps; $('opt-info').checked = !!opts.info; $('opt-shmode').value = opts.shaderMode; $('opt-scale').value = String(opts.scale || 2);
    if (window.__renderer) window.__renderer.uberOnly = opts.shaderMode === 'uber';
  };

  // ---- small Wii-like "pop" for the menu buttons (WebAudio, after the first click)
  let actx = null;
  function pop(freq = 880) {
    try {
      if (!actx) actx = new AudioContext();
      const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(freq * 1.5, t + 0.05);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.13);
    } catch (e) { /* no audio */ }
  }

  // ---- fullscreen
  const isFull = () => !!document.fullscreenElement;
  async function fullscreen(on = !isFull()) {
    try { if (on && !isFull()) await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); else if (!on && isFull()) await document.exitFullscreen(); } catch (e) { /* refused */ }
  }
  const fullLabel = () => { const t = isFull() ? 'Exit full screen' : 'Full screen'; $('hud-full').textContent = t; $('opt-full').textContent = isFull() ? 'Turn off' : 'Turn on'; };
  document.addEventListener('fullscreenchange', fullLabel);

  // ---- toasts
  function toast(text, icon) {
    const d = document.createElement('div'); d.className = 'toast';
    if (icon) { const i = document.createElement('img'); i.onerror = () => i.remove(); i.src = icon; i.alt = ''; d.appendChild(i); }
    d.appendChild(document.createTextNode(text));
    $('toasts').appendChild(d); setTimeout(() => d.remove(), 3300);
  }

  // ---- loading bar
  function progress(frac, text, sub) {
    $('barfill').style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    if (text !== undefined) $('loadtext').textContent = text;
    if (sub !== undefined) $('loadsub').textContent = sub;
  }

  function init() {
    apply(); fullLabel();
    // clock on the Wii-like strip
    const clock = () => {
      const d = new Date();
      $('clock').innerHTML = `${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}<small>${d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })}</small>`;
    };
    clock(); setInterval(clock, 10000);

    // title buttons
    for (const b of document.querySelectorAll('#menu .ibtn')) b.addEventListener('mouseenter', () => actx && pop(1250));
    $('t-settings').onclick = () => { pop(); window.openControls && window.openControls(); };
    $('t-credits').onclick = () => { pop(); $('credits').hidden = false; };
    $('credits-close').onclick = () => { $('credits').hidden = true; };
    for (const ov of [$('credits'), $('controls')]) ov.addEventListener('mousedown', (e) => { if (e.target === ov) { ov.hidden = true; } });
    addEventListener('keydown', (e) => { if (e.code === 'Escape') { $('credits').hidden = true; } });

    // settings tabs
    for (const t of document.querySelectorAll('.tab')) t.onclick = () => {
      for (const o of document.querySelectorAll('.tab')) o.classList.toggle('on', o === t);
      for (const p of document.querySelectorAll('.pane')) p.hidden = p.id !== t.dataset.pane;
      if (t.dataset.pane === 'p-video') countShaders();
    };
    $('opt-full').onclick = () => fullscreen();
    $('opt-fps').onchange = () => { opts.fps = $('opt-fps').checked; save(); apply(); };
    $('opt-info').onchange = () => { opts.info = $('opt-info').checked; save(); apply(); };
    $('opt-shmode').onchange = () => { opts.shaderMode = $('opt-shmode').value; save(); apply(); };
    $('opt-export').onclick = exportShaders;
    $('opt-scale').onchange = () => { opts.scale = Number($('opt-scale').value) || 2; save(); if (window.__renderer) toast('The new resolution is used the next time you press Play'); };

    // in-game buttons: shown while the mouse moves or the screen is touched, hidden 2.5 s later
    let hideT = 0;
    const wake = () => { document.body.classList.add('show-hud'); clearTimeout(hideT); hideT = setTimeout(() => { if (!$('hud').matches(':hover')) document.body.classList.remove('show-hud'); else wake(); }, 2500); };
    addEventListener('mousemove', () => { if (document.body.classList.contains('playing') && !document.pointerLockElement) wake(); });
    addEventListener('touchstart', () => { if (document.body.classList.contains('playing')) wake(); }, { passive: true });
    $('hud-full').onclick = () => fullscreen();

    // connection pills and toasts (controller, phone)
    let lastGp = null, lastDsu = null;
    setInterval(() => {
      const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
      const gp = pads[0] ? pads[0].id.replace(/\s*\(.*$/, '') : null;
      $('gp-pill').textContent = gp ? `Controller: ${gp.slice(0, 28)}` : 'No controller'; $('gp-pill').classList.toggle('ok', !!gp);
      if (gp !== lastGp) { if (gp) toast(`Controller connected: ${gp.slice(0, 40)}`); else if (lastGp) toast('Controller disconnected'); lastGp = gp; }
      const dsu = typeof DSU !== 'undefined' ? DSU : null, live = !!(dsu && dsu.on && dsu.status.startsWith('connected'));
      $('dsu-pill').textContent = live ? 'DSU connected' : dsu && dsu.on ? 'DSU waiting…' : 'DSU disconnected'; $('dsu-pill').classList.toggle('ok', live);
      if (lastDsu !== null && live !== lastDsu) toast(live ? 'Phone connected (DSU Remote)' : 'Phone disconnected', 'assets/dsu.png');
      lastDsu = live;
    }, 500);
  }

  // ---- shaders seen in this browser (IndexedDB rgh-shaders): count / export as a shaders.bin-style file
  function shaderDB() { return new Promise((res, rej) => { const q = indexedDB.open('nsmbw-shaders-1', 1); q.onupgradeneeded = () => q.result.createObjectStore('s'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
  async function ownShaders() { try { const db = await shaderDB(); return await new Promise((res) => { const q = db.transaction('s').objectStore('s').getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); }); } catch (e) { return []; } }
  async function countShaders() { const n = (await ownShaders()).length; $('opt-shcount').textContent = `${n} shader states saved in this browser; they are precompiled automatically next time. You can export them to have them added to the port.`; }
  async function exportShaders() {
    const all = await ownShaders();
    if (!all.length) { toast('No saved shaders yet'); return; }
    const blob = new Blob(all.map((b) => new Uint8Array(b)), { type: 'application/octet-stream' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'nsmbw-shaders-seen.bin'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`${all.length} shaders exported`);
  }

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', init); else init();
  // the game stopped: say so (and where the log went) instead of leaving a frozen picture
  function crashed(what) {
    if (document.getElementById('crash')) return;
    const d = document.createElement('div'); d.id = 'crash'; d.className = 'overlay';
    d.innerHTML = `<div class="card" style="width:min(560px,calc(100vw - 32px));padding:28px 30px;text-align:center">
      <h2 style="margin:0 0 10px;color:var(--wii-deep);font:800 24px var(--round)">Oops, the game stopped</h2>
      <p style="margin:0 0 8px;color:var(--ink)">${what}</p>
      <p style="margin:0 0 18px;color:var(--ink-soft);font-size:13px">The log was saved to <b>nsmbw-log.txt</b> (in the nsmbw-web folder).</p>
      <button class="wbtn blue" onclick="location.reload()">Restart</button></div>`;
    document.body.appendChild(d);
  }
  return { opts, apply, toast, progress, fullscreen, pop, ownShaders, shaderDB, crashed };
})();
self.UI = UI;
