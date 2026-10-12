// gx-renderer.js - draws the GX command stream produced by the recompiled game (runtime/gxrender.c)
// with WebGL2: GX transform/lighting/texgen in the vertex shader, the TEV combiner stages, alpha
// test, blending, depth and EFB copies (to the screen or to textures) - generated per GX state.
'use strict';

const RC = { BP: 1, XF: 2, DRAW: 3, TEX: 4, TEXUP: 5, TEXFREE: 6, COPY: 7, FRAME: 8, CP: 9, READBACK: 10 };
const EFB_W = 640, EFB_H = 528;

class GXRenderer {
  constructor(canvas, memory, ringAddr, opts = {}) {
    this.canvas = canvas; this.memory = memory; this.ring = ringAddr;
    this.scale = opts.scale || 2;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 no disponible');
    this.gl = gl;
    this.bp = new Uint32Array(256);
    this.xfRaw = new Uint32Array(0x1100);
    this.xfF = new Float32Array(this.xfRaw.buffer);
    this.cp30 = 0; this.cp40 = 0;
    this.xfDirty = true; this.xfLo = 0; this.xfHi = 0x680;
    this.textures = new Map();
    this.boundTex = new Array(8).fill(0);
    this.programs = new Map();
    this.stats = { draws: 0, frames: 0, tris: 0, progs: 0, texUploads: 0 };
    this.upLo = 0; this.upHi = 0; this.lastOff = 0; this.vaos = new Map(); this.curVao = null;
    this.ver = 1; this.texVer = 0; this.drawVer = 0; this.lastMask = -1; this.lastProg = null; this.attrOn = 0;
    this.initGL();
    if (memory) this.attach(memory, ringAddr);
  }
  // become the consumer of the game's command ring (the renderer can be created earlier, to compile the
  // shaders on the loading screen before the game starts)
  attach(memory, ringAddr) {
    this.memory = memory; this.ring = ringAddr;
    const h = new Int32Array(memory.buffer, ringAddr, 8);
    Atomics.store(h, 2, 1);
  }

  initGL() {
    const gl = this.gl, S = this.scale;
    this.efbColor = this.makeTex(EFB_W * S, EFB_H * S);
    // depth is a texture (not a renderbuffer) so that EFB copies in Z24 mode can read it (depth copies)
    this.efbDepth = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.efbDepth);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, EFB_W * S, EFB_H * S);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.efbFB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.efbFB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.efbColor, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.efbDepth, 0);
    gl.clearColor(0, 0, 0, 1); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.xfb = { tex: this.makeTex(EFB_W * S, 480 * S), fb: gl.createFramebuffer(), w: 640, h: 480 };
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.xfb.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.xfb.tex, 0);
    this.copyFB = gl.createFramebuffer();
    this.vbo = gl.createBuffer(); this.ibo = gl.createBuffer();
    this.vao = gl.createVertexArray();
    this.ubo = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferData(gl.UNIFORM_BUFFER, 416 * 16, gl.DYNAMIC_DRAW);
    this.whiteTex = this.makeTex(1, 1, new Uint8Array([255, 255, 255, 255]));
    // EFB copy -> texture format conversion (channel selection like the console's copy formats)
    this.copyProg = this.link(`#version 300 es
      out vec2 uv; void main(){ vec2 p = vec2((gl_VertexID & 1) * 2, (gl_VertexID >> 1) * 2); uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0, 1); }`,
      `#version 300 es
      precision highp float; in vec2 uv; uniform sampler2D t; uniform int mode; uniform int noA; uniform int yuv; out vec4 o;
      void main(){ vec4 c = texture(t, uv); if (noA != 0) c.a = 1.0;
        if (yuv != 0) { float y = clamp(dot(c.rgb, vec3(0.257, 0.504, 0.098)) + 16.0 / 255.0, 0.0, 1.0); c.rgb = vec3(y); }   // intensity copies
        if (mode == 0 || mode == 1 || mode == 8) o = c.rrrr; else if (mode == 2 || mode == 3) o = c.rrra;
        else if (mode == 4) o = vec4(c.rgb, 1.0); else if (mode == 7) o = c.aaaa; else if (mode == 9) o = c.gggg;
        else if (mode == 10) o = c.bbbb; else if (mode == 11) o = c.rrrg; else if (mode == 12) o = c.gggb; else o = c; }`);
    this.copyFB2 = gl.createFramebuffer(); this.scratch = null;
    // EFB copy in Z24 mode: the 24-bit depth goes into the texture as bytes (high / mid / low) by copy format
    this.zcopyProg = this.link(`#version 300 es
      uniform vec4 r; out vec2 uv; void main(){ vec2 p = vec2((gl_VertexID & 1) * 2, (gl_VertexID >> 1) * 2);
        uv = vec2(r.x + p.x * r.z, r.y - p.y * r.w); gl_Position = vec4(p * 2.0 - 1.0, 0, 1); }`,
      `#version 300 es
      precision highp float; in vec2 uv; uniform highp sampler2D d; uniform int mode; out vec4 o;
      void main(){ uint z = min(uint(round(clamp(texture(d, uv).r, 0.0, 1.0) * 16777215.0)), 16777215u);   // (+0.5 overflows to 2^24 in float)
        float h = float((z >> 16) & 255u) / 255.0, m = float((z >> 8) & 255u) / 255.0, l = float(z & 255u) / 255.0;
        if (mode == 0 || mode == 1 || mode == 8) o = vec4(h); else if (mode == 9) o = vec4(m); else if (mode == 10) o = vec4(l);
        else if (mode == 3) o = vec4(h, h, h, m); else if (mode == 12) o = vec4(m, m, m, l); else o = vec4(h, m, l, 1.0); }`);
    this.checkLink(this.zcopyProg);
    // present program
    this.presentProg = this.link(`#version 300 es
      out vec2 uv; void main(){ vec2 p = vec2((gl_VertexID & 1) * 2, (gl_VertexID >> 1) * 2); uv = vec2(p.x, p.y); gl_Position = vec4(p * 2.0 - 1.0, 0, 1); }`,
      `#version 300 es
      precision highp float; in vec2 uv; uniform sampler2D t; uniform vec2 sc; out vec4 o;
      void main(){ o = vec4(texture(t, vec2(uv.x * sc.x, 1.0 - (1.0 - uv.y) * sc.y)).rgb, 1.0); }`);
    this.checkLink(this.presentProg); this.checkLink(this.copyProg);
    this.parallel = gl.getExtension('KHR_parallel_shader_compile');
    // quad index buffer (GX quads -> 2 triangles)
    const q = new Uint32Array(65536 / 4 * 6 + 6);
    for (let i = 0, v = 0; i + 6 <= q.length; i += 6, v += 4) { q[i] = v; q[i + 1] = v + 1; q[i + 2] = v + 2; q[i + 3] = v; q[i + 4] = v + 2; q[i + 5] = v + 3; }
    this.quadIdx = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, q, gl.STATIC_DRAW);
    this.quadCap = 16384;
    this.dynIdx = gl.createBuffer();
    // matrix-index attributes are unsigned integers: their default value must be too (when no array is bound)
    gl.vertexAttribI4ui(14, 0, 0, 0, 0); gl.vertexAttribI4ui(15, 0, 0, 0, 0);
  }

  makeTex(w, h, data = null) {
    const gl = this.gl, t = gl.createTexture();
    this.glBound = null;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  link(vs, fs) {
    // compile without asking for the result: with KHR_parallel_shader_compile the driver builds it in the
    // background and finishProgram() collects it later (no frame hitch); errors are reported there
    const gl = this.gl;
    const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    // many programs share the same vertex shader: compile each distinct one only once
    if (!this.vsCache) this.vsCache = new Map();
    let v = this.vsCache.get(vs);
    if (!v) { v = mk(gl.VERTEX_SHADER, vs); this.vsCache.set(vs, v); }
    const p = gl.createProgram(), f = mk(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, v); gl.attachShader(p, f);
    const names = ['aPos', 'aNrm', 'aBin', 'aTan', 'aCol0', 'aCol1', 'aTex0', 'aTex1', 'aTex2', 'aTex3', 'aTex4', 'aTex5', 'aTex6', 'aTex7', 'aIdx0', 'aIdx1'];
    names.forEach((n, i) => gl.bindAttribLocation(p, i, n));
    gl.linkProgram(p);
    p._sh = [v, f, vs, fs];
    return p;
  }
  checkLink(p) {
    const gl = this.gl;
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const [v, f, vs, fs] = p._sh;
      const log = gl.getShaderInfoLog(v) || gl.getShaderInfoLog(f) || gl.getProgramInfoLog(p);
      throw new Error(log + '\n' + (gl.getShaderInfoLog(v) ? vs : fs));
    }
    p._sh = null;
  }

  // ------------------------------------------------------------------ command stream
  pump(budgetMs = 12) {
    const buf = this.memory.buffer;
    const h = new Int32Array(buf, this.ring, 8);
    const size = h[3] >>> 0;
    const data = this.ring + 32;
    const u32 = new Uint32Array(buf), f32 = new Float32Array(buf);
    const t0 = performance.now();
    let presented = false;
    const ri = this.ringInfo || (this.ringInfo = {});
    ri.dataAbs = data; ri.size = size;
    // the read position is published (and the writer woken) every 64 records and at the end, not after each
    // record: a race frame has tens of thousands of records and the atomics were a good part of the time
    let r = Atomics.load(h, 1) >>> 0, w = Atomics.load(h, 0) >>> 0, n = 0, stop = false;
    const publish = () => { Atomics.store(h, 1, r | 0); Atomics.notify(h, 1); };
    while (!stop) {
      if (r === w) { publish(); w = Atomics.load(h, 0) >>> 0; if (r === w) break; }
      ri.wAbs = data + (w % size);
      const off = r % size;
      if (off < this.lastOff) this.upHi = 0;      // the ring wrapped: data at old offsets will be replaced
      this.lastOff = off;
      const base = (data + off) >> 2;
      const hdr = u32[base], type = hdr >>> 24, len = hdr & 0xFFFFFF;
      if (len === 0) {   // broken record (should never happen): skip everything written so far instead of looping forever
        if (!this.badRec) { this.badRec = 1; this.onError && this.onError(new Error(`empty record in the ring (type ${type}); dropping what is pending`)); }
        r = w; publish(); break;
      }
      if (type === 0) { r = (r + len * 4) >>> 0; continue; }
      // when the game is more than a few frames ahead, skip drawing (state still applies) to catch up,
      // so a slow GPU lowers the frame rate instead of slowing the game (and its audio) down
      // (decided per whole frame, so a frame is either drawn completely or not at all)
      if (this.skipFrame && (type === 3 || type === 7)) { r = (r + len * 4) >>> 0; continue; }
      let wasSkipped = false;
      if (type === 8) {
        const behind = ((Atomics.load(h, 4) >>> 0) - this.stats.frames - 1) | 0;
        wasSkipped = !!this.skipFrame;
        if (wasSkipped) this.stats.skipped = (this.stats.skipped || 0) + 1;
        this.skipFrame = behind > 2 && !this.skipFrame && !this.frameCopiesToTexture(u32, data, size, r + len * 4, w);   // never skip two frames in a row
      }
      if (type !== 3 && this.batch) this.flush();          // any other record may change state: draw what is pending
      try {
        if (this.exec(type, base, len, u32, f32, buf)) {
          // a skipped frame was not drawn: keep showing the last picture (presenting it would show an older
          // frame buffer for a moment, so models seemed to vanish and come back)
          if (wasSkipped) this.framePending = false; else presented = true;
        }
      }
      catch (e) { if ((this.errCount = (this.errCount | 0) + 1) <= 30) { console.error(e); this.onError && this.onError(e); } }
      r = (r + len * 4) >>> 0;
      if (type === 10 || type === 8 || (++n & 63) === 0) { publish(); if (performance.now() - t0 > budgetMs) stop = true; }
    }
    publish();
    this.flush();
    if (this.framePending) { this.framePending = false; this.present(); }
    return presented;
  }

  // does the next frame (records from pos up to its end) copy the picture into a texture? Such copies often
  // happen once (the customized Rabbid's skin, menus, ...): skipping that frame would leave the texture black
  frameCopiesToTexture(u32, data, size, pos, w) {
    for (let n = 0; n < 200000 && pos !== w; n++) {
      const b = (data + (pos % size)) >> 2, hdr = u32[b], t = hdr >>> 24, len = hdr & 0xFFFFFF;
      if (!len) return true;
      if (t === 8) return false;
      if (t === 7 && u32[b + 1] !== 0) return true;
      pos = (pos + len * 4) >>> 0;
    }
    return true;
  }

  exec(type, b, len, u32, f32, buf) {
    switch (type) {
      case RC.BP: { const r = u32[b + 1] & 255; if (this.bp[r] !== u32[b + 2]) { this.bp[r] = u32[b + 2]; this.ver++; } this.onBP(r, u32[b + 2]); return false; }
      case RC.CP: if (u32[b + 1] === 0x30) this.cp30 = u32[b + 2]; else this.cp40 = u32[b + 2]; this.ver++; return false;
      case RC.XF: { const a = u32[b + 1], n = u32[b + 2]; for (let i = 0; i < n; i++) if (a + i < 0x1100) this.xfRaw[a + i] = u32[b + 3 + i];
        if (a < 0x680) { this.xfDirty = true; if (a < this.xfLo) this.xfLo = a; if (Math.min(a + n, 0x680) > this.xfHi) this.xfHi = Math.min(a + n, 0x680); }
        if (a + n > 0x1000) this.ver++; return false; }
      case RC.DRAW: { const sp = u32[b + 4], pad = sp >>> 16; this.draw(u32[b + 1], u32[b + 2], u32[b + 3], sp & 0xFFFF, (b + 5 + pad) * 4, buf, (len - 5 - pad) * 4); return false; }
      case RC.TEX: if (this.boundTex[u32[b + 1] & 7] !== u32[b + 2]) { this.boundTex[u32[b + 1] & 7] = u32[b + 2]; this.texVer = (this.texVer + 1) & 4095; } return false;
      case RC.TEXUP: this.upload(u32[b + 1], u32[b + 2], u32[b + 3], u32[b + 4], (b + 5) * 4, buf); return false;
      case RC.TEXFREE: { const t = this.textures.get(u32[b + 1]); if (t) { this.gl.deleteTexture(t.tex); this.textures.delete(u32[b + 1]); } return false; }
      case RC.COPY: this.efbCopy(u32[b + 1], u32[b + 2], u32[b + 3], u32[b + 4], u32[b + 5], u32[b + 6], u32[b + 7], u32[b + 8], u32[b + 9], len > 10 ? u32[b + 10] : 0); return false;
      case RC.READBACK: {
        try { this.readback(u32[b + 1], u32[b + 2], u32[b + 3], u32[b + 4], u32[b + 5]); }
        finally { const f = new Int32Array(buf, u32[b + 6] & ~3, 1); Atomics.store(f, 0, 1); Atomics.notify(f, 0); }
        return false; }
      case RC.FRAME: this.stats.frames++; this.framePending = true; this.newThisFrame = 0; if (this.lastProg === GXRenderer.PENDING) this.drawVer = -1; this.scanAddr = u32[b + 2] & 0x1FFFFFFF;
        if (this.scanAddr) { if (!this.scanBases) this.scanBases = new Set(); if (this.scanBases.size > 8) this.scanBases.clear(); this.scanBases.add(this.scanAddr); }
        return true;
    }
    return false;
  }
  onBP(reg, val) { this.onBPWrite(reg, val); }

  // an EFB copy written back into the game's memory (in the GX texture format of the copy) because the game is
  // going to read it with the CPU (runtime/gxrender.c writeback)
  readback(id, ptr, w, h, fmt) {
    const t = this.textures.get(id); if (!t || !w || !h) return;
    const gl = this.gl, S = this.scale;
    this.invalidate();
    if (!this.rbFB) { this.rbFB = gl.createFramebuffer(); this.rbSrcFB = gl.createFramebuffer(); }
    if (!this.rbTex || this.rbTex.w !== w || this.rbTex.h !== h) { if (this.rbTex) gl.deleteTexture(this.rbTex.tex); this.rbTex = { tex: this.makeTex(w, h), w, h }; }
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.rbSrcFB);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.rbFB);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.rbTex.tex, 0);
    gl.blitFramebuffer(0, 0, w * S, h * S, 0, 0, w, h, gl.COLOR_BUFFER_BIT, S > 1 ? gl.LINEAR : gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.rbFB);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);      // row 0 = top of the copy (see efbCopy)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.efbFB); this.fbBound = false;
    GXRenderer.encodeCopy(new Uint8Array(this.memory.buffer), ptr, px, w, h, fmt);
    this.stats.readbacks = (this.stats.readbacks || 0) + 1;
  }
  // GX texture layouts (tiles of 4x4 / 8x4 / 8x8 texels, big-endian) for the EFB copy formats
  static encodeCopy(mem, p, px, w, h, fmt) {
    const at = (x, y, c) => (x < w && y < h ? px[(y * w + x) * 4 + c] : 0);
    if (fmt === 6) {                      // RGBA8: per 4x4 tile 32 bytes AR, then 32 bytes GB
      for (let ty = 0; ty < h; ty += 4) for (let tx = 0; tx < w; tx += 4) {
        for (let i = 0; i < 16; i++) { const x = tx + (i & 3), y = ty + (i >> 2);
          mem[p + i * 2] = at(x, y, 3); mem[p + i * 2 + 1] = at(x, y, 0); mem[p + 32 + i * 2] = at(x, y, 1); mem[p + 33 + i * 2] = at(x, y, 2); }
        p += 64; }
    } else if (fmt === 4 || fmt === 5) {  // RGB565 / RGB5A3: 4x4 tiles of 16-bit texels
      for (let ty = 0; ty < h; ty += 4) for (let tx = 0; tx < w; tx += 4) for (let i = 0; i < 16; i++) {
        const x = tx + (i & 3), y = ty + (i >> 2), r = at(x, y, 0), g = at(x, y, 1), b = at(x, y, 2), a = at(x, y, 3);
        let v;
        if (fmt === 4) v = (r >> 3) << 11 | (g >> 2) << 5 | b >> 3;
        else if (a >= 0xE0) v = 0x8000 | (r >> 3) << 10 | (g >> 3) << 5 | b >> 3;
        else v = (a >> 5) << 12 | (r >> 4) << 8 | (g >> 4) << 4 | b >> 4;
        mem[p++] = v >> 8; mem[p++] = v & 255; }
    } else if (fmt === 3 || fmt === 11 || fmt === 12) {   // two 8-bit channels: 4x4 tiles of (first, second)
      for (let ty = 0; ty < h; ty += 4) for (let tx = 0; tx < w; tx += 4) for (let i = 0; i < 16; i++) {
        const x = tx + (i & 3), y = ty + (i >> 2); mem[p++] = at(x, y, 3); mem[p++] = at(x, y, 0); }
    } else if (fmt === 1 || (fmt >= 7 && fmt <= 10)) {   // one 8-bit channel: 8x4 tiles
      for (let ty = 0; ty < h; ty += 4) for (let tx = 0; tx < w; tx += 8) for (let i = 0; i < 32; i++) mem[p++] = at(tx + (i & 7), ty + (i >> 3), 0);
    } else if (fmt === 2) {               // IA4 / RA4: 8x4 tiles, alpha in the high nibble
      for (let ty = 0; ty < h; ty += 4) for (let tx = 0; tx < w; tx += 8) for (let i = 0; i < 32; i++) { const x = tx + (i & 7), y = ty + (i >> 3); mem[p++] = (at(x, y, 3) & 0xF0) | at(x, y, 0) >> 4; }
    } else if (fmt === 0) {               // I4 / R4: 8x8 tiles of 4-bit texels
      for (let ty = 0; ty < h; ty += 8) for (let tx = 0; tx < w; tx += 8) for (let i = 0; i < 64; i += 2) { const x = tx + (i & 7), y = ty + (i >> 3); mem[p++] = (at(x, y, 0) & 0xF0) | at(x + 1, y, 0) >> 4; }
    }
  }

  upload(id, w, h, levels, off, buf) {
    const gl = this.gl;
    this.glBound = null;
    let t = this.textures.get(id);
    if (t) gl.deleteTexture(t.tex);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    let o = off, ww = w, hh = h;
    for (let l = 0; l < levels; l++) {
      const n = ww * hh * 4;
      gl.texImage2D(gl.TEXTURE_2D, l, gl.RGBA8, ww, hh, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(buf, o, n).slice());
      o += n; ww = Math.max(1, ww >> 1); hh = Math.max(1, hh >> 1);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levels - 1);
    this.textures.set(id, { tex, w, h, levels });
    this.stats.texUploads++;
  }

  // ------------------------------------------------------------------ EFB copies / present
  // debug: show the current EFB on the canvas
  showEFB() {
    const gl = this.gl, S = this.scale;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.efbFB); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.blitFramebuffer(0, 0, EFB_W * S, EFB_H * S, 0, this.canvas.height - EFB_H * S, EFB_W * S, this.canvas.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    this.invalidate();
  }
  showTex(id) {
    const gl = this.gl, t = this.textures.get(id); if (!t) return false;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.copyFB2);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null); gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0.2, 0, 0.2, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const W = t.efb ? t.w * this.scale : t.w, H = t.efb ? t.h * this.scale : t.h;
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    this.invalidate(); return true;
  }
  invalidate() { this.stateDirty = true; this.curProg = null; this.fbBound = false; this.glBound = null; this.curVao = null; }
  // the console keeps several framebuffers (XFBs) in memory and shows the one the video interface points
  // at; intermediate copies to other XFB addresses must not be shown
  xfbFor(addr, h = 0) {
    // a copy may land inside a framebuffer (e.g. 16:9 letterbox: 60 lines down); find the framebuffer whose
    // start the video interface has shown, and the line the copy starts at
    const gl = this.gl, S = this.scale;
    if (!this.xfbs) this.xfbs = new Map();
    if (!this.scanBases) this.scanBases = new Set();
    const lineBytes = ((this.bp[0x4D] & 0x3FF) * 32) || 1280;
    // nearest scanned buffer at or below the copy (double buffers can sit closer than 576 lines: MKW's are 456 apart)
    let base = -1;
    for (const b of this.scanBases) if (addr >= b && addr - b + h * lineBytes <= lineBytes * 576 && b > base) base = b;   // the whole copy must fit
    if (base < 0) base = addr;
    let x = this.xfbs.get(base);
    if (!x) {
      if (this.xfbs.size >= 6) { const [k, old] = this.xfbs.entries().next().value; gl.deleteTexture(old.tex); gl.deleteFramebuffer(old.fb); this.xfbs.delete(k); }
      x = { tex: this.makeTex(EFB_W * S, 576 * S), fb: gl.createFramebuffer(), w: 640, h: 480 };
      gl.bindFramebuffer(gl.FRAMEBUFFER, x.fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, x.tex, 0);
      gl.disable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      this.xfbs.set(base, x);
    }
    return { xb: x, line: Math.floor((addr - base) / lineBytes) };
  }
  efbCopy(id, x, y, w, h, dw, dh, fmt, val, addr = 0) {
    const gl = this.gl, S = this.scale;
    this.invalidate();
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.efbFB);
    if (id === 0) {
      // to an external frame buffer: keep it for scan-out
      const { xb, line } = this.xfbFor(addr & 0x1FFFFFFF, h); this.lastXfb = xb; this.stats.xfbCopies = (this.stats.xfbCopies || 0) + 1;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.efbFB);   // xfbFor may have bound a new framebuffer
      xb.h = Math.max(400, Math.min(576, line + h)); xb.w = Math.max(320, Math.min(640, x + w));   // e.g. 608 wide: the VI scales it to the screen width
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, xb.fb);
      // EFB rows are stored top row last (GL y up); keep that orientation in the XFB texture (576 rows tall)
      gl.blitFramebuffer(x * S, (EFB_H - y - h) * S, (x + w) * S, (EFB_H - y) * S, 0, (576 - line - h) * S, w * S, (576 - line) * S, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      this.xfbValid = true;
    } else {
      let t = this.textures.get(id);
      if (!t || t.w !== dw || t.h !== dh) {
        if (t) gl.deleteTexture(t.tex);
        t = { tex: this.makeTex(dw * S, dh * S), w: dw, h: dh, levels: 1, efb: true };
        this.textures.set(id, t);
      }
      if ((this.bp[0x43] & 7) === 3) {                    // Z24 pixel format: this copy reads the depth buffer
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.copyFB2);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
        gl.viewport(0, 0, dw * S, dh * S);
        gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.colorMask(true, true, true, true);
        gl.useProgram(this.zcopyProg);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.efbDepth);
        gl.uniform1i(gl.getUniformLocation(this.zcopyProg, 'd'), 0);
        gl.uniform1i(gl.getUniformLocation(this.zcopyProg, 'mode'), fmt);
        // texture row 0 = top of the copied rectangle; GL rows count from the bottom of the EFB
        gl.uniform4f(gl.getUniformLocation(this.zcopyProg, 'r'), x / EFB_W, (EFB_H - y) / EFB_H, w / EFB_W, h / EFB_H);
        gl.bindVertexArray(null);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.viewport(0, 0, EFB_W * S, EFB_H * S);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.efbFB);
      } else {
      const noA = (this.bp[0x43] & 7) !== 1;              // EFB without alpha (RGB8 / RGB565): alpha reads as 1
      const yuv = (val & 0x8000) && fmt <= 3 ? 1 : 0;      // I4 / I8 / IA4 / IA8 with the intensity bit: RGB -> Y
      const conv = !this.debugNoConv && (noA || yuv || (fmt !== 6 && fmt !== 5));
      let dst = t.tex;
      if (conv) {
        if (!this.scratch || this.scratch.w !== dw * S || this.scratch.h !== dh * S) {
          if (this.scratch) gl.deleteTexture(this.scratch.tex);
          this.scratch = { tex: this.makeTex(dw * S, dh * S), w: dw * S, h: dh * S };
        }
        dst = this.scratch.tex;
      }
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.copyFB);
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
      // flip so that row 0 of the texture is the top of the copied rectangle (like GX textures)
      gl.blitFramebuffer(x * S, (EFB_H - y - h) * S, (x + w) * S, (EFB_H - y) * S, 0, dh * S, dw * S, 0, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      if (conv) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.copyFB2);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
        gl.viewport(0, 0, dw * S, dh * S);
        gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.colorMask(true, true, true, true);
        gl.useProgram(this.copyProg);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dst);
        gl.uniform1i(gl.getUniformLocation(this.copyProg, 't'), 0);
        gl.uniform1i(gl.getUniformLocation(this.copyProg, 'mode'), fmt);
        gl.uniform1i(gl.getUniformLocation(this.copyProg, 'noA'), noA ? 1 : 0);
        gl.uniform1i(gl.getUniformLocation(this.copyProg, 'yuv'), yuv);
        gl.bindVertexArray(null);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.viewport(0, 0, EFB_W * S, EFB_H * S);
      }
      }
    }
    if (val & (1 << 11)) {   // clear the copied rectangle
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.efbFB);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(x * S, (EFB_H - y - h) * S, w * S, h * S);
      const ar = this.bp[0x4F], gb = this.bp[0x50];
      gl.clearColor((ar & 255) / 255, ((gb >> 8) & 255) / 255, (gb & 255) / 255, (this.bp[0x43] & 7) === 1 ? ((ar >> 8) & 255) / 255 : 1);
      gl.clearDepth((this.bp[0x51] & 0xFFFFFF) / 16777215);
      // like the hardware, the clear only touches what the PE may update: color / alpha update enables of the
      // blend mode and the z update enable (MKW clears only alpha after copying its scene for the bloom chain)
      const bm = this.bp[0x41], fmt = this.bp[0x43] & 7, cu = !!(bm & 8), au = !!(bm & 16) && fmt === 1, zu = !!(this.bp[0x40] & 16);
      if (cu || au || zu) {
        gl.colorMask(cu, cu, cu, au || (cu && fmt !== 1)); gl.depthMask(zu);
        gl.clear((cu || au ? gl.COLOR_BUFFER_BIT : 0) | (zu ? gl.DEPTH_BUFFER_BIT : 0));
      }
      gl.disable(gl.SCISSOR_TEST); this.stateDirty = true;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.efbFB);
  }

  present() {
    const gl = this.gl;
    this.invalidate();
    if (!this.xfbValid) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.SCISSOR_TEST); gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    gl.useProgram(this.presentProg);
    const xb = (this.xfbs && this.xfbs.get(this.scanAddr)) || this.lastXfb || this.xfb;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, xb.tex);
    gl.uniform1i(gl.getUniformLocation(this.presentProg, 't'), 0);
    // the XFB texture holds rows bottom-up; show the w x h image at the top-left
    gl.uniform2f(gl.getUniformLocation(this.presentProg, 'sc'), (xb.w || 640) / 640, xb.h / 576);
    gl.bindVertexArray(null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.efbFB);
  }

  // ------------------------------------------------------------------ drawing
  draw(prim, count, mask, stride, off, buf, bytes) {
    const gl = this.gl, S = this.scale, bp = this.bp;
    this.stats.draws++;
    // batching: consecutive draws with nothing in between (same registers, textures, matrices) and the same
    // vertex layout become one indexed draw call. This game issues thousands of small draws per frame.
    const B = this.batch;
    if (B && prim <= 4 && B.mask === mask && B.stride === stride && off >= this.upLo && off + count * stride <= this.upHi && (off - this.upLo) % stride === B.phase) {
      this.addIndices(prim, (off - this.upLo - B.phase) / stride, count); return;
    }
    if (B) this.flush();
    // register state only changes between some draws: rebuild program / uniforms / GL state only then
    let prog = this.lastProg;
    const changed = this.ver !== this.drawVer || mask !== this.lastMask;
    if (changed) { prog = this.program(mask); this.lastMask = mask; }
    this.drawVer = this.ver; this.lastProg = prog;
    if (this.debugUber || (!prog.ready && !this.finishProgram(prog))) {
      // specialized shader still compiling in the background: draw with the ubershader meanwhile
      // (except Z-texture draws: the ubershader has no Z textures, and MKW's full-screen frame-blend quad drawn
      // without one darkens the whole picture for a frame: a flash. Leaving it out for a frame is invisible.)
      if (((bp[0xF5] >> 2) & 3) && !this.debugUber) { this.stats.pending = (this.stats.pending || 0) + 1; return; }
      if (!this.uber) this.uber = this.buildUber();
      prog = this.uber; this.stats.pending = (this.stats.pending || 0) + 1;
    }
    if (prog !== this.curProg) { gl.useProgram(prog.p); this.curProg = prog; }
    if (!this.fbBound) { gl.bindFramebuffer(gl.FRAMEBUFFER, this.efbFB); gl.viewport(0, 0, EFB_W * S, EFB_H * S); this.fbBound = true; }
    if (this.xfDirty) {
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
      // only the changed part of XF memory (usually one 48-byte matrix) instead of all 6.6 KB
      const lo = this.xfLo & ~3, hi = Math.min(0x680, (this.xfHi + 3) & ~3);
      if (hi > lo) gl.bufferSubData(gl.UNIFORM_BUFFER, lo * 4, this.xfF, lo, hi - lo);
      this.xfDirty = false; this.xfLo = 0x680; this.xfHi = 0;
    }
    if (!this.uboBound) { gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.ubo); this.uboBound = true; }
    if (prog.uver !== this.ver) { this.setUniforms(prog); prog.uver = this.ver; }
    if (prog.uber) this.setUberUniforms(prog, mask);
    if (changed || this.stateDirty) { this.setState(); this.stateDirty = false; }
    // textures (EFB copies are stored at the render scale: texelFetch must scale its coordinates)
    const tv = this.ver * 4096 + this.texVer;
    if (prog.u.uTexScl && prog.tver !== tv) {
      const sc = this._scl || (this._scl = new Int32Array(8));
      for (let i = 0; i < 8; i++) { const t = this.textures.get(this.boundTex[i]); sc[i] = t && t.efb ? S : 1; }
      gl.uniform1iv(prog.u.uTexScl, sc);
    }
    if (prog.u.uTexNear && prog.tver !== tv) {
      const nr = this._near || (this._near = new Int32Array(8));
      for (let i = 0; i < 8; i++) nr[i] = (this.bp[i < 4 ? 0x80 + i : 0xA0 + i - 4] >> 4) & 1 ? 0 : 1;   // mag filter nearest
      gl.uniform1iv(prog.u.uTexNear, nr);
    }
    prog.tver = tv;
    const glb = this.glBound || (this.glBound = new Array(8).fill(null));
    for (let i = 0; i < 8; i++) {
      if (!(prog.texUsed & (1 << i))) continue;
      const t = this.textures.get(this.boundTex[i]);
      const gt = t ? t.tex : this.whiteTex;
      if (glb[i] !== gt) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, gt); glb[i] = gt; }
      else if (t) { const m = this.bp[i < 4 ? 0x80 + i : 0xA0 + i - 4]; if (t.mode === m) continue; gl.activeTexture(gl.TEXTURE0 + i); }
      if (t) { const m = this.bp[i < 4 ? 0x80 + i : 0xA0 + i - 4]; if (t.mode !== m) { this.samplerState(i, t); t.mode = m; } }
    }
    // vertices: the data stays where it is in the ring. A whole stretch of the ring is uploaded at once, and
    // one vertex array object per (layout, alignment) points into it; each draw then only picks its first vertex.
    // (about 2 GL calls per draw instead of ~10)
    const bytesV = count * stride;
    if (!(off >= this.upLo && off + bytesV <= this.upHi)) {
      const ri = this.ringInfo;
      let end = off + bytesV;
      if (ri) {
        const ringEnd = ri.dataAbs + ri.size;
        const lim = ri.wAbs > off ? ri.wAbs : ringEnd;
        end = Math.max(end, Math.min(lim, off + (8 << 20)));
      }
      if (this.curVao) { gl.bindVertexArray(null); this.curVao = null; }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(buf, off, end - off), gl.STREAM_DRAW);
      this.upLo = off; this.upHi = end;
      for (const v of this.vaos.values()) gl.deleteVertexArray(v);
      this.vaos.clear();
    }
    const rel = off - this.upLo;
    const phase = rel % stride, first = (rel - phase) / stride;
    const key = mask * 4194304 + stride * 2048 + phase;
    let vao = this.vaos.get(key);
    if (!vao) {
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.dynIdx);
      let o = phase;
      const attr = (loc, size, type, norm, isInt) => {
        gl.enableVertexAttribArray(loc);
        if (isInt) gl.vertexAttribIPointer(loc, size, type, stride, o); else gl.vertexAttribPointer(loc, size, type, norm, stride, o);
      };
      attr(0, 3, gl.FLOAT, false); o += 12;
      if (mask & 2) { attr(1, 3, gl.FLOAT, false); o += 12; if (mask & 4) { attr(2, 3, gl.FLOAT, false); o += 12; attr(3, 3, gl.FLOAT, false); o += 12; } }
      if (mask & 8) { attr(4, 4, gl.UNSIGNED_BYTE, true); o += 4; }
      if (mask & 16) { attr(5, 4, gl.UNSIGNED_BYTE, true); o += 4; }
      for (let i = 0; i < 8; i++) if (mask & (32 << i)) { attr(6 + i, 2, gl.FLOAT, false); o += 8; }
      if (mask & 0x2000) { attr(14, 4, gl.UNSIGNED_BYTE, false, true); o += 4; attr(15, 4, gl.UNSIGNED_BYTE, false, true); o += 8; }
      this.vaos.set(key, vao); this.curVao = vao;
    } else if (vao !== this.curVao) { gl.bindVertexArray(vao); this.curVao = vao; }
    if (prim >= 5) {   // lines / points: drawn directly
      gl.drawArrays([gl.LINES, gl.LINE_STRIP, gl.POINTS][prim - 5], first, count); this.stats.calls = (this.stats.calls || 0) + 1;
      return;
    }
    this.batch = { mask, stride, phase, n: 0 };
    this.addIndices(prim, first, count);
  }
  // triangles of one GX primitive as indices (quads, triangle lists, strips with alternating winding, fans)
  addIndices(prim, f, n) {
    const B = this.batch;
    let need = B.n + n * 3 + 6;
    if (!this.idx || this.idx.length < need) { const a = new Uint32Array(Math.max(need, (this.idx ? this.idx.length : 0) * 2, 65536)); if (this.idx) a.set(this.idx.subarray(0, B.n)); this.idx = a; }
    const ix = this.idx; let k = B.n;
    if (prim <= 1) { for (let q = 0; q + 3 < n; q += 4) { const v = f + q; ix[k++] = v; ix[k++] = v + 1; ix[k++] = v + 2; ix[k++] = v; ix[k++] = v + 2; ix[k++] = v + 3; } }
    else if (prim === 2) { for (let i = 0; i + 2 < n; i += 3) { ix[k++] = f + i; ix[k++] = f + i + 1; ix[k++] = f + i + 2; } }
    else if (prim === 3) { for (let i = 0; i + 2 < n; i++) { if (i & 1) { ix[k++] = f + i + 1; ix[k++] = f + i; } else { ix[k++] = f + i; ix[k++] = f + i + 1; } ix[k++] = f + i + 2; } }
    else { for (let i = 1; i + 1 < n; i++) { ix[k++] = f; ix[k++] = f + i; ix[k++] = f + i + 1; } }
    B.n = k;
  }
  flush() {
    const B = this.batch; if (!B) return;
    this.batch = null;
    if (!B.n) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.dynIdx);      // the bound VAO is this batch's (it holds dynIdx)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.idx.subarray(0, B.n), gl.STREAM_DRAW);
    gl.drawElements(gl.TRIANGLES, B.n, gl.UNSIGNED_INT, 0);
    this.stats.calls = (this.stats.calls || 0) + 1;
  }


  samplerState(i, t) {
    const gl = this.gl, r = i < 4 ? 0x80 + i : 0xA0 + i - 4;
    const m0 = this.bp[r];
    if (t.efb) { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return; }
    const wrap = [gl.CLAMP_TO_EDGE, gl.REPEAT, gl.MIRRORED_REPEAT, gl.REPEAT];
    const pot = (n) => (n & (n - 1)) === 0;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap[m0 & 3]);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap[(m0 >> 2) & 3]);
    const mag = (m0 >> 4) & 1, min = (m0 >> 5) & 7;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag ? gl.LINEAR : gl.NEAREST);
    const mins = [gl.NEAREST, gl.LINEAR, gl.NEAREST_MIPMAP_NEAREST, gl.LINEAR_MIPMAP_NEAREST, gl.NEAREST_MIPMAP_LINEAR, gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR, gl.LINEAR];
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, t.levels > 1 ? mins[min] : (min & 1 ? gl.LINEAR : gl.NEAREST));
    void pot;
  }

  setState() {
    const gl = this.gl, bp = this.bp, S = this.scale;
    // skip when none of the registers involved changed since the last time (and nobody else touched GL state)
    const sig = `${bp[0x40]},${bp[0x41]},${bp[0x42]},${bp[0x43] & 7},${(bp[0x00] >> 14) & 3},${bp[0x20]},${bp[0x21]}`;
    if (sig === this.stateSig && !this.stateDirty) return;
    this.stateSig = sig;
    // depth
    const z = bp[0x40];
    if (z & 1) { gl.enable(gl.DEPTH_TEST); gl.depthFunc([gl.NEVER, gl.LESS, gl.EQUAL, gl.LEQUAL, gl.GREATER, gl.NOTEQUAL, gl.GEQUAL, gl.ALWAYS][(z >> 1) & 7]); }
    else gl.disable(gl.DEPTH_TEST);
    gl.depthMask(!!(z & 16) && !!(z & 1));
    // blend
    const bm = bp[0x41];
    gl.colorMask(!!(bm & 8), !!(bm & 8), !!(bm & 8), !!(bm & 16) && (bp[0x43] & 7) === 1);   // no alpha in RGB8/RGB565 EFB
    // destination alpha (GXSetDstAlpha): the alpha written to the EFB is a constant instead of the TEV alpha
    // (which is still used by the color blending). Games keep EFB alpha for later passes, e.g. MKW's shadows.
    const da = bp[0x42], constA = (da & 0x100) && (bm & 16) && (bp[0x43] & 7) === 1;
    if (bm & 1) {
      gl.enable(gl.BLEND);
      const src = [gl.ZERO, gl.ONE, gl.DST_COLOR, gl.ONE_MINUS_DST_COLOR, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA];
      const dst = [gl.ZERO, gl.ONE, gl.SRC_COLOR, gl.ONE_MINUS_SRC_COLOR, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA];
      const sub = bm & (1 << 11), sf = sub ? gl.ONE : src[(bm >> 8) & 7], df = sub ? gl.ONE : dst[(bm >> 5) & 7];
      const eq = sub ? gl.FUNC_REVERSE_SUBTRACT : gl.FUNC_ADD;
      if (constA) { gl.blendColor(0, 0, 0, (da & 255) / 255); gl.blendEquationSeparate(eq, gl.FUNC_ADD); gl.blendFuncSeparate(sf, df, gl.CONSTANT_ALPHA, gl.ZERO); }
      else { gl.blendEquation(eq); gl.blendFunc(sf, df); }
    } else if ((bm & 2) && ((bm >> 12) & 15) !== 3) {
      // logic op (blending off): WebGL has none, approximated with blend factors like Dolphin does on GLES.
      // MKW draws zero with OR (a no-op on color) in its bloom pass; drawn as a copy it blacked a quarter of the frame
      const Z = gl.ZERO, O = gl.ONE, DC = gl.DST_COLOR, IDC = gl.ONE_MINUS_DST_COLOR, ISC = gl.ONE_MINUS_SRC_COLOR, ISCs = gl.ONE_MINUS_SRC_COLOR, IDA = gl.ONE_MINUS_DST_ALPHA;
      const T = [[0, Z, Z], [0, DC, Z], [1, O, ISC], [0, O, Z], [1, DC, O], [0, Z, O], [0, IDC, ISC], [0, IDC, O],
        [0, IDC, ISC], [0, IDC, Z], [0, IDC, IDC], [0, O, IDA], [0, ISCs, Z], [0, ISCs, O], [0, IDC, ISC], [0, O, O]][(bm >> 12) & 15];
      gl.enable(gl.BLEND); gl.blendEquation(T[0] ? gl.FUNC_REVERSE_SUBTRACT : gl.FUNC_ADD); gl.blendFunc(T[1], T[2]);
    } else if (constA) {
      gl.enable(gl.BLEND); gl.blendColor(0, 0, 0, (da & 255) / 255);
      gl.blendEquation(gl.FUNC_ADD); gl.blendFuncSeparate(gl.ONE, gl.ZERO, gl.CONSTANT_ALPHA, gl.ZERO);
    } else gl.disable(gl.BLEND);
    // cull (GX: 1 = back, 2 = front; our EFB is drawn y-flipped, which swaps the winding)
    const cull = (bp[0x00] >> 14) & 3;
    if (cull === 0) gl.disable(gl.CULL_FACE);
    else { gl.enable(gl.CULL_FACE); gl.frontFace(gl.CCW); gl.cullFace([0, gl.FRONT, gl.BACK, gl.FRONT_AND_BACK][cull]); }
    // scissor (coordinates are offset by 342, plus the scissor offset register)
    const s0 = bp[0x20], s1 = bp[0x21], so = bp[0x59];
    const ox = ((so & 0x3FF) * 2) - 342, oy = (((so >> 10) & 0x3FF) * 2) - 342;
    const x0 = ((s0 >> 12) & 0x7FF) - 342 - ox - 342 + 342, y0 = (s0 & 0x7FF) - 342;
    const x1 = ((s1 >> 12) & 0x7FF) - 342, y1 = (s1 & 0x7FF) - 342;
    void ox; void oy; void x0;
    const sx0 = Math.max(0, ((s0 >> 12) & 0x7FF) - 342), sy0 = Math.max(0, y0);
    const sw = Math.max(0, x1 - sx0 + 1), sh = Math.max(0, y1 - sy0 + 1);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(sx0 * S, (EFB_H - sy0 - sh) * S, sw * S, sh * S);
  }

  // ------------------------------------------------------------------ uniforms
  setUniforms(pr) {
    // each uniform is uploaded only when the registers it comes from changed for this program
    const gl = this.gl, bp = this.bp, xf = this.xfRaw, xff = this.xfF, u = pr.u;
    const c = pr.c || (pr.c = {});
    const same = (k, v) => { if (c[k] === v) return true; c[k] = v; return false; };
    if (!this.tevreg) this.tevreg = new Float32Array(16);
    if (!this.konst) this.konst = new Float32Array(16);
    if (!same('reg', this.tevVer | 0)) { gl.uniform4fv(u.uReg, this.tevreg); gl.uniform4fv(u.uKonst, this.konst); }
    const unpack = (o, a, k) => { o[k] = ((a >>> 24) & 255) / 255; o[k + 1] = ((a >>> 16) & 255) / 255; o[k + 2] = ((a >>> 8) & 255) / 255; o[k + 3] = (a & 255) / 255; };
    if (!same('amb', `${xf[0x100A]},${xf[0x100B]},${xf[0x100C]},${xf[0x100D]}`)) {
      const t = new Float32Array(8); unpack(t, xf[0x100A], 0); unpack(t, xf[0x100B], 4); gl.uniform4fv(u.uAmb, t);
      const m = new Float32Array(8); unpack(m, xf[0x100C], 0); unpack(m, xf[0x100D], 4); gl.uniform4fv(u.uMat, m);
    }
    if (!same('proj', `${xf[0x1020]},${xf[0x1021]},${xf[0x1022]},${xf[0x1023]},${xf[0x1024]},${xf[0x1025]},${xf[0x1026]}`)) {
      gl.uniform1fv(u.uProj, xff.subarray(0x1020, 0x1026)); gl.uniform1i(u.uProjType, xf[0x1026]);
    }
    if (!same('vp', `${xf[0x101A]},${xf[0x101B]},${xf[0x101C]},${xf[0x101D]},${xf[0x101E]},${xf[0x101F]}`)) gl.uniform1fv(u.uVp, xff.subarray(0x101A, 0x1020));
    const mA = xf[0x1018], mB = xf[0x1019];
    if (!same('mtx', mA * 4294967296 + mB)) {
      gl.uniform4i(u.uMtxA, mA & 63, (mA >> 6) & 63, (mA >> 12) & 63, (mA >> 18) & 63);
      gl.uniform4i(u.uMtxB, (mA >> 24) & 63, mB & 63, (mB >> 6) & 63, (mB >> 12) & 63);
      gl.uniform2i(u.uMtxC, (mB >> 18) & 63, 0);
    }
    const ac = bp[0xF3];
    if (!same('aref', ac & 0xFFFF)) gl.uniform2f(u.uAlphaRef, (ac & 255) / 255, ((ac >> 8) & 255) / 255);
    if (!c.samplers) { c.samplers = true; for (let i = 0; i < 8; i++) if (u['uS' + i]) gl.uniform1i(u['uS' + i], i); }
    if (u.uTexDim && !same('dim', `${bp[0x88]},${bp[0x89]},${bp[0x8A]},${bp[0x8B]},${bp[0xA8]},${bp[0xA9]},${bp[0xAA]},${bp[0xAB]}`)) {
      const d = new Float32Array(16);
      for (let i = 0; i < 8; i++) { const r = i < 4 ? 0x88 + i : 0xA8 + i - 4; d[2 * i] = (bp[r] & 0x3FF) + 1; d[2 * i + 1] = ((bp[r] >> 10) & 0x3FF) + 1; }
      gl.uniform2fv(u.uTexDim, d);
    }
    if (u.uIndMtx && !same('imtx', `${bp[6]},${bp[7]},${bp[8]},${bp[9]},${bp[10]},${bp[11]},${bp[12]},${bp[13]},${bp[14]}`)) {
      const m = new Int32Array(24);
      const s11 = (v) => (v & 0x7FF) << 21 >> 21;
      for (let i = 0; i < 3; i++) {
        const A = bp[0x06 + 3 * i], B = bp[0x07 + 3 * i], C = bp[0x08 + 3 * i];
        const sc = ((A >> 22) & 3) | (((B >> 22) & 3) << 2) | (((C >> 22) & 3) << 4);
        m.set([s11(A), s11(B), s11(C), sc - 17], 8 * i);
        m.set([s11(A >> 11), s11(B >> 11), s11(C >> 11), sc - 17], 8 * i + 4);
      }
      gl.uniform4iv(u.uIndMtx, m);
    }
    if (u.uIndScale && !same('iscale', bp[0x25] * 16777216 + bp[0x26])) {
      const sc = new Float32Array(8), r = [bp[0x25], bp[0x25] >> 8, bp[0x26], bp[0x26] >> 8];
      for (let i = 0; i < 4; i++) { sc[2 * i] = 1 / (1 << (r[i] & 15)); sc[2 * i + 1] = 1 / (1 << ((r[i] >> 4) & 15)); }
      gl.uniform2fv(u.uIndScale, sc);
    }
    const f2 = bp[0xF2];
    if (!same('fog', f2)) gl.uniform3f(u.uFogColor, ((f2 >> 16) & 255) / 255, ((f2 >> 8) & 255) / 255, (f2 & 255) / 255);
  }
  onBPWrite(reg, val) {
    if (reg >= 0xE0 && reg <= 0xE7) {
      this.tevVer = (this.tevVer | 0) + 1;
      const i = (reg - 0xE0) >> 1, ra = this.bp[0xE0 + 2 * i], bg = this.bp[0xE1 + 2 * i];
      const s11 = (v) => ((v & 0x7FF) << 21 >> 21) / 255;
      const isK = ((reg & 1) ? (bg >> 23) : (ra >> 23)) & 1;
      if (!this.tevreg) this.tevreg = new Float32Array(16);
      if (!this.konst) this.konst = new Float32Array(16);
      const dst = isK ? this.konst : this.tevreg;
      if (reg & 1) { dst[i * 4 + 2] = isK ? (bg & 255) / 255 : s11(bg); dst[i * 4 + 1] = isK ? ((bg >> 12) & 255) / 255 : s11(bg >> 12); }
      else { dst[i * 4 + 0] = isK ? (ra & 255) / 255 : s11(ra); dst[i * 4 + 3] = isK ? ((ra >> 12) & 255) / 255 : s11(ra >> 12); }
    }
  }

  // ------------------------------------------------------------------ shader generation
  program(mask) {
    const bp = this.bp, xf = this.xfRaw;
    const gen = bp[0x00];
    const nst = ((gen >> 10) & 15) + 1, nind = (gen >> 16) & 7;
    const ntg = Math.min(8, xf[0x103F] & 15), ncol = xf[0x1009] & 3;
    const parts = [mask, nst, ntg, ncol, nind, xf[0x100E], xf[0x100F], xf[0x1010], xf[0x1011], xf[0x1012] & 1, (bp[0xF3] >> 16) & 255, bp[0xF1] >> 21];
    for (let i = 0; i < nst; i++) parts.push(bp[0xC0 + 2 * i] & 0xFFFFFF, bp[0xC1 + 2 * i] & 0xFFFFFF, (bp[0x28 + (i >> 1)] >> ((i & 1) * 12)) & 0xFFF, bp[0x10 + i] & 0x1FFFFF);
    for (let i = 0; i < 8; i++) parts.push(bp[0xF6 + i] & 0xFFFFFF);
    for (let i = 0; i < ntg; i++) parts.push(xf[0x1040 + i], xf[0x1050 + i] & 0x13F);
    parts.push(bp[0x27] & 0xFFFFFF, bp[0x25] & 0xFFFFFF, bp[0x26] & 0xFFFFFF);
    if ((bp[0xF5] >> 2) & 3) parts.push('z', bp[0xF5] & 0xF, bp[0xF4] & 0xFFFFFF);
    const key = parts.join(',');
    let pr = this.programs.get(key);
    const budget = () => this.warming || (this.newThisFrame | 0) < (this.compilePerFrame || (this.parallel ? 6 : 1));
    if (pr) {
      if (!pr.waiting) return pr;
      // a program waiting for its turn to be compiled (the source was generated once, when first seen)
      if (this.uberOnly || !budget()) return GXRenderer.PENDING;
      let e = this.srcCache.get(pr.sk);
      if (!e) { e = { p: this.link(pr.vs, pr.fs), u: null, texUsed: pr.texUsed, ready: false }; this.srcCache.set(pr.sk, e); this.newThisFrame = (this.newThisFrame | 0) + 1; }
      this.programs.set(key, e);
      return e;
    }
    if (this.uberOnly && !this.warming) return GXRenderer.PENDING;
    // the same code may already be compiled for another state (only a real compile counts against the budget)
    pr = this.buildProgram(mask, nst, ntg, ncol, nind, budget());
    this.stats.progs++;
    if (!this.warming && (pr.fresh || pr.waiting)) {
      // code never seen before: remember this state (it is compiled at the next start-up with everything else).
      // States that only produce code already known are not stored (that kept the cache small and quick to load)
      this.stats.newShaders = (this.stats.newShaders || 0) + 1;
      if (this.onNewProgram) {
        const st = new Uint32Array(1 + 256 + 0x60); st[0] = mask; st.set(bp, 1); st.set(xf.subarray(0x1000, 0x1060), 257);
        this.onNewProgram(key, st);
      }
    }
    if (pr.fresh) { pr.fresh = false; if (!this.warming) this.newThisFrame = (this.newThisFrame | 0) + 1; }
    this.programs.set(key, pr);
    return pr.waiting ? GXRenderer.PENDING : pr;
  }

  buildProgram(mask, nst, ntg, ncol, nind, canCompile = true) {
    const bp = this.bp, xf = this.xfRaw, gl = this.gl;
    // ---------------- vertex shader
    let vs = `#version 300 es
precision highp float; precision highp int;
layout(std140) uniform XF { vec4 x[416]; };
in vec3 aPos; in vec3 aNrm; in vec3 aBin; in vec3 aTan; in vec4 aCol0; in vec4 aCol1;
in vec2 aTex0, aTex1, aTex2, aTex3, aTex4, aTex5, aTex6, aTex7;
in uvec4 aIdx0; in uvec4 aIdx1;
uniform float uProj[6]; uniform int uProjType; uniform float uVp[6];
uniform ivec4 uMtxA, uMtxB; uniform ivec2 uMtxC;
uniform vec4 uAmb[2], uMat[2];
out vec4 vCol0, vCol1;
${[...Array(8).keys()].map((i) => `out vec3 vTex${i};`).join('\n')}
float X(int a) { return x[a >> 2][a & 3]; }
vec4 R(int r) { return x[r]; }
uint XU(int a) { return floatBitsToUint(x[a >> 2][a & 3]); }
vec4 col(uint c) { return vec4(float((c >> 24) & 255u), float((c >> 16) & 255u), float((c >> 8) & 255u), float(c & 255u)) / 255.0; }
`;
    const hasN = mask & 2, hasIdx = mask & 0x2000;
    vs += `void main() {
  int pm = ${hasIdx ? 'int(aIdx0.x)' : 'uMtxA.x'};
  vec4 p = vec4(aPos, 1.0);
  vec3 wp = vec3(dot(R(pm), p), dot(R(pm + 1), p), dot(R(pm + 2), p));
  int nb = 0x400 + (pm & 31) * 3;
  vec3 n = ${hasN ? 'normalize(vec3(X(nb) * aNrm.x + X(nb + 1) * aNrm.y + X(nb + 2) * aNrm.z, X(nb + 3) * aNrm.x + X(nb + 4) * aNrm.y + X(nb + 5) * aNrm.z, X(nb + 6) * aNrm.x + X(nb + 7) * aNrm.y + X(nb + 8) * aNrm.z))' : 'vec3(0.0, 0.0, 1.0)'};
  vec4 c;
  if (uProjType == 0) c = vec4(uProj[0] * wp.x + uProj[1] * wp.z, uProj[2] * wp.y + uProj[3] * wp.z, uProj[4] * wp.z + uProj[5], -wp.z);
  else c = vec4(uProj[0] * wp.x + uProj[1], uProj[2] * wp.y + uProj[3], uProj[4] * wp.z + uProj[5], 1.0);
  vec3 nd = c.xyz / c.w;
  float wx = uVp[3] - 342.0 + uVp[0] * nd.x, wy = uVp[4] - 342.0 + uVp[1] * nd.y;
  float dz = clamp((uVp[5] + uVp[2] * nd.z) / 16777215.0, 0.0, 1.0);
  gl_Position = vec4((wx / 320.0 - 1.0) * c.w, (1.0 - wy / 264.0) * c.w, (dz * 2.0 - 1.0) * c.w, c.w);
`;
    // lighting
    const chan = (i, ctl, isAlpha) => {
      const vc = i === 0 ? ((mask & 8) ? 'aCol0' : 'vec4(1.0)') : ((mask & 16) ? 'aCol1' : ((mask & 8) ? 'aCol0' : 'vec4(1.0)'));
      const comp = isAlpha ? '.a' : '.rgb';
      const mat = (ctl & 1) ? vc + comp : `uMat[${i}]${comp}`;
      if (!(ctl & 2)) return mat;
      const amb = (ctl & 64) ? vc + comp : `uAmb[${i}]${comp}`;
      let s = `(${amb}`;
      const lmask = ((ctl >> 2) & 15) | (((ctl >> 11) & 15) << 4);
      const diff = (ctl >> 7) & 3, attn = (ctl >> 9) & 1, spot = (ctl >> 10) & 1;
      for (let l = 0; l < 8; l++) {
        if (!(lmask & (1 << l))) continue;
        const b = 0x600 + 16 * l;
        const lc = `col(XU(${b + 3}))${comp}`;
        const lpos = `vec3(X(${b + 10}), X(${b + 11}), X(${b + 12}))`, ldir = `vec3(X(${b + 13}), X(${b + 14}), X(${b + 15}))`;
        let d = '1.0';
        if (diff === 1) d = `dot(normalize(${lpos} - wp), n)`;
        else if (diff === 2) d = `max(dot(normalize(${lpos} - wp), n), 0.0)`;
        let a = '1.0';
        if (attn) {
          if (spot) a = `lspot(${b}, wp)`; else a = `lspec(${b}, n, wp)`;
        }
        s += ` + ${lc} * (${d}) * (${a})`;
      }
      s += ')';
      return `${mat} * clamp(${s}, 0.0, 1.0)`;
    };
    vs = vs.replace('void main() {', `float lspot(int b, vec3 wp) {
  vec3 lv = vec3(X(b + 10), X(b + 11), X(b + 12)) - wp; float d2 = dot(lv, lv), d = sqrt(d2); lv /= max(d, 1e-6);
  float ca = max(0.0, dot(-lv, vec3(X(b + 13), X(b + 14), X(b + 15))));
  return max(0.0, X(b + 4) + X(b + 5) * ca + X(b + 6) * ca * ca) / max(1e-6, X(b + 7) + X(b + 8) * d + X(b + 9) * d2);
}
float lspec(int b, vec3 n, vec3 wp) {
  vec3 lv = normalize(vec3(X(b + 10), X(b + 11), X(b + 12)));
  float at = dot(n, lv) >= 0.0 ? max(0.0, dot(n, vec3(X(b + 13), X(b + 14), X(b + 15)))) : 0.0;
  return max(0.0, X(b + 4) + X(b + 5) * at + X(b + 6) * at * at) / max(1e-6, X(b + 7) + X(b + 8) * at + X(b + 9) * at * at);
}
void main() {`);
    vs += `  vCol0 = vec4(${chan(0, xf[0x100E], false)}, ${chan(0, xf[0x1010], true)});\n`;
    vs += `  vCol1 = vec4(${chan(1, xf[0x100F], false)}, ${chan(1, xf[0x1011], true)});\n`;
    // texgens
    const tmiExpr = (i) => hasIdx ? (i === 0 ? 'int(aIdx0.y)' : i === 1 ? 'int(aIdx0.z)' : i === 2 ? 'int(aIdx0.w)' : `int(aIdx1.${'xyzw'[i - 3] || 'w'})`)
      : (['uMtxA.y', 'uMtxA.z', 'uMtxA.w', 'uMtxB.x', 'uMtxB.y', 'uMtxB.z', 'uMtxB.w', 'uMtxC.x'][i]);
    for (let i = 0; i < 8; i++) {
      if (i >= ntg) { vs += `  vTex${i} = vec3(0.0, 0.0, 1.0);\n`; continue; }
      const info = xf[0x1040 + i], post = xf[0x1050 + i];
      const proj = (info >> 1) & 1, abc1 = (info >> 2) & 1, type = (info >> 4) & 7, row = (info >> 7) & 31;
      let src;
      if (row === 0) src = 'vec4(aPos, 1.0)';
      else if (row === 1) src = 'vec4(' + ((mask & 2) ? 'aNrm' : 'vec3(0.0,0.0,1.0)') + ', 1.0)';
      else if (row === 3) src = 'vec4(' + ((mask & 4) ? 'aTan' : 'vec3(0.0)') + ', 1.0)';
      else if (row === 4) src = 'vec4(' + ((mask & 4) ? 'aBin' : 'vec3(0.0)') + ', 1.0)';
      else if (row >= 5 && row <= 12) { const k = row - 5; src = (mask & (32 << k)) ? `vec4(aTex${k}, 1.0, 1.0)` : 'vec4(0.0, 0.0, 1.0, 1.0)'; }
      else src = 'vec4(0.0, 0.0, 1.0, 1.0)';
      if (!abc1 && row !== 0 && row !== 1) src = `vec4((${src}).xy, 1.0, 1.0)`;
      let out;
      if (type === 0) {
        vs += `  { int m = ${tmiExpr(i)}; vec4 s = ${src};\n`;
        if (proj) vs += `    vec3 t = vec3(dot(R(m), s), dot(R(m + 1), s), dot(R(m + 2), s));\n`;
        else vs += `    vec3 t = vec3(dot(R(m), s), dot(R(m + 1), s), 1.0);\n`;
        if (xf[0x1012] & 1) {
          if (post & 0x100) vs += `    t = normalize(t);\n`;
          vs += `    int pm2 = 0x140 + ${post & 63}; vec4 tt = vec4(t, 1.0); t = vec3(dot(R(pm2), tt), dot(R(pm2 + 1), tt), dot(R(pm2 + 2), tt));\n`;
        }
        vs += `    vTex${i} = t; }\n`;
        void out;
      } else if (type === 1) {
        const srcTg = (info >> 12) & 7;
        vs += `  vTex${i} = vTex${srcTg};\n`;
      } else {
        vs += `  vTex${i} = vec3(${type === 2 ? 'vCol0' : 'vCol1'}.rg, 1.0);\n`;
      }
    }
    vs += '}\n';

    // ---------------- fragment shader (TEV)
    let fs = `#version 300 es
precision highp float; precision highp int;
in vec4 vCol0, vCol1;
${[...Array(8).keys()].map((i) => `in vec3 vTex${i};`).join('\n')}
uniform sampler2D uS0, uS1, uS2, uS3, uS4, uS5, uS6, uS7;
uniform vec4 uReg[4]; uniform vec4 uKonst[4]; uniform vec2 uAlphaRef; uniform vec3 uFogColor;
uniform vec2 uTexDim[8]; uniform ivec4 uIndMtx[6]; uniform vec2 uIndScale[4]; uniform int uTexScl[8]; uniform int uTexNear[8];
out vec4 oColor;
vec2 tc(vec3 t) { return t.xy / (t.z == 0.0 ? 1.0 : t.z); }
// texture coordinate at the centre of the console pixel this fragment belongs to (the EFB is rendered at a
// higher scale; indirect texturing must pick the same texels the console would)
vec2 tcn(vec3 t) { vec2 c = tc(t); vec2 o = (floor(gl_FragCoord.xy / ${this.scale.toFixed(1)}) + 0.5) * ${this.scale.toFixed(1)} - gl_FragCoord.xy; return c + dFdx(c) * o.x + dFdy(c) * o.y; }
int dot3(ivec3 a, ivec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
void main() {
  vec4 r0 = uReg[1], r1 = uReg[2], r2 = uReg[3], prev = uReg[0];
  ivec2 tevcoord = ivec2(0);
  vec4 ztexv = vec4(1.0);
`;
    let texUsed = 0;
    // indirect texture lookups (BP 0x27 IREF, 0x25/0x26 scales)
    for (let i = 0; i < nind; i++) {
      const iref = (bp[0x27] >> (6 * i)) & 63, map = iref & 7, crd = (iref >> 3) & 7;
      texUsed |= 1 << map;
      fs += `  ivec3 iindtex${i}; { ivec2 dm = ivec2(uTexDim[${map}]); ivec2 p = ivec2(floor(tcn(vTex${crd}) * uIndScale[${i}] * uTexDim[${map}] + 0.001));
    p = ((p % dm) + dm) % dm; iindtex${i} = ivec3(texelFetch(uS${map}, p * uTexScl[${map}] + uTexScl[${map}] / 2, 0).abg * 255.0 + 0.5); }\n`;
    }
    const swap = (t) => { const a = bp[0xF6 + 2 * t], b = bp[0xF7 + 2 * t]; return 'rgba'[a & 3] + 'rgba'[(a >> 2) & 3] + 'rgba'[b & 3] + 'rgba'[(b >> 2) & 3]; };
    const kc = ['vec3(1.0)', 'vec3(0.875)', 'vec3(0.75)', 'vec3(0.625)', 'vec3(0.5)', 'vec3(0.375)', 'vec3(0.25)', 'vec3(0.125)', 'vec3(0.0)', 'vec3(0.0)', 'vec3(0.0)', 'vec3(0.0)',
      'uKonst[0].rgb', 'uKonst[1].rgb', 'uKonst[2].rgb', 'uKonst[3].rgb', 'uKonst[0].rrr', 'uKonst[1].rrr', 'uKonst[2].rrr', 'uKonst[3].rrr',
      'uKonst[0].ggg', 'uKonst[1].ggg', 'uKonst[2].ggg', 'uKonst[3].ggg', 'uKonst[0].bbb', 'uKonst[1].bbb', 'uKonst[2].bbb', 'uKonst[3].bbb',
      'uKonst[0].aaa', 'uKonst[1].aaa', 'uKonst[2].aaa', 'uKonst[3].aaa'];
    const ka = ['1.0', '0.875', '0.75', '0.625', '0.5', '0.375', '0.25', '0.125', '0.0', '0.0', '0.0', '0.0', '0.0', '0.0', '0.0', '0.0',
      'uKonst[0].r', 'uKonst[1].r', 'uKonst[2].r', 'uKonst[3].r', 'uKonst[0].g', 'uKonst[1].g', 'uKonst[2].g', 'uKonst[3].g',
      'uKonst[0].b', 'uKonst[1].b', 'uKonst[2].b', 'uKonst[3].b', 'uKonst[0].a', 'uKonst[1].a', 'uKonst[2].a', 'uKonst[3].a'];
    const regName = ['prev', 'r0', 'r1', 'r2'];
    for (let s = 0; s < nst; s++) {
      const ce = bp[0xC0 + 2 * s], ae = bp[0xC1 + 2 * s];
      const tref = (bp[0x28 + (s >> 1)] >> ((s & 1) * 12)) & 0xFFF;
      const tmap = tref & 7, tcoord = (tref >> 3) & 7, ten = (tref >> 6) & 1, chn = (tref >> 7) & 7;
      const ksel = bp[0xF6 + (s >> 1)] >> ((s & 1) ? 14 : 4);
      const kcs = ksel & 31, kas = (ksel >> 5) & 31;
      const rs = swap(ae & 3), ts = swap((ae >> 2) & 3);
      fs += `  {\n`;
      const ind = bp[0x10 + s] & 0x1FFFFF;
      const bt = ind & 3, ifmt = (ind >> 2) & 3, ibias = (ind >> 4) & 7, mid = (ind >> 9) & 15, sw = (ind >> 13) & 7, tw = (ind >> 16) & 7, fb = (ind >> 20) & 1;
      const indActive = !this.debugNoInd && ind !== 0 && (mid !== 0 || sw || tw || fb || bt < nind);
      if (ten && indActive) {
        texUsed |= 1 << tmap;
        fs += `    ivec2 fuv = ivec2(floor(tcn(vTex${tcoord}) * uTexDim[${tmap}] * 128.0 + 0.05));\n`;
        let ic = 'ivec3(0)';
        if (bt < nind) {
          const m = [0xFF, 0x1F, 0x0F, 0x07][ifmt];
          fs += `    ivec3 ic = iindtex${bt} & ${m};\n`;
          const add = ifmt === 0 ? '-128' : '1';
          if (ibias & 1) fs += `    ic.x += ${add};\n`;
          if (ibias & 2) fs += `    ic.y += ${add};\n`;
          if (ibias & 4) fs += `    ic.z += ${add};\n`;
          ic = 'ic';
        }
        let trans = 'ivec2(0)';
        if (mid >= 1 && mid <= 3) {
          const k = 2 * (mid - 1);
          fs += `    ivec2 it = ivec2(dot3(uIndMtx[${k}].xyz, ${ic}), dot3(uIndMtx[${k + 1}].xyz, ${ic})) >> 3;\n`;
          fs += `    int sh = uIndMtx[${k}].w; it = sh >= 0 ? it << sh : it >> (-sh);\n`;
          trans = 'it';
        } else if ((mid >= 5 && mid <= 7) || (mid >= 9 && mid <= 11)) {
          const k = 2 * ((mid & 3) - 1);
          fs += `    ivec2 it = (fuv * ${ic}.${mid <= 7 ? 'xx' : 'yy'}) >> 8;\n`;
          fs += `    int sh = uIndMtx[${k}].w; it = sh >= 0 ? it << sh : it >> (-sh);\n`;
          trans = 'it';
        }
        const wrapv = (w) => [0, 256, 128, 64, 32, 16, -1][w] ?? 0;
        const ws = wrapv(sw), wt = wrapv(tw);
        const wx = ws === 0 ? 'fuv.x' : ws < 0 ? '0' : `(fuv.x & ${ws * 128 - 1})`;
        const wy = wt === 0 ? 'fuv.y' : wt < 0 ? '0' : `(fuv.y & ${wt * 128 - 1})`;
        fs += `    tevcoord = ivec2(${wx}, ${wy}) + ${trans}${fb ? ' + tevcoord' : ''};\n`;
        // linear-filtered texture with a plain offset: sample at this fragment's own (sub-pixel) coordinate plus
        // the offset so the higher render scale keeps its detail; otherwise address texels exactly (Bink video)
        const plain = !ws && !wt && !fb;
        fs += `    vec4 tex; if (${plain ? `uTexNear[${tmap}] == 0` : 'false'}) tex = texture(uS${tmap}, tc(vTex${tcoord}) + vec2(${trans}) / (128.0 * uTexDim[${tmap}])).${ts};
    else { ivec2 dm = ivec2(uTexDim[${tmap}]); ivec2 p = tevcoord >> 7; p = ((p % dm) + dm) % dm; tex = texelFetch(uS${tmap}, p * uTexScl[${tmap}] + uTexScl[${tmap}] / 2, 0).${ts}; }\n`;
      } else if (ten) { texUsed |= 1 << tmap; fs += `    vec4 tex = texture(uS${tmap}, tc(vTex${tcoord})).${ts};\n`; }
      else fs += `    vec4 tex = vec4(1.0);\n`;
      fs += `    ztexv = tex;\n`;
      fs += `    vec4 ras = ${chn === 0 ? 'vCol0' : chn === 1 ? 'vCol1' : 'vec4(0.0)'}.${rs};\n`;
      fs += `    vec3 kc = ${kc[kcs]}; float ka = ${ka[kas]};\n`;
      const cin = (v) => ['prev.rgb', 'prev.aaa', 'r0.rgb', 'r0.aaa', 'r1.rgb', 'r1.aaa', 'r2.rgb', 'r2.aaa', 'tex.rgb', 'tex.aaa', 'ras.rgb', 'ras.aaa', 'vec3(1.0)', 'vec3(0.5)', 'kc', 'vec3(0.0)'][v];
      const ain = (v) => ['prev.a', 'r0.a', 'r1.a', 'r2.a', 'tex.a', 'ras.a', 'ka', '0.0'][v];
      const comb = (d, c, b, a, bias, op, clampb, scale, isAlpha) => {
        const T = isAlpha ? 'float' : 'vec3';
        const sat = (e) => `clamp(${e}, 0.0, 1.0)`;
        if (bias === 3) {
          const cmp = op | (scale << 1);
          const A = sat(a), B = sat(b);
          let cond;
          const pack16 = (v) => `(${v}.g * 256.0 + ${v}.r)`, pack24 = (v) => `(${v}.b * 65536.0 + ${v}.g * 256.0 + ${v}.r)`;
          if (isAlpha) {
            switch (cmp) {
              case 0: case 2: case 4: cond = `(${A} > ${B} ? 1.0 : 0.0)`; break;
              default: cond = `(abs(${A} - ${B}) < 0.002 ? 1.0 : 0.0)`; break;
            }
            if (cmp === 6) cond = `(${A} > ${B} ? 1.0 : 0.0)`;
            return `${sat(`${d} + ${cond} * ${c}`)}`;
          }
          const av = `${A}`, bv = `${B}`;
          switch (cmp) {
            case 0: cond = `vec3((${av}).r > (${bv}).r ? 1.0 : 0.0)`; break;
            case 1: cond = `vec3(abs((${av}).r - (${bv}).r) < 0.002 ? 1.0 : 0.0)`; break;
            case 2: cond = `vec3(${pack16(`(${av})`)} > ${pack16(`(${bv})`)} ? 1.0 : 0.0)`; break;
            case 3: cond = `vec3(abs(${pack16(`(${av})`)} - ${pack16(`(${bv})`)}) < 0.5 ? 1.0 : 0.0)`; break;
            case 4: cond = `vec3(${pack24(`(${av})`)} > ${pack24(`(${bv})`)} ? 1.0 : 0.0)`; break;
            case 5: cond = `vec3(abs(${pack24(`(${av})`)} - ${pack24(`(${bv})`)}) < 0.5 ? 1.0 : 0.0)`; break;
            case 6: cond = `vec3(greaterThan(${av}, ${bv}))`; break;
            default: cond = `vec3(lessThan(abs(${av} - ${bv}), vec3(0.002)))`; break;
          }
          return `${sat(`${d} + ${cond} * ${c}`)}`;
        }
        const bias_s = ['0.0', '0.5', '-0.5'][bias];
        const sc = ['1.0', '2.0', '4.0', '0.5'][scale];
        let e = `(${d} ${op ? '-' : '+'} mix(${sat(a)}, ${sat(b)}, ${sat(c)}) + ${bias_s}) * ${sc}`;
        return clampb ? sat(e) : `clamp(${e}, -4.0, 4.0)`;
        void T;
      };
      const cd = ce & 15, cc = (ce >> 4) & 15, cb = (ce >> 8) & 15, ca = (ce >> 12) & 15;
      const cbias = (ce >> 16) & 3, cop = (ce >> 18) & 1, cclamp = (ce >> 19) & 1, cscale = (ce >> 20) & 3, cdest = (ce >> 22) & 3;
      const ad = (ae >> 4) & 7, ac = (ae >> 7) & 7, ab = (ae >> 10) & 7, aa = (ae >> 13) & 7;
      const abias = (ae >> 16) & 3, aop = (ae >> 18) & 1, aclamp = (ae >> 19) & 1, ascale = (ae >> 20) & 3, adest = (ae >> 22) & 3;
      fs += `    vec3 cres = ${comb(cin(cd), cin(cc), cin(cb), cin(ca), cbias, cop, cclamp, cscale, false)};\n`;
      fs += `    float ares = ${comb(ain(ad), ain(ac), ain(ab), ain(aa), abias, aop, aclamp, ascale, true)};\n`;
      fs += `    ${regName[cdest]}.rgb = cres; ${regName[adest]}.a = ares;\n  }\n`;
      if (s === nst - 1) this._lastDest = [cdest, adest];
    }
    const [cd, ad] = this._lastDest;
    fs += `  vec4 outc = vec4(clamp(${regName[cd]}.rgb, 0.0, 1.0), clamp(${regName[ad]}.a, 0.0, 1.0));\n`;
    // Z textures (BP 0xF4/0xF5): the depth comes from (or is offset by) the last stage's texel. MKW draws its
    // frame-blend quad with the previous frame's depth this way, so it only lands where that depth is nearer
    const zop = (bp[0xF5] >> 2) & 3, zfmt = bp[0xF5] & 3;
    if (zop === 1 || zop === 2) {
      const zw = ['vec4(0.0, 0.0, 0.0, 1.0)', 'vec4(1.0, 0.0, 0.0, 256.0)', 'vec4(65536.0, 256.0, 1.0, 0.0)', 'vec4(0.0)'][zfmt];
      fs += `  float zc = dot(floor(clamp(ztexv, 0.0, 1.0) * 255.0 + 0.5), ${zw}) + ${(bp[0xF4] & 0xFFFFFF).toFixed(1)}${zop === 1 ? ' + min(round(gl_FragCoord.z * 16777215.0), 16777215.0)' : ''};\n`;
      fs += `  gl_FragDepth = clamp(mod(zc, 16777216.0) / 16777215.0, 0.0, 1.0);\n`;
      if (this.debugZtex) fs += `  outc = vec4(ztexv.rgb, 1.0);\n`;
    }
    // alpha test
    const ac = bp[0xF3], c0 = (ac >> 16) & 7, c1 = (ac >> 19) & 7, logic = (ac >> 22) & 3;
    const cmp = (f, ref) => ['false', `(outc.a < ${ref})`, `(abs(outc.a - ${ref}) < 0.002)`, `(outc.a <= ${ref} + 0.002)`, `(outc.a > ${ref})`, `(abs(outc.a - ${ref}) >= 0.002)`, `(outc.a >= ${ref} - 0.002)`, 'true'][f];
    const t0 = cmp(c0, 'uAlphaRef.x'), t1 = cmp(c1, 'uAlphaRef.y');
    const pass = [`(${t0} && ${t1})`, `(${t0} || ${t1})`, `(${t0} != ${t1})`, `(${t0} == ${t1})`][logic];
    if (pass !== '(true && true)') fs += `  if (!${pass}) discard;\n`;
    fs += `  oColor = outc;\n}\n`;
    // different register states often generate the same code: one program per distinct source
    if (!this.srcCache) this.srcCache = new Map();
    const sk = GXRenderer.hashStr(vs) + ':' + GXRenderer.hashStr(fs) + ':' + fs.length;
    let e = this.srcCache.get(sk);
    if (e) return e;
    if (!canCompile) return { waiting: true, vs, fs, texUsed, sk };
    e = { p: this.link(vs, fs), u: null, texUsed, ready: false, fresh: true };
    this.srcCache.set(sk, e);
    return e;
  }
  static hashStr(t) {   // 53-bit FNV-style hash of a string
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822519) ^ (h2 >>> 13); }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
  }
  // ------------------------------------------------------------------ ubershader
  // One program that reads the whole TEV / lighting / texgen setup from uniforms. It is slower on the GPU than
  // the specialized programs, but it is ready from the start: draws whose specialized program is still being
  // compiled use it, so nothing disappears or stalls while a new area loads.
  buildUber() {
    const gl = this.gl, SC = this.scale.toFixed(1);
    const vs = `#version 300 es
precision highp float; precision highp int;
layout(std140) uniform XF { vec4 x[416]; };
in vec3 aPos; in vec3 aNrm; in vec3 aBin; in vec3 aTan; in vec4 aCol0; in vec4 aCol1;
in vec2 aTex0, aTex1, aTex2, aTex3, aTex4, aTex5, aTex6, aTex7;
in uvec4 aIdx0; in uvec4 aIdx1;
uniform float uProj[6]; uniform int uProjType; uniform float uVp[6];
uniform ivec4 uMtxA, uMtxB; uniform ivec2 uMtxC;
uniform vec4 uAmb[2], uMat[2];
uniform ivec4 uVC; uniform ivec4 uChan; uniform ivec4 uTg[8];
out vec4 vCol0, vCol1;
${[...Array(8).keys()].map((i) => `out vec3 vTex${i};`).join('\n')}
float X(int a) { return x[a >> 2][a & 3]; }
vec4 R(int r) { return x[r]; }
uint XU(int a) { return floatBitsToUint(x[a >> 2][a & 3]); }
vec4 col(uint c) { return vec4(float((c >> 24) & 255u), float((c >> 16) & 255u), float((c >> 8) & 255u), float(c & 255u)) / 255.0; }
float lspot(int b, vec3 wp) {
  vec3 lv = vec3(X(b + 10), X(b + 11), X(b + 12)) - wp; float d2 = dot(lv, lv), d = sqrt(d2); lv /= max(d, 1e-6);
  float ca = max(0.0, dot(-lv, vec3(X(b + 13), X(b + 14), X(b + 15))));
  return max(0.0, X(b + 4) + X(b + 5) * ca + X(b + 6) * ca * ca) / max(1e-6, X(b + 7) + X(b + 8) * d + X(b + 9) * d2);
}
float lspec(int b, vec3 n, vec3 wp) {
  vec3 lv = normalize(vec3(X(b + 10), X(b + 11), X(b + 12)));
  float at = dot(n, lv) >= 0.0 ? max(0.0, dot(n, vec3(X(b + 13), X(b + 14), X(b + 15)))) : 0.0;
  return max(0.0, X(b + 4) + X(b + 5) * at + X(b + 6) * at * at) / max(1e-6, X(b + 7) + X(b + 8) * at + X(b + 9) * at * at);
}
vec4 lit(int ctl, vec4 vc, vec4 matU, vec4 ambU, vec3 wp, vec3 n) {
  vec4 mat = (ctl & 1) != 0 ? vc : matU;
  if ((ctl & 2) == 0) return mat;
  vec4 s = (ctl & 64) != 0 ? vc : ambU;
  int lmask = ((ctl >> 2) & 15) | (((ctl >> 11) & 15) << 4);
  int diff = (ctl >> 7) & 3, attn = (ctl >> 9) & 1, spot = (ctl >> 10) & 1;
  for (int l = 0; l < 8; l++) {
    if ((lmask & (1 << l)) == 0) continue;
    int b = 0x600 + 16 * l;
    vec3 lpos = vec3(X(b + 10), X(b + 11), X(b + 12));
    float d = 1.0;
    if (diff == 1) d = dot(normalize(lpos - wp), n); else if (diff == 2) d = max(dot(normalize(lpos - wp), n), 0.0);
    float a = 1.0;
    if (attn != 0) a = spot != 0 ? lspot(b, wp) : lspec(b, n, wp);
    s += col(XU(b + 3)) * d * a;
  }
  return mat * clamp(s, 0.0, 1.0);
}
vec2 texIn(int k) {
  if (k == 0) return aTex0; if (k == 1) return aTex1; if (k == 2) return aTex2; if (k == 3) return aTex3;
  if (k == 4) return aTex4; if (k == 5) return aTex5; if (k == 6) return aTex6; return aTex7;
}
int tmi(int i) {
  if ((uVC.x & 0x2000) != 0) { if (i == 0) return int(aIdx0.y); if (i == 1) return int(aIdx0.z); if (i == 2) return int(aIdx0.w); if (i == 3) return int(aIdx1.x); if (i == 4) return int(aIdx1.y); if (i == 5) return int(aIdx1.z); return int(aIdx1.w); }
  if (i == 0) return uMtxA.y; if (i == 1) return uMtxA.z; if (i == 2) return uMtxA.w; if (i == 3) return uMtxB.x; if (i == 4) return uMtxB.y; if (i == 5) return uMtxB.z; if (i == 6) return uMtxB.w; return uMtxC.x;
}
void main() {
  int mask = uVC.x;
  int pm = (mask & 0x2000) != 0 ? int(aIdx0.x) : uMtxA.x;
  vec4 p = vec4(aPos, 1.0);
  vec3 wp = vec3(dot(R(pm), p), dot(R(pm + 1), p), dot(R(pm + 2), p));
  int nb = 0x400 + (pm & 31) * 3;
  vec3 n = (mask & 2) != 0 ? normalize(vec3(X(nb) * aNrm.x + X(nb + 1) * aNrm.y + X(nb + 2) * aNrm.z, X(nb + 3) * aNrm.x + X(nb + 4) * aNrm.y + X(nb + 5) * aNrm.z, X(nb + 6) * aNrm.x + X(nb + 7) * aNrm.y + X(nb + 8) * aNrm.z)) : vec3(0.0, 0.0, 1.0);
  vec4 c;
  if (uProjType == 0) c = vec4(uProj[0] * wp.x + uProj[1] * wp.z, uProj[2] * wp.y + uProj[3] * wp.z, uProj[4] * wp.z + uProj[5], -wp.z);
  else c = vec4(uProj[0] * wp.x + uProj[1], uProj[2] * wp.y + uProj[3], uProj[4] * wp.z + uProj[5], 1.0);
  vec3 nd = c.xyz / c.w;
  float wx = uVp[3] - 342.0 + uVp[0] * nd.x, wy = uVp[4] - 342.0 + uVp[1] * nd.y;
  float dz = clamp((uVp[5] + uVp[2] * nd.z) / 16777215.0, 0.0, 1.0);
  gl_Position = vec4((wx / 320.0 - 1.0) * c.w, (1.0 - wy / 264.0) * c.w, (dz * 2.0 - 1.0) * c.w, c.w);
  vec4 vc0 = (mask & 8) != 0 ? aCol0 : vec4(1.0);
  vec4 vc1 = (mask & 16) != 0 ? aCol1 : vc0;
  vCol0 = vec4(lit(uChan.x, vc0, uMat[0], uAmb[0], wp, n).rgb, lit(uChan.z, vc0, uMat[0], uAmb[0], wp, n).a);
  vCol1 = vec4(lit(uChan.y, vc1, uMat[1], uAmb[1], wp, n).rgb, lit(uChan.w, vc1, uMat[1], uAmb[1], wp, n).a);
  vec3 t[8];
  for (int i = 0; i < 8; i++) {
    t[i] = vec3(0.0, 0.0, 1.0);
    if (i >= uVC.y) continue;
    int info = uTg[i].x, post = uTg[i].y;
    int proj = (info >> 1) & 1, abc1 = (info >> 2) & 1, type = (info >> 4) & 7, row = (info >> 7) & 31;
    vec4 src = vec4(0.0, 0.0, 1.0, 1.0);
    if (row == 0) src = vec4(aPos, 1.0);
    else if (row == 1) src = vec4((mask & 2) != 0 ? aNrm : vec3(0.0, 0.0, 1.0), 1.0);
    else if (row == 3) src = vec4((mask & 4) != 0 ? aTan : vec3(0.0), 1.0);
    else if (row == 4) src = vec4((mask & 4) != 0 ? aBin : vec3(0.0), 1.0);
    else if (row >= 5 && row <= 12) src = (mask & (32 << (row - 5))) != 0 ? vec4(texIn(row - 5), 1.0, 1.0) : vec4(0.0, 0.0, 1.0, 1.0);
    if (abc1 == 0 && row != 0 && row != 1) src = vec4(src.xy, 1.0, 1.0);
    if (type == 0) {
      int m = tmi(i);
      vec3 r = vec3(dot(R(m), src), dot(R(m + 1), src), proj != 0 ? dot(R(m + 2), src) : 1.0);
      if (uVC.z != 0) {
        if ((post & 0x100) != 0) r = normalize(r);
        int pm2 = 0x140 + (post & 63); vec4 tt = vec4(r, 1.0);
        r = vec3(dot(R(pm2), tt), dot(R(pm2 + 1), tt), dot(R(pm2 + 2), tt));
      }
      t[i] = r;
    } else if (type == 1) { int sg = (info >> 12) & 7; for (int k = 0; k < 8; k++) if (k == sg) t[i] = t[k]; }
    else t[i] = vec3(type == 2 ? vCol0.rg : vCol1.rg, 1.0);
  }
  vTex0 = t[0]; vTex1 = t[1]; vTex2 = t[2]; vTex3 = t[3]; vTex4 = t[4]; vTex5 = t[5]; vTex6 = t[6]; vTex7 = t[7];
}`;
    const smp = (fn, a) => [...Array(8).keys()].map((i) => `  if (m == ${i}) return ${fn}(uS${i}, ${a});`).join('\n');
    const fs = `#version 300 es
precision highp float; precision highp int;
in vec4 vCol0, vCol1;
${[...Array(8).keys()].map((i) => `in vec3 vTex${i};`).join('\n')}
uniform sampler2D uS0, uS1, uS2, uS3, uS4, uS5, uS6, uS7;
uniform vec4 uReg[4]; uniform vec4 uKonst[4]; uniform vec2 uAlphaRef;
uniform vec2 uTexDim[8]; uniform ivec4 uIndMtx[6]; uniform vec2 uIndScale[4]; uniform int uTexScl[8]; uniform int uTexNear[8];
uniform ivec4 uSt[16]; uniform ivec4 uFx; uniform ivec4 uSwap[4];
out vec4 oColor;
vec2 tc(vec3 t) { return t.xy / (t.z == 0.0 ? 1.0 : t.z); }
vec3 TC(int i) { if (i == 0) return vTex0; if (i == 1) return vTex1; if (i == 2) return vTex2; if (i == 3) return vTex3; if (i == 4) return vTex4; if (i == 5) return vTex5; if (i == 6) return vTex6; return vTex7; }
vec4 smp(int m, vec2 uv) {
${smp('texture', 'uv')}
  return vec4(1.0);
}
vec4 fet(int m, ivec2 p) {
${smp('texelFetch', 'p, 0')}
  return vec4(1.0);
}
int dot3(ivec3 a, ivec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
vec4 swz(vec4 v, ivec4 s) { return vec4(v[s.x], v[s.y], v[s.z], v[s.w]); }
vec3 konstC(int k) {
  if (k < 8) return vec3(float(8 - k) / 8.0); if (k < 12) return vec3(0.0); if (k < 16) return uKonst[k - 12].rgb;
  if (k < 20) return vec3(uKonst[k - 16].r); if (k < 24) return vec3(uKonst[k - 20].g); if (k < 28) return vec3(uKonst[k - 24].b); return vec3(uKonst[k - 28].a);
}
float konstA(int k) {
  if (k < 8) return float(8 - k) / 8.0; if (k < 16) return 0.0;
  if (k < 20) return uKonst[k - 16].r; if (k < 24) return uKonst[k - 20].g; if (k < 28) return uKonst[k - 24].b; return uKonst[k - 28].a;
}
float pk16(vec3 v) { return v.g * 256.0 + v.r; }
float pk24(vec3 v) { return v.b * 65536.0 + v.g * 256.0 + v.r; }
void main() {
  vec4 rg[4]; rg[0] = uReg[0]; rg[1] = uReg[1]; rg[2] = uReg[2]; rg[3] = uReg[3];
  vec2 tcf[8], tcc[8];
  vec2 o = (floor(gl_FragCoord.xy / ${SC}) + 0.5) * ${SC} - gl_FragCoord.xy;
  for (int i = 0; i < 8; i++) { vec2 cc = tc(TC(i)); tcf[i] = cc; tcc[i] = cc + dFdx(cc) * o.x + dFdy(cc) * o.y; }
  int nst = uFx.x, nind = uFx.y, iref = uFx.z;
  ivec3 iind[4];
  for (int i = 0; i < 4; i++) {
    iind[i] = ivec3(0);
    if (i >= nind) continue;
    int ir = (iref >> (6 * i)) & 63, map = ir & 7, crd = (ir >> 3) & 7;
    ivec2 dm = ivec2(uTexDim[map]); ivec2 p = ivec2(floor(tcc[crd] * uIndScale[i] * uTexDim[map] + 0.001));
    p = ((p % dm) + dm) % dm; iind[i] = ivec3(fet(map, p * uTexScl[map] + uTexScl[map] / 2).abg * 255.0 + 0.5);
  }
  ivec2 tevcoord = ivec2(0);
  int lastC = 0, lastA = 0;
  for (int s = 0; s < 16; s++) {
    if (s >= nst) break;
    int ce = uSt[s].x, ae = uSt[s].y, tr = uSt[s].z & 0xFFF, ks = uSt[s].z >> 12, ind = uSt[s].w;
    int tmap = tr & 7, tcoord = (tr >> 3) & 7, ten = (tr >> 6) & 1, chn = (tr >> 7) & 7;
    ivec4 rsw = uSwap[ae & 3], tsw = uSwap[(ae >> 2) & 3];
    int bt = ind & 3, ifmt = (ind >> 2) & 3, ibias = (ind >> 4) & 7, mid = (ind >> 9) & 15, sw = (ind >> 13) & 7, tw = (ind >> 16) & 7, fb = (ind >> 20) & 1;
    bool indActive = ind != 0 && (mid != 0 || sw != 0 || tw != 0 || fb != 0 || bt < nind);
    vec4 tex = vec4(1.0);
    if (ten != 0 && indActive) {
      ivec2 fuv = ivec2(floor(tcc[tcoord] * uTexDim[tmap] * 128.0 + 0.05));
      ivec3 ic = ivec3(0);
      if (bt < nind) {
        int msk = ifmt == 0 ? 0xFF : ifmt == 1 ? 0x1F : ifmt == 2 ? 0x0F : 0x07;
        for (int k = 0; k < 4; k++) if (k == bt) ic = iind[k] & msk;
        int add = ifmt == 0 ? -128 : 1;
        if ((ibias & 1) != 0) ic.x += add; if ((ibias & 2) != 0) ic.y += add; if ((ibias & 4) != 0) ic.z += add;
      }
      ivec2 it = ivec2(0);
      if (mid >= 1 && mid <= 3) {
        int k = 2 * (mid - 1);
        it = ivec2(dot3(uIndMtx[k].xyz, ic), dot3(uIndMtx[k + 1].xyz, ic)) >> 3;
        int sh = uIndMtx[k].w; it = sh >= 0 ? it << sh : it >> (-sh);
      } else if ((mid >= 5 && mid <= 7) || (mid >= 9 && mid <= 11)) {
        int k = 2 * ((mid & 3) - 1);
        it = (fuv * (mid <= 7 ? ic.xx : ic.yy)) >> 8;
        int sh = uIndMtx[k].w; it = sh >= 0 ? it << sh : it >> (-sh);
      }
      int ws = sw == 1 ? 256 : sw == 2 ? 128 : sw == 3 ? 64 : sw == 4 ? 32 : sw == 5 ? 16 : sw == 6 ? -1 : 0;
      int wt = tw == 1 ? 256 : tw == 2 ? 128 : tw == 3 ? 64 : tw == 4 ? 32 : tw == 5 ? 16 : tw == 6 ? -1 : 0;
      int wx = ws == 0 ? fuv.x : ws < 0 ? 0 : (fuv.x & (ws * 128 - 1));
      int wy = wt == 0 ? fuv.y : wt < 0 ? 0 : (fuv.y & (wt * 128 - 1));
      tevcoord = ivec2(wx, wy) + it + (fb != 0 ? tevcoord : ivec2(0));
      if (ws == 0 && wt == 0 && fb == 0 && uTexNear[tmap] == 0) tex = swz(smp(tmap, tcf[tcoord] + vec2(it) / (128.0 * uTexDim[tmap])), tsw);
      else { ivec2 dm = ivec2(uTexDim[tmap]); ivec2 p = tevcoord >> 7; p = ((p % dm) + dm) % dm; tex = swz(fet(tmap, p * uTexScl[tmap] + uTexScl[tmap] / 2), tsw); }
    } else if (ten != 0) tex = swz(smp(tmap, tcf[tcoord]), tsw);
    vec4 ras = swz(chn == 0 ? vCol0 : chn == 1 ? vCol1 : vec4(0.0), rsw);
    vec3 kc = konstC(ks & 31); float ka = konstA((ks >> 5) & 31);
    vec3 ci[16];
    ci[0] = rg[0].rgb; ci[1] = rg[0].aaa; ci[2] = rg[1].rgb; ci[3] = rg[1].aaa; ci[4] = rg[2].rgb; ci[5] = rg[2].aaa; ci[6] = rg[3].rgb; ci[7] = rg[3].aaa;
    ci[8] = tex.rgb; ci[9] = tex.aaa; ci[10] = ras.rgb; ci[11] = ras.aaa; ci[12] = vec3(1.0); ci[13] = vec3(0.5); ci[14] = kc; ci[15] = vec3(0.0);
    float ai[8];
    ai[0] = rg[0].a; ai[1] = rg[1].a; ai[2] = rg[2].a; ai[3] = rg[3].a; ai[4] = tex.a; ai[5] = ras.a; ai[6] = ka; ai[7] = 0.0;
    vec3 cd = ci[ce & 15], cc = ci[(ce >> 4) & 15], cb = ci[(ce >> 8) & 15], ca = ci[(ce >> 12) & 15];
    int cbias = (ce >> 16) & 3, cop = (ce >> 18) & 1, cclamp = (ce >> 19) & 1, cscale = (ce >> 20) & 3, cdest = (ce >> 22) & 3;
    float ad = ai[(ae >> 4) & 7], ac = ai[(ae >> 7) & 7], ab = ai[(ae >> 10) & 7], aa = ai[(ae >> 13) & 7];
    int abias = (ae >> 16) & 3, aop = (ae >> 18) & 1, aclamp = (ae >> 19) & 1, ascale = (ae >> 20) & 3, adest = (ae >> 22) & 3;
    vec3 cres; float ares;
    if (cbias == 3) {
      int cmp = cop | (cscale << 1);
      vec3 A = clamp(ca, 0.0, 1.0), B = clamp(cb, 0.0, 1.0); vec3 cond;
      if (cmp == 0) cond = vec3(A.r > B.r ? 1.0 : 0.0);
      else if (cmp == 1) cond = vec3(abs(A.r - B.r) < 0.002 ? 1.0 : 0.0);
      else if (cmp == 2) cond = vec3(pk16(A) > pk16(B) ? 1.0 : 0.0);
      else if (cmp == 3) cond = vec3(abs(pk16(A) - pk16(B)) < 0.5 ? 1.0 : 0.0);
      else if (cmp == 4) cond = vec3(pk24(A) > pk24(B) ? 1.0 : 0.0);
      else if (cmp == 5) cond = vec3(abs(pk24(A) - pk24(B)) < 0.5 ? 1.0 : 0.0);
      else if (cmp == 6) cond = vec3(greaterThan(A, B));
      else cond = vec3(lessThan(abs(A - B), vec3(0.002)));
      cres = clamp(cd + cond * cc, 0.0, 1.0);
    } else {
      float bs = cbias == 1 ? 0.5 : cbias == 2 ? -0.5 : 0.0, sc = cscale == 1 ? 2.0 : cscale == 2 ? 4.0 : cscale == 3 ? 0.5 : 1.0;
      vec3 m = mix(clamp(ca, 0.0, 1.0), clamp(cb, 0.0, 1.0), clamp(cc, 0.0, 1.0));
      vec3 e = (cd + (cop != 0 ? -m : m) + bs) * sc;
      cres = cclamp != 0 ? clamp(e, 0.0, 1.0) : clamp(e, -4.0, 4.0);
    }
    if (abias == 3) {
      int cmp = aop | (ascale << 1);
      float A = clamp(aa, 0.0, 1.0), B = clamp(ab, 0.0, 1.0);
      float cond = (cmp == 0 || cmp == 2 || cmp == 4 || cmp == 6) ? (A > B ? 1.0 : 0.0) : (abs(A - B) < 0.002 ? 1.0 : 0.0);
      ares = clamp(ad + cond * ac, 0.0, 1.0);
    } else {
      float bs = abias == 1 ? 0.5 : abias == 2 ? -0.5 : 0.0, sc = ascale == 1 ? 2.0 : ascale == 2 ? 4.0 : ascale == 3 ? 0.5 : 1.0;
      float m = mix(clamp(aa, 0.0, 1.0), clamp(ab, 0.0, 1.0), clamp(ac, 0.0, 1.0));
      float e = (ad + (aop != 0 ? -m : m) + bs) * sc;
      ares = aclamp != 0 ? clamp(e, 0.0, 1.0) : clamp(e, -4.0, 4.0);
    }
    rg[cdest].rgb = cres; rg[adest].a = ares;
    lastC = cdest; lastA = adest;
  }
  vec4 outc = vec4(clamp(rg[lastC].rgb, 0.0, 1.0), clamp(rg[lastA].a, 0.0, 1.0));
  int at = uFx.w, c0 = at & 7, c1 = (at >> 3) & 7, logic = (at >> 6) & 3;
  bool t0 = c0 == 0 ? false : c0 == 1 ? outc.a < uAlphaRef.x : c0 == 2 ? abs(outc.a - uAlphaRef.x) < 0.002 : c0 == 3 ? outc.a <= uAlphaRef.x + 0.002 : c0 == 4 ? outc.a > uAlphaRef.x : c0 == 5 ? abs(outc.a - uAlphaRef.x) >= 0.002 : c0 == 6 ? outc.a >= uAlphaRef.x - 0.002 : true;
  bool t1 = c1 == 0 ? false : c1 == 1 ? outc.a < uAlphaRef.y : c1 == 2 ? abs(outc.a - uAlphaRef.y) < 0.002 : c1 == 3 ? outc.a <= uAlphaRef.y + 0.002 : c1 == 4 ? outc.a > uAlphaRef.y : c1 == 5 ? abs(outc.a - uAlphaRef.y) >= 0.002 : c1 == 6 ? outc.a >= uAlphaRef.y - 0.002 : true;
  bool pass = logic == 0 ? (t0 && t1) : logic == 1 ? (t0 || t1) : logic == 2 ? (t0 != t1) : (t0 == t1);
  if (!pass) discard;
  oColor = outc;
}`;
    const p = this.link(vs, fs);
    const pr = { p, u: null, texUsed: 0xFF, ready: false, uber: true };
    this.syncFinish(pr);
    for (const n of ['uVC', 'uChan', 'uTg', 'uSt', 'uFx', 'uSwap']) pr.u[n] = gl.getUniformLocation(p, n);
    return pr;
  }
  syncFinish(pr) { const s = this.syncCompile; this.syncCompile = true; try { this.finishProgram(pr); } finally { this.syncCompile = s; } }
  // configuration uniforms of the ubershader for the current registers
  setUberUniforms(pr, mask) {
    const gl = this.gl, bp = this.bp, xf = this.xfRaw, u = pr.u, c = pr.c || (pr.c = {});
    const key = this.ver * 65536 + mask;
    if (c.uberKey === key) return;
    c.uberKey = key;
    const gen = bp[0x00], nst = ((gen >> 10) & 15) + 1, nind = (gen >> 16) & 7, ntg = Math.min(8, xf[0x103F] & 15);
    gl.uniform4i(u.uVC, mask, ntg, xf[0x1012] & 1, 0);
    gl.uniform4i(u.uChan, xf[0x100E] | 0, xf[0x100F] | 0, xf[0x1010] | 0, xf[0x1011] | 0);
    const tg = new Int32Array(32);
    for (let i = 0; i < 8; i++) { tg[4 * i] = xf[0x1040 + i] | 0; tg[4 * i + 1] = xf[0x1050 + i] | 0; }
    gl.uniform4iv(u.uTg, tg);
    const st = new Int32Array(64);
    for (let s = 0; s < 16; s++) {
      const tref = (bp[0x28 + (s >> 1)] >> ((s & 1) * 12)) & 0xFFF;
      const ksel = bp[0xF6 + (s >> 1)] >> ((s & 1) ? 14 : 4);
      st[4 * s] = bp[0xC0 + 2 * s] & 0xFFFFFF; st[4 * s + 1] = bp[0xC1 + 2 * s] & 0xFFFFFF;
      st[4 * s + 2] = tref | ((ksel & 31) << 12) | (((ksel >> 5) & 31) << 17);
      st[4 * s + 3] = this.debugNoInd ? 0 : bp[0x10 + s] & 0x1FFFFF;
    }
    gl.uniform4iv(u.uSt, st);
    const ac = bp[0xF3];
    gl.uniform4i(u.uFx, nst, nind, bp[0x27] & 0xFFFFFF, ((ac >> 16) & 7) | (((ac >> 19) & 7) << 3) | (((ac >> 22) & 3) << 6));
    const sw = new Int32Array(16);
    for (let t = 0; t < 4; t++) { const a = bp[0xF6 + 2 * t], b = bp[0xF7 + 2 * t]; sw[4 * t] = a & 3; sw[4 * t + 1] = (a >> 2) & 3; sw[4 * t + 2] = b & 3; sw[4 * t + 3] = (b >> 2) & 3; }
    gl.uniform4iv(u.uSwap, sw);
  }

  // build a program from a saved register state (shader cache warm-up at start-up)
  warm(st) {
    const sbp = this.bp, sxf = this.xfRaw;
    const bp = new Uint32Array(256), xf = new Uint32Array(sxf.length);
    bp.set(st.subarray(1, 257)); xf.set(st.subarray(257, 257 + 0x60), 0x1000);
    this.bp = bp; this.xfRaw = xf; this.warming = true;
    let pr = null;
    try { pr = this.program(st[0]); } catch (e) { /* ignore broken entries */ }
    this.bp = sbp; this.xfRaw = sxf; this.warming = false;
    return pr;
  }
  // Drivers (ANGLE on Windows above all) finish a program only at its first draw: the vertex input layout and
  // render target formats pick the final machine code. So every warmed program is also used once, as soon as
  // its compile is done, for a degenerate triangle into a 1x1 target with the same formats as the EFB and
  // vertex arrays with the same formats as the real ones. Returns false while it is still compiling.
  prime(pr, mask) {
    const gl = this.gl;
    if (pr.primed) return true;
    if (!pr.ready && !this.finishProgram(pr)) return false;
    if (!this.primeFB) {
      this.primeFB = gl.createFramebuffer(); this.primeTex = this.makeTex(1, 1);
      this.primeDepth = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, this.primeDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, 1, 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.primeFB);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.primeTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.primeDepth);
      this.primeBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.primeBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(4096), gl.STATIC_DRAW);
      this.primeVaos = new Map();
    }
    let vao = this.primeVaos.get(mask);
    if (!vao) {
      let stride = 12;
      if (mask & 2) stride += mask & 4 ? 36 : 12;
      if (mask & 8) stride += 4; if (mask & 16) stride += 4;
      for (let i = 0; i < 8; i++) if (mask & (32 << i)) stride += 8;
      if (mask & 0x2000) stride += 12;
      vao = gl.createVertexArray(); gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.primeBuf);
      let o = 0;
      const attr = (loc, size, type, norm, isInt) => { gl.enableVertexAttribArray(loc); if (isInt) gl.vertexAttribIPointer(loc, size, type, stride, o); else gl.vertexAttribPointer(loc, size, type, norm, stride, o); };
      attr(0, 3, gl.FLOAT, false); o += 12;
      if (mask & 2) { attr(1, 3, gl.FLOAT, false); o += 12; if (mask & 4) { attr(2, 3, gl.FLOAT, false); o += 12; attr(3, 3, gl.FLOAT, false); o += 12; } }
      if (mask & 8) { attr(4, 4, gl.UNSIGNED_BYTE, true); o += 4; }
      if (mask & 16) { attr(5, 4, gl.UNSIGNED_BYTE, true); o += 4; }
      for (let i = 0; i < 8; i++) if (mask & (32 << i)) { attr(6 + i, 2, gl.FLOAT, false); o += 8; }
      if (mask & 0x2000) { attr(14, 4, gl.UNSIGNED_BYTE, false, true); o += 4; attr(15, 4, gl.UNSIGNED_BYTE, false, true); o += 8; }
      this.primeVaos.set(mask, vao);
    } else gl.bindVertexArray(vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.primeFB); gl.viewport(0, 0, 1, 1); gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(pr.p);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    this.invalidate();
    pr.primed = true;
    return true;
  }
  // collect a compiled program; false while the driver is still compiling it in the background
  finishProgram(pr) {
    const gl = this.gl;
    if (!pr.p) return false;
    if (this.parallel && !this.syncCompile && !gl.getProgramParameter(pr.p, this.parallel.COMPLETION_STATUS_KHR)) return false;
    this.checkLink(pr.p);
    const u = {};
    for (const n of ['uTexNear', 'uTexScl', 'uTexDim', 'uIndMtx', 'uIndScale', 'uProj', 'uProjType', 'uVp', 'uMtxA', 'uMtxB', 'uMtxC', 'uAmb', 'uMat', 'uReg', 'uKonst', 'uAlphaRef', 'uFogColor', 'uS0', 'uS1', 'uS2', 'uS3', 'uS4', 'uS5', 'uS6', 'uS7'])
      u[n] = gl.getUniformLocation(pr.p, n);
    const bi = gl.getUniformBlockIndex(pr.p, 'XF');
    if (bi !== gl.INVALID_INDEX) gl.uniformBlockBinding(pr.p, bi, 0);
    pr.u = u; pr.ready = true;
    return true;
  }
}
GXRenderer.PENDING = { p: null, u: null, texUsed: 0, ready: false };
self.GXRenderer = GXRenderer;
