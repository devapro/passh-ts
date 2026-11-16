// The age payload (c2sp.org/age "Payload"): a 16-byte nonce, then STREAM chunks of
// 64 KiB plaintext sealed with ChaCha20-Poly1305 under HKDF(file key, nonce, "payload"),
// nonce = 11-byte big-endian counter || last-chunk flag. The final chunk may be shorter
// and is empty only when it is the only one.

import { aeadOpen, aeadSeal, hkdf32, randomBytes, wipe } from "./primitives.ts";

export const CHUNK_SIZE = 64 * 1024;
const TAG_SIZE = 16;
const ENC_CHUNK_SIZE = CHUNK_SIZE + TAG_SIZE;
export const PAYLOAD_NONCE_SIZE = 16;

function chunkNonce(counter: number, last: boolean): Uint8Array {
  const n = new Uint8Array(12);
  // Counters stay far below 2^53 (64 MiB files); write the low 6 bytes big-endian.
  let c = counter;
  for (let i = 10; i >= 5; i--) {
    n[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  n[11] = last ? 1 : 0;
  return n;
}

/**
 * Reports whether `length` is a payload size age's STREAM can produce (vault-format.md
 * §2.3): L = 16 + P + 16·max(1, ⌈P / 65536⌉) for some P ≥ 0. So 32 and 65 568 are
 * possible, 31 and 65 584 aren't.
 */
export function isPossiblePayloadLength(length: number): boolean {
  const c = length - PAYLOAD_NONCE_SIZE;
  if (c < TAG_SIZE) return false;
  if (c === TAG_SIZE) return true; // the empty plaintext: one empty final chunk
  const full = Math.floor((c - 1) / ENC_CHUNK_SIZE); // chunks before the last one
  const last = c - full * ENC_CHUNK_SIZE;
  return last > TAG_SIZE && last <= ENC_CHUNK_SIZE;
}

/** Encrypts a plaintext into an age payload (fresh nonce). */
export function encryptPayload(fileKey: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const nonce = randomBytes(PAYLOAD_NONCE_SIZE);
  const key = hkdf32(fileKey, nonce, "payload");
  const chunks = Math.max(1, Math.ceil(plaintext.length / CHUNK_SIZE));
  const out = new Uint8Array(PAYLOAD_NONCE_SIZE + plaintext.length + chunks * TAG_SIZE);
  out.set(nonce);
  let off = PAYLOAD_NONCE_SIZE;
  for (let i = 0; i < chunks; i++) {
    const pt = plaintext.subarray(i * CHUNK_SIZE, Math.min(plaintext.length, (i + 1) * CHUNK_SIZE));
    const ct = aeadSeal(key, pt, chunkNonce(i, i === chunks - 1));
    out.set(ct, off);
    off += ct.length;
  }
  wipe(key);
  return out;
}

/** Why a payload didn't decrypt. */
export type PayloadFailure = "truncated" | "damaged" | "too-long";

export class PayloadError extends Error {
  readonly reason: PayloadFailure;
  constructor(reason: PayloadFailure) {
    super(reason === "too-long" ? "payload: plaintext too long" : `payload: ${reason}`);
    this.name = "PayloadError";
    this.reason = reason;
  }
}

/**
 * Decrypts and authenticates a whole payload. With `maxPlaintext`, stops with
 * PayloadError("too-long") as soon as more than that many plaintext bytes have been
 * authenticated (like reading through a size-limited reader).
 */
export function decryptPayload(fileKey: Uint8Array, payload: Uint8Array, maxPlaintext?: number): Uint8Array {
  if (payload.length < PAYLOAD_NONCE_SIZE + TAG_SIZE) throw new PayloadError("truncated");
  const nonce = payload.subarray(0, PAYLOAD_NONCE_SIZE);
  const key = hkdf32(fileKey, nonce, "payload");
  try {
    const body = payload.subarray(PAYLOAD_NONCE_SIZE);
    const parts: Uint8Array[] = [];
    let total = 0;
    let off = 0;
    for (let counter = 0; ; counter++) {
      const rest = body.length - off;
      const last = rest <= ENC_CHUNK_SIZE;
      const enc = body.subarray(off, off + (last ? rest : ENC_CHUNK_SIZE));
      if (enc.length < TAG_SIZE) throw new PayloadError("truncated");
      const pt = aeadOpen(key, enc, chunkNonce(counter, last));
      if (pt === null) throw new PayloadError("damaged");
      if (last && pt.length === 0 && counter > 0) throw new PayloadError("damaged");
      parts.push(pt);
      total += pt.length;
      if (maxPlaintext !== undefined && total > maxPlaintext) {
        for (const p of parts) wipe(p);
        throw new PayloadError("too-long");
      }
      off += enc.length;
      if (last) break;
    }
    if (parts.length === 1) return parts[0]!;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
      wipe(p);
    }
    return out;
  } finally {
    wipe(key);
  }
}
