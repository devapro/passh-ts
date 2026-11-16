// Fuzzy matching (cli.md "Fuzzy matching"), the score of `passh find` (cli.md §2.4) and of
// the TUI search (tui.md §5.4). The rules are those of sahilm/fuzzy v0.1.3's fuzzy.Find,
// written out in the spec; the spec's vectors are the tests.

import { comparePaths } from "../paths/index.ts";
import { compareUTF8, decodeRuneIn, isLower, isUpper, isWhiteSpace, runeFoldEquals, toBytes } from "../util/unicode.ts";

export interface FuzzyMatch {
  /** Index of the target in the list given to fuzzyFind. */
  index: number;
  /** The target string. */
  str: string;
  score: number;
  /** Byte offsets (UTF-8) of the chosen characters in the target. */
  positions: number[];
  /** The same positions as UTF-16 indexes into `str` (for highlighting). */
  indexes: number[];
}

const SEPARATORS = new Set([0x2f, 0x2d, 0x5f, 0x20, 0x2e, 0x5c, 0x3a]); // / - _ space . \ :

/** The characters of a target: [code point, byte offset], U+FFFD for an invalid byte; ends at U+0000. */
function chars(b: Uint8Array): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let j = 0;
  while (j < b.length) {
    const [cp0, size] = b[j]! < 0x80 ? [b[j]!, 1] : decodeRuneIn(b, j, b.length);
    const cp = cp0 < 0 ? 0xfffd : cp0;
    if (cp === 0) break; // S ends at its first U+0000
    out.push([cp, j]);
    j += size;
  }
  return out;
}

/**
 * Scores one target (cli.md, fuzzy matching). Returns undefined when the pattern doesn't
 * match (an empty pattern never matches).
 */
export function fuzzyMatch(pattern: string, target: string | Uint8Array): { score: number; positions: number[] } | undefined {
  const P: number[] = [];
  for (const ch of pattern) P.push(ch.codePointAt(0)!);
  if (P.length === 0) return undefined;
  const bytes = toBytes(target);
  const S = chars(bytes);
  let k = 0;
  let total = 0;
  const chosen: number[] = [];
  let best = -1;
  let at = -1;
  let run = 0;
  let prev = -1; // none
  let prevAt = 0;
  for (let i = 0; i < S.length && k < P.length; i++) {
    const [c, j] = S[i]!;
    const next = i + 1 < S.length ? S[i + 1]![0] : -1;
    if (runeFoldEquals(c, P[k]!)) {
      let s = 0;
      if (j === 0) s += 10;
      if (prev >= 0 && isLower(prev) && isUpper(c)) s += 20; // camelCase
      if (j > 0 && SEPARATORS.has(prev)) s += 20; // after a separator
      if (chosen.length > 0 && prevAt === chosen[chosen.length - 1]) {
        const b = 2 * run + 5;
        s += b;
        run += b;
      }
      if (s > best) {
        best = s;
        at = j;
      }
    }
    if ((k < P.length - 1 && next >= 0 && runeFoldEquals(next, P[k + 1]!)) || next < 0) {
      if (at >= 0) {
        if (chosen.length === 0) best += Math.max(-5 * at, -15);
        total += best;
        chosen.push(at);
        best = -1;
        at = -1;
        k++;
      }
    }
    prev = c;
    prevAt = j;
  }
  if (chosen.length < P.length) return undefined;
  return { score: total + chosen.length - bytes.length, positions: chosen };
}

/** Converts UTF-8 byte offsets of a string into UTF-16 indexes. */
export function byteOffsetsToIndexes(s: string, offsets: readonly number[]): number[] {
  const want = new Set(offsets);
  const out: number[] = [];
  let byte = 0;
  for (let i = 0; i < s.length; i++) {
    if (want.has(byte)) out.push(i);
    const c = s.charCodeAt(i);
    if (c < 0x80) byte += 1;
    else if (c < 0x800) byte += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      byte += 4;
      i++;
    } else byte += 3;
  }
  return out;
}

/**
 * Matches the pattern against every target. Results are sorted by score, highest first;
 * equal scores keep the order of `targets` unless `tie` orders them (the callers decide
 * ties: cli.md §2.4, tui.md §5.4).
 */
export function fuzzyFind(pattern: string, targets: readonly string[], tie?: (a: string, b: string) => number): FuzzyMatch[] {
  const out: FuzzyMatch[] = [];
  targets.forEach((str, index) => {
    const m = fuzzyMatch(pattern, str);
    if (m) out.push({ index, str, score: m.score, positions: m.positions, indexes: byteOffsetsToIndexes(str, m.positions) });
  });
  out.sort((a, b) => b.score - a.score || (tie ? tie(a.str, b.str) : 0) || a.index - b.index);
  return out;
}

// ---------------------------------------------------------------------------
// Ranking entries by path and tags

export interface SearchableEntry {
  path: string;
  tags: readonly string[];
}

export interface EntryHit<E extends SearchableEntry = SearchableEntry> {
  entry: E;
  /** The hit's score (find: a tag counts t − 1; TUI: t). */
  score: number;
  /** The tag the entry matched through, when a tag won over the path. */
  tag?: string;
  /** Byte offsets of the match in the path, or in the tag when `tag` is set. */
  positions: number[];
}

export interface RankOptions {
  /**
   * "find" (cli.md §2.4): a tag counts t − 1, ties by path segment by segment, an empty query
   * matches nothing. "tui" (tui.md §5.4): a tag counts t, an empty or white-space-only query
   * lists every entry (path order), ties by `tuiTies`.
   */
  mode: "find" | "tui";
  /**
   * TUI ties: "bytes" (the reference: plain byte order of the whole path, `work-old/y`
   * before `work/x`) or "segments" (the proposed fix of audit #18: path order). Default "bytes".
   */
  tuiTies?: "bytes" | "segments";
}

/**
 * Ranks entries for a query by their path and tags (cli.md §2.4 for `find`, tui.md §5.4 for
 * the TUI search). The query is used as given: not normalized, not trimmed.
 */
// SPEC-GAP: audit #18/#38: the TUI's tie order defaults to the reference's plain byte order
// (`tuiTies: "segments"` is the proposed fix); audit #37: the query isn't normalized to NFC
// here, as in passh v0.6 (a caller may normalize it to apply the proposed fix).
export function rankEntries<E extends SearchableEntry>(query: string, entries: readonly E[], opts: RankOptions): EntryHit<E>[] {
  const sorted = [...entries].sort((a, b) => comparePaths(a.path, b.path));
  if (opts.mode === "tui" && [...query].every((ch) => isWhiteSpace(ch.codePointAt(0)!))) {
    return sorted.map((entry) => ({ entry, score: 0, positions: [] }));
  }
  if (query === "") return [];
  // Distinct tags in order of first appearance: entries in path order, tags in stored order.
  const tagOrder = new Map<string, number>();
  for (const e of sorted) for (const t of e.tags) if (!tagOrder.has(t)) tagOrder.set(t, tagOrder.size);
  const tagScores = new Map<string, { score: number; positions: number[] }>();
  for (const t of tagOrder.keys()) {
    const m = fuzzyMatch(query, t);
    if (m) tagScores.set(t, m);
  }
  const tagPenalty = opts.mode === "find" ? 1 : 0;
  const hits: EntryHit<E>[] = [];
  for (const entry of sorted) {
    let hit: EntryHit<E> | undefined;
    const p = fuzzyMatch(query, entry.path);
    if (p) hit = { entry, score: p.score, positions: p.positions };
    // The entry's best tag: highest score, then first in the tag list.
    let bestTag: string | undefined;
    for (const t of entry.tags) {
      const m = tagScores.get(t);
      if (!m) continue;
      if (bestTag === undefined) {
        bestTag = t;
        continue;
      }
      const b = tagScores.get(bestTag)!;
      if (m.score > b.score || (m.score === b.score && tagOrder.get(t)! < tagOrder.get(bestTag)!)) bestTag = t;
    }
    if (bestTag !== undefined) {
      const m = tagScores.get(bestTag)!;
      const s = m.score - tagPenalty;
      if (!hit || s > hit.score) hit = { entry, score: s, tag: bestTag, positions: m.positions };
    }
    if (hit) hits.push(hit);
  }
  const ties = opts.mode === "find" || opts.tuiTies === "segments" ? comparePaths : compareUTF8;
  hits.sort((a, b) => b.score - a.score || ties(a.entry.path, b.entry.path));
  return hits;
}
