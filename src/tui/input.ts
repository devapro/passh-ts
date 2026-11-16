// Text inputs: the one-line input (form fields, prompts, search, passphrase) and the notes
// text area, with the readline-style editing keys of tui.md §11.4 and masked editing for
// hidden values (S5).

import { decodeUTF8Strict } from "../util/unicode.ts";
import type { KeyMsg } from "./keys.ts";
import { S, chars, escapeUnits, width, type Line } from "./text.ts";

/** The fixed mask (S5, tui.md §2). */
export const MASK = "••••••••";

function isSpace(c: string | undefined): boolean {
  return c !== undefined && /^\s$/u.test(c);
}

/** What a key did to an input. */
export type EditResult = "changed" | "moved" | "ignored";

/** A paste refused or decoded (tui.md §11.4). */
export type PasteText = { ok: true; text: string } | { ok: false; reason: "utf8" | "lines" };

/**
 * Decodes a paste for a single-line input: valid UTF-8, one trailing line break (CRLF,
 * LF or CR) dropped, no line break inside.
 */
export function pasteOneLine(bytes: Uint8Array): PasteText {
  const s = decodeUTF8Strict(bytes);
  if (s === undefined) return { ok: false, reason: "utf8" };
  let t = s;
  if (t.endsWith("\r\n")) t = t.slice(0, -2);
  else if (t.endsWith("\n") || t.endsWith("\r")) t = t.slice(0, -1);
  if (/[\r\n]/.test(t)) return { ok: false, reason: "lines" };
  return { ok: true, text: t };
}

/** Decodes a paste for the notes: valid UTF-8, CRLF and CR turned into LF. */
export function pasteMultiLine(bytes: Uint8Array): PasteText {
  const s = decodeUTF8Strict(bytes);
  if (s === undefined) return { ok: false, reason: "utf8" };
  return { ok: true, text: s.replace(/\r\n?/g, "\n") };
}

/** A one-line text input. The value is a list of code points; the cursor sits between them. */
export class LineInput {
  cs: string[];
  pos: number;
  masked: boolean;

  constructor(value = "", masked = false) {
    this.cs = chars(value);
    this.pos = this.cs.length;
    this.masked = masked;
  }

  get value(): string {
    return this.cs.join("");
  }

  set(value: string): void {
    this.cs = chars(value);
    this.pos = this.cs.length;
  }

  /** Overwrites the content (best effort for a JS string) and empties the input. */
  wipe(): void {
    this.cs.fill("\0");
    this.cs = [];
    this.pos = 0;
  }

  insert(text: string): void {
    const add = chars(text);
    if (this.masked) {
      this.cs.push(...add);
      this.pos = this.cs.length;
      return;
    }
    this.cs.splice(this.pos, 0, ...add);
    this.pos += add.length;
  }

  /** Handles an editing key (§11.4). Text keys insert their text. */
  handleKey(k: KeyMsg): EditResult {
    if (k.text) {
      this.insert(k.text);
      return "changed";
    }
    if (this.masked) return this.maskedKey(k.key);
    const n = this.cs.length;
    switch (k.key) {
      case "left":
      case "ctrl+b":
        if (this.pos > 0) this.pos--;
        return "moved";
      case "right":
      case "ctrl+f":
        if (this.pos < n) this.pos++;
        return "moved";
      case "home":
      case "ctrl+a":
        this.pos = 0;
        return "moved";
      case "end":
      case "ctrl+e":
        this.pos = n;
        return "moved";
      case "alt+left":
      case "ctrl+left":
      case "alt+b":
        this.pos = wordLeft(this.cs, this.pos);
        return "moved";
      case "alt+right":
      case "ctrl+right":
      case "alt+f":
        this.pos = wordRight(this.cs, this.pos);
        return "moved";
      case "backspace":
      case "ctrl+h":
        if (this.pos === 0) return "ignored";
        this.cs.splice(this.pos - 1, 1);
        this.pos--;
        return "changed";
      case "delete":
      case "ctrl+d":
        if (this.pos >= n) return "ignored";
        this.cs.splice(this.pos, 1);
        return "changed";
      case "ctrl+w":
      case "alt+backspace":
      case "ctrl+backspace": {
        const to = wordLeft(this.cs, this.pos);
        if (to === this.pos) return "ignored";
        this.cs.splice(to, this.pos - to);
        this.pos = to;
        return "changed";
      }
      case "alt+d":
      case "alt+delete":
      case "ctrl+delete": {
        const to = wordRight(this.cs, this.pos);
        if (to === this.pos) return "ignored";
        this.cs.splice(this.pos, to - this.pos);
        return "changed";
      }
      case "ctrl+u":
        if (this.pos === 0) return "ignored";
        this.cs.splice(0, this.pos);
        this.pos = 0;
        return "changed";
      case "ctrl+k":
        if (this.pos >= n) return "ignored";
        this.cs.splice(this.pos);
        return "changed";
      default:
        return "ignored";
    }
  }

  /** Masked editing (§11.4): append only; Backspace removes the last character. */
  private maskedKey(name: string): EditResult {
    switch (name) {
      case "backspace":
      case "ctrl+h":
        if (this.cs.length === 0) return "ignored";
        this.cs.pop();
        this.pos = this.cs.length;
        return "changed";
      case "ctrl+u":
      case "ctrl+w":
      case "alt+backspace":
      case "ctrl+backspace":
        if (this.cs.length === 0) return "ignored";
        this.wipe();
        return "changed";
      default:
        return "ignored";
    }
  }

  /**
   * Draws the input in `w` cells. Focused: the cursor (reverse video) is shown and the text
   * scrolls to keep it visible. Unfocused: a value that doesn't fit ends in "…".
   * `showMasked` draws the Mask instead of the value (when not empty).
   */
  view(w: number, focused: boolean, opts: { showMasked?: boolean; style?: number } = {}): Line {
    const st = opts.style ?? 0;
    if (opts.showMasked) {
      const out: Line = [];
      if (this.cs.length > 0) out.push({ t: MASK, s: st });
      if (focused) out.push({ t: " ", s: S.reverse });
      return out;
    }
    const units = escapeUnits(this.cs);
    return renderUnits(units, focused ? this.pos : -1, w, st);
  }
}

/** Renders escaped units with an optional cursor at unit index `cur` (-1: none). */
export function renderUnits(units: string[], cur: number, w: number, st = 0): Line {
  if (w < 1) return [];
  const widths = units.map((u) => width(u));
  if (cur < 0) {
    const total = widths.reduce((a, b) => a + b, 0);
    if (total <= w) return units.length ? [{ t: units.join(""), s: st }] : [];
    // cut with "…"
    let used = 0;
    let t = "";
    for (let i = 0; i < units.length; i++) {
      if (used + widths[i]! > w - 1) break;
      t += units[i];
      used += widths[i]!;
    }
    return [{ t: t + "…", s: st }];
  }
  // focused: the cursor cell is the unit at cur, or a space after the end
  const curW = cur < units.length ? Math.max(1, widths[cur]!) : 1;
  let start = 0;
  let before = 0;
  for (let i = 0; i < cur; i++) before += widths[i]!;
  while (start < cur && before + curW > w) {
    before -= widths[start]!;
    start++;
  }
  const out: Line = [];
  let used = 0;
  let t = "";
  for (let i = start; i < units.length && i < cur; i++) {
    t += units[i];
    used += widths[i]!;
  }
  if (t) out.push({ t, s: st });
  const cu = cur < units.length ? units[cur]! : " ";
  out.push({ t: widths[cur] === 0 ? cu + " " : cu, s: st | S.reverse });
  used += curW;
  t = "";
  for (let i = cur + 1; i < units.length; i++) {
    if (used + widths[i]! > w) break;
    t += units[i];
    used += widths[i]!;
  }
  if (t) out.push({ t, s: st });
  return out;
}

function wordLeft(cs: string[], pos: number): number {
  let i = pos;
  while (i > 0 && isSpace(cs[i - 1])) i--;
  while (i > 0 && !isSpace(cs[i - 1])) i--;
  return i;
}

function wordRight(cs: string[], pos: number): number {
  let i = pos;
  const n = cs.length;
  while (i < n && isSpace(cs[i])) i++;
  while (i < n && !isSpace(cs[i])) i++;
  return i;
}

// ---------------------------------------------------------------------------
// Notes text area

interface VisualRow {
  line: number;
  start: number; // first unit (code point) index in the line
  end: number; // one past the last unit
}

/** The notes editor: soft-wrapped lines, visual-row movement, the §11.4 editing keys. */
export class TextArea {
  lines: string[][];
  row = 0;
  col = 0;
  private goalX = -1;

  constructor(value = "") {
    this.lines = value.split("\n").map((l) => chars(l));
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row]!.length;
  }

  get value(): string {
    return this.lines.map((l) => l.join("")).join("\n");
  }

  set(value: string): void {
    this.lines = value.split("\n").map((l) => chars(l));
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row]!.length;
    this.goalX = -1;
  }

  private get cur(): string[] {
    return this.lines[this.row]!;
  }

  insert(text: string): void {
    const parts = text.split("\n");
    const line = this.cur;
    const tail = line.splice(this.col);
    const first = chars(parts[0]!);
    line.splice(this.col, 0, ...first);
    this.col += first.length;
    if (parts.length > 1) {
      const rest = parts.slice(1).map((p) => chars(p));
      const last = rest[rest.length - 1]!;
      const newCol = last.length;
      last.push(...tail);
      this.lines.splice(this.row + 1, 0, ...rest);
      this.row += rest.length;
      this.col = newCol;
    } else {
      line.push(...tail);
    }
    this.goalX = -1;
  }

  newline(): void {
    this.insert("\n");
  }

  /**
   * Handles an editing key; vertical keys need the layout width and height. Returns
   * "ignored" for a key it doesn't handle (e.g. ↑ on the first visual row: the form
   * moves to the previous field).
   */
  handleKey(k: KeyMsg, w: number, h: number): EditResult {
    if (k.text) {
      this.insert(k.text);
      return "changed";
    }
    const line = this.cur;
    const n = line.length;
    const vertical = ["up", "down", "ctrl+p", "ctrl+n", "pgup", "pgdown"].includes(k.key);
    if (!vertical) this.goalX = -1;
    switch (k.key) {
      case "enter":
      case "ctrl+j":
      case "ctrl+m":
        this.newline();
        return "changed";
      case "left":
      case "ctrl+b":
        if (this.col > 0) this.col--;
        else if (this.row > 0) {
          this.row--;
          this.col = this.cur.length;
        }
        return "moved";
      case "right":
      case "ctrl+f":
        if (this.col < n) this.col++;
        else if (this.row < this.lines.length - 1) {
          this.row++;
          this.col = 0;
        }
        return "moved";
      case "home":
      case "ctrl+a":
        this.col = 0;
        return "moved";
      case "end":
      case "ctrl+e":
        this.col = n;
        return "moved";
      case "alt+left":
      case "ctrl+left":
      case "alt+b":
        this.col = wordLeft(line, this.col);
        return "moved";
      case "alt+right":
      case "ctrl+right":
      case "alt+f":
        this.col = wordRight(line, this.col);
        return "moved";
      case "backspace":
      case "ctrl+h":
        if (this.col > 0) {
          line.splice(this.col - 1, 1);
          this.col--;
          return "changed";
        }
        if (this.row === 0) return "ignored";
        return this.joinWithPrevious();
      case "delete":
      case "ctrl+d":
        if (this.col < n) {
          line.splice(this.col, 1);
          return "changed";
        }
        return this.joinWithNext();
      case "ctrl+w":
      case "alt+backspace":
      case "ctrl+backspace": {
        const to = wordLeft(line, this.col);
        if (to === this.col) return "ignored";
        line.splice(to, this.col - to);
        this.col = to;
        return "changed";
      }
      case "alt+d":
      case "alt+delete":
      case "ctrl+delete": {
        if (this.col >= n) return this.joinWithNext();
        const to = wordRight(line, this.col);
        line.splice(this.col, to - this.col);
        return "changed";
      }
      case "ctrl+u":
        if (this.col === 0) return "ignored";
        line.splice(0, this.col);
        this.col = 0;
        return "changed";
      case "ctrl+k":
        if (this.col >= n) return this.joinWithNext();
        line.splice(this.col);
        return "changed";
      case "up":
      case "ctrl+p":
        return this.moveRows(-1, w);
      case "down":
      case "ctrl+n":
        return this.moveRows(1, w);
      case "pgup":
        return this.moveRows(-Math.max(1, h - 1), w);
      case "pgdown":
        return this.moveRows(Math.max(1, h - 1), w);
      default:
        return "ignored";
    }
  }

  private joinWithPrevious(): EditResult {
    const prev = this.lines[this.row - 1]!;
    const col = prev.length;
    prev.push(...this.cur);
    this.lines.splice(this.row, 1);
    this.row--;
    this.col = col;
    return "changed";
  }

  private joinWithNext(): EditResult {
    if (this.row >= this.lines.length - 1) return "ignored";
    this.cur.push(...this.lines[this.row + 1]!);
    this.lines.splice(this.row + 1, 1);
    return "changed";
  }

  /** Visual rows for a text width: each line soft-wrapped at spaces (one cell kept for the cursor). */
  layout(w: number): VisualRow[] {
    const cap = Math.max(1, w - 1);
    const rows: VisualRow[] = [];
    this.lines.forEach((l, li) => {
      const units = escapeUnits(l);
      const ws = units.map((u) => width(u));
      let start = 0;
      while (true) {
        let used = 0;
        let end = start;
        let lastSpaceEnd = -1;
        while (end < units.length && used + ws[end]! <= cap) {
          used += ws[end]!;
          if (l[end] === " ") lastSpaceEnd = end + 1;
          end++;
        }
        if (end >= units.length) {
          rows.push({ line: li, start, end: units.length });
          break;
        }
        if (lastSpaceEnd > start) end = lastSpaceEnd;
        if (end === start) end = start + 1;
        rows.push({ line: li, start, end });
        start = end;
      }
    });
    return rows;
  }

  /** Index of the visual row holding the cursor. */
  cursorRow(rows: VisualRow[]): number {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.line !== this.row) continue;
      const next = rows[i + 1];
      const lastOfLine = !next || next.line !== this.row;
      if (this.col >= r.start && (this.col < r.end || lastOfLine)) return i;
    }
    return 0;
  }

  private xOf(rows: VisualRow[], ri: number, col: number): number {
    const r = rows[ri]!;
    const units = escapeUnits(this.lines[r.line]!);
    let x = 0;
    for (let i = r.start; i < col && i < r.end; i++) x += width(units[i]!);
    return x;
  }

  private moveRows(d: number, w: number): EditResult {
    const rows = this.layout(w);
    const ri = this.cursorRow(rows);
    if (this.goalX < 0) this.goalX = this.xOf(rows, ri, this.col);
    let target = ri + d;
    if (d < 0 && ri === 0) return "ignored";
    if (target < 0) target = 0;
    if (target > rows.length - 1) target = rows.length - 1;
    if (target === ri) return "moved";
    const r = rows[target]!;
    const units = escapeUnits(this.lines[r.line]!);
    let x = 0;
    let col = r.start;
    const lastOfLine = !rows[target + 1] || rows[target + 1]!.line !== r.line;
    const maxCol = lastOfLine ? r.end : r.end - 1;
    while (col < maxCol && x + width(units[col]!) <= this.goalX) {
      x += width(units[col]!);
      col++;
    }
    this.row = r.line;
    this.col = col;
    return "moved";
  }

  /** Draws `h` visual rows of `w` cells, scrolled to keep the cursor visible. */
  view(w: number, h: number, focused: boolean): Line[] {
    const rows = this.layout(w);
    const cr = this.cursorRow(rows);
    let top = 0;
    if (cr >= h) top = cr - h + 1;
    const out: Line[] = [];
    for (let i = top; i < rows.length && out.length < h; i++) {
      const r = rows[i]!;
      const units = escapeUnits(this.lines[r.line]!).slice(r.start, r.end);
      const cur = focused && i === cr ? this.col - r.start : -1;
      out.push(renderUnits(units, cur, w));
    }
    while (out.length < h) out.push([]);
    return out;
  }
}
