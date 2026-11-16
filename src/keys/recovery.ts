// The paper recovery key (vault-format.md §3.6): its layout on the sheet and the checks of
// a typed key. Errors never repeat the typed characters.

import { BECH32_CHARSET_UPPER } from "../age/bech32.ts";
import { X25519Identity } from "../age/x25519.ts";
import { codedError } from "../i18n/index.ts";
import { KeyErrorCode } from "./errors.ts";

const PREFIX = "AGE-SECRET-KEY-1";
const NORMALIZED_PREFIX = "AGESECRETKEY1";
const KEY_CHARS = 58;

/**
 * The sheet layout (§3.6 "Layout"): line 1 `AGE-SECRET-KEY-1`, then the 58 characters
 * after it in groups of 4 separated by one space, 5 groups per line (three lines; the
 * last group has 2 characters). Lines joined by LF, no final LF.
 */
export function formatRecoveryKey(identity: X25519Identity): string {
  const key = identity.format();
  const rest = key.slice(PREFIX.length);
  const groups: string[] = [];
  for (let i = 0; i < rest.length; i += 4) groups.push(rest.slice(i, i + 4));
  const lines = [PREFIX];
  for (let i = 0; i < groups.length; i += 5) lines.push(groups.slice(i, i + 5).join(" "));
  return lines.join("\n");
}

/** Unicode White_Space (vault-format.md conventions). */
function isWhiteSpace(cp: number): boolean {
  return (
    (cp >= 0x09 && cp <= 0x0d) ||
    cp === 0x20 ||
    cp === 0x85 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/**
 * Decodes UTF-8 like Go's range over a string: each invalid byte becomes one U+FFFD.
 * Returns the code points.
 */
export function decodeUtf8Lossy(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    if (b0 < 0x80) {
      out.push(b0);
      i++;
      continue;
    }
    let need = 0;
    let cp = 0;
    let min = 0;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1;
      cp = b0 & 0x1f;
      min = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2;
      cp = b0 & 0x0f;
      min = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3;
      cp = b0 & 0x07;
      min = 0x10000;
    } else {
      out.push(0xfffd);
      i++;
      continue;
    }
    let ok = i + need < bytes.length;
    let v = cp;
    for (let k = 1; ok && k <= need; k++) {
      const b = bytes[i + k];
      if (b === undefined || (b & 0xc0) !== 0x80) ok = false;
      else v = (v << 6) | (b & 0x3f);
    }
    if (ok && (v < min || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff))) ok = false;
    if (ok) {
      out.push(v);
      i += need + 1;
    } else {
      out.push(0xfffd);
      i++;
    }
  }
  return out;
}

function invalid(format: string, ...args: unknown[]) {
  return codedError(KeyErrorCode.BadRecoveryKey, format, ...args);
}

/**
 * Checks a typed recovery key (§3.6 "Input") and returns the vault key. In order:
 * 1. remove every white space character and every `-`; ASCII a–z to upper case;
 * 2. nothing left → `not a valid recovery key: nothing was typed` (code recovery-key-empty);
 * 3. not starting with `AGESECRETKEY1` → `not a valid recovery key: it must start with AGE-SECRET-KEY-1`;
 * 4. a character outside the Bech32 alphabet → `not a valid recovery key: group G, character C is not used in keys (…)`;
 * 5. not exactly 58 characters → `not a valid recovery key: it has N characters after AGE-SECRET-KEY-1 instead of 58; …`;
 * 6. a bad checksum or non-zero padding → `recovery key has a typo (checksum mismatch)`.
 * Steps 3–6 have code bad-recovery-key.
 */
export function parseRecoveryKey(typed: Uint8Array | string): X25519Identity {
  const bytes = typeof typed === "string" ? new TextEncoder().encode(typed) : typed;
  const cps: number[] = [];
  for (const cp of decodeUtf8Lossy(bytes)) {
    if (isWhiteSpace(cp) || cp === 0x2d) continue;
    cps.push(cp >= 0x61 && cp <= 0x7a ? cp - 0x20 : cp);
  }
  try {
    if (cps.length === 0) throw codedError(KeyErrorCode.RecoveryKeyEmpty, "not a valid recovery key: nothing was typed");
    for (let i = 0; i < NORMALIZED_PREFIX.length; i++) {
      if (cps[i] !== NORMALIZED_PREFIX.charCodeAt(i)) throw invalid("not a valid recovery key: it must start with AGE-SECRET-KEY-1");
    }
    const rest = cps.slice(NORMALIZED_PREFIX.length);
    // Every character so far is ASCII, so the index of the first bad one is also its byte offset.
    for (let i = 0; i < rest.length; i++) {
      const cp = rest[i]!;
      if (cp >= 0x80 || !BECH32_CHARSET_UPPER.includes(String.fromCharCode(cp))) {
        throw invalid(
          "not a valid recovery key: group %d, character %d is not used in keys (B, I, O and 1 never appear after AGE-SECRET-KEY-1)",
          Math.floor(i / 4) + 1,
          (i % 4) + 1,
        );
      }
    }
    if (rest.length !== KEY_CHARS) {
      throw invalid("not a valid recovery key: it has %d characters after AGE-SECRET-KEY-1 instead of 58; a character is missing or extra", rest.length);
    }
    try {
      return X25519Identity.parse(PREFIX + String.fromCharCode(...rest));
    } catch {
      throw invalid("recovery key has a typo (checksum mismatch)");
    } finally {
      rest.fill(0);
    }
  } finally {
    cps.fill(0);
  }
}
