export const $ = s => document.querySelector(s);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Map a 0–1000 slider position onto a log scale, and back. */
export const logMap = (x, min, max) => min * Math.pow(max / min, x / 1000);
export const logInv = (v, min, max) => Math.round(1000 * Math.log(v / min) / Math.log(max / min));

const NOTES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
/** Nearest musical note with cents deviation, e.g. "F♯8 +12¢". */
export function noteName(f) {
  const m = 69 + 12 * Math.log2(f / 440);
  const r = Math.round(m);
  const c = Math.round((m - r) * 100);
  return NOTES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1) + (c ? ` ${c > 0 ? "+" : ""}${c}¢` : "");
}

export const fmtHz = f => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2) + " kHz" : Math.round(f) + " Hz");
export const fmtT = s => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
export const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Trigger a browser download of a text file. */
export function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function relTime(iso) {
  if (!iso) return "";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return new Date(iso).toLocaleDateString();
}
