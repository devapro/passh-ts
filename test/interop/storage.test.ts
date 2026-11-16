// Interop of the storage layer (src/vault) with the reference implementation
// (reference/passh-go, run as a black box; prompts on a PTY):
//
//   a. a vault made by passh-go opens and saves with our code, and vice versa; alternating saves
//      by each: revisions increment, one shared backups folder in seq order, the same lock
//      files, `backups` byte for byte the same;
//   b. a save waiting on the other implementation's lock fails with "changed";
//   c. `verify` and `verify --full`: stdout and stderr identical for good, non-canonical (CRLF,
//      re-wrapped, text around), damaged and truncated files;
//   d. `backup`: the same output and copies with the same SHA-256;
//   e. revisions.json written by one and read by the other: the same rollback warning, and the
//      TTY answer `y` updates the record for both; the record format is the same;
//   f. damaged data: the same list of backups (this vault's, or every one on the machine);
//   g. `backups` notes (missing vault, no match, none) identical; a backup file refuses saves.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, REF_BIN, run, writeConfig, type IsolatedEnv } from "../helpers/env.ts";
import { initVault, PASS, withPassphrase } from "../helpers/passh.ts";
import { spawnPty } from "../helpers/pty.ts";
import { armorText } from "../../src/age/index.ts";
import { h32, loadConfig, type Config } from "../../src/config/index.ts";
import { errorText } from "../../src/i18n/index.ts";
import { encryptData, generateVaultKey, unwrapKeyBlock, type X25519Identity } from "../../src/keys/index.ts";
import { addEntry, emptyContent } from "../../src/model/index.ts";
import { captureIO, type CapturedIO } from "../../src/util/io.ts";
import { parseContainer } from "../../src/vaultfile/index.ts";
import {
  createVault,
  decodeRecord,
  encodeRecord,
  identityKeySource,
  openVault,
  runBackup,
  runBackups,
  runVerify,
  vaultTestHooks,
  type OpenedVault,
  type OpenOptions,
} from "../../src/vault/index.ts";

const haveRef = existsSync(REF_BIN);
const te = new TextEncoder();

interface Out {
  code: number;
  stdout: string;
  stderr: string;
}

/** The reference without a terminal. */
async function ref(e: IsolatedEnv, args: string[]): Promise<Out> {
  const r = await run([REF_BIN, ...args], e.env);
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}

/** The reference on a PTY, answering `Passphrase: ` (and the given prompts); stderr without the prompts. */
async function refTty(e: IsolatedEnv, args: string[], answers: Array<[string, string]> = []): Promise<Out> {
  const r = await withPassphrase([REF_BIN], args, e, PASS, answers);
  const stderr = r.tty.replace(/\r\n/g, "\n").replace(/Passphrase: \n/g, "");
  return { code: r.code, stdout: r.stdout, stderr };
}

/** Runs one of our command cores the way the CLI will: stderr lines, then `passh: <error>`. */
async function ours(fn: (io: CapturedIO) => Promise<unknown>): Promise<Out> {
  const io = captureIO();
  let code = 0;
  try {
    await fn(io);
  } catch (e) {
    io.err.push("passh: " + errorText(e));
    code = 1;
  }
  return { code, stdout: io.out, stderr: io.err.map((l) => l + "\n").join("") };
}

async function keyOf(path: string): Promise<X25519Identity> {
  return unwrapKeyBlock(parseContainer(new Uint8Array(readFileSync(path))).keyBlock, te.encode(PASS));
}

function cfg(e: IsolatedEnv): Config {
  return loadConfig({ env: e.env });
}

function openOurs(e: IsolatedEnv, id: X25519Identity, extra: Partial<OpenOptions> = {}): Promise<OpenedVault> {
  return openVault(e.vault, { config: cfg(e), io: captureIO(), rollback: "prompt", sources: [identityKeySource(id, "passphrase")], env: e.env, ...extra });
}

async function ourSave(e: IsolatedEnv, id: X25519Identity, path: string): Promise<bigint> {
  const v = await openOurs(e, id);
  await v.save(addEntry(v.data, path, { ...emptyContent(), password: "pw-" + path }).data);
  const r = v.data.revision;
  v.close();
  return r;
}

describe.skipIf(!haveRef)("storage interop with passh-go", () => {
  let e: IsolatedEnv;
  let id: X25519Identity;
  let vaultId = "";

  beforeAll(async () => {
    e = isolatedEnv("istor");
    await writeConfig(e);
    await initVault([REF_BIN], e);
    id = await keyOf(e.vault);
  }, 60_000);
  afterAll(() => e?.cleanup());

  test("a. alternating saves: revisions, one backups folder in seq order, the same lock files", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await refTty(e, ["generate", `ref/${i}`]);
      expect(r.code).toBe(0);
      expect(await ourSave(e, id, `ts/${i}`)).toBe(BigInt(2 * i + 3));
    }
    const v = await openOurs(e, id);
    vaultId = v.data.vaultId;
    expect(v.data.revision).toBe(7n);
    expect(v.data.entries.map((x) => x.path).sort()).toEqual(["ref/0", "ref/1", "ref/2", "ts/0", "ts/1", "ts/2"]);
    v.close();
    const ls = await refTty(e, ["ls"]);
    expect(ls.stdout).toContain("ts/");
    const dir = join(e.stateHome, "passh", "backups", vaultId);
    const names = readdirSync(dir).sort();
    expect(names.map((n) => n.slice(0, 8))).toEqual(["00000001", "00000002", "00000003", "00000004", "00000005", "00000006"]);
    expect(names.map((n) => n.replace(/^.*-r/, "r"))).toEqual(["r1.passh", "r2.passh", "r3.passh", "r4.passh", "r5.passh", "r6.passh"]);
    const locks = readdirSync(join(e.stateHome, "passh", "locks")).sort();
    expect(locks).toEqual([`backups-${h32(vaultId)}.lock`, "revisions.lock", `vault-${h32(e.vault)}.lock`].sort());
    // `backups`, byte for byte
    const a = await ref(e, ["backups"]);
    const b = await ours((io) => runBackups({ config: cfg(e), vaultPath: e.vault, io, env: e.env }));
    expect(b).toEqual(a);
    expect(a.stdout.split("\n")).toHaveLength(7);
    // a vault we create opens in passh-go
    const e2 = isolatedEnv("istor2");
    try {
      await writeConfig(e2);
      const nid = generateVaultKey();
      const created = await createVault(e2.vault, { config: cfg(e2), io: captureIO(), identity: nid, passphrase: te.encode(PASS), env: e2.env });
      created.close();
      const r = await refTty(e2, ["generate", "from-ref"]);
      expect(r.code).toBe(0);
      const full = await refTty(e2, ["verify", "--full"]);
      expect(full.stdout).toContain("  revision  2\n");
      expect(full.stdout).toContain("  rollback  OK: the newest revision seen on this machine (r2)\n");
    } finally {
      e2.cleanup();
    }
  }, 120_000);

  test("b. a save waiting for the other implementation's lock fails with changed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const locked = new Promise<void>((r) => (held = r));
    vaultTestHooks.point = async (p) => {
      if (p === "locked") {
        held();
        await gate;
      }
    };
    try {
      const v = await openOurs(e, id);
      const ourSavePromise = v.save(addEntry(v.data, "lock/ours", { ...emptyContent(), password: "p" }).data);
      await locked;
      const p = spawnPty([REF_BIN, "generate", "lock/ref"], e.env);
      await p.expect("Passphrase: ");
      p.line(PASS);
      await Bun.sleep(1500); // the reference decrypts, then waits for our lock
      release();
      await ourSavePromise;
      v.close();
      const r = await p.wait();
      expect(r.code).toBe(1);
      expect(r.output).toContain("passh: vault changed on disk after it was opened (another passh, a sync tool or a copy); nothing was saved: reload and repeat the change");
    } finally {
      vaultTestHooks.point = undefined;
    }
  }, 60_000);

  test("c. verify and verify --full: identical output for good, non-canonical, damaged and truncated files", async () => {
    const bytes = readFileSync(e.vault);
    const text = bytes.toString("latin1");
    const variants: Record<string, string> = {
      "good.passh": text,
      "crlf.passh": text.replace(/\n/g, "\r\n"),
      "rewrap.passh": text.replace(/([A-Za-z0-9+/=]{64})\n(?=[A-Za-z0-9+/=])/g, "$1"),
      "around.passh": "Subject: my vault\n\n" + text + "\n-- \nsent from my phone\n",
      "damaged.passh": text.replace(/(-----END AGE ENCRYPTED FILE-----\n-----BEGIN AGE ENCRYPTED FILE-----\n)YWdl/, "$1YW!l"),
      "truncated.passh": text.slice(0, Math.floor(text.length * 0.8)),
      "empty.passh": "",
    };
    const config = cfg(e);
    for (const [name, content] of Object.entries(variants)) {
      const path = join(e.home, name);
      writeFileSync(path, content, "latin1");
      const a = await ref(e, ["verify", "~/" + name]);
      const b = await ours((io) => runVerify({ file: "~/" + name, config, full: false, io, env: e.env }));
      expect([name, b]).toEqual([name, a]);
    }
    for (const name of ["good.passh", "crlf.passh", "rewrap.passh", "around.passh", "damaged.passh", "truncated.passh"]) {
      const a = await refTty(e, ["verify", "--full", "~/" + name]);
      const b = await ours((io) => runVerify({ file: "~/" + name, config, full: true, io, env: e.env, sources: [identityKeySource(id, "passphrase")] }));
      expect([name, b]).toEqual([name, a]);
    }
    // missing, not regular
    mkdirSync(join(e.home, "dir.passh"));
    for (const name of ["missing.passh", "dir.passh"]) {
      const a = await ref(e, ["verify", "~/" + name]);
      const b = await ours((io) => runVerify({ file: "~/" + name, config, full: false, io, env: e.env }));
      expect([name, b]).toEqual([name, a]);
    }
  }, 120_000);

  test("d. backup: the same output and the same copies", async () => {
    const outA = join(e.home, "outA");
    const outB = join(e.home, "outB");
    mkdirSync(outA);
    mkdirSync(outB);
    const original = readFileSync(e.vault);
    for (const [label, content] of [
      ["canonical", original.toString("latin1")],
      ["crlf", "junk\n" + original.toString("latin1").replace(/\n/g, "\r\n")],
    ] as const) {
      writeFileSync(e.vault, content, "latin1");
      const a = await ref(e, ["backup", `~/outA/${label}.passh`]);
      const b = await ours((io) => runBackup({ source: e.vault, dest: `~/outB/${label}.passh`, io, env: e.env }));
      expect([label, b]).toEqual([label, { ...a, stdout: a.stdout.replace("outA", "outB"), stderr: a.stderr.replace("outA", "outB") }]);
      expect(readFileSync(join(outB, `${label}.passh`))).toEqual(readFileSync(join(outA, `${label}.passh`)));
      // existing destination
      const a2 = await ref(e, ["backup", `~/outA/${label}.passh`]);
      const b2 = await ours((io) => runBackup({ source: e.vault, dest: `~/outA/${label}.passh`, io, env: e.env }));
      expect(b2).toEqual(a2);
    }
    writeFileSync(e.vault, original);
    const a = await ref(e, ["backup", "~/nofolder/"]);
    const b = await ours((io) => runBackup({ source: e.vault, dest: "~/nofolder/", io, env: e.env }));
    expect(b).toEqual(a);
  }, 60_000);

  test("e. revisions.json shared: the same warning, `y` updates the record for both; the same format", async () => {
    const recPath = join(e.stateHome, "passh", "revisions.json");
    const fmt = () => {
      const text = readFileSync(recPath, "utf8");
      const r = decodeRecord(te.encode(text));
      expect(r.kind).toBe("ok");
      return r.kind === "ok" ? { text, canon: encodeRecord(r.vaults), rev: r.vaults.get(vaultId)!.revision } : { text, canon: "", rev: -1n };
    };
    let r = fmt();
    expect(r.text).toBe(r.canon); // the reference writes our format
    const current = r.rev;
    const dir = join(e.stateHome, "passh", "backups", vaultId);
    const backupOf = (rev: number) => join(dir, readdirSync(dir).find((n) => n.endsWith(`-r${rev}.passh`))!);
    const saved = readFileSync(e.vault);
    // an older copy: `verify --full` reports it the same way (report only, record unchanged)
    copyFileSync(backupOf(5), e.vault);
    const fa = await refTty(e, ["verify", "--full"]);
    const fb = await ours((io) => runVerify({ config: cfg(e), full: true, io, env: e.env, sources: [identityKeySource(id, "passphrase")] }));
    expect(fb).toEqual(fa);
    expect(fa.stdout).toContain(`  rollback  OLDER than seen before on this machine (seen r${current} of `);
    expect(fmt().rev).toBe(current);
    // a newer or damaged record: the same reports and warnings
    const keep = readFileSync(recPath);
    writeFileSync(recPath, '{"version": 2}');
    const na = await refTty(e, ["verify", "--full"]);
    const nb = await ours((io) => runVerify({ config: cfg(e), full: true, io, env: e.env, sources: [identityKeySource(id, "passphrase")] }));
    expect(nb).toEqual(na);
    writeFileSync(recPath, "{bad");
    const db = await ours((io) => runVerify({ config: cfg(e), full: true, io, env: e.env, sources: [identityKeySource(id, "passphrase")] }));
    const ourReplaced = readFileSync(recPath, "utf8");
    writeFileSync(recPath, "{bad");
    const da = await refTty(e, ["verify", "--full"]);
    expect(db).toEqual(da);
    const strip = (r: ReturnType<typeof decodeRecord>) => (r.kind === "ok" ? [...r.vaults].map(([k, v]) => [k, v.revision, v.savedAt]) : r.kind);
    expect(strip(decodeRecord(te.encode(ourReplaced)))).toEqual(strip(decodeRecord(readFileSync(recPath))));
    expect(strip(decodeRecord(te.encode(ourReplaced)))).toHaveLength(1);
    writeFileSync(recPath, keep);
    // our open without a terminal warns, record unchanged
    const io = captureIO();
    (await openOurs(e, id, { io })).close();
    expect(io.err).toHaveLength(1);
    const warning = io.err[0]!.replace("passh: warning: ", "");
    expect(fmt().rev).toBe(current);
    // the reference asks the same question; `y` updates the record
    const a = await refTty(e, ["ls"], [["[y/N] ", "y"]]);
    expect(a.stderr).toContain(`warning: ${warning}\nContinue with this copy? [y/N] y\n`);
    expect(fmt().rev).toBe(5n);
    // our open: no warning now
    const io2 = captureIO();
    (await openOurs(e, id, { io: io2 })).close();
    expect(io2.err).toEqual([]);
    // the other way round: our `y` to an even older copy, then the reference doesn't ask
    copyFileSync(backupOf(4), e.vault);
    const asked: string[] = [];
    (await openOurs(e, id, { confirmOlder: async (t) => (asked.push(t), true) })).close();
    expect(asked).toHaveLength(1);
    r = fmt();
    expect(r.rev).toBe(4n);
    expect(r.text).toBe(r.canon);
    const b = await refTty(e, ["ls"]);
    expect(b.stderr).not.toContain("Continue with this copy?");
    expect(b.code).toBe(0);
    // restore the newest and let both raise the record again
    writeFileSync(e.vault, saved);
    const c = await refTty(e, ["ls"]);
    expect(c.code).toBe(0);
    expect(fmt().rev).toBe(current);
  }, 60_000);

  test("f. damaged data: the same message and list of backups", async () => {
    const saved = readFileSync(e.vault);
    const c = parseContainer(new Uint8Array(saved));
    const write = (kb: Uint8Array, db: Uint8Array) => writeFileSync(e.vault, "passh-vault 1\n" + armorText(kb) + armorText(db));
    const compare = async () => {
      const a = await refTty(e, ["ls"]);
      let msg = "";
      try {
        (await openOurs(e, id)).close();
      } catch (err) {
        msg = "passh: " + errorText(err) + "\n";
      }
      expect(msg).not.toBe("");
      expect(msg).toBe(a.stderr);
    };
    try {
      const db = new Uint8Array(c.dataBlock);
      db[db.length - 1]! ^= 1;
      write(c.keyBlock, db);
      await compare();
      write(c.keyBlock, encryptData(te.encode("{}"), generateVaultKey()));
      await compare();
      write(c.keyBlock, encryptData(te.encode('{"format":"passh-vault-data","version":1,"revision":1}'), id));
      await compare();
      // a second vault on the machine with damaged data: every backup on the machine
      const other = join(e.home, "other.passh");
      const p = spawnPty([REF_BIN, "--vault", other, "init"], e.env);
      await p.expect("New passphrase: ");
      p.line(PASS);
      await p.expect("Repeat passphrase: ");
      p.line(PASS);
      await p.expect("[Y/n] ", 30_000);
      p.line("n");
      expect((await p.wait()).code).toBe(0);
      const oc = parseContainer(new Uint8Array(readFileSync(other)));
      const odb = new Uint8Array(oc.dataBlock);
      odb[odb.length - 1]! ^= 1;
      writeFileSync(other, "passh-vault 1\n" + armorText(oc.keyBlock) + armorText(odb));
      const oid = await unwrapKeyBlock(oc.keyBlock, te.encode(PASS));
      const a = await refTty(e, ["--vault", other, "ls"]);
      let msg = "";
      try {
        (await openVault(other, { config: cfg(e), io: captureIO(), rollback: "prompt", sources: [identityKeySource(oid, "passphrase")], env: e.env })).close();
      } catch (err) {
        msg = "passh: " + errorText(err) + "\n";
      }
      expect(msg).toContain("automatic backups on this machine, newest first:");
      expect(msg).toBe(a.stderr);
    } finally {
      writeFileSync(e.vault, saved);
    }
  }, 120_000);

  test("g. backups notes identical; a backup file refuses saves with the same message", async () => {
    const config = cfg(e);
    for (const vault of [join(e.home, "missing.passh"), join(e.home, "garbage.passh"), join(e.home, "dir.passh")]) {
      if (vault.endsWith("garbage.passh")) writeFileSync(vault, "garbage");
      const a = await ref(e, ["--vault", vault, "backups"]);
      const b = await ours((io) => runBackups({ config, vaultPath: vault, io, env: e.env }));
      expect([vault, b]).toEqual([vault, a]);
    }
    const dir = join(e.stateHome, "passh", "backups", vaultId);
    const backup = join(dir, readdirSync(dir).sort()[0]!);
    const a = await refTty(e, ["--vault", backup, "generate", "x/y"]);
    let msg = "";
    const v = await openVault(backup, { config, io: captureIO(), rollback: "prompt", sources: [identityKeySource(id, "passphrase")], env: e.env });
    try {
      await v.save(addEntry(v.data, "x/y", { ...emptyContent(), password: "p" }).data);
    } catch (err) {
      msg = "passh: " + errorText(err) + "\n";
    }
    v.close();
    expect(msg).toBe(a.stderr);
    // none at all, in a fresh environment
    const e3 = isolatedEnv("istor3");
    try {
      await writeConfig(e3);
      const a3 = await ref(e3, ["backups"]);
      const b3 = await ours((io) => runBackups({ config: cfg(e3), vaultPath: e3.vault, io, env: e3.env }));
      expect(b3).toEqual(a3);
      rmSync(e3.dir, { recursive: true, force: true });
    } finally {
      e3.cleanup();
    }
  }, 60_000);
});
