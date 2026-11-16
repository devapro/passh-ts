// Side by side with the reference: `passh verify [file] [--full]`, `passh backup <dest>` and
// `passh backups` (cli.md §2.19–§2.21, storage.md §5.4, §6) on byte-identical vault copies:
// good, non-canonical, damaged and missing files; the rollback report of --full; backups to
// a file and to a folder, the refusals; the listing of automatic backups and its notes.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IsolatedEnv } from "../helpers/env.ts";
import { bothMore, killAgentsUnder, makePair, PASSPHRASE_STEP, runMore, visible, type MoreRunOptions, type Pair } from "./side_more.ts";
import { buildVault, placeVault, type BuiltVault } from "./vaults.ts";

setDefaultTimeout(90_000);

let vault: BuiltVault;
let other: BuiltVault;
let crlf: Uint8Array;
const pairs: Pair[] = [];
const isRoot = process.getuid?.() === 0;

beforeAll(async () => {
  vault = await buildVault([
    { path: "work/github", password: "pw1", username: "alice" },
    { path: "mail", password: "pw2" },
  ]);
  other = await buildVault([{ path: "x" }]);
  const text = new TextDecoder().decode(vault.bytes);
  crlf = new TextEncoder().encode(("Hello,\nhere is the file\n\n" + text + "--\nsig\n").replace(/\n/g, "\r\n"));
});

afterAll(async () => {
  for (const p of pairs) {
    for (const e of [p.ref, p.ours]) {
      killAgentsUnder(e.dir);
      for (const d of [e.dir, join(e.dataHome, "passh"), e.home]) {
        try {
          chmodSync(d, 0o700);
        } catch {}
      }
    }
    p.cleanup();
  }
});

async function newPair(setup?: (e: IsolatedEnv) => void, extra = "", bytes: Uint8Array | null = vault.bytes): Promise<Pair> {
  const p = await makePair("fil", bytes ?? undefined, extra);
  pairs.push(p);
  for (const e of [p.ref, p.ours]) setup?.(e);
  return p;
}

const STAMP: Array<[RegExp, string]> = [[/-\d{8}-\d{6}\.passh/g, "-<STAMP>.passh"]];

async function same(p: Pair, args: string[], o: MoreRunOptions = {}) {
  const r = await bothMore(p, args, { ...o, replace: [...STAMP, ...(o.replace ?? [])] });
  expect(visible(r.ours)).toEqual(visible(r.ref));
  return r;
}

const pty: MoreRunOptions = { pty: true, steps: [PASSPHRASE_STEP] };

function record(e: IsolatedEnv, revision: number, savedAt = "2026-11-15T12:00:00Z") {
  mkdirSync(join(e.stateHome, "passh"), { recursive: true, mode: 0o700 });
  const vaults = { [vault.data.vaultId]: { revision, saved_at: savedAt, seen_at: "2026-11-15T12:00:05Z" } };
  writeFileSync(join(e.stateHome, "passh", "revisions.json"), JSON.stringify({ version: 1, vaults }, null, 2) + "\n", { mode: 0o600 });
}

describe("verify", () => {
  test("the configured vault: good, and with --vault", async () => {
    const p = await newPair((e) => placeVault(join(e.home, "copy.passh"), vault.bytes));
    const r = await same(p, ["verify"]);
    expect(r.ref.code).toBe(0);
    expect(r.ref.stdout).toMatch(/^<ENV>\/data\/passh\/vault\.passh: OK\n {2}SHA-256 {3}[0-9a-f]{64}\n {2}size {6}\d+ bytes\n$/);
    await same(p, ["--vault", "~/copy.passh", "verify"]);
    await same(p, ["verify", "extra", "args"]);
  });

  test("files: relative, ~/, missing, a folder, too large, unreadable", async () => {
    const p = await newPair((e) => {
      placeVault(join(e.home, "copy.passh"), vault.bytes);
      mkdirSync(join(e.home, "dir"));
      writeFileSync(join(e.home, "big.passh"), "");
      truncateSync(join(e.home, "big.passh"), 64 * 1024 * 1024 + 1);
      placeVault(join(e.home, "noread.passh"), vault.bytes);
      chmodSync(join(e.home, "noread.passh"), 0);
    });
    const cwd = { cwd: (e: IsolatedEnv) => e.home };
    for (const f of ["copy.passh", "~/copy.passh", "./copy.passh", "nope.passh", "dir", "big.passh"]) await same(p, ["verify", f], cwd);
    if (!isRoot) await same(p, ["verify", "noread.passh"], cwd);
  });

  test("non-canonical with ignored text: notes", async () => {
    const p = await newPair((e) => writeFileSync(e.vault, crlf, { mode: 0o600 }));
    const r = await same(p, ["verify"]);
    expect(r.ref.stderr).toContain("passh: note: ignored 2 lines of text before the passh-vault line\n");
    expect(r.ref.stderr).toContain("passh: note: the file isn't in passh's canonical form");
  });

  test("damaged and not a vault: FAILED", async () => {
    const p = await newPair((e) => {
      writeFileSync(e.vault, vault.bytes.subarray(0, 900));
      writeFileSync(join(e.home, "junk"), "junk\n");
      writeFileSync(join(e.home, "empty"), "");
    });
    const r = await same(p, ["verify"]);
    expect(r.ref.code).toBe(1);
    expect(r.ref.stdout).toContain(": FAILED\n");
    await same(p, ["verify", "~/junk"]);
    await same(p, ["verify", "~/empty"]);
    await same(p, ["verify", "--full"], pty);
  });

  test("missing configured vault; no config; config rules with a file", async () => {
    const p = await newPair((e) => placeVault(join(e.home, "copy.passh"), vault.bytes), "", null);
    await same(p, ["verify"]);
    await same(p, ["verify", "--full"]);
    for (const e of [p.ref, p.ours]) rmSync(e.configFile);
    await same(p, ["verify"]);
    await same(p, ["verify", "~/copy.passh"]);
    await same(p, ["--config", "~/nope.toml", "verify", "~/copy.passh"]);
    // Audit #10, current behaviour: an invalid config file fails `verify <file>` too.
    for (const e of [p.ref, p.ours]) writeFileSync(e.configFile, "bogus = 1\n");
    await same(p, ["verify", "~/copy.passh"]);
    for (const e of [p.ref, p.ours]) writeFileSync(e.configFile, 'language = "en"\n');
    await same(p, ["verify", "~/copy.passh"]);
    for (const e of [p.ref, p.ours]) rmSync(e.configFile);
    await same(p, ["verify", "~/copy.passh"], { unset: ["HOME"] });
    await same(p, ["verify", "~/copy.passh"], { unset: ["HOME", "PASSH_CONFIG", "XDG_CONFIG_HOME"] });
  });

  test("--full with the passphrase: unseen, then the newest revision", async () => {
    const p = await newPair();
    const r1 = await same(p, ["verify", "--full"], pty);
    expect(r1.ref.stdout).toContain("  rollback  this machine hasn't seen this vault before\n");
    const r2 = await same(p, ["verify", "--full"], pty);
    expect(r2.ref.stdout).toContain("  rollback  OK: the newest revision seen on this machine (r5)\n");
  });

  test("--full: newer and OLDER than the record (also with rollback.warn = false)", async () => {
    const p = await newPair((e) => record(e, 2));
    const r = await same(p, ["verify", "--full"], pty);
    expect(r.ref.stdout).toContain("OK: newer than seen before on this machine (r2)");
    for (const e of [p.ref, p.ours]) record(e, 9, "2026-10-01T08:00:00Z");
    const o = await same(p, ["verify", "--full"], pty);
    expect(o.ref.stdout).toContain("OLDER than seen before on this machine (seen r9 of 2026-10-01)");
    expect(o.ref.code).toBe(0);
    const q = await newPair((e) => record(e, 9), "[rollback]\nwarn = false\n");
    await same(q, ["verify", "--full"], pty);
  });

  test("--full: damaged, newer and unreadable records", async () => {
    const p = await newPair((e) => {
      mkdirSync(join(e.stateHome, "passh"), { mode: 0o700 });
      writeFileSync(join(e.stateHome, "passh", "revisions.json"), "{not json");
    });
    await same(p, ["verify", "--full"], pty);
    for (const e of [p.ref, p.ours]) writeFileSync(join(e.stateHome, "passh", "revisions.json"), '{"version": 7}');
    await same(p, ["verify", "--full"], pty);
    if (!isRoot) {
      for (const e of [p.ref, p.ours]) chmodSync(join(e.stateHome, "passh", "revisions.json"), 0);
      await same(p, ["verify", "--full"], pty);
    }
  });

  test("--full: non-canonical (audit #13: the warnings twice)", async () => {
    const p = await newPair((e) => writeFileSync(e.vault, crlf, { mode: 0o600 }));
    const r = await same(p, ["verify", "--full"], pty);
    expect(r.ref.stderr).toContain("passh: warning: <ENV>/data/passh/vault.passh: ignored 2 lines of text before the passh-vault line");
  });

  test("--full: no terminal (vault is locked), wrong passphrase", async () => {
    const p = await newPair();
    const r = await same(p, ["verify", "--full"]);
    expect(r.ref.code).toBe(1);
    expect(r.ref.stdout).toContain(": OK\n");
    await same(p, ["verify", "--full"], { pty: true, steps: [["Passphrase: ", "a"], ["Passphrase: ", "b"], ["Passphrase: ", ""]] });
  });

  test("--full of a copy through the configured vault's agent", async () => {
    const p = await newPair((e) => placeVault(join(e.home, "copy.passh"), vault.bytes));
    try {
      await same(p, ["unlock"], pty);
      const r = await same(p, ["verify", "~/copy.passh", "--full"]);
      expect(r.ref.code).toBe(0);
      expect(r.ref.stdout).toContain("  entries   2\n");
      // Another key block: the configured vault's agent is silent, the copy's own has none.
      for (const e of [p.ref, p.ours]) placeVault(join(e.home, "copy.passh"), other.bytes);
      await same(p, ["verify", "~/copy.passh", "--full"]);
    } finally {
      await same(p, ["lock"]);
    }
  });
});

describe("backup", () => {
  test("to a new file, then refused over it", async () => {
    const p = await newPair();
    const r = await same(p, ["backup", "~/b.passh"]);
    expect(r.ref.code).toBe(0);
    expect(r.ref.stdout).toMatch(/^~\/b\.passh: OK\n {2}SHA-256 {3}[0-9a-f]{64}\n {2}size {6}\d+ bytes\n$/);
    expect(r.ref.stderr).toContain("The copy is byte for byte the vault");
    for (const e of [p.ref, p.ours]) expect(readFileSync(join(e.home, "b.passh"))).toEqual(Buffer.from(vault.bytes));
    await same(p, ["backup", "~/b.passh"]);
  });

  test("into a folder, also through a symlink and with a trailing /", async () => {
    const p = await newPair((e) => {
      mkdirSync(join(e.home, "bk"));
      mkdirSync(join(e.home, "bk2"));
      symlinkSync(join(e.home, "bk2"), join(e.home, "bklink"));
    });
    const r = await same(p, ["backup", "~/bk"]);
    expect(r.ref.stdout).toMatch(/^~\/bk\/vault-<STAMP>\.passh: OK\n/);
    await same(p, ["backup", "~/bklink/"]);
  });

  test("refusals: no such folder, a dangling symlink, an existing folder entry", async () => {
    const p = await newPair((e) => {
      symlinkSync("/nonexistent/x", join(e.home, "dangling"));
      writeFileSync(join(e.home, "file"), "x");
    });
    await same(p, ["backup", "~/nofolder/"]);
    await same(p, ["backup", "~/file/"]);
    await same(p, ["backup", "~/dangling"]);
    await same(p, ["backup", "~/dangling/"]);
    await same(p, ["backup"]);
  });

  // KNOWN DIFFERENCE (src/vault runBackup, storage.md §6.1 step 4 gives no wording): the
  // reference wraps a failed temporary file as `writing <dest>: open <tmp>: …`; ours says
  // `open <tmp>: …`. Same exit status, nothing written.
  test("a destination in a missing folder (known wording difference)", async () => {
    const p = await newPair();
    const r = await bothMore(p, ["backup", "~/nofolder/x.passh"]);
    expect(r.ours.code).toBe(r.ref.code);
    expect(r.ref.stderr).toMatch(/^passh: writing <ENV>\/home\/nofolder\/x\.passh: open <ENV>\/home\/nofolder\/\.x\.passh\.tmp-\d+: no such file or directory\n$/);
    expect(r.ours.stderr).toMatch(/open <ENV>\/home\/nofolder\/\.x\.passh\.tmp-\d+: no such file or directory\n$/);
  });

  test("a non-canonical vault is copied in canonical form", async () => {
    const p = await newPair((e) => writeFileSync(e.vault, crlf, { mode: 0o600 }));
    const r = await same(p, ["backup", "~/c.passh"]);
    expect(r.ref.stderr).toContain("The vault isn't in canonical form, so the copy was written in canonical form;\n");
    for (const e of [p.ref, p.ours]) expect(readFileSync(join(e.home, "c.passh"))).toEqual(Buffer.from(vault.bytes));
  });

  test("a damaged or missing vault isn't copied", async () => {
    const p = await newPair((e) => writeFileSync(e.vault, "junk\n"));
    await same(p, ["backup", "~/d.passh"]);
    for (const e of [p.ref, p.ours]) expect(existsSync(join(e.home, "d.passh"))).toBe(false);
    for (const e of [p.ref, p.ours]) rmSync(e.vault);
    await same(p, ["backup", "~/d.passh"]);
    for (const e of [p.ref, p.ours]) rmSync(e.configFile);
    await same(p, ["backup", "~/d.passh"]);
  });

  test("relative destination, and --vault", async () => {
    const p = await newPair((e) => placeVault(join(e.home, "w", "v2.passh"), vault.bytes));
    const cwd = { cwd: (e: IsolatedEnv) => e.home };
    await same(p, ["backup", "rel.passh"], cwd);
    await same(p, ["--vault", "w/v2.passh", "backup", "."], cwd);
  });
});

describe("backups", () => {
  function backupFile(e: IsolatedEnv, dir: string, name: string, bytes: Uint8Array) {
    const d = join(e.stateHome, "passh", "backups", dir);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    writeFileSync(join(d, name), bytes, { mode: 0o600 });
  }

  test("none yet", async () => {
    const r = await same(await newPair(), ["backups"]);
    expect(r.ref.stderr).toBe("No automatic backups yet. passh makes one before each save (backup.keep = 10).\n");
    await same(await newPair(undefined, "[backup]\nkeep = 3\n"), ["backups"]);
  });

  test("this vault's backups, newest first by counter", async () => {
    const p = await newPair((e) => {
      backupFile(e, vault.data.vaultId, "00000002-20261115T120031Z-r4.passh", vault.bytes);
      backupFile(e, vault.data.vaultId, "00000010-20261114T080000Z-r3.passh", vault.bytes);
      backupFile(e, vault.data.vaultId, "notabackup.passh", vault.bytes);
      backupFile(e, other.data.vaultId, "00000001-20261115T120031Z-r1.passh", other.bytes);
    });
    const r = await same(p, ["backups"]);
    expect(r.ref.stdout.split("\n")[0]).toContain("  r3  ");
  });

  test("notes: no backup with this key block; vault missing; vault damaged", async () => {
    const p = await newPair((e) => {
      backupFile(e, "zz-other", "00000001-20261115T120031Z-r1.passh", other.bytes);
      backupFile(e, "aa-other", "00000003-20261115T120031Z-r7.passh", other.bytes);
      backupFile(e, "aa-other", "00000004-20261116T120031Z-r8.passh", other.bytes);
    });
    const r = await same(p, ["backups"]);
    expect(r.ref.stderr).toContain("passh: note: no backup has this vault's current key block");
    for (const e of [p.ref, p.ours]) writeFileSync(e.vault, "junk\n");
    await same(p, ["backups"]);
    for (const e of [p.ref, p.ours]) rmSync(e.vault);
    const m = await same(p, ["backups"]);
    expect(m.ref.stderr).toContain("can't be read (stat ");
    for (const e of [p.ref, p.ours]) mkdirSync(e.vault);
    await same(p, ["backups"]);
  });

  test("vault missing and no backups at all; no config; --vault", async () => {
    const p = await newPair(undefined, "", null);
    await same(p, ["backups"]);
    await same(p, ["--vault", "~/x.passh", "backups"]);
    for (const e of [p.ref, p.ours]) rmSync(e.configFile);
    await same(p, ["backups"]);
    await same(p, ["backups", "x"]);
  });
});

test("ours alone: verify writes nothing on stdout for an unreadable file", async () => {
  const p = await newPair(undefined, "", null);
  const r = await runMore("ours", p.ours, ["verify", "/nonexistent/x"]);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
});
