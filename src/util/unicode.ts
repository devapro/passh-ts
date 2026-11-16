// Unicode helpers with the tables of Unicode 15.0.0 (vault-format.md, conventions at the
// top: "white space", "control character", "in any case", "Unicode version"), and the
// UTF-8 helpers the data modules share.
//
// The tables are generated (src/util/gen-unicode-data.ts → src/util/unicode-data.ts) rather
// than taken from the JS engine's regexp tables, whose Unicode version follows the engine
// (Bun 1.4 mixes 15.1 and 17.0 data) while the spec fixes 15.0.0.
// SPEC-GAP: East Asian Width of unassigned code points is not normative; we use the defaults
// stated in EastAsianWidth.txt (W in the CJK blocks and planes 2–3).

import { GC_CHARS, GC_NAMES, GC_RUNS, WIDE_RANGES, FOLD_RUNS } from "./unicode-data.ts";
import { decodeRune, isValidUTF8 } from "../i18n/quote.ts";

export { decodeRune, isValidUTF8 };

export type GeneralCategory = (typeof GC_NAMES)[number];

// ---------------------------------------------------------------------------
// General categories

const [runStarts, runCats] = ((): [Uint32Array, Uint8Array] => {
  const starts: number[] = [];
  const cats: number[] = [];
  let pos = 0;
  let num = "";
  for (let i = 0; i < GC_RUNS.length; i++) {
    const ch = GC_RUNS[i]!;
    const k = GC_CHARS.indexOf(ch);
    if (k < 0) {
      num += ch;
      continue;
    }
    pos += parseInt(num, 36);
    num = "";
    starts.push(pos);
    cats.push(k);
  }
  return [Uint32Array.from(starts), Uint8Array.from(cats)];
})();

const latin1 = new Uint8Array(256);
for (let c = 0; c < 256; c++) latin1[c] = lookupCat(c);

function lookupCat(cp: number): number {
  let lo = 0;
  let hi = runStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (runStarts[mid]! <= cp) lo = mid;
    else hi = mid - 1;
  }
  return runCats[lo]!;
}

function catIndex(cp: number): number {
  if (cp < 0 || cp > 0x10ffff) return 0; // Cn
  if (cp < 256) return latin1[cp]!;
  return lookupCat(cp);
}

/** The general category of a code point (Unicode 15.0.0; Cn for unassigned and out of range). */
export function generalCategory(cp: number): GeneralCategory {
  return GC_NAMES[catIndex(cp)]!;
}

// Indexes in GC_NAMES: Cn 0, Lu 1, Ll 2, Lt 3, Lm 4, Lo 5, Mn 6, Mc 7, Me 8, Nd 9, Nl 10, No 11,
// Pc 12 … Po 18, Sm 19 … So 22, Zs 23, Zl 24, Zp 25, Cc 26, Cf 27, Cs 28, Co 29.

/** Letter: L* (Lu, Ll, Lt, Lm, Lo). */
export function isLetter(cp: number): boolean {
  const k = catIndex(cp);
  return k >= 1 && k <= 5;
}
/** Mark: M* (Mn, Mc, Me). */
export function isMark(cp: number): boolean {
  const k = catIndex(cp);
  return k >= 6 && k <= 8;
}
/** Non-spacing or enclosing mark (Mn, Me): zero display width (print.md §3.2). */
export function isZeroWidthMark(cp: number): boolean {
  const k = catIndex(cp);
  return k === 6 || k === 8;
}
/** Number: N* (Nd, Nl, No). */
export function isNumber(cp: number): boolean {
  const k = catIndex(cp);
  return k >= 9 && k <= 11;
}
/** Decimal digit: Nd. */
export function isDecimalDigit(cp: number): boolean {
  return catIndex(cp) === 9;
}
/** Punctuation: P*. */
export function isPunct(cp: number): boolean {
  const k = catIndex(cp);
  return k >= 12 && k <= 18;
}
/** Symbol: S*. */
export function isSymbol(cp: number): boolean {
  const k = catIndex(cp);
  return k >= 19 && k <= 22;
}
/** Upper case letter: Lu (fuzzy matching's camelCase rule, cli.md). */
export function isUpper(cp: number): boolean {
  return catIndex(cp) === 1;
}
/** Lower case letter: Ll. */
export function isLower(cp: number): boolean {
  return catIndex(cp) === 2;
}
/** Control character: Cc, U+0000–U+001F and U+007F–U+009F. */
export function isControl(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
}
/** Format character: Cf. */
export function isFormat(cp: number): boolean {
  return catIndex(cp) === 27;
}

/** Unicode White_Space (vault-format.md conventions; Go's unicode.IsSpace). */
export function isWhiteSpace(cp: number): boolean {
  if (cp <= 0xff) return (cp >= 0x09 && cp <= 0x0d) || cp === 0x20 || cp === 0x85 || cp === 0xa0;
  return cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 || cp === 0x202f || cp === 0x205f || cp === 0x3000;
}

/** Removes leading and trailing white space (Go's strings.TrimSpace). */
export function trimWhiteSpace(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b) {
    const cp = s.codePointAt(a)!;
    if (!isWhiteSpace(cp)) break;
    a += cp > 0xffff ? 2 : 1;
  }
  while (b > a) {
    const cu = s.charCodeAt(b - 1);
    // White space is all in the BMP; a low surrogate ends a non-space character.
    if (!isWhiteSpace(cu)) break;
    b--;
  }
  return s.slice(a, b);
}

/** Reports whether the string is empty or only white space. */
export function isBlank(s: string): boolean {
  return trimWhiteSpace(s) === "";
}

/** Reports whether the string holds a control character (Cc). */
export function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// East Asian Width

/** Reports whether the East Asian Width of the code point is Wide (W) or Fullwidth (F). */
export function isWide(cp: number): boolean {
  if (cp < 0x1100) return false;
  let lo = 0;
  let hi = WIDE_RANGES.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (cp < WIDE_RANGES[2 * mid]!) hi = mid - 1;
    else if (cp > WIDE_RANGES[2 * mid + 1]!) lo = mid + 1;
    else return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Simple case folding ("in any case")

const foldMap: Map<number, number> = (() => {
  const m = new Map<number, number>();
  for (let i = 0; i < FOLD_RUNS.length; i += 4) {
    const start = FOLD_RUNS[i]!;
    const count = FOLD_RUNS[i + 1]!;
    const stride = FOLD_RUNS[i + 2]!;
    const delta = FOLD_RUNS[i + 3]!;
    for (let k = 0; k < count; k++) m.set(start + k * stride, start + k * stride + delta);
  }
  return m;
})();

/**
 * The simple case folding of a code point (CaseFolding.txt statuses C and S): the common
 * representative of its case-folding orbit, so two code points are equal "in any case"
 * exactly when their folds are equal (`K`, `k` and U+212A all fold to `k`).
 */
export function simpleFold(cp: number): number {
  if (cp < 0x80) return cp >= 0x41 && cp <= 0x5a ? cp + 0x20 : cp;
  return foldMap.get(cp) ?? cp;
}

/** Reports whether two code points are equal under simple case folding. */
export function runeFoldEquals(a: number, b: number): boolean {
  return a === b || simpleFold(a) === simpleFold(b);
}

/** Folds every code point of a string (simple case folding). */
export function foldString(s: string): string {
  let out = "";
  for (const ch of s) out += String.fromCodePoint(simpleFold(ch.codePointAt(0)!));
  return out;
}

/** Reports whether two strings are equal "in any case" (Unicode simple case folding, Go's strings.EqualFold). */
export function foldEquals(a: string, b: string): boolean {
  if (a === b) return true;
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return !!x.done && !!y.done;
    if (!runeFoldEquals(x.value.codePointAt(0)!, y.value.codePointAt(0)!)) return false;
  }
}

// ---------------------------------------------------------------------------
// UTF-8

const encoder = new TextEncoder();

/** UTF-8 bytes of a string (a lone surrogate becomes U+FFFD, as TextEncoder does). */
export function utf8Encode(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Length of a string in UTF-8 bytes (a lone surrogate counts 3, as U+FFFD). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * Generalized UTF-8 ("WTF-8") of a JS string: like UTF-8, but a lone surrogate is encoded
 * as its own 3 bytes (ED A0 80 … ED BF BF), which no UTF-8 decoder accepts. So a string
 * with a lone surrogate is "invalid UTF-8", byte for byte, as the spec's byte rules see it.
 */
export function wtf8Encode(s: string): Uint8Array {
  if (!hasLoneSurrogate(s)) return encoder.encode(s);
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(i + 1) - 0xdc00);
      i++;
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

/** Bytes of a value: a Uint8Array as is, a string as its WTF-8 (see wtf8Encode). */
export function toBytes(s: string | Uint8Array): Uint8Array {
  return typeof s === "string" ? wtf8Encode(s) : s;
}

/** Reports whether a JS string holds an unpaired surrogate (so it has no UTF-8 form). */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    if (c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      i++;
      continue;
    }
    return true;
  }
  return false;
}

/** Reports whether a value is valid UTF-8 (a string: no lone surrogate). */
export function isValidText(s: string | Uint8Array): boolean {
  return typeof s === "string" ? !hasLoneSurrogate(s) : isValidUTF8(s);
}

/**
 * Decodes UTF-8 the way Go converts bytes to runes: each byte that doesn't start a valid
 * sequence becomes one U+FFFD (so E2 82 gives two). TextDecoder would give one per
 * maximal subpart instead.
 */
export function decodeUTF8Lossy(b: Uint8Array, start = 0, end = b.length): string {
  let out = "";
  let i = start;
  let chunkStart = start;
  const dec = new TextDecoder("utf-8", { ignoreBOM: true });
  while (i < end) {
    if (b[i]! < 0x80) {
      i++;
      continue;
    }
    const [cp, size] = decodeRuneIn(b, i, end);
    if (cp >= 0) {
      i += size;
      continue;
    }
    if (i > chunkStart) out += dec.decode(b.subarray(chunkStart, i));
    out += "\ufffd";
    i++;
    chunkStart = i;
  }
  if (end > chunkStart) out += dec.decode(b.subarray(chunkStart, end));
  return out;
}

/** decodeRune limited to b[0:end]: [codePoint, size], codePoint -1 for an invalid byte (size 1). */
export function decodeRuneIn(s: Uint8Array, i: number, end: number): [number, number] {
  const b0 = s[i]!;
  if (b0 < 0x80) return [b0, 1];
  let need: number, min: number, cp: number;
  if (b0 >= 0xc2 && b0 <= 0xdf) { need = 1; min = 0x80; cp = b0 & 0x1f; }
  else if (b0 >= 0xe0 && b0 <= 0xef) { need = 2; min = 0x800; cp = b0 & 0x0f; }
  else if (b0 >= 0xf0 && b0 <= 0xf4) { need = 3; min = 0x10000; cp = b0 & 0x07; }
  else return [-1, 1];
  if (i + need >= end) return [-1, 1];
  for (let k = 1; k <= need; k++) {
    const c = s[i + k]!;
    if ((c & 0xc0) !== 0x80) return [-1, 1];
    cp = (cp << 6) | (c & 0x3f);
  }
  if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return [-1, 1];
  return [cp, need + 1];
}

/** Strict UTF-8 decoding: undefined if the bytes aren't valid UTF-8. */
export function decodeUTF8Strict(b: Uint8Array): string | undefined {
  if (!isValidUTF8(b)) return undefined;
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(b);
}

/**
 * Compares two strings by their UTF-8 bytes (= code point order), as Go compares strings.
 * JS's `<` compares UTF-16 code units, which puts U+10000… before U+E000–U+FFFF.
 */
export function compareUTF8(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    // Surrogates (U+10000 and up) sort after U+E000–U+FFFF in code point order.
    if (x >= 0xd800) x = x <= 0xdfff ? x + 0x2000 : x - 0x800;
    if (y >= 0xd800) y = y <= 0xdfff ? y + 0x2000 : y - 0x800;
    return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Compares two byte arrays (Go's bytes.Compare). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** The number of code points of a string (a lone surrogate counts 1). */
export function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) i++;
    n++;
  }
  return n;
}
