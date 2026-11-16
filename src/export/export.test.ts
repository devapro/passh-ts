// `passh export`'s command core (import-export.md §2.1, §2.7): the order of checks with each
// message and exit status, the confirmation, the destinations and the lines on stderr.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { x25519 } from "@noble/curves/ed25519.js";
import { bech32Encode, decrypt, dearmor, X25519Identity } from "../age/index.ts";
import { exitCodeOf } from "../errors.ts";
import { addEntry, emptyContent, newVaultData, timeFromParts, type VaultData } from "../model/index.ts";
import { captureIO, type CapturedIO } from "../util/io.ts";
import type { OpenedVault } from "../vault/types.ts";
import { runExport, type ExportOptions, type ExportTerminal } from "./export.ts";

const ROOT = join(import.meta.dir, "../..");
mkdirSync(join(ROOT, "tmp"), { recursive: true });
const DIR = mkdtempSync(join(ROOT, "tmp", "export-unit-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const T0 = timeFromParts(2026, 11, 16, 18, 21, 42);
const ENV = { HOME: join(DIR, "home"), PATH: process.env.PATH };
mkdirSync(ENV.HOME, { recursive: true });

function data(): VaultData {
  let d = newVaultData(T0);
  d = addEntry(d, "router", { ...emptyContent(), password: "=admin" }, { now: T0 }).data;
  d = addEntry(d, "work/github", { ...emptyContent(), password: "pw", tags: ["work"], fields: [{ key: "otp", value: "otpauth://x", unknown: new Map() }] }, { now: T0 }).data;
  return d;
}

interface Run {
  io: CapturedIO;
  opened: number;
  closed: number;
  said: string[];
  phrases: string[];
  result?: Awaited<ReturnType<typeof runExport>>;
  error?: unknown;
}

/** Runs runExport with a fake vault and a fake terminal (`term`: null = no terminal). */
async function exp(o: Partial<ExportOptions>, opts: { term?: "ok" | "decline" | null; stdoutTerminal?: boolean } = {}): Promise<Run> {
  const io = captureIO({ stdoutTerminal: opts.stdoutTerminal });
  const r: Run = { io, opened: 0, closed: 0, said: [], phrases: [] };
  const termMode = opts.term === undefined ? null : opts.term;
  const terminal = (): ExportTerminal | null =>
    termMode === null
      ? null
      : {
          say: (t) => r.said.push(t),
          confirmPhrase: async (p) => {
            r.phrases.push(p);
            if (termMode === "decline") throw new Error("not confirmed: you didn't type EXPORT PLAINTEXT");
          },
          close: () => {},
        };
  try {
    r.result = await runExport({
      io,
      env: ENV,
      cwd: DIR,
      now: () => T0,
      terminal,
      openVault: async () => {
        r.opened++;
        return { data: data(), close: () => r.closed++ } as unknown as OpenedVault;
      },
      ...o,
    });
  } catch (e) {
    r.error = e;
  }
  return r;
}

function failure(r: Run): [number, string] {
  expect(r.error).toBeDefined();
  return [exitCodeOf(r.error), (r.error as Error).message];
}

describe("order of checks (§2.1)", () => {
  test("1. no --format (also an empty one)", async () => {
    expect(failure(await exp({}))).toEqual([2, "--format is required: csv, json or bitwarden-json"]);
    expect(failure(await exp({ format: "", folder: "a//b" }))).toEqual([2, "--format is required: csv, json or bitwarden-json"]);
  });
  test("2. unknown format, case-sensitive", async () => {
    expect(failure(await exp({ format: "CSV", folder: "a//b" }))).toEqual([2, 'unknown export format "CSV" (use csv, json or bitwarden-json)']);
  });
  test("3. folder before tag; an empty folder is no filter", async () => {
    expect(failure(await exp({ format: "csv", folder: "a//b", tags: ["x\x01"] }))).toEqual([1, "invalid folder: it has an empty segment (//)"]);
    expect(failure(await exp({ format: "csv", folder: "a/", tags: ["x\x01"] }))).toEqual([1, "invalid folder: it ends with /"]);
    expect(failure(await exp({ format: "csv", tags: ["x\x01"], age: "x", confirmPlaintext: true }))).toEqual([1, 'invalid tag "x\\x01": it contains a control character']);
    expect(failure(await exp({ format: "csv", tags: ["a", "", "b"] }))).toEqual([1, "invalid tag: a tag can't be empty"]);
    const r = await exp({ format: "csv", folder: "", confirmPlaintext: true });
    expect(r.result?.count).toBe(2);
  });
  test("4. --age with --confirm-plaintext", async () => {
    expect(failure(await exp({ format: "json", age: "x", confirmPlaintext: true, spreadsheetSafe: true }))).toEqual([2, "--age and --confirm-plaintext can't be used together"]);
  });
  test("5. --spreadsheet-safe without csv", async () => {
    expect(failure(await exp({ format: "json", spreadsheetSafe: true, age: "bad" }))).toEqual([2, "--spreadsheet-safe applies only to --format csv"]);
    expect(failure(await exp({ format: "bitwarden-json", spreadsheetSafe: true }))).toEqual([2, "--spreadsheet-safe applies only to --format csv"]);
  });
  test("6. a bad --age value", async () => {
    expect(failure(await exp({ format: "csv", age: "bad", output: "/etc/passwd" }))).toEqual([1, "--age: not an age recipient; give an age public key (age1…)"]);
    expect(failure(await exp({ format: "csv", age: "  AGE-SECRET-KEY-1abc  " }))).toEqual([1, "--age: this is an age secret key; give its public recipient (age1…), as printed by age-keygen -y"]);
    expect(failure(await exp({ format: "csv", age: "age1abc" }))).toEqual([1, '--age: invalid age recipient "age1abc": malformed recipient "age1abc": separator \'1\' at invalid position: pos=3, len=7']);
    expect(failure(await exp({ format: "csv", age: "  " }))).toEqual([1, "--age: the recipient is empty; give an age public key (age1…)"]);
  });
  test("6. an empty --age: an error (audit #4 fix), plaintext with quirks", async () => {
    expect(failure(await exp({ format: "csv", age: "" }))).toEqual([1, "--age: the recipient is empty; give an age public key (age1…)"]);
    expect(failure(await exp({ format: "csv", age: "", quirks: true }))).toEqual([
      1,
      "a plaintext export needs confirmation: without a terminal, add --confirm-plaintext (or encrypt it with --age <recipient>)",
    ]);
    const r = await exp({ format: "csv", age: "", quirks: true, confirmPlaintext: true });
    expect(r.result?.encrypted).toBe(false);
  });
  test("7. -o exists (lstat: a dangling symlink too), ~/ in the message", async () => {
    const f = join(ENV.HOME, "exists.csv");
    writeFileSync(f, "x");
    expect(failure(await exp({ format: "csv", output: "~/exists.csv" }, { stdoutTerminal: true }))).toEqual([1, "~/exists.csv already exists; passh doesn't overwrite files"]);
    symlinkSync(join(DIR, "nothing"), join(ENV.HOME, "dangling.csv"));
    expect(failure(await exp({ format: "csv", output: join(ENV.HOME, "dangling.csv") }))).toEqual([1, "~/dangling.csv already exists; passh doesn't overwrite files"]);
    expect(failure(await exp({ format: "csv", output: "/etc/passwd" }))).toEqual([1, "/etc/passwd already exists; passh doesn't overwrite files"]);
    // A control character in the name is escaped (S4).
    const odd = join(ENV.HOME, "a\nb");
    writeFileSync(odd, "x");
    expect(failure(await exp({ format: "csv", output: odd }))).toEqual([1, "~/a\\nb already exists; passh doesn't overwrite files"]);
  });
  test("7. stdout is a terminal, also with --age", async () => {
    const msg = "refusing to write export data to a terminal: add -o file or redirect stdout";
    expect(failure(await exp({ format: "csv" }, { stdoutTerminal: true }))).toEqual([1, msg]);
    const id = X25519Identity.generate();
    const rcpt = bech32Encode("age", x25519.getPublicKey(id.secretBytes()));
    expect(failure(await exp({ format: "csv", age: rcpt }, { stdoutTerminal: true }))).toEqual([1, msg]);
  });
  test("8. plaintext without a terminal needs --confirm-plaintext", async () => {
    const r = await exp({ format: "json" });
    expect(failure(r)).toEqual([1, "a plaintext export needs confirmation: without a terminal, add --confirm-plaintext (or encrypt it with --age <recipient>)"]);
    expect(r.opened).toBe(0);
  });
  test("8. with a terminal the phrase is asked, even with --confirm-plaintext", async () => {
    const r = await exp({ format: "json", confirmPlaintext: true }, { term: "ok" });
    expect(r.said).toEqual(["This writes your passwords unencrypted."]);
    expect(r.phrases).toEqual(["EXPORT PLAINTEXT"]);
    expect(r.result?.count).toBe(2);
    const d = await exp({ format: "json", confirmPlaintext: true }, { term: "decline" });
    expect(failure(d)[1]).toBe("not confirmed: you didn't type EXPORT PLAINTEXT");
    expect(d.opened).toBe(0);
    expect(d.io.out).toBe("");
  });
  test("an --age export asks nothing", async () => {
    const id = X25519Identity.generate();
    const rcpt = bech32Encode("age", x25519.getPublicKey(id.secretBytes()));
    const r = await exp({ format: "json", age: "  " + rcpt + "\n" }, { term: "ok" });
    expect(r.phrases).toEqual([]);
    expect(r.result?.encrypted).toBe(true);
  });
});

describe("output (§2.1 after writing, §2.7)", () => {
  test("stdout: one write, then the note and the CSV warning", async () => {
    const r = await exp({ format: "csv", confirmPlaintext: true });
    expect(r.io.out).toBe("folder,name,username,password,url,tags,notes\r\n,router,,=admin,,,\r\nwork,github,,pw,,work,\r\n");
    expect(r.io.err).toEqual([
      "passh: exported 2 entries (csv, plaintext) to stdout",
      "passh: warning: CSV has no column for custom fields: 1 field was left out (otp fields included); use --format json or bitwarden-json to keep them",
    ]);
    expect(r.opened).toBe(1);
    expect(r.closed).toBe(1);
  });
  test("singular, folder and tag filters, no CSV warning without fields", async () => {
    const r = await exp({ format: "csv", confirmPlaintext: true, tags: ["work"], folder: "work" });
    expect(r.io.err[0]).toBe("passh: exported 1 entry (csv, plaintext) to stdout");
    const n = await exp({ format: "csv", confirmPlaintext: true, folder: "router" });
    expect(n.io.err).toEqual(["passh: exported 0 entries (csv, plaintext) to stdout"]);
  });
  test("json carries exported_at; bitwarden-json", async () => {
    const r = await exp({ format: "json", confirmPlaintext: true });
    expect(r.io.out).toContain('"exported_at": "2026-11-16T18:21:42Z",');
    const b = await exp({ format: "bitwarden-json", confirmPlaintext: true });
    expect(JSON.parse(b.io.out).items.length).toBe(2);
    expect(b.io.err).toEqual(["passh: exported 2 entries (bitwarden-json, plaintext) to stdout"]);
  });
  test("-o: a new 0600 file, the tmpfs warning on a persistent disk", async () => {
    const r = await exp({ format: "csv", confirmPlaintext: true, output: "~/out.csv" });
    const f = join(ENV.HOME, "out.csv");
    expect(readFileSync(f, "utf8")).toContain("router");
    expect(lstatSync(f).mode & 0o777).toBe(0o600);
    expect(r.io.out).toBe("");
    expect(r.io.err).toEqual([
      "passh: warning: ~/out.csv isn't on tmpfs: the plaintext is on persistent disk. Delete it when you're done",
      "passh: exported 2 entries (csv, plaintext) to ~/out.csv",
      "passh: warning: CSV has no column for custom fields: 1 field was left out (otp fields included); use --format json or bitwarden-json to keep them",
    ]);
  });
  test("-o on tmpfs: no warning", async () => {
    if (!existsSync("/dev/shm")) return;
    const dir = mkdtempSync("/dev/shm/passh-ts-export-");
    try {
      const r = await exp({ format: "json", confirmPlaintext: true, output: join(dir, "x.json") });
      expect(r.io.err).toEqual([`passh: exported 2 entries (json, plaintext) to ${dir}/x.json`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("-o in a missing folder: the open error, nothing written", async () => {
    const r = await exp({ format: "csv", confirmPlaintext: true, output: "nodir/x.csv" });
    expect(failure(r)).toEqual([1, `open ${DIR}/nodir/x.csv: no such file or directory`]);
    expect(r.io.err).toEqual([]);
  });
  test("--age: armored, decrypts to the format's bytes; no tmpfs warning", async () => {
    const id = X25519Identity.generate();
    const rcpt = bech32Encode("age", x25519.getPublicKey(id.secretBytes()));
    const r = await exp({ format: "csv", age: rcpt, output: "~/enc.age" });
    const text = readFileSync(join(ENV.HOME, "enc.age"), "utf8");
    expect(text.startsWith("-----BEGIN AGE ENCRYPTED FILE-----\n")).toBe(true);
    expect(text.endsWith("-----END AGE ENCRYPTED FILE-----\n")).toBe(true);
    for (const l of text.split("\n").slice(1, -2)) expect(l.length).toBeLessThanOrEqual(64);
    const plain = new TextDecoder().decode(decrypt(dearmor(text)!, id));
    expect(plain).toBe("folder,name,username,password,url,tags,notes\r\n,router,,=admin,,,\r\nwork,github,,pw,,work,\r\n");
    expect(r.io.err).toEqual([
      "passh: exported 2 entries (csv, encrypted with age) to ~/enc.age",
      "passh: warning: CSV has no column for custom fields: 1 field was left out (otp fields included); use --format json or bitwarden-json to keep them",
    ]);
  });
});
