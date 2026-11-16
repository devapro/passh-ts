// The rollback record (spec §4.10, storage.md §7): `<state>/revisions.json`, its format, the
// lenient reading of hand-edited files, updates under `revisions.lock`, and the check at open.

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { errorf, T, type PasshError } from "../i18n/index.ts";
import { acquireLock, cleanLeftovers, createTempFile, fsyncDir, fsyncFd, mkdirs, osError, rename, writeAll } from "../fsx/index.ts";
import { parseJSON, type JValue } from "../model/json.ts";
import { civilFromDays, daysFromCivil, MAX_TIME, MIN_TIME, ZERO_TIME, type Time } from "../model/index.ts";
import { compareUTF8, foldEquals } from "../util/unicode.ts";
import type { CommandIO } from "../util/io.ts";
import { errRollbackDeclined } from "./errors.ts";
import { faultPoint, nowMs, vaultTestHooks } from "./hooks.ts";
import type { RollbackMode, RollbackReport } from "./types.ts";

// ---------------------------------------------------------------------------
// Times (storage.md §7.1: read as vault-format.md §4.1, kept with their offset and fraction)

/** A time of the record as read: kept with its fraction and offset, so it is rewritten as read. */
export interface RecordTime {
  /** Whole seconds since the epoch, UTC (truncated). */
  sec: number;
  /** Nanoseconds within the second (only the first 9 fraction digits count). */
  nsec: number;
  /** The offset in seconds east of UTC (0 for `Z`). */
  offset: number;
}

/** A record time from a data Time (UTC, whole seconds). */
export function recordTime(t: Time): RecordTime {
  return { sec: t, nsec: 0, offset: 0 };
}

const ZERO: RecordTime = { sec: ZERO_TIME, nsec: 0, offset: 0 };

function digitsAt(s: string, i: number, n: number): number {
  let v = 0;
  for (let k = 0; k < n; k++) {
    const c = s.charCodeAt(i + k);
    if (!(c >= 0x30 && c <= 0x39)) return -1;
    v = v * 10 + (c - 0x30);
  }
  return v;
}

function isDigit(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c >= 0x30 && c <= 0x39;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Parses a record time with the grammar of vault-format.md §4.1 (a one-digit hour, `,` before
 * the fraction and an offset minute of 60 accepted, as passh's reader does). Returns undefined
 * for a bad or out-of-range time.
 *
 * Audit #33 (proposed fix implemented): an offset hour of 24 is refused here, so the record
 * reads as damaged (and is replaced at the next update) instead of making every later update
 * fail; passh v0.6 reads it and then can't write it.
 */
export function parseRecordTime(s: string): RecordTime | undefined {
  if (s.length < 10) return undefined;
  const y = digitsAt(s, 0, 4);
  if (y < 0 || s[4] !== "-") return undefined;
  const mo = digitsAt(s, 5, 2);
  if (mo < 0 || s[7] !== "-") return undefined;
  const d = digitsAt(s, 8, 2);
  if (d < 0 || s[10] !== "T") return undefined;
  if (mo < 1 || mo > 12) return undefined;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = mo === 2 && leap ? 29 : MONTH_DAYS[mo - 1]!;
  if (d < 1 || d > dim) return undefined;
  let i = 11;
  if (!isDigit(s, i)) return undefined;
  let h = s.charCodeAt(i) - 0x30;
  i++;
  if (isDigit(s, i)) {
    h = h * 10 + (s.charCodeAt(i) - 0x30);
    i++;
  }
  if (h > 23 || s[i] !== ":") return undefined;
  const mi = digitsAt(s, i + 1, 2);
  if (mi < 0 || mi > 59 || s[i + 3] !== ":") return undefined;
  const sec = digitsAt(s, i + 4, 2);
  if (sec < 0 || sec > 59) return undefined;
  i += 6;
  let nsec = 0;
  if (s[i] === "." || s[i] === ",") {
    i++;
    if (!isDigit(s, i)) return undefined;
    let n = 0;
    let scale = 100_000_000;
    while (isDigit(s, i)) {
      if (n < 9) {
        nsec += (s.charCodeAt(i) - 0x30) * scale;
        scale /= 10;
        n++;
      }
      i++;
    }
  }
  let offset = 0;
  if (s[i] === "Z") {
    i++;
  } else if (s[i] === "+" || s[i] === "-") {
    const oh = digitsAt(s, i + 1, 2);
    // SPEC-GAP / audit #33: an offset hour of 24 makes the record damaged (see above).
    if (oh < 0 || oh > 23 || s[i + 3] !== ":") return undefined;
    const om = digitsAt(s, i + 4, 2);
    if (om < 0 || om > 60) return undefined;
    offset = (oh * 60 + om) * 60 * (s[i] === "-" ? -1 : 1);
    i += 6;
  } else {
    return undefined;
  }
  if (i !== s.length) return undefined;
  const t = daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + sec - offset;
  if (t < MIN_TIME || t > MAX_TIME) return undefined;
  return { sec: t, nsec, offset };
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/**
 * Formats a record time as passh writes it (Go's RFC 3339 with nanoseconds): the time in its
 * own offset, the fraction without trailing zeros, `Z` for a zero offset.
 * `2026-11-15T12:00:00.250+02:00` → `2026-11-15T12:00:00.25+02:00`.
 */
export function formatRecordTime(t: RecordTime): string {
  const local = t.sec + t.offset;
  const days = Math.floor(local / 86400);
  const secs = local - days * 86400;
  const [y, m, d] = civilFromDays(days);
  let s = `${pad(y, 4)}-${pad(m)}-${pad(d)}T${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`;
  if (t.nsec > 0) s += "." + String(t.nsec).padStart(9, "0").replace(/0+$/, "");
  if (t.offset === 0) return s + "Z";
  const o = Math.abs(t.offset) / 60;
  return s + (t.offset < 0 ? "-" : "+") + pad(Math.floor(o / 60)) + ":" + pad(o % 60);
}

/** `YYYY-MM-DD` of a time in UTC. */
export function utcDate(sec: number): string {
  const [y, m, d] = civilFromDays(Math.floor(sec / 86400));
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

// ---------------------------------------------------------------------------
// Reading (storage.md §7.2)

export interface RecordEntry {
  revision: bigint;
  savedAt: RecordTime;
  seenAt: RecordTime;
}

export type RecordRead =
  | { kind: "ok"; vaults: Map<string, RecordEntry> }
  | { kind: "damaged" }
  | { kind: "newer"; version: bigint }
  | { kind: "unreadable"; error: Error };

/** The record's path: `<state>/revisions.json`. */
export function recordPath(state: string): string {
  return join(state, "revisions.json");
}

class TypeErr extends Error {}

const INT64_MAX = (1n << 63n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;

function numberText(b: Uint8Array, v: JValue): string {
  return new TextDecoder().decode(b.subarray(v.start, v.end));
}

/** One member of an object matched to a field name the way Go's encoding/json v1 does (case-insensitive). */
function fieldOf(name: string, fields: readonly string[]): string | undefined {
  for (const f of fields) if (name === f) return f;
  for (const f of fields) if (foldEquals(name, f)) return f;
  return undefined;
}

function decodeTime(v: JValue): RecordTime {
  if (v.kind === "null") return ZERO;
  if (v.kind !== "string") throw new TypeErr("time");
  const t = parseRecordTime(v.str!);
  if (!t) throw new TypeErr("time");
  return t;
}

function decodeEntry(b: Uint8Array, v: JValue): RecordEntry {
  const e: RecordEntry = { revision: 0n, savedAt: ZERO, seenAt: ZERO };
  if (v.kind === "null") return e;
  if (v.kind !== "object") throw new TypeErr("entry");
  for (const m of v.members!) {
    const f = fieldOf(m.name, ["revision", "saved_at", "seen_at"]);
    if (f === "revision") {
      if (m.value.kind === "null") continue;
      if (m.value.kind !== "number") throw new TypeErr("revision");
      const text = numberText(b, m.value);
      if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new TypeErr("revision");
      const r = BigInt(text);
      if (r > UINT64_MAX) throw new TypeErr("revision");
      e.revision = r;
    } else if (f === "saved_at") {
      e.savedAt = decodeTime(m.value);
    } else if (f === "seen_at") {
      e.seenAt = decodeTime(m.value);
    }
  }
  return e;
}

/**
 * Decodes the record's bytes (storage.md §7.2), with passh's leniency for hand-edited files:
 * member names match case-insensitively, the last duplicate wins, duplicate `vaults` objects
 * merge, an entry that is `null` reads as revision 0, unknown members are ignored.
 */
export function decodeRecord(b: Uint8Array): RecordRead {
  let root: JValue;
  try {
    root = parseJSON(b);
  } catch {
    return { kind: "damaged" };
  }
  let version = 0n;
  let vaults: Map<string, RecordEntry> | null = null;
  try {
    if (root.kind === "null") return { kind: "damaged" };
    if (root.kind !== "object") throw new TypeErr("top");
    for (const m of root.members!) {
      const f = fieldOf(m.name, ["version", "vaults"]);
      if (f === "version") {
        if (m.value.kind === "null") continue;
        if (m.value.kind !== "number") throw new TypeErr("version");
        const text = numberText(b, m.value);
        if (!/^-?(0|[1-9][0-9]*)$/.test(text)) throw new TypeErr("version");
        const v = BigInt(text);
        if (v > INT64_MAX || v < -INT64_MAX - 1n) throw new TypeErr("version");
        version = v;
      } else if (f === "vaults") {
        if (m.value.kind === "null") {
          vaults = null;
          continue;
        }
        if (m.value.kind !== "object") throw new TypeErr("vaults");
        if (vaults === null) vaults = new Map();
        for (const vm of m.value.members!) vaults.set(vm.name, decodeEntry(b, vm.value));
      }
    }
  } catch (e) {
    if (e instanceof TypeErr) return { kind: "damaged" };
    throw e;
  }
  if (version < 1n) return { kind: "damaged" };
  if (version > 1n) return { kind: "newer", version };
  return { kind: "ok", vaults: vaults ?? new Map() };
}

/** Reads `<state>/revisions.json` (storage.md §7.2): missing → empty. */
export function readRecord(path: string): RecordRead {
  let b: Uint8Array;
  try {
    b = readFileSync(path);
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return { kind: "ok", vaults: new Map() };
    return { kind: "unreadable", error: osError("open", path, e) };
  }
  return decodeRecord(b);
}

// ---------------------------------------------------------------------------
// Writing (storage.md §7.1)

/**
 * A JSON string with HTML escaping (storage.md §7.1): `"` `\` escaped, `<` `>` `&` as
 * `<` `>` `&`, LF CR TAB BS FF as `\n` `\r` `\t` `\b` `\f`, other U+0000–U+001F
 * as `\u00xx`, U+2028/U+2029 as ` `/` `; DEL and other non-ASCII literal.
 */
export function quoteHTMLJSON(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x22:
        out += '\\"';
        continue;
      case 0x5c:
        out += "\\\\";
        continue;
      case 0x0a:
        out += "\\n";
        continue;
      case 0x0d:
        out += "\\r";
        continue;
      case 0x09:
        out += "\\t";
        continue;
      case 0x08:
        out += "\\b";
        continue;
      case 0x0c:
        out += "\\f";
        continue;
      case 0x3c:
      case 0x3e:
      case 0x26:
      case 0x2028:
      case 0x2029:
        out += "\\u" + c.toString(16).padStart(4, "0");
        continue;
    }
    if (c < 0x20) {
      out += "\\u00" + c.toString(16).padStart(2, "0");
      continue;
    }
    if (c >= 0xd800 && c <= 0xdfff) {
      // A lone surrogate has no UTF-8 form: written as U+FFFD (as Go's encoder does for invalid UTF-8).
      if (c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
        out += s[i]! + s[i + 1]!;
        i++;
      } else out += "�";
      continue;
    }
    out += s[i]!;
  }
  return out + '"';
}

/** The record's file text (storage.md §7.1): two-space indentation, keys sorted by UTF-8 bytes, final LF. */
export function encodeRecord(vaults: Map<string, RecordEntry>): string {
  const keys = [...vaults.keys()].sort(compareUTF8);
  let s = '{\n  "version": 1,\n  "vaults": ';
  if (keys.length === 0) s += "{}";
  else {
    s += "{\n";
    keys.forEach((k, i) => {
      const e = vaults.get(k)!;
      s += `    ${quoteHTMLJSON(k)}: {\n`;
      s += `      "revision": ${e.revision.toString()},\n`;
      s += `      "saved_at": ${quoteHTMLJSON(formatRecordTime(e.savedAt))},\n`;
      s += `      "seen_at": ${quoteHTMLJSON(formatRecordTime(e.seenAt))}\n`;
      s += `    }${i + 1 < keys.length ? "," : ""}\n`;
    });
    s += "  }";
  }
  return s + "\n}\n";
}

// ---------------------------------------------------------------------------
// Updating (storage.md §7.3)

/** `<path> was written by a newer passh (version <n>)`. */
function errNewerRecord(path: string, version: bigint): PasshError {
  return errorf("%s was written by a newer passh (version %d)", path, version);
}

export interface RecordUpdate {
  vaultId: string;
  revision: bigint;
  /** The revision's saved_at (UTC seconds). */
  savedAt: Time;
  /** Set even to a lower revision (the user accepted the rollback question). */
  force?: boolean;
}

/**
 * Updates the record (storage.md §7.3): under `revisions.lock`, read; stop if the vault has a
 * revision ≥ the new one and the update isn't forced; else set the entry (seen_at = now), write
 * a temporary file, fsync, rename, fsync `<state>`. A damaged record is replaced; a newer or
 * unreadable one is never written (thrown). Throws on failure: callers warn `the rollback
 * record wasn't updated: …`.
 */
export async function updateRecord(state: string, u: RecordUpdate): Promise<void> {
  mkdirs(join(state, "locks"));
  const lock = await acquireLock(join(state, "locks", "revisions.lock"), { timeoutMs: vaultTestHooks.lockTimeoutMs });
  try {
    const path = recordPath(state);
    const r = readRecord(path);
    let vaults: Map<string, RecordEntry>;
    switch (r.kind) {
      case "ok":
        vaults = r.vaults;
        break;
      case "damaged":
        vaults = new Map();
        break;
      case "newer":
        throw errNewerRecord(path, r.version);
      case "unreadable":
        throw r.error;
    }
    const cur = vaults.get(u.vaultId);
    if (cur && cur.revision >= u.revision && !u.force) return;
    vaults.set(u.vaultId, { revision: u.revision, savedAt: recordTime(u.savedAt), seenAt: recordTime(Math.floor(nowMs() / 1000)) });
    const text = new TextEncoder().encode(encodeRecord(vaults));
    cleanLeftovers(state, "revisions.json");
    const t = createTempFile(state, "revisions.json");
    try {
      writeAll(t.fd, text, t.path);
      await faultPoint("record-written", t.path);
      fsyncFd(t.fd, t.path);
      await faultPoint("record-synced", t.path);
      rename(t.path, path);
    } catch (e) {
      t.remove();
      throw e;
    }
    t.close();
    await faultPoint("record-renamed", path);
    fsyncDir(state);
  } finally {
    lock.release();
  }
}

/** Updates the record; a failure is the warning `the rollback record wasn't updated: …`. */
export async function updateRecordOrWarn(state: string, u: RecordUpdate, io: CommandIO): Promise<void> {
  try {
    await updateRecord(state, u);
  } catch (e) {
    io.warnOnce(T("the rollback record wasn't updated: %v", e));
  }
}

// ---------------------------------------------------------------------------
// The check at open (storage.md §7.4)

/**
 * `this copy is older than one seen before on this machine (r<rev> of <date>; seen r<recorded>
 * of <recorded date>). If you didn't restore it on purpose, the file may have been replaced.`
 */
export function olderText(rev: bigint, savedAt: number, seen: bigint, seenSavedAt: number): string {
  return T(
    "this copy is older than one seen before on this machine (r%d of %s; seen r%d of %s). If you didn't restore it on purpose, the file may have been replaced.",
    rev,
    utcDate(savedAt),
    seen,
    utcDate(seenSavedAt),
  );
}

export interface RollbackCheck {
  state: string;
  vaultId: string;
  revision: bigint;
  savedAt: Time;
  inBackups: boolean;
  mode: RollbackMode;
  /** config `rollback.warn`. */
  warn: boolean;
  confirmOlder?: (text: string) => Promise<boolean>;
  io: CommandIO;
}

/**
 * The rollback check at open (storage.md §7.4) and the record update that goes with every open
 * (§7.3): returns the comparison with the record as it was before this open. Declining the
 * question throws `stopped: …` (code "rollback-declined"); a prompt error is thrown as is.
 * A damaged, newer or unreadable record gives "unseen" plus its warning (audit #34: current
 * behaviour kept, so `verify --full` says "hasn't seen" although no comparison was made).
 */
export async function checkRollback(c: RollbackCheck): Promise<RollbackReport> {
  const path = recordPath(c.state);
  const r = readRecord(path);
  let vaults: Map<string, RecordEntry> | undefined;
  switch (r.kind) {
    case "ok":
      vaults = r.vaults;
      break;
    case "damaged":
      c.io.warnOnce(T("the rollback record %s is damaged; a new one is started, so older copies aren't detected this time", path));
      vaults = new Map();
      break;
    case "newer":
      c.io.warnOnce(T("the rollback record can't be used, so older copies aren't detected: %v", errNewerRecord(path, r.version)));
      break;
    case "unreadable":
      c.io.warnOnce(T("the rollback record can't be used, so older copies aren't detected: %v", r.error));
      break;
  }
  if (!vaults) return { kind: "unseen" };
  const cur = vaults.get(c.vaultId);
  const update = { vaultId: c.vaultId, revision: c.revision, savedAt: c.savedAt };
  if (!cur) {
    await updateRecordOrWarn(c.state, update, c.io);
    return { kind: "unseen" };
  }
  if (c.revision === cur.revision) return { kind: "same", seen: cur.revision };
  if (c.revision > cur.revision) {
    await updateRecordOrWarn(c.state, update, c.io);
    return { kind: "newer", seen: cur.revision };
  }
  const report: RollbackReport = { kind: "older", seen: cur.revision, seenSavedAt: cur.savedAt.sec };
  if (c.mode === "report" || c.inBackups || !c.warn) return report;
  const text = olderText(c.revision, c.savedAt, cur.revision, cur.savedAt.sec);
  if (!c.confirmOlder) {
    c.io.warnOnce(text);
    return report;
  }
  if (!(await c.confirmOlder(text))) throw errRollbackDeclined();
  await updateRecordOrWarn(c.state, { ...update, force: true }, c.io);
  return report;
}
