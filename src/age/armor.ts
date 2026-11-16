// age's ASCII armor (c2sp.org/age "ASCII armor", RFC 7468 strict PEM with label
// "AGE ENCRYPTED FILE"). The canonical form is what vault-format.md §2.1 requires for
// each block and import-export.md §2.7 for `export --age`:
//
//   -----BEGIN AGE ENCRYPTED FILE----- LF
//   base64 (padded) in lines of exactly 64 characters, the last 1–64 LF
//   -----END AGE ENCRYPTED FILE----- LF
//
// The lenient reading of a vault file is the container's (src/vaultfile); `dearmor` here is
// the strict reader stock age applies, for tests and tools.

import { b64StdDecodeStrict, b64StdEncode } from "./base64.ts";

export const ARMOR_BEGIN = "-----BEGIN AGE ENCRYPTED FILE-----";
export const ARMOR_END = "-----END AGE ENCRYPTED FILE-----";
export const ARMOR_COLUMNS = 64;

/** The canonical armor of a binary age file, as text. */
export function armorText(binary: Uint8Array): string {
  const b64 = b64StdEncode(binary);
  const lines: string[] = [ARMOR_BEGIN];
  for (let i = 0; i < b64.length; i += ARMOR_COLUMNS) lines.push(b64.slice(i, i + ARMOR_COLUMNS));
  lines.push(ARMOR_END, "");
  return lines.join("\n");
}

/** The canonical armor of a binary age file, as ASCII bytes. */
export function armor(binary: Uint8Array): Uint8Array {
  return new Uint8Array(Buffer.from(armorText(binary), "latin1"));
}

/**
 * Strict armor reading, as stock age does: optional white space around the block,
 * LF or CRLF line endings, 64-column lines (the last 1–64), canonical padded base64.
 * Returns null on any deviation.
 */
export function dearmor(text: Uint8Array | string): Uint8Array | null {
  let s = typeof text === "string" ? text : Buffer.from(text.buffer, text.byteOffset, text.byteLength).toString("latin1");
  s = s.replace(/^[ \t\r\n]+/, "").replace(/[ \t\r\n]+$/, "");
  const lines = s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines.length < 3 || lines[0] !== ARMOR_BEGIN || lines[lines.length - 1] !== ARMOR_END) return null;
  const body = lines.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    if (i < body.length - 1 ? l.length !== ARMOR_COLUMNS : l.length === 0 || l.length > ARMOR_COLUMNS) return null;
  }
  const bin = b64StdDecodeStrict(body.join(""));
  if (bin === null || bin.length === 0) return null;
  return bin;
}
