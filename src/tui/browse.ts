// The lists of the main screen (tui.md §5.2–§5.5): the Folders tree, the Tags view, the
// search results, and the cursor rules. Pure functions of the data and the view state.

import type { Entry, VaultData } from "../model/types.ts";
import { comparePaths, countTags, hasAllTags, parentFolder } from "../paths/index.ts";
import { rankEntries } from "../fuzzy/index.ts";
import { compareUTF8 } from "../util/unicode.ts";

export type RowKind = "folder" | "entry" | "tag" | "note" | "heading";

export interface Row {
  kind: RowKind;
  /** The item's identity for the cursor (§5.5): "f:<folder>", "e:<id>", "t:<tag>"; "" for notes. */
  key: string;
  /** Indentation depth (2 cells each). */
  depth: number;
  /** The text shown (raw: escaped when drawn), except for note rows (fixed texts). */
  text: string;
  /** Folder: entries at any depth below; tag: entries with it. */
  count?: number;
  open?: boolean;
  /** Tag: selected. */
  selected?: boolean;
  entry?: Entry;
  folder?: string;
  tag?: string;
  /** Search: the tag the entry matched through (`#tag` at the right). */
  matchTag?: string;
}

export function selectable(r: Row | undefined): boolean {
  return !!r && r.kind !== "note" && r.kind !== "heading";
}

interface FolderNode {
  path: string;
  name: string;
  folders: FolderNode[];
  entries: Entry[];
  count: number;
}

/** Sorted entries and the folder tree of one data snapshot (cached by identity). */
export interface Index {
  data: VaultData;
  sorted: Entry[];
  root: FolderNode;
  folders: Map<string, FolderNode>;
  byId: Map<string, Entry>;
}

const cache = new WeakMap<VaultData, Index>();

/** The index of a data snapshot: entries sorted by path (vault-format.md §6.2), the tree. */
export function indexOf(data: VaultData): Index {
  let ix = cache.get(data);
  if (ix) return ix;
  const sorted = [...data.entries].sort((a, b) => comparePaths(a.path, b.path));
  const root: FolderNode = { path: "", name: "", folders: [], entries: [], count: 0 };
  const folders = new Map<string, FolderNode>([["", root]]);
  const byId = new Map<string, Entry>();
  for (const e of sorted) {
    byId.set(e.id, e);
    const segs = e.path.split("/");
    let node = root;
    node.count++;
    let p = "";
    for (let i = 0; i < segs.length - 1; i++) {
      p = p ? p + "/" + segs[i] : segs[i]!;
      let child = folders.get(p);
      if (!child) {
        child = { path: p, name: segs[i]!, folders: [], entries: [], count: 0 };
        folders.set(p, child);
        node.folders.push(child);
      }
      child.count++;
      node = child;
    }
    node.entries.push(e);
  }
  // Subfolders by segment, each segment by bytes; entries likewise (sorted already).
  for (const f of folders.values()) f.folders.sort((a, b) => compareUTF8(a.name, b.name));
  ix = { data, sorted, root, folders, byId };
  cache.set(data, ix);
  return ix;
}

/** Folders view rows (§5.2): subfolders first, then entries; open folders show their children. */
export function folderRows(ix: Index, expanded: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (node: FolderNode, depth: number) => {
    for (const f of node.folders) {
      const open = expanded.has(f.path);
      rows.push({ kind: "folder", key: "f:" + f.path, depth, text: f.name, count: f.count, open, folder: f.path });
      if (open) walk(f, depth + 1);
    }
    for (const e of node.entries) {
      const name = e.path.slice(e.path.lastIndexOf("/") + 1);
      rows.push({ kind: "entry", key: "e:" + e.id, depth, text: name, entry: e });
    }
  };
  walk(ix.root, 0);
  return rows;
}

/** Tags view rows (§5.3). `noTags` is set when the vault has no tags at all. */
export function tagRows(ix: Index, selected: readonly string[], texts: { none: string; hint: string; heading: (n: number, tags: string) => string }): Row[] {
  const counts = countTags(ix.sorted);
  const rows: Row[] = [];
  if (counts.length === 0) {
    rows.push({ kind: "note", key: "", depth: 0, text: texts.none });
    return rows;
  }
  for (const { tag, count } of counts) rows.push({ kind: "tag", key: "t:" + tag, depth: 0, text: tag, count, selected: selected.includes(tag), tag });
  if (selected.length === 0) {
    rows.push({ kind: "note", key: "", depth: 0, text: texts.hint });
    return rows;
  }
  const sel = [...selected].sort(compareUTF8);
  const matches = ix.sorted.filter((e) => hasAllTags(e.tags, sel));
  rows.push({ kind: "heading", key: "", depth: 0, text: texts.heading(matches.length, sel.join(" + ")) });
  for (const e of matches) rows.push({ kind: "entry", key: "e:" + e.id, depth: 0, text: e.path, entry: e });
  return rows;
}

/** Search result rows (§5.4): paths and tags, the TUI's ranking; "No matches." when empty. */
export function searchRows(ix: Index, query: string, noMatches: string): Row[] {
  // SPEC-GAP (audit #18): ties are ordered by path order (the proposed fix), not plain bytes.
  const hits = rankEntries(query, ix.sorted, { mode: "tui", tuiTies: "segments" });
  if (hits.length === 0) return [{ kind: "note", key: "", depth: 0, text: noMatches }];
  return hits.map((h) => ({ kind: "entry", key: "e:" + h.entry.id, depth: 0, text: h.entry.path, entry: h.entry, matchTag: h.tag }));
}

/** A list's remembered cursor: the item (§5.5) and the index it was last seen at. */
export interface Cursor {
  key: string;
  index: number;
}

/**
 * Finds the cursor's row: its item if still listed, else the nearest selectable row at the
 * same index (looking down first, then up); -1 when nothing is selectable.
 */
export function resolveCursor(rows: readonly Row[], cur: Cursor): number {
  if (cur.key) {
    const i = rows.findIndex((r) => r.key === cur.key);
    if (i >= 0) return i;
  }
  if (rows.length === 0) return -1;
  const start = Math.min(Math.max(cur.index, 0), rows.length - 1);
  for (let i = start; i < rows.length; i++) if (selectable(rows[i])) return i;
  for (let i = start - 1; i >= 0; i--) if (selectable(rows[i])) return i;
  return -1;
}

/** Moves from row i by d selectable rows, stopping at the ends (no wrap). */
export function moveBy(rows: readonly Row[], i: number, d: number): number {
  if (i < 0) return firstSelectable(rows);
  let cur = i;
  const step = d > 0 ? 1 : -1;
  let left = Math.abs(d);
  let j = i;
  while (left > 0) {
    j += step;
    if (j < 0 || j >= rows.length) break;
    if (selectable(rows[j])) {
      cur = j;
      left--;
    }
  }
  return cur;
}

export function firstSelectable(rows: readonly Row[]): number {
  return rows.findIndex((r) => selectable(r));
}

export function lastSelectable(rows: readonly Row[]): number {
  for (let i = rows.length - 1; i >= 0; i--) if (selectable(rows[i])) return i;
  return -1;
}

/** The folder of a row for `a` (§7.2) and the print scope (§7.8): a folder row's own path, an entry's folder. */
export function folderOfRow(r: Row | undefined): string {
  if (!r) return "";
  if (r.kind === "folder") return r.folder!;
  if (r.kind === "entry") return parentFolder(r.entry!.path);
  return "";
}

/** Entries inside a folder at any depth (segment-aware). */
export function countIn(ix: Index, folder: string): number {
  return ix.folders.get(folder)?.count ?? 0;
}

/** Entries that have all the tags. */
export function countWithTags(ix: Index, tags: readonly string[]): number {
  return ix.sorted.filter((e) => hasAllTags(e.tags, tags)).length;
}
