import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseLogFile, serializeLog, toCSV, mergeLogs, emptyLog, normalizeSession, countNew,
  SCHEMA_VERSION, FORMAT_ID, LogFormatError, CSV_COLUMNS,
} from "../site/js/logformat.js";

const fixture = name => readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8");

test("reads the v1 prototype CSV export, including quotes, commas and newlines in notes", () => {
  const { log, sourceFormat } = parseLogFile(fixture("v1-prototype-export.csv"));
  assert.equal(sourceFormat, "v1 CSV");
  assert.equal(log.sessions.length, 2);
  const [a, b] = log.sessions;
  assert.equal(a.notes, 'went quiet, then came back from the "left"');
  assert.equal(b.notes, "line one\nline two");
  assert.equal(a.returnSec, 74);
  assert.equal(b.carrier, 6727);
  assert.equal(typeof a.rate, "number");
  assert.match(a.id, /^s-\d+$/);
  assert.equal(a.updatedAt, a.t);
});

test("re-importing the same v1 CSV gives the same ids (idempotent)", () => {
  const one = parseLogFile(fixture("v1-prototype-export.csv")).log;
  const two = parseLogFile(fixture("v1-prototype-export.csv")).log;
  assert.deepEqual(one.sessions.map(s => s.id), two.sessions.map(s => s.id));
  assert.equal(mergeLogs(one, two).sessions.length, 2);
});

test("reads a v1 JSON array and drops the prototype's internal kind field", () => {
  const { log, sourceFormat } = parseLogFile(fixture("v1-sessions.json"));
  assert.equal(sourceFormat, "v1 JSON");
  assert.equal(log.sessions[0].id, "s-1791403000000");
  assert.equal("kind" in log.sessions[0], false);
});

test("v2 JSON round-trips sessions, settings and tombstones", () => {
  const src = parseLogFile(fixture("v1-prototype-export.csv")).log;
  src.settings = { pitch: 6000, vol: -50 };
  src.settingsUpdatedAt = "2026-10-07T21:00:00.000Z";
  src.tombstones = { "s-1": "2026-10-07T21:00:00.000Z" };
  const text = serializeLog(src, "1.0.0");
  const parsed = JSON.parse(text);
  assert.equal(parsed.format, FORMAT_ID);
  assert.equal(parsed.schemaVersion, SCHEMA_VERSION);
  const back = parseLogFile(text);
  assert.equal(back.sourceFormat, "v2 JSON");
  assert.deepEqual(back.log.sessions, src.sessions);
  assert.deepEqual(back.log.settings, src.settings);
  assert.deepEqual(back.log.tombstones, src.tombstones);
});

test("CSV export keeps the v1 column order and reads back as v2 CSV", () => {
  assert.deepEqual(CSV_COLUMNS.slice(0, 18), fixture("v1-prototype-export.csv").split("\n")[0].split(","));
  const src = parseLogFile(fixture("v1-prototype-export.csv")).log;
  const back = parseLogFile(toCSV(src.sessions));
  assert.equal(back.sourceFormat, "v2 CSV");
  assert.deepEqual(back.log.sessions, src.sessions);
});

test("merge: newer edit wins, tombstones delete, later edit survives an older delete", () => {
  const base = normalizeSession({ id: "s-a", t: "2026-10-01T10:00:00Z", returnSec: 10 });
  const edited = { ...base, returnSec: 20, updatedAt: "2026-10-02T10:00:00.000Z" };
  const a = { ...emptyLog(), sessions: [base] };
  const b = { ...emptyLog(), sessions: [edited] };
  assert.equal(mergeLogs(a, b).sessions[0].returnSec, 20);
  assert.equal(mergeLogs(b, a).sessions[0].returnSec, 20);

  const deleted = { ...emptyLog(), tombstones: { "s-a": "2026-10-01T12:00:00.000Z" } };
  assert.equal(mergeLogs(a, deleted).sessions.length, 0);
  assert.equal(mergeLogs(b, deleted).sessions.length, 1, "edit after deletion keeps the session");
  assert.equal(mergeLogs(a, deleted).tombstones["s-a"], "2026-10-01T12:00:00.000Z");
});

test("merge: newer settings win", () => {
  const a = { ...emptyLog(), settings: { vol: -50 }, settingsUpdatedAt: "2026-10-01T00:00:00.000Z" };
  const b = { ...emptyLog(), settings: { vol: -40 }, settingsUpdatedAt: "2026-10-02T00:00:00.000Z" };
  assert.equal(mergeLogs(a, b).settings.vol, -40);
  assert.equal(mergeLogs(b, a).settings.vol, -40);
  assert.equal(mergeLogs(a, emptyLog()).settings.vol, -50);
});

test("a log from a newer schema imports with a warning and keeps unknown fields", () => {
  const text = JSON.stringify({ format: FORMAT_ID, schemaVersion: SCHEMA_VERSION + 1, sessions: [{ id: "x", t: "2026-10-01T00:00:00Z", futureField: 7 }] });
  const { log, warnings } = parseLogFile(text);
  assert.equal(warnings.length, 1);
  assert.equal(log.sessions[0].futureField, 7);
});

test("countNew counts only sessions not already present", () => {
  const cur = parseLogFile(fixture("v1-prototype-export.csv")).log;
  const inc = parseLogFile(fixture("v1-sessions.json")).log;
  assert.equal(countNew(cur, inc), 1);
  assert.equal(countNew(cur, cur), 0);
});

test("rejects files that aren't logs, with readable messages", () => {
  assert.throws(() => parseLogFile(""), LogFormatError);
  assert.throws(() => parseLogFile("{not json"), /couldn't be read/);
  assert.throws(() => parseLogFile('{"format":"something-else","sessions":[]}'), /Unknown log format/);
  assert.throws(() => parseLogFile("a,b\n1,2"), /no "t"/);
  assert.throws(() => parseLogFile('[{"t":"not a date"}]'), /no valid time/);
});
