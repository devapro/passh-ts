// The print page's certificate in `<state>/print-web/` (print.md §6.3): reuse the stored
// pair unless a rule of the table says otherwise; else make a new one (written key first,
// each through a temporary file, 0600, fsynced, renamed into place).

import { chmodSync, closeSync, constants as C, lstatSync, mkdirSync, openSync, readFileSync, renameSync, type Stats } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { errorf, type PasshError } from "../i18n/index.ts";
import { formatAddr } from "../config/cidr.ts";
import { foldEquals } from "../util/unicode.ts";
import { tildePath } from "../config/paths.ts";
import { fsyncDir, removeQuiet, writeAll, fsyncFd, closeQuiet } from "../fsx/files.ts";
import { isErrno, osError } from "../fsx/oserror.ts";
import { fingerprint, keyMatches, loadPrivateKey, makeCertificate, parseCertificate, pemBlock } from "./x509.ts";

export interface CertPair {
  certPem: string;
  keyPem: string;
  /** DER of the certificate. */
  der: Uint8Array;
  /** SHA-256 fingerprint as browsers show it. */
  fingerprint: string;
  /** Why a new certificate was made (the notice's `<reason>`), or undefined when reused. */
  madeBecause?: PasshError;
}

const DAY = 24 * 3600_000;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function sameIp(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Creates the certificate folder (print.md §6.3): 0700, a symlink or non-folder refused, another mode chmod'ed. */
function ensureFolder(dir: string): void {
  let st: Stats | undefined;
  try {
    st = lstatSync(dir);
  } catch (e) {
    if (!isErrno(e, "ENOENT")) throw errorf("print page certificate folder %s: %v", tildePath(dir), osError("lstat", dir, e));
  }
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) throw errorf("print page certificate folder %s is not a folder", tildePath(dir));
    if ((st.mode & 0o777) !== 0o700) {
      try {
        chmodSync(dir, 0o700);
      } catch (e) {
        throw osError("chmod", dir, e);
      }
    }
    return;
  }
  // The folder and a missing parent are created 0700.
  const parent = dirname(dir);
  try {
    lstatSync(parent);
  } catch (e) {
    if (!isErrno(e, "ENOENT")) throw osError("lstat", parent, e);
    try {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      chmodSync(parent, 0o700);
    } catch (e2) {
      throw osError("mkdir", parent, e2);
    }
  }
  try {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
  } catch (e) {
    throw osError("mkdir", dir, e);
  }
}

/** Why the stored pair can't be reused, or the parsed pair (print.md §6.3, the table in order). */
function checkStored(dir: string, ips: readonly Uint8Array[], hostnames: readonly string[], now: Date): { reason: PasshError } | { pair: CertPair } {
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  let certSt: Stats | undefined;
  let keySt: Stats | undefined;
  let certErr: unknown;
  let keyErr: unknown;
  try {
    certSt = lstatSync(certPath);
  } catch (e) {
    certErr = e;
  }
  try {
    keySt = lstatSync(keyPath);
  } catch (e) {
    keyErr = e;
  }
  if (!certSt && !keySt && isErrno(certErr, "ENOENT") && isErrno(keyErr, "ENOENT")) return { reason: errorf("first use") };
  if (!certSt) return { reason: errorf("the stored certificate can't be read: %v", osError("lstat", certPath, certErr)) };
  if (!keySt) return { reason: errorf("the stored key can't be read: %v", osError("lstat", keyPath, keyErr)) };
  if (!keySt.isFile()) return { reason: errorf("the stored key is not a regular file") };
  if (keySt.mode & 0o077) return { reason: errorf("the stored key had mode %s, readable by others", "0" + (keySt.mode & 0o777).toString(8).padStart(3, "0")) };
  let certPem: string;
  let keyPem: string;
  let der: Uint8Array;
  let parsed: ReturnType<typeof parseCertificate>;
  try {
    // cert.pem is read through a symlink and its mode is not checked (known issue, print.md §6.3).
    try {
      certPem = readFileSync(certPath, "utf8");
    } catch (e) {
      throw osError("open", certPath, e);
    }
    try {
      keyPem = readFileSync(keyPath, "utf8");
    } catch (e) {
      throw osError("open", keyPath, e);
    }
    const block = pemBlock(certPem, "CERTIFICATE");
    if (!block) throw new Error("tls: failed to find any PEM data in certificate input");
    der = block;
    parsed = parseCertificate(der);
    let key;
    try {
      key = loadPrivateKey(keyPem);
    } catch {
      throw new Error("tls: failed to parse private key");
    }
    const m = keyMatches(der, key);
    if (!m.ok) throw new Error(m.reason);
  } catch (e) {
    return { reason: errorf("the stored certificate can't be used: %v", e instanceof Error ? e : new Error(String(e))) };
  }
  const t = now.getTime();
  if (t < parsed.notBefore.getTime()) return { reason: errorf("the stored certificate is not valid until %s", ymd(parsed.notBefore)) };
  if (t > parsed.notAfter.getTime()) return { reason: errorf("the stored certificate expired on %s", ymd(parsed.notAfter)) };
  if (t + DAY > parsed.notAfter.getTime()) return { reason: errorf("the stored certificate expires on %s", ymd(parsed.notAfter)) };
  const missing: string[] = [];
  for (const ip of ips) if (!parsed.ips.some((x) => sameIp(x, ip))) missing.push(formatAddr(ip));
  for (const h of hostnames) if (!parsed.dnsNames.some((d) => foldEquals(d, h))) missing.push(h);
  if (missing.length > 0) return { reason: errorf("the addresses or hostnames changed: the old one doesn't cover %s", missing.join(", ")) };
  return { pair: { certPem, keyPem, der, fingerprint: fingerprint(der) } };
}

/** Writes a file through `.tmp-<name>-<random>` in its folder: 0600, fsynced, renamed into place. */
function writeAtomic(dir: string, name: string, data: string): void {
  const target = join(dir, name);
  let tmp = "";
  let fd = -1;
  for (let i = 0; i < 100 && fd < 0; i++) {
    tmp = join(dir, `.tmp-${name}-${randomBytes(4).readUInt32BE(0)}`);
    try {
      fd = openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | (C.O_NOFOLLOW ?? 0), 0o600);
    } catch (e) {
      if (!isErrno(e, "EEXIST")) throw osError("open", tmp, e);
    }
  }
  if (fd < 0) throw errorf("print page certificate: can't create a temporary file in %s", dir);
  try {
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* file systems without modes */
    }
    writeAll(fd, new TextEncoder().encode(data), tmp);
    fsyncFd(fd, tmp);
    closeSync(fd);
    fd = -1;
    try {
      renameSync(tmp, target);
    } catch (e) {
      throw osError("rename", tmp, e, target);
    }
  } catch (e) {
    closeQuiet(fd < 0 ? undefined : fd);
    removeQuiet(tmp);
    throw e;
  }
}

/**
 * Loads the stored certificate, or makes a new one for the bound addresses and hostnames
 * (print.md §6.3). `stateDir` is `<state>` (`$XDG_STATE_HOME/passh`).
 */
export function loadOrCreateCertificate(stateDir: string, ips: readonly Uint8Array[], hostnames: readonly string[], now: Date): CertPair {
  const dir = join(stateDir, "print-web");
  ensureFolder(dir);
  const stored = checkStored(dir, ips, hostnames, now);
  if ("pair" in stored) return stored.pair;
  // A new certificate covers only the current addresses and hostnames (SAN order as the
  // reference writes it: DNS names, then IP addresses in bind order).
  const c = makeCertificate(ips, hostnames, now);
  writeAtomic(dir, "key.pem", c.keyPem);
  writeAtomic(dir, "cert.pem", c.certPem);
  try {
    fsyncDir(dir);
  } catch {
    /* best effort */
  }
  return { certPem: c.certPem, keyPem: c.keyPem, der: c.der, fingerprint: fingerprint(c.der), madeBecause: stored.reason };
}

/** The notice when a certificate was made (print.md §6.3). */
export function certificateNotice(reason: PasshError): PasshError {
  return errorf("made a new certificate for the print page (%s); browsers will warn about it: compare the fingerprint", reason);
}
