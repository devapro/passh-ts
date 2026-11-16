// Unit tests for the key layer: key block (vault-format §3.2), data block (§3.3), paper
// recovery key (§3.6), passphrase strength (§3.5).

import { describe, expect, test } from "bun:test";
import {
  dataHeaderOpensWith,
  decryptData,
  encryptData,
  formatRecoveryKey,
  generateVaultKey,
  KeyErrorCode,
  keyBlockDigest,
  parseIdentityFile,
  parseRecoveryKey,
  passphraseStrength,
  unwrapKeyBlock,
  weakPassphraseWarning,
  wrapKeyBlock,
  X25519Identity,
} from "./index.ts";
import { armorText, encryptWithPassphrase, parseHeader, sha256Bytes } from "../age/index.ts";
import { encodeHeader } from "../age/header.ts";
import { x25519Base } from "../age/primitives.ts";
import { errorText, hasCode } from "../i18n/index.ts";

const te = new TextEncoder();
const td = new TextDecoder();
const PW = te.encode("correct horse battery staple x");

async function failure(f: () => Promise<unknown>): Promise<string[]> {
  try {
    await f();
  } catch (e) {
    const code = Object.values(KeyErrorCode).find((c) => hasCode(e, c)) ?? "?";
    return [code, errorText(e)];
  }
  return ["ok", ""];
}

function failureSync(f: () => unknown): string[] {
  try {
    f();
  } catch (e) {
    const code = Object.values(KeyErrorCode).find((c) => hasCode(e, c)) ?? "?";
    return [code, errorText(e)];
  }
  return ["ok", ""];
}

/** A key block with the scrypt stanza's arguments replaced (the MAC no longer matches). */
function withScryptArgs(keyBlock: Uint8Array, args: string[]): Uint8Array {
  const h = parseHeader(keyBlock);
  const header = encodeHeader([{ ...h.stanzas[0]!, args }], new Uint8Array(16));
  return Uint8Array.from([...header, ...keyBlock.subarray(h.payloadOffset)]);
}

const WRONG = ["wrong-passphrase", "wrong passphrase, or the key block is damaged"];
const BAD_BLOCK = ["bad-key-block", "the key block is damaged: it doesn't hold exactly one vault key"];

describe("key block (§3.2)", () => {
  test("written at 2^18: 257 bytes, armored 5×64 + 24, opens with the passphrase", async () => {
    const id = generateVaultKey();
    const kb = await wrapKeyBlock(id, PW);
    expect(kb.length).toBe(257);
    const h = parseHeader(kb);
    expect(h.payloadOffset).toBe(150);
    expect(h.stanzas.length).toBe(1);
    expect(h.stanzas[0]!.type).toBe("scrypt");
    expect(h.stanzas[0]!.args[1]).toBe("18");
    expect(h.stanzas[0]!.args[0]!.length).toBe(22);
    const lines = armorText(kb).split("\n").slice(1, -2);
    expect(lines.map((l) => l.length)).toEqual([64, 64, 64, 64, 64, 24]);
    expect(armorText(kb).split("\n")[1]!.startsWith("YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+I")).toBe(true);
    const t = performance.now();
    const back = await unwrapKeyBlock(kb, PW);
    const ms = performance.now() - t;
    expect(back.equals(id)).toBe(true);
    console.log(`scrypt 2^18 unwrap: ${ms.toFixed(0)} ms`);
    // A fresh salt every time.
    const kb2 = await wrapKeyBlock(id, PW);
    expect(Buffer.from(kb2).equals(Buffer.from(kb))).toBe(false);
  }, 20_000);

  test("step 1: empty passphrase, before anything else", async () => {
    const kb = await wrapKeyBlock(generateVaultKey(), PW, 10);
    expect(await failure(() => unwrapKeyBlock(kb, new Uint8Array(0)))).toEqual(["empty-passphrase", "passphrase is empty"]);
    expect(await failure(() => unwrapKeyBlock(withScryptArgs(kb, ["AAAAAAAAAAAAAAAAAAAAAA", "19"]), new Uint8Array(0)))).toEqual([
      "empty-passphrase",
      "passphrase is empty",
    ]);
  });

  test("steps 2 and 3: work factors", async () => {
    const kb = await wrapKeyBlock(generateVaultKey(), PW, 10);
    const salt = parseHeader(kb).stanzas[0]!.args[0]!;
    const wf = (n: string) =>
      `key block asks for scrypt work factor 2^${n}; passh uses 2^18: the file is damaged or not made by passh`;
    const cases: Array<[string, string[]]> = [
      ["19", ["work-factor", wf("19")]],
      ["+19", ["work-factor", wf("19")]],
      ["019", ["work-factor", wf("19")]],
      ["40", ["work-factor", wf("40")]],
      ["9223372036854775807", ["work-factor", wf("9223372036854775807")]],
      ["9223372036854775808", WRONG],
      ["99999999999999999999", WRONG],
      ["018", WRONG],
      ["+18", WRONG],
      ["0", WRONG],
      ["-5", WRONG],
      ["-19", WRONG],
      ["abc", WRONG],
      ["1e1", WRONG],
    ];
    for (const [arg, want] of cases) {
      const t = performance.now();
      expect([arg, ...(await failure(() => unwrapKeyBlock(withScryptArgs(kb, [salt, arg]), PW)))]).toEqual([arg, ...want]);
      // Refused before any scrypt work (2^18 would take ~0.6 s).
      expect(performance.now() - t).toBeLessThan(150);
    }
    // A bad salt is step 3 too.
    expect(await failure(() => unwrapKeyBlock(withScryptArgs(kb, [salt.slice(0, 21), "10"]), PW))).toEqual(WRONG);
    expect(await failure(() => unwrapKeyBlock(withScryptArgs(kb, ["!!", "abc"]), PW))).toEqual(WRONG);
    // The work factor of a non-canonical but valid value with a changed MAC: wrong passphrase.
    expect(await failure(() => unwrapKeyBlock(withScryptArgs(kb, [salt, "10"]), PW))).toEqual(WRONG);
  });

  test("step 3: wrong passphrase, damage", async () => {
    const kb = await wrapKeyBlock(generateVaultKey(), PW, 10);
    expect(await failure(() => unwrapKeyBlock(kb, te.encode("correct horse battery staple X")))).toEqual(WRONG);
    // passphrase bytes are exact: no trimming
    expect(await failure(() => unwrapKeyBlock(kb, te.encode(" correct horse battery staple x")))).toEqual(WRONG);
    for (const i of [60, 120, 160, 200, 256]) {
      const d = Uint8Array.from(kb);
      d[i]! ^= 1;
      expect([i, ...(await failure(() => unwrapKeyBlock(d, PW)))]).toEqual([i, ...WRONG]);
    }
    expect(await failure(() => unwrapKeyBlock(kb.subarray(0, 200), PW))).toEqual(WRONG);
    expect(await failure(() => unwrapKeyBlock(new Uint8Array(10), PW))).toEqual(WRONG);
  });

  test("steps 4 and 5: the plaintext", async () => {
    const block = (s: string | Uint8Array) => encryptWithPassphrase(typeof s === "string" ? te.encode(s) : s, PW, 10);
    const id = generateVaultKey();
    const key = id.format();
    // An age-keygen identity file, with comments and CRLF.
    const keygen = `# created: 2026-11-16T12:00:00Z\r\n# public key: age1…\r\n${key}\r\n`;
    expect((await unwrapKeyBlock(await block(keygen), PW)).equals(id)).toBe(true);
    expect((await unwrapKeyBlock(await block(`\n\n#x\n${key}`), PW)).equals(id)).toBe(true);
    const bad = [
      "",
      "# only a comment\n",
      `${key}\n${key}\n`,
      `${key.toLowerCase()}\n`,
      ` ${key}\n`,
      `${key} \n`,
      `${key}\n \n`,
      `${key.slice(0, -1)}Q\n`,
      "AGE-SECRET-KEY-PQ-1XX76JRALNLXDMEW0CRK45QMCCH4X06SE84UN3VPM33W6HWDX0H3SK3ZQFR\n",
      `${key}\r\r\n`,
    ];
    for (const p of bad) expect([p, ...(await failure(async () => unwrapKeyBlock(await block(p), PW)))]).toEqual([p, ...BAD_BLOCK]);
    // 4096 bytes are fine as long as they hold one key; 4097 are not.
    const pad = (n: number) => "#".repeat(n - key.length - 2) + "\n" + key + "\n";
    expect((await unwrapKeyBlock(await block(pad(4096)), PW)).equals(id)).toBe(true);
    expect(await failure(async () => unwrapKeyBlock(await block(pad(4097)), PW))).toEqual(BAD_BLOCK);
    expect(await failure(async () => unwrapKeyBlock(await block(new Uint8Array(70000)), PW))).toEqual(BAD_BLOCK);
  });

  test("parseIdentityFile", () => {
    const id = generateVaultKey();
    expect(parseIdentityFile(te.encode(id.format() + "\n")).equals(id)).toBe(true);
    expect(failureSync(() => parseIdentityFile(te.encode("x")))).toEqual(BAD_BLOCK);
  });

  test("keyBlockDigest: lower-case hex SHA-256 of the binary block", async () => {
    const kb = await wrapKeyBlock(generateVaultKey(), PW, 10);
    expect(keyBlockDigest(kb)).toBe(Buffer.from(sha256Bytes(kb)).toString("hex"));
    expect(keyBlockDigest(kb)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("data block (§3.3)", () => {
  const json = te.encode('{"format":"passh-vault-data","version":1}\n');

  test("round trip; size; one X25519 stanza; no recipient in the block (S9)", () => {
    const id = generateVaultKey();
    const block = encryptData(json, id);
    expect(block.length).toBe(168 + 16 + json.length + 16);
    const h = parseHeader(block);
    expect(h.stanzas.length).toBe(1);
    expect(h.stanzas[0]!.type).toBe("X25519");
    expect(decryptData(block, id, "passphrase")).toEqual(json);
    const point = x25519Base(id.secretBytes());
    expect(Buffer.from(block).includes(Buffer.from(point))).toBe(false);
    expect(armorText(block).includes("age1")).toBe(false);
    // A fresh file key every time.
    expect(Buffer.from(encryptData(json, id)).equals(Buffer.from(block))).toBe(false);
    expect(encryptData(new Uint8Array(194), id).length).toBe(394);
  });

  test("failures by key source", () => {
    const id = generateVaultKey();
    const other = generateVaultKey();
    const block = encryptData(json, id);
    const notToKey = "data is damaged; restore a backup (the data block isn't encrypted to this vault's key: damaged or replaced)";
    expect(failureSync(() => decryptData(block, other, "passphrase"))).toEqual(["data-not-to-key", notToKey]);
    expect(failureSync(() => decryptData(block, other, "agent"))).toEqual(["data-not-to-key", notToKey]);
    expect(failureSync(() => decryptData(block, other, "paper"))).toEqual([
      "wrong-recovery-key",
      "this key doesn't open this vault (rekeyed elsewhere? wrong recovery key?)",
    ]);
    const damaged = Uint8Array.from(block);
    damaged[damaged.length - 3]! ^= 1;
    for (const src of ["passphrase", "agent", "paper"] as const) {
      expect(failureSync(() => decryptData(damaged, id, src))).toEqual(["data-damaged", "data is damaged; restore a backup"]);
    }
    const mac = Uint8Array.from(block);
    mac[160]! = mac[160] === 0x41 ? 0x42 : 0x41; // inside the MAC's base64
    expect(failureSync(() => decryptData(mac, id, "passphrase"))[0]).toBe("data-damaged");
    expect(failureSync(() => decryptData(block.subarray(0, 100), id, "passphrase"))[0]).toBe("data-damaged");
  });

  test("dataHeaderOpensWith", () => {
    const id = generateVaultKey();
    const block = encryptData(json, id);
    expect(dataHeaderOpensWith(block, id)).toBe(true);
    expect(dataHeaderOpensWith(block, generateVaultKey())).toBe(false);
    expect(dataHeaderOpensWith(new Uint8Array(5), id)).toBe(false);
    const damaged = Uint8Array.from(block);
    damaged[damaged.length - 3]! ^= 1;
    expect(dataHeaderOpensWith(damaged, id)).toBe(true); // header only
  });
});

describe("paper recovery key (§3.6)", () => {
  test("layout", () => {
    const id = generateVaultKey();
    const sheet = formatRecoveryKey(id);
    const lines = sheet.split("\n");
    expect(lines[0]).toBe("AGE-SECRET-KEY-1");
    expect(lines.slice(1).map((l) => l.split(" ").map((g) => g.length))).toEqual([
      [4, 4, 4, 4, 4],
      [4, 4, 4, 4, 4],
      [4, 4, 4, 4, 2],
    ]);
    expect(sheet.endsWith("\n")).toBe(false);
    expect(sheet.replace(/[\s]/g, "").replace("AGE-SECRET-KEY-1", "AGE-SECRET-KEY-1")).toBe(id.format());
    expect(parseRecoveryKey(sheet).equals(id)).toBe(true);
  });

  test("normalization", () => {
    const id = generateVaultKey();
    const key = id.format();
    const rest = key.slice(16).toLowerCase();
    const groups = rest.match(/.{1,4}/g)!;
    const variants = [
      key,
      key.toLowerCase(),
      `age secret key 1 ${groups.join("-")}`,
      `AGE-SECRET-KEY-1\r\n${groups.join(" ")}\r\n`,
      `\tage-secret-key-1 ${groups.join("　")} `,
      `a-g-e-s-e-c-r-e-t-k-e-y-1${rest}`,
      `  ${key.slice(0, 30)}\n\n${key.slice(30)}  `,
    ];
    for (const v of variants) expect(parseRecoveryKey(v).equals(id)).toBe(true);
    expect(parseRecoveryKey(te.encode(variants[2]!)).equals(id)).toBe(true);
  });

  const err = (typed: string | Uint8Array) => failureSync(() => parseRecoveryKey(typed));

  test("errors, in order", () => {
    const key = generateVaultKey().format();
    const rest = key.slice(16);
    expect(err("")).toEqual(["recovery-key-empty", "not a valid recovery key: nothing was typed"]);
    expect(err(" -\n\t- ")).toEqual(["recovery-key-empty", "not a valid recovery key: nothing was typed"]);
    const prefix = ["bad-recovery-key", "not a valid recovery key: it must start with AGE-SECRET-KEY-1"];
    expect(err(rest)).toEqual(prefix);
    expect(err("AGE-SECRET-KEY-2" + rest)).toEqual(prefix);
    expect(err("AGE-SECRET-KEY-PQ-1" + rest)).toEqual(prefix);
    expect(err("AGE-SECRET")).toEqual(prefix);
    expect(err("XAGE-SECRET-KEY-1" + rest)).toEqual(prefix);
    const charErr = (g: number, c: number) => [
      "bad-recovery-key",
      `not a valid recovery key: group ${g}, character ${c} is not used in keys (B, I, O and 1 never appear after AGE-SECRET-KEY-1)`,
    ];
    expect(err("AGE-SECRET-KEY-1B" + rest.slice(1))).toEqual(charErr(1, 1));
    expect(err("AGE-SECRET-KEY-1" + rest.slice(0, 5) + "i" + rest.slice(6))).toEqual(charErr(2, 2));
    expect(err("AGE-SECRET-KEY-1" + rest.slice(0, 11) + "O" + rest.slice(12))).toEqual(charErr(3, 4));
    expect(err("AGE-SECRET-KEY-1" + rest.slice(0, 56) + "1" + rest.slice(57))).toEqual(charErr(15, 1));
    expect(err("AGE-SECRET-KEY-1" + rest.slice(0, 8) + "é" + rest.slice(9))).toEqual(charErr(3, 1));
    expect(err(Uint8Array.from([...te.encode("AGE-SECRET-KEY-1" + rest.slice(0, 2)), 0xff, ...te.encode(rest.slice(3))]))).toEqual(charErr(1, 3));
    // a bad character beyond 58 is still reported by position, before the count
    expect(err("AGE-SECRET-KEY-1" + rest + "QQB")).toEqual(charErr(16, 1));
    const count = (n: number) => [
      "bad-recovery-key",
      `not a valid recovery key: it has ${n} characters after AGE-SECRET-KEY-1 instead of 58; a character is missing or extra`,
    ];
    expect(err("AGE-SECRET-KEY-1" + rest.slice(1))).toEqual(count(57));
    expect(err("AGE-SECRET-KEY-1" + rest + "Q")).toEqual(count(59));
    expect(err("AGE-SECRET-KEY-1")).toEqual(count(0));
    // the fake key of vault-format §7.3
    expect(err("AGE-SECRET-KEY-1\nQPZR Y9X8 GF2T VDW0 S3JN\n54KH CE6M UA7L QPZR Y9X8\nGF2T VDW0 S3JN 54KH CE")).toEqual([
      "bad-recovery-key",
      "recovery key has a typo (checksum mismatch)",
    ]);
  });

  test("every single substitution and neighbour swap fails the checksum", () => {
    const CHARSET = "QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L";
    const typo = ["bad-recovery-key", "recovery key has a typo (checksum mismatch)"];
    for (let k = 0; k < 3; k++) {
      const key = generateVaultKey().format();
      const rest = key.slice(16);
      let n = 0;
      for (let i = 0; i < 58; i++) {
        for (const c of CHARSET) {
          if (c === rest[i]) continue;
          const v = rest.slice(0, i) + c + rest.slice(i + 1);
          expect(err("AGE-SECRET-KEY-1" + v)).toEqual(typo);
          n++;
        }
      }
      expect(n).toBe(58 * 31);
      for (let i = 0; i < 57; i++) {
        if (rest[i] === rest[i + 1]) continue;
        const v = rest.slice(0, i) + rest[i + 1] + rest[i] + rest.slice(i + 2);
        expect(err("AGE-SECRET-KEY-1" + v)).toEqual(typo);
      }
    }
  });
});

describe("passphrase strength (§3.5)", () => {
  const inputs = ["passh", "vault", "tester", "myhost"];
  const reason = (pw: string | Uint8Array) => {
    const s = passphraseStrength(typeof pw === "string" ? te.encode(pw) : pw, inputs);
    return s.score >= 3 ? "OK" : (s.reason ?? "");
  };

  test("reasons as the reference words them", () => {
    const want: Record<string, string> = {
      password: "this is a top-10 common password",
      asdfgh: "this is a top-100 common password",
      Password1: "this is a very common password",
      "p@ssw0rd": "this is similar to a commonly used password",
      correct: "a word by itself is easy to guess",
      correcthorse: "common words are easy to guess",
      john: "names and surnames by themselves are easy to guess",
      johnsmith: "common names and surnames are easy to guess",
      zxcvfr: "short keyboard patterns are easy to guess",
      aaaaaa: 'repeats like "aaa" are easy to guess',
      abcabcabc: 'repeats like "abcabcabc" are only slightly harder to guess than "abc"',
      abcdef: "sequences like abc or 6543 are easy to guess",
      "1990": "recent years are easy to guess",
      "12/05/1990": "dates are often easy to guess",
      a: "",
      tester: "",
      myhost: "",
      "correct horse battery staple x": "OK",
    };
    for (const [pw, r] of Object.entries(want)) expect([pw, reason(pw)]).toEqual([pw, r]);
  });

  test("first 100 code points; invalid UTF-8 counts as one", () => {
    expect(reason("a".repeat(100) + " correct horse battery staple x")).not.toBe("OK");
    expect(reason("correct horse battery staple x")).toBe("OK");
    expect(reason(Uint8Array.from([0xff, 0xfe, ...te.encode("correct horse battery staple")]))).toBe("OK");
  });

  test("the warning line", () => {
    expect(weakPassphraseWarning(te.encode("password"), inputs)).toBe("warning: weak passphrase: this is a top-10 common password; use 6 or more random words");
    expect(weakPassphraseWarning(te.encode("Zz"), inputs)).toBe("warning: weak passphrase; use 6 or more random words");
    expect(weakPassphraseWarning(te.encode("correct horse battery staple x"), inputs)).toBeNull();
  });
});

test("X25519Identity: S9 — no text form of the recipient", () => {
  const id = generateVaultKey();
  const r = id.stanzaRecipient() as unknown as Record<string, unknown>;
  expect(String(r)).not.toContain("age1");
  expect(JSON.stringify(id)).not.toContain("AGE-SECRET");
  expect(Object.keys(id)).toEqual([]);
  expect(X25519Identity.parse(id.format()).equals(id)).toBe(true);
  expect(td.decode(id.encode())).toBe(id.format());
  // String conversion and inspection never show the key.
  expect(String(id)).toBe("[X25519Identity]");
  expect(`${id}`).not.toContain("AGE-SECRET");
  expect(Bun.inspect(id)).not.toContain("AGE-SECRET");
  expect(Bun.inspect({ key: id })).not.toContain("AGE-SECRET");
});
