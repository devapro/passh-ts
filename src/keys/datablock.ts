// The data block (vault-format.md §3.3): an age file to the vault key's recipient, the
// plaintext being the data JSON. S9: the recipient exists only in memory while encrypting.

import { AgeDecryptError, decrypt, encrypt } from "../age/age.ts";
import { AgeHeaderError, parseHeader } from "../age/header.ts";
import { wipe } from "../age/primitives.ts";
import { StanzaError, type X25519Identity } from "../age/x25519.ts";
import { errDataDamaged, errDataNotToKey, errWrongRecoveryKey } from "./errors.ts";

/** Where the vault key came from: it decides the message when no stanza opens (§3.3). */
export type KeySource = "passphrase" | "agent" | "paper";

/**
 * Encrypts the data JSON to the vault key: exactly one X25519 stanza, a fresh file key
 * (§3.3 "Write"). Binary size: 168 + 16 + P + 16·max(1, ⌈P/65536⌉).
 */
export function encryptData(json: Uint8Array, identity: X25519Identity): Uint8Array {
  return encrypt(json, [identity.stanzaRecipient()]);
}

/**
 * Decrypts and authenticates the whole data block (§3.3 "Read"). Failures:
 * - no stanza opens with the key: from the passphrase or the agent → `data is damaged;
 *   restore a backup (the data block isn't encrypted to this vault's key: damaged or
 *   replaced)` (code data-not-to-key); from a paper key → `this key doesn't open this
 *   vault (rekeyed elsewhere? wrong recovery key?)` (code wrong-recovery-key);
 * - any other failure → `data is damaged; restore a backup` (code data-damaged).
 * The storage layer adds `<path>: ` and the list of backups.
 */
export function decryptData(block: Uint8Array, identity: X25519Identity, keySource: KeySource): Uint8Array {
  try {
    return decrypt(block, identity);
  } catch (e) {
    if (e instanceof AgeDecryptError) {
      if (e.kind === "no-match") throw keySource === "paper" ? errWrongRecoveryKey() : errDataNotToKey();
      throw errDataDamaged();
    }
    throw e;
  }
}

/**
 * Reports whether the key unwraps a file key from the data block's age header (header
 * only: no MAC, no payload). storage.md §3.2 step 2 uses it to match backups to a vault.
 */
export function dataHeaderOpensWith(block: Uint8Array, identity: X25519Identity): boolean {
  try {
    const fileKey = identity.unwrap(parseHeader(block).stanzas);
    if (fileKey === null) return false;
    wipe(fileKey);
    return true;
  } catch (e) {
    if (e instanceof StanzaError || e instanceof AgeHeaderError) return false;
    throw e;
  }
}
