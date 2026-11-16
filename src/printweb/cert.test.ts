// The print page's certificate (print.md §6.3): fields, storage, reuse and regeneration.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, type IsolatedEnv } from "../../test/helpers/env.ts";
import { certificateNotice, loadOrCreateCertificate } from "./cert.ts";
import { fingerprint, makeCertificate, parseCertificate, pemBlock } from "./x509.ts";

let env: IsolatedEnv;
beforeAll(() => {
  env = isolatedEnv("cert");
});
afterAll(() => env.cleanup());

const IP1 = Uint8Array.of(192, 168, 1, 10);
const IP2 = Uint8Array.of(0xfd, 0x12, 0x34, 0x56, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);
const NOW = new Date("2026-11-16T12:00:00Z");
const DAY = 24 * 3600_000;

describe("a new certificate", () => {
  test("its fields, parsed back with node:crypto", () => {
    const c = makeCertificate([IP1, IP2], ["pi.local", "Host.Example"], NOW);
    const x = new X509Certificate(c.certPem);
    expect(x.subject).toBe("CN=passh print page");
    expect(x.issuer).toBe("CN=passh print page");
    expect(x.subjectAltName).toBe("DNS:pi.local, DNS:Host.Example, IP Address:192.168.1.10, IP Address:FD12:3456:0:0:0:0:0:1");
    expect(new Date(x.validFrom).getTime()).toBe(NOW.getTime() - 3600_000);
    expect(new Date(x.validTo).getTime()).toBe(NOW.getTime() + 365 * DAY);
    expect(x.ca).toBe(false);
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.checkPrivateKey(createPrivateKey(c.keyPem))).toBe(true);
    expect(x.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(BigInt("0x" + x.serialNumber) < 1n << 127n).toBe(true);
    expect(x.fingerprint256).toBe(fingerprint(c.der));
    expect(fingerprint(c.der)).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(c.keyPem).toStartWith("-----BEGIN PRIVATE KEY-----\n");
  });

  test("extensions: key usage and basic constraints critical, EKU serverAuth, no key identifiers", () => {
    const c = makeCertificate([IP1], [], NOW);
    const hex = Buffer.from(c.der).toString("hex");
    // 2.5.29.15 critical, BIT STRING 07 80 (digitalSignature)
    expect(hex).toContain("0603551d0f0101ff04040302078030");
    // 2.5.29.37 serverAuth
    expect(hex).toContain("0603551d25040c300a06082b06010505070301");
    // 2.5.29.19 critical, empty SEQUENCE (CA:FALSE)
    expect(hex).toContain("0603551d130101ff04023000");
    expect(hex).not.toContain("0603551d0e"); // subject key identifier
    expect(hex).not.toContain("0603551d23"); // authority key identifier
    const p = parseCertificate(c.der);
    expect(p.ips).toEqual([IP1]);
    expect(p.dnsNames).toEqual([]);
  });

  test("dates outside 1950–2049 use GeneralizedTime", () => {
    const c = makeCertificate([IP1], [], new Date("2049-12-01T00:00:00Z"));
    const p = parseCertificate(c.der);
    expect(p.notAfter.toISOString()).toBe("2050-12-01T00:00:00.000Z");
    expect(new X509Certificate(c.certPem).validTo).toContain("2050");
  });
});

describe("storage and reuse", () => {
  const state = () => join(env.dir, "state-" + Math.random().toString(36).slice(2));

  test("first use, then reused with the same fingerprint; files 0600, folder 0700", () => {
    const st = state();
    const a = loadOrCreateCertificate(st, [IP1], ["pi.local"], NOW);
    expect(a.madeBecause?.message).toBe("first use");
    expect(certificateNotice(a.madeBecause!).message).toBe("made a new certificate for the print page (first use); browsers will warn about it: compare the fingerprint");
    const dir = join(st, "print-web");
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(dir, "key.pem")).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(dir, "cert.pem")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual(["cert.pem", "key.pem"]);
    const b = loadOrCreateCertificate(st, [IP1], ["PI.LOCAL"], new Date(NOW.getTime() + 10 * DAY));
    expect(b.madeBecause).toBeUndefined();
    expect(b.fingerprint).toBe(a.fingerprint);
    // Covering more than needed is fine.
    expect(loadOrCreateCertificate(st, [], [], NOW).madeBecause).toBeUndefined();
  });

  test("regeneration reasons, in table order", () => {
    const st = state();
    const dir = join(st, "print-web");
    const reason = (ips: Uint8Array[], names: string[], now: Date) => loadOrCreateCertificate(st, ips, names, now).madeBecause?.message;
    loadOrCreateCertificate(st, [IP1], [], NOW);
    expect(reason([IP1, IP2], ["pi.local"], NOW)).toBe("the addresses or hostnames changed: the old one doesn't cover fd12:3456::1, pi.local");
    expect(reason([IP1], [], new Date(NOW.getTime() + 365 * DAY - 12 * 3600_000))).toBe("the stored certificate expires on 2027-11-16");
    expect(reason([IP1], [], new Date(NOW.getTime() + 800 * DAY))).toMatch(/^the stored certificate expired on \d{4}-\d\d-\d\d$/);
    expect(reason([IP1], [], new Date(NOW.getTime() - 10 * DAY))).toMatch(/^the stored certificate is not valid until \d{4}-\d\d-\d\d$/);
    chmodSync(join(dir, "key.pem"), 0o644);
    expect(reason([IP1], [], new Date(NOW.getTime() - 10 * DAY))).toBe("the stored key had mode 0644, readable by others");
    writeFileSync(join(dir, "elsewhere.pem"), readFileSync(join(dir, "key.pem")), { mode: 0o600 });
    rmSync(join(dir, "key.pem"));
    symlinkSync(join(dir, "elsewhere.pem"), join(dir, "key.pem"));
    expect(reason([IP1], [], NOW)).toBe("the stored key is not a regular file");
    rmSync(join(dir, "elsewhere.pem"));
    rmSync(join(dir, "key.pem"));
    mkdirSync(join(dir, "key.pem"));
    // A folder in the way: the reason is found, but the new key can't be renamed over it.
    expect(() => reason([IP1], [], NOW)).toThrow(/^rename .*key\.pem: is a directory$/);
    rmSync(join(dir, "key.pem"), { recursive: true });
    expect(reason([IP1], [], NOW)).toMatch(/^the stored key can't be read: lstat .*key\.pem: no such file or directory$/);
    rmSync(join(dir, "cert.pem"));
    expect(reason([IP1], [], NOW)).toMatch(/^the stored certificate can't be read: lstat .*cert\.pem: no such file or directory$/);
    writeFileSync(join(dir, "cert.pem"), "garbage");
    expect(reason([IP1], [], NOW)).toMatch(/^the stored certificate can't be used: /);
    // Another implementation's pair (SEC 1 key) is reused if it passes the table.
    const other = makeCertificate([IP1], [], NOW);
    const sec1 = createPrivateKey(other.keyPem).export({ type: "sec1", format: "pem" }).toString();
    writeFileSync(join(dir, "cert.pem"), other.certPem);
    writeFileSync(join(dir, "key.pem"), sec1, { mode: 0o600 });
    const reused = loadOrCreateCertificate(st, [IP1], [], NOW);
    expect(reused.madeBecause).toBeUndefined();
    expect(reused.fingerprint).toBe(fingerprint(other.der));
    // A key that doesn't match the certificate.
    writeFileSync(join(dir, "key.pem"), makeCertificate([IP1], [], NOW).keyPem, { mode: 0o600 });
    expect(reason([IP1], [], NOW)).toBe("the stored certificate can't be used: tls: private key does not match public key");
  });

  test("the folder: a symlink or a file is refused; another mode is fixed", () => {
    const st = state();
    mkdirSync(st, { recursive: true });
    symlinkSync("/tmp", join(st, "print-web"));
    expect(() => loadOrCreateCertificate(st, [IP1], [], NOW)).toThrow(/^print page certificate folder .*print-web is not a folder$/);
    const st2 = state();
    mkdirSync(join(st2, "print-web"), { recursive: true, mode: 0o755 });
    chmodSync(join(st2, "print-web"), 0o755);
    loadOrCreateCertificate(st2, [IP1], [], NOW);
    expect(lstatSync(join(st2, "print-web")).mode & 0o777).toBe(0o700);
    expect(existsSync(join(st2, "print-web", "cert.pem"))).toBe(true);
    expect(pemBlock(readFileSync(join(st2, "print-web", "cert.pem"), "utf8"), "CERTIFICATE")).toBeDefined();
  });
});
