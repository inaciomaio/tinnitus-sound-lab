// Local persistence of the log in localStorage, in the current schema.
// Also picks up data left by the single-file prototype (keys tsl.sessions / tsl.settings).

import { emptyLog, migrate, mergeLogs, serializeLog, normalizeSession } from "./logformat.js";

const KEY = "tsl.log.v2";
const LEGACY_SESSIONS = "tsl.sessions";
const LEGACY_SETTINGS = "tsl.settings";

function read(key) { try { return localStorage.getItem(key); } catch { return null; } }
function write(key, val) { try { localStorage.setItem(key, val); return true; } catch { return false; } }

export class LocalStore {
  constructor() {
    this.log = emptyLog();
    this.listeners = new Set();
    this.persistent = true;
  }

  load() {
    const raw = read(KEY);
    if (raw) {
      try { this.log = migrate(JSON.parse(raw)).log; } catch { this.log = emptyLog(); }
    }
    this._absorbLegacy();
    return this.log;
  }

  _absorbLegacy() {
    const s = read(LEGACY_SESSIONS), st = read(LEGACY_SETTINGS);
    if (!s && !st) return;
    try {
      const legacy = emptyLog();
      if (s) legacy.sessions = JSON.parse(s).map(normalizeSession);
      if (st && !this.log.settings) { legacy.settings = JSON.parse(st); legacy.settingsUpdatedAt = null; }
      this.log = mergeLogs(this.log, legacy);
      this.save();
      localStorage.removeItem(LEGACY_SESSIONS); localStorage.removeItem(LEGACY_SETTINGS);
    } catch { /* leave legacy keys alone if they can't be read */ }
  }

  save() { this.persistent = write(KEY, serializeLog(this.log)); }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(reason) { for (const fn of this.listeners) fn(this.log, reason); }

  get sessions() { return this.log.sessions; }

  addSession(session) {
    const s = normalizeSession(session);
    this.log = mergeLogs(this.log, { ...emptyLog(), sessions: [s] });
    this.save(); this._emit("add");
    return s;
  }

  deleteSession(id) {
    this.log = mergeLogs(this.log, { ...emptyLog(), tombstones: { [id]: new Date().toISOString() } });
    this.save(); this._emit("delete");
  }

  setSettings(settings) {
    this.log = { ...this.log, settings: { ...settings }, settingsUpdatedAt: new Date().toISOString() };
    this.save(); this._emit("settings");
  }

  /** Merge another log in (import or sync). */
  merge(other, reason) {
    this.log = mergeLogs(this.log, other);
    this.save(); this._emit(reason || "merge");
  }
}
