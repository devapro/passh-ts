// Password generator (spec §5.5 S3, import-export.md §3, agent-session.md §A9 S3):
// CSPRNG bytes with rejection sampling, no modulo bias, no forced character classes.

import { errorf } from "../i18n/index.ts";
import { UsageError } from "../errors.ts";
import { isControl, isWhiteSpace } from "../util/unicode.ts";

/** Default length (import-export.md §3.3). */
export const DEFAULT_LENGTH = 24;
export const MIN_LENGTH = 1;
export const MAX_LENGTH = 4096;

/** `A`–`Z`, `a`–`z`, `0`–`9`: 62 characters, in index order (§3.1). */
export const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** The default alphabet, then the 32 printable ASCII punctuation characters in ASCII order: 94. */
export const ALPHABET_SYMBOLS = ALPHABET + "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

/** A source of random bytes: fills the array completely or throws. */
export type RandomSource = (buf: Uint8Array) => void;

/** crypto.getRandomValues (the OS CSPRNG). */
export const cryptoRandom: RandomSource = (buf) => {
  crypto.getRandomValues(buf);
};

/**
 * Generates `length` characters from `alphabet` (2–256 distinct code points): reads exactly
 * as many bytes as characters are still missing, accepts a byte b only if
 * b < L = 256 − (256 mod n) and maps it to alphabet[b mod n]; repeats until done (§3.2).
 */
export function generateFrom(alphabet: string, length: number, random: RandomSource = cryptoRandom): string {
  const chars = checkAlphabet(alphabet);
  const n = chars.length;
  const limit = 256 - (256 % n);
  if (!Number.isInteger(length) || length < 0) throw errorf("invalid password length %d", length);
  const out: string[] = [];
  while (out.length < length) {
    const buf = new Uint8Array(length - out.length);
    try {
      random(buf);
    } catch (e) {
      throw errorf("reading random bytes: %w", e instanceof Error ? e : new Error(String(e)));
    }
    for (const b of buf) if (b < limit) out.push(chars[b % n]!);
    buf.fill(0);
  }
  return out.join("");
}

/** Generates a password: `length` characters, letters and digits, or also symbols (§3.1). */
export function generatePassword(length: number = DEFAULT_LENGTH, symbols = false, random: RandomSource = cryptoRandom): string {
  return generateFrom(symbols ? ALPHABET_SYMBOLS : ALPHABET, length, random);
}

/** Strength shown for a password: ⌊length × log2(n)⌋ bits (24 → 142, 24 symbols → 157). */
export function strengthBits(length: number, symbols = false): number {
  const n = symbols ? ALPHABET_SYMBOLS.length : ALPHABET.length;
  return Math.floor(length * Math.log2(n));
}

/** Checks a custom alphabet: 2–256 distinct code points, no control or white space characters. */
function checkAlphabet(alphabet: string): string[] {
  const chars = [...alphabet];
  if (chars.length < 2 || chars.length > 256) throw errorf("the alphabet must have 2 to 256 characters");
  const seen = new Set<string>();
  for (const c of chars) {
    const cp = c.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) throw errorf("the alphabet is not valid UTF-8");
    if (isControl(cp) || isWhiteSpace(cp)) throw errorf("the alphabet holds a control or space character");
    if (seen.has(c)) throw errorf("the alphabet holds %q twice", c);
    seen.add(c);
  }
  return chars;
}

/**
 * Parses `generate`'s `[len]` argument (import-export.md §3.3 check 3): a decimal integer
 * 1–4096, an optional sign and leading zeros accepted (`+5`, `007`, as Go's strconv.Atoi).
 * Otherwise a usage error (exit 2): `length "<arg>": give a number from 1 to 4096`.
 */
export function parseLength(arg: string): number {
  if (/^[+-]?[0-9]+$/.test(arg)) {
    const v = BigInt(arg);
    if (v >= BigInt(MIN_LENGTH) && v <= BigInt(MAX_LENGTH)) return Number(v);
  }
  throw new UsageError("length %q: give a number from 1 to 4096", arg);
}

/**
 * Shell form of a path for the hint `Show it with: passh show <qpath> --field password`
 * (import-export.md §3.3): as is when every character is in [A-Za-z0-9/._\-+@:,=],
 * otherwise in single quotes with `'` written as `'\''`.
 */
export function shellQuote(s: string): string {
  if (s !== "" && /^[A-Za-z0-9/._\-+@:,=]+$/.test(s)) return s;
  return "'" + s.replaceAll("'", "'\\''") + "'";
}
