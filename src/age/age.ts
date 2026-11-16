// age v1 files (c2sp.org/age): encryption to recipients and decryption with an identity
// or a passphrase. Failures are AgeDecryptError with a `kind` that the key layer maps to
// passh's messages (vault-format.md §3.2, §3.3).

import { encodeHeader, headerMac, parseHeader, AgeHeaderError, type Header, type Stanza } from "./header.ts";
import { constantTimeEqual, randomBytes, wipe } from "./primitives.ts";
import { checkScryptStanza, scryptStanza, unwrapScryptStanza } from "./scrypt.ts";
import { decryptPayload, encryptPayload, PayloadError } from "./stream.ts";
import { StanzaError, type Identity, type Recipient } from "./x25519.ts";

export const FILE_KEY_SIZE = 16;

/**
 * Why decryption failed:
 * - `header`: the header breaks the grammar;
 * - `scrypt-mixed`: an scrypt stanza isn't the only stanza;
 * - `stanza`: a stanza of the identity's own type is malformed (scrypt: bad salt, work
 *   factor not canonical or above the limit, body size);
 * - `no-match`: no stanza opens with the identity (for scrypt: wrong passphrase);
 * - `mac`: the header MAC doesn't verify;
 * - `payload`: the payload is truncated or damaged;
 * - `too-long`: the plaintext is longer than the caller's limit.
 */
export type AgeFailure = "header" | "scrypt-mixed" | "stanza" | "no-match" | "mac" | "payload" | "too-long";

export class AgeDecryptError extends Error {
  readonly kind: AgeFailure;
  constructor(kind: AgeFailure, detail?: string) {
    super(detail ? `age: ${kind}: ${detail}` : `age: ${kind}`);
    this.name = "AgeDecryptError";
    this.kind = kind;
  }
}

function assemble(header: Uint8Array, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(header.length + payload.length);
  out.set(header);
  out.set(payload, header.length);
  return out;
}

/** Encrypts with a fresh file key to stanzas made by `wrapAll`. */
function encryptWith(plaintext: Uint8Array, stanzas: Stanza[], fileKey: Uint8Array): Uint8Array {
  const header = encodeHeader(stanzas, fileKey);
  const payload = encryptPayload(fileKey, plaintext);
  return assemble(header, payload);
}

/** Encrypts a plaintext to one or more recipients: a binary age file. */
export function encrypt(plaintext: Uint8Array, recipients: readonly Recipient[]): Uint8Array {
  if (recipients.length === 0) throw new Error("age: no recipients");
  const fileKey = randomBytes(FILE_KEY_SIZE);
  try {
    const stanzas = recipients.flatMap((r) => r.wrap(fileKey));
    return encryptWith(plaintext, stanzas, fileKey);
  } finally {
    wipe(fileKey);
  }
}

/** Encrypts a plaintext with a passphrase (one scrypt stanza, work factor 2^logN). */
export async function encryptWithPassphrase(plaintext: Uint8Array, passphrase: Uint8Array, logN: number): Promise<Uint8Array> {
  const fileKey = randomBytes(FILE_KEY_SIZE);
  try {
    const stanza = await scryptStanza(fileKey, passphrase, logN);
    return encryptWith(plaintext, [stanza], fileKey);
  } finally {
    wipe(fileKey);
  }
}

function parse(file: Uint8Array): Header {
  try {
    return parseHeader(file);
  } catch (e) {
    if (e instanceof AgeHeaderError) throw new AgeDecryptError("header", e.message);
    throw e;
  }
}

/** Verifies the header MAC and decrypts the payload with an unwrapped file key. */
function finish(file: Uint8Array, header: Header, fileKey: Uint8Array, maxPlaintext?: number): Uint8Array {
  try {
    const mac = headerMac(fileKey, header.macInput);
    if (!constantTimeEqual(mac, header.mac)) throw new AgeDecryptError("mac");
    try {
      return decryptPayload(fileKey, file.subarray(header.payloadOffset), maxPlaintext);
    } catch (e) {
      if (e instanceof PayloadError) throw new AgeDecryptError(e.reason === "too-long" ? "too-long" : "payload", e.reason);
      throw e;
    }
  } finally {
    wipe(fileKey);
  }
}

export interface DecryptOptions {
  /** Fail with `too-long` once the plaintext exceeds this many bytes. */
  maxPlaintext?: number;
}

/** Decrypts a binary age file with an identity (X25519, hybrid). */
export function decrypt(file: Uint8Array, identity: Identity, opts: DecryptOptions = {}): Uint8Array {
  const header = parse(file);
  if (header.stanzas.some((s) => s.type === "scrypt") && header.stanzas.length !== 1) throw new AgeDecryptError("scrypt-mixed");
  let fileKey: Uint8Array | null;
  try {
    fileKey = identity.unwrap(header.stanzas);
  } catch (e) {
    if (e instanceof StanzaError) throw new AgeDecryptError("stanza", e.message);
    throw e;
  }
  if (fileKey === null) throw new AgeDecryptError("no-match");
  return finish(file, header, fileKey, opts.maxPlaintext);
}

export interface PassphraseDecryptOptions extends DecryptOptions {
  /** The largest accepted work factor (log2 N). */
  maxLogN: number;
}

/**
 * Decrypts a binary age file with a passphrase: exactly one scrypt stanza, checked by
 * age's rules (and `maxLogN`) before scrypt runs.
 */
export async function decryptWithPassphrase(file: Uint8Array, passphrase: Uint8Array, opts: PassphraseDecryptOptions): Promise<Uint8Array> {
  const header = parse(file);
  const scryptCount = header.stanzas.filter((s) => s.type === "scrypt").length;
  if (scryptCount === 0) throw new AgeDecryptError("no-match", "no scrypt stanza");
  if (header.stanzas.length !== 1) throw new AgeDecryptError("scrypt-mixed");
  const stanza = header.stanzas[0]!;
  let params;
  try {
    params = checkScryptStanza(stanza, opts.maxLogN);
  } catch (e) {
    if (e instanceof StanzaError) throw new AgeDecryptError("stanza", e.message);
    throw e;
  }
  const fileKey = await unwrapScryptStanza(stanza, params, passphrase);
  if (fileKey === null) throw new AgeDecryptError("no-match", "incorrect passphrase");
  return finish(file, header, fileKey, opts.maxPlaintext);
}
