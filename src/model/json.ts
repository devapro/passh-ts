// A byte-level JSON reader for the data block (vault-format.md §4.2), and the writer's
// string escaping and indentation (§4.6).
//
// The reader checks the whole input first (RFC 8259; nesting at most 10 000 levels, the
// top-level value counting as 1) and reports errors with the texts of the reference's JSON
// library (Go's encoding/json v1 API on its v2 implementation; not normative, vault-format.md
// §3.3): `invalid character 'x' after top-level value`, `unexpected end of JSON input`, …
// It then builds a tree in which every value keeps its byte span, so unknown members can be
// kept "as written" (§4.5, §4.6). Strings are decoded like Go: invalid UTF-8 and unpaired
// surrogate escapes become U+FFFD (one per invalid byte).

import { isGoPrint } from "../i18n/quote.ts";
import { decodeRuneIn, decodeUTF8Lossy } from "../util/unicode.ts";

/** Maximum nesting depth (objects and arrays; the top-level value counts as 1). */
export const MAX_DEPTH = 10_000;

export type JKind = "object" | "array" | "string" | "number" | "true" | "false" | "null";

export interface JMember {
  /** The decoded name. */
  name: string;
  value: JValue;
}

export interface JValue {
  kind: JKind;
  /** Byte span of the value in the input: [start, end). */
  start: number;
  end: number;
  /** Object members in input order (duplicates included). */
  members?: JMember[];
  /** Array elements. */
  items?: JValue[];
  /** Decoded string value. */
  str?: string;
}

/** A JSON syntax error, with the library's text. Not a PasshError: library text isn't translated. */
export class JSONSyntaxError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.name = "JSONSyntaxError";
    this.offset = offset;
  }
}

const HEX = "0123456789abcdef";

/** Go's strconv.QuoteRune of the character at b[i]; an invalid byte is '\xNN'. */
function quoteCharAt(b: Uint8Array, i: number): string {
  const [cp] = decodeRuneIn(b, i, b.length);
  if (cp < 0) return "'\\x" + HEX[b[i]! >> 4] + HEX[b[i]! & 15] + "'";
  return quoteRune(cp);
}

/** Go's strconv.QuoteRune. */
export function quoteRune(cp: number): string {
  if (cp === 0x27) return "'\\''";
  if (cp === 0x5c) return "'\\\\'";
  if (isGoPrint(cp)) return "'" + String.fromCodePoint(cp) + "'";
  switch (cp) {
    case 0x07: return "'\\a'";
    case 0x08: return "'\\b'";
    case 0x0c: return "'\\f'";
    case 0x0a: return "'\\n'";
    case 0x0d: return "'\\r'";
    case 0x09: return "'\\t'";
    case 0x0b: return "'\\v'";
  }
  if (cp < 0x20 || cp === 0x7f) return "'\\x" + HEX[cp >> 4] + HEX[cp & 15] + "'";
  if (cp < 0x10000) return "'\\u" + cp.toString(16).padStart(4, "0") + "'";
  return "'\\U" + cp.toString(16).padStart(8, "0") + "'";
}

function isWS(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

function isHex(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
}

function hexVal(c: number): number {
  if (c <= 0x39) return c - 0x30;
  if (c >= 0x61) return c - 0x61 + 10;
  return c - 0x41 + 10;
}

// Parser frames for the iterative parse.
interface Frame {
  value: JValue;
  /** For objects: the name of the member whose value is being parsed. */
  name?: string;
}

/**
 * Parses one JSON document (the whole input; only SP, TAB, LF, CR around it). Throws
 * JSONSyntaxError with the reference library's text.
 */
export function parseJSON(b: Uint8Array): JValue {
  const n = b.length;
  let i = 0;
  const stack: Frame[] = [];
  const eof = (): never => {
    throw new JSONSyntaxError("unexpected end of JSON input", n);
  };
  const bad = (at: number, context: string): never => {
    if (at >= n) eof();
    throw new JSONSyntaxError("invalid character " + quoteCharAt(b, at) + " " + context, at);
  };
  const skipWS = (): void => {
    while (i < n && isWS(b[i]!)) i++;
  };

  // Parses a string starting at b[i] === '"'; returns the decoded text, leaves i after the quote.
  const parseString = (): string => {
    i++;
    let out = "";
    let chunk = i;
    let simple = true;
    for (;;) {
      if (i >= n) eof();
      const c = b[i]!;
      if (c === 0x22) {
        if (simple) out = decodeUTF8Lossy(b, chunk, i);
        else out += decodeUTF8Lossy(b, chunk, i);
        i++;
        return out;
      }
      if (c < 0x20) bad(i, "in string");
      if (c !== 0x5c) {
        i++;
        continue;
      }
      // escape
      if (simple) {
        out = "";
        simple = false;
      }
      out += decodeUTF8Lossy(b, chunk, i);
      const esc = i;
      if (i + 1 >= n) eof();
      const e = b[i + 1]!;
      switch (e) {
        case 0x22: out += '"'; i += 2; break;
        case 0x5c: out += "\\"; i += 2; break;
        case 0x2f: out += "/"; i += 2; break;
        case 0x62: out += "\b"; i += 2; break;
        case 0x66: out += "\f"; i += 2; break;
        case 0x6e: out += "\n"; i += 2; break;
        case 0x72: out += "\r"; i += 2; break;
        case 0x74: out += "\t"; i += 2; break;
        case 0x75: {
          const u = readU4(esc);
          i = esc + 6;
          if (u >= 0xd800 && u <= 0xdfff) {
            // A valid pair only when a high surrogate is followed by an escaped low one.
            if (u <= 0xdbff && i + 1 < n && b[i] === 0x5c && b[i + 1] === 0x75) {
              const lo = readU4(i);
              if (lo >= 0xdc00 && lo <= 0xdfff) {
                out += String.fromCharCode(u, lo);
                i += 6;
                break;
              }
            }
            out += "�";
          } else {
            out += String.fromCharCode(u);
          }
          break;
        }
        default:
          escapeError(esc, 2);
      }
      chunk = i;
    }
  };
  // Reads the 4 hex digits of a \u escape at b[at] === '\\'.
  const readU4 = (at: number): number => {
    let v = 0;
    for (let k = 2; k < 6; k++) {
      if (at + k >= n) eof();
      const c = b[at + k]!;
      if (!isHex(c)) escapeError(at, 6);
      v = (v << 4) | hexVal(c);
    }
    return v;
  };
  const escapeError = (at: number, len: number): never => {
    if (at + len > n) eof();
    throw new JSONSyntaxError("invalid escape sequence `" + decodeUTF8Lossy(b, at, at + len) + "` in string", at);
  };

  // Parses a number at b[i]; leaves i after it.
  const parseNumber = (): void => {
    if (b[i] === 0x2d) {
      i++;
      if (i >= n) eof();
      if (!(b[i]! >= 0x30 && b[i]! <= 0x39)) bad(i, "in numeric literal");
    }
    if (b[i] === 0x30) i++;
    else while (i < n && b[i]! >= 0x30 && b[i]! <= 0x39) i++;
    if (i < n && b[i] === 0x2e) {
      i++;
      if (i >= n) eof();
      if (!(b[i]! >= 0x30 && b[i]! <= 0x39)) bad(i, "in numeric literal");
      while (i < n && b[i]! >= 0x30 && b[i]! <= 0x39) i++;
    }
    if (i < n && (b[i] === 0x65 || b[i] === 0x45)) {
      i++;
      if (i < n && (b[i] === 0x2b || b[i] === 0x2d)) i++;
      if (i >= n) eof();
      if (!(b[i]! >= 0x30 && b[i]! <= 0x39)) bad(i, "in numeric literal");
      while (i < n && b[i]! >= 0x30 && b[i]! <= 0x39) i++;
    }
  };

  const parseLiteral = (word: string): void => {
    for (let k = 0; k < word.length; k++) {
      if (i + k >= n) eof();
      if (b[i + k] !== word.charCodeAt(k)) bad(i + k, `in literal ${word} (expecting '${word[k]}')`);
    }
    i += word.length;
  };

  let root: JValue | undefined;
  // Attaches a finished value to its parent (or makes it the root).
  const attach = (v: JValue): void => {
    const top = stack[stack.length - 1];
    if (!top) root = v;
    else if (top.value.kind === "array") top.value.items!.push(v);
    else top.value.members!.push({ name: top.name!, value: v });
  };

  // State machine: expecting a value (context names for errors), or after a value.
  let expectValueContext: string | null = "looking for beginning of value";
  for (;;) {
    if (expectValueContext !== null) {
      skipWS();
      if (i >= n) eof();
      const c = b[i]!;
      const start = i;
      if (c === 0x7b || c === 0x5b) {
        if (stack.length + 1 > MAX_DEPTH) throw new JSONSyntaxError("exceeded max depth", i);
        const v: JValue = c === 0x7b ? { kind: "object", start, end: -1, members: [] } : { kind: "array", start, end: -1, items: [] };
        stack.push({ value: v });
        i++;
        skipWS();
        if (i >= n) eof();
        if (c === 0x7b) {
          if (b[i] === 0x7d) {
            i++;
            stack.pop();
            v.end = i;
            attach(v);
            expectValueContext = null;
            continue;
          }
          if (b[i] !== 0x22) bad(i, "looking for beginning of object key string");
          stack[stack.length - 1]!.name = parseString();
          skipWS();
          if (i >= n) eof();
          if (b[i] !== 0x3a) bad(i, "after object key");
          i++;
          expectValueContext = "looking for beginning of value";
          continue;
        }
        if (b[i] === 0x5d) {
          i++;
          stack.pop();
          v.end = i;
          attach(v);
          expectValueContext = null;
          continue;
        }
        expectValueContext = "looking for beginning of value";
        continue;
      }
      let v: JValue;
      if (c === 0x22) {
        const str = parseString();
        v = { kind: "string", start, end: i, str };
      } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
        parseNumber();
        v = { kind: "number", start, end: i };
      } else if (c === 0x74) {
        parseLiteral("true");
        v = { kind: "true", start, end: i };
      } else if (c === 0x66) {
        parseLiteral("false");
        v = { kind: "false", start, end: i };
      } else if (c === 0x6e) {
        parseLiteral("null");
        v = { kind: "null", start, end: i };
      } else {
        return bad(i, expectValueContext);
      }
      attach(v);
      expectValueContext = null;
      continue;
    }
    // After a value.
    skipWS();
    const top = stack[stack.length - 1];
    if (!top) {
      if (i < n) bad(i, "after top-level value");
      return root!;
    }
    if (i >= n) eof();
    const c = b[i]!;
    if (top.value.kind === "object") {
      if (c === 0x2c) {
        i++;
        skipWS();
        if (i >= n) eof();
        if (b[i] !== 0x22) bad(i, "looking for beginning of object key string");
        top.name = parseString();
        skipWS();
        if (i >= n) eof();
        if (b[i] !== 0x3a) bad(i, "after object key");
        i++;
        expectValueContext = "looking for beginning of value";
        continue;
      }
      if (c === 0x7d) {
        i++;
        stack.pop();
        top.value.end = i;
        attach(top.value);
        continue;
      }
      bad(i, "after object key:value pair");
    } else {
      if (c === 0x2c) {
        i++;
        expectValueContext = "looking for beginning of value";
        continue;
      }
      if (c === 0x5d) {
        i++;
        stack.pop();
        top.value.end = i;
        attach(top.value);
        continue;
      }
      bad(i, "after array element");
    }
  }
}

/**
 * The value's JSON text as written with insignificant white space removed (§4.6): numbers,
 * escapes and duplicate members unchanged. Invalid UTF-8 inside it becomes U+FFFD, one per
 * byte (the proposed fix of audit #31; passh v0.6 copies such bytes).
 */
// SPEC-GAP: §4.6 / audit #31: passh v0.6 copies invalid UTF-8 inside unknown values byte for
// byte; we implement the proposed fix (one U+FFFD per invalid byte, as known strings get).
export function compactRaw(b: Uint8Array, v: JValue): string {
  const out: number[] = [];
  let inStr = false;
  for (let i = v.start; i < v.end; i++) {
    const c = b[i]!;
    if (inStr) {
      out.push(c);
      if (c === 0x5c) {
        out.push(b[++i]!);
      } else if (c === 0x22) inStr = false;
      continue;
    }
    if (isWS(c)) continue;
    if (c === 0x22) inStr = true;
    out.push(c);
  }
  return decodeUTF8Lossy(Uint8Array.from(out));
}

// ---------------------------------------------------------------------------
// Writing (§4.6)

/** A JSON string as passh writes it: no HTML escaping; `\"` `\\` `\n` `\r` `\t` `\b` `\f`, other C0 as `\u00xx`, U+2028/2029 escaped. */
export function quoteJSON(s: string): string {
  let out = '"';
  let chunk = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep: string | undefined;
    if (c < 0x20) {
      switch (c) {
        case 0x0a: rep = "\\n"; break;
        case 0x0d: rep = "\\r"; break;
        case 0x09: rep = "\\t"; break;
        case 0x08: rep = "\\b"; break;
        case 0x0c: rep = "\\f"; break;
        default: rep = "\\u00" + HEX[c >> 4] + HEX[c & 15];
      }
    } else if (c === 0x22) rep = '\\"';
    else if (c === 0x5c) rep = "\\\\";
    else if (c === 0x2028) rep = "\\u2028";
    else if (c === 0x2029) rep = "\\u2029";
    if (rep !== undefined) {
      out += s.slice(chunk, i) + rep;
      chunk = i + 1;
    }
  }
  return out + s.slice(chunk) + '"';
}

/**
 * Indents compact JSON text the way Go's json.Indent does with a two-space indent:
 * one element per line, `": "` after keys, `[]` and `{}` for empty ones. `depth` is the
 * nesting level of the line the value starts on.
 */
export function indentCompact(compact: string, depth: number): string {
  let out = "";
  let inStr = false;
  let needIndent = false;
  let d = depth;
  let chunk = 0;
  const nl = (k: number) => "\n" + "  ".repeat(k);
  for (let i = 0; i < compact.length; i++) {
    const c = compact.charCodeAt(i);
    if (inStr) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inStr = false;
      continue;
    }
    if (c === 0x22) {
      if (needIndent) {
        out += compact.slice(chunk, i) + nl(d);
        chunk = i;
        needIndent = false;
      }
      inStr = true;
      continue;
    }
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
      out += compact.slice(chunk, i);
      chunk = i + 1;
      continue;
    }
    if (needIndent && c !== 0x5d && c !== 0x7d) {
      out += compact.slice(chunk, i) + nl(d);
      chunk = i;
      needIndent = false;
    }
    switch (c) {
      case 0x7b:
      case 0x5b:
        needIndent = true;
        d++;
        break;
      case 0x2c:
        out += compact.slice(chunk, i + 1) + nl(d);
        chunk = i + 1;
        break;
      case 0x3a:
        out += compact.slice(chunk, i + 1) + " ";
        chunk = i + 1;
        break;
      case 0x7d:
      case 0x5d:
        if (needIndent) {
          needIndent = false; // empty: "{}" / "[]"
        } else {
          out += compact.slice(chunk, i) + nl(d - 1);
          chunk = i;
        }
        d--;
        break;
    }
  }
  return out + compact.slice(chunk);
}
