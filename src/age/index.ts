// age v1 (c2sp.org/age, age-encryption.org/v1), tailored to passh: the header parser follows
// vault-format.md §2.3 exactly; scrypt, X25519 and the hybrid post-quantum recipient
// (`age1pq1…`, for `export --age`); STREAM payload; armor; Bech32.

export { AgeDecryptError, decrypt, decryptWithPassphrase, encrypt, encryptWithPassphrase, FILE_KEY_SIZE } from "./age.ts";
export type { AgeFailure, DecryptOptions, PassphraseDecryptOptions } from "./age.ts";
export { ARMOR_BEGIN, ARMOR_END, armor, armorText, dearmor } from "./armor.ts";
export { b64RawDecodeStrict, b64RawEncode, b64StdDecodeStrict, b64StdEncode } from "./base64.ts";
export { bech32Decode, bech32Encode, BECH32_CHARSET_UPPER } from "./bech32.ts";
export { AgeHeaderError, encodeHeader, MAX_HEADER_SIZE, parseHeader, VERSION_LINE } from "./header.ts";
export type { Header, Stanza } from "./header.ts";
export { HybridIdentity, HybridRecipient } from "./hybrid.ts";
export { constantTimeEqual, randomBytes, sha256Bytes, wipe } from "./primitives.ts";
export { encryptArmored, parseExportRecipient, parseRecipient, trimSpace } from "./recipients.ts";
export { checkScryptStanza } from "./scrypt.ts";
export { isPossiblePayloadLength } from "./stream.ts";
export { StanzaError, X25519Identity, X25519Recipient } from "./x25519.ts";
export type { Identity, Recipient } from "./x25519.ts";
