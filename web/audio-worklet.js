// audio-worklet.js - plays the 32 kHz stereo stream mixed by runtime/ax.c from the shared ring.
// The game produces audio in bursts (whenever its audio interrupt runs), so we keep 120-400 ms buffered and
// speed up / slow down playback slightly to stay near that level instead of stopping on every gap. When the
// buffer still runs dry (a slow PC, a heavy scene), the buffer target grows so it does not happen again.
class RghAudio extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = opts.processorOptions;
    this.buf = o.memory.buffer; this.ring = new Int16Array(this.buf, o.ring, o.len * 2); this.len = o.len;
    this.w = new Int32Array(this.buf, o.wpos, 1); this.r = new Int32Array(this.buf, o.rpos, 1);
    this.ratio = 32000 / sampleRate;           // source samples per output sample
    this.target = 3840;                         // 120 ms at 32 kHz (grows up to 400 ms after underruns)
    this.calm = 0;
    this.started = false; this.frac = 0; this.gain = 0; this.lastL = 0; this.lastR = 0;
    this.st = { n: 0, sq: 0, dry: 0, drop: 0, buf: 0 };   // once a second to the page: level, underruns, drops
  }
  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0];
    let r = Atomics.load(this.r, 0) >>> 0; const w = Atomics.load(this.w, 0) >>> 0;
    let avail = (w - r) >>> 0;
    if (avail > this.len) { r = (w - this.target) >>> 0; avail = this.target; }
    if (!this.started) {
      if (avail < this.target * 0.75) { for (let i = 0; i < L.length; i++) { this.lastL *= 0.995; this.lastR *= 0.995; L[i] = this.lastL; R[i] = this.lastR; } return true; }
      this.started = true;
    }
    if (avail > this.target * 4) { r = (w - this.target) >>> 0; avail = this.target; this.st.drop++; }    // far behind: drop the backlog
    const step = this.ratio * (1 + Math.max(-0.08, Math.min(0.04, (avail - this.target) / this.target * 0.08)));
    let frac = this.frac;
    for (let i = 0; i < L.length; i++) {
      if (avail < 2) {                          // ran dry: fade out instead of clicking, then re-buffer
        if (this.started) { this.st.dry++; this.target = Math.min(12800, this.target + 1280); this.calm = 0; } this.lastL *= 0.99; this.lastR *= 0.99; L[i] = this.lastL; R[i] = this.lastR; this.started = false; continue;
      }
      const k0 = (r % this.len) * 2, k1 = ((r + 1) % this.len) * 2;
      const l = (this.ring[k0] + (this.ring[k1] - this.ring[k0]) * frac) / 32768;
      const rr = (this.ring[k0 + 1] + (this.ring[k1 + 1] - this.ring[k0 + 1]) * frac) / 32768;
      L[i] = l; R[i] = rr; this.lastL = l; this.lastR = rr;
      frac += step;
      while (frac >= 1) { frac -= 1; r = (r + 1) >>> 0; avail--; }
    }
    this.frac = frac;
    Atomics.store(this.r, 0, r | 0);
    const st = this.st;
    for (let i = 0; i < L.length; i += 4) st.sq += L[i] * L[i];
    st.n += L.length / 4; st.buf = avail;
    if (st.n >= sampleRate / 4) {
      this.port.postMessage({ rms: Math.round(Math.sqrt(st.sq / st.n) * 32768), dry: st.dry, drop: st.drop, buf: Math.round(st.buf / 32), target: Math.round(this.target / 32) });
      st.n = 0; st.sq = 0; st.dry = 0; st.drop = 0;
      if (++this.calm > 20 && this.target > 3840) this.target -= 32;   // quiet for a while: shrink the buffer again
    }
    return true;
  }
}
registerProcessor('rgh-audio', RghAudio);
