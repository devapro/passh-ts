// The vault container (vault-format.md §2, spec §4.1, §4.5, §4.8): the lenient parse,
// the block checks made without a key, and the canonical form passh writes.

import { ARMOR_BEGIN, ARMOR_END, armorText } from "../age/armor.ts";
import { b64StdDecodeStrict } from "../age/base64.ts";
import { parseHeader } from "../age/header.ts";
import { isPossiblePayloadLength } from "../age/stream.ts";
import {
  ContainerError,
  ContainerWarning,
  errDamaged,
  errEncodedTooLarge,
  errNewerContainer,
  errNotVault,
  errTruncated,
  errUnknownVersion0,
  reasons,
} from "./errors.ts";

/** Container version 1's magic line (§1). */
export const MAGIC_LINE = "passh-vault 1";
/** Vault file read limit (§1, §2.5): 64 MiB. */
export const MAX_VAULT_FILE_SIZE = 64 * 1024 * 1024;

const INT64_MAX = 9223372036854775807n;

export interface Container {
  /** Block 1, the binary key block (de-armored). */
  keyBlock: Uint8Array;
  /** Block 2, the binary data block (de-armored). */
  dataBlock: Uint8Array;
  /** Warnings about ignored text (§2.2 steps 4 and 6), in that order. */
  warnings: ContainerWarning[];
  /** The file is byte for byte the canonical form of its two blocks (§2.2 step 7). */
  canonical: boolean;
}

// ---------------------------------------------------------------------------
// Lines. The file is handled as a latin1 string (one char per byte), so invalid UTF-8
// survives; white space is Unicode White_Space in UTF-8 (as Go's bytes.TrimSpace sees it).

function isAsciiSpace(c: number): boolean {
  return c === 0x20 || (c >= 0x09 && c <= 0x0d);
}

/** Length of a UTF-8 encoded non-ASCII White_Space character starting at i, or 0. */
function wsPrefixLen(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c === 0xc2) {
    const d = s.charCodeAt(i + 1);
    return d === 0x85 || d === 0xa0 ? 2 : 0;
  }
  if (c === 0xe1) return s.charCodeAt(i + 1) === 0x9a && s.charCodeAt(i + 2) === 0x80 ? 3 : 0;
  if (c === 0xe2) {
    const d = s.charCodeAt(i + 1);
    const e = s.charCodeAt(i + 2);
    if (d === 0x80 && ((e >= 0x80 && e <= 0x8a) || e === 0xa8 || e === 0xa9 || e === 0xaf)) return 3;
    if (d === 0x81 && e === 0x9f) return 3;
    return 0;
  }
  if (c === 0xe3) return s.charCodeAt(i + 1) === 0x80 && s.charCodeAt(i + 2) === 0x80 ? 3 : 0;
  return 0;
}

/** Length of a White_Space character ending just before `end`, or 0. */
function wsSuffixLen(s: string, end: number): number {
  if (end >= 1 && isAsciiSpace(s.charCodeAt(end - 1))) return 1;
  if (end >= 2 && wsPrefixLen(s, end - 2) === 2) return 2;
  if (end >= 3 && wsPrefixLen(s, end - 3) === 3) return 3;
  return 0;
}

/** Trims White_Space from both ends of a latin1-encoded UTF-8 string. */
export function trimSpaceBytes(s: string): string {
  let start = 0;
  let end = s.length;
  for (;;) {
    if (start >= end) return "";
    if (isAsciiSpace(s.charCodeAt(start))) {
      start++;
      continue;
    }
    const n = wsPrefixLen(s, start);
    if (n === 0 || start + n > end) break;
    start += n;
  }
  for (;;) {
    const n = wsSuffixLen(s, end);
    if (n === 0 || end - n < start) break;
    end -= n;
  }
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

function toLatin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

/** §2.2 steps 1–2: BOM removed, split at CR LF / LF / CR, every line trimmed. */
function splitLines(bytes: Uint8Array): { text: string; lines: string[] } {
  let text = toLatin1(bytes);
  if (text.startsWith("\xef\xbb\xbf")) text = text.slice(3);
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) lines[i] = trimSpaceBytes(lines[i]!);
  return { text, lines };
}

const MAGIC_RE = /^passh-vault[ \t]+([0-9]+)$/;

/** §2.2 step 3: the magic line's index, or the error when there is none or it is unusable. */
function findMagic(text: string, lines: string[]): number {
  let idx = -1;
  let m: RegExpExecArray | null = null;
  for (let i = 0; i < lines.length; i++) {
    m = MAGIC_RE.exec(lines[i]!);
    if (m) {
      idx = i;
      break;
    }
  }
  if (idx < 0) {
    const t = trimSpaceBytes(text);
    if (t === "") throw errTruncated(undefined, reasons.empty());
    if ("passh-vault ".startsWith(t)) throw errTruncated(undefined, reasons.endsInMagic());
    throw errNotVault();
  }
  let v = BigInt(m![1]!);
  // A number too large for an int counts as newer; passh then shows the int's maximum.
  if (v > INT64_MAX) v = INT64_MAX;
  if (v === 0n) throw errUnknownVersion0();
  if (v > 1n) throw errNewerContainer(v);
  return idx;
}

function countNonBlank(lines: string[], from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (lines[i] !== "") n++;
  return n;
}

/** §2.3: checks a block without a key. Throws `file is damaged (block n): …`. */
export function checkBlock(n: 1 | 2, block: Uint8Array): void {
  let header;
  try {
    header = parseHeader(block);
  } catch {
    throw errDamaged(n, reasons.badHeader());
  }
  const st = header.stanzas;
  if (n === 1) {
    if (!(st.length === 1 && st[0]!.type === "scrypt" && st[0]!.args.length === 2)) throw errDamaged(1, reasons.keyBlockNotScrypt());
  } else {
    const ok = st.some((s) => s.type === "X25519" && s.args.length === 1) && !st.some((s) => s.type === "scrypt");
    if (!ok) throw errDamaged(2, reasons.dataBlockNotX25519());
  }
  if (!isPossiblePayloadLength(block.length - header.payloadOffset)) throw errDamaged(n, reasons.impossibleSize());
}

/** Decodes the armored base64 of block n (§2.2 steps 5.4). */
function decodeBlock(n: 1 | 2, b64: string): Uint8Array {
  const bin = b64StdDecodeStrict(b64);
  if (bin === null) throw errDamaged(n, reasons.badBase64());
  if (bin.length === 0) throw errDamaged(n, reasons.emptyBlock());
  return bin;
}

/** §2.2 step 5: reads block n from line `i`; returns the block and the line after its END. */
function readBlock(n: 1 | 2, lines: string[], i: number): { block: Uint8Array; next: number } {
  while (i < lines.length && lines[i] === "") i++;
  if (i >= lines.length) throw errTruncated(n, reasons.missing(n));
  const first = lines[i]!;
  if (first !== ARMOR_BEGIN) {
    if (first.length < ARMOR_BEGIN.length && ARMOR_BEGIN.startsWith(first) && countNonBlank(lines, i + 1, lines.length) === 0) {
      throw errTruncated(n, reasons.cutShort(n));
    }
    throw errDamaged(n, reasons.badBegin());
  }
  i++;
  const parts: string[] = [];
  for (;;) {
    if (i >= lines.length) throw errTruncated(n, reasons.noEnd(n));
    const l = lines[i++]!;
    if (l === ARMOR_END) break;
    if (l === ARMOR_BEGIN) throw errDamaged(n, reasons.badEnd());
    if (l !== "") parts.push(l);
  }
  const block = decodeBlock(n, parts.join(""));
  checkBlock(n, block);
  return { block, next: i };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

/** The canonical file text (§2.1). */
function canonicalText(keyBlock: Uint8Array, dataBlock: Uint8Array): string {
  return MAGIC_LINE + "\n" + armorText(keyBlock) + armorText(dataBlock);
}

/**
 * Parses a vault file leniently (§2.2) and checks both blocks (§2.3). Throws
 * ContainerError (codes not-vault, newer-container, truncated, damaged; `block` set for
 * block errors; `warnings` holds the warnings found so far). The 64 MiB limit is the
 * caller's (it reads the file; §2.5).
 */
export function parseContainer(bytes: Uint8Array): Container {
  const { text, lines } = splitLines(bytes);
  const warnings: ContainerWarning[] = [];
  try {
    const magic = findMagic(text, lines);
    const before = countNonBlank(lines, 0, magic);
    if (before > 0) warnings.push(new ContainerWarning("before", before));
    const b1 = readBlock(1, lines, magic + 1);
    const b2 = readBlock(2, lines, b1.next);
    const after = countNonBlank(lines, b2.next, lines.length);
    if (after > 0) warnings.push(new ContainerWarning("after", after));
    const canonical = bytesEqual(bytes, new Uint8Array(Buffer.from(canonicalText(b1.block, b2.block), "latin1")));
    return { keyBlock: b1.block, dataBlock: b2.block, warnings, canonical };
  } catch (e) {
    if (e instanceof ContainerError) e.warnings = warnings;
    throw e;
  }
}

export interface RecoveryContainer extends Container {
  /**
   * True when block 1 failed with a *damaged* error and the data block was taken from the
   * last armored block (§3.6 "Damaged key block"); `keyBlock` is then empty and
   * `keyBlockError` holds the block-1 error.
   */
  keyBlockDamaged: boolean;
  keyBlockError?: ContainerError;
}

/**
 * The parse of `passh recover` (vault-format.md §3.6, storage.md §3.1): like
 * parseContainer, but if block 1 fails with a *damaged* error (not truncation), the last
 * armored block of the file (the last BEGIN line, its base64 up to the next END line, as
 * leniently as §2.2) becomes the data block, and `keyBlockDamaged` is set.
 *
 * As the reference does: no END line after the last BEGIN, bad base64 or an empty block
 * → the block-1 error is thrown at once. Otherwise the block is returned *without* the
 * §2.3 check; the caller warns `the key block is damaged; setting a new passphrase
 * rewrites it`, decrypts with the paper key, and on any failure of that decryption
 * (header, wrong key, payload) reports `keyBlockError`, not a data error.
 * SPEC-GAP: the spec doesn't say what happens when the last block doesn't open; this is
 * the reference's observed behaviour.
 */
export function parseContainerForRecovery(bytes: Uint8Array): RecoveryContainer {
  try {
    return { ...parseContainer(bytes), keyBlockDamaged: false };
  } catch (e) {
    if (!(e instanceof ContainerError) || e.kind !== "damaged" || e.block !== 1) throw e;
    const { lines } = splitLines(bytes);
    let begin = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i] === ARMOR_BEGIN) {
        begin = i;
        break;
      }
    }
    if (begin < 0) throw e;
    const parts: string[] = [];
    let end = -1;
    for (let i = begin + 1; i < lines.length; i++) {
      if (lines[i] === ARMOR_END) {
        end = i;
        break;
      }
      if (lines[i] !== "") parts.push(lines[i]!);
    }
    if (end < 0) throw e;
    let dataBlock: Uint8Array;
    try {
      dataBlock = decodeBlock(2, parts.join(""));
    } catch {
      throw e;
    }
    const after = countNonBlank(lines, end + 1, lines.length);
    const warnings = [...e.warnings];
    if (after > 0) warnings.push(new ContainerWarning("after", after));
    return { keyBlock: new Uint8Array(0), dataBlock, warnings, canonical: false, keyBlockDamaged: true, keyBlockError: e };
  }
}

/**
 * The canonical file (§2.1) for two blocks. Both must pass §2.3 (ContainerError
 * otherwise), and the result must not exceed 64 MiB (§2.5; code too-large).
 */
export function encodeContainer(keyBlock: Uint8Array, dataBlock: Uint8Array): Uint8Array {
  checkBlock(1, keyBlock);
  checkBlock(2, dataBlock);
  const text = canonicalText(keyBlock, dataBlock);
  if (text.length > MAX_VAULT_FILE_SIZE) throw errEncodedTooLarge(text.length);
  return new Uint8Array(Buffer.from(text, "latin1"));
}
