// gpg's status lines and exit status judged as import-export.md §1.5 says; finding gpg.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv } from "../../test/helpers/env.ts";
import { findGpg, judgeGpg, parseStatus, type GpgVerdict } from "./gpg.ts";

const te = new TextEncoder();
const st = (...lines: string[]) => te.encode(lines.map((l) => l + "\n").join(""));
const detail = (v: GpgVerdict) => (v.kind === "failed" ? v.detail.message : v.kind);

describe("status parsing", () => {
  test("only `[GNUPG:] ` lines count; one trailing CR dropped; fields split on white space", () => {
    const lines = parseStatus(te.encode("[GNUPG:] A b  c\r\n[GNUPG:]B\n [GNUPG:] C\n[GNUPG:]  D\te \r\r\n[GNUPG:] \nnoise"));
    expect(lines.map((l) => l.fields)).toEqual([["A", "b", "c"], ["D", "e"]]);
  });
});

describe("judging (§1.5)", () => {
  test("success needs exit 0, DECRYPTION_OKAY and no failure keyword", () => {
    expect(judgeGpg(0, st("[GNUPG:] DECRYPTION_OKAY")).kind).toBe("ok");
    expect(judgeGpg(0, st("[GNUPG:] NO_SECKEY 1111", "[GNUPG:] DECRYPTION_OKAY")).kind).toBe("ok");
    expect(judgeGpg(0, st("[GNUPG:] DECRYPTION_OKAY\r")).kind).toBe("ok");
    expect(detail(judgeGpg(2, st("[GNUPG:] DECRYPTION_OKAY")))).toBe("gpg failed (exit status 2)");
    expect(detail(judgeGpg(null, st("[GNUPG:] DECRYPTION_OKAY")))).toBe("gpg failed (exit status -1)");
    expect(detail(judgeGpg(0, st("[GNUPG:] BADMDC", "[GNUPG:]  ERROR   decrypt   1  ", "[GNUPG:] DECRYPTION_OKAY")))).toBe("gpg reported BADMDC; ERROR decrypt 1");
    expect(detail(judgeGpg(0, st()))).toBe("gpg did not report a successful decryption");
    expect(detail(judgeGpg(0, st("[GNUPG:]DECRYPTION_OKAY", " [GNUPG:] DECRYPTION_OKAY")))).toBe("gpg did not report a successful decryption");
  });

  test("the first matching detail", () => {
    expect(detail(judgeGpg(2, st("[GNUPG:] NO_SECKEY 1111AAAA", "[GNUPG:] NO_SECKEY 2222BBBB", "[GNUPG:] NO_SECKEY 1111AAAA", "[GNUPG:] BAD_PASSPHRASE x")))).toBe(
      "no secret key for key ID 1111AAAA, 2222BBBB, 1111AAAA",
    );
    expect(detail(judgeGpg(2, st("[GNUPG:] BAD_PASSPHRASE x", "[GNUPG:] MISSING_PASSPHRASE", "[GNUPG:] NODATA 1")))).toBe("bad passphrase");
    expect(detail(judgeGpg(2, st("[GNUPG:] MISSING_PASSPHRASE", "[GNUPG:] NODATA 1")))).toBe("no passphrase given");
    for (const kw of ["NODATA 1", "BADARMOR", "UNEXPECTED 0"]) expect(detail(judgeGpg(2, st("[GNUPG:] " + kw, "[GNUPG:] ERROR x 1")))).toBe("not an OpenPGP message (damaged file?)");
    expect(detail(judgeGpg(0, st("[GNUPG:] FAILURE decrypt 123", "[GNUPG:] DECRYPTION_OKAY")))).toBe("gpg reported FAILURE decrypt 123");
    expect(detail(judgeGpg(0, st("[GNUPG:] DECRYPTION_FAILED", "[GNUPG:] DECRYPTION_OKAY")))).toBe("gpg reported DECRYPTION_FAILED");
    expect(detail(judgeGpg(3, st("[GNUPG:] NEED_PASSPHRASE")))).toBe("gpg failed (exit status 3)");
  });

  test("a cancel at the passphrase prompt is checked first", () => {
    expect(judgeGpg(2, st("[GNUPG:] DECRYPTION_OKAY", "[GNUPG:] ERROR pkdecrypt_failed 83886179")).kind).toBe("canceled");
    expect(judgeGpg(2, st("[GNUPG:] FAILURE decrypt 99")).kind).toBe("canceled");
    expect(judgeGpg(2, st("[GNUPG:] NO_SECKEY 1", "[GNUPG:] ERROR x 198")).kind).toBe("canceled");
    expect(judgeGpg(2, st("[GNUPG:] ERROR x " + ((1n << 40n) + 99n).toString())).kind).toBe("canceled");
    // not a cancel: other codes, a sign, a non-number, a value above 2^64−1, the second field
    expect(judgeGpg(2, st("[GNUPG:] ERROR x 100")).kind).toBe("failed");
    expect(judgeGpg(2, st("[GNUPG:] ERROR x +99")).kind).toBe("failed");
    expect(judgeGpg(2, st("[GNUPG:] ERROR x 99a")).kind).toBe("failed");
    expect(judgeGpg(2, st("[GNUPG:] ERROR x " + ((1n << 64n) + 99n).toString())).kind).toBe("failed");
    expect(judgeGpg(2, st("[GNUPG:] ERROR 99")).kind).toBe("failed");
    expect(judgeGpg(2, st("[GNUPG:] WARNING x 99")).kind).toBe("failed");
  });
});

describe("finding gpg", () => {
  const e = isolatedEnv("gpgfind");
  afterAll(() => e.cleanup());
  const bin = (name: string, files: string[]) => {
    const d = join(e.dir, name);
    mkdirSync(d, { recursive: true });
    for (const f of files) {
      writeFileSync(join(d, f), "#!/bin/sh\n");
      chmodSync(join(d, f), 0o755);
    }
    return d;
  };

  test("gpg2 first, else gpg; neither: the spec's message", () => {
    const both = bin("both", ["gpg", "gpg2"]);
    const only = bin("only", ["gpg"]);
    const none = bin("none", []);
    expect(findGpg({ PATH: both })).toBe(join(both, "gpg2"));
    expect(findGpg({ PATH: `${only}:${both}` })).toBe(join(both, "gpg2"));
    expect(findGpg({ PATH: only })).toBe(join(only, "gpg"));
    expect(() => findGpg({ PATH: none })).toThrow("gpg not found: import pass needs GnuPG (gpg) to decrypt the store");
    expect(() => findGpg({ PATH: "" })).toThrow("gpg not found");
  });

  test("a match through a relative $PATH entry isn't used", () => {
    const d = bin("rel", ["gpg2"]);
    symlinkSync(d, join(e.dir, "relbin"));
    const only = bin("only2", ["gpg"]);
    // `relbin` is relative: refused, so gpg from the absolute entry is used.
    const old = process.cwd();
    process.chdir(e.dir);
    try {
      expect(findGpg({ PATH: `relbin:${only}` })).toBe(join(only, "gpg"));
    } finally {
      process.chdir(old);
    }
  });
});
