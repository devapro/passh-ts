// The age X25519 recipient type (c2sp.org/age "The X25519 recipient type").
//
// The vault key is an X25519 identity (vault-format.md §3.1). S9: its recipient (`age1…`)
// is never written or printed, so X25519Identity offers no way to format it; the
// recipient's bytes are derived only inside `stanzaRecipient()` to encrypt a data block.

import { b64RawDecodeStrict, b64RawEncode } from "./base64.ts";
import { bech32Decode, bech32Encode, convertBits } from "./bech32.ts";
import type { Stanza } from "./header.ts";
import { aeadOpen, aeadSeal, hkdf32, randomBytes, wipe, x25519Base, x25519Shared } from "./primitives.ts";
import { errorf } from "../i18n/index.ts";

export const SECRET_KEY_HRP = "AGE-SECRET-KEY-";
export const RECIPIENT_HRP = "age";
const X25519_INFO = "age-encryption.org/v1/X25519";
const CHARSET_UPPER = "QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L";

/** Something that wraps a file key into stanzas (an age recipient). */
export interface Recipient {
  wrap(fileKey: Uint8Array): Stanza[];
}

/**
 * Result of offering stanzas to an identity: the file key, or null when no stanza is
 * addressed to this identity / opens with it. Malformed stanzas of its own type throw.
 */
export interface Identity {
  unwrap(stanzas: readonly Stanza[]): Uint8Array | null;
}

/** A malformed stanza of a type the identity handles (age rejects the file). */
export class StanzaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StanzaError";
  }
}

function wrapTo(recipientPoint: Uint8Array, fileKey: Uint8Array): Stanza {
  const ephemeral = randomBytes(32);
  const share = x25519Base(ephemeral);
  const shared = x25519Shared(ephemeral, recipientPoint);
  wipe(ephemeral);
  if (shared === null) throw new Error("X25519 recipient is a low-order point");
  const salt = new Uint8Array(64);
  salt.set(share);
  salt.set(recipientPoint, 32);
  const key = hkdf32(shared, salt, X25519_INFO);
  const body = aeadSeal(key, fileKey);
  wipe(shared, key);
  return { type: "X25519", args: [b64RawEncode(share)], body };
}

/** An age X25519 recipient (public key), e.g. from `--age age1…`. */
export class X25519Recipient implements Recipient {
  readonly #point: Uint8Array;

  constructor(point: Uint8Array) {
    if (point.length !== 32) throw errorf("invalid X25519 public key");
    this.#point = Uint8Array.from(point);
  }

  /** Parses `age1…` with age's errors (`malformed recipient "…": …`). */
  static parse(s: string): X25519Recipient {
    let d;
    try {
      d = bech32Decode(s);
    } catch (e) {
      throw errorf("malformed recipient %q: %w", s, e);
    }
    if (d.hrp !== RECIPIENT_HRP) throw errorf("malformed recipient %q: invalid type %q", s, d.hrp);
    try {
      return new X25519Recipient(d.data);
    } catch (e) {
      throw errorf("malformed recipient %q: %w", s, e);
    }
  }

  /** The `age1…` text. Only for recipients given by the user (never the vault key's: S9). */
  toString(): string {
    return bech32Encode(RECIPIENT_HRP, this.#point);
  }

  wrap(fileKey: Uint8Array): Stanza[] {
    return [wrapTo(this.#point, fileKey)];
  }
}

/** `AGE-SECRET-KEY-1…` for a 32-byte scalar, as upper-case ASCII bytes. */
function bech32Upper(data: Uint8Array): Uint8Array {
  // `AGE-SECRET-KEY-1` + data + checksum as ASCII bytes, built without an intermediate
  // string of the secret so the bytes can be wiped.
  const words = convertBits(data, 8, 5, true);
  const hrp = SECRET_KEY_HRP.toLowerCase();
  // Checksum over the lower-case hrp (BIP 173).
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const values: number[] = [];
  for (let i = 0; i < hrp.length; i++) values.push(hrp.charCodeAt(i) >> 5);
  values.push(0);
  for (let i = 0; i < hrp.length; i++) values.push(hrp.charCodeAt(i) & 31);
  values.push(...words, 0, 0, 0, 0, 0, 0);
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0;
    for (let j = 0; j < 5; j++) if ((top >>> j) & 1) chk = (chk ^ gen[j]!) >>> 0;
  }
  const mod = chk ^ 1;
  const prefix = SECRET_KEY_HRP + "1";
  const out = new Uint8Array(prefix.length + words.length + 6);
  for (let i = 0; i < prefix.length; i++) out[i] = prefix.charCodeAt(i);
  let o = prefix.length;
  for (const w of words) out[o++] = CHARSET_UPPER.charCodeAt(w);
  for (let i = 0; i < 6; i++) out[o++] = CHARSET_UPPER.charCodeAt((mod >>> (5 * (5 - i))) & 31);
  words.fill(0);
  values.fill(0);
  return out;
}

/**
 * An age X25519 identity: the vault key (vault-format.md §3.1). Holds the 32-byte scalar;
 * `wipe()` zeroes it. The recipient is never exposed as text (S9).
 */
export class X25519Identity implements Identity {
  readonly #scalar: Uint8Array;
  #wiped = false;

  private constructor(scalar: Uint8Array) {
    this.#scalar = scalar;
  }

  /** A new random identity (32 bytes from the CSPRNG). */
  static generate(): X25519Identity {
    return new X25519Identity(randomBytes(32));
  }

  /** An identity from its 32-byte scalar (copied). */
  static fromBytes(scalar: Uint8Array): X25519Identity {
    if (scalar.length !== 32) throw errorf("invalid X25519 secret key");
    return new X25519Identity(Uint8Array.from(scalar));
  }

  /**
   * Parses `AGE-SECRET-KEY-1…` like age does: Bech32 with checksum, all upper or all
   * lower case, human-readable part `AGE-SECRET-KEY-` as written (so upper case), 32
   * bytes. Throws `malformed secret key: …`.
   */
  static parse(s: string): X25519Identity {
    let d;
    try {
      d = bech32Decode(s);
    } catch (e) {
      throw errorf("malformed secret key: %w", e);
    }
    if (d.hrp !== SECRET_KEY_HRP) {
      wipe(d.data);
      throw errorf("malformed secret key: unknown type %q", d.hrp);
    }
    if (d.data.length !== 32) {
      wipe(d.data);
      throw errorf("malformed secret key: invalid X25519 secret key");
    }
    return new X25519Identity(d.data);
  }

  #check(): void {
    if (this.#wiped) throw new Error("X25519Identity used after wipe()");
  }

  /**
   * The `AGE-SECRET-KEY-1…` text (74 characters, upper case). A JS string can't be wiped:
   * prefer `encode()` where the copy can be.
   */
  format(): string {
    this.#check();
    const b = bech32Upper(this.#scalar);
    const s = Buffer.from(b).toString("latin1");
    wipe(b);
    return s;
  }

  /** Never the key: string conversion and inspection can't leak it into a message or log. */
  toString(): string {
    return "[X25519Identity]";
  }

  toJSON(): string {
    return "[X25519Identity]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[X25519Identity]";
  }

  /** The `AGE-SECRET-KEY-1…` text as ASCII bytes, which the caller can wipe. */
  encode(): Uint8Array {
    this.#check();
    return bech32Upper(this.#scalar);
  }

  /** A copy of the 32-byte scalar (the caller wipes it). */
  secretBytes(): Uint8Array {
    this.#check();
    return Uint8Array.from(this.#scalar);
  }

  /** Reports whether both identities hold the same key (constant time). */
  equals(other: X25519Identity): boolean {
    this.#check();
    const a = this.#scalar;
    const b = other.secretBytes();
    let acc = 0;
    for (let i = 0; i < 32; i++) acc |= a[i]! ^ b[i]!;
    wipe(b);
    return acc === 0;
  }

  /**
   * A recipient for this identity, to encrypt a data block (S9: held only in memory, and
   * it has no text form). Intended for one encryption, then dropped.
   */
  stanzaRecipient(): Recipient {
    this.#check();
    const point = x25519Base(this.#scalar);
    return {
      wrap(fileKey: Uint8Array): Stanza[] {
        return [wrapTo(point, fileKey)];
      },
    };
  }

  /**
   * Offers the stanzas: the file key from the first X25519 stanza that opens with this
   * identity, null if none does. A malformed X25519 stanza (not exactly one argument, not
   * canonical base64 of 32 bytes, a body not of 32 bytes, an all-zero shared secret)
   * throws StanzaError, as age rejects such a file.
   */
  unwrap(stanzas: readonly Stanza[]): Uint8Array | null {
    this.#check();
    const ourPoint = x25519Base(this.#scalar);
    try {
      for (const s of stanzas) {
        if (s.type !== "X25519") continue;
        if (s.args.length !== 1) throw new StanzaError("invalid X25519 recipient block");
        const share = b64RawDecodeStrict(s.args[0]!);
        if (share === null || share.length !== 32) throw new StanzaError("invalid X25519 recipient block");
        if (s.body.length !== 32) throw new StanzaError("invalid X25519 recipient block");
        const shared = x25519Shared(this.#scalar, share);
        if (shared === null) throw new StanzaError("invalid X25519 recipient");
        const salt = new Uint8Array(64);
        salt.set(share);
        salt.set(ourPoint, 32);
        const key = hkdf32(shared, salt, X25519_INFO);
        const fileKey = aeadOpen(key, s.body);
        wipe(shared, key);
        if (fileKey !== null) return fileKey;
      }
      return null;
    } finally {
      wipe(ourPoint);
    }
  }

  /** Zeroes the key; the identity can't be used afterwards. */
  wipe(): void {
    this.#scalar.fill(0);
    this.#wiped = true;
  }

  get wiped(): boolean {
    return this.#wiped;
  }
}
