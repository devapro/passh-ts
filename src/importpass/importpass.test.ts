// `passh import pass` end to end in-process (import-export.md §1), with a fake gpg (testdata/
// fake-gpg.sh) first in $PATH and an in-memory vault: the walk rules, planning, dry run, gpg's
// verdicts, parsing, the one save and the report.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { isolatedEnv, type IsolatedEnv } from "../../test/helpers/env.ts";
import { exitCodeOf } from "../errors.ts";
import { codedError } from "../i18n/index.ts";
import { addEntry, cloneVaultData, emptyContent, newVaultData, timeFromParts, type VaultData } from "../model/index.ts";
import { captureIO } from "../util/io.ts";
import type { OpenedVault } from "../vault/types.ts";
import { locateStore, runImportPass, type ImportOptions } from "./importpass.ts";
import { ROOT_MAX_SYMLINKS, StoreRoot } from "./root.ts";
import { planImport, walkStore } from "./walk.ts";

const FAKE = join(import.meta.dir, "testdata", "fake-gpg.sh");
const T0 = timeFromParts(2026, 11, 16, 18, 21, 42);
const T1 = T0 + 3600;

let e: IsolatedEnv;
let bin: string;
let env: Record<string, string>;

beforeAll(() => {
  e = isolatedEnv("import");
  bin = join(e.dir, "bin");
  mkdirSync(bin);
  symlinkSync(FAKE, join(bin, "gpg"));
  env = { ...e.env, PATH: `${bin}:/usr/bin:/bin`, FAKE_GPG_LOG: join(e.dir, "gpg.log"), GPG_TTY: "" };
});
afterAll(() => e.cleanup());

let storeN = 0;
/** A fresh store folder with files: name → content (a string or bytes), symlinks given as {link: target}, folders as {dir: true}. */
function makeStore(files: Record<string, string | Uint8Array | { link: string } | { dir: true } | { fifo: true }>): string {
  const s = join(e.dir, `store${++storeN}`);
  mkdirSync(s, { recursive: true });
  for (const [name, v] of Object.entries(files)) {
    const p = join(s, name);
    mkdirSync(join(p, ".."), { recursive: true });
    if (typeof v === "string" || v instanceof Uint8Array) writeFileSync(p, v);
    else if ("link" in v) symlinkSync(v.link, p);
    else if ("dir" in v) mkdirSync(p, { recursive: true });
    else mkfifoSync(p);
  }
  return s;
}

function mkfifoSync(p: string): void {
  const r = spawnSync("mkfifo", [p]);
  if (r.status !== 0) throw new Error("mkfifo failed");
}

/** A fake-gpg ciphertext: directives, then the plaintext. */
function ct(plaintext: string | Uint8Array, ...directives: string[]): Uint8Array {
  const head = new TextEncoder().encode(["#!fake-gpg", ...(directives.length ? directives : ["status DECRYPTION_OKAY"]), "--", ""].join("\n"));
  const body = typeof plaintext === "string" ? new TextEncoder().encode(plaintext) : plaintext;
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

interface FakeVault extends OpenedVault {
  saves: VaultData[];
  closed: number;
}

function fakeVault(initial: VaultData, failSave?: Error): FakeVault {
  let data = initial;
  const v = {
    saves: [] as VaultData[],
    closed: 0,
    get data() {
      return data;
    },
    async save(d: VaultData) {
      if (failSave) throw failSave;
      const next = cloneVaultData(d);
      next.revision = data.revision + 1n;
      v.saves.push(next);
      data = next;
    },
    close() {
      v.closed++;
    },
  };
  return v as unknown as FakeVault;
}

async function imp(store: string, vault: FakeVault, o: Partial<ImportOptions> = {}, terminal = false) {
  const io = captureIO({ stderrTerminal: terminal });
  const progress: string[] = [];
  let error: unknown;
  let result;
  try {
    result = await runImportPass({ dir: store, io, env, openVault: async () => vault, now: () => T1, progress: (s) => progress.push(s), ...o });
  } catch (err) {
    error = err;
  }
  return { io, out: io.out, progress, error, result };
}

function emptyVault(...paths: string[]): FakeVault {
  let d = newVaultData(T0);
  for (const p of paths) d = addEntry(d, p, { ...emptyContent(), password: "old-" + p }, { now: T0 }).data;
  return fakeVault(d);
}

describe("locating the store (§1.2)", () => {
  test("argument, $PASSWORD_STORE_DIR, $HOME/.password-store", () => {
    const en = { HOME: "/h", PASSWORD_STORE_DIR: "/p" };
    expect(locateStore("~/s", en, "/cwd")).toBe("/h/s");
    expect(locateStore("~", en, "/cwd")).toBe("/h");
    expect(locateStore("~user/x", en, "/cwd")).toBe("/cwd/~user/x");
    expect(locateStore("rel/../s", en, "/cwd")).toBe("/cwd/s");
    expect(locateStore("", en, "/cwd")).toBe("/p");
    expect(locateStore(undefined, en, "/cwd")).toBe("/p");
    expect(locateStore(undefined, { HOME: "/h", PASSWORD_STORE_DIR: "~/ps" }, "/cwd")).toBe("/h/ps");
    expect(locateStore(undefined, { HOME: "/h", PASSWORD_STORE_DIR: "" }, "/cwd")).toBe("/h/.password-store");
    expect(() => locateStore(undefined, {}, "/cwd")).toThrow("$HOME is not set");
    expect(() => locateStore(undefined, { HOME: "rel" }, "/cwd")).toThrow('$HOME ("rel") is not an absolute path');
  });

  test("a missing store, a file, an unreadable root", async () => {
    const v = emptyVault();
    expect(((await imp(join(e.dir, "nothing"), v)).error as Error).message).toBe(`pass store: open ${e.dir}/nothing: no such file or directory`);
    writeFileSync(join(e.dir, "afile"), "x");
    expect(((await imp(join(e.dir, "afile"), v)).error as Error).message).toBe(`pass store: open ${e.dir}/afile: not a directory`);
    const s600 = makeStore({ "a.gpg": "x" });
    chmodSync(s600, 0o600);
    try {
      expect(((await imp(s600, v, { dryRun: true })).error as Error).message).toBe(`pass store ${s600}: statat .: permission denied`);
    } finally {
      chmodSync(s600, 0o700);
    }
    const s000 = makeStore({});
    chmodSync(s000, 0o000);
    try {
      expect(((await imp(s000, v, { dryRun: true })).error as Error).message).toBe(`pass store: open ${s000}: permission denied`);
    } finally {
      chmodSync(s000, 0o700);
    }
  });

  test("the store may be a symlink; the report shows the path as given", async () => {
    const s = makeStore({ "a.gpg": "x" });
    symlinkSync(s, join(e.dir, "storelink"));
    const r = await imp(join(e.dir, "storelink"), emptyVault(), { dryRun: true });
    expect(r.out).toBe(`Dry run: nothing was decrypted or saved. Store: ${e.dir}/storelink\nWould import 1 entry:\n  a\nWould import 1 entry.\n`);
  });
});

describe("the walk (§1.3) and planning (§1.4), as a dry run", () => {
  let store: string;
  beforeAll(() => {
    const L = "a".repeat(200);
    const M = "m".repeat(250);
    store = makeStore({
      "a.gpg": "a",
      "b.txt": "b",
      ".gpg-id": "id",
      ".git/x.gpg": "x",
      ".hidden.gpg": "h",
      "dir/c.gpg": "c",
      "x.gpg/y.gpg": "y",
      "sub/link-up.gpg": { link: "../a.gpg" },
      "fifo.gpg": { fifo: true },
      fifo: { fifo: true },
      "link-in.gpg": { link: "a.gpg" },
      "link-in-txt": { link: "a.gpg" },
      "link-dir.gpg": { link: "dir" },
      "link-dir": { link: "dir" },
      "link-out.gpg": { link: "../outside.gpg" },
      "link-out": { link: "/etc/passwd" },
      "broken.gpg": { link: "nothing.gpg" },
      broken: { link: "nothing" },
      "broken-out.gpg": { link: "../nothing.gpg" },
      "loop.gpg": { link: "loop.gpg" },
      "link-fifo.gpg": { link: "fifo.gpg" },
      "link-notdir.gpg": { link: "a.gpg/x" },
      "link-notdir": { link: "a.gpg/x" },
      "link-dotdot.gpg": { link: "dir/../a.gpg" },
      "link-dotdot2.gpg": { link: "link-dir/../a.gpg" },
      "-x.gpg": "m",
      "dir/-y.gpg": "m",
      "c\x01.gpg": "m",
      "caf\u00e9.gpg": "m",
      "cafe\u0301.gpg": "m",
      "router.gpg": "r",
      "locked/z.gpg": "z",
      [`${L}/${L}/${L}/${L}/${L}/short.gpg`]: "l",
      [`${M}/${M}/${M}/${M}/${"n".repeat(30)}.gpg`]: "l",
      "toolong.gpg": { link: "b".repeat(300) },
      "self.gpg": { link: "." },
      "subslash.gpg": { link: "dir/" },
      "aslash.gpg": { link: "a.gpg/" },
      "dot.gpg": { link: "./a.gpg" },
      "back.gpg": { link: "sub/../../" + "STORE/a.gpg" },
      "nodir.gpg": { link: "nodir/x.gpg" },
      "idlink.gpg": { link: ".gpg-id" },
    });
    writeFileSync(join(e.dir, "outside.gpg"), "o");
    // an absolute link into the store, a chain of 9 links (one too many) and one of 8
    symlinkSync(join(store, "a.gpg"), join(store, "link-abs-in.gpg"));
    symlinkSync("a.gpg", join(store, "ch9.gpg"));
    for (let i = 8; i >= 1; i--) symlinkSync(`ch${i + 1}.gpg`, join(store, `ch${i}.gpg`));
    // invalid UTF-8 in a name
    writeFileSync(Buffer.concat([Buffer.from(store + "/n"), Buffer.from([0xff]), Buffer.from(".gpg")]), "m");
    chmodSync(join(store, "locked"), 0o000);
  });
  afterAll(() => chmodSync(join(store, "locked"), 0o700));

  test("the report", async () => {
    const r = await imp(store, emptyVault("router"), { dryRun: true });
    const L = "a".repeat(200);
    const M = "m".repeat(250);
    expect(r.error).toBeUndefined();
    expect(r.out).toBe(
      [
        `Dry run: nothing was decrypted or saved. Store: ${store}`,
        "Would import 19 entries:",
        "  a",
        `  ${L}/${L}/${L}/${L}/${L}/short`,
        "  caf\u00e9",
        "  ch2",
        "  ch3",
        "  ch4",
        "  ch5",
        "  ch6",
        "  ch7",
        "  ch8",
        "  ch9",
        "  dir/c",
        "  dot",
        "  idlink",
        "  link-dotdot",
        "  link-dotdot2",
        "  link-in",
        "  sub/link-up",
        "  x.gpg/y",
        "Would import 19 entries.",
        "Would skip 27: 5 invalid path, 1 already in the vault, 1 duplicate path, 9 symlink leads outside the store, 2 broken symlink, 4 symlink to a folder, 2 not a regular file, 3 unreadable.",
        "  -x.gpg — invalid path: a segment starts with -",
        "  aslash.gpg — symlink leads outside the store: not followed",
        "  back.gpg — symlink leads outside the store: not followed",
        "  broken-out.gpg — symlink leads outside the store: not followed",
        "  broken.gpg — broken symlink",
        "  c\\x01.gpg — invalid path: it contains a control character",
        "  caf\u00e9.gpg — duplicate path: same path as cafe\u0301.gpg",
        "  ch1.gpg — unreadable: too many levels of symbolic links",
        "  dir/-y.gpg — invalid path: a segment starts with -",
        "  fifo.gpg — not a regular file",
        "  link-abs-in.gpg — symlink leads outside the store: not followed",
        "  link-dir — symlink to a folder: not followed",
        "  link-dir.gpg — symlink to a folder: not followed",
        "  link-fifo.gpg — not a regular file",
        "  link-notdir — symlink leads outside the store: not followed",
        "  link-notdir.gpg — symlink leads outside the store: not followed",
        "  link-out — symlink leads outside the store: not followed",
        "  link-out.gpg — symlink leads outside the store: not followed",
        "  locked — unreadable: permission denied",
        "  loop.gpg — unreadable: too many levels of symbolic links",
        `  ${M}/${M}/${M}/${M}/${"n".repeat(30)}.gpg — invalid path: it is longer than 1024 bytes`,
        "  nodir.gpg — broken symlink",
        "  n\\xff.gpg — invalid path: it is not valid UTF-8",
        "  router.gpg — already in the vault: use --overwrite to replace it",
        "  self.gpg — symlink to a folder: not followed",
        "  subslash.gpg — symlink to a folder: not followed",
        "  toolong.gpg — symlink leads outside the store: not followed",
        "",
      ].join("\n"),
    );
    // nothing was decrypted: gpg never ran
    expect(existsSync(env.FAKE_GPG_LOG!)).toBe(false);
  });

  test("with --overwrite the conflict becomes a replace", async () => {
    const r = await imp(store, emptyVault("router"), { dryRun: true, overwrite: true });
    expect(r.out).toContain("\n  router  (replaces the entry in the vault)\n");
    expect(r.out).toContain("\nWould import 20 entries (1 replacing entries already in the vault).\n");
    expect(r.out).not.toContain("already in the vault: use");
  });

  test("the duplicate keeps the earlier file in walk order (bytes: NFD `e` before NFC `é`)", () => {
    const root = StoreRoot.open(store);
    try {
      const w = walkStore(root);
      const p = planImport(w.files, newVaultData(T0), false);
      const cafe = p.items.find((i) => i.path === "caf\u00e9")!;
      expect(cafe.file.toString()).toBe("cafe\u0301.gpg");
    } finally {
      root.close();
    }
  });

  test("the walk order is depth-first, pre-order, names by bytes", () => {
    const s = makeStore({ "b.gpg": "", "a/z.gpg": "", "a/b/c.gpg": "", "a.gpg": "", "B.gpg": "", "a-b.gpg": "" });
    const root = StoreRoot.open(s);
    try {
      expect(walkStore(root).files.map((f) => f.toString())).toEqual(["B.gpg", "a/b/c.gpg", "a/z.gpg", "a-b.gpg", "a.gpg", "b.gpg"]);
    } finally {
      root.close();
    }
  });

  test("the symlink limit is Go's os.Root limit", () => {
    expect(ROOT_MAX_SYMLINKS).toBe(8);
  });
});

describe("a real run with the fake gpg (§1.5–§1.8)", () => {
  test("parsing (§1.6), new entries, one save, the report", async () => {
    const example = "pw\notpauth://totp/A?secret=X\nlogin: bob\nusername: other\nURL: https://a\nurl: https://b\ntags: a, , b, a\npin: 1234\nPIN:5678\nnote\n  OTPAUTH://totp/B?secret=Y\n\n";
    const store = makeStore({
      "work/example.gpg": ct(example),
      "crlf.gpg": ct("p\r\nuser: u\r\n---\r\nn1\r\nn2\r\n"),
      "empty.gpg": ct(""),
      "bom.gpg": ct("﻿pw\n"),
      "latin.gpg": ct(new Uint8Array([0xff, 0xfe, 0x0a])),
      "crpw.gpg": ct("pw\rx\n"),
    });
    const v = emptyVault("other");
    const r = await imp(store, v);
    expect(r.error).toBeUndefined();
    expect(r.out).toBe(
      `Imported 4 entries from ${store}.\nSkipped 2: 2 not a text entry.\n  crpw.gpg — not a text entry: invalid entry: password must be a single line\n  latin.gpg — not a text entry: the text is not valid UTF-8\n`,
    );
    expect(v.saves.length).toBe(1);
    const d = v.saves[0]!;
    expect(d.entries.map((x) => x.path)).toEqual(["other", "bom", "crlf", "empty", "work/example"]);
    const ex = d.entries.find((x) => x.path === "work/example")!;
    expect(ex.password).toBe("pw");
    expect(ex.username).toBe("bob");
    expect(ex.url).toBe("https://a");
    expect(ex.tags).toEqual(["a", "b"]);
    expect(ex.fields.map((f) => [f.key, f.value])).toEqual([
      ["otp", "otpauth://totp/A?secret=X"],
      ["pin", "1234"],
      ["otp", "OTPAUTH://totp/B?secret=Y"],
    ]);
    expect(ex.notes).toBe("username: other\nurl: https://b\nPIN:5678\nnote");
    expect(ex.createdAt).toBe(T1);
    expect(ex.updatedAt).toBe(T1);
    expect(ex.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const crlf = d.entries.find((x) => x.path === "crlf")!;
    expect([crlf.password, crlf.username, crlf.notes]).toEqual(["p", "u", "n1\nn2"]);
    expect(d.entries.find((x) => x.path === "bom")!.password).toBe("﻿pw");
    expect(d.entries.find((x) => x.path === "empty")!.password).toBe("");
    // gpg got exactly these arguments, once per planned file
    const log = readFileSync(env.FAKE_GPG_LOG!, "utf8").trim().split("\n");
    expect(log.length).toBe(6);
    expect(log[0]).toBe("gpg|--quiet --status-fd 3 --decrypt|GPG_TTY=");
    expect(v.closed).toBe(1);
  });

  test("every verdict of §1.5 and the limits", async () => {
    const store = makeStore({
      "ok.gpg": ct("pw1\nuser: bob\n"),
      "noseckey.gpg": ct("", "status NO_SECKEY 1111AAAA", "status NO_SECKEY 2222BBBB", "status BAD_PASSPHRASE x", "exit 2"),
      "badmdc.gpg": ct("x\n", "status BADMDC", "status  ERROR   decrypt   1  ", "status DECRYPTION_OKAY"),
      "exit3.gpg": ct("x\n", "status DECRYPTION_OKAY", "exit 3"),
      "killed.gpg": ct("x\n", "status DECRYPTION_OKAY", "kill KILL"),
      "nothing.gpg": ct("", "exit 0"),
      "missing.gpg": ct("", "status MISSING_PASSPHRASE", "exit 2"),
      "big.gpg": ct("", "status DECRYPTION_OKAY", "big 4194305"),
      "big4.gpg": ct("", "status DECRYPTION_OKAY", "big 4194304"),
      "nodata.gpg": "not fake",
      "crlfstatus.gpg": ct("crlf\n", "rawcr [GNUPG:] DECRYPTION_OKAY"),
      "toolarge.gpg": new Uint8Array(1048577),
      "bigstatus.gpg": ct("s\n", "bigstatus 2000000", "raw ", "status DECRYPTION_OKAY"),
    });
    const v = emptyVault();
    const r = await imp(store, v);
    expect(r.out).toBe(
      [
        `Imported 3 entries from ${store}.`,
        "Skipped 10: 2 too large, 8 decryption failed.",
        "  badmdc.gpg — decryption failed: gpg reported BADMDC; ERROR decrypt 1",
        "  big.gpg — too large: the decrypted entry is larger than 4 MiB",
        "  bigstatus.gpg — decryption failed: gpg did not report a successful decryption",
        "  exit3.gpg — decryption failed: gpg failed (exit status 3)",
        "  killed.gpg — decryption failed: gpg failed (exit status -1)",
        "  missing.gpg — decryption failed: no passphrase given",
        "  nodata.gpg — decryption failed: not an OpenPGP message (damaged file?)",
        "  noseckey.gpg — decryption failed: no secret key for key ID 1111AAAA, 2222BBBB",
        "  nothing.gpg — decryption failed: gpg did not report a successful decryption",
        "  toolarge.gpg — too large: larger than 1 MiB",
        "",
      ].join("\n"),
    );
    expect(v.saves[0]!.entries.map((x) => x.path).sort()).toEqual(["big4", "crlfstatus", "ok"]);
    expect(v.saves[0]!.entries.find((x) => x.path === "big4")!.password.length).toBe(4194304);
    // audit #8 with quirks: `decryption failed`
    const q = await imp(makeStore({ "big.gpg": ct("", "status DECRYPTION_OKAY", "big 4194305") }), emptyVault(), { quirks: true });
    expect(q.out).toContain("  big.gpg — decryption failed: the decrypted entry is larger than 4 MiB\n");
  });

  test("a cancel at the passphrase prompt aborts the import: nothing saved, no report", async () => {
    const store = makeStore({ "c1.gpg": ct("pw\n"), "c2.gpg": ct("", "status ERROR pkdecrypt_failed 83886179", "exit 2"), "c3.gpg": ct("pw\n") });
    rmSync(env.FAKE_GPG_LOG!, { force: true });
    const v = emptyVault();
    const r = await imp(store, v);
    expect((r.error as Error).message).toBe("import canceled at the passphrase prompt");
    expect(exitCodeOf(r.error)).toBe(1);
    expect(r.out).toBe("");
    expect(v.saves.length).toBe(0);
    expect(readFileSync(env.FAKE_GPG_LOG!, "utf8").trim().split("\n").length).toBe(2);
    expect(v.closed).toBe(1);
  });

  test("gpg is looked up only when something needs decrypting", async () => {
    const none = join(e.dir, "nobin");
    mkdirSync(none, { recursive: true });
    const noGpg = { ...env, PATH: none };
    const msg = "gpg not found: import pass needs GnuPG (gpg) to decrypt the store";
    expect(((await imp(makeStore({ "big.gpg": new Uint8Array(1048577) }), emptyVault(), { env: noGpg })).error as Error).message).toBe(msg);
    expect(((await imp(makeStore({ "x.gpg": "x" }), emptyVault(), { env: noGpg })).error as Error).message).toBe(msg);
    // nothing planned: no lookup
    const r = await imp(makeStore({ "x.txt": "x", "-x.gpg": "x" }), emptyVault(), { env: noGpg });
    expect(r.out).toBe(`Imported 0 entries from ${e.dir}/store${storeN}.\nSkipped 1: 1 invalid path.\n  -x.gpg — invalid path: a segment starts with -\n`);
    // a dry run never looks
    const d = await imp(makeStore({ "x.gpg": "x" }), emptyVault(), { env: noGpg, dryRun: true });
    expect(d.error).toBeUndefined();
  });

  test("gpg that can't be started aborts: `gpg: ‹error›`", async () => {
    const bad = join(e.dir, "badbin");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "gpg"), "\x7fELFgarbage");
    chmodSync(join(bad, "gpg"), 0o755);
    const r = await imp(makeStore({ "x.gpg": "x" }), emptyVault(), { env: { ...env, PATH: bad } });
    expect((r.error as Error).message).toBe(`gpg: ${bad}/gpg: fork/exec ${bad}/gpg: exec format error`);
  });

  test("progress on a terminal: before each file; the last one cleared at once", async () => {
    const store = makeStore({ "p1.gpg": ct("a\n"), "p2.gpg": ct("b\n"), "p3.gpg": ct("c\n") });
    const r = await imp(store, emptyVault(), {}, true);
    expect(r.progress.join("")).toBe("\rDecrypting 1/3…\x1b[K\rDecrypting 2/3…\x1b[K\rDecrypting 3/3…\x1b[K\r\x1b[K");
    const quiet = await imp(makeStore({ "p1.gpg": ct("a\n") }), emptyVault(), {}, false);
    expect(quiet.progress).toEqual([]);
  });

  test("GPG_TTY: passed on unchanged when set, never added without a terminal", async () => {
    rmSync(env.FAKE_GPG_LOG!, { force: true });
    await imp(makeStore({ "t1.gpg": ct("a\n") }), emptyVault(), { env: { ...env, GPG_TTY: "/dev/bogus" } });
    expect(readFileSync(env.FAKE_GPG_LOG!, "utf8")).toBe("gpg|--quiet --status-fd 3 --decrypt|GPG_TTY=/dev/bogus\n");
  });

  test("the status pipe is closed 2 s after gpg exits when something still holds it", async () => {
    const t = Date.now();
    const r = await imp(makeStore({ "held.gpg": ct("pw\n", "status DECRYPTION_OKAY", "hold 6") }), emptyVault());
    const ms = Date.now() - t;
    expect(r.out).toContain("Imported 1 entry from");
    expect(ms).toBeGreaterThanOrEqual(1900);
    expect(ms).toBeLessThan(5000);
  }, 10_000);

  test("a file swapped for an escaping symlink after the walk: unreadable", async () => {
    const store = makeStore({ "s1.gpg": ct("a\n", "status DECRYPTION_OKAY", "sleep 0.6"), "s2.gpg": ct("b\n") });
    writeFileSync(join(e.dir, "evil.gpg"), ct("evil\n"));
    const v = emptyVault();
    const p = imp(store, v);
    // s1's gpg sleeps; meanwhile s2 becomes a link out of the store
    await Bun.sleep(200);
    renameSync(join(store, "s2.gpg"), join(store, "s2.old"));
    symlinkSync(join(e.dir, "evil.gpg"), join(store, "s2.gpg"));
    const r = await p;
    expect(r.out).toBe(`Imported 1 entry from ${store}.\nSkipped 1: 1 unreadable.\n  s2.gpg — unreadable: path escapes from parent\n`);
    // and a planned regular file that became a FIFO
    const store2 = makeStore({ "f1.gpg": ct("a\n", "status DECRYPTION_OKAY", "sleep 0.6"), "f2.gpg": ct("b\n") });
    const p2 = imp(store2, emptyVault());
    await Bun.sleep(200);
    rmSync(join(store2, "f2.gpg"));
    mkfifoSync(join(store2, "f2.gpg"));
    expect((await p2).out).toContain("  f2.gpg — not a regular file\n");
  });

  test("--overwrite keeps id, created_at and unknown keys; identical content saves nothing (audit #7)", async () => {
    let d = newVaultData(T0);
    d = addEntry(d, "a", { ...emptyContent(), password: "same" }, { now: T0 }).data;
    d = addEntry(d, "b", { ...emptyContent(), password: "old", fields: [{ key: "k", value: "v", unknown: new Map([["x", "1"]]) }] }, { now: T0 }).data;
    d.entries[1]!.unknown.set("keep", '"me"');
    const store = makeStore({ "a.gpg": ct("same\n"), "b.gpg": ct("new\npin: 1\n") });
    // without --overwrite both are conflicts, nothing decrypted, no save
    const v0 = fakeVault(d);
    const r0 = await imp(store, v0);
    expect(r0.out).toBe(
      `Imported 0 entries from ${store}.\nSkipped 2: 2 already in the vault.\n  a.gpg — already in the vault: use --overwrite to replace it\n  b.gpg — already in the vault: use --overwrite to replace it\n`,
    );
    expect(v0.saves.length).toBe(0);
    // with it
    const v = fakeVault(d);
    const r = await imp(store, v, { overwrite: true });
    expect(r.out).toBe(`Imported 2 entries (2 replacing entries already in the vault) from ${store}.\n`);
    expect(v.saves.length).toBe(1);
    const [a, b] = v.saves[0]!.entries;
    expect([a!.id, a!.updatedAt]).toEqual([d.entries[0]!.id, T0]);
    expect([b!.id, b!.createdAt, b!.updatedAt, b!.password]).toEqual([d.entries[1]!.id, T0, T1, "new"]);
    expect(b!.unknown.get("keep")).toBe('"me"');
    expect(b!.fields).toEqual([{ key: "pin", value: "1", unknown: new Map() }]);
    // only identical content: no save (fix); quirks: a save anyway
    const same = makeStore({ "a.gpg": ct("same\n") });
    const v2 = fakeVault(d);
    expect((await imp(same, v2, { overwrite: true })).out).toBe(`Imported 1 entry (1 replacing entries already in the vault) from ${same}.\n`);
    expect(v2.saves.length).toBe(0);
    const v3 = fakeVault(d);
    await imp(same, v3, { overwrite: true, quirks: true });
    expect(v3.saves.length).toBe(1);
  });

  test("a failed save: `nothing was imported: ‹error›`, no report", async () => {
    const v = fakeVault(newVaultData(T0), codedError("changed", "vault changed on disk after it was opened (another passh, a sync tool or a copy); nothing was saved: reload and repeat the change"));
    const r = await imp(makeStore({ "x.gpg": ct("x\n") }), v);
    expect((r.error as Error).message).toBe(
      "nothing was imported: vault changed on disk after it was opened (another passh, a sync tool or a copy); nothing was saved: reload and repeat the change",
    );
    expect(r.out).toBe("");
  });

  test("the vault is unlocked first: a locked vault fails before the store is looked at", async () => {
    const r = await runImportPass({ dir: join(e.dir, "nothing"), io: captureIO(), env, openVault: async () => { throw new Error("vault is locked"); } }).catch((x) => x);
    expect((r as Error).message).toBe("vault is locked");
  });
});
