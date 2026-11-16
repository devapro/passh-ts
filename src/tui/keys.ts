// Key and paste decoding from raw terminal bytes (tui.md §1.1 step 3: raw mode, bracketed
// paste, no mouse). Understands the legacy encodings (control bytes, ESC-prefixed Alt,
// CSI/SS3 cursor and editing keys with xterm modifiers), xterm's modifyOtherKeys
// (`CSI 27 ; m ; code ~`) and the kitty keyboard protocol's `CSI code ; m u`, which the
// runtime enables so that Esc, Ctrl-Backspace and the like can be told apart.
//
// A key is named like `ctrl+c`, `alt+b`, `shift+tab`, `enter`, `up`, `pgdown`, or the
// character itself (`a`, `L`, `?`, `й`); `space` for the space bar. `text` is what the key
// inserts into a text field: set only for printable characters typed without Ctrl or Alt.

export interface KeyMsg {
  type: "key";
  key: string;
  text: string;
}

export interface PasteMsg {
  type: "paste";
  /** The pasted bytes, exactly as the terminal sent them (tui.md §11.4 checks UTF-8). */
  bytes: Uint8Array;
}

export type InputMsg = KeyMsg | PasteMsg;

export function key(name: string, text = ""): KeyMsg {
  return { type: "key", key: name, text };
}

/** A key for a typed character (what a terminal sends for printable input). */
export function charKey(c: string): KeyMsg {
  return c === " " ? { type: "key", key: "space", text: " " } : { type: "key", key: c, text: c };
}

const PASTE_START = [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]; // ESC [ 2 0 0 ~
const PASTE_END = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]; // ESC [ 2 0 1 ~

const CTRL_NAMES: Record<number, string> = {
  0x00: "ctrl+space",
  0x08: "ctrl+h",
  0x09: "tab",
  0x0a: "ctrl+j",
  0x0d: "enter",
  0x1b: "esc",
  0x1c: "ctrl+\\",
  0x1d: "ctrl+]",
  0x1e: "ctrl+^",
  0x1f: "ctrl+_",
  0x7f: "backspace",
};

function ctrlName(b: number): string {
  const n = CTRL_NAMES[b];
  if (n) return n;
  if (b >= 0x01 && b <= 0x1a) return "ctrl+" + String.fromCharCode(0x60 + b);
  return "ctrl+?";
}

/** Names of keys in `CSI n ~` form. */
const TILDE: Record<number, string> = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "pgup",
  6: "pgdown",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12",
};

/** Names of keys in `CSI [1;m] X` and `SS3 X` form. */
const LETTER: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
  Z: "shift+tab",
};

/** kitty functional key codes (CSI u) that matter here. */
const KITTY_CODES: Record<number, string> = {
  9: "tab",
  13: "enter",
  27: "esc",
  127: "backspace",
  8: "backspace",
  57414: "enter", // keypad enter
  57399: "0",
};

function withMods(name: string, mod: number): string {
  // xterm modifier parameter: 1 + (shift 1 | alt 2 | ctrl 4 | meta 8)
  const m = mod > 0 ? mod - 1 : 0;
  let out = name;
  if (m & 1 && !(name.length === 1 && name !== name.toLowerCase())) out = "shift+" + out;
  if (m & 2 || m & 8) out = "alt+" + out;
  if (m & 4) out = "ctrl+" + out;
  return out;
}

function fromCodepoint(code: number, mod: number): KeyMsg {
  const m = mod > 0 ? mod - 1 : 0;
  const special = KITTY_CODES[code];
  if (special) {
    if (special === "tab" && m & 1) return key(withMods("shift+tab", 1 + (m & ~1)));
    return key(withMods(special, mod));
  }
  if (code === 32) {
    if (m === 0) return charKey(" ");
    return key(withMods("space", mod));
  }
  let ch = String.fromCodePoint(code);
  if (m & 1 && !(m & 4) && !(m & 2)) ch = ch.toUpperCase();
  if (m & ~1) {
    // with Ctrl or Alt: a key, not text
    let name = ch;
    if (m & 1 && (m & 4 || m & 2)) name = ch.toLowerCase();
    let out = name;
    if (m & 1 && (m & 4 || m & 2)) out = "shift+" + out;
    if (m & 2 || m & 8) out = "alt+" + out;
    if (m & 4) out = "ctrl+" + out;
    return key(out);
  }
  return charKey(ch);
}

/**
 * Decodes a byte stream into key and paste events. `feed` returns the complete events;
 * an incomplete escape sequence (or a lone ESC) waits for more bytes, and `flush` turns
 * what is pending into keys (the runtime calls it after a short pause).
 */
export class InputDecoder {
  private buf: number[] = [];
  private paste: number[] | null = null;

  feed(bytes: Uint8Array): InputMsg[] {
    for (const b of bytes) this.buf.push(b);
    return this.drain(false);
  }

  /** Whether bytes are waiting (e.g. a lone ESC). */
  pending(): boolean {
    return this.buf.length > 0 && this.paste === null;
  }

  flush(): InputMsg[] {
    return this.drain(true);
  }

  private drain(final: boolean): InputMsg[] {
    const out: InputMsg[] = [];
    const b = this.buf;
    let i = 0;
    const take = (n: number) => {
      i += n;
    };
    while (i < b.length) {
      if (this.paste !== null) {
        // inside a bracketed paste: everything up to ESC [ 2 0 1 ~
        const end = indexOfSeq(b, PASTE_END, i);
        if (end < 0) {
          // keep a possible partial end marker in the buffer
          const keep = partialSuffix(b, PASTE_END, i);
          for (let k = i; k < b.length - keep; k++) this.paste.push(b[k]!);
          i = b.length - keep;
          break;
        }
        for (let k = i; k < end; k++) this.paste.push(b[k]!);
        out.push({ type: "paste", bytes: Uint8Array.from(this.paste) });
        this.paste = null;
        i = end + PASTE_END.length;
        continue;
      }
      const c = b[i]!;
      if (c === 0x1b) {
        const r = this.escape(b, i, final);
        if (r === null) break; // incomplete
        if (r.paste) {
          this.paste = [];
          take(r.len);
          continue;
        }
        if (r.msg) out.push(r.msg);
        take(r.len);
        continue;
      }
      if (c < 0x20 || c === 0x7f) {
        out.push(key(ctrlName(c)));
        take(1);
        continue;
      }
      // UTF-8 text
      const n = utf8Len(c);
      if (n === 0) {
        take(1); // a byte that isn't UTF-8 is dropped (agent-session.md §A4, TUI passphrase)
        continue;
      }
      if (i + n > b.length) {
        if (final) {
          take(b.length - i);
          continue;
        }
        break;
      }
      const cp = decodeUtf8(b, i, n);
      if (cp < 0) {
        take(1);
        continue;
      }
      out.push(charKey(String.fromCodePoint(cp)));
      take(n);
    }
    this.buf = b.slice(i);
    return out;
  }

  /** Decodes an escape sequence at b[i]; null when more bytes are needed. */
  private escape(b: number[], i: number, final: boolean): { len: number; msg?: KeyMsg; paste?: boolean } | null {
    if (i + 1 >= b.length) {
      if (final) return { len: 1, msg: key("esc") };
      return null;
    }
    const t = b[i + 1]!;
    if (t === 0x5b) {
      // CSI: params 0x30–0x3F, intermediates 0x20–0x2F, final 0x40–0x7E
      let j = i + 2;
      while (j < b.length && b[j]! >= 0x20 && b[j]! <= 0x3f) j++;
      if (j >= b.length) {
        if (final) return { len: b.length - i, msg: undefined };
        return null;
      }
      const fin = b[j]!;
      if (fin < 0x40 || fin > 0x7e) {
        // malformed: drop the ESC [
        return { len: 2 };
      }
      const params = String.fromCharCode(...b.slice(i + 2, j));
      const len = j - i + 1;
      if (params === "200" && fin === 0x7e) return { len, paste: true };
      return { len, msg: csiKey(params, String.fromCharCode(fin)) ?? undefined };
    }
    if (t === 0x4f) {
      // SS3
      if (i + 2 >= b.length) {
        if (final) return { len: 2, msg: key("alt+O") };
        return null;
      }
      const name = LETTER[String.fromCharCode(b[i + 2]!)];
      return { len: 3, msg: name ? key(name) : undefined };
    }
    if (t === 0x1b) {
      // ESC ESC: Alt+Esc, or an ESC followed by a sequence; report Esc and go on.
      return { len: 1, msg: key("esc") };
    }
    // Alt + key
    if (t < 0x20 || t === 0x7f) {
      const base = ctrlName(t);
      return { len: 2, msg: key("alt+" + base) };
    }
    const n = utf8Len(t);
    if (n === 0) return { len: 2 };
    if (i + 1 + n > b.length) {
      if (final) return { len: 1, msg: key("esc") };
      return null;
    }
    const cp = decodeUtf8(b, i + 1, n);
    if (cp < 0) return { len: 2 };
    const ch = String.fromCodePoint(cp);
    return { len: 1 + n, msg: key("alt+" + (ch === " " ? "space" : ch)) };
  }
}

function csiKey(params: string, fin: string): KeyMsg | null {
  if (/[<=>?]/.test(params[0] ?? "")) return null; // replies (e.g. DECRQM, kitty flags)
  const ps = params.split(";").map((p) => p.split(":"));
  const num = (k: number, d: number) => {
    const s = ps[k]?.[0];
    return s === undefined || s === "" ? d : parseInt(s, 10);
  };
  if (fin === "~") {
    const n = num(0, 0);
    if (n === 27) {
      // modifyOtherKeys: CSI 27 ; mod ; code ~
      return fromCodepoint(num(2, 0), num(1, 1));
    }
    const name = TILDE[n];
    if (!name) return null;
    return key(withMods(name, num(1, 1)));
  }
  if (fin === "u") {
    const code = num(0, 0);
    const mod = num(1, 1);
    // kitty: the text-as-codepoint field (3rd) may carry the shifted character
    const alt = ps[0]?.[1];
    if (alt && mod === 2) return charKey(String.fromCodePoint(parseInt(alt, 10)));
    return fromCodepoint(code, mod);
  }
  const name = LETTER[fin];
  if (!name) return null;
  if (name === "shift+tab") return key("shift+tab");
  return key(withMods(name, num(1, 1)));
}

function utf8Len(c: number): number {
  if (c < 0x80) return 1;
  if (c >= 0xc2 && c <= 0xdf) return 2;
  if (c >= 0xe0 && c <= 0xef) return 3;
  if (c >= 0xf0 && c <= 0xf4) return 4;
  return 0;
}

function decodeUtf8(b: number[], i: number, n: number): number {
  const c = b[i]!;
  if (n === 1) return c;
  let cp = n === 2 ? c & 0x1f : n === 3 ? c & 0x0f : c & 0x07;
  for (let k = 1; k < n; k++) {
    const x = b[i + k]!;
    if ((x & 0xc0) !== 0x80) return -1;
    cp = (cp << 6) | (x & 0x3f);
  }
  if ((n === 3 && cp < 0x800) || (n === 4 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff)) return -1;
  return cp;
}

function indexOfSeq(b: number[], seq: number[], from: number): number {
  outer: for (let i = from; i + seq.length <= b.length; i++) {
    for (let k = 0; k < seq.length; k++) if (b[i + k] !== seq[k]) continue outer;
    return i;
  }
  return -1;
}

/** Length of the longest suffix of b[from..] that is a proper prefix of seq. */
function partialSuffix(b: number[], seq: number[], from: number): number {
  for (let n = Math.min(seq.length - 1, b.length - from); n > 0; n--) {
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (b[b.length - n + k] !== seq[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return n;
  }
  return 0;
}

/** Encodes a key name back to bytes, for tests and the fake terminal. */
export function encodeKey(name: string): string {
  const simple: Record<string, string> = {
    enter: "\r",
    tab: "\t",
    "shift+tab": "\x1b[Z",
    esc: "\x1b",
    backspace: "\x7f",
    up: "\x1b[A",
    down: "\x1b[B",
    right: "\x1b[C",
    left: "\x1b[D",
    home: "\x1b[H",
    end: "\x1b[F",
    pgup: "\x1b[5~",
    pgdown: "\x1b[6~",
    delete: "\x1b[3~",
    space: " ",
  };
  if (simple[name]) return simple[name]!;
  const m = /^ctrl\+([a-z])$/.exec(name);
  if (m) return String.fromCharCode(m[1]!.charCodeAt(0) - 0x60);
  const a = /^alt\+(.+)$/.exec(name);
  if (a) return "\x1b" + encodeKey(a[1]!);
  return name;
}

/** The PASTE_START marker, exported for tests. */
export const PASTE_START_SEQ = String.fromCharCode(...PASTE_START);
export const PASTE_END_SEQ = String.fromCharCode(...PASTE_END);
