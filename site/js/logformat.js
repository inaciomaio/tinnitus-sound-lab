// Log file format: parsing, migration, merging and serialisation.
// Pure module (no DOM) so it runs in the browser and under `node --test`.
//
// Supported inputs (see docs/LOG_FORMAT.md):
//   - schema v2 JSON  { format: "tinnitus-sound-lab-log", schemaVersion: 2, ... }
//   - schema v1 JSON  a bare array of sessions, or { sessions: [...] } without a format id
//   - v1 CSV          the "Export CSV" file from the original prototype
//   - v2 CSV          same columns as v1 plus id and updatedAt

export const FORMAT_ID = "tinnitus-sound-lab-log";
export const SCHEMA_VERSION = 2;

/** Column order for CSV export. The first 18 columns are exactly the v1 prototype's. */
export const CSV_COLUMNS = [
  "t", "pitch", "carrier", "offset", "rate", "depth", "edge", "mix", "bw", "vol",
  "durationSec", "before", "after", "locBefore", "locAfter", "pitchShift", "returnSec", "notes",
  "id", "updatedAt",
];

const NUMERIC = new Set([
  "pitch", "carrier", "offset", "rate", "depth", "edge", "mix", "bw", "vol",
  "durationSec", "before", "after", "returnSec",
]);
const TEXT = new Set(["locBefore", "locAfter", "pitchShift", "notes"]);

export class LogFormatError extends Error {
  constructor(message) { super(message); this.name = "LogFormatError"; }
}

/** Default id for a session that lacks one: derived from its timestamp, so re-importing the same v1 file is idempotent. */
export function idFor(t) {
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? "s-" + ms : "s-" + Math.random().toString(36).slice(2, 12);
}

/** Coerce one raw session (from any version) into the canonical v2 shape. Unknown fields are kept. */
export function normalizeSession(raw) {
  if (!raw || typeof raw !== "object") throw new LogFormatError("A session entry is not an object.");
  const out = { ...raw };
  delete out.kind; // prototype-internal marker
  const t = raw.t ?? raw.time ?? raw.date;
  if (!t || !Number.isFinite(Date.parse(t))) throw new LogFormatError("A session has no valid time (t).");
  out.t = new Date(Date.parse(t)).toISOString();
  for (const k of NUMERIC) {
    if (raw[k] === undefined || raw[k] === null || raw[k] === "") { out[k] = null; continue; }
    const n = Number(raw[k]);
    out[k] = Number.isFinite(n) ? n : null;
  }
  for (const k of TEXT) out[k] = raw[k] == null ? "" : String(raw[k]);
  out.id = raw.id ? String(raw.id) : idFor(out.t);
  out.updatedAt = raw.updatedAt && Number.isFinite(Date.parse(raw.updatedAt))
    ? new Date(Date.parse(raw.updatedAt)).toISOString()
    : out.t;
  return out;
}

/** An empty v2 document. */
export function emptyLog() {
  return { format: FORMAT_ID, schemaVersion: SCHEMA_VERSION, sessions: [], tombstones: {}, settings: null, settingsUpdatedAt: null };
}

/** Bring any supported JSON value up to the current schema. Returns { log, warnings, sourceFormat }. */
export function migrate(value) {
  const warnings = [];
  if (Array.isArray(value)) {
    return { log: { ...emptyLog(), sessions: value.map(normalizeSession) }, warnings, sourceFormat: "v1 JSON" };
  }
  if (!value || typeof value !== "object") throw new LogFormatError("This file isn't a session log.");

  let version = value.format === FORMAT_ID ? Number(value.schemaVersion) : 1;
  if (value.format && value.format !== FORMAT_ID) throw new LogFormatError(`Unknown log format "${value.format}".`);
  if (!Array.isArray(value.sessions)) throw new LogFormatError("This file has no sessions list.");
  if (!Number.isInteger(version) || version < 1) version = 1;
  if (version > SCHEMA_VERSION) {
    warnings.push(`This log was written by a newer version of the app (schema ${version}). Known fields were imported; newer fields were kept but may not be shown.`);
  }

  const log = emptyLog();
  log.sessions = value.sessions.map(normalizeSession);
  if (version >= 2) {
    log.tombstones = sanitizeTombstones(value.tombstones);
    if (value.settings && typeof value.settings === "object") {
      log.settings = { ...value.settings };
      log.settingsUpdatedAt = validIso(value.settingsUpdatedAt);
    }
  } else if (value.settings && typeof value.settings === "object") {
    log.settings = { ...value.settings };
  }
  return { log, warnings, sourceFormat: version >= 2 ? `v${version} JSON` : "v1 JSON" };
}

function validIso(v) { return v && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null; }
function sanitizeTombstones(t) {
  const out = {};
  if (t && typeof t === "object") for (const [id, at] of Object.entries(t)) { const iso = validIso(at); if (iso) out[id] = iso; }
  return out;
}

/** RFC 4180 CSV parser: quoted fields, escaped quotes, commas and newlines inside quotes, CRLF. */
export function parseCSV(text) {
  const rows = []; let row = []; let field = ""; let i = 0; let quoted = false;
  text = text.replace(/^﻿/, "");
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field === "") { quoted = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ""));
}

function fromCSV(text) {
  const rows = parseCSV(text);
  if (!rows.length) throw new LogFormatError("The CSV file is empty.");
  const header = rows[0].map(h => h.trim());
  if (!header.includes("t")) throw new LogFormatError('The CSV file has no "t" (time) column.');
  const sessions = rows.slice(1).map(r => {
    const o = {}; header.forEach((h, idx) => { if (h) o[h] = r[idx] ?? ""; });
    return normalizeSession(o);
  });
  const isV2 = header.includes("id");
  return { log: { ...emptyLog(), sessions }, warnings: [], sourceFormat: isV2 ? "v2 CSV" : "v1 CSV" };
}

/** Parse any supported log file's text. Returns { log, warnings, sourceFormat }. */
export function parseLogFile(text) {
  const trimmed = String(text).replace(/^﻿/, "").trimStart();
  if (!trimmed) throw new LogFormatError("The file is empty.");
  if (trimmed[0] === "{" || trimmed[0] === "[") {
    let value;
    try { value = JSON.parse(trimmed); } catch { throw new LogFormatError("The file looks like JSON but couldn't be read."); }
    return migrate(value);
  }
  return fromCSV(trimmed);
}

/**
 * Merge two logs. Sessions are unioned by id; the newer updatedAt wins.
 * A tombstone removes a session unless the session was edited after the deletion.
 * Settings: the side with the newer settingsUpdatedAt wins.
 */
export function mergeLogs(a, b) {
  const out = emptyLog();
  const tomb = { ...a.tombstones };
  for (const [id, at] of Object.entries(b.tombstones || {})) if (!tomb[id] || at > tomb[id]) tomb[id] = at;
  const byId = new Map();
  for (const s of [...(a.sessions || []), ...(b.sessions || [])]) {
    const prev = byId.get(s.id);
    if (!prev || s.updatedAt > prev.updatedAt) byId.set(s.id, s);
  }
  out.sessions = [...byId.values()]
    .filter(s => !(tomb[s.id] && tomb[s.id] >= s.updatedAt))
    .sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0));
  out.tombstones = tomb;
  const aT = a.settingsUpdatedAt || "", bT = b.settingsUpdatedAt || "";
  const pick = bT > aT ? b : a.settings ? a : b;
  out.settings = pick.settings ?? null;
  out.settingsUpdatedAt = pick.settingsUpdatedAt ?? null;
  return out;
}

/** Count how many sessions in `incoming` are new relative to `current`. */
export function countNew(current, incoming) {
  const have = new Set(current.sessions.map(s => s.id));
  return incoming.sessions.filter(s => !have.has(s.id)).length;
}

/** Serialise to the current JSON format. */
export function serializeLog(log, appVersion) {
  return JSON.stringify({
    format: FORMAT_ID,
    schemaVersion: SCHEMA_VERSION,
    appVersion: appVersion || null,
    exportedAt: new Date().toISOString(),
    settings: log.settings ?? null,
    settingsUpdatedAt: log.settingsUpdatedAt ?? null,
    tombstones: log.tombstones || {},
    sessions: log.sessions,
  }, null, 2);
}

/** CSV export. v1-compatible column order with id and updatedAt appended. */
export function toCSV(sessions) {
  const q = v => { v = v == null ? "" : String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const sorted = [...sessions].sort((a, b) => (a.t < b.t ? -1 : 1));
  return [CSV_COLUMNS.join(",")].concat(sorted.map(s => CSV_COLUMNS.map(c => q(s[c])).join(","))).join("\n") + "\n";
}
