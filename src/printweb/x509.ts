// A minimal X.509 v3 writer and reader for the print page's self-signed certificate
// (print.md §6.3). node:crypto makes and signs with ECDSA P-256 keys but has no certificate
// builder, so the DER is encoded here (about 100 lines, no dependency); reading back uses
// the same small DER parser for the fields the reuse rules need (validity and SANs).

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

// ---------------------------------------------------------------------------
// DER encoding

function len(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
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

function tlv(tag: number, ...content: Uint8Array[]): Uint8Array {
  const c = concat(content);
  return concat([Uint8Array.of(tag), len(c.length), c]);
}

const seq = (...c: Uint8Array[]) => tlv(0x30, ...c);
const set = (...c: Uint8Array[]) => tlv(0x31, ...c);
const octets = (b: Uint8Array) => tlv(0x04, b);
const bitString = (b: Uint8Array, unused = 0) => tlv(0x03, Uint8Array.of(unused), b);
const explicit = (n: number, ...c: Uint8Array[]) => tlv(0xa0 | n, ...c);
const bool = (v: boolean) => tlv(0x01, Uint8Array.of(v ? 0xff : 0));

/** A non-negative INTEGER from big-endian bytes (minimal form). */
function integer(b: Uint8Array): Uint8Array {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  let v = b.subarray(i);
  if (v.length === 0) v = Uint8Array.of(0);
  if (v[0]! & 0x80) v = concat([Uint8Array.of(0), v]);
  return tlv(0x02, v);
}

function oid(dotted: string): Uint8Array {
  const parts = dotted.split(".").map(Number);
  const out: number[] = [parts[0]! * 40 + parts[1]!];
  for (const p of parts.slice(2)) {
    const enc: number[] = [p & 0x7f];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) enc.unshift(0x80 | (v & 0x7f));
    out.push(...enc);
  }
  return tlv(0x06, Uint8Array.from(out));
}

function printable(s: string): Uint8Array {
  return tlv(0x13, new TextEncoder().encode(s));
}

/** UTCTime for 1950–2049, GeneralizedTime otherwise (RFC 5280 §4.1.2.5). */
function time(d: Date): Uint8Array {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const y = d.getUTCFullYear();
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  if (y >= 1950 && y < 2050) return tlv(0x17, new TextEncoder().encode(p(y % 100) + rest));
  return tlv(0x18, new TextEncoder().encode(p(y, 4) + rest));
}

const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const OID_CN = "2.5.4.3";
const OID_KEY_USAGE = "2.5.29.15";
const OID_EXT_KEY_USAGE = "2.5.29.37";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_SAN = "2.5.29.17";
const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";

function extension(id: string, critical: boolean, value: Uint8Array): Uint8Array {
  return critical ? seq(oid(id), bool(true), octets(value)) : seq(oid(id), octets(value));
}

export interface NewCertificate {
  /** DER of the certificate. */
  der: Uint8Array;
  /** PEM `CERTIFICATE`. */
  certPem: string;
  /** PEM `PRIVATE KEY` (PKCS #8). */
  keyPem: string;
}

/**
 * A new self-signed certificate (print.md §6.3): ECDSA P-256; issuer = subject =
 * `CN=passh print page`; serial uniform in [0, 2^127); NotBefore = now − 1 h; NotAfter =
 * now + 365 × 24 h; Key Usage digitalSignature (critical); Extended Key Usage serverAuth;
 * Basic Constraints CA:FALSE (critical); SAN: the hostnames as DNS entries and the addresses
 * (in bind order) as IP entries; signature ECDSA-SHA256; no key identifiers.
 */
export function makeCertificate(ips: readonly Uint8Array[], hostnames: readonly string[], now: Date): NewCertificate {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }) as Buffer);
  const serial = new Uint8Array(randomBytes(16));
  serial[0]! &= 0x7f; // uniform in [0, 2^127)
  const name = seq(set(seq(oid(OID_CN), printable("passh print page"))));
  const algo = seq(oid(OID_ECDSA_SHA256));
  const notBefore = new Date(now.getTime() - 3600_000);
  const notAfter = new Date(now.getTime() + 365 * 24 * 3600_000);
  const sanNames = [...hostnames.map((h) => tlv(0x82, new TextEncoder().encode(h))), ...ips.map((ip) => tlv(0x87, ip))];
  const extensions = seq(
    extension(OID_KEY_USAGE, true, bitString(Uint8Array.of(0x80), 7)),
    extension(OID_EXT_KEY_USAGE, false, seq(oid(OID_SERVER_AUTH))),
    extension(OID_BASIC_CONSTRAINTS, true, seq()),
    extension(OID_SAN, false, seq(...sanNames)),
  );
  const tbs = seq(explicit(0, integer(Uint8Array.of(2))), integer(serial), algo, name, seq(time(notBefore), time(notAfter)), name, spki, explicit(3, extensions));
  const sig = new Uint8Array(sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" }));
  const der = seq(tbs, algo, bitString(sig));
  return { der, certPem: pem("CERTIFICATE", der), keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

/** A PEM block with 64-character base64 lines. */
export function pem(type: string, der: Uint8Array): string {
  const b64 = Buffer.from(der).toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----\n`;
}

/** The DER of the first PEM block of a type, or undefined. */
export function pemBlock(text: string, type: string): Uint8Array | undefined {
  const re = new RegExp(`-----BEGIN ${type}-----\\r?\\n([\\s\\S]*?)-----END ${type}-----`);
  const m = re.exec(text);
  if (!m) return undefined;
  return new Uint8Array(Buffer.from(m[1]!.replace(/\s+/g, ""), "base64"));
}

/** SHA-256 of the DER, upper-case hex byte pairs joined by `:` (print.md §6.3). */
export function fingerprint(der: Uint8Array): string {
  const h = createHash("sha256").update(der).digest("hex").toUpperCase();
  return h.match(/../g)!.join(":");
}

// ---------------------------------------------------------------------------
// DER decoding (the fields the reuse rules need)

interface Node {
  tag: number;
  off: number; // element start (tag)
  start: number; // content start
  end: number; // content end
  next: number; // offset after this element
}

function readNode(b: Uint8Array, off: number, end = b.length): Node {
  if (off + 2 > end) throw new Error("x509: truncated");
  const tag = b[off]!;
  let l = b[off + 1]!;
  let p = off + 2;
  if (l & 0x80) {
    const n = l & 0x7f;
    if (n === 0 || n > 4 || p + n > end) throw new Error("x509: bad length");
    l = 0;
    for (let i = 0; i < n; i++) l = l * 256 + b[p + i]!;
    p += n;
  }
  if (p + l > end) throw new Error("x509: truncated");
  return { tag, off, start: p, end: p + l, next: p + l };
}

function children(b: Uint8Array, n: Node): Node[] {
  const out: Node[] = [];
  for (let p = n.start; p < n.end; ) {
    const c = readNode(b, p, n.end);
    out.push(c);
    p = c.next;
  }
  return out;
}

function parseTime(b: Uint8Array, n: Node): Date {
  const s = new TextDecoder().decode(b.subarray(n.start, n.end));
  let m: RegExpExecArray | null;
  if (n.tag === 0x17 && (m = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s))) {
    const yy = Number(m[1]);
    return new Date(Date.UTC(yy >= 50 ? 1900 + yy : 2000 + yy, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
  }
  if (n.tag === 0x18 && (m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s))) {
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
  }
  throw new Error("x509: bad time");
}

function oidText(b: Uint8Array, n: Node): string {
  const v = b.subarray(n.start, n.end);
  const parts = [Math.floor(v[0]! / 40), v[0]! % 40];
  let acc = 0;
  for (let i = 1; i < v.length; i++) {
    acc = acc * 128 + (v[i]! & 0x7f);
    if (!(v[i]! & 0x80)) {
      parts.push(acc);
      acc = 0;
    }
  }
  return parts.join(".");
}

export interface ParsedCertificate {
  der: Uint8Array;
  notBefore: Date;
  notAfter: Date;
  /** IP SANs (4 or 16 bytes). */
  ips: Uint8Array[];
  /** DNS SANs. */
  dnsNames: string[];
  publicKey: KeyObject;
}

/** Parses a certificate's DER for the reuse rules; throws on anything malformed. */
export function parseCertificate(der: Uint8Array): ParsedCertificate {
  const root = readNode(der, 0);
  if (root.tag !== 0x30 || root.next !== der.length) throw new Error("x509: malformed certificate");
  const [tbsNode] = children(der, root);
  if (!tbsNode || tbsNode.tag !== 0x30) throw new Error("x509: malformed certificate");
  const tbs = children(der, tbsNode);
  let i = 0;
  if (tbs[0]?.tag === 0xa0) i++; // version
  const validity = tbs[i + 3];
  const spki = tbs[i + 5];
  if (!validity || !spki || validity.tag !== 0x30 || spki.tag !== 0x30) throw new Error("x509: malformed certificate");
  const [nb, na] = children(der, validity);
  if (!nb || !na) throw new Error("x509: malformed validity");
  const publicKey = createPublicKey({ key: Buffer.from(der.subarray(spki.off, spki.next)), format: "der", type: "spki" });
  const ips: Uint8Array[] = [];
  const dnsNames: string[] = [];
  for (const n of tbs.slice(i + 6)) {
    if (n.tag !== 0xa3) continue;
    const [exts] = children(der, n);
    if (!exts) continue;
    for (const ext of children(der, exts)) {
      const parts = children(der, ext);
      if (!parts[0] || oidText(der, parts[0]) !== OID_SAN) continue;
      const value = parts[parts.length - 1]!;
      const gn = readNode(der, value.start, value.end);
      for (const name of children(der, gn)) {
        const v = der.subarray(name.start, name.end);
        if (name.tag === 0x87) ips.push(new Uint8Array(v));
        else if (name.tag === 0x82) dnsNames.push(new TextDecoder().decode(v));
      }
    }
  }
  return { der, notBefore: parseTime(der, nb), notAfter: parseTime(der, na), ips, dnsNames, publicKey };
}

/** The SubjectPublicKeyInfo element of a certificate (tag and length included). */
function spkiDer(der: Uint8Array): Uint8Array {
  const tbsNode = children(der, readNode(der, 0))[0]!;
  const tbs = children(der, tbsNode);
  const spki = tbs[(tbs[0]?.tag === 0xa0 ? 1 : 0) + 5]!;
  return der.subarray(spki.off, spki.next);
}

/** Loads a private key from PEM (PKCS #8 `PRIVATE KEY` or SEC 1 `EC PRIVATE KEY`). */
export function loadPrivateKey(pemText: string): KeyObject {
  return createPrivateKey({ key: pemText, format: "pem" });
}

/** Reports whether a private key is ECDSA P-256 and matches the certificate's public key. */
export function keyMatches(certDer: Uint8Array, key: KeyObject): { ok: true } | { ok: false; reason: string } {
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return { ok: false, reason: "the key is not an ECDSA P-256 key" };
  const certSpki = Buffer.from(spkiDer(certDer));
  const keySpki = createPublicKey(key).export({ type: "spki", format: "der" }) as Buffer;
  if (!certSpki.equals(keySpki)) return { ok: false, reason: "tls: private key does not match public key" };
  return { ok: true };
}
