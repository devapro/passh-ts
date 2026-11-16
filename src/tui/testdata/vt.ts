// A minimal VT100/xterm screen model for tests: feeds terminal output and keeps a grid of
// cells, so tests can compare what a TUI shows (ours or the reference's) as text.
//
// Handles what full-screen TUIs emit: CUP/CUU/CUD/CUF/CUB/CHA/VPA/CNL/CPL, ED/EL/ECH,
// IL/DL/ICH/DCH, SU/SD, DECSTBM, SGR (bold, faint, reverse, colours tracked per cell),
// DECSET/DECRST 1049/47/1047 (alternate screen), 7 (autowrap), 25 (cursor), save/restore
// cursor, IND/RI/NEL, BS/CR/LF/TAB, wide characters. OSC strings are recorded (OSC 52 copies
// are visible to tests); DCS/APC/PM strings are skipped.

export interface Cell {
  ch: string; // "" for the second half of a wide character
  bold: boolean;
  faint: boolean;
  reverse: boolean;
  fg: number; // -1 default, 0–15
}

function blank(): Cell {
  return { ch: " ", bold: false, faint: false, reverse: false, fg: -1 };
}

function width(s: string): number {
  return Bun.stringWidth(s);
}

export class Screen {
  cols: number;
  rows: number;
  private main: Cell[][];
  private alt: Cell[][];
  grid: Cell[][];
  altActive = false;
  x = 0;
  y = 0;
  private saved = { x: 0, y: 0 };
  private top = 0;
  private bottom: number;
  private autowrap = true;
  private pendingWrap = false;
  cursorVisible = true;
  private attr: Omit<Cell, "ch"> = { bold: false, faint: false, reverse: false, fg: -1 };
  /** OSC strings seen, e.g. "52;c;aGVsbG8=". */
  osc: string[] = [];
  /** DECSET/DECRST modes seen, in order (e.g. "?2004h"). */
  modes: string[] = [];
  private rest = "";
  private decoder = new TextDecoder();

  constructor(cols = 80, rows = 24) {
    this.cols = cols;
    this.rows = rows;
    this.bottom = rows - 1;
    this.main = this.newGrid();
    this.alt = this.newGrid();
    this.grid = this.main;
  }

  private newGrid(): Cell[][] {
    return Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, blank));
  }

  resize(cols: number, rows: number): void {
    const fit = (g: Cell[][]) => {
      const n = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => g[r]?.[c] ?? blank()));
      return n;
    };
    this.main = fit(this.main);
    this.alt = fit(this.alt);
    this.grid = this.altActive ? this.alt : this.main;
    this.cols = cols;
    this.rows = rows;
    this.top = 0;
    this.bottom = rows - 1;
    this.x = Math.min(this.x, cols - 1);
    this.y = Math.min(this.y, rows - 1);
  }

  write(data: string | Uint8Array): void {
    const s = this.rest + (typeof data === "string" ? data : this.decoder.decode(data, { stream: true }));
    this.rest = "";
    let i = 0;
    const n = s.length;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 0x1b) {
        const used = this.escape(s, i);
        if (used < 0) {
          this.rest = s.slice(i);
          return;
        }
        i += used;
        continue;
      }
      if (c < 0x20 || c === 0x7f) {
        this.control(c);
        i++;
        continue;
      }
      // one code point, plus any following zero-width characters
      const cp = s.codePointAt(i)!;
      let ch = String.fromCodePoint(cp);
      i += ch.length;
      while (i < n) {
        const cp2 = s.codePointAt(i)!;
        const c2 = String.fromCodePoint(cp2);
        if (cp2 >= 0x20 && cp2 !== 0x7f && width(c2) === 0 && !(cp2 >= 0x80 && cp2 < 0xa0)) {
          ch += c2;
          i += c2.length;
        } else break;
      }
      this.put(ch);
    }
  }

  private put(ch: string): void {
    let w = width(ch);
    if (w === 0) {
      // a lone zero-width character: attach to the previous cell
      const px = this.x > 0 ? this.x - 1 : 0;
      const cell = this.grid[this.y]![px]!;
      cell.ch += ch;
      return;
    }
    if (w > 2) w = 2;
    if (this.pendingWrap) {
      this.pendingWrap = false;
      if (this.autowrap) {
        this.x = 0;
        this.lineFeed();
      }
    }
    if (this.x + w > this.cols) {
      if (this.autowrap) {
        this.x = 0;
        this.lineFeed();
      } else {
        this.x = this.cols - w;
      }
    }
    const row = this.grid[this.y]!;
    row[this.x] = { ch, ...this.attr };
    if (w === 2 && this.x + 1 < this.cols) row[this.x + 1] = { ch: "", ...this.attr };
    this.x += w;
    if (this.x >= this.cols) {
      this.x = this.cols - 1;
      this.pendingWrap = true;
    }
  }

  private control(c: number): void {
    switch (c) {
      case 0x08:
        this.pendingWrap = false;
        if (this.x > 0) this.x--;
        break;
      case 0x09:
        this.pendingWrap = false;
        this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8);
        break;
      case 0x0a:
      case 0x0b:
      case 0x0c:
        this.pendingWrap = false;
        this.lineFeed();
        break;
      case 0x0d:
        this.pendingWrap = false;
        this.x = 0;
        break;
      default:
        break;
    }
  }

  private lineFeed(): void {
    if (this.y === this.bottom) this.scrollUp(1);
    else if (this.y < this.rows - 1) this.y++;
  }

  private scrollUp(n: number): void {
    for (let k = 0; k < n; k++) {
      this.grid.splice(this.top, 1);
      this.grid.splice(this.bottom, 0, Array.from({ length: this.cols }, blank));
    }
  }

  private scrollDown(n: number): void {
    for (let k = 0; k < n; k++) {
      this.grid.splice(this.bottom, 1);
      this.grid.splice(this.top, 0, Array.from({ length: this.cols }, blank));
    }
  }

  /** Parses an escape sequence at s[i]; returns the length consumed, or -1 if incomplete. */
  private escape(s: string, i: number): number {
    if (i + 1 >= s.length) return -1;
    const t = s[i + 1]!;
    if (t === "[") {
      let j = i + 2;
      while (j < s.length) {
        const c = s.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) break;
        j++;
      }
      if (j >= s.length) return -1;
      this.csi(s.slice(i + 2, j), s[j]!);
      return j - i + 1;
    }
    if (t === "]" || t === "P" || t === "_" || t === "^" || t === "X") {
      // string until BEL or ST
      let j = i + 2;
      while (j < s.length) {
        if (s[j] === "\x07") {
          if (t === "]") this.osc.push(s.slice(i + 2, j));
          return j - i + 1;
        }
        if (s[j] === "\x1b" && s[j + 1] === "\\") {
          if (t === "]") this.osc.push(s.slice(i + 2, j));
          return j - i + 2;
        }
        if (s[j] === "\x1b" && j + 1 >= s.length) return -1;
        j++;
      }
      return -1;
    }
    if (t === "(" || t === ")" || t === "*" || t === "+" || t === "#" || t === "%") {
      if (i + 2 >= s.length) return -1;
      return 3;
    }
    switch (t) {
      case "7":
        this.saved = { x: this.x, y: this.y };
        break;
      case "8":
        this.x = this.saved.x;
        this.y = this.saved.y;
        break;
      case "D":
        this.lineFeed();
        break;
      case "E":
        this.x = 0;
        this.lineFeed();
        break;
      case "M":
        if (this.y === this.top) this.scrollDown(1);
        else if (this.y > 0) this.y--;
        break;
      case "c":
        this.grid = this.altActive ? (this.alt = this.newGrid()) : (this.main = this.newGrid());
        this.x = this.y = 0;
        break;
      default:
        break;
    }
    return 2;
  }

  private csi(params: string, final: string): void {
    this.pendingWrap = false;
    const priv = params.length > 0 && "?<>=".includes(params[0]!) ? params[0]! : "";
    const body = priv ? params.slice(1) : params;
    // intermediate bytes (e.g. "$" in DECRQM, " " in DECSCUSR): ignore those sequences
    if (/[ -/]/.test(body)) return;
    const ps = body.split(";").map((p) => (p === "" ? NaN : parseInt(p.split(":")[0]!, 10)));
    const p = (k: number, d: number) => (Number.isNaN(ps[k] ?? NaN) || ps[k] === undefined ? d : ps[k]!);
    if (priv === "?") {
      if (final === "h" || final === "l") {
        const on = final === "h";
        for (const m of ps) {
          this.modes.push("?" + m + final);
          if (m === 1049 || m === 47 || m === 1047) this.setAlt(on, m === 1049);
          else if (m === 7) this.autowrap = on;
          else if (m === 25) this.cursorVisible = on;
        }
      }
      return;
    }
    if (priv) {
      this.modes.push(priv + body + final);
      return;
    }
    switch (final) {
      case "H":
      case "f":
        this.y = clamp(p(0, 1) - 1, 0, this.rows - 1);
        this.x = clamp(p(1, 1) - 1, 0, this.cols - 1);
        break;
      case "A":
        this.y = clamp(this.y - p(0, 1), 0, this.rows - 1);
        break;
      case "B":
        this.y = clamp(this.y + p(0, 1), 0, this.rows - 1);
        break;
      case "C":
        this.x = clamp(this.x + p(0, 1), 0, this.cols - 1);
        break;
      case "D":
        this.x = clamp(this.x - p(0, 1), 0, this.cols - 1);
        break;
      case "E":
        this.y = clamp(this.y + p(0, 1), 0, this.rows - 1);
        this.x = 0;
        break;
      case "F":
        this.y = clamp(this.y - p(0, 1), 0, this.rows - 1);
        this.x = 0;
        break;
      case "G":
      case "`":
        this.x = clamp(p(0, 1) - 1, 0, this.cols - 1);
        break;
      case "d":
        this.y = clamp(p(0, 1) - 1, 0, this.rows - 1);
        break;
      case "J": {
        const m = p(0, 0);
        if (m === 0) {
          this.clearRow(this.y, this.x, this.cols);
          for (let r = this.y + 1; r < this.rows; r++) this.clearRow(r, 0, this.cols);
        } else if (m === 1) {
          for (let r = 0; r < this.y; r++) this.clearRow(r, 0, this.cols);
          this.clearRow(this.y, 0, this.x + 1);
        } else {
          for (let r = 0; r < this.rows; r++) this.clearRow(r, 0, this.cols);
        }
        break;
      }
      case "K": {
        const m = p(0, 0);
        if (m === 0) this.clearRow(this.y, this.x, this.cols);
        else if (m === 1) this.clearRow(this.y, 0, this.x + 1);
        else this.clearRow(this.y, 0, this.cols);
        break;
      }
      case "X":
        this.clearRow(this.y, this.x, Math.min(this.cols, this.x + p(0, 1)));
        break;
      case "@": {
        const row = this.grid[this.y]!;
        const n = p(0, 1);
        for (let k = 0; k < n; k++) {
          row.splice(this.x, 0, blank());
          row.pop();
        }
        break;
      }
      case "P": {
        const row = this.grid[this.y]!;
        const n = p(0, 1);
        row.splice(this.x, n);
        while (row.length < this.cols) row.push(blank());
        break;
      }
      case "L":
        if (this.y >= this.top && this.y <= this.bottom) {
          for (let k = 0; k < p(0, 1); k++) {
            this.grid.splice(this.bottom, 1);
            this.grid.splice(this.y, 0, Array.from({ length: this.cols }, blank));
          }
        }
        break;
      case "M":
        if (this.y >= this.top && this.y <= this.bottom) {
          for (let k = 0; k < p(0, 1); k++) {
            this.grid.splice(this.y, 1);
            this.grid.splice(this.bottom, 0, Array.from({ length: this.cols }, blank));
          }
        }
        break;
      case "S":
        this.scrollUp(p(0, 1));
        break;
      case "T":
        this.scrollDown(p(0, 1));
        break;
      case "r":
        this.top = clamp(p(0, 1) - 1, 0, this.rows - 1);
        this.bottom = clamp(p(1, this.rows) - 1, 0, this.rows - 1);
        this.x = 0;
        this.y = 0;
        break;
      case "s":
        this.saved = { x: this.x, y: this.y };
        break;
      case "u":
        this.x = this.saved.x;
        this.y = this.saved.y;
        break;
      case "m":
        this.sgr(ps);
        break;
      default:
        break;
    }
  }

  private sgr(ps: number[]): void {
    if (ps.length === 0) ps = [0];
    for (let k = 0; k < ps.length; k++) {
      const v = Number.isNaN(ps[k]!) ? 0 : ps[k]!;
      if (v === 0) this.attr = { bold: false, faint: false, reverse: false, fg: -1 };
      else if (v === 1) this.attr.bold = true;
      else if (v === 2) this.attr.faint = true;
      else if (v === 22) {
        this.attr.bold = false;
        this.attr.faint = false;
      } else if (v === 7) this.attr.reverse = true;
      else if (v === 27) this.attr.reverse = false;
      else if (v >= 30 && v <= 37) this.attr.fg = v - 30;
      else if (v >= 90 && v <= 97) this.attr.fg = v - 90 + 8;
      else if (v === 39) this.attr.fg = -1;
      else if (v === 38 || v === 48) {
        // extended colour: skip its parameters
        if (ps[k + 1] === 5) k += 2;
        else if (ps[k + 1] === 2) k += 4;
      }
    }
  }

  private clearRow(r: number, from: number, to: number): void {
    const row = this.grid[r];
    if (!row) return;
    for (let c = Math.max(0, from); c < Math.min(to, this.cols); c++) row[c] = blank();
  }

  private setAlt(on: boolean, saveCursor: boolean): void {
    if (on === this.altActive) return;
    if (on) {
      if (saveCursor) this.saved = { x: this.x, y: this.y };
      this.alt = this.newGrid();
      this.grid = this.alt;
      this.altActive = true;
    } else {
      this.grid = this.main;
      this.altActive = false;
      if (saveCursor) {
        this.x = this.saved.x;
        this.y = this.saved.y;
      }
    }
  }

  /** The screen as text lines, trailing blanks removed. */
  lines(): string[] {
    return this.grid.map((row) => row.map((c) => c.ch).join("").replace(/\s+$/, ""));
  }

  text(): string {
    return this.lines().join("\n");
  }

  /** The cells of one row whose attribute matches, as text (e.g. what is in reverse video). */
  styled(r: number, pred: (c: Cell) => boolean): string {
    return (this.grid[r] ?? []).filter(pred).map((c) => c.ch).join("");
  }

  /** The decoded payloads of OSC 52 writes seen ("" for a clear). */
  osc52(): string[] {
    return this.osc
      .filter((o) => o.startsWith("52;"))
      .map((o) => {
        const b64 = o.slice(o.indexOf(";", 3) + 1);
        return Buffer.from(b64, "base64").toString("utf8");
      });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
