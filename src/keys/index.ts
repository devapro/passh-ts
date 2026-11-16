// Keys and encryption of the vault (vault-format.md §3, spec §5.4): the vault key, the
// key block (scrypt wrap), the data block, the paper recovery key, passphrase strength.

export { X25519Identity } from "../age/x25519.ts";
export { dataHeaderOpensWith, decryptData, encryptData } from "./datablock.ts";
export type { KeySource } from "./datablock.ts";
export {
  errBadKeyBlock,
  errDataDamaged,
  errDataNotToKey,
  errEmptyPassphrase,
  errWorkFactor,
  errWrongPassphrase,
  errWrongRecoveryKey,
  KeyErrorCode,
} from "./errors.ts";
export {
  excessiveWorkFactor,
  generateVaultKey,
  KEY_BLOCK_PLAINTEXT_LIMIT,
  KEY_BLOCK_SIZE,
  keyBlockDigest,
  parseIdentityFile,
  SCRYPT_LOG_N,
  unwrapKeyBlock,
  wrapKeyBlock,
} from "./keyblock.ts";
export { formatRecoveryKey, parseRecoveryKey } from "./recovery.ts";
export { defaultUserInputs, passphraseStrength, WEAK_SCORE, weakPassphraseWarning } from "./strength.ts";
export type { Strength } from "./strength.ts";
