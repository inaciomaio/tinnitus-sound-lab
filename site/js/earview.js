// Live top-down head view: ear levels from the per-channel analysers, plus a dot for where the sound sits.
import { clamp } from "./util.js";

export function startEarView(canvas, engine, getVolDb) {
  const g = canvas.getContext("2d");
  const buf = new Float32Array(256);
  let smL = 0, smR = 0;
  const rms = a => { a.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / buf.length); };

  function frame() {
    const cs = getComputedStyle(document.documentElement), col = n => cs.getPropertyValue(n).trim();
    let l = 0, r = 0;
    if (engine.n && engine.playing) { l = rms(engine.n.aL); r = rms(engine.n.aR); }
    const ref = Math.pow(10, getVolDb() / 20) * 0.75 || 1e-6;
    l = clamp(l / ref, 0, 1); r = clamp(r / ref, 0, 1);
    smL += (l - smL) * 0.5; smR += (r - smR) * 0.5;

    const W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2 + 6;
    g.clearRect(0, 0, W, H);
    g.lineWidth = 3; g.strokeStyle = col("--line");
    g.beginPath(); g.ellipse(cx, cy, 92, 108, 0, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(cx - 12, cy - 106); g.lineTo(cx, cy - 128); g.lineTo(cx + 12, cy - 106); g.stroke();
    g.fillStyle = col("--muted"); g.font = "600 20px " + col("--f-mono"); g.textAlign = "center";
    g.fillText("L", cx - 200, cy + 80); g.fillText("R", cx + 200, cy + 80);

    for (const [s, v, c] of [[-1, smL, col("--left")], [1, smR, col("--right")]]) {
      const ex = cx + s * 104;
      g.fillStyle = c; g.globalAlpha = 0.18 + 0.82 * v;
      g.beginPath(); g.ellipse(ex, cy, 14, 30, 0, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
      for (let i = 1; i <= 3; i++) {
        g.strokeStyle = c; g.globalAlpha = v * (1 - i / 4); g.lineWidth = 4; g.beginPath();
        g.arc(ex + s * 6, cy, 30 + i * 26, s < 0 ? Math.PI * 0.72 : -Math.PI * 0.28, s < 0 ? Math.PI * 1.28 : Math.PI * 0.28);
        g.stroke();
      }
      g.globalAlpha = 1; g.fillStyle = c;
      g.fillRect(s < 0 ? cx - 232 : cx + 212, cy + 40 - 80 * v, 20, 80 * v + 0.01);
    }
    const tot = smL + smR;
    if (tot > 0.04) {
      const pan = (smR - smL) / tot;
      g.fillStyle = col("--accent"); g.beginPath(); g.arc(cx + pan * 70, cy, 10, 0, Math.PI * 2); g.fill();
    } else {
      g.fillStyle = col("--muted"); g.font = "400 18px " + col("--f-mono"); g.fillText("silent", cx, cy + 6);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
