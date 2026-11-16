// The age scrypt recipient type (c2sp.org/age "The scrypt recipient type"):
//
//   -> scrypt <base64 16-byte salt> <log2 N>
//   body = ChaCha20-Poly1305(scrypt(N, r = 8, p = 1, S = "age-encryption.org/v1/scrypt" || salt, P), file key)
//
// The identity rules (exactly two arguments, a canonical 16-byte salt, a work factor in
// canonical decimal `[1-9][0-9]*` not above the limit, a 32-byte body) are checked before
// any scrypt work (vault-format.md §3.2 step 3).

import { b64RawDecodeStrict, b64RawEncode } from "./base64.ts";
import type { Stanza } from "./header.ts";
import { aeadOpen, aeadSeal, ascii, randomBytes, scryptAsync, wipe } from "./primitives.ts";
import { StanzaError } from "./x25519.ts";

const SCRYPT_LABEL = ascii("age-encryption.org/v1/scrypt");
export const SCRYPT_SALT_SIZE = 16;

function scryptSalt(salt: Uint8Array): Uint8Array {
  const s = new Uint8Array(SCRYPT_LABEL.length + salt.length);
  s.set(SCRYPT_LABEL);
  s.set(salt, SCRYPT_LABEL.length);
  return s;
}

/** Wraps a file key with a passphrase: a fresh 16-byte salt and work factor 2^logN. */
export async function scryptStanza(fileKey: Uint8Array, passphrase: Uint8Array, logN: number): Promise<Stanza> {
  const salt = randomBytes(SCRYPT_SALT_SIZE);
  const key = await scryptAsync(passphrase, scryptSalt(salt), logN);
  const body = aeadSeal(key, fileKey);
  wipe(key);
  return { type: "scrypt", args: [b64RawEncode(salt), String(logN)], body };
}

export interface ScryptParams {
  salt: Uint8Array;
  logN: number;
}

/**
 * Checks an scrypt stanza by age's identity rules with a work-factor limit; returns its
 * parameters or throws StanzaError (no scrypt work is done).
 */
export function checkScryptStanza(stanza: Stanza, maxLogN: number): ScryptParams {
  if (stanza.type !== "scrypt") throw new StanzaError("not an scrypt stanza");
  if (stanza.args.length !== 2) throw new StanzaError("invalid scrypt recipient block");
  const salt = b64RawDecodeStrict(stanza.args[0]!);
  if (salt === null) throw new StanzaError("failed to parse scrypt salt");
  if (salt.length !== SCRYPT_SALT_SIZE) throw new StanzaError("invalid scrypt recipient block");
  const wf = stanza.args[1]!;
  if (!/^[1-9][0-9]*$/.test(wf)) throw new StanzaError("scrypt work factor encoding invalid");
  // A long digit string is simply too large.
  const logN = wf.length > 3 ? Infinity : Number(wf);
  if (logN > maxLogN) throw new StanzaError("scrypt work factor too large");
  if (stanza.body.length !== 32) throw new StanzaError("invalid scrypt recipient block");
  return { salt, logN };
}

/**
 * Unwraps the file key from a checked scrypt stanza with the passphrase: null when the
 * passphrase is wrong (the AEAD tag doesn't verify).
 */
export async function unwrapScryptStanza(stanza: Stanza, params: ScryptParams, passphrase: Uint8Array): Promise<Uint8Array | null> {
  const key = await scryptAsync(passphrase, scryptSalt(params.salt), params.logN);
  const fileKey = aeadOpen(key, stanza.body);
  wipe(key);
  return fileKey;
}
