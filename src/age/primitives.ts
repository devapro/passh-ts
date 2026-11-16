// Cryptographic primitives for age (c2sp.org/age): HKDF-SHA-256, HMAC-SHA-256,
// ChaCha20-Poly1305 (@noble/ciphers: Bun's node:crypto lacks it), X25519 (@noble/curves),
// scrypt (node:crypto, native) and the CSPRNG (S3: crypto.getRandomValues).

import { scrypt as nodeScrypt, scryptSync as nodeScryptSync, timingSafeEqual } from "node:crypto";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf as nobleHkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

const enc = new TextEncoder();

/** UTF-8 bytes of an ASCII label. */
export function ascii(s: string): Uint8Array {
  return enc.encode(s);
}

/** n bytes from the CSPRNG (S3). */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // getRandomValues fills at most 65536 bytes per call.
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

/** HKDF-SHA-256 with a 32-byte output (age: "the length of the output keying material is always 32 bytes"). */
export function hkdf32(ikm: Uint8Array, salt: Uint8Array, info: string | Uint8Array): Uint8Array {
  return nobleHkdf(sha256, ikm, salt, typeof info === "string" ? ascii(info) : info, 32);
}

/** HMAC-SHA-256. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  return hmac(sha256, key, message);
}

/** SHA-256. */
export function sha256Bytes(data: Uint8Array): Uint8Array {
  return sha256(data);
}

const ZERO_NONCE = new Uint8Array(12);

/** ChaCha20-Poly1305 seal (RFC 7539) with the given nonce (default: 12 zero bytes, as age's stanzas use). */
export function aeadSeal(key: Uint8Array, plaintext: Uint8Array, nonce: Uint8Array = ZERO_NONCE, aad?: Uint8Array): Uint8Array {
  return chacha20poly1305(key, nonce, aad).encrypt(plaintext);
}

/** ChaCha20-Poly1305 open; null when the tag doesn't verify. */
export function aeadOpen(key: Uint8Array, ciphertext: Uint8Array, nonce: Uint8Array = ZERO_NONCE, aad?: Uint8Array): Uint8Array | null {
  if (ciphertext.length < 16) return null;
  try {
    return chacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  } catch {
    return null;
  }
}

/** X25519 of a scalar with the base point (RFC 7748 §5). */
export function x25519Base(scalar: Uint8Array): Uint8Array {
  return x25519.getPublicKey(scalar);
}

/**
 * X25519(scalar, point); null if the result is all zero bytes (age: "the identity
 * implementation MUST abort") or the point is rejected.
 */
export function x25519Shared(scalar: Uint8Array, point: Uint8Array): Uint8Array | null {
  let out: Uint8Array;
  try {
    out = x25519.getSharedSecret(scalar, point);
  } catch {
    return null;
  }
  let acc = 0;
  for (const b of out) acc |= b;
  return acc === 0 ? null : out;
}

/** Overwrites a buffer with zeros (best effort: JS can't guarantee no other copies). */
export function wipe(...bufs: Array<Uint8Array | null | undefined>): void {
  for (const b of bufs) b?.fill(0);
}

/** Constant-time equality of two byte strings (false for different lengths). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** scrypt parameters as age defines them: N = 2^logN, r = 8, p = 1, 32-byte output. */
function scryptOptions(logN: number) {
  const N = 2 ** logN;
  // 128 · N · r bytes for V, plus the B and XY buffers; leave generous headroom.
  return { N, r: 8, p: 1, maxmem: 128 * N * 8 + 64 * 1024 * 1024 };
}

/** scrypt (RFC 7914), native, off the main thread. log2 N = 18 takes about 0.6 s. */
export function scryptAsync(password: Uint8Array, salt: Uint8Array, logN: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, 32, scryptOptions(logN), (err, key) => {
      if (err) reject(err);
      else resolve(new Uint8Array(key.buffer, key.byteOffset, key.byteLength));
    });
  });
}

/** scrypt, blocking. */
export function scryptSync(password: Uint8Array, salt: Uint8Array, logN: number): Uint8Array {
  const key = nodeScryptSync(password, salt, 32, scryptOptions(logN));
  return new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
}
