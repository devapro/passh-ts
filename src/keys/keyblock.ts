// The vault key and the key block (vault-format.md §3.1, §3.2, §3.4).

import { AgeDecryptError, decryptWithPassphrase, encryptWithPassphrase } from "../age/age.ts";
import { parseHeader } from "../age/header.ts";
import { sha256Bytes, wipe } from "../age/primitives.ts";
import { X25519Identity } from "../age/x25519.ts";
import { errBadKeyBlock, errEmptyPassphrase, errWorkFactor, errWrongPassphrase } from "./errors.ts";

/** scrypt work factor (log2 N) passh writes, and the largest it accepts on read (§1). */
export const SCRYPT_LOG_N = 18;
/** Key block plaintext limit (§1). */
export const KEY_BLOCK_PLAINTEXT_LIMIT = 4096;
/** Size of a key block passh writes (informative, §3.2). */
export const KEY_BLOCK_SIZE = 257;

const INT64_MAX = 9223372036854775807n;

/** A new vault key: 32 bytes from the CSPRNG as an age X25519 identity (§3.1). */
export function generateVaultKey(): X25519Identity {
  return X25519Identity.generate();
}

/**
 * Wraps the vault key with a passphrase (§3.2 "Write"): an age file with one scrypt
 * stanza (fresh 16-byte salt, work factor 18), plaintext `<vault key> LF` (75 bytes). The
 * result is the 257-byte binary key block. `logN` exists for tests only.
 */
export async function wrapKeyBlock(identity: X25519Identity, passphrase: Uint8Array, logN: number = SCRYPT_LOG_N): Promise<Uint8Array> {
  if (passphrase.length === 0) throw errEmptyPassphrase();
  const key = identity.encode();
  const plaintext = new Uint8Array(key.length + 1);
  plaintext.set(key);
  plaintext[key.length] = 0x0a;
  wipe(key);
  try {
    return await encryptWithPassphrase(plaintext, passphrase, logN);
  } finally {
    wipe(plaintext);
  }
}

/**
 * The work factor of a key block's single scrypt stanza if it is above 18 and is an
 * integer `[+-]?[0-9]+` that fits a 64-bit integer (§3.2 step 2), else undefined.
 */
export function excessiveWorkFactor(keyBlock: Uint8Array): bigint | undefined {
  let header;
  try {
    header = parseHeader(keyBlock);
  } catch {
    return undefined;
  }
  if (header.stanzas.length !== 1) return undefined;
  const s = header.stanzas[0]!;
  if (s.type !== "scrypt" || s.args.length !== 2) return undefined;
  const a = s.args[1]!;
  if (!/^[+-]?[0-9]+$/.test(a)) return undefined;
  const v = BigInt(a);
  // SPEC-GAP: §3.2 leaves values above 2^31−1 to the platform; like a 64-bit build, a
  // value beyond int64 falls to step 3 (wrong passphrase).
  if (v > INT64_MAX || v < -INT64_MAX - 1n) return undefined;
  return v > BigInt(SCRYPT_LOG_N) ? v : undefined;
}

/**
 * Reads a key block's plaintext as an age identity file (§3.2 step 5): split at LF, one
 * trailing CR dropped per line, empty lines and `#` lines skipped; exactly one line must
 * remain, start with `AGE-SECRET-KEY-1` and parse as an X25519 identity.
 */
export function parseIdentityFile(plaintext: Uint8Array): X25519Identity {
  if (plaintext.length > KEY_BLOCK_PLAINTEXT_LIMIT) throw errBadKeyBlock();
  const text = Buffer.from(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).toString("latin1");
  const lines = text
    .split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
    .filter((l) => l !== "" && !l.startsWith("#"));
  if (lines.length !== 1 || !lines[0]!.startsWith("AGE-SECRET-KEY-1")) throw errBadKeyBlock();
  try {
    return X25519Identity.parse(lines[0]!);
  } catch {
    throw errBadKeyBlock();
  }
}

/**
 * Opens a key block with a passphrase (§3.2 "Read"), in order:
 * 1. empty passphrase → `passphrase is empty` (code empty-passphrase);
 * 2. a work factor above 18 → `key block asks for scrypt work factor 2^N; …` (code
 *    work-factor), before any scrypt work;
 * 3. age decryption fails for any reason (stanza rules, wrong passphrase, header MAC,
 *    payload) → `wrong passphrase, or the key block is damaged` (code wrong-passphrase);
 * 4. plaintext above 4096 bytes, 5. not exactly one X25519 identity →
 *    `the key block is damaged: it doesn't hold exactly one vault key` (code bad-key-block).
 * The passphrase is used as exact bytes. Takes about 0.6 s (scrypt 2^18, off the main thread).
 */
export async function unwrapKeyBlock(keyBlock: Uint8Array, passphrase: Uint8Array): Promise<X25519Identity> {
  if (passphrase.length === 0) throw errEmptyPassphrase();
  const wf = excessiveWorkFactor(keyBlock);
  if (wf !== undefined) throw errWorkFactor(wf);
  let plaintext: Uint8Array;
  try {
    plaintext = await decryptWithPassphrase(keyBlock, passphrase, { maxLogN: SCRYPT_LOG_N, maxPlaintext: KEY_BLOCK_PLAINTEXT_LIMIT });
  } catch (e) {
    if (e instanceof AgeDecryptError) {
      if (e.kind === "too-long") throw errBadKeyBlock();
      throw errWrongPassphrase();
    }
    throw e;
  }
  try {
    return parseIdentityFile(plaintext);
  } finally {
    wipe(plaintext);
  }
}

/**
 * Lower-case hex SHA-256 of the binary key block (§3.4 "Key block identity",
 * agent-session.md §A2.5 `key_block`).
 */
export function keyBlockDigest(keyBlock: Uint8Array): string {
  return Buffer.from(sha256Bytes(keyBlock)).toString("hex");
}
