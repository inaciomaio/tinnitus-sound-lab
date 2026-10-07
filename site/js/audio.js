// Web Audio engine.
//
// Signal path:
//   sine osc ──► toneGain ─┐
//   noise ─► bp ─► bp ─► noiseGain ─┴─► src ─┬─► gainL ─┐
//                                            └─► gainR ─┴─► merger ─► master ─► limiter ─► out
//   mod osc (alternation rate) ─► waveshaper (switch shape) ─► depth ─┬─► gainL.gain (+)
//                                                                     └─► invert ─► gainR.gain (−)
// Each ear's gain is 0.5 ± 0.5·depth·shape(sin(2π·rate·t)). Depth 1 with a hard
// shape gives a full 1/0 swap; depth 0 gives a steady sound at 0.5 in both ears.

import { clamp } from "./util.js";

export const LEVEL_MIN_DB = -80;
export const LEVEL_MAX_DB = -15; // hard cap

const dbToGain = db => Math.pow(10, clamp(db, LEVEL_MIN_DB, LEVEL_MAX_DB) / 20);

/** Waveshaper curve: e=0 passes the sine through (smooth pan), e=1 is a sign function (hard switch). */
function shapeCurve(e) {
  const n = 2049, a = new Float32Array(n);
  const hard = e >= 0.995, k = 0.01 + Math.pow(e, 3) * 120;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    a[i] = hard ? Math.sign(x) : Math.tanh(k * x) / Math.tanh(k);
  }
  return a;
}

/** Biquad Q for a bandwidth in octaves. */
const qFromBw = b => { const p = Math.pow(2, b); return Math.sqrt(p) / (p - 1); };

export class Engine {
  constructor() { this.ctx = null; this.n = null; this.mode = null; this.lastEdge = -1; }

  get playing() { return !!this.mode; }

  _build() {
    const c = this.ctx, sr = c.sampleRate;
    const osc = c.createOscillator(); osc.type = "sine";

    // 4 s of Gaussian noise (σ = 0.25), looped.
    const len = sr * 4, buf = c.createBuffer(1, len, sr), d = buf.getChannelData(0);
    for (let i = 0; i < len; i += 2) {
      const u = Math.random() || 1e-9, v = Math.random(), r = Math.sqrt(-2 * Math.log(u));
      d[i] = 0.25 * r * Math.cos(2 * Math.PI * v);
      if (i + 1 < len) d[i + 1] = 0.25 * r * Math.sin(2 * Math.PI * v);
    }
    const noise = c.createBufferSource(); noise.buffer = buf; noise.loop = true;
    const bp1 = c.createBiquadFilter(), bp2 = c.createBiquadFilter(); bp1.type = bp2.type = "bandpass";

    const toneG = c.createGain(), noiseG = c.createGain(), src = c.createGain();
    osc.connect(toneG); noise.connect(bp1); bp1.connect(bp2); bp2.connect(noiseG);
    toneG.connect(src); noiseG.connect(src);

    const gL = c.createGain(), gR = c.createGain(); gL.gain.value = 0.5; gR.gain.value = 0.5;
    src.connect(gL); src.connect(gR);

    const mod = c.createOscillator(); mod.type = "sine";
    const shaper = c.createWaveShaper(), depthG = c.createGain(), inv = c.createGain();
    inv.gain.value = -1; depthG.gain.value = 0;
    mod.connect(shaper); shaper.connect(depthG); depthG.connect(gL.gain); depthG.connect(inv); inv.connect(gR.gain);

    const merger = c.createChannelMerger(2); gL.connect(merger, 0, 0); gR.connect(merger, 0, 1);
    const master = c.createGain(); master.gain.value = 0;
    const lim = c.createDynamicsCompressor();
    lim.threshold.value = -6; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.05;
    merger.connect(master); master.connect(lim); lim.connect(c.destination);

    const split = c.createChannelSplitter(2), aL = c.createAnalyser(), aR = c.createAnalyser();
    aL.fftSize = aR.fftSize = 256; lim.connect(split); split.connect(aL, 0); split.connect(aR, 1);

    osc.start(); noise.start(); mod.start();
    this.n = { osc, bp1, bp2, toneG, noiseG, mod, shaper, depthG, master, aL, aR, sr };
  }

  /** Gain that makes band-limited noise roughly match the tone's RMS. */
  _noiseComp(f, bw) {
    const enbw = 0.785 * f / qFromBw(bw), nyq = this.n.sr / 2;
    return clamp(0.707 / (0.25 * Math.sqrt(Math.min(1, enbw / nyq))), 1, 60);
  }

  /**
   * p = { carrier Hz, rate Hz, depth 0–1, edge 0–1, mix 0–1 (1 = tone), bw octaves, vol dBFS }
   */
  apply(p) {
    const n = this.n; if (!n) return;
    const t = this.ctx.currentTime, k = 0.015;
    const f = clamp(p.carrier, 20, Math.min(20000, n.sr / 2 - 100));
    n.osc.frequency.setTargetAtTime(f, t, k);
    n.bp1.frequency.setTargetAtTime(f, t, k); n.bp2.frequency.setTargetAtTime(f, t, k);
    const q = qFromBw(p.bw); n.bp1.Q.setTargetAtTime(q, t, k); n.bp2.Q.setTargetAtTime(q, t, k);
    n.mod.frequency.setTargetAtTime(p.rate, t, k);
    n.depthG.gain.setTargetAtTime(0.5 * p.depth, t, k);
    if (p.edge !== this.lastEdge) { n.shaper.curve = shapeCurve(p.edge); this.lastEdge = p.edge; }
    n.toneG.gain.setTargetAtTime(p.mix, t, k);
    n.noiseG.gain.setTargetAtTime((1 - p.mix) * this._noiseComp(f, p.bw), t, k);
    if (this.mode) n.master.gain.setTargetAtTime(dbToGain(p.vol), t, k);
  }

  async play(mode, p) {
    if (!this.ctx) { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); this._build(); }
    await this.ctx.resume();
    this.mode = mode;
    this.apply(p);
    const g = this.n.master.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setTargetAtTime(dbToGain(p.vol), this.ctx.currentTime, 0.01);
  }

  /** ~20 ms fade-out. */
  stop() {
    if (!this.n || !this.mode) { this.mode = null; return; }
    this.mode = null;
    const g = this.n.master.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setTargetAtTime(0, this.ctx.currentTime, 0.006);
  }
}
