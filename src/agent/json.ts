// The JSON of the agent protocol (agent-session.md §A2.5), decoded and encoded the way the
// reference does (Go's encoding/json), so that old and new agents refuse the same requests
// and clients read the same answers:
//
// - the whole input must be one valid JSON value with only white space (space, TAB, CR,
//   LF) around it, else a syntax error;
// - the value is decoded into a few typed members: member names match case-insensitively
//   (Unicode simple folding, so U+212A KELVIN SIGN matches `k`), a repeated member keeps its
//   last value, `null` leaves a member as it was, unknown members are ignored;
// - a member of the wrong JSON type (`"v":"1"`, `"v":1.0`, `"v":1e0`, `"op":5`), an integer
//   outside int64, or a top-level value other than an object or `null` is a type error;
// - strings are decoded like Go: invalid UTF-8 bytes and lone surrogate escapes become
//   U+FFFD (one per invalid byte).

import { decodeRune } from "../i18n/quote.ts";
import { simpleFold } from "../util/unicode.ts";

/** The Go type a member is decoded into: int (int64), string, bool, or json.RawMessage. */
export type FieldKind = "int" | "string" | "bool" | "raw";

export type FieldValue = bigint | string | boolean | Uint8Array;

/** Not valid JSON (Go's SyntaxError). */
export class JsonSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonSyntaxError";
  }
}

export interface Decoded {
  /** The members found (by field name as declared); absent or only `null` → not set. */
  values: Map<string, FieldValue>;
  /** A wrong JSON type somewhere (Go's UnmarshalTypeError): decoding failed. */
  typeError: boolean;
}

const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

function isWs(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
}

type Value =
  | { kind: "object"; start: number; end: number; members: Array<{ name: string; value: Value }> }
  | { kind: "array"; start: number; end: number }
  | { kind: "string"; start: number; end: number; text: string }
  | { kind: "number"; start: number; end: number; literal: string }
  | { kind: "bool"; start: number; end: number; value: boolean }
  | { kind: "null"; start: number; end: number };

class Parser {
  private i = 0;
  constructor(private readonly b: Uint8Array) {}

  private fail(what: string): never {
    throw new JsonSyntaxError(`invalid JSON: ${what} at offset ${this.i}`);
  }

  private ws(): void {
    while (this.i < this.b.length && isWs(this.b[this.i]!)) this.i++;
  }

  parseTop(): Value {
    this.ws();
    const v = this.value(0, true);
    this.ws();
    if (this.i !== this.b.length) this.fail("text after the top-level value");
    return v;
  }

  /** Parses a value; `keep` = record object members (only the top level needs them). */
  private value(depth: number, keep: boolean): Value {
    if (depth > 10000) this.fail("nesting too deep");
    const start = this.i;
    const c = this.b[this.i];
    if (c === undefined) this.fail("unexpected end of input");
    if (c === 0x7b) return this.object(depth, keep);
    if (c === 0x5b) {
      this.i++;
      this.ws();
      if (this.b[this.i] === 0x5d) {
        this.i++;
        return { kind: "array", start, end: this.i };
      }
      for (;;) {
        this.ws();
        this.value(depth + 1, false);
        this.ws();
        const d = this.b[this.i];
        if (d === 0x2c) {
          this.i++;
          continue;
        }
        if (d === 0x5d) {
          this.i++;
          return { kind: "array", start, end: this.i };
        }
        this.fail("expected , or ]");
      }
    }
    if (c === 0x22) {
      const text = this.string();
      return { kind: "string", start, end: this.i, text };
    }
    if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      this.number();
      return { kind: "number", start, end: this.i, literal: latin1(this.b, start, this.i) };
    }
    if (this.literal("true")) return { kind: "bool", start, end: this.i, value: true };
    if (this.literal("false")) return { kind: "bool", start, end: this.i, value: false };
    if (this.literal("null")) return { kind: "null", start, end: this.i };
    this.fail("invalid character");
  }

  private literal(word: string): boolean {
    for (let k = 0; k < word.length; k++) {
      if (this.b[this.i + k] !== word.charCodeAt(k)) {
        // A literal that starts right but ends wrong ("tru") is a syntax error either way.
        return false;
      }
    }
    this.i += word.length;
    return true;
  }

  private object(depth: number, keep: boolean): Value {
    const start = this.i;
    this.i++; // {
    const members: Array<{ name: string; value: Value }> = [];
    this.ws();
    if (this.b[this.i] === 0x7d) {
      this.i++;
      return { kind: "object", start, end: this.i, members };
    }
    for (;;) {
      this.ws();
      if (this.b[this.i] !== 0x22) this.fail("expected a member name");
      const name = this.string();
      this.ws();
      if (this.b[this.i] !== 0x3a) this.fail("expected :");
      this.i++;
      this.ws();
      const value = this.value(depth + 1, false);
      if (keep) members.push({ name, value });
      this.ws();
      const d = this.b[this.i];
      if (d === 0x2c) {
        this.i++;
        continue;
      }
      if (d === 0x7d) {
        this.i++;
        return { kind: "object", start, end: this.i, members };
      }
      this.fail("expected , or }");
    }
  }

  private number(): void {
    const b = this.b;
    if (b[this.i] === 0x2d) this.i++;
    const d0 = b[this.i];
    if (d0 === 0x30) this.i++;
    else if (d0 !== undefined && d0 >= 0x31 && d0 <= 0x39) {
      while (isDigit(b[this.i])) this.i++;
    } else this.fail("invalid number");
    if (b[this.i] === 0x2e) {
      this.i++;
      if (!isDigit(b[this.i])) this.fail("invalid number");
      while (isDigit(b[this.i])) this.i++;
    }
    if (b[this.i] === 0x65 || b[this.i] === 0x45) {
      this.i++;
      if (b[this.i] === 0x2b || b[this.i] === 0x2d) this.i++;
      if (!isDigit(b[this.i])) this.fail("invalid number");
      while (isDigit(b[this.i])) this.i++;
    }
  }

  /** A string literal at this.i (the opening quote): its decoded text (Go's unquote). */
  private string(): string {
    const b = this.b;
    this.i++; // "
    let out = "";
    for (;;) {
      const c = b[this.i];
      if (c === undefined) this.fail("unterminated string");
      if (c === 0x22) {
        this.i++;
        return out;
      }
      if (c < 0x20) this.fail("control character in string");
      if (c === 0x5c) {
        const e = b[this.i + 1];
        switch (e) {
          case 0x22: out += '"'; this.i += 2; continue;
          case 0x5c: out += "\\"; this.i += 2; continue;
          case 0x2f: out += "/"; this.i += 2; continue;
          case 0x62: out += "\b"; this.i += 2; continue;
          case 0x66: out += "\f"; this.i += 2; continue;
          case 0x6e: out += "\n"; this.i += 2; continue;
          case 0x72: out += "\r"; this.i += 2; continue;
          case 0x74: out += "\t"; this.i += 2; continue;
          case 0x75: {
            const u = this.hex4(this.i + 2);
            this.i += 6;
            if (u >= 0xd800 && u < 0xdc00) {
              // A high surrogate: a pair only with a following \uDC00–\uDFFF.
              if (b[this.i] === 0x5c && b[this.i + 1] === 0x75) {
                const lo = this.hex4(this.i + 2, true);
                if (lo >= 0xdc00 && lo < 0xe000) {
                  out += String.fromCodePoint(0x10000 + ((u - 0xd800) << 10) + (lo - 0xdc00));
                  this.i += 6;
                  continue;
                }
              }
              out += "�";
              continue;
            }
            if (u >= 0xdc00 && u < 0xe000) {
              out += "�";
              continue;
            }
            out += String.fromCharCode(u);
            continue;
          }
          default:
            this.fail("invalid escape");
        }
      }
      if (c < 0x80) {
        out += String.fromCharCode(c);
        this.i++;
        continue;
      }
      const [cp, size] = decodeRune(b, this.i);
      if (cp < 0) {
        out += "�";
        this.i += 1;
      } else {
        out += String.fromCodePoint(cp);
        this.i += size;
      }
    }
  }

  /** Four hex digits at j; `peek`: -1 instead of a syntax error (a following \u that isn't hex fails later). */
  private hex4(j: number, peek = false): number {
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const c = this.b[j + k];
      let d = -1;
      if (c !== undefined) {
        if (c >= 0x30 && c <= 0x39) d = c - 0x30;
        else if (c >= 0x61 && c <= 0x66) d = c - 0x61 + 10;
        else if (c >= 0x41 && c <= 0x46) d = c - 0x41 + 10;
      }
      if (d < 0) {
        if (peek) return -1;
        this.i = j + k;
        this.fail("invalid \\u escape");
      }
      v = v * 16 + d;
    }
    return v;
  }
}

function isDigit(c: number | undefined): boolean {
  return c !== undefined && c >= 0x30 && c <= 0x39;
}

function latin1(b: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let k = start; k < end; k++) s += String.fromCharCode(b[k]!);
  return s;
}

/** Go's case-insensitive member-name key (Unicode simple folding). */
function foldKey(name: string): string {
  let out = "";
  for (const ch of name) out += String.fromCodePoint(simpleFold(ch.codePointAt(0)!));
  return out;
}

/**
 * Validates `input` as one JSON value and decodes it into the declared members, like Go's
 * json.Unmarshal into a struct whose fields have these (lower-case) names and kinds.
 * Throws JsonSyntaxError for invalid JSON. A raw member keeps its value's exact bytes.
 */
export function decodeMembers(input: Uint8Array, fields: Readonly<Record<string, FieldKind>>): Decoded {
  const top = new Parser(input).parseTop();
  const values = new Map<string, FieldValue>();
  if (top.kind === "null") return { values, typeError: false };
  if (top.kind !== "object") return { values, typeError: true };
  const byFold = new Map<string, [string, FieldKind]>();
  for (const [name, kind] of Object.entries(fields)) byFold.set(foldKey(name), [name, kind]);
  let typeError = false;
  for (const m of top.members) {
    const f = byFold.get(foldKey(m.name));
    if (!f) continue;
    const [name, kind] = f;
    const v = m.value;
    if (kind === "raw") {
      values.set(name, input.slice(v.start, v.end));
      continue;
    }
    if (v.kind === "null") continue;
    switch (kind) {
      case "int": {
        if (v.kind !== "number" || /[.eE]/.test(v.literal)) {
          typeError = true;
          break;
        }
        const n = BigInt(v.literal);
        if (n < INT64_MIN || n > INT64_MAX) typeError = true;
        else values.set(name, n);
        break;
      }
      case "string":
        if (v.kind !== "string") typeError = true;
        else values.set(name, v.text);
        break;
      case "bool":
        if (v.kind !== "bool") typeError = true;
        else values.set(name, v.value);
        break;
    }
  }
  return { values, typeError };
}

/**
 * A JSON string as Go's json.Marshal writes it: `"`, `\` and control characters escaped
 * (`\n`, `\r`, `\t`, `\b`, `\f`, else `\u00XX`), HTML-safe `<`, `>`, `&` as `<`,
 * `>`, `&`, U+2028/U+2029 as ` `/` `, a lone surrogate as `�`.
 */
export function goJsonString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    switch (c) {
      case 0x22: out += '\\"'; continue;
      case 0x5c: out += "\\\\"; continue;
      case 0x0a: out += "\\n"; continue;
      case 0x0d: out += "\\r"; continue;
      case 0x09: out += "\\t"; continue;
      case 0x08: out += "\\b"; continue;
      case 0x0c: out += "\\f"; continue;
      case 0x3c: out += "\\u003c"; continue;
      case 0x3e: out += "\\u003e"; continue;
      case 0x26: out += "\\u0026"; continue;
      case 0x2028: out += "\\u2028"; continue;
      case 0x2029: out += "\\u2029"; continue;
    }
    if (c < 0x20) out += "\\u00" + c.toString(16).padStart(2, "0");
    else if (c >= 0xd800 && c <= 0xdfff) out += "\\ufffd";
    else out += ch;
  }
  return out + '"';
}
