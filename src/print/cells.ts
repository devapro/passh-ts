// The layout grid's cells, widths, ambiguity marks and wrapping (print.md §3.2–§3.4).
// Text reaching these functions has already been escaped by S4 (sanitize), so it holds no
// control characters; the cells add the print sheets' own escapes for what would be
// invisible or misleading on paper.

import { generalCategory, isWide, isWhiteSpace } from "../util/unicode.ts";

/** Line width of the sheets (print.md §3.1). */
export const COLUMNS = 80;
/** Value column width: 80 − the 12-column value prefix. */
export const VALUE_WIDTH = 68;
/** The value prefix: 2 blanks of indent + a 10-column label column. */
export const VALUE_PREFIX = 12;
/** The continuation mark (U+2192). */
export const CONTINUATION = "→";

/** What a run of text marks (print.md §3.3): nothing, the five characters, or those and spaces. */
export type MarkMode = "none" | "chars" | "spaces";

/** One unbreakable unit of laid-out text. */
export interface Cell {
  text: string;
  /** Display columns. */
  width: number;
  /** The ambiguity code (`D`, `U`, `L`, `S`) or "". */
  mark: string;
  /** A `\uXXXX` cell made by the layout (rules 1 and 2): never marked, nothing joins it. */
  escape: boolean;
}

function uEscape(cp: number): string {
  if (cp > 0xffff) return "\\U" + cp.toString(16).padStart(8, "0");
  return "\\u" + cp.toString(16).padStart(4, "0");
}

/**
 * Rule 1: a rune invisible or misleading on paper: not U+0020 and in Cf, Zs, Zl, Zp, Co, Cc,
 * or in none of L, M, N, P, S (unassigned, surrogates).
 */
function invisible(cp: number): boolean {
  if (cp === 0x20) return false;
  const gc = generalCategory(cp);
  switch (gc[0]) {
    case "L":
    case "M":
    case "N":
    case "P":
    case "S":
      return false;
    case "Z":
      return true;
    default:
      return true; // Cc, Cf, Co, Cs, Cn
  }
}

function markOf(cp: number, mode: MarkMode): string {
  if (mode === "none") return "";
  switch (cp) {
    case 0x30: // 0
    case 0x31: // 1
      return "D";
    case 0x4f: // O
    case 0x49: // I
      return "U";
    case 0x6c: // l
      return "L";
    case 0x20:
      return mode === "spaces" ? "S" : "";
    default:
      return "";
  }
}

/** Splits text into cells (print.md §3.2), with marks per `mode` (§3.3). */
export function cellsOf(text: string, mode: MarkMode = "none"): Cell[] {
  const cells: Cell[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    const ch = text.slice(i, i + len);
    i += len;
    if (cp < 0x80 && cp >= 0x20 && cp !== 0x7f) {
      cells.push({ text: ch, width: 1, mark: markOf(cp, mode), escape: false });
      continue;
    }
    const gc = generalCategory(cp);
    if (gc === "Mn" || gc === "Me") {
      const prev = cells[cells.length - 1];
      if (prev && prev.mark === "" && !prev.escape) {
        prev.text += ch;
        continue;
      }
      const e = uEscape(cp);
      cells.push({ text: e, width: e.length, mark: "", escape: true });
      continue;
    }
    if (invisible(cp)) {
      const e = uEscape(cp);
      cells.push({ text: e, width: e.length, mark: "", escape: true });
      continue;
    }
    cells.push({ text: ch, width: isWide(cp) ? 2 : 1, mark: "", escape: false });
  }
  return cells;
}

/** The text of cells. */
export function cellText(cells: readonly Cell[]): string {
  let s = "";
  for (const c of cells) s += c.text;
  return s;
}

/** The display width of cells. */
export function cellWidth(cells: readonly Cell[]): number {
  let w = 0;
  for (const c of cells) w += c.width;
  return w;
}

/**
 * The marks line of cells (print.md §3.3), without the 12-column prefix: per cell its code
 * followed by width−1 blanks, or width blanks; trailing blanks removed. "" when nothing is
 * marked.
 */
export function marksOf(cells: readonly Cell[]): string {
  let s = "";
  let any = false;
  for (const c of cells) {
    if (c.mark) {
      any = true;
      s += c.mark + " ".repeat(Math.max(0, c.width - 1));
    } else s += " ".repeat(c.width);
  }
  return any ? s.trimEnd() : "";
}

/**
 * Breaks cells into chunks of at most `width` columns between cells; a cell wider than
 * `width` gets a chunk of its own. An empty input gives one empty chunk.
 */
export function chunkCells(cells: readonly Cell[], width: number): Cell[][] {
  const out: Cell[][] = [];
  let cur: Cell[] = [];
  let w = 0;
  for (const c of cells) {
    if (cur.length > 0 && w + c.width > width) {
      out.push(cur);
      cur = [];
      w = 0;
    }
    cur.push(c);
    w += c.width;
  }
  if (cur.length > 0 || out.length === 0) out.push(cur);
  return out;
}

/** Hard wrap (names and headings, print.md §3.4): lines of at most `width` columns, by cells. */
export function hardWrap(text: string, width: number = COLUMNS): string[] {
  return chunkCells(cellsOf(text), width).map(cellText);
}

/** Splits prose into words at Unicode White_Space (runs collapse, no empty words). */
export function words(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (isWhiteSpace(ch.codePointAt(0)!)) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Prose wrap (print.md §3.4): words split at white space, rejoined with single spaces,
 * greedy fill to `width` columns; a word longer than a line is broken by cells. Returns at
 * least one line ("" for empty prose).
 */
export function proseWrap(text: string, width: number = COLUMNS): string[] {
  const lines: string[] = [];
  let line: Cell[] = [];
  let w = 0;
  for (const word of words(text)) {
    const cells = cellsOf(word);
    const ww = cellWidth(cells);
    if (line.length > 0 && w + 1 + ww <= width) {
      line.push({ text: " ", width: 1, mark: "", escape: false }, ...cells);
      w += 1 + ww;
      continue;
    }
    if (line.length > 0) {
      lines.push(cellText(line));
      line = [];
      w = 0;
    }
    if (ww <= width) {
      line = cells;
      w = ww;
      continue;
    }
    // A word longer than a line: full chunks become lines, the last one continues the fill.
    const chunks = chunkCells(cells, width);
    for (let k = 0; k < chunks.length - 1; k++) lines.push(cellText(chunks[k]!));
    line = chunks[chunks.length - 1]!;
    w = cellWidth(line);
  }
  if (line.length > 0 || lines.length === 0) lines.push(cellText(line));
  return lines;
}

/** Display width of laid-out text (print.md §3.2): the width of its cells. */
export function textWidth(text: string): number {
  return cellWidth(cellsOf(text));
}
