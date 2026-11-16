// Recipients for `passh export --age` (import-export.md §2.7) and armored encryption.

import { encrypt } from "./age.ts";
import { armor } from "./armor.ts";
import { HybridRecipient } from "./hybrid.ts";
import { X25519Recipient, type Recipient } from "./x25519.ts";
import { errorf } from "../i18n/index.ts";

/** Unicode White_Space at both ends (Go's strings.TrimSpace; unlike String.trim, U+FEFF stays). */
const WS = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const TRIM = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");

export function trimSpace(s: string): string {
  return s.replace(TRIM, "");
}

/**
 * Parses an age recipient: `age1pq1…` (hybrid post-quantum) or `age1…` (X25519), with
 * age's error texts (`malformed recipient "…": …`). Plugin recipients are refused.
 */
export function parseRecipient(s: string): Recipient {
  if (s.startsWith("age1pq1")) return HybridRecipient.parse(s);
  return X25519Recipient.parse(s);
}

/**
 * The `--age` value of `passh export`, checked as import-export.md §2.7's table says.
 * Errors (exit status 1):
 * - `--age: invalid age recipient "‹value›": ‹age error›`
 * - `--age: this is an age secret key; give its public recipient (age1…), as printed by age-keygen -y`
 * - `--age: the recipient is empty; give an age public key (age1…)`
 * - `--age: not an age recipient; give an age public key (age1…)`
 * Only values that look like a recipient are echoed, so a pasted secret key never is.
 */
export function parseExportRecipient(value: string): Recipient {
  const v = trimSpace(value);
  if (v.startsWith("age1pq1") || v.startsWith("age1")) {
    try {
      return parseRecipient(v);
    } catch (e) {
      throw errorf("--age: invalid age recipient %q: %w", v, e);
    }
  }
  if (v.toUpperCase().startsWith("AGE-SECRET-KEY-")) {
    throw errorf("--age: this is an age secret key; give its public recipient (age1…), as printed by age-keygen -y");
  }
  if (v === "") throw errorf("--age: the recipient is empty; give an age public key (age1…)");
  throw errorf("--age: not an age recipient; give an age public key (age1…)");
}

/** Encrypts to one recipient and returns the canonical armored age file (import-export.md §2.7 "Output"). */
export function encryptArmored(plaintext: Uint8Array, recipient: Recipient): Uint8Array {
  return armor(encrypt(plaintext, [recipient]));
}
