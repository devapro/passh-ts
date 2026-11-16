// Unit tests of opening (storage.md §3): the order of the checks and their messages, the data
// block failures with the list of backups (§3.2), recovery mode, changes and reload (§3.3).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { armorText } from "../age/index.ts";
import { errorText, hasCode } from "../i18n/index.ts";
import { encryptData, generateVaultKey } from "../keys/index.ts";
import { cloneVaultData, serializeVaultData } from "../model/index.ts";
import { parseContainer } from "../vaultfile/index.ts";
import { identityKeySource, paperKeySource } from "./keysources.ts";
import { openVault } from "./open.ts";
import { copyOf, fixture, type Fixture } from "./testdata/helpers.ts";
import type { KeySource } from "./types.ts";
import { withOpenHint } from "./errors.ts";
import { addEntry, emptyContent } from "../model/index.ts";

let f: Fixture | undefined;
afterEach(() => {
  f?.cleanup();
  f = undefined;
});

const te = new TextEncoder();

async function errOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

function blocks(path: string) {
  return parseContainer(new Uint8Array(readFileSync(path)));
}

function writeVault(path: string, keyBlock: Uint8Array, dataBlock: Uint8Array) {
  writeFileSync(path, "passh-vault 1\n" + armorText(keyBlock) + armorText(dataBlock));
}

/** Saves `n` changes so that backups exist. */
async function saves(fx: Fixture, n: number) {
  const v = await fx.open();
  for (let i = 0; i < n; i++) {
    const r = addEntry(v.data, `e/${i}`, { ...emptyContent(), password: "p" + i });
    await v.save(r.data);
  }
  v.close();
}

describe("order of checks (storage.md §3.1)", () => {
  test("a missing file: opening the vault: <os error>", async () => {
    f = await fixture("open");
    const e = await errOf(f.open({}).then(() => openVault(join(f!.e.dir, "nope.passh"), { config: f!.config, io: f!.io, rollback: "prompt", sources: [], env: f!.env })));
    expect(errorText(e)).toBe(`opening the vault: lstat ${join(f.e.dir, "nope.passh")}: no such file or directory`);
  });

  test("not a regular file", async () => {
    f = await fixture("open");
    const d = join(f.e.dir, "dir.passh");
    mkdirSync(d);
    const e = await errOf(openVault(d, { config: f.config, io: f.io, rollback: "prompt", sources: [], env: f.env }));
    expect(errorText(e)).toBe(`${d}: not a passh vault: not a regular file`);
  });

  test("larger than 64 MiB", async () => {
    f = await fixture("open");
    const big = join(f.e.dir, "big.passh");
    writeFileSync(big, "");
    truncateSync(big, 64 * 1024 * 1024 + 1);
    const e = await errOf(openVault(big, { config: f.config, io: f.io, rollback: "prompt", sources: [], env: f.env }));
    expect(errorText(e)).toBe(`${big}: not a passh vault: the file is larger than 64 MiB`);
  });

  test("damaged and truncated files never ask for a key", async () => {
    f = await fixture("open");
    let asked = false;
    const src: KeySource = {
      kind: "passphrase",
      async getKey() {
        asked = true;
        return undefined;
      },
    };
    const text = readFileSync(f.vault, "latin1");
    writeFileSync(f.vault, text.slice(0, 200), "latin1");
    let e = await errOf(f.open({ sources: [src] }));
    expect(errorText(e)).toBe(`${f.vault}: file is truncated: block 1 has no END line`);
    expect(hasCode(e, "truncated")).toBe(true);
    writeFileSync(f.vault, text.replace("-----BEGIN AGE ENCRYPTED FILE-----\nYWdl", "-----BEGIN AGE ENCRYPTED FILE-----\nYWd!"), "latin1");
    e = await errOf(f.open({ sources: [src] }));
    expect(errorText(e)).toBe(`${f.vault}: file is damaged (block 1): bad base64`);
    expect(errorText(withOpenHint(e))).toBe(
      `${f.vault}: file is damaged (block 1): bad base64\nThe key block only protects the vault key with the passphrase: if the data block is intact, \`passh recover\` with the paper recovery key writes a new key block`,
    );
    expect(asked).toBe(false);
  });

  test("ignored text: warnings through warnOnce, once per command", async () => {
    f = await fixture("open");
    const text = readFileSync(f.vault, "latin1");
    writeFileSync(f.vault, "hello\n\nworld\n" + text + "bye\n", "latin1");
    (await f.open()).close();
    (await f.open()).close();
    expect(f.io.err).toEqual([
      `passh: warning: ${f.vault}: ignored 2 lines of text before the passh-vault line`,
      `passh: warning: ${f.vault}: ignored 1 line of text after the last END line`,
    ]);
  });

  test("no source gives a key: vault is locked", async () => {
    f = await fixture("open");
    const none: KeySource = { kind: "agent", getKey: async () => undefined };
    const e = await errOf(f.open({ sources: [none] }));
    expect(errorText(e)).toBe("vault is locked: run `passh unlock` in a terminal (over SSH: `ssh -t host passh unlock`)");
    expect(hasCode(e, "locked")).toBe(true);
  });

  test("key sources are tried in order and get the request", async () => {
    f = await fixture("open");
    const seen: string[] = [];
    const a: KeySource = {
      kind: "agent",
      async getKey(req) {
        seen.push("agent " + req.keyBlockDigest.length + " " + (req.realPath === f!.vault));
        return undefined;
      },
    };
    const v = await f.open({ sources: [a, identityKeySource(f.identity, "passphrase")] });
    expect(seen).toEqual(["agent 64 true"]);
    expect(v.keySource).toBe("passphrase");
    expect(v.canonical).toBe(true);
    v.close();
  });

  test("a symlinked vault: path as given, real path resolved", async () => {
    f = await fixture("open");
    const link = join(f.e.dir, "link.passh");
    symlinkSync(f.vault, link);
    const v = await openVault(link, { config: f.config, io: f.io, rollback: "prompt", sources: [identityKeySource(f.identity, "passphrase")], env: f.env });
    expect(v.path).toBe(link);
    expect(v.realPath).toBe(f.vault);
    v.close();
  });
});

describe("a data block that doesn't open (storage.md §3.2)", () => {
  test("damaged payload: the list of this vault's backups, newest first", async () => {
    f = await fixture("damaged");
    await saves(f, 2);
    const c = blocks(f.vault);
    const db = new Uint8Array(c.dataBlock);
    db[db.length - 1]! ^= 1;
    writeVault(f.vault, c.keyBlock, db);
    const e = await errOf(f.open());
    const dir = join(f.state, "backups");
    const msg = errorText(e);
    const lines = msg.split("\n");
    expect(lines[0]).toBe(`${f.vault}: data is damaged; restore a backup`);
    expect(lines[1]).toBe("automatic backups of this vault, newest first:");
    expect(lines).toHaveLength(4);
    expect(lines[2]).toMatch(new RegExp(`^  \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d  r2  ${dir}/[0-9a-f-]{36}/00000002-\\d{8}T\\d{6}Z-r2\\.passh$`));
    expect(lines[3]).toMatch(/  r1  .*\/00000001-\d{8}T\d{6}Z-r1\.passh$/);
    expect(hasCode(e, "data-damaged")).toBe(true);
  });

  test("encrypted to another key: the 'isn't encrypted to this vault's key' text; matching by header", async () => {
    f = await fixture("damaged");
    await saves(f, 1);
    const c = blocks(f.vault);
    // another vault's data block under this key block: the key block still matches the backups
    writeVault(f.vault, c.keyBlock, encryptData(te.encode("{}"), generateVaultKey()));
    const e = await errOf(f.open());
    const lines = errorText(e).split("\n");
    expect(lines[0]).toBe(`${f.vault}: data is damaged; restore a backup (the data block isn't encrypted to this vault's key: damaged or replaced)`);
    expect(lines[1]).toBe("automatic backups of this vault, newest first:");
    expect(hasCode(e, "data-not-to-key")).toBe(true);
  });

  test("a foreign file: every backup on the machine; none at all", async () => {
    f = await fixture("damaged");
    await saves(f, 1);
    // a second vault in the same environment, with its own key, and damaged data
    const other = generateVaultKey();
    const { wrapKeyBlock } = await import("../keys/index.ts");
    const kb = await wrapKeyBlock(other, te.encode("x"), 10);
    const path = join(f.e.dir, "other.passh");
    const data = cloneVaultData(blocksData());
    const db = encryptData(serializeVaultData(data), other);
    db[db.length - 1]! ^= 1;
    writeVault(path, kb, db);
    const open = () => openVault(path, { config: f!.config, io: f!.io, rollback: "prompt", sources: [identityKeySource(other, "passphrase")], env: f!.env });
    let lines = errorText(await errOf(open())).split("\n");
    expect(lines[0]).toBe(`${path}: data is damaged; restore a backup`);
    expect(lines[1]).toBe("automatic backups on this machine, newest first:");
    expect(lines).toHaveLength(3);
    // no backups at all
    const { rmSync } = await import("node:fs");
    rmSync(join(f.state, "backups"), { recursive: true });
    lines = errorText(await errOf(open())).split("\n");
    expect(lines).toEqual([`${path}: data is damaged; restore a backup`, "no automatic backups of this vault were found; use another copy (passh verify --full <copy>)"]);
  });

  test("a paper key that doesn't open: no list", async () => {
    f = await fixture("damaged");
    const e = await errOf(f.open({ sources: [paperKeySource(generateVaultKey())] }));
    expect(errorText(e)).toBe(`${f.vault}: this key doesn't open this vault (rekeyed elsewhere? wrong recovery key?)`);
    expect(hasCode(e, "wrong-recovery-key")).toBe(true);
  });

  test("invalid JSON: invalid vault data with the list", async () => {
    f = await fixture("damaged");
    const c = blocks(f.vault);
    writeVault(f.vault, c.keyBlock, encryptData(te.encode('{"format":"passh-vault-data","version":1,"revision":1}'), f.identity));
    const e = await errOf(f.open());
    const lines = errorText(e).split("\n");
    expect(lines[0]).toBe(`${f.vault}: data is damaged; restore a backup (invalid vault data: missing or bad vault_id)`);
    expect(lines[1]).toBe("no automatic backups of this vault were found; use another copy (passh verify --full <copy>)");
    expect(hasCode(e, "data-damaged")).toBe(true);
  });

  test("newer data version", async () => {
    f = await fixture("damaged");
    const c = blocks(f.vault);
    writeVault(f.vault, c.keyBlock, encryptData(te.encode('{"format":"passh-vault-data","version":2}'), f.identity));
    const e = await errOf(f.open());
    expect(errorText(e)).toBe(`${f.vault}: made by a newer passh; upgrade passh (data version)`);
  });
});

function blocksData() {
  return {
    format: "passh-vault-data",
    version: 1,
    vaultId: "11111111-2222-4333-8444-555555555555",
    revision: 1n,
    savedAt: 0,
    entries: [],
    deleted: [],
    unknown: new Map(),
  };
}

describe("recovery mode (vault-format.md §3.6)", () => {
  test("a damaged key block: the last block is the data block; only a save with a new key block", async () => {
    f = await fixture("recover");
    const text = readFileSync(f.vault, "latin1");
    const damaged = text.replace("-----BEGIN AGE ENCRYPTED FILE-----\nYWdl", "-----BEGIN AGE ENCRYPTED FILE-----\nYWd!");
    writeFileSync(f.vault, damaged, "latin1");
    const v = await f.open({ recoveryMode: true, sources: [paperKeySource(f.identity)] });
    expect(v.keyBlockDamaged).toBe(true);
    expect(f.io.err).toContain(`passh: warning: ${f.vault}: the key block is damaged; setting a new passphrase rewrites it`);
    const e = await errOf(v.save(cloneVaultData(v.data)));
    expect(errorText(e)).toBe("the key block is damaged: set a new passphrase first (passh recover)");
    expect(hasCode(e, "key-block-damaged")).toBe(true);
    await v.save(cloneVaultData(v.data), { keyBlock: f.keyBlock });
    expect(v.keyBlockDamaged).toBe(false);
    v.close();
    const w = await f.open();
    expect(w.data.revision).toBe(2n);
    w.close();
  });

  test("a damaged key block and a wrong key: the block-1 error", async () => {
    f = await fixture("recover");
    const text = readFileSync(f.vault, "latin1");
    writeFileSync(f.vault, text.replace("-----BEGIN AGE ENCRYPTED FILE-----\nYWdl", "-----BEGIN AGE ENCRYPTED FILE-----\nYWd!"), "latin1");
    const e = await errOf(f.open({ recoveryMode: true, sources: [paperKeySource(generateVaultKey())] }));
    expect(errorText(e)).toBe(`${f.vault}: file is damaged (block 1): bad base64`);
  });

  test("outside recovery mode the same file fails at the container check", async () => {
    f = await fixture("recover");
    const text = readFileSync(f.vault, "latin1");
    writeFileSync(f.vault, text.replace("-----BEGIN AGE ENCRYPTED FILE-----\nYWdl", "-----BEGIN AGE ENCRYPTED FILE-----\nYWd!"), "latin1");
    const e = await errOf(f.open({ sources: [paperKeySource(f.identity)] }));
    expect(errorText(e)).toBe(`${f.vault}: file is damaged (block 1): bad base64`);
  });
});

describe("changes and reload (storage.md §3.3)", () => {
  test("changedOnDisk: other bytes, gone, retargeted; a byte-identical copy is no change", async () => {
    f = await fixture("changed");
    const link = join(f.e.dir, "link.passh");
    symlinkSync(f.vault, link);
    const v = await openVault(link, { config: f.config, io: f.io, rollback: "prompt", sources: [identityKeySource(f.identity, "passphrase")], env: f.env });
    expect(await v.changedOnDisk()).toBe(false);
    const bytes = readFileSync(f.vault);
    // a byte-identical replacement (new inode)
    writeFileSync(f.vault + ".new", bytes);
    renameSync(f.vault + ".new", f.vault);
    expect(await v.changedOnDisk()).toBe(false);
    // retargeted symlink to an identical copy
    const copy = join(f.e.dir, "copy.passh");
    writeFileSync(copy, bytes);
    const { unlinkSync } = await import("node:fs");
    unlinkSync(link);
    symlinkSync(copy, link);
    expect(await v.changedOnDisk()).toBe(true);
    unlinkSync(link);
    symlinkSync(f.vault, link);
    expect(await v.changedOnDisk()).toBe(false);
    writeFileSync(f.vault, Buffer.concat([bytes, Buffer.from("\n")]));
    expect(await v.changedOnDisk()).toBe(true);
    unlinkSync(f.vault);
    expect(await v.changedOnDisk()).toBe(true);
    v.close();
  });

  test("reload tries the current key first when the key block is unchanged", async () => {
    f = await fixture("reload");
    const v = await f.open();
    // another process saves a change
    const w = await f.open();
    await w.save(addEntry(w.data, "x", { ...emptyContent(), password: "p" }).data);
    w.close();
    expect(await v.changedOnDisk()).toBe(true);
    let asked = 0;
    const counting: KeySource = {
      kind: "passphrase",
      async getKey() {
        asked++;
        return undefined;
      },
    };
    const r = await v.reload({ config: f.config, io: f.io, rollback: "prompt", sources: [counting], env: f.env });
    expect(asked).toBe(0);
    expect(r.data.revision).toBe(2n);
    expect(r.data.entries.map((e) => e.path)).toEqual(["x"]);
    // a changed key block goes through the sources
    const { wrapKeyBlock } = await import("../keys/index.ts");
    await r.save(cloneVaultData(r.data), { keyBlock: await wrapKeyBlock(f.identity, te.encode("new"), 10) });
    const e = await errOf(v.reload({ config: f.config, io: f.io, rollback: "prompt", sources: [counting], env: f.env }));
    expect(asked).toBe(1);
    expect(hasCode(e, "locked")).toBe(true);
    r.close();
    v.close();
  });

  test("close wipes the key", async () => {
    f = await fixture("reload");
    const v = await f.open();
    const id = v.identity();
    v.close();
    expect(id.wiped).toBe(true);
    expect(() => v.identity()).toThrow();
    expect(copyOf(f.identity).wiped).toBe(false);
  });
});
