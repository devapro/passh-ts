// The age v1 header (c2sp.org/age "Header"), parsed by the exact rules of
// vault-format.md §2.3 ("Header rules", which are age v1.3.2's parser):
//
//   1. Line 1 is exactly `age-encryption.org/v1` LF; every header line ends in LF; a CR
//      anywhere in the header is a break.
//   2. One or more stanzas, at most 1024. `->` SP type, then 0–128 arguments, each after
//      one SP, then LF; type and arguments are non-empty strings of bytes 0x21–0x7E.
//   3. Body: lines of canonical unpadded base64, each decoding to at most 48 bytes; the
//      first line decoding to fewer than 48 bytes (possibly empty) ends it.
//   4. Where a stanza could start, a line starting with `---` is the MAC line: `---` SP
//      and one argument, canonical unpadded base64 of exactly 32 bytes, then LF.
//   5. The header, up to and including the MAC line's LF, is at most 2 MiB; the payload is
//      every byte after it.
//
// The MAC isn't verified here (that needs the file key; see age.ts).

import { b64RawDecodeStrict, b64RawEncode } from "./base64.ts";
import { ascii, hkdf32, hmacSha256 } from "./primitives.ts";

export const VERSION_LINE = "age-encryption.org/v1";
export const MAX_HEADER_SIZE = 2 * 1024 * 1024;
export const MAX_STANZAS = 1024;
export const MAX_STANZA_ARGS = 128;
const BYTES_PER_LINE = 48;

export interface Stanza {
  type: string;
  args: string[];
  body: Uint8Array;
}

export interface Header {
  stanzas: Stanza[];
  /** The 32-byte header MAC. */
  mac: Uint8Array;
  /** The header bytes the MAC covers: from line 1 up to and including `---`. */
  macInput: Uint8Array;
  /** Offset of the payload (just after the MAC line's LF). */
  payloadOffset: number;
}

/** A header that breaks the grammar (vault-format.md §2.3: `bad age header`). */
export class AgeHeaderError extends Error {
  constructor(detail: string) {
    super(`bad age header: ${detail}`);
    this.name = "AgeHeaderError";
  }
}

/** A printable-ASCII string (bytes 0x21–0x7E), non-empty. */
function isValidString(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}

const LF = 0x0a;

/**
 * Parses the age v1 header at the start of `file`. Throws AgeHeaderError on any break of
 * the header rules. The returned arrays are views into `file` where possible.
 */
export function parseHeader(file: Uint8Array): Header {
  const limit = Math.min(file.length, MAX_HEADER_SIZE);
  let pos = 0;

  // Reads one line (without its LF) as a latin1 string; null if there's no LF within the limit.
  const readLine = (): string | null => {
    const end = file.indexOf(LF, pos);
    if (end < 0 || end >= limit) return null;
    const line = Buffer.from(file.buffer, file.byteOffset + pos, end - pos).toString("latin1");
    pos = end + 1;
    return line;
  };

  const first = readLine();
  if (first === null) throw new AgeHeaderError("no version line");
  if (first !== VERSION_LINE) throw new AgeHeaderError("unexpected version line");

  const stanzas: Stanza[] = [];
  for (;;) {
    if (pos + 3 <= file.length && file[pos] === 0x2d && file[pos + 1] === 0x2d && file[pos + 2] === 0x2d) {
      // The MAC line.
      const macStart = pos;
      const line = readLine();
      if (line === null) throw new AgeHeaderError("unterminated MAC line or header too large");
      const parts = line.split(" ");
      if (parts[0] !== "---" || parts.length !== 2) throw new AgeHeaderError("malformed MAC line");
      const mac = b64RawDecodeStrict(parts[1]!);
      if (mac === null || mac.length !== 32) throw new AgeHeaderError("malformed MAC");
      if (stanzas.length === 0) throw new AgeHeaderError("no recipient stanzas");
      return {
        stanzas,
        mac,
        macInput: file.subarray(0, macStart + 3),
        payloadOffset: pos,
      };
    }
    if (stanzas.length >= MAX_STANZAS) throw new AgeHeaderError("too many stanzas");
    const line = readLine();
    if (line === null) throw new AgeHeaderError("unterminated stanza line or header too large");
    const parts = line.split(" ");
    if (parts[0] !== "->") throw new AgeHeaderError("malformed stanza line");
    const args = parts.slice(1);
    if (args.length < 1) throw new AgeHeaderError("stanza without a type");
    for (const a of args) if (!isValidString(a)) throw new AgeHeaderError("malformed stanza argument");
    if (args.length - 1 > MAX_STANZA_ARGS) throw new AgeHeaderError("too many stanza arguments");
    const chunks: Uint8Array[] = [];
    let bodyLen = 0;
    for (;;) {
      const bl = readLine();
      if (bl === null) throw new AgeHeaderError("unterminated stanza body or header too large");
      const b = b64RawDecodeStrict(bl);
      if (b === null) throw new AgeHeaderError("malformed stanza body line");
      if (b.length > BYTES_PER_LINE) throw new AgeHeaderError("stanza body line too long");
      chunks.push(b);
      bodyLen += b.length;
      if (b.length < BYTES_PER_LINE) break;
    }
    const body = new Uint8Array(bodyLen);
    let off = 0;
    for (const c of chunks) {
      body.set(c, off);
      off += c.length;
    }
    stanzas.push({ type: args[0]!, args: args.slice(1), body });
  }
}

/** The header's text up to and including `---` (what the MAC covers), for stanzas written by us. */
export function encodeHeaderWithoutMac(stanzas: readonly Stanza[]): Uint8Array {
  let s = VERSION_LINE + "\n";
  for (const st of stanzas) {
    s += "-> " + [st.type, ...st.args].join(" ") + "\n";
    const b64 = b64RawEncode(st.body);
    // Wrapped at 64 columns; the last line is shorter than 64 characters, possibly empty.
    for (let i = 0; i <= b64.length; i += 64) s += b64.slice(i, i + 64) + "\n";
  }
  s += "---";
  return ascii(s);
}

/** The header MAC: HMAC-SHA-256 keyed with HKDF(file key, salt empty, info "header"). */
export function headerMac(fileKey: Uint8Array, macInput: Uint8Array): Uint8Array {
  const key = hkdf32(fileKey, new Uint8Array(0), "header");
  const mac = hmacSha256(key, macInput);
  key.fill(0);
  return mac;
}

/** The complete header for stanzas and a file key: text, `---`, SP, base64 MAC, LF. */
export function encodeHeader(stanzas: readonly Stanza[], fileKey: Uint8Array): Uint8Array {
  const macInput = encodeHeaderWithoutMac(stanzas);
  const mac = headerMac(fileKey, macInput);
  const tail = ascii(" " + b64RawEncode(mac) + "\n");
  const out = new Uint8Array(macInput.length + tail.length);
  out.set(macInput);
  out.set(tail, macInput.length);
  return out;
}
