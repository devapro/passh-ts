// The data block's JSON (vault-format.md §4): reading (§4.2), content rules (§4.3),
// validation (§4.4), unknown keys (§4.5) and serialization (§4.6).
//
// Reading order, as the reference reads (verified against reference/passh-go with crafted
// data blocks): the whole input's syntax; the top-level object; then the known members in a
// fixed order (format, version, vault_id, revision, saved_at, entries, deleted; inside an
// entry id, path, password, username, url, tags, fields, notes, created_at, updated_at)
// whatever their order in the input; then content checks of every entry; then vault_id,
// ids and paths, tombstones.
//
// SPEC-GAP: vault-format.md §4.2–§4.4 give the messages but not the order of the checks nor
// the decoding errors' prefixes; both follow the reference as observed: decoding errors read
// `entries: <key>: …` (no position), content errors `entry N: invalid entry: …` and tag errors
// `entry N: invalid tag …` (no `invalid entry:`), a field value `field <key> must be a single
// line` (key unquoted), and the JSON library's texts are Go 1.26's encoding/json (v1 API on
// the v2 implementation: `json: cannot unmarshal … into Go value of type …`, `exceeded max
// depth`, …; not normative).

import { codedError, errorf, PasshError } from "../i18n/index.ts";
import { dedupeTags, normalizeTag, parsePath, pathProblem } from "../paths/index.ts";
import { compareUTF8, foldEquals, hasLoneSurrogate, isDecimalDigit, isLetter, isMark, trimWhiteSpace, utf8Encode } from "../util/unicode.ts";
import { compactRaw, indentCompact, JSONSyntaxError, parseJSON, quoteJSON, type JValue } from "./json.ts";
import { formatTime, nowTime, parseTime } from "./time.ts";
import { ZERO_TIME, type Entry, type Field, type Time, type Tombstone, type Unknowns, type VaultData } from "./types.ts";

export const DATA_FORMAT = "passh-vault-data";
export const DATA_VERSION = 1;
export const MAX_REVISION = (1n << 64n) - 1n;

const TOP_KEYS = new Set(["format", "version", "vault_id", "revision", "saved_at", "entries", "deleted"]);
const ENTRY_KEYS = new Set(["id", "path", "password", "username", "url", "tags", "fields", "notes", "created_at", "updated_at"]);
const FIELD_KEYS = new Set(["key", "value"]);
const TOMBSTONE_KEYS = new Set(["id", "deleted_at"]);

// ---------------------------------------------------------------------------
// Errors

/** `made by a newer passh; upgrade passh (data version)` (code "newer-data"). */
export function newerDataError(): PasshError {
  return codedError("newer-data", "made by a newer passh; upgrade passh (data version)");
}

/** `invalid vault data: <detail>` (code "invalid-data"); storage wraps it in `data is damaged; …`. */
function invalidData(detail: Error): PasshError {
  return codedError("invalid-data", "invalid vault data: %w", detail);
}

/** A decoding error of the JSON library (type mismatch), not translated. */
class JSONTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JSONTypeError";
  }
}

function kindName(v: JValue): string {
  switch (v.kind) {
    case "true":
    case "false":
      return "bool";
    default:
      return v.kind;
  }
}

/** `json: cannot unmarshal <kind> into Go value of type <type>` (the reference library's text). */
function typeError(v: JValue, goType: string): JSONTypeError {
  return new JSONTypeError(`json: cannot unmarshal ${kindName(v)} into Go value of type ${goType}`);
}

function keyed(key: string, e: unknown): PasshError {
  return errorf("%s: %w", key, e);
}

// ---------------------------------------------------------------------------
// Reading

interface Obj {
  /** Members, the last occurrence of each name winning. */
  m: Map<string, JValue>;
}

/** Decodes an object value; null → undefined (the caller decides); other kinds → type error. */
function asObject(v: JValue, goType: string): Obj {
  if (v.kind === "null") throw errorf("expected an object, got null");
  if (v.kind !== "object") throw typeError(v, goType);
  const m = new Map<string, JValue>();
  for (const mem of v.members!) {
    m.delete(mem.name); // keep the last occurrence, at its own position
    m.set(mem.name, mem.value);
  }
  return { m };
}

function unknownsOf(b: Uint8Array, o: Obj, known: Set<string>): Unknowns {
  const u: Unknowns = new Map();
  for (const [name, v] of o.m) if (!known.has(name)) u.set(name, compactRaw(b, v));
  return u;
}

/** A string member: missing or null → "", a string → its value, else a type error. */
function str(o: Obj, key: string): string {
  const v = o.m.get(key);
  if (v === undefined || v.kind === "null") return "";
  if (v.kind !== "string") throw keyed(key, typeError(v, "string"));
  return v.str!;
}

/** A time member: missing or null → the zero time. */
function time(o: Obj, key: string): Time {
  const v = o.m.get(key);
  if (v === undefined || v.kind === "null") return ZERO_TIME;
  if (v.kind !== "string") throw keyed(key, typeError(v, "string"));
  try {
    return parseTime(v.str!);
  } catch (e) {
    throw keyed(key, e);
  }
}

const INT_RE = /^-?(0|[1-9][0-9]*)$/;

function decodeEntry(b: Uint8Array, v: JValue): Entry {
  const o = asObject(v, "map[string]jsontext.Value");
  const id = str(o, "id");
  let path = "";
  const pv = o.m.get("path");
  if (pv !== undefined && pv.kind !== "null") {
    if (pv.kind !== "string") throw keyed("path", new JSONTypeError(`json: cannot unmarshal ${kindName(pv)} into Go value of type paths.Path: JSON value must be string type`));
    try {
      path = parsePath(pv.str!);
    } catch (e) {
      throw keyed("path", e);
    }
  }
  const password = str(o, "password");
  const username = str(o, "username");
  const url = str(o, "url");
  const tags: string[] = [];
  const tv = o.m.get("tags");
  if (tv !== undefined && tv.kind !== "null") {
    if (tv.kind !== "array") throw keyed("tags", typeError(tv, "[]string"));
    tv.items!.forEach((t, i) => {
      if (t.kind === "null") tags.push("");
      else if (t.kind !== "string") throw keyed("tags", new JSONTypeError(`json: cannot unmarshal ${kindName(t)} into .${i} of type string`));
      else tags.push(t.str!);
    });
  }
  const fields: Field[] = [];
  const fv = o.m.get("fields");
  if (fv !== undefined && fv.kind !== "null") {
    if (fv.kind !== "array") throw keyed("fields", typeError(fv, "[]model.Field"));
    for (const item of fv.items!) {
      try {
        const fo = asObject(item, "map[string]jsontext.Value");
        fields.push({ key: str(fo, "key"), value: str(fo, "value"), unknown: unknownsOf(b, fo, FIELD_KEYS) });
      } catch (e) {
        throw keyed("fields", e);
      }
    }
  }
  const notes = str(o, "notes");
  const createdAt = time(o, "created_at");
  const updatedAt = time(o, "updated_at");
  return { id, path, password, username, url, tags: normalizeTagsLenient(tags), fields, notes, createdAt, updatedAt, unknown: unknownsOf(b, o, ENTRY_KEYS) };
}

/**
 * Tags as read: each normalized (NFC, trimmed) and duplicates removed; an invalid tag is kept
 * (normalized as far as possible) so that validation reports it with the entry's position.
 */
function normalizeTagsLenient(tags: string[]): string[] {
  return dedupeTags(tags.map((t) => (hasLoneSurrogate(t) ? t : trimWhiteSpace(t.normalize("NFC")))));
}

function decodeTombstone(b: Uint8Array, v: JValue): Tombstone {
  const o = asObject(v, "map[string]jsontext.Value");
  return { id: str(o, "id"), deletedAt: time(o, "deleted_at"), unknown: unknownsOf(b, o, TOMBSTONE_KEYS) };
}

function decodeList<T>(b: Uint8Array, top: Obj, key: string, goType: string, one: (b: Uint8Array, v: JValue) => T): T[] {
  const v = top.m.get(key);
  if (v === undefined || v.kind === "null") return [];
  try {
    if (v.kind !== "array") throw typeError(v, goType);
    return v.items!.map((item) => one(b, item));
  } catch (e) {
    throw keyed(key, e);
  }
}

/**
 * Reads the data block's plaintext (§4.2) and validates it (§4.4). Throws a PasshError with
 * code "newer-data" (`made by a newer passh; upgrade passh (data version)`) or
 * "invalid-data" (`invalid vault data: <detail>`).
 */
export function parseVaultData(bytes: Uint8Array): VaultData {
  let d: VaultData;
  try {
    d = decodeVaultData(bytes);
  } catch (e) {
    if (e instanceof PasshError && (e.code === "newer-data" || e.code === "invalid-data")) throw e;
    throw invalidData(e instanceof Error ? e : new Error(String(e)));
  }
  const problem = validationProblem(d);
  if (problem) throw invalidData(problem);
  return d;
}

function decodeVaultData(b: Uint8Array): VaultData {
  const root = parseJSON(b); // JSONSyntaxError
  if (root.kind === "null") throw errorf("expected an object, got null");
  if (root.kind !== "object") throw typeError(root, "map[string]jsontext.Value");
  const top = asObject(root, "map[string]jsontext.Value");

  // 1. format, checked first
  const fv = top.m.get("format");
  if (fv === undefined || fv.kind !== "string" || fv.str !== DATA_FORMAT) throw errorf('format is not "passh-vault-data"');

  // 2. version: a plain integer literal read as int64
  const vv = top.m.get("version");
  let version = 0n;
  if (vv === undefined) throw errorf("missing or bad version");
  if (vv.kind !== "null") {
    const text = vv.kind === "number" ? new TextDecoder().decode(b.subarray(vv.start, vv.end)) : "";
    if (!INT_RE.test(text)) throw errorf("missing or bad version");
    version = BigInt(text);
    if (version > (1n << 63n) - 1n || version < -(1n << 63n)) throw errorf("missing or bad version");
  }
  if (version > 1n) throw newerDataError();
  if (version < 1n) throw errorf("unsupported version %d", version);

  // 3. vault_id: missing or not a string → bad; null → "" (validation: missing vault_id)
  const iv = top.m.get("vault_id");
  if (iv === undefined || (iv.kind !== "string" && iv.kind !== "null")) throw errorf("missing or bad vault_id");
  const vaultId = iv.kind === "string" ? iv.str! : "";

  // 4. revision: a plain unsigned integer literal (uint64); null → 0
  const rv = top.m.get("revision");
  let revision = 0n;
  if (rv === undefined) throw errorf("missing or bad revision");
  if (rv.kind !== "null") {
    const text = rv.kind === "number" ? new TextDecoder().decode(b.subarray(rv.start, rv.end)) : "";
    if (!/^(0|[1-9][0-9]*)$/.test(text)) throw errorf("missing or bad revision");
    revision = BigInt(text);
    if (revision > MAX_REVISION) throw errorf("missing or bad revision");
  }

  // 5. the rest
  const savedAt = time(top, "saved_at");
  const entries = decodeList(b, top, "entries", "[]model.Entry", decodeEntry);
  const deleted = decodeList(b, top, "deleted", "[]model.Tombstone", decodeTombstone);
  return { format: DATA_FORMAT, version: DATA_VERSION, vaultId, revision, savedAt, entries, deleted, unknown: unknownsOf(b, top, TOP_KEYS) };
}

/** Reports whether an error is a JSON syntax or type error of the reader. */
export function isJSONError(e: unknown): boolean {
  return e instanceof JSONSyntaxError || e instanceof JSONTypeError;
}

// ---------------------------------------------------------------------------
// Content rules (§4.3) and validation (§4.4)

/** Reports whether a custom field key follows the grammar: a letter or decimal digit, then letters, digits, marks, `_`, `.`, `-`. */
export function isValidFieldKey(key: string): boolean {
  let first = true;
  for (const ch of key) {
    const cp = ch.codePointAt(0)!;
    const ok = isLetter(cp) || isDecimalDigit(cp) || (!first && (isMark(cp) || cp === 0x5f || cp === 0x2e || cp === 0x2d));
    if (!ok) return false;
    first = false;
  }
  return !first;
}

/** Reports whether a key is reserved: `username`, `url` or `tags` in any case (simple case folding). */
export function isReservedFieldKey(key: string): boolean {
  return foldEquals(key, "username") || foldEquals(key, "url") || foldEquals(key, "tags");
}

/**
 * Checks a custom field key (§4.3): `field key "k" is not valid (letters, digits, then also _ . -)`
 * or `"URL" can't be a custom field key`. Returns the error or undefined.
 */
export function fieldKeyProblem(key: string): PasshError | undefined {
  if (!isValidFieldKey(key)) return codedError("invalid-entry", "field key %q is not valid (letters, digits, then also _ . -)", key);
  if (isReservedFieldKey(key)) return codedError("invalid-entry", "%q can't be a custom field key", key);
  return undefined;
}

function singleLine(s: string): boolean {
  return !s.includes("\n") && !s.includes("\r");
}

/**
 * The content rules of §4.3 for one entry, in the reference's order: password, username,
 * url, tags, fields (key, then value, field by field), notes. Returns the error
 * (`invalid entry: password must be a single line`, `invalid tag "a,b": it contains a comma`, …)
 * or undefined. Paths are checked separately (validationProblem).
 */
// SPEC-GAP: `<name> is not valid UTF-8` can't happen on read (strings are decoded with
// U+FFFD); for in-memory strings with a lone surrogate the field texts are ours:
// `field key "k" is not valid UTF-8`, `field <key> is not valid UTF-8`.
export function entryContentProblem(e: Pick<Entry, "password" | "username" | "url" | "tags" | "fields" | "notes">): PasshError | undefined {
  const inv = (format: string, ...args: unknown[]) => codedError("invalid-entry", "invalid entry: %w", errorf(format, ...args));
  for (const [name, value] of [["password", e.password], ["username", e.username], ["url", e.url]] as const) {
    if (hasLoneSurrogate(value)) return inv("%s is not valid UTF-8", name);
    if (!singleLine(value)) return inv("%s must be a single line", name);
  }
  for (const t of e.tags) {
    try {
      if (normalizeTag(t) !== t) return codedError("invalid-tag", "invalid tag %q: it isn't normalized", t);
    } catch (err) {
      return err as PasshError;
    }
  }
  for (const f of e.fields) {
    if (hasLoneSurrogate(f.key)) return inv("field key %q is not valid UTF-8", f.key);
    const kp = fieldKeyProblem(f.key);
    if (kp) return codedError("invalid-entry", "invalid entry: %w", kp);
    if (hasLoneSurrogate(f.value)) return inv("field %s is not valid UTF-8", f.key);
    if (!singleLine(f.value)) return inv("field %s must be a single line", f.key);
  }
  if (hasLoneSurrogate(e.notes)) return inv("notes are not valid UTF-8");
  return undefined;
}

/** Throws the content error of an entry (§4.3), if any. */
export function validateEntryContent(e: Pick<Entry, "password" | "username" | "url" | "tags" | "fields" | "notes">): void {
  const p = entryContentProblem(e);
  if (p) throw p;
}

/**
 * The first validation problem of the data (§4.4), as the detail after `invalid vault data: `,
 * or undefined: entry contents (`entry 3: invalid entry: …`, `entry 3: invalid tag …`), then
 * `missing vault_id`, then per entry `missing id`, `missing path`, `duplicate id "x"`,
 * `duplicate path "p"`, then `tombstone 2: missing id`.
 */
// SPEC-GAP: path validity isn't in §4.4's list (the reference checks paths while decoding);
// for data built in memory we also report `entry N: invalid path: …` and
// `entry N: path "p" isn't in NFC` (never seen on read).
export function validationProblem(d: VaultData): PasshError | undefined {
  for (let i = 0; i < d.entries.length; i++) {
    const p = entryContentProblem(d.entries[i]!);
    if (p) return errorf("entry %d: %w", i + 1, p);
  }
  if (d.vaultId === "") return errorf("missing vault_id");
  if (hasLoneSurrogate(d.vaultId)) return errorf("vault_id is not valid UTF-8");
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (let i = 0; i < d.entries.length; i++) {
    const e = d.entries[i]!;
    const n = i + 1;
    if (e.id === "") return errorf("entry %d: missing id", n);
    if (e.path === "") return errorf("entry %d: missing path", n);
    const pp = pathProblem(e.path);
    if (pp) return errorf("entry %d: invalid path: %w", n, pp);
    if (e.path.normalize("NFC") !== e.path) return errorf("entry %d: path %q isn't in NFC", n, e.path);
    if (ids.has(e.id)) return errorf("entry %d: duplicate id %q", n, e.id);
    if (paths.has(e.path)) return errorf("entry %d: duplicate path %q", n, e.path);
    ids.add(e.id);
    paths.add(e.path);
  }
  for (let i = 0; i < d.deleted.length; i++) {
    if (d.deleted[i]!.id === "") return errorf("tombstone %d: missing id", i + 1);
  }
  return undefined;
}

/** Validates data before a write (§4.4): throws `invalid vault data: …` (code "invalid-data"). */
export function validateVaultData(d: VaultData): void {
  const p = validationProblem(d);
  if (p) throw invalidData(p);
}

// ---------------------------------------------------------------------------
// Serialization (§4.6)

function sortedUnknowns(u: Unknowns): Array<[string, string]> {
  return [...u].sort((a, b) => compareUTF8(a[0], b[0]));
}

class Writer {
  parts: string[] = [];
  write(s: string): void {
    this.parts.push(s);
  }
}

function ind(depth: number): string {
  return "  ".repeat(depth);
}

/**
 * Writes an object's members at `depth` (the depth of the members' lines). `known` are the
 * known members in order, already as JSON texts; unknown members follow, sorted by the
 * UTF-8 bytes of their names.
 */
function writeObject(w: Writer, depth: number, known: Array<[string, (depth: number) => string]>, unknown: Unknowns): void {
  const members: Array<[string, (depth: number) => string]> = [...known];
  for (const [name, raw] of sortedUnknowns(unknown)) members.push([name, (d) => indentCompact(raw, d)]);
  if (members.length === 0) {
    w.write("{}");
    return;
  }
  w.write("{\n");
  members.forEach(([name, val], i) => {
    w.write(ind(depth) + quoteJSON(name) + ": " + val(depth) + (i < members.length - 1 ? ",\n" : "\n"));
  });
  w.write(ind(depth - 1) + "}");
}

function arrayText(items: Array<(depth: number) => string>, depth: number): string {
  if (items.length === 0) return "[]";
  return "[\n" + items.map((it) => ind(depth + 1) + it(depth + 1)).join(",\n") + "\n" + ind(depth) + "]";
}

function objectText(depth: number, known: Array<[string, (depth: number) => string]>, unknown: Unknowns): string {
  const w = new Writer();
  writeObject(w, depth + 1, known, unknown);
  return w.parts.join("");
}

const s = (v: string) => () => quoteJSON(v);
const t = (v: Time) => () => quoteJSON(formatTime(v));

function fieldText(f: Field, depth: number): string {
  return objectText(depth, [["key", s(f.key)], ["value", s(f.value)]], f.unknown);
}

function entryText(e: Entry, depth: number): string {
  return objectText(
    depth,
    [
      ["id", s(e.id)],
      ["path", s(e.path)],
      ["password", s(e.password)],
      ["username", s(e.username)],
      ["url", s(e.url)],
      ["tags", (d) => arrayText(e.tags.map((tag) => () => quoteJSON(tag)), d)],
      ["fields", (d) => arrayText(e.fields.map((f) => (dd: number) => fieldText(f, dd)), d)],
      ["notes", s(e.notes)],
      ["created_at", t(e.createdAt)],
      ["updated_at", t(e.updatedAt)],
    ],
    e.unknown,
  );
}

function tombstoneText(x: Tombstone, depth: number): string {
  return objectText(depth, [["id", s(x.id)], ["deleted_at", t(x.deletedAt)]], x.unknown);
}

/** The data as JSON text, exactly as passh writes it (§4.6), with the final LF. */
export function serializeVaultDataText(d: VaultData): string {
  const top = objectText(
    0,
    [
      ["format", s(d.format)],
      ["version", () => String(d.version)],
      ["vault_id", s(d.vaultId)],
      ["revision", () => d.revision.toString()],
      ["saved_at", t(d.savedAt)],
      ["entries", (dd) => arrayText(d.entries.map((e) => (x: number) => entryText(e, x)), dd)],
      ["deleted", (dd) => arrayText(d.deleted.map((x) => (y: number) => tombstoneText(x, y)), dd)],
    ],
    d.unknown,
  );
  return top + "\n";
}

/** The data block's plaintext, byte for byte as passh writes it (§4.6). */
export function serializeVaultData(d: VaultData): Uint8Array {
  return utf8Encode(serializeVaultDataText(d));
}

// ---------------------------------------------------------------------------
// New data, ids

/** A random UUID v4 in lower case (`8-4-4-4-12`), from the CSPRNG (§4.1). */
export function newId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** New data for `init` (§4.7): a new vault_id, revision 1, saved_at now, nothing else. */
export function newVaultData(now: Time = nowTime()): VaultData {
  return { format: DATA_FORMAT, version: DATA_VERSION, vaultId: newId(), revision: 1n, savedAt: now, entries: [], deleted: [], unknown: new Map() };
}
