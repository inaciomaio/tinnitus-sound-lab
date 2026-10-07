// Optional Google Drive sync.
//
// Uses Google Identity Services (token model) with the `drive.file` scope, so the
// app can only see files it created. The log lives in one JSON file in the user's
// Drive. Each sync downloads it, merges with the local log, and uploads the result.
// No server is involved; the access token stays in memory for this page.

import { parseLogFile, serializeLog, emptyLog, mergeLogs } from "./logformat.js";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const GIS_SRC = "https://accounts.google.com/gsi/client";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const DRIVE_FILE_NAME = "tinnitus-sound-lab-log.json";

const K_CONNECTED = "tsl.drive.connected";
const K_FILE = "tsl.drive.fileId";
const K_LAST = "tsl.drive.lastSync";

const ls = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del: k => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

class AuthNeeded extends Error {}

let gisPromise = null;
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = GIS_SRC; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new Error("Couldn't load Google sign-in. Check your connection or content blockers.")); };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

export class DriveSync {
  /**
   * @param {{clientId: string, appVersion: string, onStatus: (s: object) => void}} opts
   */
  constructor({ clientId, appVersion, onStatus }) {
    this.clientId = clientId || "";
    this.appVersion = appVersion;
    this.onStatus = onStatus || (() => {});
    this.token = null; this.expiresAt = 0;
    this.tokenClient = null;
    this.busy = null; this.again = false;
  }

  get configured() { return !!this.clientId; }
  get wasConnected() { return ls.get(K_CONNECTED) === "1"; }
  get hasToken() { return !!this.token && Date.now() < this.expiresAt - 60_000; }
  get lastSync() { return ls.get(K_LAST); }

  _status(state, message) { this.onStatus({ state, message, lastSync: this.lastSync }); }

  async _requestToken(prompt) {
    await loadGis();
    if (!this.tokenClient) {
      this.tokenClient = window.google.accounts.oauth2.initTokenClient({ client_id: this.clientId, scope: SCOPE, callback: () => {} });
    }
    return new Promise((resolve, reject) => {
      this.tokenClient.callback = resp => {
        if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
        if (!window.google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) { reject(new Error("Drive access wasn't granted.")); return; }
        this.token = resp.access_token;
        this.expiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
        resolve();
      };
      this.tokenClient.error_callback = err => reject(new Error(err?.type === "popup_closed" ? "Sign-in window was closed." : "Sign-in failed. Allow pop-ups for this site and try again."));
      this.tokenClient.requestAccessToken({ prompt });
    });
  }

  /** Must be called from a click: opens Google's consent pop-up. */
  async connect(localLog) {
    if (!this.configured) throw new Error("Drive sync isn't configured on this copy of the site.");
    this._status("working", "Connecting to Google Drive…");
    try {
      await this._requestToken(this.wasConnected ? "" : "consent");
    } catch (e) { this._status(this.wasConnected ? "paused" : "off", e.message); throw e; }
    ls.set(K_CONNECTED, "1");
    return this.sync(localLog);
  }

  async disconnect() {
    const t = this.token;
    this.token = null; this.expiresAt = 0;
    ls.del(K_CONNECTED); ls.del(K_FILE); ls.del(K_LAST);
    if (t && window.google?.accounts?.oauth2) { try { window.google.accounts.oauth2.revoke(t, () => {}); } catch { /* ignore */ } }
    this._status("off", "Disconnected. Your file stays in Google Drive.");
  }

  async _api(url, init = {}) {
    if (!this.hasToken) throw new AuthNeeded();
    const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: "Bearer " + this.token } });
    if (res.status === 401) { this.token = null; throw new AuthNeeded(); }
    if (res.status === 403 || res.status === 429 || res.status >= 500) {
      const body = await res.text().catch(() => "");
      throw new Error(`Google Drive returned ${res.status}. ${body.includes("rateLimit") ? "Too many requests; try again shortly." : "Try again later."}`);
    }
    return res;
  }

  async _findFile() {
    const known = ls.get(K_FILE);
    if (known) {
      const r = await this._api(`${API}/files/${encodeURIComponent(known)}?fields=id,trashed`);
      if (r.ok) { const j = await r.json(); if (!j.trashed) return known; }
      ls.del(K_FILE);
    }
    const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
    const r = await this._api(`${API}/files?q=${q}&spaces=drive&orderBy=modifiedTime desc&fields=files(id,modifiedTime)&pageSize=1`);
    if (!r.ok) throw new Error("Couldn't search Google Drive.");
    const j = await r.json();
    const id = j.files?.[0]?.id || null;
    if (id) ls.set(K_FILE, id);
    return id;
  }

  async _download(id) {
    const r = await this._api(`${API}/files/${encodeURIComponent(id)}?alt=media`);
    if (!r.ok) throw new Error("Couldn't download the log from Google Drive.");
    return r.text();
  }

  async _upload(id, text) {
    if (id) {
      const r = await this._api(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: text,
      });
      if (r.ok) return id;
      if (r.status !== 404) throw new Error("Couldn't upload the log to Google Drive.");
      ls.del(K_FILE);
    }
    const boundary = "tsl" + Math.random().toString(36).slice(2);
    const meta = { name: DRIVE_FILE_NAME, mimeType: "application/json", description: "Tinnitus Sound Lab session log. Safe to download; import it on the website." };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
    const r = await this._api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
    });
    if (!r.ok) throw new Error("Couldn't create the log file in Google Drive.");
    const j = await r.json(); ls.set(K_FILE, j.id); return j.id;
  }

  /**
   * Download, merge with `localLog`, upload. Resolves with the remote log so the
   * caller can merge it locally. Calls during a running sync are coalesced.
   * @param {object|() => object} localLog the log, or a function returning the latest log
   */
  async sync(localLog) {
    const getLocal = typeof localLog === "function" ? localLog : () => localLog;
    if (this.busy) { this.again = true; return this.busy; }
    this.busy = (async () => {
      let remote = emptyLog();
      try {
        do {
          this.again = false;
          this._status("working", "Syncing with Google Drive…");
          const id = await this._findFile();
          if (id) remote = parseLogFile(await this._download(id)).log;
          const merged = mergeLogs(getLocal(), remote);
          await this._upload(id, serializeLog(merged, this.appVersion));
          remote = merged;
          ls.set(K_LAST, new Date().toISOString());
        } while (this.again);
        this._status("on", "Synced");
        return remote;
      } catch (e) {
        if (e instanceof AuthNeeded) { this._status("paused", "Sign in again to resume syncing."); }
        else { this._status("error", e.message || "Sync failed."); }
        throw e;
      } finally { this.busy = null; }
    })();
    return this.busy;
  }
}
