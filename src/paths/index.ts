// Entry paths, folders and tags (spec §4.4, vault-format.md §4.3 and §6, cli.md §1.8, §2.3).

import { codedError, errorf, type PasshError } from "../i18n/index.ts";
import { compareUTF8, decodeUTF8Lossy, hasControl, hasLoneSurrogate, isValidUTF8, trimWhiteSpace, utf8Length } from "../util/unicode.ts";

/** Maximum length of a path in bytes, after NFC (vault-format.md §1). */
export const MAX_PATH_BYTES = 1024;

/** The reason a path breaks a rule of vault-format.md §6.1, or undefined if it is valid. */
function pathRule(s: string | Uint8Array): { reason?: PasshError; nfc: string } {
  // 1. non-empty
  if (s.length === 0) return { reason: errorf("it is empty"), nfc: "" };
  // 2. valid UTF-8
  let text: string;
  if (typeof s === "string") {
    if (hasLoneSurrogate(s)) return { reason: errorf("it is not valid UTF-8"), nfc: "" };
    text = s;
  } else {
    if (!isValidUTF8(s)) return { reason: errorf("it is not valid UTF-8"), nfc: "" };
    text = decodeUTF8Lossy(s);
  }
  // 3. NFC; every later rule applies to the NFC form
  const nfc = text.normalize("NFC");
  // 4. at most 1024 bytes
  if (utf8Length(nfc) > MAX_PATH_BYTES) return { reason: errorf("it is longer than 1024 bytes"), nfc };
  // 5. no control character
  if (hasControl(nfc)) return { reason: errorf("it contains a control character"), nfc };
  // 6, 7
  if (nfc.startsWith("/")) return { reason: errorf("it starts with /"), nfc };
  if (nfc.endsWith("/")) return { reason: errorf("it ends with /"), nfc };
  // 8. segments, in order, each rule in order
  for (const seg of nfc.split("/")) {
    if (seg === "") return { reason: errorf("it has an empty segment (//)"), nfc };
    if (seg === "." || seg === "..") return { reason: errorf('it has a "." or ".." segment'), nfc };
    if (seg.startsWith("-")) return { reason: errorf("a segment starts with -"), nfc };
  }
  return { nfc };
}

/**
 * Validates an entry path (vault-format.md §6.1) and returns its NFC form, which is what is
 * stored. Throws `invalid path: <reason>` (code "invalid-path").
 */
export function parsePath(s: string | Uint8Array): string {
  const { reason, nfc } = pathRule(s);
  if (reason) throw codedError("invalid-path", "invalid path: %w", reason);
  return nfc;
}

/**
 * Validates a folder argument (`ls [folder]`, `--folder`): the path rules, with
 * `invalid folder: <reason>` (code "invalid-folder"). A trailing `/` is refused.
 */
export function parseFolder(s: string | Uint8Array): string {
  const { reason, nfc } = pathRule(s);
  if (reason) throw codedError("invalid-folder", "invalid folder: %w", reason);
  return nfc;
}

/** Reports whether the string is a valid path in NFC form (as stored). */
export function isValidPath(s: string): boolean {
  const { reason, nfc } = pathRule(s);
  return !reason && nfc === s;
}

/** The reason (e.g. `it has an empty segment (//)`) a path is invalid, or undefined. */
export function pathProblem(s: string | Uint8Array): PasshError | undefined {
  return pathRule(s).reason;
}

// ---------------------------------------------------------------------------
// Order and folders (vault-format.md §6.2)

/**
 * Path order: segment by segment, each segment by bytes; a path whose segments run out
 * first sorts first: `work` < `work/x` < `work-old/y`.
 */
export function comparePaths(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    if (x === 0x2f) return -1; // the segment of a ended: a sorts first
    if (y === 0x2f) return 1;
    // Code point (UTF-8 byte) order: a surrogate (U+10000 and up) sorts after U+E000–U+FFFF.
    const xx = x >= 0xd800 ? (x <= 0xdfff ? x + 0x2000 : x - 0x800) : x;
    const yy = y >= 0xd800 ? (y <= 0xdfff ? y + 0x2000 : y - 0x800) : y;
    return xx < yy ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Sorts paths in place by comparePaths and returns the array. */
export function sortPaths<T extends string>(paths: T[]): T[] {
  return paths.sort(comparePaths);
}

/** Sorts items by their path (comparePaths), in place. */
export function sortByPath<T extends { path: string }>(items: T[]): T[] {
  return items.sort((a, b) => comparePaths(a.path, b.path));
}

/**
 * Reports whether an entry path is inside a folder: it starts with `folder/`. `work/x` is in
 * `work`, `workshop/x` isn't, and `work` isn't inside itself. The empty folder is the top
 * level, which holds everything.
 */
export function isInFolder(path: string, folder: string): boolean {
  if (folder === "") return true;
  return path.length > folder.length + 1 && path.startsWith(folder) && path.charCodeAt(folder.length) === 0x2f;
}

/** The segments of a path. */
export function segments(path: string): string[] {
  return path === "" ? [] : path.split("/");
}

/** The last segment of a path (the entry's name). */
export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/** The folder holding a path: `a/b` for `a/b/c`, "" (top level) for `c`. */
export function parentFolder(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** The folders of a path, outermost first: `a`, `a/b` for `a/b/c`; none for `c`. */
export function foldersOf(path: string): string[] {
  const out: string[] = [];
  for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) out.push(path.slice(0, i));
  return out;
}

/** Every folder that exists (holds at least one of the paths), sorted by comparePaths. */
export function allFolders(paths: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const p of paths) for (const f of foldersOf(p)) set.add(f);
  return sortPaths([...set]);
}

/** Reports whether a folder exists: some path lies inside it. */
export function folderExists(paths: Iterable<string>, folder: string): boolean {
  for (const p of paths) if (isInFolder(p, folder)) return true;
  return false;
}

/** The number of paths inside a folder, at any depth. */
export function countInFolder(paths: Iterable<string>, folder: string): number {
  let n = 0;
  for (const p of paths) if (isInFolder(p, folder)) n++;
  return n;
}

/**
 * The destination of `passh mv <src> <dst>` (cli.md §2.10): a `<dst>` ending in `/` means
 * "into that folder": one trailing `/` is removed and `/` + the last segment of `<src>` is
 * appended. The result is validated (`invalid path: …`). `src` must be a valid path.
 */
export function moveDestination(src: string, dst: string | Uint8Array): string {
  let d = typeof dst === "string" ? dst : isValidUTF8(dst) ? decodeUTF8Lossy(dst) : undefined;
  if (d === undefined) return parsePath(dst);
  if (d.endsWith("/")) d = d.slice(0, -1) + "/" + baseName(src);
  return parsePath(d);
}

// ---------------------------------------------------------------------------
// Tree (cli.md §2.3 `ls`, tui.md §5.2)

export interface TreeNode {
  /** One segment. */
  name: string;
  /** The full path of the entry or folder. */
  path: string;
  /** A folder node (an entry with the same path is a separate node). */
  folder: boolean;
  /** Children of a folder, sorted. */
  children: TreeNode[];
}

export interface TreeOptions {
  /**
   * `ls` (false, the default): items sorted by name in byte order, a folder before an entry
   * of the same name. TUI (true): subfolders first, then entries, each sorted by bytes.
   */
  foldersFirst?: boolean;
}

/**
 * Builds the tree of the given entry paths below `base` ("" for the top level): paths not
 * inside `base` are skipped. Folders exist only where they hold entries.
 */
export function buildTree(paths: Iterable<string>, base = "", opts: TreeOptions = {}): TreeNode[] {
  const root: TreeNode = { name: "", path: base, folder: true, children: [] };
  const folders = new Map<string, TreeNode>([[base, root]]);
  const prefixLen = base === "" ? 0 : base.length + 1;
  for (const p of paths) {
    if (base !== "" && !isInFolder(p, base)) continue;
    const rel = p.slice(prefixLen);
    const segs = rel.split("/");
    let parent = root;
    let cur = base;
    for (let i = 0; i < segs.length - 1; i++) {
      cur = cur === "" ? segs[i]! : cur + "/" + segs[i]!;
      let node = folders.get(cur);
      if (!node) {
        node = { name: segs[i]!, path: cur, folder: true, children: [] };
        folders.set(cur, node);
        parent.children.push(node);
      }
      parent = node;
    }
    parent.children.push({ name: segs[segs.length - 1]!, path: p, folder: false, children: [] });
  }
  const cmp = (a: TreeNode, b: TreeNode): number => {
    if (opts.foldersFirst && a.folder !== b.folder) return a.folder ? -1 : 1;
    return compareUTF8(a.name, b.name) || (a.folder === b.folder ? 0 : a.folder ? -1 : 1);
  };
  const sortRec = (n: TreeNode): void => {
    n.children.sort(cmp);
    for (const c of n.children) if (c.folder) sortRec(c);
  };
  sortRec(root);
  return root.children;
}

/**
 * The lines of an `ls` tree (cli.md §2.3), without the header: `├── ` / `└── ` branches,
 * children indented by `│   ` or four spaces, folders ending with `/`. Each name goes
 * through `escape` (S4 single-line for the CLI).
 */
export function renderTree(nodes: TreeNode[], escape: (s: string) => string = (s) => s): string[] {
  const out: string[] = [];
  const walk = (list: TreeNode[], indent: string): void => {
    list.forEach((n, i) => {
      const last = i === list.length - 1;
      out.push(indent + (last ? "└── " : "├── ") + escape(n.name) + (n.folder ? "/" : ""));
      if (n.folder) walk(n.children, indent + (last ? "    " : "│   "));
    });
  };
  walk(nodes, "");
  return out;
}

/** What `passh ls [folder] [--tag t]…` shows (cli.md §2.3). */
export type Listing =
  /** The header, then the tree of the matching entries relative to the folder. */
  | { kind: "tree"; nodes: TreeNode[] }
  /** The header, then `(no entries)`. */
  | { kind: "empty" }
  /** `ls <folder>` where the folder is itself a matching entry: just its path, no header. */
  | { kind: "entry"; path: string };

/**
 * The `ls` listing (cli.md §2.3): the entries having every tag of `tags`, below `folder`
 * ("" or undefined: everything). With a folder that holds no matching entry: the folder
 * itself if it is an entry with all the tags; else, if any entry lies inside it, "empty";
 * else `<folder>: no such folder` (code "no-such-folder"). Folder and tags must already be
 * validated and normalized.
 */
export function listEntries(entries: Iterable<{ path: string; tags: readonly string[] }>, folder: string | undefined, tags: readonly string[] = []): Listing {
  const all = [...entries];
  const base = folder ?? "";
  const matching = all.filter((e) => hasAllTags(e.tags, tags) && (base === "" || isInFolder(e.path, base)));
  if (matching.length > 0) return { kind: "tree", nodes: buildTree(matching.map((e) => e.path), base) };
  if (base === "") return { kind: "empty" };
  const self = all.find((e) => e.path === base);
  if (self && hasAllTags(self.tags, tags)) return { kind: "entry", path: base };
  if (all.some((e) => isInFolder(e.path, base))) return { kind: "empty" };
  throw codedError("no-such-folder", "%s: no such folder", base);
}

// ---------------------------------------------------------------------------
// Tags (vault-format.md §4.3, cli.md §1.8)

/** The reason a tag is invalid, as an error, or the normalized tag. */
function tagRule(t: string | Uint8Array): { tag: string; err?: PasshError } {
  if (typeof t === "string" ? hasLoneSurrogate(t) : !isValidUTF8(t)) {
    return { tag: "", err: codedError("invalid-tag", "invalid tag %q: not valid UTF-8", t) };
  }
  const text = typeof t === "string" ? t : decodeUTF8Lossy(t);
  const tag = trimWhiteSpace(text.normalize("NFC"));
  if (tag === "") return { tag, err: codedError("invalid-tag", "invalid tag: a tag can't be empty") };
  if (tag.includes(",")) return { tag, err: codedError("invalid-tag", "invalid tag %q: it contains a comma", tag) };
  if (hasControl(tag)) return { tag, err: codedError("invalid-tag", "invalid tag %q: it contains a control character", tag) };
  return { tag };
}

/**
 * Normalizes one tag: valid UTF-8, NFC, white space trimmed; then non-empty, no comma, no
 * control character. Throws `invalid tag …` (code "invalid-tag"), the tag Go-quoted as
 * normalized and trimmed.
 */
export function normalizeTag(t: string | Uint8Array): string {
  const { tag, err } = tagRule(t);
  if (err) throw err;
  return tag;
}

/** Reports whether a string is a valid tag in normalized form. */
export function isValidTag(t: string): boolean {
  const { tag, err } = tagRule(t);
  return !err && tag === t;
}

/** Removes duplicate tags, keeping the first occurrence and the order. */
export function dedupeTags(tags: Iterable<string>): string[] {
  return [...new Set(tags)];
}

/**
 * Parses a tag list typed as text (`tags:` line, `passh tag`, the add prompt, the form):
 * split at `,`, blank items skipped, every other item normalized (the first invalid one
 * throws); duplicates removed, the first kept.
 */
export function parseTagList(text: string | Uint8Array): string[] {
  const out: string[] = [];
  if (typeof text === "string") {
    for (const item of text.split(",")) {
      if (trimWhiteSpace(item) === "") continue;
      out.push(normalizeTag(item));
    }
  } else {
    // Split the bytes at "," (0x2C is never part of a multi-byte sequence), so an item with
    // invalid UTF-8 is reported alone.
    let start = 0;
    for (let i = 0; i <= text.length; i++) {
      if (i < text.length && text[i] !== 0x2c) continue;
      const item = text.subarray(start, i);
      start = i + 1;
      if (isValidUTF8(item) && trimWhiteSpace(decodeUTF8Lossy(item)) === "") continue;
      out.push(normalizeTag(item));
    }
  }
  return dedupeTags(out);
}

/** Reports whether `have` holds every tag of `want` (AND, exact comparison). */
export function hasAllTags(have: readonly string[], want: readonly string[]): boolean {
  for (const w of want) if (!have.includes(w)) return false;
  return true;
}

/** Joins tags for display and `show --field tags`: `, `. */
export function joinTags(tags: readonly string[]): string {
  return tags.join(", ");
}

export interface TagCount {
  tag: string;
  count: number;
}

/**
 * Tags with the number of entries that have each, sorted by tag in byte order (cli.md §2.13,
 * tui.md §5.3).
 */
export function countTags(entries: Iterable<{ tags: readonly string[] }>): TagCount[] {
  const m = new Map<string, number>();
  for (const e of entries) for (const t of new Set(e.tags)) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m].map(([tag, count]) => ({ tag, count })).sort((a, b) => compareUTF8(a.tag, b.tag));
}
