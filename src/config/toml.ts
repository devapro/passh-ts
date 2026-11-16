// A TOML 1.1.0 parser for the config file (storage.md §2.2 step 2).
//
// Written for passh rather than using smol-toml (which reads TOML 1.1) because the
// config needs what a generic parser doesn't give: the keys in file order, each with its
// line (unknown keys are reported in file order, type errors carry `line N (last key
// "k")`), and the defining rules of tables kept exactly.
//
// TOML 1.1 additions supported: newlines, comments and a trailing comma in inline tables;
// the `\e` and `\xHH` escapes; times without seconds (`07:32`, `1979-05-27T07:32Z`).
// Error texts follow BurntSushi/toml's style (not normative, storage.md §2.2).

import { decodeRune, goQuote } from "../i18n/quote.ts";

export type TableHow = "root" | "explicit" | "implicit" | "dotted" | "inline" | "aot";

interface Base {
  /** The line (1-based) of the key that defined the value. */
  line: number;
}
export interface TomlString extends Base {
  type: "string";
  value: string;
}
export interface TomlInteger extends Base {
  type: "integer";
  value: bigint;
}
export interface TomlFloat extends Base {
  type: "float";
  value: number;
}
export interface TomlBoolean extends Base {
  type: "boolean";
  value: boolean;
}
export interface TomlDatetime extends Base {
  type: "datetime";
  value: string;
  kind: "offset-datetime" | "local-datetime" | "local-date" | "local-time";
}
export interface TomlArray extends Base {
  type: "array";
  value: TomlValue[];
  /** An array of tables (`[[name]]`), as opposed to a static array. */
  ofTables: boolean;
}
export interface TomlTable extends Base {
  type: "table";
  value: Map<string, TomlValue>;
  how: TableHow;
}
export type TomlValue = TomlString | TomlInteger | TomlFloat | TomlBoolean | TomlDatetime | TomlArray | TomlTable;

/** A key defined in the file, in file order (like BurntSushi's MetaData.Keys). */
export interface TomlKey {
  path: string[];
  line: number;
}

export interface TomlDocument {
  root: TomlTable;
  /**
   * Every key defined, in file order: table headers (`[a.b]` → a.b, `[[a]]` → a each
   * time), key/value pairs with their table (`x.y = 1` in `[t]` → t.x.y; the tables
   * that dotted keys create implicitly are not listed), and the keys inside inline tables.
   */
  keys: TomlKey[];
}

/** A decoding error: `line N (last key "k"): <detail>` or `line N: <detail>`. */
export class TomlError extends Error {
  readonly line: number;
  readonly lastKey: string | undefined;
  readonly detail: string;
  constructor(line: number, detail: string, lastKey?: string) {
    super(`line ${line}${lastKey !== undefined ? ` (last key ${goStr(lastKey)})` : ""}: ${detail}`);
    this.name = "TomlError";
    this.line = line;
    this.lastKey = lastKey;
    this.detail = detail;
  }
}

/** %q for the "(last key …)" context. */
function goStr(s: string): string {
  return goQuote(s);
}

const BARE = /[A-Za-z0-9_-]/;

/**
 * A key as BurntSushi's Key.String() writes it: bare parts as they are, others in
 * double quotes with `"` `\` and control characters escaped (`\b \t \n \f \r`, other
 * C0 and DEL as `\u00XX`), joined with dots.
 */
export function keyString(path: readonly string[]): string {
  return path.map(quoteKeyPart).join(".");
}

function quoteKeyPart(k: string): string {
  if (k === "") return '""';
  let bare = true;
  for (const ch of k) {
    if (!BARE.test(ch)) {
      bare = false;
      break;
    }
  }
  if (bare) return k;
  let out = '"';
  for (const ch of k) {
    const c = ch.codePointAt(0)!;
    switch (ch) {
      case '"':
        out += '\\"';
        continue;
      case "\\":
        out += "\\\\";
        continue;
      case "\b":
        out += "\\b";
        continue;
      case "\t":
        out += "\\t";
        continue;
      case "\n":
        out += "\\n";
        continue;
      case "\f":
        out += "\\f";
        continue;
      case "\r":
        out += "\\r";
        continue;
    }
    if (c < 0x20 || c === 0x7f) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

function charDesc(c: string | undefined): string {
  if (c === undefined) return "end of file";
  if (c === "\n") return "'\\n'";
  if (c === "\r") return "'\\r'";
  if (c === "\t") return "'\\t'";
  return `'${c}'`;
}

function isControl(c: number): boolean {
  return (c < 0x20 && c !== 0x09) || c === 0x7f;
}

/** Parses a TOML 1.1 document. Throws TomlError. */
export function parseToml(input: string | Uint8Array): TomlDocument {
  let src: string;
  if (typeof input === "string") src = input;
  else {
    // Valid UTF-8 is required: report the first bad byte with its line.
    let line = 1;
    for (let i = 0; i < input.length; ) {
      const b = input[i]!;
      if (b === 0x0a) line++;
      if (b < 0x80) {
        i++;
        continue;
      }
      const [cp, size] = decodeRune(input, i);
      if (cp < 0) throw new TomlError(line, `invalid UTF-8 byte: 0x${b.toString(16).padStart(2, "0")}`);
      i += size;
    }
    src = new TextDecoder().decode(input);
  }
  return new Parser(src).document();
}

class Parser {
  private s: string;
  private i = 0;
  private line = 1;
  private lastKey: string | undefined;
  private root: TomlTable;
  private keys: TomlKey[] = [];

  constructor(s: string) {
    this.s = s;
    this.root = { type: "table", value: new Map(), how: "root", line: 1 };
  }

  private fail(detail: string, line = this.line): never {
    throw new TomlError(line, detail, this.lastKey);
  }

  private peek(off = 0): string | undefined {
    return this.s[this.i + off];
  }

  private eof(): boolean {
    return this.i >= this.s.length;
  }

  private skipWs(): void {
    while (this.i < this.s.length && (this.s[this.i] === " " || this.s[this.i] === "\t")) this.i++;
  }

  /** At a newline (LF or CRLF)? A lone CR is a control character. */
  private atNewline(): boolean {
    const c = this.s[this.i];
    return c === "\n" || (c === "\r" && this.s[this.i + 1] === "\n");
  }

  private newline(): void {
    if (this.s[this.i] === "\r") this.i++;
    this.i++;
    this.line++;
  }

  private comment(): void {
    // at '#'
    this.i++;
    while (this.i < this.s.length && !this.atNewline()) {
      const cp = this.s.codePointAt(this.i)!;
      if (isControl(cp)) this.fail(`TOML files cannot contain control characters: '0x${cp.toString(16).padStart(2, "0")}'`);
      this.i += cp > 0xffff ? 2 : 1;
    }
  }

  /** Skips white space, newlines and comments (inside arrays and inline tables). */
  private skipAll(): void {
    for (;;) {
      this.skipWs();
      if (this.atNewline()) this.newline();
      else if (this.peek() === "#") this.comment();
      else return;
    }
  }

  /** After an expression: white space, an optional comment, then a newline or the end. */
  private endOfLine(): void {
    this.skipWs();
    if (this.peek() === "#") this.comment();
    if (this.eof()) return;
    if (this.atNewline()) {
      this.newline();
      return;
    }
    const c = this.s.codePointAt(this.i)!;
    if (isControl(c)) this.fail(`TOML files cannot contain control characters: '0x${c.toString(16).padStart(2, "0")}'`);
    this.fail(`expected a top-level item to end with a newline, comment, or EOF, but got ${charDesc(String.fromCodePoint(c))} instead`);
  }

  document(): TomlDocument {
    if (this.s.startsWith("﻿")) this.i = 1;
    let current = this.root;
    let currentPath: string[] = [];
    while (!this.eof()) {
      this.lastKey = undefined;
      this.skipWs();
      if (this.eof()) break;
      const c = this.peek()!;
      if (c === "#") {
        this.comment();
        this.endOfLine();
      } else if (this.atNewline()) {
        this.newline();
      } else if (c === "[") {
        const line = this.line;
        const isArray = this.peek(1) === "[";
        this.i += isArray ? 2 : 1;
        this.skipWs();
        const path = this.key();
        this.skipWs();
        if (isArray) {
          if (this.peek() !== "]" || this.peek(1) !== "]") this.fail(`expected ']]' to end the array of tables name, but got ${charDesc(this.peek())} instead`);
          this.i += 2;
        } else {
          if (this.peek() !== "]") this.fail(`expected '.' or ']' to end table name, but got ${charDesc(this.peek())} instead`);
          this.i++;
        }
        current = this.headerTable(path, isArray, line);
        currentPath = path;
        this.keys.push({ path, line });
        this.endOfLine();
      } else {
        const line = this.line;
        const path = this.key();
        this.lastKey = keyString([...currentPath, ...path]);
        this.skipWs();
        if (this.peek() !== "=") this.fail(`expected '.' or '=', but got ${charDesc(this.peek())} instead`);
        this.i++;
        this.skipWs();
        // Recorded before the value, so an inline table's own keys come after it.
        this.keys.push({ path: [...currentPath, ...path], line });
        const value = this.value(line, [...currentPath, ...path]);
        this.setKey(current, path, value, line);
        this.endOfLine();
      }
    }
    return { root: this.root, keys: this.keys };
  }

  // -------------------------------------------------------------------------
  // Keys

  private key(): string[] {
    const parts = [this.simpleKey()];
    for (;;) {
      const save = this.i;
      this.skipWs();
      if (this.peek() !== ".") {
        this.i = save;
        return parts;
      }
      this.i++;
      this.skipWs();
      parts.push(this.simpleKey());
    }
  }

  private simpleKey(): string {
    const c = this.peek();
    if (c === '"') {
      if (this.s.startsWith('"""', this.i)) this.fail("multi-line strings are not allowed as keys");
      return this.basicString();
    }
    if (c === "'") {
      if (this.s.startsWith("'''", this.i)) this.fail("multi-line strings are not allowed as keys");
      return this.literalString();
    }
    const start = this.i;
    while (this.i < this.s.length && BARE.test(this.s[this.i]!)) this.i++;
    if (this.i === start) {
      if (c !== undefined && isControl(c.codePointAt(0)!) && c !== "\n" && c !== "\r") {
        this.fail(`TOML files cannot contain control characters: '0x${c.codePointAt(0)!.toString(16).padStart(2, "0")}'`);
      }
      this.fail(`expected a key but got ${charDesc(c === undefined ? undefined : String.fromCodePoint(this.s.codePointAt(this.i)!))} instead`);
    }
    return this.s.slice(start, this.i);
  }

  // -------------------------------------------------------------------------
  // Tables

  private newTable(how: TableHow, line: number): TomlTable {
    return { type: "table", value: new Map(), how, line };
  }

  private headerTable(path: string[], isArray: boolean, line: number): TomlTable {
    let t = this.root;
    for (let k = 0; k < path.length - 1; k++) {
      const name = path[k]!;
      const v = t.value.get(name);
      if (v === undefined) {
        const nt = this.newTable("implicit", line);
        t.value.set(name, nt);
        t = nt;
      } else if (v.type === "table" && v.how !== "inline") {
        t = v;
      } else if (v.type === "array" && v.ofTables) {
        t = v.value[v.value.length - 1] as TomlTable;
      } else {
        this.fail(`Key '${keyString(path.slice(0, k + 1))}' has already been defined.`, line);
      }
    }
    const last = path[path.length - 1]!;
    const v = t.value.get(last);
    if (isArray) {
      const nt = this.newTable("aot", line);
      if (v === undefined) {
        t.value.set(last, { type: "array", value: [nt], ofTables: true, line });
      } else if (v.type === "array" && v.ofTables) {
        v.value.push(nt);
      } else {
        this.fail(`Key '${keyString(path)}' was already created and cannot be used as an array.`, line);
      }
      return nt;
    }
    if (v === undefined) {
      const nt = this.newTable("explicit", line);
      t.value.set(last, nt);
      return nt;
    }
    if (v.type === "table" && v.how === "implicit") {
      v.how = "explicit";
      v.line = line;
      return v;
    }
    this.fail(`Key '${keyString(path)}' has already been defined.`, line);
  }

  /** Sets a (possibly dotted) key in a table; dotted keys create tables marked "dotted". */
  private setKey(table: TomlTable, path: string[], value: TomlValue, line: number): void {
    let t = table;
    for (let k = 0; k < path.length - 1; k++) {
      const name = path[k]!;
      const v = t.value.get(name);
      if (v === undefined) {
        const nt = this.newTable("dotted", line);
        t.value.set(name, nt);
        t = nt;
      } else if (v.type === "table" && v.how === "dotted") {
        t = v;
      } else {
        this.fail(`Key '${keyString(path.slice(0, k + 1))}' has already been defined.`, line);
      }
    }
    const last = path[path.length - 1]!;
    if (t.value.has(last)) this.fail(`Key '${keyString(path)}' has already been defined.`, line);
    t.value.set(last, value);
  }

  // -------------------------------------------------------------------------
  // Values

  private value(line: number, keyPath: string[]): TomlValue {
    const c = this.peek();
    if (c === '"') {
      const v = this.s.startsWith('"""', this.i) ? this.multilineBasic() : this.basicString();
      return { type: "string", value: v, line };
    }
    if (c === "'") {
      const v = this.s.startsWith("'''", this.i) ? this.multilineLiteral() : this.literalString();
      return { type: "string", value: v, line };
    }
    if (c === "[") return this.array(line, keyPath);
    if (c === "{") return this.inlineTable(line, keyPath);
    if (c !== undefined && /[0-9A-Za-z_+.:-]/.test(c)) return this.scalar(line);
    if (c === undefined || this.atNewline() || c === "#") this.fail(`expected value but found ${charDesc(c)} instead`);
    const cp = this.s.codePointAt(this.i)!;
    if (isControl(cp)) this.fail(`TOML files cannot contain control characters: '0x${cp.toString(16).padStart(2, "0")}'`);
    this.fail(`expected value but found ${charDesc(String.fromCodePoint(cp))} instead`);
  }

  private array(line: number, keyPath: string[]): TomlArray {
    this.i++; // [
    const out: TomlValue[] = [];
    for (;;) {
      this.skipAll();
      if (this.peek() === "]") {
        this.i++;
        return { type: "array", value: out, ofTables: false, line };
      }
      if (this.eof()) this.fail("unexpected EOF; expected ']'");
      out.push(this.value(line, keyPath));
      this.skipAll();
      const c = this.peek();
      if (c === ",") {
        this.i++;
        continue;
      }
      if (c === "]") {
        this.i++;
        return { type: "array", value: out, ofTables: false, line };
      }
      this.fail(`expected a comma (',') or array terminator (']'), but got ${charDesc(c)} instead`);
    }
  }

  private inlineTable(line: number, keyPath: string[]): TomlTable {
    this.i++; // {
    const t = this.newTable("dotted", line);
    // Keys inside an inline table are relative to it; the table itself is frozen after '}'.
    const saveLast = this.lastKey;
    let first = true;
    for (;;) {
      this.skipAll();
      const c = this.peek();
      if (c === "}") {
        this.i++;
        break;
      }
      if (c === undefined) this.fail("unexpected EOF; expected '}'");
      if (c === "," && first) this.fail("expected a key but got ',' instead");
      const kline = this.line;
      const path = this.key();
      this.lastKey = keyString([...keyPath, ...path]);
      this.skipWs();
      if (this.peek() !== "=") this.fail(`expected '.' or '=', but got ${charDesc(this.peek())} instead`);
      this.i++;
      this.skipWs();
      this.keys.push({ path: [...keyPath, ...path], line: kline });
      const v = this.value(kline, [...keyPath, ...path]);
      this.setKey(t, path, v, kline);
      first = false;
      this.skipAll();
      const d = this.peek();
      if (d === ",") {
        this.i++;
        this.skipAll();
        if (this.peek() === ",") this.fail("expected a key but got ',' instead");
        continue;
      }
      if (d === "}") {
        this.i++;
        break;
      }
      this.fail(`expected a comma (',') or inline table terminator ('}'), but got ${charDesc(d)} instead`);
    }
    this.lastKey = saveLast;
    freeze(t);
    t.line = line;
    return t;
  }

  // -------------------------------------------------------------------------
  // Strings

  private controlCheck(cp: number): void {
    if (isControl(cp)) this.fail(`TOML files cannot contain control characters: '0x${cp.toString(16).padStart(2, "0")}'`);
  }

  private basicString(): string {
    this.i++; // "
    let out = "";
    for (;;) {
      if (this.eof()) this.fail("unexpected EOF; expected '\"'");
      const c = this.s[this.i]!;
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c === "\n" || (c === "\r" && this.s[this.i + 1] === "\n")) this.fail("strings cannot contain newlines");
      if (c === "\\") {
        out += this.escape();
        continue;
      }
      const cp = this.s.codePointAt(this.i)!;
      this.controlCheck(cp);
      const ch = String.fromCodePoint(cp);
      out += ch;
      this.i += ch.length;
    }
  }

  private escape(): string {
    // at '\'
    const e = this.s[this.i + 1];
    this.i += 2;
    switch (e) {
      case "b":
        return "\b";
      case "t":
        return "\t";
      case "n":
        return "\n";
      case "f":
        return "\f";
      case "r":
        return "\r";
      case "e":
        return "\x1b";
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "x": {
        const h = this.s.slice(this.i, this.i + 2);
        if (!/^[0-9A-Fa-f]{2}$/.test(h)) this.fail(`expected two hexadecimal digits after '\\x', but got ${JSON.stringify("\\x" + this.s.slice(this.i, this.i + 2))} instead`);
        this.i += 2;
        return String.fromCodePoint(parseInt(h, 16));
      }
      case "u":
      case "U": {
        const n = e === "u" ? 4 : 8;
        const h = this.s.slice(this.i, this.i + n);
        if (h.length !== n || !/^[0-9A-Fa-f]+$/.test(h)) this.fail(`expected ${n} hexadecimal digits after '\\${e}', but got ${JSON.stringify(h)} instead`);
        this.i += n;
        const cp = parseInt(h, 16);
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) this.fail(`escaped character '\\${e}${h}' is not valid UTF-8`);
        return String.fromCodePoint(cp);
      }
      default:
        if (e === undefined) this.fail("unexpected EOF in an escape sequence");
        this.fail(`invalid escape in string '\\${e}'`);
    }
  }

  private literalString(): string {
    this.i++; // '
    const start = this.i;
    for (;;) {
      if (this.eof()) this.fail("unexpected EOF; expected \"'\"");
      const c = this.s[this.i]!;
      if (c === "'") {
        const v = this.s.slice(start, this.i);
        this.i++;
        return v;
      }
      if (c === "\n" || (c === "\r" && this.s[this.i + 1] === "\n")) this.fail("strings cannot contain newlines");
      const cp = this.s.codePointAt(this.i)!;
      this.controlCheck(cp);
      this.i += cp > 0xffff ? 2 : 1;
    }
  }

  private multilineBasic(): string {
    this.i += 3;
    if (this.atNewline()) this.newline();
    let out = "";
    for (;;) {
      if (this.eof()) this.fail("unexpected EOF; expected '\"\"\"'");
      if (this.s.startsWith('"""', this.i)) {
        let q = 3;
        while (this.s[this.i + q] === '"') q++;
        if (q > 5) this.fail("too many quotation marks at the end of a multi-line string");
        out += '"'.repeat(q - 3);
        this.i += q;
        return out;
      }
      const c = this.s[this.i]!;
      if (this.atNewline()) {
        out += "\n";
        this.newline();
        continue;
      }
      if (c === "\\") {
        // A line-ending backslash: trims white space and newlines up to the next text.
        let j = this.i + 1;
        while (this.s[j] === " " || this.s[j] === "\t") j++;
        if (this.s[j] === "\n" || (this.s[j] === "\r" && this.s[j + 1] === "\n")) {
          this.i = j;
          for (;;) {
            this.skipWs();
            if (this.atNewline()) this.newline();
            else break;
          }
          continue;
        }
        out += this.escape();
        continue;
      }
      const cp = this.s.codePointAt(this.i)!;
      this.controlCheck(cp);
      const ch = String.fromCodePoint(cp);
      out += ch;
      this.i += ch.length;
    }
  }

  private multilineLiteral(): string {
    this.i += 3;
    if (this.atNewline()) this.newline();
    let out = "";
    for (;;) {
      if (this.eof()) this.fail("unexpected EOF; expected \"'''\"");
      if (this.s.startsWith("'''", this.i)) {
        let q = 3;
        while (this.s[this.i + q] === "'") q++;
        if (q > 5) this.fail("too many quotation marks at the end of a multi-line string");
        out += "'".repeat(q - 3);
        this.i += q;
        return out;
      }
      if (this.atNewline()) {
        out += "\n";
        this.newline();
        continue;
      }
      const cp = this.s.codePointAt(this.i)!;
      this.controlCheck(cp);
      const ch = String.fromCodePoint(cp);
      out += ch;
      this.i += ch.length;
    }
  }

  // -------------------------------------------------------------------------
  // Numbers, booleans, dates and times

  private scalar(line: number): TomlValue {
    const start = this.i;
    while (this.i < this.s.length && /[0-9A-Za-z_+.:-]/.test(this.s[this.i]!)) this.i++;
    let tok = this.s.slice(start, this.i);
    // A date followed by a space and a time is one date-time ("1979-05-27 07:32:00").
    if (/^\d{4}-\d{2}-\d{2}$/.test(tok) && this.s[this.i] === " " && /^\d{2}:/.test(this.s.slice(this.i + 1, this.i + 4))) {
      this.i++;
      const s2 = this.i;
      while (this.i < this.s.length && /[0-9A-Za-z_+.:-]/.test(this.s[this.i]!)) this.i++;
      tok += " " + this.s.slice(s2, this.i);
    }
    if (tok === "true") return { type: "boolean", value: true, line };
    if (tok === "false") return { type: "boolean", value: false, line };
    if (/^[+-]?(inf|nan)$/.test(tok)) {
      const neg = tok.startsWith("-");
      const v = tok.endsWith("inf") ? (neg ? -Infinity : Infinity) : NaN;
      return { type: "float", value: v, line };
    }
    const dt = parseDatetime(tok);
    if (dt === "invalid") this.fail(`invalid datetime: ${JSON.stringify(tok)}`);
    if (dt) return { ...dt, type: "datetime", value: tok, line };
    // Integers
    if (/^[+-]?(0|[1-9](_?[0-9])*)$/.test(tok)) return this.int(tok, BigInt(tok.replace(/_/g, "")), line);
    if (/^0x[0-9A-Fa-f](_?[0-9A-Fa-f])*$/.test(tok)) return this.int(tok, BigInt("0x" + tok.slice(2).replace(/_/g, "")), line);
    if (/^0o[0-7](_?[0-7])*$/.test(tok)) return this.int(tok, BigInt("0o" + tok.slice(2).replace(/_/g, "")), line);
    if (/^0b[01](_?[01])*$/.test(tok)) return this.int(tok, BigInt("0b" + tok.slice(2).replace(/_/g, "")), line);
    if (/^[+-]?0[0-9_]+$/.test(tok)) this.fail(`Invalid integer ${JSON.stringify(tok)}: cannot have leading zeroes`);
    // Floats
    if (/^[+-]?(0|[1-9](_?[0-9])*)((\.[0-9](_?[0-9])*)([eE][+-]?[0-9](_?[0-9])*)?|[eE][+-]?[0-9](_?[0-9])*)$/.test(tok)) {
      return { type: "float", value: Number(tok.replace(/_/g, "")), line };
    }
    if (tok === "") this.fail(`expected value but found ${charDesc(this.peek())} instead`);
    this.fail(`invalid value: ${JSON.stringify(tok)}`);
  }

  private int(tok: string, v: bigint, line: number): TomlInteger {
    if (v > 0x7fffffffffffffffn || v < -0x8000000000000000n) this.fail(`${tok} is out of range for int64`);
    return { type: "integer", value: v, line };
  }
}

/** Marks an inline table and the tables inside it as frozen. */
function freeze(t: TomlTable): void {
  t.how = "inline";
  for (const v of t.value.values()) {
    if (v.type === "table") freeze(v);
  }
}

function daysIn(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Recognizes the four date/time forms; "invalid" when one matches with values out of range. */
function parseDatetime(tok: string): { kind: TomlDatetime["kind"] } | "invalid" | undefined {
  const date = "(\\d{4})-(\\d{2})-(\\d{2})";
  const time = "(\\d{2}):(\\d{2})(?::(\\d{2})(\\.\\d+)?)?";
  let m = new RegExp(`^${date}[Tt ]${time}([Zz]|[+-]\\d{2}:\\d{2})?$`).exec(tok);
  if (m) {
    if (!validDate(+m[1]!, +m[2]!, +m[3]!) || !validTime(+m[4]!, +m[5]!, m[6] === undefined ? 0 : +m[6])) return "invalid";
    if (m[8] && m[8].length === 6) {
      const oh = +m[8].slice(1, 3);
      const om = +m[8].slice(4, 6);
      if (oh > 23 || om > 59) return "invalid";
    }
    return { kind: m[8] ? "offset-datetime" : "local-datetime" };
  }
  m = new RegExp(`^${date}$`).exec(tok);
  if (m) return validDate(+m[1]!, +m[2]!, +m[3]!) ? { kind: "local-date" } : "invalid";
  m = new RegExp(`^${time}$`).exec(tok);
  if (m) return validTime(+m[1]!, +m[2]!, m[3] === undefined ? 0 : +m[3]) ? { kind: "local-time" } : "invalid";
  return undefined;
}

function validDate(y: number, mo: number, d: number): boolean {
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

function validTime(h: number, mi: number, s: number): boolean {
  return h <= 23 && mi <= 59 && s <= 60;
}
