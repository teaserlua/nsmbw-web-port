// input.js - keyboard / mouse / gamepad / DSU phone -> emulated Wii Remote + Nunchuk (runtime/wpad.c Pad struct)
// or GameCube controller on port 1 (runtime/hw.c GcPad struct), chosen in Settings > Controls
// Bindings (keyboard and gamepad buttons) are changed in the "Controles" panel and kept in this browser.
'use strict';
const BTN = { LEFT: 0x0001, RIGHT: 0x0002, DOWN: 0x0004, UP: 0x0008, PLUS: 0x0010, TWO: 0x0100, ONE: 0x0200, B: 0x0400, A: 0x0800, MINUS: 0x1000, Z: 0x2000, C: 0x4000, HOME: 0x8000 };
const PAD_BYTES = 60;   // sizeof(Pad) in runtime/input.h

// action id -> [label, default keys, default gamepad buttons (standard mapping indices), mode]
// New Super Mario Bros. Wii holds the Wii Remote sideways: the player's left/right/up/down are the remote's
// D-pad up/down/right/left, 2 = jump / OK, 1 = run / fireball / back, shake = spin jump / pick up.
// The GameCube controller mode is kept for other games; NSMBW does not read it.
const ACTIONS = [
  ['MLEFT', 'Move left', ['ArrowLeft', 'KeyA'], [14], 'wii'],
  ['MRIGHT', 'Move right', ['ArrowRight', 'KeyD'], [15], 'wii'],
  ['MUP', 'Up (enter doors / climb)', ['ArrowUp', 'KeyW'], [12], 'wii'],
  ['MDOWN', 'Down (crouch / pipes)', ['ArrowDown', 'KeyS'], [13], 'wii'],
  ['TWO', '2 button: jump / OK', ['Space', 'KeyK'], [0, 3], 'wii'],
  ['ONE', '1 button: run / fireball / back', ['ShiftLeft', 'KeyJ'], [2, 1], 'wii'],
  ['SHAKE', 'Shake: spin jump / pick up', ['KeyE', 'KeyL'], [5, 7], 'wii'],
  ['PLUS', '+ button (pause)', ['Enter', 'KeyP'], [9], 'wii'],
  ['MINUS', '− button', ['Backspace', 'KeyM'], [8], 'wii'],
  ['A', 'A button', ['KeyQ'], [4], 'wii'],
  ['B', 'B button', ['KeyB'], [6], 'wii'],
  ['HOME', 'HOME button', ['KeyH'], [16], 'wii'],
  ['GA', 'A (accelerate / OK)', ['Space', 'Enter'], [0], 'gc'],
  ['GB', 'B (brake / back)', ['KeyX', 'Backspace'], [1], 'gc'],
  ['GX', 'X (look back)', ['KeyC'], [2], 'gc'],
  ['GY', 'Y', ['KeyV'], [3], 'gc'],
  ['GL', 'L (use item)', ['KeyQ'], [6, 4], 'gc'],
  ['GR', 'R (drift / hop)', ['ShiftLeft', 'KeyE'], [7, 5], 'gc'],
  ['GZ', 'Z', ['KeyZ'], [], 'gc'],
  ['GSTART', 'START (pause)', ['KeyP', 'Escape'], [9], 'gc'],
  ['GUP', 'D-pad up (trick)', ['ArrowUp'], [12], 'gc'],
  ['GDOWN', 'D-pad down', ['ArrowDown'], [13], 'gc'],
  ['GLEFT', 'D-pad left', ['ArrowLeft'], [14], 'gc'],
  ['GRIGHT', 'D-pad right', ['ArrowRight'], [15], 'gc'],
  ['GSUP', 'Stick up', ['KeyW'], [], 'gc'],
  ['GSDOWN', 'Stick down', ['KeyS'], [], 'gc'],
  ['GSLEFT', 'Stick left (steer)', ['KeyA'], [], 'gc'],
  ['GSRIGHT', 'Stick right (steer)', ['KeyD'], [], 'gc'],
  ['GCUP', 'C-stick up', ['KeyI'], [], 'gc'],
  ['GCDOWN', 'C-stick down', ['KeyK'], [], 'gc'],
  ['GCLEFT', 'C-stick left', ['KeyJ'], [], 'gc'],
  ['GCRIGHT', 'C-stick right', ['KeyL'], [], 'gc'],
];
const GC = { LEFT: 0x0001, RIGHT: 0x0002, DOWN: 0x0004, UP: 0x0008, Z: 0x0010, R: 0x0020, L: 0x0040, A: 0x0100, B: 0x0200, X: 0x0400, Y: 0x0800, START: 0x1000 };
const MODE_KEY = 'nsmbw-ctl-mode';
let gMode = (() => { try { return false ? 'gc' : 'wii'; } catch (e) { return 'wii'; } })();
const PAD_NAMES = ['A / Cross', 'B / Circle', 'X / Square', 'Y / Triangle', 'LB / L1', 'RB / R1', 'LT / L2', 'RT / R2',
  'Back / Share', 'Start / Options', 'L3 (left stick)', 'R3 (right stick)', 'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →', 'Guide / PS'];
const BIND_KEY = 'nsmbw-binds-v1';
function defaultBinds() { const b = {}; for (const [id, , keys, pads] of ACTIONS) b[id] = { k: keys.slice(), p: pads.slice() }; return b; }
const modeOf = (id) => (ACTIONS.find((a) => a[0] === id) || [])[4];
function loadBinds() {
  const b = defaultBinds();
  try {
    const s = JSON.parse(localStorage.getItem(BIND_KEY) || 'null');
    if (s && typeof s === 'object') for (const id in b) if (s[id]) {
      if (Array.isArray(s[id].k)) b[id].k = s[id].k.filter((k) => typeof k === 'string').slice(0, 2);
      if (Array.isArray(s[id].p)) b[id].p = s[id].p.filter((k) => Number.isInteger(k) && k >= 0 && k < 32).slice(0, 2);
    }
  } catch (e) { /* storage unavailable: defaults */ }
  return b;
}
function saveBinds(b) { try { localStorage.setItem(BIND_KEY, JSON.stringify(b)); } catch (e) { /* ignore */ } }
function keyName(code) {
  if (!code) return '—';
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, 'Arrow ').replace('Space', 'Space')
    .replace('ShiftLeft', 'L-Shift').replace('ShiftRight', 'R-Shift').replace('ControlLeft', 'L-Ctrl').replace('ControlRight', 'R-Ctrl')
    .replace('Up', '↑').replace('Down', '↓').replace('Left', '←').replace('Right', '→');
}
function padName(i) { return i === undefined ? '—' : (PAD_NAMES[i] || `Button ${i}`); }

let gBinds = loadBinds();
let gKeyToActions = null, gPadToActions = null;
function rebuildMap() {
  gKeyToActions = new Map(); gPadToActions = new Map();
  for (const id in gBinds) {
    if (modeOf(id) !== gMode) continue;      // only the bindings of the controller in use
    for (const k of gBinds[id].k) { if (!gKeyToActions.has(k)) gKeyToActions.set(k, []); gKeyToActions.get(k).push(id); }
    for (const p of gBinds[id].p) { if (!gPadToActions.has(p)) gPadToActions.set(p, []); gPadToActions.get(p).push(id); }
  }
}
rebuildMap();
let gCapture = null;     // while the settings panel waits for a key: (code) => void
let gPadCapture = null;  // ... or for a gamepad button: (index) => void

function firstGamepad() { if (!navigator.getGamepads) return null; for (const g of navigator.getGamepads()) if (g && g.connected) return g; return null; }
const dz = (v, d = 0.18) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));

// ---------------------------------------------------------------- DSU (cemuhook) - e.g. "DSU Remote" phone app
// The local launcher (serve.py / start-nsmbw-web.ps1) talks UDP to the phone(s); we poll /dsu/state, which
// returns one 100-byte pad packet per connected slot. Each slot gets a role chosen in the panel:
//  wiimote  - the app's "WiiMote" layout: Cross=A, Square=B, Triangle=1, Circle=2, Share=-, Options=+, PS=HOME,
//             D-pad, gyro -> pointer, touch = recenter, phone motion = Wii Remote motion (shake)
//  nunchuk  - phone motion = Nunchuk motion (shake it), stick = Nunchuk stick, Cross/ZL/ZR = Z, other buttons = C
//  classic  - the app's "Classic" layout used as Wiimote+Nunchuk: left stick = Nunchuk, right stick = pointer,
//             a=A, b=B, ZR=B, ZL=Z, L=C, R=shake Nunchuk, x=1, y=2, -,+,HOME, D-pad, phone motion = Wiimote
const DSU_KEY = 'nsmbw-dsu-v1';
const ROLES = { wiimote: 'Wiimote', nunchuk: 'Nunchuk', classic: 'Classic controller → Wii Remote+Nunchuk', off: 'Not used' };
function dsuSlot() { return { buttons: 0, stick: null, rstick: null, acc: null, gyro: null, touch: false, ts: 0n, fresh: 0, nshake: false, seen: 0 }; }
const DSU = {
  cfg: { host: '', port: 26760, sens: 1.0, invX: false, invY: false, auto: false, roles: ['wiimote', 'nunchuk', 'off', 'off'] },
  on: false, status: 'disconnected', slots: [dsuSlot(), dsuSlot(), dsuSlot(), dsuSlot()], live: [],
  load() { try { const s = JSON.parse(localStorage.getItem(DSU_KEY) || '{}'); Object.assign(this.cfg, s); if (!Array.isArray(this.cfg.roles) || this.cfg.roles.length !== 4) this.cfg.roles = ['wiimote', 'nunchuk', 'off', 'off']; } catch (e) { /* defaults */ } },
  save() { try { localStorage.setItem(DSU_KEY, JSON.stringify(this.cfg)); } catch (e) { /* ignore */ } },
  async connect() {
    const r = await fetch(`dsu/connect?host=${encodeURIComponent(this.cfg.host)}&port=${this.cfg.port | 0}`).catch(() => null);
    if (!r) { this.status = 'the launcher is not responding'; return false; }
    if (r.status === 404) { this.status = 'this launcher has no DSU bridge (update serve.py / the .ps1)'; return false; }
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { this.status = j.error || 'error'; return false; }
    this.on = true; this.status = 'waiting for data from the phone…'; this.poll(); return true;
  },
  clear() { this.slots = [dsuSlot(), dsuSlot(), dsuSlot(), dsuSlot()]; this.live = []; },
  async disconnect() { this.on = false; this.clear(); this.status = 'disconnected'; await fetch('dsu/disconnect').catch(() => null); },
  async poll() {
    if (this.polling) return; this.polling = true;
    while (this.on) {
      const r = await fetch('dsu/state', { cache: 'no-store' }).catch(() => null);
      if (r && r.status === 200) {
        const buf = await r.arrayBuffer(); if (!this.on) break;
        const live = [];
        for (let o = 0; o + 100 <= buf.byteLength; o += 100) { const d = new DataView(buf, o, 100); const s = d.getUint8(20) & 3; this.parse(s, d); live.push(s); }
        for (let s = 0; s < 4; s++) if (!live.includes(s)) this.slots[s] = dsuSlot();
        this.live = live;
        this.status = 'connected: ' + live.map((s) => `slot ${s + 1} = ${ROLES[this.cfg.roles[s]] || '?'}`).join(', ');
      } else {
        this.clear();
        if (this.on) this.status = r ? 'waiting for data from the phone… (right IP? same Wi-Fi network? app open?)' : 'the launcher is not responding';
        await new Promise((ok) => setTimeout(ok, 250));
      }
      await new Promise((ok) => setTimeout(ok, 4));
    }
    this.polling = false;
  },
  parse(slot, d) {
    const role = this.cfg.roles[slot] || 'off', S = this.slots[slot];
    const b1 = d.getUint8(36), b2 = d.getUint8(37), home = d.getUint8(38), touch = d.getUint8(39);
    const cross = b2 & 0x40, circle = b2 & 0x20, square = b2 & 0x80, tri = b2 & 0x10, l1 = b2 & 0x04, r1 = b2 & 0x08, l2 = b2 & 0x01, r2 = b2 & 0x02;
    let b = 0; S.nshake = false;
    const common = () => {
      if (b1 & 0x01) b |= BTN.MINUS; if (b1 & 0x08) b |= BTN.PLUS; if (home) b |= BTN.HOME;
      if (b1 & 0x10) b |= BTN.UP; if (b1 & 0x20) b |= BTN.RIGHT; if (b1 & 0x40) b |= BTN.DOWN; if (b1 & 0x80) b |= BTN.LEFT;
    };
    if (role === 'wiimote') {
      if (cross) b |= BTN.A; if (square) b |= BTN.B; if (tri) b |= BTN.ONE; if (circle) b |= BTN.TWO;
      if (l1 || l2) b |= BTN.Z; if (r1) b |= BTN.C; if (r2) b |= BTN.B; common();
    } else if (role === 'nunchuk') {
      if (cross || l2 || r2) b |= BTN.Z; if (circle || square || tri || l1 || r1) b |= BTN.C;
    } else if (role === 'classic') {
      if (cross) b |= BTN.A; if (circle || r2) b |= BTN.B; if (l2) b |= BTN.Z; if (l1) b |= BTN.C; if (tri) b |= BTN.ONE; if (square) b |= BTN.TWO;
      if (r1) S.nshake = true; common();
    }
    S.buttons = role === 'off' ? 0 : b; S.touch = !!touch && role !== 'nunchuk';
    const ax = (o) => Math.max(-1, Math.min(1, (d.getUint8(o) - 128) / 127));
    const lx = ax(40), ly = ax(41), rx = ax(42), ry = ax(43);
    S.stick = Math.hypot(lx, ly) > 0.2 ? [lx, ly] : null;
    S.rstick = Math.hypot(rx, ry) > 0.2 ? [rx, ry] : null;
    const ts = d.getBigUint64(68, true);
    if (ts !== S.ts) {
      const dt = S.ts && ts > S.ts ? Math.min(0.1, Number(ts - S.ts) / 1e6) : 0; S.ts = ts;
      S.acc = [d.getFloat32(76, true), d.getFloat32(80, true), d.getFloat32(84, true)];
      S.gyro = [d.getFloat32(88, true), d.getFloat32(92, true), d.getFloat32(96, true), dt];
      S.fresh++;
    }
  },
};
DSU.load();

function shakeWave(now, k = 1) { const ph = now / 40 * k; return [Math.sin(ph) * 2.5, Math.cos(ph * 1.3) * 2.5, 1 + Math.sin(ph * 0.7) * 2.5]; }

class PadInput {
  constructor(canvas, memory, addr) {
    this.canvas = canvas; this.memory = memory; this.addr = addr;
    this.keys = new Set(); this.mouseBtn = 0; this.px = 0; this.py = 0; this.shake = 0; this.nshake = 0; this.screen = 0;
    addEventListener('keydown', (e) => {
      if (gCapture || gPadCapture || (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT'))) return;
      if (gKeyToActions.has(e.code)) {
        e.preventDefault();
        // keep a focused button (e.g. "Iniciar") from also reacting to Space/Enter
        if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
      }
      this.keys.add(e.code);
    }, true);
    addEventListener('keyup', (e) => { this.keys.delete(e.code); if (gKeyToActions.has(e.code)) e.preventDefault(); }, true);
    addEventListener('blur', () => { this.keys.clear(); this.mouseBtn = 0; this.screen = 0; });
    // Mouse = pointer. Clicking the game captures the mouse (pointer lock, Esc releases it): then the mouse moves
    // the pointer by its movement, so it never leaves the game and can reach every edge (a bit past them, like
    // a real Wii Remote). Without the capture the pointer follows the cursor over the picture.
    const LIM = 1.25;
    const clamp = (v) => Math.max(-LIM, Math.min(LIM, v));
    this.locked = () => document.pointerLockElement === canvas;
    addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      if (this.locked()) { this.px = clamp(this.px + (e.movementX / r.width) * 2.2); this.py = clamp(this.py - (e.movementY / r.height) * 2.2); return; }
      if (e.target !== canvas && !(e.target && e.target.id === 'screen')) return;
      this.px = clamp((((e.clientX - r.left) / r.width) * 2 - 1) * 1.1); this.py = clamp((1 - ((e.clientY - r.top) / r.height) * 2) * 1.1);
    });
    canvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (!this.locked() && document.body.classList.contains('playing') && canvas.requestPointerLock) {
        try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (err) { /* not allowed */ }
        if (!this.lockHint) { this.lockHint = 1; if (self.UI) UI.toast('Mouse captured by the game · press Esc to release it'); }
        return;      // this click only captures the mouse
      }
      this.mouseBtn |= 1 << e.button;
    });
    addEventListener('mouseup', (e) => { this.mouseBtn &= ~(1 << e.button); });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.lastT = performance.now();
    setInterval(() => this.update(), 4);
  }
  // buttons held from the on-screen bar (A+B etc.)
  hold(mask, on) { this.screen = on ? (this.screen | mask) : (this.screen & ~mask); }
  update() {
    const now = performance.now(), dt = Math.min(0.05, (now - this.lastT) / 1000); this.lastT = now;
    const act = new Set();
    for (const c of this.keys) { const a = gKeyToActions.get(c); if (a) for (const x of a) act.add(x); }
    let sx = 0, sy = 0;
    // gamepad (standard mapping): buttons through the bindings, left stick = Nunchuk, right stick = pointer
    const gp = gPadCapture ? null : firstGamepad();
    if (gp) {
      gp.buttons.forEach((bt, i) => { if (bt && (bt.pressed || bt.value > 0.5)) { const a = gPadToActions.get(i); if (a) for (const x of a) act.add(x); } });
      const lx = dz(gp.axes[0] || 0), ly = dz(gp.axes[1] || 0), rx = dz(gp.axes[2] || 0), ry = dz(gp.axes[3] || 0);
      if (lx || ly) { sx = lx; sy = -ly; }
      if (rx || ry) { this.px = Math.max(-1, Math.min(1, this.px + rx * 1.8 * dt)); this.py = Math.max(-1, Math.min(1, this.py - ry * 1.8 * dt)); }
    }
    let b = this.screen;
    for (const id of ['A', 'B', 'PLUS', 'MINUS', 'HOME', 'ONE', 'TWO']) if (act.has(id)) b |= BTN[id];
    // sideways Wii Remote: player directions -> D-pad rotated a quarter turn (left = up, right = down, up = right, down = left)
    if (act.has('MLEFT') || sx < -0.5) b |= BTN.UP;
    if (act.has('MRIGHT') || sx > 0.5) b |= BTN.DOWN;
    if (act.has('MUP') || sy > 0.5) b |= BTN.RIGHT;
    if (act.has('MDOWN') || sy < -0.5) b |= BTN.LEFT;
    sx = 0; sy = 0;
    if (act.has('AB')) b |= BTN.A | BTN.B;
    if (this.mouseBtn & 1) b |= BTN.A;
    if (this.mouseBtn & 6) b |= BTN.B;
    const kx = (act.has('SRIGHT') ? 1 : 0) - (act.has('SLEFT') ? 1 : 0), ky = (act.has('SUP') ? 1 : 0) - (act.has('SDOWN') ? 1 : 0);
    if (kx || ky) { sx = kx; sy = ky; }
    const pdx = (act.has('PRIGHT') ? 1 : 0) - (act.has('PLEFT') ? 1 : 0), pdy = (act.has('PUP') ? 1 : 0) - (act.has('PDOWN') ? 1 : 0);
    if (pdx || pdy) { this.px = Math.max(-1, Math.min(1, this.px + pdx * 1.6 * dt)); this.py = Math.max(-1, Math.min(1, this.py + pdy * 1.6 * dt)); }
    if (act.has('PCENTER')) { this.px = 0; this.py = 0; }
    if (act.has('SHAKE')) this.shake = now;
    if (act.has('NSHAKE')) this.nshake = now;
    let wacc = null, nacc = null;
    // phones
    if (DSU.on) {
      for (const s of DSU.live) {
        const S = DSU.slots[s], role = DSU.cfg.roles[s];
        if (role === 'off') continue;
        b |= S.buttons;
        if (S.nshake) this.nshake = now;
        if ((role === 'nunchuk' || role === 'classic') && S.stick && !(sx || sy)) { sx = S.stick[0]; sy = S.stick[1]; }
        if (role === 'wiimote' && S.stick && !(sx || sy)) { sx = S.stick[0]; sy = S.stick[1]; }
        if (S.touch) { this.px = 0; this.py = 0; }
        if (role === 'classic' && S.rstick) { this.px = Math.max(-1, Math.min(1, this.px + S.rstick[0] * 1.8 * dt)); this.py = Math.max(-1, Math.min(1, this.py + S.rstick[1] * 1.8 * dt)); }
        if (role === 'wiimote' && S.gyro && S.fresh !== S.seen) {
          S.seen = S.fresh;
          const [pitch, yaw, , gdt] = S.gyro, k = (2 / 40) * DSU.cfg.sens;     // ~40 degrees = full screen width
          this.px = Math.max(-1.2, Math.min(1.2, this.px - yaw * gdt * k * (DSU.cfg.invX ? -1 : 1)));
          this.py = Math.max(-1.2, Math.min(1.2, this.py + pitch * gdt * k * (DSU.cfg.invY ? -1 : 1)));
        }
        if (S.acc) {
          const a = [-S.acc[0], S.acc[2], S.acc[1]];
          if (role === 'nunchuk') nacc = a; else wacc = a;
        }
      }
    }
    let [ax, ay, az] = wacc || [0, 0, 1];
    if (now - this.shake < 350) [ax, ay, az] = shakeWave(now);
    let [nx, ny, nz] = nacc || [0, 0, 1];
    if (now - this.nshake < 350) [nx, ny, nz] = shakeWave(now, 1.1);
    const len = Math.hypot(sx, sy); if (len > 1) { sx /= len; sy /= len; }
    if (!this.gcAddr && window.__gcAddr) this.gcAddr = window.__gcAddr;
    if (this.gcAddr) {        // GameCube controller (port 1)
      const g = new DataView(this.memory.buffer, this.gcAddr, 32);
      let gb = 0, gx = 0, gy = 0, cx = 0, cy = 0, tl = 0, tr = 0;
      if (gMode === 'gc') {
        for (const [id, bit] of [['GA', GC.A], ['GB', GC.B], ['GX', GC.X], ['GY', GC.Y], ['GZ', GC.Z], ['GL', GC.L], ['GR', GC.R], ['GSTART', GC.START],
                                 ['GUP', GC.UP], ['GDOWN', GC.DOWN], ['GLEFT', GC.LEFT], ['GRIGHT', GC.RIGHT]]) if (act.has(id)) gb |= bit;
        if (this.mouseBtn & 1) gb |= GC.A;
        gx = (act.has('GSRIGHT') ? 1 : 0) - (act.has('GSLEFT') ? 1 : 0); gy = (act.has('GSUP') ? 1 : 0) - (act.has('GSDOWN') ? 1 : 0);
        cx = (act.has('GCRIGHT') ? 1 : 0) - (act.has('GCLEFT') ? 1 : 0); cy = (act.has('GCUP') ? 1 : 0) - (act.has('GCDOWN') ? 1 : 0);
        if (gp) {
          const lx = dz(gp.axes[0] || 0), ly = dz(gp.axes[1] || 0), rx = dz(gp.axes[2] || 0), ry = dz(gp.axes[3] || 0);
          if (lx || ly) { gx = lx; gy = -ly; }
          if (rx || ry) { cx = rx; cy = -ry; }
          tl = gp.buttons[6] ? gp.buttons[6].value || 0 : 0; tr = gp.buttons[7] ? gp.buttons[7].value || 0 : 0;
        }
        const gl = Math.hypot(gx, gy); if (gl > 1) { gx /= gl; gy /= gl; }
        b = 0; sx = 0; sy = 0;        // the Wii Remote stays idle
      }
      g.setUint32(4, gb, true); g.setFloat32(8, gx, true); g.setFloat32(12, gy, true);
      g.setFloat32(16, cx, true); g.setFloat32(20, cy, true); g.setFloat32(24, tl, true); g.setFloat32(28, tr, true);
    }
    const dv = new DataView(this.memory.buffer, this.addr, PAD_BYTES);
    dv.setInt32(16, b, true);
    dv.setFloat32(20, this.px, true); dv.setFloat32(24, this.py, true);
    dv.setFloat32(28, ax, true); dv.setFloat32(32, ay, true); dv.setFloat32(36, az, true);
    dv.setFloat32(40, sx, true); dv.setFloat32(44, sy, true);
    dv.setFloat32(48, nx, true); dv.setFloat32(52, ny, true); dv.setFloat32(56, nz, true);
  }
}

// ---------------------------------------------------------------- settings panel
function buildControlsPanel() {
  const panel = document.getElementById('controls');
  const body = panel.querySelector('tbody');
  const hint = panel.querySelector('.hint');
  const stopCapture = () => { gCapture = null; if (gPadCapture) { clearInterval(gPadCapture.timer); gPadCapture = null; } hint.textContent = ''; };
  const assign = (id, kind, slot, value) => {
    const list = gBinds[id][kind].slice();
    if (value === null) list.splice(slot, 1);
    else {
      for (const other in gBinds) if (modeOf(other) === gMode) gBinds[other][kind] = gBinds[other][kind].filter((k) => k !== value);   // one action per key/button
      const cur = gBinds[id][kind].filter((k) => k !== value); cur[Math.min(slot, cur.length)] = value; list.length = 0; list.push(...cur);
    }
    gBinds[id][kind] = [...new Set(list.filter((v) => v !== undefined && v !== null))].slice(0, 2);
    saveBinds(gBinds); rebuildMap(); render();
  };
  function render() {
    body.textContent = '';
    for (const [id, label, , , mode] of ACTIONS) {
      if (mode !== gMode) continue;
      const tr = document.createElement('tr');
      const th = document.createElement('td'); th.textContent = label; tr.appendChild(th);
      for (const [kind, slot] of [['k', 0], ['k', 1], ['p', 0], ['p', 1]]) {
        const td = document.createElement('td');
        const btn = document.createElement('button');
        btn.className = 'bind' + (kind === 'p' ? ' pad' : '');
        btn.textContent = kind === 'k' ? keyName(gBinds[id].k[slot]) : padName(gBinds[id].p[slot]);
        btn.onclick = () => {
          stopCapture(); render();
          const b2 = body.querySelectorAll('tr')[ACTIONS.filter((a) => a[4] === gMode).findIndex((a) => a[0] === id)].querySelectorAll('button')[(kind === 'k' ? 0 : 2) + slot];
          b2.textContent = kind === 'k' ? 'press a key…' : 'press a controller button…'; b2.classList.add('wait');
          if (kind === 'k') {
            hint.textContent = 'Press the new key (Backspace = clear, Esc = cancel).';
            gCapture = (code) => { stopCapture(); if (code === 'Escape') { render(); return; } assign(id, 'k', slot, code === 'Backspace' || code === 'Delete' ? null : code); };
          } else {
            const gp = firstGamepad();
            hint.textContent = gp ? 'Press the new button on the controller (Backspace = clear, Esc = cancel).' : 'No controller found: connect it and press any button so the browser detects it.';
            const base = new Set(); if (gp) gp.buttons.forEach((bt, i) => { if (bt.pressed) base.add(i); });
            gCapture = (code) => { if (code === 'Escape') { stopCapture(); render(); } else if (code === 'Backspace' || code === 'Delete') { stopCapture(); assign(id, 'p', slot, null); } };
            gPadCapture = { timer: setInterval(() => {
              const g = firstGamepad(); if (!g) return;
              g.buttons.forEach((bt, i) => { if (!bt.pressed) base.delete(i); });
              const i = g.buttons.findIndex((bt, k) => bt.pressed && !base.has(k));
              if (i >= 0) { stopCapture(); assign(id, 'p', slot, i); }
            }, 30) };
          }
        };
        td.appendChild(btn); tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  }
  addEventListener('keydown', (e) => { if (gCapture) { e.preventDefault(); e.stopImmediatePropagation(); gCapture(e.code); } }, true);
  const modeSel = document.getElementById('ctl-mode');
  if (modeSel) {
    modeSel.value = gMode;
    modeSel.onchange = () => { stopCapture(); gMode = modeSel.value === 'gc' ? 'gc' : 'wii'; try { localStorage.setItem(MODE_KEY, gMode); } catch (e) { /* ignore */ } rebuildMap(); render(); };
  }
  panel.querySelector('#ctl-reset').onclick = () => { stopCapture(); gBinds = defaultBinds(); saveBinds(gBinds); rebuildMap(); render(); };
  panel.querySelector('#ctl-close').onclick = () => { stopCapture(); panel.hidden = true; };
  window.openControls = () => { stopCapture(); panel.hidden = false; render(); };
  const sb = document.getElementById('settings'); if (sb) sb.onclick = () => { stopCapture(); panel.hidden = !panel.hidden; if (!panel.hidden) render(); };
  // gamepad status line
  const gpst = document.getElementById('gp-status');
  setInterval(() => { const g = firstGamepad(); if (gpst) gpst.textContent = g ? `Controller detected: ${g.id}${g.mapping === 'standard' ? '' : ' (no standard mapping: check the buttons)'}` : 'No controller detected (connect it and press a button).'; }, 500);
  // on-screen A+B button (press and hold)
  const ab = document.getElementById('btn-ab');
  if (ab) {
    const set = (on) => (e) => { e.preventDefault(); if (window.__input) window.__input.hold(BTN.A | BTN.B, on); };
    ab.addEventListener('pointerdown', set(true)); ab.addEventListener('pointerup', set(false)); ab.addEventListener('pointerleave', set(false));
  }
  // DSU section
  const $ = (id) => document.getElementById(id);
  const st = $('dsu-status');
  $('dsu-host').value = DSU.cfg.host; $('dsu-port').value = DSU.cfg.port; $('dsu-sens').value = DSU.cfg.sens;
  $('dsu-invx').checked = DSU.cfg.invX; $('dsu-invy').checked = DSU.cfg.invY;
  for (let s = 0; s < 2; s++) {
    const sel = $(`dsu-role${s}`);
    for (const [v, t] of Object.entries(ROLES)) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); }
    sel.value = DSU.cfg.roles[s];
  }
  const readCfg = () => {
    DSU.cfg.host = $('dsu-host').value.trim(); DSU.cfg.port = Number($('dsu-port').value) || 26760;
    DSU.cfg.sens = Number($('dsu-sens').value) || 1; DSU.cfg.invX = $('dsu-invx').checked; DSU.cfg.invY = $('dsu-invy').checked;
    DSU.cfg.roles[0] = $('dsu-role0').value; DSU.cfg.roles[1] = $('dsu-role1').value; DSU.save();
  };
  for (const id of ['dsu-sens', 'dsu-invx', 'dsu-invy', 'dsu-role0', 'dsu-role1']) $(id).onchange = readCfg;
  $('dsu-connect').onclick = async () => {
    readCfg();
    if (DSU.on) { await DSU.disconnect(); DSU.cfg.auto = false; }
    else { DSU.cfg.auto = await DSU.connect(); }
    DSU.save();
  };
  setInterval(() => { st.textContent = DSU.status; $('dsu-connect').textContent = DSU.on ? 'Disconnect' : 'Connect'; }, 300);
  if (DSU.cfg.auto && DSU.cfg.host) DSU.connect();
  render();
}
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', buildControlsPanel); else buildControlsPanel();
self.PadInput = PadInput;
self.__binds = () => gBinds;
self.__ctlMode = () => gMode;
self.__dsu = DSU;
