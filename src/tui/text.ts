// Styled text for the TUI: spans of text with a style, measured in display cells, plus
// wrapping, truncation, padding and the S4 escaping of values (tui.md §12).
//
// A frame is a list of lines; a line is a list of spans. Values from the vault are escaped
// (single-line S4 form) where they are drawn, with `v()`; fixed texts are passed as is.

import { escapeLine, stringWidth } from "../sanitize/index.ts";
import { isFormat, isLetter, isMark, isNumber, isSymbol } from "../util/unicode.ts";

/** Style bits (tui.md §12; only the basic attributes and 16 colours). */
export const S = {
  none: 0,
  bold: 1,
  faint: 2,
  reverse: 4,
  red: 8,
  yellow: 16,
  cyan: 32,
} as const;

export type Style = number;

export interface Span {
  t: string;
  s: Style;
}

export type Line = Span[];

export function span(t: string, s: Style = 0): Span {
  return { t, s };
}

/** A line of one span. */
export function line(t: string, s: Style = 0): Line {
  return t === "" ? [] : [{ t, s }];
}

/** S4 single-line escape of a value (tui.md §12). */
export function v(s: string): string {
  return escapeLine(s);
}

/** Display width of plain text (escaped; no control characters). */
export function width(s: string): number {
  return stringWidth(s);
}

export function lineWidth(l: Line): number {
  let w = 0;
  for (const sp of l) w += width(sp.t);
  return w;
}

export function lineText(l: Line): string {
  return l.map((s) => s.t).join("");
}

/** Code points of a string. */
export function chars(s: string): string[] {
  return Array.from(s);
}

/** Cuts plain text to at most w cells; with `tail` ("…") when something was cut. */
export function truncate(s: string, w: number, tail = "…"): string {
  if (w <= 0) return "";
  if (width(s) <= w) return s;
  const tw = width(tail);
  if (tw > w) return "";
  let out = "";
  let used = 0;
  for (const c of chars(s)) {
    const cw = width(c);
    if (used + cw > w - tw) break;
    out += c;
    used += cw;
  }
  return out + tail;
}

/** Cuts a styled line to at most w cells, with "…" (in the last span's style) when cut. */
export function truncLine(l: Line, w: number, tail = "…"): Line {
  if (lineWidth(l) <= w) return l;
  const tw = width(tail);
  const out: Line = [];
  let used = 0;
  let lastStyle = 0;
  for (const sp of l) {
    lastStyle = sp.s;
    let t = "";
    let full = true;
    for (const c of chars(sp.t)) {
      const cw = width(c);
      if (used + cw > w - tw) {
        full = false;
        break;
      }
      t += c;
      used += cw;
    }
    if (t) out.push({ t, s: sp.s });
    if (!full) break;
  }
  if (tw <= w) out.push({ t: tail, s: lastStyle & ~S.reverse });
  return out;
}

/** Cuts a styled line to w cells without a marker. */
export function clipLine(l: Line, w: number): Line {
  if (lineWidth(l) <= w) return l;
  const out: Line = [];
  let used = 0;
  for (const sp of l) {
    let t = "";
    let full = true;
    for (const c of chars(sp.t)) {
      const cw = width(c);
      if (used + cw > w) {
        full = false;
        break;
      }
      t += c;
      used += cw;
    }
    if (t) out.push({ t, s: sp.s });
    if (!full) break;
  }
  return out;
}

/** Pads a styled line with spaces (in style `s`) to exactly w cells (cutting if wider). */
export function padLine(l: Line, w: number, s: Style = 0): Line {
  const lw = lineWidth(l);
  if (lw > w) return padLine(clipLine(l, w), w, s);
  if (lw === w) return l;
  return [...l, { t: " ".repeat(w - lw), s }];
}

/** Applies extra style bits to every span of a line. */
export function restyle(l: Line, add: Style): Line {
  return l.map((sp) => ({ t: sp.t, s: sp.s | add }));
}

/**
 * Wraps plain text to lines of at most w cells, breaking at spaces where possible and
 * inside words that are longer than a line. Leading spaces of continuation lines are
 * dropped. An empty text gives one empty line.
 */
export function wrap(text: string, w: number): string[] {
  if (w < 1) w = 1;
  if (width(text) <= w) return [text];
  const out: string[] = [];
  const cs = chars(text);
  let cur: string[] = [];
  let curW = 0;
  let lastSpace = -1; // index in cur of the last space
  for (const c of cs) {
    const cw = width(c);
    if (curW + cw > w) {
      if (c === " ") {
        out.push(cur.join("").replace(/ +$/, ""));
        cur = [];
        curW = 0;
        lastSpace = -1;
        continue;
      }
      if (lastSpace > 0) {
        const head = cur.slice(0, lastSpace).join("").replace(/ +$/, "");
        const rest = cur.slice(lastSpace + 1);
        out.push(head);
        cur = rest;
        curW = width(rest.join(""));
      } else {
        out.push(cur.join(""));
        cur = [];
        curW = 0;
      }
      lastSpace = -1;
      for (let i = 0; i < cur.length; i++) if (cur[i] === " ") lastSpace = i;
      if (cur.length === 0 && c === " ") continue;
    }
    if (c === " ") lastSpace = cur.length;
    cur.push(c);
    curW += cw;
  }
  out.push(cur.join(""));
  return out;
}

/** Wraps text that may hold line breaks: each line is wrapped on its own. */
export function wrapLines(text: string, w: number): string[] {
  return text.split("\n").flatMap((l) => wrap(l, w));
}

/** Wraps a list of items joined by `sep`, breaking only between items. */
export function wrapItems(items: string[], sep: string, w: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const it of items) {
    if (cur === "") {
      cur = it;
      continue;
    }
    if (width(cur + sep + it) <= w) cur += sep + it;
    else {
      out.push(cur);
      cur = it;
    }
  }
  if (cur !== "" || out.length === 0) out.push(cur);
  return out.flatMap((l) => (width(l) > w ? wrap(l, w) : [l]));
}

// ---------------------------------------------------------------------------
// Per-character escaping, for inputs where the cursor moves over each character as one unit
// (tui.md §11.1: "control characters show as escapes and the cursor moves over each as one
// unit").

function visibleNonASCII(cp: number): boolean {
  if (cp < 0x80 || cp === 0xfffd) return false;
  return isLetter(cp) || isMark(cp) || isNumber(cp) || isSymbol(cp);
}

/**
 * The S4 single-line rendering of each code point of `cs`, with the ZWNJ/ZWJ rule applied
 * in context (§A9.1 rule 3). The concatenation equals escapeLine(cs.join("")).
 */
export function escapeUnits(cs: readonly string[]): string[] {
  const out: string[] = new Array(cs.length);
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]!;
    const cp = c.codePointAt(0)!;
    if ((cp === 0x200c || cp === 0x200d) && i > 0 && i + 1 < cs.length) {
      const a = cs[i - 1]!.codePointAt(0)!;
      const b = cs[i + 1]!.codePointAt(0)!;
      if (visibleNonASCII(a) && visibleNonASCII(b) && !isFormat(a)) {
        out[i] = c;
        continue;
      }
    }
    out[i] = escapeLine(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering to the terminal

const SGR_OF: Array<[Style, string]> = [
  [S.bold, "1"],
  [S.faint, "2"],
  [S.reverse, "7"],
  [S.red, "31"],
  [S.yellow, "33"],
  [S.cyan, "36"],
];

/** SGR sequence for a style ("" for none). */
export function sgr(s: Style): string {
  if (s === 0) return "";
  const ps: string[] = [];
  for (const [bit, p] of SGR_OF) if (s & bit) ps.push(p);
  return "\x1b[" + ps.join(";") + "m";
}

/** Renders a line as text with SGR sequences, ending with a reset if styled. */
export function renderLine(l: Line): string {
  let out = "";
  let cur = 0;
  for (const sp of l) {
    if (sp.t === "") continue;
    if (sp.s !== cur) {
      if (cur !== 0) out += "\x1b[m";
      out += sgr(sp.s);
      cur = sp.s;
    }
    out += sp.t;
  }
  if (cur !== 0) out += "\x1b[m";
  return out;
}

const ALLOWED_SGR = new Set(["", "0", "1", "2", "7", "22", "27", "39", "30", "31", "32", "33", "34", "35", "36", "37", "90", "91", "92", "93", "94", "95", "96", "97"]);

/**
 * The final filter of every frame (tui.md §12): escapes any ESC sequence except SGR with
 * the parameters 0 1 2 7 22 27 39 30–37 90–97, escapes other control characters, and turns
 * tabs into spaces. A value that missed its own escaping still can't drive the terminal.
 */
export function filterFrame(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x1b) {
      const m = /^\x1b\[([0-9;]*)m/.exec(s.slice(i, i + 64));
      if (m && m[1]!.split(";").every((p) => ALLOWED_SGR.has(p))) {
        out += m[0];
        i += m[0].length - 1;
        continue;
      }
      out += "\\x1b";
      continue;
    }
    if (c === 0x09) {
      out += " ";
      continue;
    }
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) {
      out += escapeLine(s[i]!);
      continue;
    }
    out += s[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Times (tui.md §2)

/** A countdown as m:ss, or h:mm:ss from one hour; rounded up to whole seconds. */
export function countdown(ms: number): string {
  let sec = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(sec / 3600);
  sec -= h * 3600;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/** Whole seconds left, rounded up. */
export function secondsLeft(ms: number): number {
  return Math.ceil(Math.max(0, ms) / 1000);
}
