// Changes to the data (vault-format.md §4.7) as pure functions: each takes the data, returns a
// changed copy (the input is never modified) and says whether anything changed, so callers
// skip the save when nothing did (add with overwrite, edit and tag edit of identical content).
// Also: field lookup, "masked like a password", the field pairing of `edit --editor` (§4.5),
// clones and equality.

import { codedError, type PasshError } from "../i18n/index.ts";
import { comparePaths, dedupeTags, isInFolder, normalizeTag, parsePath } from "../paths/index.ts";
import { foldEquals } from "../util/unicode.ts";
import { entryContentProblem, MAX_REVISION, newId } from "./data.ts";
import { nowTime } from "./time.ts";
import type { Entry, Field, Time, Tombstone, Unknowns, VaultData } from "./types.ts";

// ---------------------------------------------------------------------------
// Clones and equality

export function cloneUnknowns(u: Unknowns): Unknowns {
  return new Map(u);
}

export function cloneField(f: Field): Field {
  return { key: f.key, value: f.value, unknown: cloneUnknowns(f.unknown) };
}

export function cloneEntry(e: Entry): Entry {
  return { ...e, tags: [...e.tags], fields: e.fields.map(cloneField), unknown: cloneUnknowns(e.unknown) };
}

export function cloneTombstone(t: Tombstone): Tombstone {
  return { id: t.id, deletedAt: t.deletedAt, unknown: cloneUnknowns(t.unknown) };
}

/** A deep copy of the data. */
export function cloneVaultData(d: VaultData): VaultData {
  return { ...d, entries: d.entries.map(cloneEntry), deleted: d.deleted.map(cloneTombstone), unknown: cloneUnknowns(d.unknown) };
}

export function unknownsEqual(a: Unknowns, b: Unknowns): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

export function fieldsEqual(a: readonly Field[], b: readonly Field[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.key !== y.key || x.value !== y.value || !unknownsEqual(x.unknown, y.unknown)) return false;
  }
  return true;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Reports whether two entries have the same content: path, values, tags, fields (with their
 * unknown keys), notes and the entry's unknown keys (§4.7 "nothing would change"). Ids and
 * times are not compared.
 */
export function sameContent(a: Entry, b: Entry): boolean {
  return (
    a.path === b.path &&
    a.password === b.password &&
    a.username === b.username &&
    a.url === b.url &&
    a.notes === b.notes &&
    arraysEqual(a.tags, b.tags) &&
    fieldsEqual(a.fields, b.fields) &&
    unknownsEqual(a.unknown, b.unknown)
  );
}

/** Reports whether two entries are equal in every member, ids and times included. */
export function entriesEqual(a: Entry, b: Entry): boolean {
  return a.id === b.id && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt && sameContent(a, b);
}

/** Reports whether two data values are equal in every member. */
export function vaultDataEqual(a: VaultData, b: VaultData): boolean {
  return (
    a.format === b.format &&
    a.version === b.version &&
    a.vaultId === b.vaultId &&
    a.revision === b.revision &&
    a.savedAt === b.savedAt &&
    unknownsEqual(a.unknown, b.unknown) &&
    a.entries.length === b.entries.length &&
    a.entries.every((e, i) => entriesEqual(e, b.entries[i]!)) &&
    a.deleted.length === b.deleted.length &&
    a.deleted.every((t, i) => t.id === b.deleted[i]!.id && t.deletedAt === b.deleted[i]!.deletedAt && unknownsEqual(t.unknown, b.deleted[i]!.unknown))
  );
}

// ---------------------------------------------------------------------------
// Lookup

/** The entry at a path (exact NFC path), or undefined. */
export function findEntry(d: VaultData, path: string): Entry | undefined {
  return d.entries.find((e) => e.path === path);
}

/** The index of the entry at a path, or −1. */
export function findEntryIndex(d: VaultData, path: string): number {
  return d.entries.findIndex((e) => e.path === path);
}

/** The entry with an id, or undefined. */
export function findEntryById(d: VaultData, id: string): Entry | undefined {
  return d.entries.find((e) => e.id === id);
}

/** Every entry path, sorted by path order (§6.2). */
export function entryPaths(d: VaultData): string[] {
  return d.entries.map((e) => e.path).sort(comparePaths);
}

/** The entries sorted by path (§6.2), as a new array. */
export function sortedEntries(d: VaultData): Entry[] {
  return [...d.entries].sort((a, b) => comparePaths(a.path, b.path));
}

/** `<path>: not found` (code "not-found"). */
export function notFoundError(path: string): PasshError {
  return codedError("not-found", "%s: not found", path);
}

/** `<path>: already exists` (code "exists"). */
export function existsError(path: string): PasshError {
  return codedError("exists", "%s: already exists", path);
}

/**
 * Field lookup (§4.7, cli.md §1.8): `password`, `username`, `url`, `notes` give the standard
 * value, `tags` the tags joined with `, `; any other name the first custom field with exactly
 * that key (case-sensitive). Undefined when there is none.
 */
export function fieldValue(e: Entry, name: string): string | undefined {
  switch (name) {
    case "password":
      return e.password;
    case "username":
      return e.username;
    case "url":
      return e.url;
    case "notes":
      return e.notes;
    case "tags":
      return e.tags.join(", ");
  }
  return e.fields.find((f) => f.key === name)?.value;
}

/** Reports whether a value is an `otpauth://` URI (scheme in any case). */
export function isOtpauth(value: string): boolean {
  return foldEquals(value.slice(0, 10), "otpauth://");
}

/**
 * Masked like a password (§4.7, S5): custom fields keyed `password` or `otp` in any case, and
 * any value starting with `otpauth://` (scheme in any case). The password itself always is.
 */
export function isSecretField(key: string, value: string): boolean {
  return foldEquals(key, "password") || foldEquals(key, "otp") || isOtpauth(value);
}

// ---------------------------------------------------------------------------
// Unknown keys of fields (§4.5)

/**
 * `edit --editor`: each new field takes, if there is one, the unknown keys of the first stored
 * field with the same key and value not yet taken (stored order). So a reordered list keeps
 * them, duplicates pair up one to one in order, and a changed field loses them.
 */
export function pairFields(stored: readonly Field[], next: ReadonlyArray<{ key: string; value: string; unknown?: Unknowns }>): Field[] {
  const taken = new Array<boolean>(stored.length).fill(false);
  return next.map((f) => {
    const i = stored.findIndex((s, k) => !taken[k] && s.key === f.key && s.value === f.value);
    if (i < 0) return { key: f.key, value: f.value, unknown: cloneUnknowns(f.unknown ?? new Map()) };
    taken[i] = true;
    return { key: f.key, value: f.value, unknown: cloneUnknowns(stored[i]!.unknown) };
  });
}

// ---------------------------------------------------------------------------
// Operations

/** The content a user supplies for an entry. */
export interface EntryContent {
  password: string;
  username: string;
  url: string;
  /** Tags; normalized and de-duplicated by the operations. */
  tags: string[];
  /** Custom fields with their unknown keys (none for new content). */
  fields: Field[];
  notes: string;
}

/** Empty content: every value "". */
export function emptyContent(): EntryContent {
  return { password: "", username: "", url: "", tags: [], fields: [], notes: "" };
}

export interface ChangeResult {
  /** The changed copy (or a plain copy when nothing changed). */
  data: VaultData;
  /** Whether anything changed: false means "don't save". */
  changed: boolean;
  /** The entry added or changed, in `data`. */
  entry?: Entry;
}

export interface OpOptions {
  /** "now" for created_at/updated_at/deleted_at (default: the current time). */
  now?: Time;
}

function normalizedTags(tags: readonly string[]): string[] {
  return dedupeTags(tags.map((t) => normalizeTag(t)));
}

function checkContent(e: Entry): void {
  const p = entryContentProblem(e);
  if (p) throw p;
}

/**
 * Add (§4.7): a new id, created_at = updated_at = now, appended. A taken path fails with
 * `<path>: already exists` unless `overwrite` (`add --force`, `import pass --overwrite`):
 * then the existing entry keeps its id, created_at, position and unknown keys, takes the new
 * content (its fields replace the old ones entirely) and updated_at = now; identical content
 * changes nothing. The path is validated and normalized (parsePath); content is checked by §4.3.
 */
export function addEntry(d: VaultData, path: string, content: EntryContent, opts: OpOptions & { overwrite?: boolean; id?: string } = {}): ChangeResult {
  const now = opts.now ?? nowTime();
  path = parsePath(path);
  const data = cloneVaultData(d);
  const i = findEntryIndex(data, path);
  const base = {
    path,
    password: content.password,
    username: content.username,
    url: content.url,
    tags: normalizedTags(content.tags),
    fields: content.fields.map(cloneField),
    notes: content.notes,
  };
  if (i >= 0) {
    if (!opts.overwrite) throw existsError(path);
    const old = data.entries[i]!;
    const next: Entry = { ...base, id: old.id, createdAt: old.createdAt, updatedAt: now, unknown: cloneUnknowns(old.unknown) };
    checkContent(next);
    if (sameContent(old, next)) return { data, changed: false, entry: old };
    data.entries[i] = next;
    return { data, changed: true, entry: next };
  }
  const entry: Entry = { ...base, id: opts.id ?? newId(), createdAt: now, updatedAt: now, unknown: new Map() };
  checkContent(entry);
  data.entries.push(entry);
  return { data, changed: true, entry };
}

/** What an edit may change; members left out keep their stored value. */
export interface EntryChange {
  path?: string;
  password?: string;
  username?: string;
  url?: string;
  tags?: string[];
  /** The new fields as they should be stored (see pairFields for `edit --editor`). */
  fields?: Field[];
  notes?: string;
}

/**
 * Edit by id (§4.7; `edit`, the TUI form, `generate --force`): keeps id, created_at, position
 * and unknown keys; a new path moves it (`<path>: already exists` if another entry has it);
 * updated_at = now. Nothing changes when the content is the same. An unknown id fails with
 * code "not-found".
 */
export function editEntry(d: VaultData, id: string, change: EntryChange, opts: OpOptions = {}): ChangeResult {
  const now = opts.now ?? nowTime();
  const data = cloneVaultData(d);
  const i = data.entries.findIndex((e) => e.id === id);
  // SPEC-GAP: the spec has no message for an unknown id; callers map code "not-found" to theirs.
  if (i < 0) throw codedError("not-found", "entry %s: not found", id);
  const old = data.entries[i]!;
  const next: Entry = {
    ...old,
    path: change.path !== undefined ? parsePath(change.path) : old.path,
    password: change.password ?? old.password,
    username: change.username ?? old.username,
    url: change.url ?? old.url,
    tags: change.tags ? normalizedTags(change.tags) : [...old.tags],
    fields: change.fields ? change.fields.map(cloneField) : old.fields.map(cloneField),
    notes: change.notes ?? old.notes,
    unknown: cloneUnknowns(old.unknown),
  };
  if (next.path !== old.path && data.entries.some((e, k) => k !== i && e.path === next.path)) throw existsError(next.path);
  checkContent(next);
  if (sameContent(old, next)) return { data, changed: false, entry: old };
  next.updatedAt = now;
  data.entries[i] = next;
  return { data, changed: true, entry: next };
}

/** Replaces only the password of the entry at a path (`generate --force`). */
export function setPassword(d: VaultData, path: string, password: string, opts: OpOptions = {}): ChangeResult {
  const e = findEntry(d, path);
  if (!e) throw notFoundError(path);
  return editEntry(d, e.id, { password }, opts);
}

/**
 * Move (§4.7, `mv`): keeps id and position, updated_at = now; `<src>: not found`; the
 * destination must not exist (`mv a a` is `a: already exists`). Always a change.
 */
export function moveEntry(d: VaultData, src: string, dst: string, opts: OpOptions = {}): ChangeResult {
  const now = opts.now ?? nowTime();
  const data = cloneVaultData(d);
  const i = findEntryIndex(data, src);
  if (i < 0) throw notFoundError(src);
  dst = parsePath(dst);
  if (findEntryIndex(data, dst) >= 0) throw existsError(dst);
  const e = data.entries[i]!;
  e.path = dst;
  e.updatedAt = now;
  return { data, changed: true, entry: e };
}

export interface FolderMoveResult extends ChangeResult {
  /** The number of entries moved. */
  moved: number;
}

/**
 * Moves every entry under folder `src` to `dst` + the rest of its path, in one change
 * (cli.md §2.10), each with updated_at = now. Errors: `<src>: not found` (no entry inside),
 * `can't move the folder <src> into itself` (`dst` equal to or inside `src`),
 * `<path>: already exists` (nothing moves). The entries move one by one in path order and a
 * destination also counts as taken while an entry of the same move that hasn't moved yet
 * holds it, as passh v0.6 does (known issue, audit #36).
 */
// SPEC-GAP: audit #36: current behaviour reproduced (the reference fails `mv m/b m` with
// `m/b/x: already exists`); the proposed fix would check against the post-move paths.
export function moveFolder(d: VaultData, src: string, dst: string, opts: OpOptions = {}): FolderMoveResult {
  const now = opts.now ?? nowTime();
  const data = cloneVaultData(d);
  const inside = data.entries.filter((e) => isInFolder(e.path, src)).sort((a, b) => comparePaths(a.path, b.path));
  if (inside.length === 0) throw notFoundError(src);
  if (dst === src || isInFolder(dst, src)) throw codedError("into-itself", "can't move the folder %s into itself", src);
  const taken = new Set(data.entries.map((e) => e.path));
  const moves: Array<[Entry, string]> = [];
  for (const e of inside) {
    const np = parsePath(dst + e.path.slice(src.length));
    if (taken.has(np)) throw existsError(np);
    taken.delete(e.path);
    taken.add(np);
    moves.push([e, np]);
  }
  for (const [e, np] of moves) {
    e.path = np;
    e.updatedAt = now;
  }
  return { data, changed: true, moved: moves.length };
}

/**
 * Remove (§4.7): the entry leaves the array (the others keep their order) and a tombstone
 * `{id, deleted_at: now}` is appended; its unknown keys go with it. `<path>: not found`.
 */
export function removeEntry(d: VaultData, path: string, opts: OpOptions = {}): ChangeResult & { removed: Entry } {
  const now = opts.now ?? nowTime();
  const data = cloneVaultData(d);
  const i = findEntryIndex(data, path);
  if (i < 0) throw notFoundError(path);
  const [removed] = data.entries.splice(i, 1);
  data.deleted.push({ id: removed!.id, deletedAt: now, unknown: new Map() });
  return { data, changed: true, removed: removed! };
}

/**
 * Tag edit (§4.7, `tag`): adds the given tags (appended after the existing ones), then removes
 * the given ones (an absent one is ignored), all compared after normalization; then as Edit,
 * so identical tags change nothing. Tags are normalized (`invalid tag …` on a bad one).
 */
export function editTags(d: VaultData, path: string, add: readonly string[], remove: readonly string[], opts: OpOptions = {}): ChangeResult & { tags: string[] } {
  const e = findEntry(d, path);
  if (!e) throw notFoundError(path);
  const addN = add.map((t) => normalizeTag(t));
  const removeN = new Set(remove.map((t) => normalizeTag(t)));
  const tags = dedupeTags([...e.tags, ...addN]).filter((t) => !removeN.has(t));
  const r = editEntry(d, e.id, { tags }, opts);
  return { ...r, tags: r.entry!.tags };
}

/**
 * The revision a save writes (§4.7): max(revision of the data, opened revision) + 1. At
 * 2^64 − 1 the save is refused (the proposed fix of audit #32; passh v0.6 wraps to 0).
 */
// SPEC-GAP: audit #32 / §4.7: we refuse the save at 2^64 − 1 (passh v0.6 wraps to 0); the
// message is ours.
export function nextRevision(dataRevision: bigint, openedRevision: bigint = dataRevision): bigint {
  const m = dataRevision > openedRevision ? dataRevision : openedRevision;
  if (m >= MAX_REVISION) throw codedError("revision-max", "the vault is at the largest revision (%d); it can't be saved again", m);
  return m + 1n;
}

/** The data as a save writes it: the next revision and saved_at = now (§4.7 "Every save"). */
export function prepareSave(d: VaultData, openedRevision: bigint = d.revision, now: Time = nowTime()): VaultData {
  const data = cloneVaultData(d);
  data.revision = nextRevision(d.revision, openedRevision);
  data.savedAt = now;
  return data;
}

