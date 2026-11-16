// S4 terminal escaping (spec §5.5 S4, agent-session.md §A9.1).
//
// Two forms over a string of bytes: single-line (escapeLine) for one value or name, and
// multi-line (escapeMultiline), which keeps LF and TAB raw. A JS string is taken as its
// UTF-8 bytes; a lone surrogate counts as invalid bytes (its generalized UTF-8 form, three
// bytes, each written \xNN).
// SPEC-GAP: the spec works on bytes; a JS string with a lone surrogate has no UTF-8 form, so
// we escape its WTF-8 bytes (U+D800 → \xed\xa0\x80).

import { decodeRuneIn, isFormat, isLetter, isMark, isNumber, isSymbol, toBytes, hasLoneSurrogate } from "../util/unicode.ts";

export { stringWidth, runeWidth } from "./width.ts";

const HEX = "0123456789abcdef";

function hex2(b: number): string {
  return "\\x" + HEX[b >> 4]! + HEX[b & 15]!;
}

function uEscape(cp: number): string {
  if (cp > 0xffff) return "\\U" + cp.toString(16).padStart(8, "0");
  return "\\u" + cp.toString(16).padStart(4, "0");
}

/**
 * "Visible non-ASCII" (§A9.1 rule 3): a valid character ≥ U+0080, not U+FFFD, of general
 * category L, M, N or S.
 */
function visibleNonASCII(cp: number): boolean {
  if (cp < 0x80 || cp === 0xfffd) return false;
  return isLetter(cp) || isMark(cp) || isNumber(cp) || isSymbol(cp);
}

/** Rule 3: C1 controls, U+2028, U+2029 and Cf are escaped (ZWNJ/ZWJ sometimes kept). */
function needsEscape(cp: number): boolean {
  return (cp >= 0x80 && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029 || isFormat(cp);
}

/** Whether b[i] starts a visible non-ASCII character (false at the end, for ASCII and invalid bytes). */
function visibleAt(b: Uint8Array, i: number): boolean {
  if (i >= b.length) return false;
  if (b[i]! < 0x80) return false;
  const [cp] = decodeRuneIn(b, i, b.length);
  return cp >= 0 && visibleNonASCII(cp);
}

function escapeBytes(b: Uint8Array, multiline: boolean): string {
  let out = "";
  let i = 0;
  let prevVisible = false;
  const n = b.length;
  while (i < n) {
    const c = b[i]!;
    if (c < 0x80) {
      if (c >= 0x20 && c !== 0x7f) out += String.fromCharCode(c);
      else if (c === 0x09) out += multiline ? "\t" : "\\t";
      else if (c === 0x0a) out += multiline ? "\n" : "\\n";
      else if (c === 0x0d) out += "\\r";
      else out += hex2(c);
      prevVisible = false;
      i++;
      continue;
    }
    const [cp, size] = decodeRuneIn(b, i, n);
    if (cp < 0) {
      out += hex2(c);
      prevVisible = false;
      i++;
      continue;
    }
    if (needsEscape(cp)) {
      const joiner = cp === 0x200c || cp === 0x200d;
      if (joiner && prevVisible && visibleAt(b, i + size)) out += String.fromCodePoint(cp);
      else out += uEscape(cp);
    } else {
      out += String.fromCodePoint(cp);
    }
    prevVisible = visibleNonASCII(cp);
    i += size;
  }
  return out;
}

/** True when every code unit is printable ASCII (nothing to escape). */
function plainASCII(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c >= 0x7f) return false;
  }
  return true;
}

/** True when the string needs no escaping in either form, checked cheaply where possible. */
function unchangedFast(s: string, multiline: boolean): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c < 0x7f) continue;
    if (multiline && (c === 0x0a || c === 0x09)) continue;
    return false;
  }
  return true;
}

/**
 * S4 single-line form (§A9.1): one value or name. Control bytes become `\t` `\n` `\r` or
 * `\xNN`, invalid UTF-8 bytes `\xNN`, C1 controls, U+2028/2029 and Cf characters `\uXXXX`
 * (`\UXXXXXXXX` above U+FFFF), except a ZWNJ/ZWJ between two visible non-ASCII characters.
 * The backslash itself is not escaped, so escaping twice changes nothing.
 */
export function escapeLine(s: string | Uint8Array): string {
  if (typeof s === "string" && plainASCII(s)) return s;
  return escapeBytes(toBytes(s), false);
}

/** S4 multi-line form (§A9.1): the single-line form, but LF and TAB are kept as they are. */
export function escapeMultiline(s: string | Uint8Array): string {
  if (typeof s === "string" && unchangedFast(s, true)) return s;
  return escapeBytes(toBytes(s), true);
}

/** Reports whether escapeLine would change the value (used to decide on quoting or marking). */
export function needsEscaping(s: string | Uint8Array): boolean {
  if (typeof s === "string") {
    if (plainASCII(s)) return false;
    if (hasLoneSurrogate(s)) return true;
    return escapeLine(s) !== s;
  }
  return escapeLine(s) !== new TextDecoder().decode(s);
}
