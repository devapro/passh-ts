// Strict base64 (RFC 4648 §4, standard alphabet) as age and the vault container need it.
//
// - Unpadded ("raw") base64 is what age uses inside a header (age-encryption.org/v1:
//   canonical encodings only, no `=`); vault-format.md §2.3 header rules 3 and 4.
// - Padded base64 is the armor's (vault-format.md §2.1, §2.2 step 5.4): padding required,
//   non-zero pad bits rejected, any character outside the alphabet fails.
//
// Decoders return null on any deviation; callers turn that into their own error.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Value of a base64 character code, or -1. */
const VALUES = (() => {
  const t = new Int8Array(256).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Unpadded base64 of bytes (age header encoding). */
export function b64RawEncode(bytes: Uint8Array): string {
  return toBuffer(bytes).toString("base64").replace(/=+$/, "");
}

/** Padded base64 of bytes (armor encoding). */
export function b64StdEncode(bytes: Uint8Array): string {
  return toBuffer(bytes).toString("base64");
}

/** Checks that every character of s[from, to) is in the alphabet. */
function allInAlphabet(s: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (c > 255 || VALUES[c]! < 0) return false;
  }
  return true;
}

function copyOut(buf: Buffer): Uint8Array {
  // A fresh, unshared Uint8Array (Buffer.from(string) may come from a shared pool).
  const out = new Uint8Array(buf.length);
  out.set(buf);
  return out;
}

/**
 * Decodes canonical unpadded base64: only alphabet characters, no `=`, a length that
 * isn't 1 mod 4, and zero unused bits in the last character. Null on any deviation.
 */
export function b64RawDecodeStrict(s: string): Uint8Array | null {
  const n = s.length;
  const rem = n % 4;
  if (rem === 1) return null;
  if (!allInAlphabet(s, 0, n)) return null;
  if (rem !== 0) {
    const last = VALUES[s.charCodeAt(n - 1)]!;
    if (rem === 2 && (last & 0x0f) !== 0) return null;
    if (rem === 3 && (last & 0x03) !== 0) return null;
  }
  return copyOut(Buffer.from(s, "base64"));
}

/**
 * Decodes canonical padded base64: a length that is a multiple of 4, `=` only as one or
 * two final padding characters, zero pad bits, nothing outside the alphabet (spaces
 * included). Null on any deviation.
 */
export function b64StdDecodeStrict(s: string): Uint8Array | null {
  const n = s.length;
  if (n % 4 !== 0) return null;
  let pad = 0;
  if (n > 0 && s.charCodeAt(n - 1) === 0x3d) pad = s.charCodeAt(n - 2) === 0x3d ? 2 : 1;
  if (!allInAlphabet(s, 0, n - pad)) return null;
  if (pad > 0) {
    const last = VALUES[s.charCodeAt(n - pad - 1)]!;
    if (pad === 1 && (last & 0x03) !== 0) return null;
    if (pad === 2 && (last & 0x0f) !== 0) return null;
  }
  return copyOut(Buffer.from(s, "base64"));
}
