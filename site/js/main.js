import { $, clamp, logMap, logInv, noteName, fmtHz, fmtT, esc, downloadText, relTime } from "./util.js";
import { Engine, LEVEL_MIN_DB, LEVEL_MAX_DB } from "./audio.js";
import { startEarView } from "./earview.js";
import { LocalStore } from "./store.js";
import { DriveSync, DRIVE_FILE_NAME } from "./drive.js";
import { parseLogFile, serializeLog, toCSV, countNew, LogFormatError } from "./logformat.js";
import { APP_VERSION } from "./version.js";
import { GOOGLE_CLIENT_ID } from "../config.js";

/* ---------- state ---------- */
const DEFAULTS = { pitch: 6000, matchFreq: 6000, matchType: "tone", offset: 0, rate: 6, depth: 100, edge: 100, mix: 100, bw: 0.5, vol: -50 };
const store = new LocalStore();
store.load();
let S = { ...DEFAULTS, ...(store.log.settings || {}) };
S.vol = clamp(S.vol, LEVEL_MIN_DB, LEVEL_MAX_DB);
const carrierHz = () => S.pitch * Math.pow(2, S.offset / 12);

const engine = new Engine();
let ses = null, tick = null, wake = null, pendingDel = null;

/* ---------- audio ---------- */
function params(mode) {
  if (mode === "match") return { carrier: S.matchFreq, rate: 1, depth: 0, edge: 0, mix: S.matchType === "tone" ? 1 : 0, bw: 0.33, vol: S.vol };
  return { carrier: carrierHz(), rate: S.rate, depth: S.depth / 100, edge: S.edge / 100, mix: S.mix / 100, bw: S.bw, vol: S.vol };
}
async function play(mode) { await engine.play(mode, params(mode)); syncButtons(); }
function stop() { engine.stop(); syncButtons(); }

/* ---------- controls ---------- */
function syncButtons() {
  const m = engine.mode, busy = !!ses;
  $("#matchPlay").textContent = m === "match" ? "Stop" : "Play match";
  $("#matchPlay").classList.toggle("on", m === "match");
  $("#previewBtn").textContent = m === "preview" ? "Stop preview" : "Preview";
  $("#previewBtn").classList.toggle("on", m === "preview");
  $("#matchPlay").disabled = busy; $("#previewBtn").disabled = busy; $("#matchUse").disabled = busy;
  document.querySelectorAll("#genPanel input").forEach(i => { i.disabled = busy || (i.id === "bw" && S.mix === 100); });
  $("#lockNote").hidden = !busy;
}

function syncControls() {
  $("#matchSlider").value = logInv(S.matchFreq, 125, 16000);
  $("#matchHz").innerHTML = Math.round(S.matchFreq) + "<small>Hz</small>";
  $("#matchNote").textContent = noteName(S.matchFreq);
  $("#mTone").setAttribute("aria-pressed", S.matchType === "tone");
  $("#mNoise").setAttribute("aria-pressed", S.matchType !== "tone");
  $("#pitchOut").textContent = Math.round(S.pitch) + " Hz · " + noteName(S.pitch);
  $("#offset").value = S.offset;
  $("#offsetOut").innerHTML = (S.offset > 0 ? "+" : "") + S.offset + " st<small>" + fmtHz(carrierHz()) + "</small>";
  $("#rate").value = logInv(S.rate, 0.5, 40);
  $("#rateOut").innerHTML = S.rate.toFixed(S.rate < 10 ? 1 : 0) + " Hz<small>" + (S.rate * 2).toFixed(S.rate < 10 ? 1 : 0) + " swaps/s</small>";
  $("#depth").value = S.depth;
  $("#depthOut").innerHTML = S.depth + "%<small>" + (S.depth === 100 ? "full 1/0 swap" : S.depth === 0 ? "steady, no swap" : "partial") + "</small>";
  $("#edge").value = S.edge;
  $("#edgeOut").innerHTML = (S.edge >= 100 ? "hard switch" : S.edge <= 0 ? "smooth pan" : S.edge + "% sharp") + "<small>" + (S.edge >= 100 ? "audible clicks" : "") + "</small>";
  $("#mix").value = S.mix;
  $("#mixOut").textContent = S.mix === 100 ? "pure tone" : S.mix === 0 ? "narrow noise" : S.mix + "% tone";
  $("#bw").value = Math.round(S.bw * 100);
  $("#bwOut").textContent = S.bw.toFixed(2) + " oct";
  $("#vol").value = S.vol;
  $("#volOut").innerHTML = S.vol + " dB<small>re full scale</small>";
  syncButtons();
}

let settingsT = null;
function changed() {
  syncControls();
  if (engine.mode) engine.apply(params(engine.mode));
  clearTimeout(settingsT);
  settingsT = setTimeout(() => store.setSettings(S), 600);
}

$("#matchSlider").addEventListener("input", e => { S.matchFreq = logMap(+e.target.value, 125, 16000); changed(); });
const nudge = oct => () => { S.matchFreq = clamp(S.matchFreq * Math.pow(2, oct), 125, 16000); changed(); };
$("#mOctDn").onclick = nudge(-1); $("#mOctUp").onclick = nudge(1);
$("#mStDn").onclick = nudge(-1 / 12); $("#mStUp").onclick = nudge(1 / 12);
$("#mCentDn").onclick = nudge(-0.1 / 12); $("#mCentUp").onclick = nudge(0.1 / 12);
$("#mTone").onclick = () => { S.matchType = "tone"; changed(); };
$("#mNoise").onclick = () => { S.matchType = "noise"; changed(); };
$("#matchPlay").onclick = () => (engine.mode === "match" ? stop() : play("match"));
$("#matchUse").onclick = () => { S.pitch = Math.round(S.matchFreq); changed(); say("Pitch set to " + S.pitch + " Hz. The generator now centres on it."); };
$("#offset").addEventListener("input", e => { S.offset = +e.target.value; changed(); });
$("#rate").addEventListener("input", e => { const v = logMap(+e.target.value, 0.5, 40); S.rate = v < 10 ? Math.round(v * 10) / 10 : Math.round(v); changed(); });
$("#depth").addEventListener("input", e => { S.depth = +e.target.value; changed(); });
$("#edge").addEventListener("input", e => { S.edge = +e.target.value; changed(); });
$("#mix").addEventListener("input", e => { S.mix = +e.target.value; changed(); });
$("#bw").addEventListener("input", e => { S.bw = +e.target.value / 100; changed(); });
$("#vol").addEventListener("input", e => { S.vol = +e.target.value; changed(); });
$("#previewBtn").onclick = () => (engine.mode === "preview" ? stop() : play("preview"));
$("#before").addEventListener("input", e => { $("#beforeOut").textContent = e.target.value + " / 10"; });
$("#after").addEventListener("input", e => { $("#afterOut").textContent = e.target.value + " / 10"; });

let toastT;
function say(msg, where = "#toast") {
  const el = $(where); el.textContent = msg;
  clearTimeout(toastT); toastT = setTimeout(() => { el.textContent = ""; }, 7000);
}

/* ---------- session ---------- */
async function lockScreen() { try { wake = await navigator.wakeLock?.request("screen"); } catch { wake = null; } }
function releaseScreen() { try { wake && wake.release(); } catch { /* ignore */ } wake = null; }

$("#startBtn").onclick = async () => {
  stop();
  ses = {
    phase: "play", t0: performance.now(), planned: +$("#dur").value,
    before: +$("#before").value, locBefore: $("#locBefore").value, returnSec: null,
    p: { pitch: S.pitch, carrier: Math.round(carrierHz()), offset: S.offset, rate: S.rate, depth: S.depth, edge: S.edge, mix: S.mix, bw: S.bw, vol: S.vol },
  };
  $("#stepBefore").hidden = true; $("#stepPlay").hidden = false; $("#stepAfter").hidden = true;
  await play("session"); lockScreen();
  tick = setInterval(onTick, 200); onTick();
};
function onTick() {
  if (!ses) return;
  const now = performance.now();
  if (ses.phase === "play") {
    const el = (now - ses.t0) / 1000;
    $("#countdown").textContent = fmtT(ses.planned - el);
    if (el >= ses.planned) endPlay();
  } else if (ses.phase === "after" && ses.returnSec === null) {
    $("#stopwatch").textContent = fmtT((now - ses.tStop) / 1000);
  }
}
function endPlay() {
  stop();
  ses.phase = "after"; ses.tStop = performance.now(); ses.durationSec = Math.round((ses.tStop - ses.t0) / 1000);
  $("#after").value = ses.before; $("#afterOut").textContent = ses.before + " / 10";
  $("#recordedOut").textContent = ""; $("#notes").value = "";
  $("#stepPlay").hidden = true; $("#stepAfter").hidden = false;
  $("#saveBtn").disabled = true; $("#stopwatch").textContent = "0:00";
  syncButtons();
}
$("#stopEarly").onclick = endPlay;
$("#baselineBtn").onclick = () => {
  if (!ses) return;
  ses.returnSec = Math.round((performance.now() - ses.tStop) / 1000);
  $("#stopwatch").textContent = fmtT(ses.returnSec);
  $("#recordedOut").textContent = "Recorded " + fmtT(ses.returnSec);
  $("#saveBtn").disabled = false;
};
$("#noEffectBtn").onclick = () => {
  if (!ses) return;
  ses.returnSec = 0; $("#stopwatch").textContent = "0:00";
  $("#recordedOut").textContent = "Recorded: no effect"; $("#saveBtn").disabled = false;
};
function endSession() {
  clearInterval(tick); tick = null; ses = null; releaseScreen();
  $("#stepBefore").hidden = false; $("#stepPlay").hidden = true; $("#stepAfter").hidden = true;
  syncButtons();
}
$("#discardBtn").onclick = () => { endSession(); say("Session discarded."); };
$("#saveBtn").onclick = () => {
  if (!ses) return;
  const now = new Date().toISOString();
  const rec = store.addSession({
    id: "s-" + Date.now(), t: now, updatedAt: now, ...ses.p,
    durationSec: ses.durationSec, before: ses.before, after: +$("#after").value,
    locBefore: ses.locBefore, locAfter: $("#locAfter").value, pitchShift: $("#pitchShift").value,
    returnSec: ses.returnSec, notes: $("#notes").value.trim().slice(0, 2000),
  });
  endSession();
  say(rec.after > rec.before
    ? "Saved. Tinnitus was louder afterwards. Avoid these settings."
    : "Saved. Relief lasted " + fmtT(rec.returnSec) + "." + (store.persistent ? "" : " Warning: this browser blocked storage, so the log won't survive a reload. Export it now."));
};

/* ---------- log view ---------- */
const soundLabel = s => (s.mix === 100 ? "tone" : s.mix === 0 ? "noise " + Number(s.bw ?? 0).toFixed(2) + " oct" : s.mix + "% tone");
const edgeLabel = e => (e >= 100 ? "hard" : e <= 0 ? "smooth" : e + "%");
const louder = s => s.after != null && s.before != null && s.after > s.before;

function renderLog() {
  const list = [...store.sessions].sort((a, b) => (a.t < b.t ? -1 : 1));
  const rets = list.map(s => s.returnSec || 0).sort((a, b) => a - b);
  const med = rets.length ? (rets.length % 2 ? rets[(rets.length - 1) / 2] : (rets[rets.length / 2 - 1] + rets[rets.length / 2]) / 2) : 0;
  $("#stats").innerHTML = [
    ["Sessions", list.length],
    ["Longest relief", list.length ? fmtT(rets[rets.length - 1]) : "—"],
    ["Median relief", list.length ? fmtT(med) : "—"],
    ["Louder after", list.filter(louder).length],
  ].map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join("");

  $("#exportJson").disabled = $("#exportCsv").disabled = !list.length;
  if (!list.length) {
    $("#bestBox").innerHTML = ""; $("#chart").innerHTML = "";
    $("#tableWrap").innerHTML = `<div class="empty">No sessions yet. Match your pitch, rate your tinnitus, and press <b>Start session</b>. You can also import a log file you exported earlier, including CSV files from the first version.</div>`;
    return;
  }

  const best = list.filter(s => !louder(s)).reduce((a, b) => ((b.returnSec || 0) > (a ? a.returnSec || 0 : -1) ? b : a), null);
  $("#bestBox").innerHTML = best
    ? `<div class="best"><span>Longest relief so far: <b>${fmtT(best.returnSec)}</b> <code>${esc(fmtHz(best.carrier))} · ${esc(best.rate)} Hz · depth ${esc(best.depth)}% · ${esc(edgeLabel(best.edge))} · ${esc(soundLabel(best))}</code></span><button class="mini" data-load="${esc(best.id)}">Load these settings</button></div>`
    : "";

  // Chart: relief duration per session (last 40).
  const show = list.slice(-40), W = 760, H = 220, pl = 46, pr = 10, pt = 14, pb = 30;
  const max = Math.max(30, ...show.map(s => s.returnSec || 0));
  const step = [10, 15, 30, 60, 120, 300, 600, 1200].find(s => max / s <= 5) || 1800;
  const top = Math.ceil(max / step) * step, bw = (W - pl - pr) / show.length;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Relief duration per session"><title>Relief duration per session</title>`;
  for (let v = 0; v <= top; v += step) {
    const y = pt + (H - pt - pb) * (1 - v / top);
    svg += `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" class="grid"/><text x="${pl - 6}" y="${y + 4}" text-anchor="end" class="axis">${fmtT(v)}</text>`;
  }
  show.forEach((s, i) => {
    const v = s.returnSec || 0, h = (H - pt - pb) * v / top, w = Math.min(36, Math.max(2, bw * 0.7)), x0 = pl + i * bw + (bw - w) / 2;
    svg += `<rect x="${x0}" y="${H - pb - h}" width="${w}" height="${Math.max(h, 1)}" class="${louder(s) ? "bar bad" : "bar"}"><title>${esc(new Date(s.t).toLocaleString())}: ${fmtT(v)}</title></rect>`;
  });
  svg += `<text x="${pl}" y="${H - 8}" class="axis">older</text><text x="${W - pr}" y="${H - 8}" text-anchor="end" class="axis">newest · bars = time until back to baseline · red = louder after</text></svg>`;
  $("#chart").innerHTML = svg;

  const rows = [...list].reverse().map(s => `<tr class="${louder(s) ? "excite" : ""}">
    <td>${esc(new Date(s.t).toLocaleString([], { year: "2-digit", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</td>
    <td class="num">${s.carrier != null ? esc(fmtHz(s.carrier)) : "—"}</td>
    <td class="num">${s.offset > 0 ? "+" : ""}${esc(s.offset ?? "—")} st</td>
    <td class="num">${esc(s.rate ?? "—")} Hz</td>
    <td class="num">${esc(s.depth ?? "—")}%</td>
    <td>${esc(edgeLabel(s.edge))}</td>
    <td>${esc(soundLabel(s))}</td>
    <td class="num">${esc(s.vol ?? "—")} dB</td>
    <td class="num">${fmtT(s.durationSec)}</td>
    <td class="num">${esc(s.before ?? "—")} → ${esc(s.after ?? "—")}</td>
    <td class="num">${fmtT(s.returnSec || 0)}</td>
    <td>${esc(s.locAfter)} · ${esc(s.pitchShift)}</td>
    <td>${louder(s) ? '<span class="tag warn">louder</span>' : s.returnSec ? '<span class="tag ok">relief</span>' : ""}</td>
    <td class="note" title="${esc(s.notes)}">${esc(s.notes && s.notes.length > 40 ? s.notes.slice(0, 40) + "…" : s.notes)}</td>
    <td><button class="mini" data-load="${esc(s.id)}">Load</button> ${pendingDel === s.id
      ? `<button class="mini danger" data-del="${esc(s.id)}">Confirm delete</button>`
      : `<button class="mini" data-askdel="${esc(s.id)}">Delete</button>`}</td></tr>`).join("");
  $("#tableWrap").innerHTML = `<div class="tablebox"><table><thead><tr><th>When</th><th>Carrier</th><th>Offset</th><th>Rate</th><th>Depth</th><th>Switch</th><th>Sound</th><th>Level</th><th>Length</th><th>Loud</th><th>Relief</th><th>After</th><th></th><th>Notes</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

$("#logPanel").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.load) {
    if (ses) { say("Finish the current session first.", "#logMsg"); return; }
    const s = store.sessions.find(x => x.id === b.dataset.load); if (!s) return;
    for (const k of ["pitch", "offset", "rate", "depth", "edge", "mix", "bw", "vol"]) if (s[k] != null) S[k] = s[k];
    S.vol = clamp(S.vol, LEVEL_MIN_DB, LEVEL_MAX_DB);
    changed(); say("Settings loaded into the generator.", "#logMsg");
  }
  if (b.dataset.askdel) { pendingDel = b.dataset.askdel; renderLog(); }
  if (b.dataset.del) { pendingDel = null; store.deleteSession(b.dataset.del); }
});

/* ---------- import / export ---------- */
const stamp = () => new Date().toISOString().slice(0, 10);
$("#exportJson").onclick = () => {
  downloadText(`tinnitus-sound-lab-${stamp()}.json`, serializeLog(store.log, APP_VERSION), "application/json");
  say("Exported the full log as JSON.", "#logMsg");
};
$("#exportCsv").onclick = () => {
  downloadText(`tinnitus-sessions-${stamp()}.csv`, toCSV(store.sessions), "text/csv");
  say("Exported sessions as CSV.", "#logMsg");
};
$("#importBtn").onclick = () => $("#importFile").click();
$("#importFile").addEventListener("change", e => { importFiles([...e.target.files]); e.target.value = ""; });

async function importFiles(files) {
  const parts = [];
  for (const f of files) {
    try {
      const { log, warnings, sourceFormat } = parseLogFile(await f.text());
      const added = countNew(store.log, log);
      store.merge(log, "import");
      parts.push(`${f.name}: ${added} new of ${log.sessions.length} (${sourceFormat})` + (warnings.length ? ". " + warnings.join(" ") : ""));
    } catch (err) {
      parts.push(`${f.name}: ${err instanceof LogFormatError ? err.message : "couldn't be read."}`);
    }
  }
  say("Imported " + parts.join(" · "), "#logMsg");
}

// Drag and drop files onto the log panel.
const logPanel = $("#logPanel");
logPanel.addEventListener("dragover", e => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); logPanel.classList.add("drop"); } });
logPanel.addEventListener("dragleave", e => { if (!logPanel.contains(e.relatedTarget)) logPanel.classList.remove("drop"); });
logPanel.addEventListener("drop", e => { e.preventDefault(); logPanel.classList.remove("drop"); importFiles([...e.dataTransfer.files]); });

/* ---------- Google Drive ---------- */
let driveState = { state: "off", message: "" };
const drive = new DriveSync({
  clientId: GOOGLE_CLIENT_ID, appVersion: APP_VERSION,
  onStatus: s => { driveState = s; renderDrive(); },
});

function renderDrive() {
  const box = $("#drivePanel");
  if (!drive.configured) { box.hidden = true; renderChip(); return; }
  box.hidden = false;
  const st = driveState.state;
  const connected = drive.wasConnected;
  $("#driveConnect").hidden = connected && st !== "paused";
  $("#driveConnect").textContent = connected ? "Sign in to resume" : "Connect Google Drive";
  $("#driveSync").hidden = !connected || st === "paused";
  $("#driveDisconnect").hidden = !connected;
  $("#driveSync").disabled = $("#driveConnect").disabled = st === "working";
  let text;
  if (st === "working") text = driveState.message;
  else if (st === "error") text = driveState.message;
  else if (connected && st === "paused") text = "Sync is paused until you sign in again. Your log is still saved in this browser.";
  else if (connected) text = "Synced " + relTime(drive.lastSync) + `. File: ${DRIVE_FILE_NAME} in your Drive.`;
  else text = driveState.message || "Off. Your log is saved in this browser only.";
  $("#driveStatus").textContent = text;
  $("#driveStatus").className = "drive-status " + st;
  renderChip();
}
function renderChip() {
  const c = $("#storeChip");
  if (drive.configured && drive.wasConnected && drive.hasToken) { c.textContent = "Synced to Google Drive"; c.className = "chip cloud"; }
  else if (drive.configured && drive.wasConnected) { c.textContent = "Drive sync paused"; c.className = "chip warn"; }
  else { c.textContent = store.persistent ? "Saved in this browser" : "Not saved: storage blocked"; c.className = store.persistent ? "chip" : "chip warn"; }
}

async function runSync(connect) {
  try {
    const remote = connect ? await drive.connect(() => store.log) : await drive.sync(() => store.log);
    store.merge(remote, "sync");
  } catch { /* status already shown */ }
}
$("#driveConnect").onclick = () => runSync(true);
$("#driveSync").onclick = () => runSync(false);
$("#driveDisconnect").onclick = async () => { await drive.disconnect(); };

let syncT = null;
store.onChange((log, reason) => {
  if (reason === "sync") { /* came from Drive */ }
  else if (drive.configured && drive.hasToken) { clearTimeout(syncT); syncT = setTimeout(() => runSync(false), 2500); }
  if (reason === "settings") return;
  if (reason === "sync" || reason === "import") {
    const fresh = log.settings ? { ...DEFAULTS, ...log.settings } : S;
    if (!ses && JSON.stringify(fresh) !== JSON.stringify(S)) { S = fresh; syncControls(); }
  }
  renderLog();
});
setInterval(renderDrive, 30_000);

/* ---------- boot ---------- */
$("#appVersion").textContent = "v" + APP_VERSION;
startEarView($("#ears"), engine, () => S.vol);
syncControls();
renderLog();
renderDrive();
