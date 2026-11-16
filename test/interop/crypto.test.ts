// Interop of the crypto layer (src/age, src/keys, src/vaultfile) with the reference
// implementation (reference/passh-go, run as a black box) and with the stock age tool
// (tmp/age/age, age-keygen: v1.3.x release binaries; the tests that need them skip
// without them).
//
//   a. a vault made by passh-go opens with our code;
//   b. a vault we build opens in passh-go (passphrase, `verify --full`, `show`, and
//      `recover` with our paper key);
//   c. container parse parity: `passh-go verify` and parseContainer agree on every
//      lenient variant and every error of vault-format §2.2–§2.3;
//   d. key block work factors and damage: the same messages as passh-go (§3.2);
//   e. a data block to another key (§3.3);
//   f. stock age: the §8 recovery commands (passphrase and paper key) on both vaults, and
//      `export --age`-style encryption to age-keygen X25519 and -pq recipients;
//      stock-age files decrypt with our code.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isolatedEnv, REF_BIN, ROOT, run, writeConfig, type IsolatedEnv } from "../helpers/env.ts";
import { initVault, PASS, withPassphrase } from "../helpers/passh.ts";
import { spawnPty } from "../helpers/pty.ts";
import { armorText, decrypt, decryptWithPassphrase, dearmor, encryptArmored, parseExportRecipient, parseHeader, X25519Identity } from "../../src/age/index.ts";
import { encodeHeader } from "../../src/age/header.ts";
import {
  decryptData,
  encryptData,
  errDataNotToKey,
  formatRecoveryKey,
  generateVaultKey,
  keyBlockDigest,
  unwrapKeyBlock,
  wrapKeyBlock,
} from "../../src/keys/index.ts";
import { encodeContainer, parseContainer } from "../../src/vaultfile/index.ts";
import { errorText } from "../../src/i18n/index.ts";

const AGE = join(ROOT, "tmp/age/age");
const AGE_KEYGEN = join(ROOT, "tmp/age/age-keygen");
const haveAge = existsSync(AGE) && existsSync(AGE_KEYGEN);
const haveRef = existsSync(REF_BIN);
if (!haveAge) console.warn("crypto interop: tmp/age/age and age-keygen not found; the stock-age tests are skipped");

const te = new TextEncoder();
const td = new TextDecoder();
const latin1 = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));

const envs: IsolatedEnv[] = [];
function env(name: string): IsolatedEnv {
  const e = isolatedEnv(name);
  envs.push(e);
  return e;
}
afterAll(() => {
  for (const e of envs) e.cleanup();
});

/** Writes a vault file where the reference expects it (mode 0600) and a config naming it. */
async function placeVault(e: IsolatedEnv, bytes: Uint8Array): Promise<void> {
  mkdirSync(dirname(e.vault), { recursive: true, mode: 0o700 });
  writeFileSync(e.vault, bytes, { mode: 0o600 });
  chmodSync(e.vault, 0o600);
  await writeConfig(e);
}

/** Data JSON as passh writes it (vault-format §4.6, §7.2). */
function dataJson(revision: number, entries: Array<{ path: string; password: string; tags?: string[] }>): Uint8Array {
  const t = "2026-11-15T12:00:00Z";
  const d = {
    format: "passh-vault-data",
    version: 1,
    vault_id: "0f6c1d2e-0000-4000-8000-000000000001",
    revision,
    saved_at: t,
    entries: entries.map((x, i) => ({
      id: `8d1e7a90-0000-4000-8000-00000000000${i + 2}`,
      path: x.path,
      password: x.password,
      username: "",
      url: "",
      tags: x.tags ?? [],
      fields: [],
      notes: "",
      created_at: t,
      updated_at: t,
    })),
    deleted: [],
  };
  return te.encode(JSON.stringify(d, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Shared vaults: one made by passh-go, one made by us.

let refEnv: IsolatedEnv;
let refVault: Uint8Array;
let ourEnv: IsolatedEnv;
let ourId: X25519Identity;
let ourVault: Uint8Array;
let ourJson: Uint8Array;

beforeAll(async () => {
  if (!haveRef) return;
  refEnv = env("cry-ref");
  await initVault([REF_BIN], refEnv);
  for (const [path, len] of [
    ["work/github", "20"],
    ["personal/mail", "32"],
  ]) {
    const r = await withPassphrase([REF_BIN], ["generate", path!, len!], refEnv);
    if (r.code !== 0) throw new Error(`generate failed: ${r.tty}`);
  }
  refVault = new Uint8Array(readFileSync(refEnv.vault));

  ourEnv = env("cry-our");
  ourId = generateVaultKey();
  ourJson = dataJson(1, [
    { path: "work/github", password: "s3cr3t-P@ss", tags: ["work", "2fa"] },
    { path: "bank/My Bank", password: "hunter2" },
  ]);
  const kb = await wrapKeyBlock(ourId, te.encode(PASS));
  ourVault = encodeContainer(kb, encryptData(ourJson, ourId));
  await placeVault(ourEnv, ourVault);
}, 120_000);

describe.skipIf(!haveRef)("passh-go ↔ ours", () => {
  test("a. a passh-go vault opens with our code", async () => {
    const c = parseContainer(refVault);
    expect(c.canonical).toBe(true);
    expect(c.warnings).toEqual([]);
    expect(c.keyBlock.length).toBe(257);
    expect(Buffer.from(encodeContainer(c.keyBlock, c.dataBlock)).equals(Buffer.from(refVault))).toBe(true);
    const id = await unwrapKeyBlock(c.keyBlock, te.encode(PASS));
    const data = JSON.parse(td.decode(decryptData(c.dataBlock, id, "passphrase")));
    expect(data.format).toBe("passh-vault-data");
    expect(data.version).toBe(1);
    expect(data.revision).toBe(3);
    expect(data.entries.map((x: { path: string }) => x.path).sort()).toEqual(["personal/mail", "work/github"]);
    expect(data.entries.find((x: { path: string }) => x.path === "personal/mail").password.length).toBe(32);
    // S9: no age1… recipient anywhere in the file
    expect(td.decode(refVault).includes("age1")).toBe(false);
    expect(keyBlockDigest(c.keyBlock)).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  test("b. our vault opens in passh-go: verify --full, show", async () => {
    let r = await withPassphrase([REF_BIN], ["verify", "--full"], ourEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(": OK\n");
    expect(r.stdout).toMatch(/revision +1\n/);
    expect(r.stdout).toMatch(/entries +2\n/);
    expect(r.stdout).toContain("0f6c1d2e-0000-4000-8000-000000000001");
    r = await withPassphrase([REF_BIN], ["show", "bank/My Bank", "--field", "password"], ourEnv);
    expect(r.code).toBe(0);
    expect(r.stdout.replace(/\n$/, "")).toBe("hunter2"); // final newline: cli.md show --field
    // passh-go's verify (no key) on our file: canonical, no notes
    const v = await run([REF_BIN, "verify", ourEnv.vault], ourEnv.env);
    expect(v.code).toBe(0);
    expect(v.stderr).toBe("");
  }, 60_000);

  test("b. passh-go recover with our paper key, then we open the result", async () => {
    const e = env("cry-rec");
    await placeVault(e, ourVault);
    const p = spawnPty([REF_BIN, "recover"], e.env);
    await p.expect("> ");
    for (const line of formatRecoveryKey(ourId).split("\n")) {
      p.line(line.toLowerCase());
      await p.expect("> ");
    }
    p.line("");
    await p.expect("The recovery key opens the vault. Choose a new passphrase.", 30_000);
    const newPass = "a completely different passphrase here";
    await p.expect("New passphrase: ");
    p.line(newPass);
    await p.expect("Repeat passphrase: ");
    p.line(newPass);
    const res = await p.wait(60_000);
    expect(res.code).toBe(0);
    expect(res.output).toContain("The paper recovery key stays valid.");
    const c = parseContainer(new Uint8Array(readFileSync(e.vault)));
    const id = await unwrapKeyBlock(c.keyBlock, te.encode(newPass));
    expect(id.equals(ourId)).toBe(true);
    const data = JSON.parse(td.decode(decryptData(c.dataBlock, id, "passphrase")));
    expect(data.revision).toBe(2);
    await expect(unwrapKeyBlock(c.keyBlock, te.encode(PASS))).rejects.toThrow("wrong passphrase, or the key block is damaged");
  }, 90_000);

  test("e. a data block to another key: same message as passh-go", async () => {
    const e = env("cry-oth");
    const c = parseContainer(ourVault);
    const other = encryptData(ourJson, generateVaultKey());
    await placeVault(e, encodeContainer(c.keyBlock, other));
    const r = await withPassphrase([REF_BIN], ["ls"], e);
    expect(r.code).toBe(1);
    const ours = errorText(errDataNotToKey());
    expect(r.tty).toContain(`${e.vault}: ${ours}`);
    expect(() => decryptData(other, ourId, "passphrase")).toThrow(ours);
  }, 60_000);

  test("e. malformed X25519 stanzas, damaged payload: same messages as passh-go", async () => {
    const e = env("cry-stz");
    const c = parseContainer(ourVault);
    const h = parseHeader(c.dataBlock);
    const payload = c.dataBlock.subarray(h.payloadOffset);
    const other = parseHeader(encryptData(ourJson, generateVaultKey())).stanzas[0]!;
    const withStanzas = (st: Parameters<typeof encodeHeader>[0]) => Uint8Array.from([...encodeHeader(st, new Uint8Array(16)), ...payload]);
    const damagedPayload = Uint8Array.from(c.dataBlock);
    damagedPayload[damagedPayload.length - 2]! ^= 1;
    const cases: Array<[string, Uint8Array]> = [
      ["arg of 3 bytes", withStanzas([{ ...h.stanzas[0]!, args: ["AAAA"] }])],
      ["body of 31 bytes", withStanzas([{ ...h.stanzas[0]!, body: h.stanzas[0]!.body.subarray(0, 31) }])],
      ["another key, then a malformed stanza", withStanzas([other, { ...h.stanzas[0]!, args: ["AAAA"] }])],
      ["another key, then ours: MAC mismatch", withStanzas([other, h.stanzas[0]!])],
      ["an unknown stanza and another key", withStanzas([{ type: "x", args: [], body: new Uint8Array(0) }, other])],
      ["damaged payload", damagedPayload],
    ];
    for (const [name, block] of cases) {
      await placeVault(e, encodeContainer(c.keyBlock, block));
      const r = await withPassphrase([REF_BIN], ["ls"], e);
      let ours = "";
      try {
        decryptData(block, ourId, "passphrase");
      } catch (err) {
        ours = errorText(err);
      }
      expect(ours).not.toBe("");
      const line = r.tty.split("\r\n").find((l) => l.startsWith(`passh: ${e.vault}: `)) ?? r.tty;
      expect([name, line]).toEqual([name, `passh: ${e.vault}: ${ours}`]);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// c. Container parse parity with `passh-go verify`.

/** Our verdict: ["OK", notes…] or ["FAILED", message]. */
function ourVerify(bytes: Uint8Array): string[] {
  try {
    const c = parseContainer(bytes);
    const notes = c.warnings.map((w) => `note: ${w.message}`);
    if (!c.canonical) notes.push("note: the file isn't in passh's canonical form");
    return ["OK", ...notes];
  } catch (e) {
    return ["FAILED", errorText(e)];
  }
}

async function refVerify(e: IsolatedEnv, file: string): Promise<string[]> {
  const r = await run([REF_BIN, "verify", file], e.env);
  const status = r.stdout.split("\n")[0]!.endsWith(": OK") ? "OK" : "FAILED";
  const lines = r.stderr.split("\n").filter((l) => l !== "");
  if (status === "OK") {
    return [
      "OK",
      ...lines.map((l) => {
        const s = l.replace(/^passh: /, "");
        return s.startsWith("note: the file isn't in passh's canonical form") ? "note: the file isn't in passh's canonical form" : s;
      }),
    ];
  }
  const prefix = `passh: ${file}: `;
  expect(lines[0]!.startsWith(prefix)).toBe(true);
  return ["FAILED", lines[0]!.slice(prefix.length)];
}

/** The block with its header text changed by f (the payload kept). */
function rawHeader(block: Uint8Array, f: (text: string) => string): Uint8Array {
  const h = parseHeader(block);
  const text = Buffer.from(block.subarray(0, h.payloadOffset)).toString("latin1");
  return Uint8Array.from([...latin1(f(text)), ...block.subarray(h.payloadOffset)]);
}

/** The block with an extra stanza that makes its header exactly `size` bytes. */
function headerOfSize(block: Uint8Array, size: number): Uint8Array {
  const h = parseHeader(block);
  const make = (bodyLen: number, argLen: number) =>
    encodeHeader([...h.stanzas, { type: "x", args: ["a".repeat(argLen)], body: new Uint8Array(bodyLen) }], new Uint8Array(16));
  const base = make(0, 1).length;
  const body = Math.floor((size - base - 100) / 65) * 48;
  const arg = 1 + size - make(body, 1).length;
  const hdr = make(body, arg);
  if (hdr.length !== size) throw new Error(`header of ${hdr.length} bytes, wanted ${size}`);
  return Uint8Array.from([...hdr, ...block.subarray(h.payloadOffset)]);
}

function variants(vault: string): Array<[string, string]> {
  const lines = vault.split("\n");
  const BEGIN = "-----BEGIN AGE ENCRYPTED FILE-----";
  const END = "-----END AGE ENCRYPTED FILE-----";
  const c = parseContainer(latin1(vault));
  const k = Buffer.from(c.keyBlock).toString("base64");
  const d = Buffer.from(c.dataBlock).toString("base64");
  const kArm = armorText(c.keyBlock);
  const dArm = armorText(c.dataBlock);
  const wrap = (b: string, w: number) => b.match(new RegExp(`.{1,${w}}`, "g"))!.join("\n");
  const withKey = (kb: Uint8Array) => "passh-vault 1\n" + armorText(kb) + dArm;
  const withData = (db: Uint8Array) => "passh-vault 1\n" + kArm + armorText(db);
  const dmg = (b: Uint8Array, i: number, v: number) => {
    const x = Uint8Array.from(b);
    x[i] = v;
    return x;
  };
  const restanza = (b: Uint8Array, f: (h: ReturnType<typeof parseHeader>) => Parameters<typeof encodeHeader>[0]) => {
    const h = parseHeader(b);
    return Uint8Array.from([...encodeHeader(f(h), new Uint8Array(16)), ...b.subarray(h.payloadOffset)]);
  };
  const hdr = parseHeader(c.dataBlock);
  return [
    ["canonical", vault],
    ["CRLF", vault.replaceAll("\n", "\r\n")],
    ["CR", vault.replaceAll("\n", "\r")],
    ["mixed endings", lines.map((l, i) => l + ["\n", "\r\n", "\r"][i % 3]).join("")],
    ["BOM", "\xef\xbb\xbf" + vault],
    ["indented", lines.map((l) => (l ? "  \t" + l + "  " : l)).join("\n")],
    ["NBSP and U+3000 around lines", lines.map((l) => (l ? "\xc2\xa0" + l + "\xe3\x80\x80" : l)).join("\n")],
    ["blank lines", "\n\n" + vault.replaceAll("\n", "\n \n") + "\n\n"],
    ["re-wrapped 76", `passh-vault 1\n${BEGIN}\n${wrap(k, 76)}\n${END}\n${BEGIN}\n${wrap(d, 76)}\n${END}\n`],
    ["re-wrapped 7", `passh-vault 1\n${BEGIN}\n${wrap(k, 7)}\n${END}\n${BEGIN}\n${wrap(d, 7)}\n${END}\n`],
    ["one long line", `passh-vault 1\n${BEGIN}\n${k}\n${END}\n${BEGIN}\n${d}\n${END}`],
    ["no final newline", vault.slice(0, -1)],
    ["text around", "Hi,\nmy vault:\n\n" + vault + "\nbye\n"],
    ["one line around", "x\n" + vault + "y"],
    ["two vaults", vault + vault],
    ["magic with tabs and zeros", vault.replace("passh-vault 1", "passh-vault\t \t0001")],
    ["empty", ""],
    ["white space only", " \r\n\t\n"],
    ["prefix of magic", "passh-vau"],
    ["magic word only", "  passh-vault \n"],
    ["not a vault", "hello\nworld\n"],
    ["upper-case magic", vault.replace("passh-vault", "PASSH-VAULT")],
    ["version 2", vault.replace("passh-vault 1", "passh-vault 2")],
    ["version huge", "passh-vault 123456789012345678901234567890\n"],
    ["version 0", vault.replace("passh-vault 1", "passh-vault 0")],
    ["magic only", "passh-vault 1\n"],
    ["BEGIN cut", "passh-vault 1\n-----BEGIN AGE ENCR\n\n"],
    ["BEGIN cut then text", "passh-vault 1\n-----BEGIN AGE ENCR\nxyz\n"],
    ["text before block 1", "passh-vault 1\nhello\n" + kArm + dArm],
    ["damaged BEGIN", vault.replace(BEGIN, "-----BEGIN AGE ENCRYPTED FILE----")],
    ["no END, EOF", "passh-vault 1\n" + BEGIN + "\n" + k + "\n"],
    ["END missing before BEGIN", "passh-vault 1\n" + kArm.replace(END + "\n", "") + dArm],
    ["inner space", vault.replace(k.slice(0, 64), k.slice(0, 30) + " " + k.slice(30, 64))],
    ["bad char", vault.replace(k.slice(0, 64), k.slice(0, 30) + "!" + k.slice(31, 64))],
    ["missing padding", vault.replace("=\n-----END", "\n-----END")],
    ["empty block 1", "passh-vault 1\n" + BEGIN + "\n" + END + "\n" + dArm],
    ["block 2 missing", "passh-vault 1\n" + kArm],
    ["block 2 cut", "passh-vault 1\n" + kArm + "-----BEG"],
    ["text between blocks", "passh-vault 1\n" + kArm + "note\n" + dArm],
    ["block 2 no END", "passh-vault 1\n" + kArm + BEGIN + "\n" + d + "\n"],
    ["block 2 bad base64", "passh-vault 1\n" + kArm + BEGIN + "\n" + d + "*\n" + END + "\n"],
    ["key block header", withKey(dmg(c.keyBlock, 0, 0x62))],
    ["key block CR in header", withKey(dmg(c.keyBlock, 21, 0x0d))],
    ["key block is a data block", withKey(c.dataBlock)],
    ["key block scrypt !! abc", withKey(restanza(c.keyBlock, (h) => [{ ...h.stanzas[0]!, args: ["!!", "abc"] }]))],
    ["key block three args", withKey(restanza(c.keyBlock, (h) => [{ ...h.stanzas[0]!, args: ["a", "b", "c"] }]))],
    ["key block payload cut", withKey(c.keyBlock.subarray(0, 150 + 31))],
    ["data block scrypt", withData(c.keyBlock)],
    ["data block X25519 two args", withData(restanza(c.dataBlock, (h) => [{ ...h.stanzas[0]!, args: [h.stanzas[0]!.args[0]!, "x"] }]))],
    ["data block extra stanza type", withData(restanza(c.dataBlock, (h) => [...h.stanzas, { type: "Scrypt", args: [], body: new Uint8Array(0) }]))],
    ["data block 49-byte body", withData(restanza(c.dataBlock, (h) => [{ ...h.stanzas[0]!, body: new Uint8Array(49) }]))],
    ["data block payload +16", withData(Uint8Array.from([...c.dataBlock, ...new Uint8Array(16)]))],
    ["data block payload -1 of 32", withData(c.dataBlock.subarray(0, hdr.payloadOffset + 31))],
    ["data block MAC line damaged", withData(dmg(c.dataBlock, hdr.payloadOffset - 2, 0x2e))],
    // header rules 2 and 5: limits
    ["128 arguments", withData(restanza(c.dataBlock, (h) => [...h.stanzas, { type: "x", args: Array(128).fill("a"), body: new Uint8Array(0) }]))],
    ["129 arguments", withData(restanza(c.dataBlock, (h) => [...h.stanzas, { type: "x", args: Array(129).fill("a"), body: new Uint8Array(0) }]))],
    ["1024 stanzas", withData(restanza(c.dataBlock, (h) => [...h.stanzas, ...Array.from({ length: 1023 }, () => ({ type: "x", args: [], body: new Uint8Array(0) }))]))],
    ["1025 stanzas", withData(restanza(c.dataBlock, (h) => [...h.stanzas, ...Array.from({ length: 1024 }, () => ({ type: "x", args: [], body: new Uint8Array(0) }))]))],
    ["header of exactly 2 MiB", withData(headerOfSize(c.dataBlock, 2 * 1024 * 1024))],
    ["header of 2 MiB + 1", withData(headerOfSize(c.dataBlock, 2 * 1024 * 1024 + 1))],
    // raw header text: a body line decoding to more than 48 bytes, a CR in a body line
    ["68-character body line", withData(rawHeader(c.dataBlock, (t) => t.replace("\n---", "\n-> x\n" + "A".repeat(68) + "\n\n---")))],
    ["CR in a body line", withData(rawHeader(c.dataBlock, (t) => t.replace(/\n([A-Za-z0-9+/]{43})\n---/, "\n$1\r\n---")))],
    ["double space in a stanza line", withData(rawHeader(c.dataBlock, (t) => t.replace("-> X25519 ", "-> X25519  ")))],
  ];
}

describe.skipIf(!haveRef)("c. container parse parity with passh-go verify", () => {
  test("every variant", async () => {
    const e = env("cry-ver");
    const vault = Buffer.from(refVault).toString("latin1");
    let i = 0;
    for (const [name, content] of variants(vault)) {
      const file = join(e.dir, `v${i++}.passh`);
      writeFileSync(file, latin1(content));
      const ref = await refVerify(e, file);
      const ours = ourVerify(latin1(content));
      expect([name, ...ours]).toEqual([name, ...ref]);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// d. Key block work factors and damage.

describe.skipIf(!haveRef)("d. key block: same messages as passh-go", () => {
  test("work factors (§3.2 steps 2–3)", async () => {
    const e = env("cry-wf");
    const c = parseContainer(ourVault);
    const salt = parseHeader(c.keyBlock).stanzas[0]!.args[0]!;
    const withArg = (a: string) => {
      const h = parseHeader(c.keyBlock);
      return Uint8Array.from([...encodeHeader([{ ...h.stanzas[0]!, args: [salt, a] }], new Uint8Array(16)), ...c.keyBlock.subarray(h.payloadOffset)]);
    };
    for (const a of ["19", "+19", "019", "9223372036854775807", "99999999999999999999", "018", "+18", "0", "-5", "abc"]) {
      const kb = withArg(a);
      await placeVault(e, encodeContainer(kb, c.dataBlock));
      const r = await withPassphrase([REF_BIN], ["ls"], e);
      expect(r.code).toBe(1);
      let ours = "";
      try {
        await unwrapKeyBlock(kb, te.encode(PASS));
      } catch (err) {
        ours = errorText(err);
      }
      expect([a, r.tty]).toEqual([a, expect.stringContaining(`passh: ${e.vault}: ${ours}`)]);
    }
  }, 120_000);

  test("damaged key block payload and wrong passphrase", async () => {
    const e = env("cry-kb");
    const c = parseContainer(ourVault);
    const kb = Uint8Array.from(c.keyBlock);
    kb[200]! ^= 1;
    await placeVault(e, encodeContainer(kb, c.dataBlock));
    const r = await withPassphrase([REF_BIN], ["ls"], e);
    expect(r.code).toBe(1);
    await expect(unwrapKeyBlock(kb, te.encode(PASS))).rejects.toThrow("wrong passphrase, or the key block is damaged");
    expect(r.tty).toContain(`passh: ${e.vault}: wrong passphrase, or the key block is damaged`);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// f. Stock age.

/** The §8 commands that cut out the blocks, run literally with /bin/sh in `dir`. */
function cutBlocks(e: IsolatedEnv, dir: string): void {
  const cmd =
    `tr -d '\\r' < vault.passh | awk '/BEGIN AGE ENCRYPTED FILE/{n++} n==1{print} n==1 && /END AGE ENCRYPTED FILE/{exit}' > key.age\n` +
    `tr -d '\\r' < vault.passh | awk '/BEGIN AGE ENCRYPTED FILE/{n++} n==2{print} n==2 && /END AGE ENCRYPTED FILE/{exit}' > data.age\n`;
  const r = Bun.spawnSync(["/bin/sh", "-c", cmd], { cwd: dir, env: e.env });
  if (r.exitCode !== 0) throw new Error("cutting the blocks failed: " + r.stderr.toString());
}

/** `age -d -o <shm>/key.txt key.age`, the passphrase typed on the PTY. */
async function ageDecryptKey(e: IsolatedEnv, dir: string, passphrase: string): Promise<string> {
  const keyTxt = join(e.runtimeDir, "key.txt");
  const p = spawnPty([AGE, "-d", "-o", keyTxt, join(dir, "key.age")], e.env, { cwd: dir });
  await p.expect(/Enter passphrase: /);
  p.line(passphrase);
  const r = await p.wait(30_000);
  if (r.code !== 0) throw new Error("age -d failed: " + r.output);
  return keyTxt;
}

async function ageDecryptData(e: IsolatedEnv, dir: string, keyTxt: string): Promise<string> {
  const out = join(e.runtimeDir, "vault.json");
  const r = await run([AGE, "-d", "-i", keyTxt, "-o", out, join(dir, "data.age")], e.env);
  if (r.code !== 0) throw new Error("age -d -i failed: " + r.stderr);
  return readFileSync(out, "utf8");
}

describe.skipIf(!haveAge || !haveRef)("f. stock age", () => {
  for (const which of ["passh-go", "ours"] as const) {
    test(`§8 recovery commands on a ${which} vault: passphrase and paper key, LF and CRLF`, async () => {
      const e = env("cry-age");
      const vault = which === "passh-go" ? refVault : ourVault;
      const c = parseContainer(vault);
      const id = await unwrapKeyBlock(c.keyBlock, te.encode(PASS));
      const json = td.decode(decryptData(c.dataBlock, id, "passphrase"));
      for (const crlf of [false, true]) {
        const dir = join(e.dir, crlf ? "crlf" : "lf");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "vault.passh"), crlf ? Buffer.from(Buffer.from(vault).toString("latin1").replaceAll("\n", "\r\n"), "latin1") : vault);
        cutBlocks(e, dir);
        // with the passphrase
        const keyTxt = await ageDecryptKey(e, dir, PASS);
        expect(readFileSync(keyTxt, "utf8")).toBe(id.format() + "\n");
        expect(await ageDecryptData(e, dir, keyTxt)).toBe(json);
        // with the paper key: one line, no spaces, upper case (vault-format §8)
        writeFileSync(keyTxt, formatRecoveryKey(id).replace(/\s/g, "") + "\n", { mode: 0o600 });
        expect(await ageDecryptData(e, dir, keyTxt)).toBe(json);
        Bun.spawnSync(["rm", "-f", "--", keyTxt, join(e.runtimeDir, "vault.json")]);
      }
    }, 60_000);
  }

  test("--age encryption to age-keygen recipients (X25519 and -pq), armored", async () => {
    const e = env("cry-exp");
    for (const pq of [false, true]) {
      const keyFile = join(e.dir, pq ? "pq.txt" : "x.txt");
      const g = await run([AGE_KEYGEN, ...(pq ? ["-pq"] : []), "-o", keyFile], e.env);
      expect(g.code).toBe(0);
      const pub = readFileSync(keyFile, "utf8").match(/^# public key: (\S+)$/m)![1]!;
      expect(pub.startsWith(pq ? "age1pq1" : "age1")).toBe(true);
      const plaintext = te.encode(`{"exported": ${pq}}\n`);
      const out = encryptArmored(plaintext, parseExportRecipient(" " + pub + "\n"));
      const outFile = join(e.dir, pq ? "pq.age" : "x.age");
      writeFileSync(outFile, out);
      const text = Buffer.from(out).toString("latin1");
      expect(text.startsWith("-----BEGIN AGE ENCRYPTED FILE-----\n")).toBe(true);
      for (const l of text.split("\n").slice(1, -3)) expect(l.length).toBe(64);
      const r = await run([AGE, "-d", "-i", keyFile, outFile], e.env);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(td.decode(plaintext));
    }
  }, 60_000);

  test("files encrypted by stock age decrypt with our code", async () => {
    const e = env("cry-rev");
    const keyFile = join(e.dir, "k.txt");
    await run([AGE_KEYGEN, "-o", keyFile], e.env);
    const secret = readFileSync(keyFile, "utf8").match(/^AGE-SECRET-KEY-1\S+$/m)![0];
    const pub = readFileSync(keyFile, "utf8").match(/^# public key: (\S+)$/m)![1]!;
    const id = X25519Identity.parse(secret);
    const plain = join(e.dir, "plain.txt");
    writeFileSync(plain, "x".repeat(70000));
    for (const armor of [false, true]) {
      const out = join(e.dir, armor ? "a.age" : "b.age");
      const r = await run([AGE, "-e", "-r", pub, ...(armor ? ["-a"] : []), "-o", out, plain], e.env);
      expect(r.code).toBe(0);
      let bytes: Uint8Array = new Uint8Array(readFileSync(out));
      if (armor) bytes = dearmor(bytes)!;
      expect(td.decode(decrypt(bytes, id))).toBe("x".repeat(70000));
    }
    // A passphrase file from `age -p` (scrypt, work factor 18) opens with our scrypt code,
    // and a stock passphrase file is a valid key block when it holds a key.
    const keyAge = join(e.dir, "key.age");
    const p = spawnPty([AGE, "-p", "-a", "-o", keyAge, keyFile], e.env);
    await p.expect(/Enter passphrase.*: /);
    p.line(PASS);
    await p.expect(/Confirm passphrase: /);
    p.line(PASS);
    expect((await p.wait(30_000)).code).toBe(0);
    const kb = dearmor(new Uint8Array(readFileSync(keyAge)))!;
    expect(td.decode(await decryptWithPassphrase(kb, te.encode(PASS), { maxLogN: 18 }))).toBe(readFileSync(keyFile, "utf8"));
    expect((await unwrapKeyBlock(kb, te.encode(PASS))).equals(id)).toBe(true);
  }, 60_000);
});
