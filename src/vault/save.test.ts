// Unit tests of saving (storage.md §4): the steps and their messages, the exchange with
// put-back and conflict files, locks, leftovers, symlinks, refusals, the revision rule,
// cancellation, init (§4.6), and two saves at once (§4.7).

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "../fsx/index.ts";
import { h32 } from "../config/index.ts";
import { errorText, hasCode } from "../i18n/index.ts";
import { generateVaultKey, wrapKeyBlock } from "../keys/index.ts";
import { addEntry, cloneVaultData, emptyContent, MAX_REVISION } from "../model/index.ts";
import { ERRNO } from "../ffi/libc.ts";
import { createVault } from "./create.ts";
import { vaultTestHooks } from "./hooks.ts";
import { identityKeySource } from "./keysources.ts";
import { openVault } from "./open.ts";
import { copyOf, fixture, TEST_PASS, type Fixture } from "./testdata/helpers.ts";
import type { OpenedVault } from "./types.ts";
import { captureIO } from "../util/io.ts";

let f: Fixture | undefined;
afterEach(() => {
  f?.cleanup();
  f = undefined;
  for (const k of Object.keys(vaultTestHooks)) delete (vaultTestHooks as Record<string, unknown>)[k];
});

const CHANGED = "vault changed on disk after it was opened (another passh, a sync tool or a copy); nothing was saved: reload and repeat the change";

async function errOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

function change(v: OpenedVault, path = "a/b") {
  return addEntry(v.data, path, { ...emptyContent(), password: "secret-" + path }).data;
}

function tempFiles(dir: string, name = "vault.passh"): string[] {
  return readdirSync(dir).filter((n) => n.startsWith(`.${name}.tmp-`));
}

describe("a save (storage.md §4.2)", () => {
  test("revision + 1, saved_at now, backup of the replaced file, record updated, mode 0600, canonical", async () => {
    f = await fixture("save");
    const v = await f.open();
    const before = readFileSync(f.vault);
    await v.save(change(v));
    expect(v.data.revision).toBe(2n);
    expect(Math.abs(v.data.savedAt - Date.now() / 1000)).toBeLessThan(5);
    expect(statSync(f.vault).mode & 0o777).toBe(0o600);
    const dir = join(f.state, "backups", v.data.vaultId);
    const names = readdirSync(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^00000001-\d{8}T\d{6}Z-r1\.passh$/);
    expect(readFileSync(join(dir, names[0]!))).toEqual(before);
    expect(statSync(join(dir, names[0]!)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(f.state, "revisions.json"), "utf8")).toContain(`"revision": 2,`);
    expect(existsSync(join(f.state, "locks", `vault-${h32(f.vault)}.lock`))).toBe(true);
    expect(existsSync(join(f.state, "locks", `backups-${h32(v.data.vaultId)}.lock`))).toBe(true);
    expect(v.openedHash).toBe(new Bun.CryptoHasher("sha256").update(readFileSync(f.vault)).digest("hex"));
    expect(tempFiles(join(f.e.dataHome, "passh"))).toEqual([]);
    // the data in memory is the saved data; a second save works from it
    await v.save(change(v, "c"));
    expect(v.data.revision).toBe(3n);
    v.close();
    const w = await f.open();
    expect(w.data.entries.map((e) => e.path)).toEqual(["a/b", "c"]);
    w.close();
  });

  test("the revision rule: max(data, opened) + 1; refused at 2^64 − 1 (audit #32)", async () => {
    f = await fixture("save");
    const v = await f.open();
    const d = change(v);
    d.revision = 40n;
    await v.save(d);
    expect(v.data.revision).toBe(41n);
    const big = cloneVaultData(v.data);
    big.revision = MAX_REVISION;
    const e = await errOf(v.save(big));
    expect(hasCode(e, "revision-max")).toBe(true);
    expect(v.data.revision).toBe(41n);
    v.close();
  });

  test("backup.keep = 0: no backup, no backups folder", async () => {
    f = await fixture("save", { keep: 0 });
    const v = await f.open();
    await v.save(change(v));
    expect(existsSync(join(f.state, "backups"))).toBe(false);
    v.close();
  });

  test("changed on disk at step 2: nothing saved, data in memory unchanged", async () => {
    f = await fixture("save");
    const v = await f.open();
    const text = readFileSync(f.vault, "latin1");
    writeFileSync(f.vault, text.replace(/\n/g, "\r\n"), "latin1");
    const e = await errOf(v.save(change(v)));
    expect(errorText(e)).toBe(CHANGED);
    expect(hasCode(e, "changed")).toBe(true);
    expect(v.data.revision).toBe(1n);
    expect(v.data.entries).toEqual([]);
    // gone
    const { unlinkSync } = await import("node:fs");
    unlinkSync(f.vault);
    expect(hasCode(await errOf(v.save(change(v))), "changed")).toBe(true);
    v.close();
  });

  test("changed on disk at step 6: the temporary file is removed", async () => {
    f = await fixture("save");
    const v = await f.open();
    const text = readFileSync(f.vault, "latin1");
    vaultTestHooks.point = (p) => {
      if (p === "read-back") writeFileSync(f!.vault, text + "\n", "latin1");
    };
    const e = await errOf(v.save(change(v)));
    expect(errorText(e)).toBe(CHANGED);
    expect(tempFiles(join(f.e.dataHome, "passh"))).toEqual([]);
    expect(existsSync(join(f.state, "backups"))).toBe(false);
    v.close();
  });

  test("a replacement between step 6 and the exchange is put back", async () => {
    f = await fixture("save");
    const v = await f.open();
    const other = readFileSync(f.vault, "latin1").replace(/\n/g, "\r\n");
    vaultTestHooks.point = (p) => {
      if (p === "before-replace") {
        writeFileSync(f!.vault + ".x", other, "latin1");
        renameSync(f!.vault + ".x", f!.vault);
      }
    };
    const e = await errOf(v.save(change(v)));
    expect(errorText(e)).toBe(CHANGED);
    expect(readFileSync(f.vault, "latin1")).toBe(other);
    expect(tempFiles(join(f.e.dataHome, "passh"))).toEqual([]);
    expect(readdirSync(join(f.e.dataHome, "passh")).filter((n) => n.includes("conflict"))).toEqual([]);
    expect(v.data.revision).toBe(1n);
    v.close();
  });

  test("put-back fails: the other version is kept as a conflict file (-2 when the name is taken)", async () => {
    f = await fixture("save");
    const v = await f.open();
    const dir = join(f.e.dataHome, "passh");
    const other = readFileSync(f.vault, "latin1").replace(/\n/g, "\r\n");
    const now = Date.UTC(2026, 10, 15, 12, 0, 31);
    vaultTestHooks.now = () => now;
    writeFileSync(join(dir, "vault.conflict-20261115T120031Z.passh"), "taken");
    vaultTestHooks.point = (p) => {
      if (p === "before-replace") {
        writeFileSync(f!.vault + ".x", other, "latin1");
        renameSync(f!.vault + ".x", f!.vault);
      }
    };
    const { renameExchange } = await import("../ffi/libc.ts");
    let calls = 0;
    vaultTestHooks.exchangeSys = (a, b) => (++calls === 1 ? renameExchange(a, b) : ERRNO.EIO!);
    const e = await errOf(v.save(change(v)));
    const conflict = join(dir, "vault.conflict-20261115T120031Z-2.passh");
    expect(errorText(e)).toBe(`${CHANGED}; the save couldn't be undone (rename ${tempFilesBefore(e)} ${f.vault}: input/output error): the vault now holds this save, the other version is in ${conflict}`);
    expect(hasCode(e, "changed")).toBe(true);
    expect(readFileSync(conflict, "latin1")).toBe(other);
    // the vault holds this save
    v.close();
    const w = await f.open();
    expect(w.data.revision).toBe(2n);
    w.close();
  });

  test("a replaced file that can't be read is kept beside the vault; the save stands", async () => {
    f = await fixture("save");
    const v = await f.open();
    const dir = join(f.e.dataHome, "passh");
    vaultTestHooks.now = () => Date.UTC(2026, 10, 15, 12, 0, 31);
    const { chmodSync } = await import("node:fs");
    vaultTestHooks.point = (p) => {
      if (p === "before-replace") chmodSync(f!.vault, 0);
    };
    await v.save(change(v));
    const conflict = join(dir, "vault.conflict-20261115T120031Z.passh");
    expect(existsSync(conflict)).toBe(true);
    expect(f.io.err).toEqual([
      expect.stringMatching(new RegExp(`^passh: warning: the replaced vault file couldn't be checked \\(open ${dir}/\\.vault\\.passh\\.tmp-\\d+: permission denied\\); it is kept in ${conflict.replace(/[.]/g, "\\.")}$`)),
    ]);
    expect(v.data.revision).toBe(2n);
    chmodSync(conflict, 0o600);
    v.close();
  });

  test("exchange unsupported: plain rename", async () => {
    f = await fixture("save");
    vaultTestHooks.exchangeSys = () => ERRNO.EINVAL!;
    const v = await f.open();
    await v.save(change(v));
    expect(v.data.revision).toBe(2n);
    expect(tempFiles(join(f.e.dataHome, "passh"))).toEqual([]);
    v.close();
  });

  test("read-back failure: the vault is unchanged", async () => {
    f = await fixture("save");
    const v = await f.open();
    const before = readFileSync(f.vault);
    vaultTestHooks.point = (p, info) => {
      if (p === "temp-synced") writeFileSync(info.path, "garbage");
    };
    const e = await errOf(v.save(change(v)));
    expect(errorText(e)).toBe("the new vault file didn't read back as written; the vault is unchanged: the bytes read differ from those written");
    expect(readFileSync(f.vault)).toEqual(before);
    expect(tempFiles(join(f.e.dataHome, "passh"))).toEqual([]);
    v.close();
  });

  test("a busy vault lock gives up after the timeout", async () => {
    f = await fixture("save");
    vaultTestHooks.lockTimeoutMs = 150;
    const lock = await acquireLock(join(f.state, "locks", `vault-${h32(f.vault)}.lock`));
    try {
      const v = await f.open();
      const t0 = Date.now();
      const e = await errOf(v.save(change(v)));
      expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
      expect(errorText(e)).toBe("vault is being saved by another passh process; nothing was saved: try again");
      expect(hasCode(e, "busy")).toBe(true);
      v.close();
    } finally {
      lock.release();
    }
  });

  test("leftover temporary files are removed by the next save", async () => {
    f = await fixture("save");
    const dir = join(f.e.dataHome, "passh");
    writeFileSync(join(dir, ".vault.passh.tmp-123"), "x");
    writeFileSync(join(dir, ".vault.passh.tmp-"), "y");
    writeFileSync(join(dir, ".vault.passh.tmpX"), "kept");
    const v = await f.open();
    await v.save(change(v));
    expect(readdirSync(dir).sort()).toEqual([".vault.passh.tmpX", "vault.passh"]);
    v.close();
  });

  test("a symlinked vault keeps its link; the temporary file lies in the target's folder", async () => {
    f = await fixture("save");
    const linkDir = join(f.e.dir, "links");
    mkdirSync(linkDir);
    const link = join(linkDir, "v.passh");
    symlinkSync(f.vault, link);
    let tempDir = "";
    vaultTestHooks.point = (p, info) => {
      if (p === "temp-synced") tempDir = info.path.slice(0, info.path.lastIndexOf("/"));
    };
    const v = await openVault(link, { config: f.config, io: f.io, rollback: "prompt", sources: [identityKeySource(f.identity, "passphrase")], env: f.env });
    await v.save(change(v));
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(f.vault);
    expect(tempDir).toBe(join(f.e.dataHome, "passh"));
    v.close();
  });

  test("a file in the backups folder opens but never saves", async () => {
    f = await fixture("save");
    const v = await f.open();
    await v.save(change(v));
    v.close();
    const dir = join(f.state, "backups", v.data.vaultId);
    const backup = join(dir, readdirSync(dir)[0]!);
    const b = await openVault(backup, { config: f.config, io: f.io, rollback: "prompt", sources: [identityKeySource(f.identity, "passphrase")], env: f.env });
    expect(b.inBackups).toBe(true);
    const e = await errOf(b.save(change(b, "z")));
    expect(errorText(e)).toBe("this is an automatic backup: copy it out first (e.g. over the vault file) and open the copy");
    expect(hasCode(e, "in-backups")).toBe(true);
    b.close();
  });

  test("the state folder must be writable for every save", async () => {
    f = await fixture("save", { keep: 0 });
    const v = await f.open();
    const { chmodSync, unlinkSync } = await import("node:fs");
    unlinkSync(join(f.state, "locks", `vault-${h32(f.vault)}.lock`));
    chmodSync(join(f.state, "locks"), 0o500);
    try {
      const e = await errOf(v.save(change(v)));
      expect(errorText(e)).toBe(`opening the lock file: open ${join(f.state, "locks", `vault-${h32(f.vault)}.lock`)}: permission denied`);
    } finally {
      chmodSync(join(f.state, "locks"), 0o700);
    }
    v.close();
  });

  test("a read-only vault folder fails at step 4, before any backup", async () => {
    f = await fixture("save");
    const v = await f.open();
    const dir = join(f.e.dataHome, "passh");
    const { chmodSync } = await import("node:fs");
    chmodSync(dir, 0o500);
    try {
      const e = await errOf(v.save(change(v)));
      expect(errorText(e)).toMatch(new RegExp(`^writing the new vault file: open ${dir}/\\.vault\\.passh\\.tmp-\\d+: permission denied; the vault is unchanged$`));
      expect(existsSync(join(f.state, "backups"))).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
    }
    v.close();
  });

  test("cancellation before steps 2 and 3", async () => {
    f = await fixture("save");
    const v = await f.open();
    const ac = new AbortController();
    vaultTestHooks.point = (p) => {
      if (p === "locked") ac.abort();
    };
    const e = await errOf(v.save(change(v), { signal: ac.signal }));
    expect(hasCode(e, "cancelled")).toBe(true);
    expect(v.data.revision).toBe(1n);
    // a cancelled wait for the lock
    const lock = await acquireLock(join(f.state, "locks", `vault-${h32(f.vault)}.lock`));
    vaultTestHooks.point = undefined;
    const ac2 = new AbortController();
    setTimeout(() => ac2.abort(), 50);
    const e2 = await errOf(v.save(change(v), { signal: ac2.signal }));
    expect(errorText(e2)).toBe("stopped waiting for another passh process: context canceled");
    lock.release();
    v.close();
  });

  test("a save larger than 64 MiB is refused (audit #3)", async () => {
    f = await fixture("save", { keep: 0 });
    const v = await f.open();
    const d = addEntry(v.data, "big", { ...emptyContent(), notes: "x".repeat(49 * 1024 * 1024) }).data;
    const e = await errOf(v.save(d));
    expect(hasCode(e, "too-large")).toBe(true);
    expect(errorText(e)).toMatch(/^the vault file would be \d+ bytes, larger than 64 MiB, which passh can't open; nothing was saved$/);
    expect(tempFiles(join(f.e.dataHome, "passh"))).toEqual([]);
    v.close();
  }, 30_000);

  test("passwd-like save: a new key block; rekey-like: a new key", async () => {
    f = await fixture("save");
    const v = await f.open();
    const kb = await wrapKeyBlock(f.identity, new TextEncoder().encode("other"), 10);
    await v.save(cloneVaultData(v.data), { keyBlock: kb });
    expect(v.keyBlock).toEqual(kb);
    const nk = generateVaultKey();
    const kb2 = await wrapKeyBlock(nk, TEST_PASS, 10);
    await v.save(cloneVaultData(v.data), { keyBlock: kb2, identity: copyOf(nk) });
    v.close();
    const w = await openVault(f.vault, { config: f.config, io: f.io, rollback: "prompt", sources: [identityKeySource(nk, "passphrase")], env: f.env });
    expect(w.data.revision).toBe(3n);
    w.close();
  });
});

function tempFilesBefore(e: unknown): string {
  const m = /rename (\S+) /.exec(errorText(e));
  return m ? m[1]! : "?";
}

describe("concurrency (storage.md §4.7)", () => {
  test("two saves at once: the second waits for the lock, then fails with changed", async () => {
    f = await fixture("conc");
    const a = await f.open();
    const b = await f.open();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    vaultTestHooks.point = async (p) => {
      if (p === "locked" && first) {
        first = false;
        await gate;
      }
    };
    const pa = a.save(change(a, "from-a"));
    await Bun.sleep(30);
    const pb = errOf(b.save(change(b, "from-b")));
    await Bun.sleep(100);
    release();
    await pa;
    const e = await pb;
    expect(errorText(e)).toBe(CHANGED);
    a.close();
    b.close();
    const w = await f.open();
    expect(w.data.entries.map((x) => x.path)).toEqual(["from-a"]);
    expect(w.data.revision).toBe(2n);
    w.close();
  });
});

describe("init (storage.md §4.6)", () => {
  test("creates folders 0700, the file 0600 at revision 1, the record; never replaces", async () => {
    f = await fixture("init", { create: false });
    const path = join(f.e.dir, "new", "deep", "v.passh");
    const id = generateVaultKey();
    const io = captureIO();
    const v = await createVault(path, { config: f.config, io, identity: copyOf(id), passphrase: new TextEncoder().encode("pw"), env: f.env });
    expect(v.data.revision).toBe(1n);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.e.dir, "new")).mode & 0o777).toBe(0o700);
    expect(statSync(join(f.e.dir, "new", "deep")).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(f.state, "revisions.json"), "utf8")).toContain(`"revision": 1,`);
    v.close();
    const e = await errOf(createVault(path, { config: f.config, io, identity: copyOf(id), keyBlock: f.keyBlock, env: f.env }));
    expect(errorText(e)).toBe(`${path}: a file already exists there`);
    // a dangling symlink counts as existing
    const dangling = join(f.e.dir, "dangling.passh");
    symlinkSync(join(f.e.dir, "nowhere"), dangling);
    const e2 = await errOf(createVault(dangling, { config: f.config, io, identity: copyOf(id), keyBlock: f.keyBlock, env: f.env }));
    expect(errorText(e2)).toBe(`${dangling}: a file already exists there`);
  }, 20_000);

  test("a folder that can't be created", async () => {
    f = await fixture("init", { create: false });
    const file = join(f.e.dir, "afile");
    writeFileSync(file, "");
    const e = await errOf(createVault(join(file, "sub", "v.passh"), { config: f.config, io: f.io, identity: generateVaultKey(), keyBlock: f.keyBlock, env: f.env }));
    expect(errorText(e)).toBe(`creating the vault's folder: ${file} is not a folder`);
  });
});
