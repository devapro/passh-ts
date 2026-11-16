// The age hybrid post-quantum recipient type, MLKEM768-X25519 (X-Wing), as in
// c2sp.org/age "The MLKEM768-X25519 (i.e. X-Wing) hybrid post-quantum recipient type"
// and age v1.3 (`age-keygen -pq`). Used by `export --age age1pq1…` (import-export.md §2.7).
//
// Stanza: `-> mlkem768x25519 <base64 enc (1120 bytes)>`, body = the HPKE ciphertext of
// the file key from SealBase (RFC 9180 §6.1) with KEM MLKEM768-X25519 (id 0x647a,
// draft-ietf-hpke-pq), KDF HKDF-SHA256, AEAD ChaCha20Poly1305,
// info "age-encryption.org/mlkem768x25519", empty aad.
//
// The identity side (`AGE-SECRET-KEY-PQ-1…`) is here for round-trip tests; passh itself
// never decrypts with a hybrid identity.

import { ml_kem768_x25519 as xwing } from "@noble/post-quantum/hybrid.js";
import { extract, expand } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { b64RawDecodeStrict, b64RawEncode } from "./base64.ts";
import { bech32Decode, bech32Encode } from "./bech32.ts";
import type { Stanza } from "./header.ts";
import { aeadOpen, aeadSeal, ascii, wipe } from "./primitives.ts";
import { StanzaError, type Identity, type Recipient } from "./x25519.ts";
import { errorf } from "../i18n/index.ts";

export const HYBRID_RECIPIENT_HRP = "age1pq";
export const HYBRID_SECRET_KEY_HRP = "AGE-SECRET-KEY-PQ-";
const STANZA_TYPE = "mlkem768x25519";
const HPKE_INFO = ascii("age-encryption.org/mlkem768x25519");
const PUBLIC_KEY_SIZE = 1216;
const ENC_SIZE = 1120;

// RFC 9180 §5.1: suite_id = "HPKE" || I2OSP(kem_id, 2) || I2OSP(kdf_id, 2) || I2OSP(aead_id, 2)
const SUITE_ID = new Uint8Array([0x48, 0x50, 0x4b, 0x45, 0x64, 0x7a, 0x00, 0x01, 0x00, 0x03]);
const HPKE_V1 = ascii("HPKE-v1");

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function labeledExtract(salt: Uint8Array, label: string, ikm: Uint8Array): Uint8Array {
  return extract(sha256, concat(HPKE_V1, SUITE_ID, ascii(label), ikm), salt);
}

function labeledExpand(prk: Uint8Array, label: string, info: Uint8Array, length: number): Uint8Array {
  const len = new Uint8Array([length >> 8, length & 0xff]);
  return expand(sha256, prk, concat(len, HPKE_V1, SUITE_ID, ascii(label), info), length);
}

/** RFC 9180 §5.1 KeySchedule in base mode (no PSK): the AEAD key and base nonce. */
function keySchedule(sharedSecret: Uint8Array, info: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
  const empty = new Uint8Array(0);
  const pskIdHash = labeledExtract(empty, "psk_id_hash", empty);
  const infoHash = labeledExtract(empty, "info_hash", info);
  const context = concat(new Uint8Array([0x00]), pskIdHash, infoHash);
  const secret = labeledExtract(sharedSecret, "secret", empty);
  const key = labeledExpand(secret, "key", context, 32);
  const nonce = labeledExpand(secret, "base_nonce", context, 12);
  wipe(secret);
  return { key, nonce };
}

/**
 * FIPS 203 §7.2 encapsulation key check of the ML-KEM-768 part (the first 1184 bytes):
 * every 12-bit coefficient of the 3 × 384 encoded bytes is below q = 3329.
 */
function mlkemKeyOk(pk: Uint8Array): boolean {
  for (let i = 0; i < 1152; i += 3) {
    const a = pk[i]!;
    const b = pk[i + 1]!;
    const c = pk[i + 2]!;
    if ((a | ((b & 0x0f) << 8)) >= 3329 || ((b >> 4) | (c << 4)) >= 3329) return false;
  }
  return true;
}

/** An age hybrid post-quantum recipient (`age1pq1…`). */
export class HybridRecipient implements Recipient {
  readonly #publicKey: Uint8Array;

  constructor(publicKey: Uint8Array) {
    if (publicKey.length !== PUBLIC_KEY_SIZE || !mlkemKeyOk(publicKey)) throw errorf("invalid MLKEM768-X25519 public key");
    this.#publicKey = Uint8Array.from(publicKey);
  }

  /** Parses `age1pq1…` with age's error forms (`malformed recipient "…": …`). */
  static parse(s: string): HybridRecipient {
    let d;
    try {
      d = bech32Decode(s);
    } catch (e) {
      throw errorf("malformed recipient %q: %w", s, e);
    }
    if (d.hrp !== HYBRID_RECIPIENT_HRP) throw errorf("malformed recipient %q: invalid type %q", s, d.hrp);
    try {
      return new HybridRecipient(d.data);
    } catch (e) {
      throw errorf("malformed recipient %q: %w", s, e);
    }
  }

  toString(): string {
    return bech32Encode(HYBRID_RECIPIENT_HRP, this.#publicKey);
  }

  /** HPKE SealBase of the file key to this recipient. */
  wrap(fileKey: Uint8Array): Stanza[] {
    const { cipherText: enc, sharedSecret } = xwing.encapsulate(this.#publicKey);
    const { key, nonce } = keySchedule(sharedSecret, HPKE_INFO);
    const body = aeadSeal(key, fileKey, nonce);
    wipe(sharedSecret, key, nonce);
    return [{ type: STANZA_TYPE, args: [b64RawEncode(enc)], body }];
  }
}

/** An age hybrid identity (`AGE-SECRET-KEY-PQ-1…`), for tests. */
export class HybridIdentity implements Identity {
  readonly #seed: Uint8Array;

  constructor(seed: Uint8Array) {
    if (seed.length !== 32) throw errorf("invalid hybrid secret key");
    this.#seed = Uint8Array.from(seed);
  }

  static generate(): HybridIdentity {
    const { secretKey } = xwing.keygen();
    return new HybridIdentity(secretKey);
  }

  static parse(s: string): HybridIdentity {
    const d = bech32Decode(s);
    if (d.hrp !== HYBRID_SECRET_KEY_HRP) throw errorf("malformed secret key: unknown type %q", d.hrp);
    return new HybridIdentity(d.data);
  }

  toString(): string {
    return bech32Encode(HYBRID_SECRET_KEY_HRP, this.#seed, true);
  }

  recipient(): HybridRecipient {
    return new HybridRecipient(xwing.getPublicKey(this.#seed));
  }

  unwrap(stanzas: readonly Stanza[]): Uint8Array | null {
    for (const s of stanzas) {
      if (s.type !== STANZA_TYPE) continue;
      if (s.args.length !== 1) throw new StanzaError("invalid mlkem768x25519 recipient block");
      const enc = b64RawDecodeStrict(s.args[0]!);
      if (enc === null || enc.length !== ENC_SIZE) throw new StanzaError("invalid mlkem768x25519 recipient block");
      if (s.body.length !== 32) throw new StanzaError("invalid mlkem768x25519 recipient block");
      const shared = xwing.decapsulate(enc, this.#seed);
      const { key, nonce } = keySchedule(shared, HPKE_INFO);
      const fileKey = aeadOpen(key, s.body, nonce);
      wipe(shared, key, nonce);
      if (fileKey !== null) return fileKey;
    }
    return null;
  }

  wipe(): void {
    this.#seed.fill(0);
  }
}
