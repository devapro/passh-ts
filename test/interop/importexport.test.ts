// Interop of `import pass` and `export` (src/importpass, src/export) with the reference
// implementation (reference/passh-go, run as a black box).
//
//   a. export: a vault filled through passh-go (`add` on a PTY, `generate`, `tag`) and then
//      with crafted tricky data is exported by passh-go in every format (with --tag,
//      --folder, --spreadsheet-safe); our formatter fed the same data gives the same bytes
//      (`exported_at` taken from passh-go's output), and our runExport writes the same file
//      and the same stderr lines. `--age` output of both decrypts with stock age.
//   b. import: a real pass store (an isolated gpg home with a key without passphrase) with
//      tricky entries is imported by passh-go and by runImportPass into two copies of the
//      same vault: dry run, real run and --overwrite give byte-identical reports and equal
//      data (ids and timestamps aside).
//
// The comparisons run our code with `quirks: true` (passh v0.6's known issues reproduced);
// the proposed fixes (audit #6, #7, #8, #39) are checked separately where they differ.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, REF_BIN, ROOT, run, type IsolatedEnv } from "../helpers/env.ts";
import { initVault, PASS, withPassphrase } from "../helpers/passh.ts";
import { spawnPty } from "../helpers/pty.ts";
import { decryptData, encryptData, unwrapKeyBlock, type X25519Identity } from "../../src/keys/index.ts";
import { encodeContainer, parseContainer } from "../../src/vaultfile/index.ts";
import { addEntry, cloneVaultData, emptyContent, nowTime, parseTime, parseVaultData, serializeVaultData, type Entry, type Field, type VaultData } from "../../src/model/index.ts";
import { formatExport, runExport, selectEntries, type ExportFormat } from "../../src/export/index.ts";
import { runImportPass } from "../../src/importpass/index.ts";
import { captureIO } from "../../src/util/io.ts";
import type { OpenedVault } from "../../src/vault/types.ts";

setDefaultTimeout(180_000);

const te = new TextEncoder();
const td = new TextDecoder();
const AGE = join(ROOT, "tmp/age/age");
const AGE_KEYGEN = join(ROOT, "tmp/age/age-keygen");

let e: IsolatedEnv;
let identity: X25519Identity;
let keyBlock: Uint8Array;
let revision = 1000n;
let out: string;

beforeAll(async () => {
  e = isolatedEnv("impexp");
  await initVault([REF_BIN], e);
  const c = parseContainer(new Uint8Array(readFileSync(e.vault)));
  keyBlock = c.keyBlock;
  identity = await unwrapKeyBlock(keyBlock, te.encode(PASS));
  const u = await withPassphrase([REF_BIN], ["unlock"], e);
  if (u.code !== 0) throw new Error("unlock failed: " + u.tty);
  out = join(e.home, "out");
  mkdirSync(out);
});

afterAll(async () => {
  if (!e) return;
  await run([REF_BIN, "lock"], e.env);
  Bun.spawnSync(["gpgconf", "--kill", "gpg-agent"], { env: e.env });
  Bun.spawnSync(["gpgconf", "--kill", "gpg-agent"], { env: { ...e.env, GNUPGHOME: join(e.dir, "gnupg-other") } });
  e.cleanup();
});

const ref = (...args: string[]) => run([REF_BIN, ...args], e.env);

function readData(path = e.vault): VaultData {
  const c = parseContainer(new Uint8Array(readFileSync(path)));
  return parseVaultData(decryptData(c.dataBlock, identity, "agent"));
}

/** Writes data as the vault's data block at a revision above every earlier one. */
function writeData(d: VaultData, path = e.vault): VaultData {
  revision += 10n;
  const data = { ...d, revision };
  writeFileSync(path, encodeContainer(keyBlock, encryptData(serializeVaultData(data), identity)), { mode: 0o600 });
  return data;
}

/** An OpenedVault over a vault file: the data block decrypted with the key, saves written back. */
function fileVault(path: string): OpenedVault {
  let data = readData(path);
  const v = {
    path,
    get data() {
      return data;
    },
    async save(d: VaultData) {
      const next = { ...cloneVaultData(d), revision: data.revision + 1n, savedAt: nowTime() };
      writeFileSync(path, encodeContainer(keyBlock, encryptData(serializeVaultData(next), identity)), { mode: 0o600 });
      data = next;
    },
    close() {},
  };
  return v as unknown as OpenedVault;
}

/** passh-go `add` on a PTY (the agent serves the key). */
async function refAdd(path: string, pw: string, user: string, url: string, tags: string, notes: string[]): Promise<void> {
  const p = spawnPty([REF_BIN, "add", path], e.env);
  await p.expect("Password (empty to generate): ");
  p.line(pw);
  if (pw !== "") {
    await p.expect("Repeat password: ");
    p.line(pw);
  }
  await p.expect("Username: ");
  p.line(user);
  await p.expect("URL: ");
  p.line(url);
  await p.expect("Tags (comma-separated): ");
  p.line(tags);
  await p.expect("Notes (end with an empty line):");
  for (const n of notes) p.line(n);
  p.line("");
  const r = await p.wait();
  if (r.code !== 0) throw new Error(`add ${path} failed (${r.code}): ${r.output}`);
}

// ---------------------------------------------------------------------------
// a. export

interface ExportCase {
  format: ExportFormat;
  tags?: string[];
  folder?: string;
  spreadsheetSafe?: boolean;
}

const CASES: ExportCase[] = [
  { format: "json" },
  { format: "csv" },
  { format: "bitwarden-json" },
  { format: "csv", spreadsheetSafe: true },
  { format: "json", tags: ["work"] },
  { format: "bitwarden-json", folder: "work" },
  { format: "csv", tags: ["net", "home"] },
  { format: "bitwarden-json", tags: ["a b"], folder: "ünï" },
  { format: "json", folder: "nothing" },
];

let caseN = 0;

function flags(c: ExportCase): string[] {
  const f = ["--format", c.format];
  for (const t of c.tags ?? []) f.push("--tag", t);
  if (c.folder) f.push("--folder", c.folder);
  if (c.spreadsheetSafe) f.push("--spreadsheet-safe");
  return f;
}

function exportedAtOf(bytes: Uint8Array): number {
  const m = /"exported_at": "([^"]+)"/.exec(td.decode(bytes));
  return m ? parseTime(m[1]!) : 0;
}

/** passh-go exports; our formatter and our runExport must give the same bytes and stderr. */
async function compareExport(c: ExportCase): Promise<void> {
  const n = ++caseN;
  const refFile = join(out, `ref-${n}.out`);
  const r = await ref("export", ...flags(c), "--confirm-plaintext", "-o", refFile);
  expect(r.code).toBe(0);
  const refBytes = new Uint8Array(readFileSync(refFile));
  const data = readData();
  const exportedAt = exportedAtOf(refBytes);
  const ours = formatExport(c.format, data, selectEntries(data, { folder: c.folder, tags: c.tags }), { exportedAt, spreadsheetSafe: c.spreadsheetSafe, quirks: true });
  expect(td.decode(ours)).toBe(td.decode(refBytes));
  expect(Buffer.from(ours).equals(Buffer.from(refBytes))).toBe(true);

  const tsFile = join(out, `ts-${n}.out`);
  const io = captureIO();
  await runExport({
    format: c.format,
    tags: c.tags,
    folder: c.folder,
    spreadsheetSafe: c.spreadsheetSafe,
    confirmPlaintext: true,
    output: tsFile,
    io,
    env: e.env,
    terminal: () => null,
    now: () => exportedAt,
    quirks: true,
    openVault: async () => ({ data, close() {} }) as unknown as OpenedVault,
  });
  expect(Buffer.from(readFileSync(tsFile)).equals(Buffer.from(refBytes))).toBe(true);
  const refErr = r.stderr.trimEnd().split("\n");
  expect(io.err.map((l) => l.replace(`ts-${n}.out`, `ref-${n}.out`))).toEqual(refErr);
}

describe("a. export", () => {
  beforeAll(async () => {
    await refAdd("work/github", "s3cr3t-P@ss", "arsenii", "https://github.com", "work, dev, 2fa", ["Recovery codes in the safe.", 'Second line, "quoted".']);
    await refAdd("router", "=admin", "", "", "", []);
    await refAdd("ünï/spaced name", " lead", "-x", "+1", "a b", ["\tTAB", "@at, comma"]);
    await refAdd("work/a/b/c", "@p,q", "", "", "", []);
    expect((await ref("generate", "gen/x", "32", "--symbols")).code).toBe(0);
    expect((await ref("tag", "router", "--add", "net,home")).code).toBe(0);
  });

  test("entries made by passh-go: every format and filter", async () => {
    for (const c of CASES) await compareExport(c);
  });

  test("crafted tricky data: every format and filter", async () => {
    const f = (key: string, value: string, unknown: Array<[string, string]> = []): Field => ({ key, value, unknown: new Map(unknown) });
    let d = readData();
    const add = (p: string, c: Partial<ReturnType<typeof emptyContent>>) => {
      d = addEntry(d, p, { ...emptyContent(), ...c }, { now: 1763317302 }).data;
    };
    add("work-old/y", { password: "a ", username: " x", url: "\\.", notes: "\vx", tags: ["work"] });
    add("work/otp", {
      password: "  <>&/\x7f\u0085",
      notes: "line1\r\nline2\rline3\n",
      username: "\x01\x1f",
      fields: [f("OTP", ""), f("x", "otpauth://totp/B"), f("Password", "pw2"), f("pin", "", [["x-k", '{"a":[1E0,-0]}']]), f("Otp", "second")],
      tags: ["work", "2fa"],
    });
    add("b", { password: " x", username: "x\t", url: "'=x", notes: "\u0085z", fields: [f("note", "OtPaUtH://x")] });
    add("c", { password: "\tTAB", url: "=1", notes: "-n", fields: [f("pAsSwOrD", "")] });
    add("ünï/​z", { password: "é" + "́", tags: ["a b", "ünï"] });
    add("deep/a/b/c/d/leaf", { password: '"q"', username: "a,b", fields: [f("k", "v")] });
    d.entries[0]!.unknown.set("x-entry", '"\\u00e9\\/"');
    d.unknown.set("x-top", "[1,2,{}]");
    d.unknown.set("exported_at", '"stored"');
    writeData(d);
    for (const c of CASES) await compareExport(c);
    for (const c of [{ format: "csv", spreadsheetSafe: true }, { format: "bitwarden-json", folder: "deep/a" }, { format: "csv", tags: ["2fa"] }] as ExportCase[]) await compareExport(c);
  });

  test("the proposed fixes differ only where the audit says", () => {
    const d = readData();
    const sel = selectEntries(d);
    // #6: the stored unknown exported_at is not written a second time
    const json = td.decode(formatExport("json", d, sel, { exportedAt: 0 }));
    expect(json.match(/"exported_at"/g)!.length).toBe(1);
    // #39: an empty first otp value doesn't become the TOTP: the next otp field does (passh-go: "")
    const bw = JSON.parse(td.decode(formatExport("bitwarden-json", d, sel, { exportedAt: 0 })));
    const quirk = JSON.parse(td.decode(formatExport("bitwarden-json", d, sel, { exportedAt: 0, quirks: true })));
    expect(bw.items.find((i: { name: string }) => i.name === "otp").login.totp).toBe("second");
    expect(quirk.items.find((i: { name: string }) => i.name === "otp").login.totp).toBe("");
  });

  test("--age: both outputs decrypt with stock age to the format's bytes", async () => {
    if (!existsSync(AGE) || !existsSync(AGE_KEYGEN)) return;
    for (const pq of [false, true]) {
      const key = join(e.dir, pq ? "age-pq.key" : "age.key");
      rmSync(key, { force: true });
      const g = Bun.spawnSync([AGE_KEYGEN, ...(pq ? ["-pq"] : []), "-o", key]);
      expect(g.exitCode).toBe(0);
      const rcpt = td.decode(Bun.spawnSync([AGE_KEYGEN, "-y", key]).stdout).trim();
      expect(rcpt.startsWith(pq ? "age1pq1" : "age1")).toBe(true);
      const refFile = join(out, `ref-age-${pq}.age`);
      const r = await ref("export", "--format", "json", "--age", rcpt, "-o", refFile);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe(`passh: exported 11 entries (json, encrypted with age) to ~/out/ref-age-${pq}.age\n`);
      const refText = readFileSync(refFile, "utf8");
      expect(refText.startsWith("-----BEGIN AGE ENCRYPTED FILE-----\n")).toBe(true);
      const dec = Bun.spawnSync([AGE, "-d", "-i", key, refFile]);
      expect(dec.exitCode).toBe(0);
      const data = readData();
      const exportedAt = exportedAtOf(dec.stdout);
      expect(td.decode(dec.stdout)).toBe(td.decode(formatExport("json", data, selectEntries(data), { exportedAt, quirks: true })));

      const tsFile = join(out, `ts-age-${pq}.age`);
      const io = captureIO();
      await runExport({ format: "json", age: rcpt, output: tsFile, io, env: e.env, terminal: () => null, now: () => exportedAt, quirks: true, openVault: async () => ({ data, close() {} }) as unknown as OpenedVault });
      expect(io.err).toEqual([`passh: exported 11 entries (json, encrypted with age) to ~/out/ts-age-${pq}.age`]);
      const dec2 = Bun.spawnSync([AGE, "-d", "-i", key, tsFile]);
      expect(dec2.exitCode).toBe(0);
      expect(td.decode(dec2.stdout)).toBe(td.decode(dec.stdout));
    }
  });

  test("the plaintext confirmation on a terminal: same prompt, none of it in the data (§13.2 item 5)", async () => {
    const driver = join(ROOT, "src/export/testdata/export-driver.ts");
    const dataFile = join(e.dir, "data.json");
    writeFileSync(dataFile, serializeVaultData(readData()));
    for (const [answer, ok] of [["  EXPORT PLAINTEXT ", true], ["export plaintext", false]] as const) {
      const refOut = join(e.dir, `pty-ref-${ok}.csv`);
      const p = spawnPty([REF_BIN, "export", "--format", "csv", "--confirm-plaintext"], e.env, { stdoutFile: refOut });
      await p.expect("Type EXPORT PLAINTEXT to confirm: ");
      p.line(answer);
      const r = await p.wait();
      const tsOut = join(e.dir, `pty-ts-${ok}.csv`);
      const q = spawnPty([process.execPath, "run", driver, dataFile, "0", JSON.stringify({ format: "csv", confirmPlaintext: true })], e.env, { stdoutFile: tsOut });
      await q.expect("Type EXPORT PLAINTEXT to confirm: ");
      q.line(answer);
      const t = await q.wait();
      expect([t.code, t.output]).toEqual([r.code, r.output]);
      expect(r.code).toBe(ok ? 0 : 1);
      expect(r.output.startsWith("This writes your passwords unencrypted.\r\nType EXPORT PLAINTEXT to confirm: ")).toBe(true);
      const refData = readFileSync(refOut, "utf8");
      expect(readFileSync(tsOut, "utf8")).toBe(refData);
      expect(refData).not.toContain("EXPORT PLAINTEXT");
      if (!ok) expect(refData).toBe("");
    }
  });

  test("the order of checks and their messages match passh-go", async () => {
    const cases: Array<Parameters<typeof runExport>[0] extends infer O ? [string[], Partial<O>] : never> = [
      [[], {}],
      [["--format", "CSV", "--folder", "a//b"], { format: "CSV", folder: "a//b" }],
      [["--format", "csv", "--folder", "a//b", "--tag", "x\x01"], { format: "csv", folder: "a//b", tags: ["x\x01"] }],
      [["--format", "csv", "--tag", "x\x01", "--age", "x", "--confirm-plaintext"], { format: "csv", tags: ["x\x01"], age: "x", confirmPlaintext: true }],
      [["--format", "csv", "--tag", "a,,b"], { format: "csv", tags: ["a", "", "b"] }],
      [["--format", "json", "--age", "x", "--confirm-plaintext", "--spreadsheet-safe"], { format: "json", age: "x", confirmPlaintext: true, spreadsheetSafe: true }],
      [["--format", "json", "--spreadsheet-safe", "--age", "bad"], { format: "json", spreadsheetSafe: true, age: "bad" }],
      [["--format", "csv", "--age", "bad", "-o", "/etc/passwd"], { format: "csv", age: "bad", output: "/etc/passwd" }],
      [["--format", "csv", "--age", "  AGE-SECRET-KEY-1abc  "], { format: "csv", age: "  AGE-SECRET-KEY-1abc  " }],
      [["--format", "csv", "--age", "age1abc"], { format: "csv", age: "age1abc" }],
      [["--format", "csv", "--age", " "], { format: "csv", age: " " }],
      [["--format", "csv", "-o", "~/out/ref-1.out"], { format: "csv", output: "~/out/ref-1.out" }],
      [["--format", "csv"], { format: "csv" }],
      [["--format", "csv", "-o", "nodir/x.csv", "--confirm-plaintext"], { format: "csv", output: "nodir/x.csv", confirmPlaintext: true }],
    ];
    for (const [args, o] of cases) {
      const r = await run([REF_BIN, "export", ...args], e.env, { cwd: e.home });
      let ours: unknown;
      const io = captureIO();
      try {
        await runExport({ io, env: e.env, cwd: e.home, terminal: () => null, quirks: true, openVault: async () => ({ data: readData(), close() {} }) as unknown as OpenedVault, ...o });
      } catch (x) {
        ours = x;
      }
      const refMsg = r.stderr.split("\n")[0]!.replace(/^passh: /, "");
      expect([args.join(" "), (ours as Error | undefined)?.message]).toEqual([args.join(" "), refMsg]);
      expect((ours as { exitCode?: number }).exitCode ?? 1).toBe(r.code);
    }
  });
});

// ---------------------------------------------------------------------------
// b. import

const KEY_EMAIL = "passh-test@example.invalid";
const OTHER_EMAIL = "other@example.invalid";

function gpg(args: string[], opts: { input?: Uint8Array | string; home?: string } = {}): Uint8Array {
  const r = Bun.spawnSync(["gpg", "--batch", "--quiet", "--yes", ...args], {
    env: { ...e.env, GNUPGHOME: opts.home ?? e.gnupgHome },
    stdin: opts.input === undefined ? "ignore" : typeof opts.input === "string" ? te.encode(opts.input) : opts.input,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`gpg ${args.join(" ")}: ${td.decode(r.stderr)}`);
  return r.stdout;
}

/** Encrypts a plaintext into the store as pass does. */
function passInsert(rel: string, plaintext: string | Uint8Array, recipient = KEY_EMAIL): void {
  const p = join(e.storeDir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  const ct = gpg(["--trust-model", "always", "--encrypt", "-r", recipient], { input: plaintext });
  writeFileSync(p, ct);
}

function contentOf(x: Entry) {
  return { path: x.path, password: x.password, username: x.username, url: x.url, tags: x.tags, fields: x.fields.map((f) => [f.key, f.value]), notes: x.notes };
}

function sameData(a: VaultData, b: VaultData): void {
  const sa = [...a.entries].sort((x, y) => (x.path < y.path ? -1 : 1));
  const sb = [...b.entries].sort((x, y) => (x.path < y.path ? -1 : 1));
  expect(sb.map(contentOf)).toEqual(sa.map(contentOf));
  // ids: kept for existing entries, UUIDv4 for new ones; created_at = updated_at for new ones
  for (const x of sb) expect(x.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
}

describe("b. import pass", () => {
  let vaultA: string; // passh-go's (e.vault)
  let vaultB: string; // ours

  beforeAll(() => {
    // keys: ours (no passphrase), and another one whose secret key we don't have
    gpg(["--pinentry-mode", "loopback", "--passphrase", "", "--quick-gen-key", `passh test <${KEY_EMAIL}>`, "default", "default", "never"]);
    const other = join(e.dir, "gnupg-other");
    mkdirSync(other, { mode: 0o700 });
    gpg(["--pinentry-mode", "loopback", "--passphrase", "", "--quick-gen-key", `other <${OTHER_EMAIL}>`, "default", "default", "never"], { home: other });
    const pub = gpg(["--export", OTHER_EMAIL], { home: other });
    gpg(["--import"], { input: pub });

    writeFileSync(join(e.storeDir, ".gpg-id"), KEY_EMAIL + "\n");
    passInsert(
      "work/example.gpg",
      "pw\notpauth://totp/A?secret=X\nlogin: bob\nusername: other\nURL: https://a\nurl: https://b\ntags: a, , b, a\npin: 1234\nPIN:5678\nnote\n  OTPAUTH://totp/B?secret=Y\n\n",
    );
    passInsert("email/user.gpg", "pw\nuser: a\nlogin: b\nUser: c\nusername: d\n");
    passInsert("crlf.gpg", "p\r\nuser: u\r\nurl: x\r\n---\r\nn1\r\nn2\r\n");
    passInsert("cr.gpg", "pw\nuser: u\r\nnote\rwith cr\n");
    passInsert("bom.gpg", "﻿pw\n");
    passInsert("tags.gpg", "pw\ntags: a\tb\ntags: x, y\nTags: z\n");
    passInsert("otp-first.gpg", "otpauth://totp/X?secret=Y\nuser: u\n");
    passInsert("sep.gpg", "pw\n\n\nnotes after blanks\n---\nnot a separator now\n");
    passInsert("sep2.gpg", "pw\nk: v\n---\n\n  indented\n\n\n");
    passInsert("multi/level/deep/entry.gpg", "deep\n");
    passInsert("unicode/naïve café.gpg", "nfc\n");
    passInsert("unicode/naïve café.gpg", "nfd\n");
    passInsert("-bad.gpg", "x\n");
    passInsert("dir/-bad2.gpg", "x\n");
    passInsert("latin1.gpg", new Uint8Array([0x70, 0xe9, 0x0a]));
    passInsert("crpw.gpg", "pw\rx\n");
    passInsert("empty.gpg", "");
    passInsert("existing.gpg", "new value\n");
    passInsert("noseckey.gpg", "x\n", OTHER_EMAIL);
    writeFileSync(join(e.storeDir, "damaged.gpg"), crypto.getRandomValues(new Uint8Array(300)));
    passInsert("big.gpg", "a".repeat(5 * 1024 * 1024));
    passInsert("long.gpg", Buffer.from(crypto.getRandomValues(new Uint8Array(900 * 1024))).toString("base64") + "\nuser: long\n");
    // incompressible: the ciphertext is over 1 MiB
    const huge = new Uint8Array(1100 * 1024);
    for (let i = 0; i < huge.length; i += 65536) crypto.getRandomValues(huge.subarray(i, i + 65536));
    passInsert("huge.gpg", huge);
    passInsert(".hidden.gpg", "x\n");
    passInsert(".git/config.gpg", "x\n");
    passInsert(".extensions/ext.gpg", "x\n");
    writeFileSync(join(e.storeDir, "notes.txt"), "not an entry");
    symlinkSync("work/example.gpg", join(e.storeDir, "alias.gpg"));
    writeFileSync(join(e.dir, "outside.gpg"), gpg(["--trust-model", "always", "--encrypt", "-r", KEY_EMAIL], { input: "outside\n" }));
    symlinkSync("../outside.gpg", join(e.storeDir, "out.gpg"));
    symlinkSync(join(e.storeDir, "bom.gpg"), join(e.storeDir, "abs.gpg"));
    symlinkSync("work", join(e.storeDir, "folder.gpg"));
    symlinkSync("nothing.gpg", join(e.storeDir, "dangling.gpg"));
    symlinkSync("/etc", join(e.storeDir, "etclink"));

    // the same starting vault for both: one existing entry
    let d = readData();
    d = { ...d, entries: [], deleted: [] };
    d = addEntry(d, "existing", { ...emptyContent(), password: "old", fields: [{ key: "k", value: "v", unknown: new Map() }] }, { now: 1763317302 }).data;
    d.entries[0]!.unknown.set("x-keep", "true");
    writeData(d);
    vaultA = e.vault;
    vaultB = join(e.dir, "ours.passh");
    copyFileSync(vaultA, vaultB);
  });

  const ours = async (o: { dryRun?: boolean; overwrite?: boolean; quirks?: boolean; vault?: string } = {}) => {
    const io = captureIO();
    await runImportPass({ io, env: e.env, dryRun: o.dryRun, overwrite: o.overwrite, quirks: o.quirks ?? true, openVault: async () => fileVault(o.vault ?? vaultB) });
    return io.out;
  };

  test("dry run: the same report", async () => {
    const r = await ref("import", "pass", "--dry-run");
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const o = await ours({ dryRun: true });
    expect(o).toBe(r.stdout);
    expect(o).toContain("Would skip ");
    const r2 = await ref("import", "pass", "--dry-run", "--overwrite");
    expect(await ours({ dryRun: true, overwrite: true })).toBe(r2.stdout);
  });

  test("real run: the same report and the same data", async () => {
    const before = readData(vaultA);
    const r = await ref("import", "pass");
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const o = await ours();
    expect(o).toBe(r.stdout);
    // gpg 2.2 with --quiet reports DECRYPTION_FAILED without NO_SECKEY for a missing key
    expect(o).toMatch(/noseckey\.gpg — decryption failed: (no secret key for key ID |gpg reported DECRYPTION_FAILED)/);
    expect(o).toContain("big.gpg — decryption failed: the decrypted entry is larger than 4 MiB");
    expect(o).toContain("huge.gpg — too large: larger than 1 MiB");
    const a = readData(vaultA);
    const b = readData(vaultB);
    sameData(a, b);
    expect(a.revision).toBe(before.revision + 1n);
    expect(b.revision).toBe(before.revision + 1n);
    // an existing entry keeps its id and unknown keys (not replaced here)
    expect(b.entries.find((x) => x.path === "existing")!.unknown.get("x-keep")).toBe("true");
    const ex = b.entries.find((x) => x.path === "work/example")!;
    expect([ex.username, ex.url, ex.tags, ex.notes]).toEqual(["bob", "https://a", ["a", "b"], "username: other\nurl: https://b\nPIN:5678\nnote"]);
  });

  test("--overwrite: the same report and data; replaces keep id and created_at", async () => {
    passInsert("work/example.gpg", "changed\nuser: someone\n");
    const beforeA = readData(vaultA);
    const r = await ref("import", "pass", "--overwrite");
    expect(r.code).toBe(0);
    const o = await ours({ overwrite: true });
    expect(o).toBe(r.stdout);
    expect(o).toMatch(/^Imported \d+ entries \(\d+ replacing entries already in the vault\) from /);
    const a = readData(vaultA);
    const b = readData(vaultB);
    sameData(a, b);
    const exA = a.entries.find((x) => x.path === "existing")!;
    const exB = b.entries.find((x) => x.path === "existing")!;
    const old = beforeA.entries.find((x) => x.path === "existing")!;
    expect([exA.id, exA.createdAt, exA.password]).toEqual([old.id, old.createdAt, "new value"]);
    expect([exB.id, exB.createdAt, exB.password]).toEqual([old.id, old.createdAt, "new value"]);
    expect(exB.unknown.get("x-keep")).toBe("true");
    expect(exB.fields).toEqual([]);
  });

  test("an identical --overwrite: passh-go saves a new revision, the fix (audit #7) doesn't", async () => {
    const revA = readData(vaultA).revision;
    const revB = readData(vaultB).revision;
    const r = await ref("import", "pass", "--overwrite");
    const o = await ours({ overwrite: true, quirks: false });
    expect(o.split("\n").filter((l) => !l.includes("big.gpg") && !l.startsWith("Skipped"))).toEqual(r.stdout.split("\n").filter((l) => !l.includes("big.gpg") && !l.startsWith("Skipped")));
    expect(readData(vaultA).revision).toBe(revA + 1n);
    expect(readData(vaultB).revision).toBe(revB);
    // audit #8: the fix reports the large plaintext as `too large`
    expect(o).toContain("  big.gpg — too large: the decrypted entry is larger than 4 MiB\n");
    sameData(readData(vaultA), readData(vaultB));
  });

  test("on a terminal: the same progress on stderr and the same report", async () => {
    const store = join(e.dir, "store-pty");
    for (const n of ["p1", "p2", "sub/p3"]) {
      mkdirSync(join(store, n, ".."), { recursive: true });
      writeFileSync(join(store, n + ".gpg"), gpg(["--trust-model", "always", "--encrypt", "-r", KEY_EMAIL], { input: n + "\n" }));
    }
    const dataFile = join(e.dir, "data-import.json");
    writeFileSync(dataFile, serializeVaultData(readData(vaultB)));
    const refOut = join(e.dir, "pty-import-ref.txt");
    const p = spawnPty([REF_BIN, "import", "pass", store], e.env, { stdoutFile: refOut });
    const r = await p.wait(60_000);
    const tsOut = join(e.dir, "pty-import-ts.txt");
    const driver = join(ROOT, "src/importpass/testdata/import-driver.ts");
    const q = spawnPty([process.execPath, "run", driver, dataFile, JSON.stringify({ dir: store, quirks: true })], e.env, { stdoutFile: tsOut });
    const t = await q.wait(60_000);
    expect(r.code).toBe(0);
    expect([t.code, t.output]).toEqual([r.code, r.output]);
    expect(r.output).toBe("\rDecrypting 1/3…\x1b[K\rDecrypting 2/3…\x1b[K\rDecrypting 3/3…\x1b[K\r\x1b[K");
    expect(readFileSync(tsOut, "utf8")).toBe(readFileSync(refOut, "utf8"));
    expect(readFileSync(refOut, "utf8")).toBe(`Imported 3 entries from ${store}.\n`);
  });
});
