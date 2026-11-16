// Bech32 (BIP 173, not Bech32m) as age uses it: no length limit on the data part, the
// string all upper or all lower case, the checksum computed over the lower-case form
// (c2sp.org/age "Conventions"; vault-format.md §3.1).
//
// Error texts follow age's own bech32 errors, because passh shows them inside
// `--age: invalid age recipient "…": malformed recipient "…": <error>` (import-export.md
// §2.7). Positions are byte offsets in the UTF-8 string, like Go's.

import { errorf, type PasshError } from "../i18n/index.ts";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: ArrayLike<number>): number {
  let chk = 1;
  for (let i = 0; i < values.length; i++) {
    const top = chk >>> 25;
    chk = (((chk & 0x1ffffff) << 5) ^ values[i]!) >>> 0;
    for (let j = 0; j < 5; j++) if ((top >>> j) & 1) chk = (chk ^ GENERATOR[j]!) >>> 0;
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function verifyChecksum(hrp: string, data: number[]): boolean {
  return polymod([...hrpExpand(hrp), ...data]) === 1;
}

function createChecksum(hrp: string, data: number[]): number[] {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const out: number[] = [];
  for (let i = 0; i < 6; i++) out.push((mod >>> (5 * (5 - i))) & 31);
  return out;
}

/** Regroups bits (BIP 173 convertbits). Without padding, leftover bits must be fewer than `from` and zero. */
export function convertBits(data: ArrayLike<number>, from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (v >> from !== 0) throw errorf("invalid data range: data[%d]=%d (frombits=%d)", i, v, from);
    acc = ((acc << from) | v) & 0xffffff;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from) {
    throw errorf("illegal zero padding");
  } else if (((acc << (to - bits)) & maxv) !== 0) {
    throw errorf("non-zero padding");
  }
  return out;
}

/**
 * Encodes data as Bech32 with the given human-readable part. `upper` gives the upper-case
 * form (age secret keys); the checksum is the same either way.
 */
export function bech32Encode(hrp: string, data: Uint8Array, upper = false): string {
  const lowerHrp = hrp.toLowerCase();
  const words = convertBits(data, 8, 5, true);
  const all = [...words, ...createChecksum(lowerHrp, words)];
  let s = lowerHrp + "1";
  for (const w of all) s += CHARSET[w];
  return upper ? s.toUpperCase() : s;
}

/** Byte length of a code point in UTF-8. */
function utf8Len(cp: number): number {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** Byte offset of the UTF-16 index i in s. */
function byteOffset(s: string, i: number): number {
  return Buffer.byteLength(s.slice(0, i), "utf8");
}

export interface Bech32Decoded {
  /** The human-readable part as written (upper case for an upper-case string). */
  hrp: string;
  data: Uint8Array;
}

/**
 * Decodes a Bech32 string. Throws a PasshError with age's text: `mixed case`,
 * `separator '1' at invalid position: pos=N, len=N`, `invalid character human-readable part: s[N]=N`,
 * `invalid character data part: s[N]=N`, `invalid checksum`, `illegal zero padding`, `non-zero padding`.
 */
export function bech32Decode(s: string): Bech32Decoded {
  const lower = s.toLowerCase();
  if (lower !== s && s.toUpperCase() !== s) throw errorf("mixed case");
  const sepIdx = s.lastIndexOf("1");
  const pos = sepIdx < 0 ? -1 : byteOffset(s, sepIdx);
  const len = Buffer.byteLength(s, "utf8");
  if (pos < 1 || pos + 7 > len) throw errorf("separator '1' at invalid position: pos=%d, len=%d", pos, len);
  const hrp = s.slice(0, sepIdx);
  {
    let p = 0;
    for (const ch of hrp) {
      const c = ch.codePointAt(0)!;
      if (c < 33 || c > 126) throw errorf("invalid character human-readable part: s[%d]=%d", p, c);
      p += utf8Len(c);
    }
  }
  const dataPart = lower.slice(sepIdx + 1);
  const values: number[] = [];
  {
    let p = 0;
    for (const ch of dataPart) {
      const c = ch.codePointAt(0)!;
      const d = c < 128 ? CHARSET.indexOf(ch) : -1;
      if (d < 0) throw errorf("invalid character data part: s[%d]=%d", p, c);
      values.push(d);
      p += utf8Len(c);
    }
  }
  if (!verifyChecksum(hrp.toLowerCase(), values)) throw errorf("invalid checksum");
  const bytes = convertBits(values.slice(0, values.length - 6), 5, 8, false);
  return { hrp, data: Uint8Array.from(bytes) };
}

/** Like bech32Decode, but returns the error instead of throwing. */
export function tryBech32Decode(s: string): Bech32Decoded | PasshError {
  try {
    return bech32Decode(s);
  } catch (e) {
    return e as PasshError;
  }
}

/** The Bech32 data alphabet in upper case (the characters after `AGE-SECRET-KEY-1`). */
export const BECH32_CHARSET_UPPER = CHARSET.toUpperCase();
