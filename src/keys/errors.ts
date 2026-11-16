// Errors of the key layer, with stable codes for hasCode() (vault-format.md §3.2, §3.3,
// §3.6). Messages carry no `<path>: ` prefix: the storage layer adds it.

import { codedError, type PasshError } from "../i18n/index.ts";

/** Codes of the errors below. */
export const KeyErrorCode = {
  /** §3.2 step 1. */
  EmptyPassphrase: "empty-passphrase",
  /** §3.2 step 2: work factor above 18, refused before scrypt. */
  WorkFactor: "work-factor",
  /** §3.2 step 3: counts as a wrong try. */
  WrongPassphrase: "wrong-passphrase",
  /** §3.2 steps 4–5. */
  BadKeyBlock: "bad-key-block",
  /** §3.3: no stanza opens with the key from the passphrase or the agent. */
  DataNotToKey: "data-not-to-key",
  /** §3.3: no stanza opens with a paper recovery key. */
  WrongRecoveryKey: "wrong-recovery-key",
  /** §3.3: any other decryption failure of the data block. */
  DataDamaged: "data-damaged",
  /** §3.6 step 2: nothing was typed (the CLI stops asking at once). */
  RecoveryKeyEmpty: "recovery-key-empty",
  /** §3.6 steps 3–6. */
  BadRecoveryKey: "bad-recovery-key",
} as const;

export function errEmptyPassphrase(): PasshError {
  return codedError(KeyErrorCode.EmptyPassphrase, "passphrase is empty");
}

export function errWorkFactor(n: bigint): PasshError {
  return codedError(KeyErrorCode.WorkFactor, "key block asks for scrypt work factor 2^%d; passh uses 2^18: the file is damaged or not made by passh", n);
}

export function errWrongPassphrase(): PasshError {
  return codedError(KeyErrorCode.WrongPassphrase, "wrong passphrase, or the key block is damaged");
}

export function errBadKeyBlock(): PasshError {
  return codedError(KeyErrorCode.BadKeyBlock, "the key block is damaged: it doesn't hold exactly one vault key");
}

export function errDataNotToKey(): PasshError {
  return codedError(KeyErrorCode.DataNotToKey, "data is damaged; restore a backup (the data block isn't encrypted to this vault's key: damaged or replaced)");
}

export function errWrongRecoveryKey(): PasshError {
  return codedError(KeyErrorCode.WrongRecoveryKey, "this key doesn't open this vault (rekeyed elsewhere? wrong recovery key?)");
}

export function errDataDamaged(): PasshError {
  return codedError(KeyErrorCode.DataDamaged, "data is damaged; restore a backup");
}
