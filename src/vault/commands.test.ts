// Unit tests of the command cores: `verify` (storage.md §6.2), `backup` (§6.1), `backups` (§5.4).

import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorText, hasCode } from "../i18n/index.ts";
import { addEntry, emptyContent } from "../model/index.ts";
import { captureIO } from "../util/io.ts";
import { runBackup, runBackups, runVerify } from "./commands.ts";
import { identityKeySource } from "./keysources.ts";
import { fixture, type Fixture } from "./testdata/helpers.ts";
import type { KeySource } from "./types.ts";
import { vaultTestHooks } from "./hooks.ts";

let f: Fixture | undefined;
afterEach(() => {
  f?.cleanup();
  f = undefined;
  vaultTestHooks.now = undefined;
});

async function errOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

const sha = (b: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

/** A fixture whose vault lives under $HOME (so paths print as `~/…`). */
async function homeFixture(name: string, keep?: number) {
  const fx = await fixture(name, { keep });
  const vault = join(fx.e.home, "v.passh");
  copyFileSync(fx.vault, vault);
  fx.config.vault = vault;
  return { fx, vault };
}

describe("verify (storage.md §6.2)", () => {
  test("OK: the three lines; notes for ignored text and a non-canonical file", async () => {
    const { fx, vault } = await homeFixture("verify");
    f = fx;
    let io = captureIO();
    await runVerify({ config: fx.config, full: false, io, env: fx.env });
    const bytes = readFileSync(vault);
    expect(io.out).toBe(`~/v.passh: OK\n  SHA-256   ${sha(bytes)}\n  size      ${bytes.length} bytes\n`);
    expect(io.err).toEqual([]);
    const crlf = join(fx.e.home, "crlf.passh");
    writeFileSync(crlf, "junk\n" + bytes.toString("latin1").replace(/\n/g, "\r\n") + "a\nb\n", "latin1");
    io = captureIO();
    await runVerify({ file: "~/crlf.passh", config: fx.config, full: false, io, env: fx.env });
    expect(io.out.split("\n")[0]).toBe("~/crlf.passh: OK");
    expect(io.err).toEqual([
      "passh: note: ignored 1 line of text before the passh-vault line",
      "passh: note: ignored 2 lines of text after the last END line",
      "passh: note: the file isn't in passh's canonical form (line endings or line wrapping changed in copying); it opens, and `passh backup` writes a canonical copy",
    ]);
  });

  test("FAILED: the lines, then the error", async () => {
    const { fx } = await homeFixture("verify");
    f = fx;
    const t = join(fx.e.home, "t.passh");
    writeFileSync(t, readFileSync(fx.vault, "latin1").slice(0, 300), "latin1");
    const io = captureIO();
    const e = await errOf(runVerify({ file: t, config: fx.config, full: false, io, env: fx.env }));
    expect(io.out).toBe(`~/t.passh: FAILED\n  SHA-256   ${sha(readFileSync(t))}\n  size      300 bytes\n`);
    expect(errorText(e)).toBe("~/t.passh: file is truncated: block 1 has no END line");
  });

  test("files that can't be read print nothing on stdout", async () => {
    const { fx } = await homeFixture("verify");
    f = fx;
    const io = captureIO();
    const missing = join(fx.e.home, "missing.passh");
    expect(errorText(await errOf(runVerify({ file: missing, full: false, io, env: fx.env })))).toBe(`stat ${missing}: no such file or directory`);
    const dir = join(fx.e.home, "dir");
    mkdirSync(dir);
    expect(errorText(await errOf(runVerify({ file: dir, full: false, io, env: fx.env })))).toBe("~/dir is not a regular file");
    const big = join(fx.e.home, "big");
    writeFileSync(big, "");
    truncateSync(big, 64 * 1024 * 1024 + 1);
    expect(errorText(await errOf(runVerify({ file: big, full: false, io, env: fx.env })))).toBe("~/big is larger than 64 MiB: not a passh vault");
    fx.config.vault = join(fx.e.home, "gone.passh");
    const e = await errOf(runVerify({ config: fx.config, full: false, io, env: fx.env }));
    expect(errorText(e)).toBe("no vault at ~/gone.passh: run `passh init` to create one, or pass --vault <file>");
    expect(hasCode(e, "no-vault")).toBe(true);
    expect(io.out).toBe("");
  });

  test("--full: the five lines; sources in order; the rollback report", async () => {
    const { fx, vault } = await homeFixture("verify");
    f = fx;
    const asked: string[] = [];
    const agent = (p: string): KeySource => ({
      kind: "agent",
      async getKey() {
        asked.push(p);
        return undefined;
      },
    });
    // the config names another existing file: its agent is asked second
    fx.config.vault = fx.vault;
    let io = captureIO();
    await runVerify({ file: vault, config: fx.config, full: true, io, env: fx.env, agentSource: agent, passphrase: identityKeySource(fx.identity, "passphrase") });
    expect(asked).toEqual([vault, fx.vault]);
    const lines = io.out.split("\n");
    expect(lines.slice(3)).toEqual([
      expect.stringMatching(/^  vault_id  [0-9a-f-]{36}$/),
      "  revision  1",
      expect.stringMatching(/^  saved_at  \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC$/),
      "  entries   0",
      "  rollback  OK: the newest revision seen on this machine (r1)",
      "",
    ]);
    // the configured vault saves twice; the copy is now older
    const v = await fx.open();
    await v.save(addEntry(v.data, "a", { ...emptyContent(), password: "p" }).data);
    v.close();
    io = captureIO();
    await runVerify({ file: vault, config: fx.config, full: true, io, env: fx.env, sources: [identityKeySource(fx.identity, "passphrase")] });
    const today = new Date().toISOString().slice(0, 10);
    expect(io.out.split("\n")[7]).toBe(`  rollback  OLDER than seen before on this machine (seen r2 of ${today})`);
    expect(io.err).toEqual([
      `passh: warning: this copy is older than one seen before on this machine (r1 of ${today}; seen r2 of ${today}). If you didn't restore it on purpose, the file may have been replaced.`,
    ]);
    // a failed open keeps the three lines and nothing more
    io = captureIO();
    const e = await errOf(runVerify({ file: vault, config: fx.config, full: true, io, env: fx.env, sources: [] }));
    expect(hasCode(e, "locked")).toBe(true);
    expect(io.out.split("\n")).toHaveLength(4);
  });
});

describe("backup (storage.md §6.1)", () => {
  test("into a folder, to a file, never over an existing file", async () => {
    const { fx, vault } = await homeFixture("backup");
    f = fx;
    const out = join(fx.e.home, "out");
    mkdirSync(out);
    let io = captureIO();
    await runBackup({ source: vault, dest: "~/out", io, env: fx.env });
    const names = readdirSync(out);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^v-\d{8}-\d{6}\.passh$/);
    const bytes = readFileSync(vault);
    expect(io.out).toBe(`~/out/${names[0]}: OK\n  SHA-256   ${sha(bytes)}\n  size      ${bytes.length} bytes\n`);
    expect(io.err).toEqual([`Backed up ~/v.passh to ~/out/${names[0]}.`, "The copy is byte for byte the vault; `passh verify` shows the same SHA-256 for both."]);
    io = captureIO();
    await runBackup({ source: vault, dest: join(out, "x.passh"), io, env: fx.env });
    expect(readFileSync(join(out, "x.passh"))).toEqual(bytes);
    const e = await errOf(runBackup({ source: vault, dest: join(out, "x.passh"), io: captureIO(), env: fx.env }));
    expect(errorText(e)).toBe(`${join(out, "x.passh")}: a file already exists there; passh doesn't overwrite files`);
    symlinkSync(join(out, "nowhere"), join(out, "dangling.passh"));
    expect(errorText(await errOf(runBackup({ source: vault, dest: join(out, "dangling.passh"), io: captureIO(), env: fx.env })))).toBe(
      `${join(out, "dangling.passh")}: a file already exists there; passh doesn't overwrite files`,
    );
    expect(errorText(await errOf(runBackup({ source: vault, dest: "~/nofolder/", io: captureIO(), env: fx.env })))).toBe("~/nofolder: no such folder");
    // a symlink to a folder keeps the link's name in messages
    symlinkSync(out, join(fx.e.home, "outlink"));
    io = captureIO();
    vaultTestHooks.now = () => Date.UTC(2030, 0, 2, 3, 4, 5);
    await runBackup({ source: vault, dest: "~/outlink/", io, env: fx.env });
    expect(io.out).toMatch(/^~\/outlink\/v-20300102-030405\.passh: OK\n/);
    expect(readdirSync(out).filter((n) => n.startsWith("."))).toEqual([]);
  });

  test("a non-canonical source is copied in canonical form; a damaged one isn't copied", async () => {
    const { fx, vault } = await homeFixture("backup");
    f = fx;
    const canonical = readFileSync(vault);
    writeFileSync(vault, "hello\n" + canonical.toString("latin1").replace(/\n/g, "\r\n"), "latin1");
    const io = captureIO();
    await runBackup({ source: vault, dest: "~/c.passh", io, env: fx.env });
    expect(readFileSync(join(fx.e.home, "c.passh"))).toEqual(canonical);
    expect(io.out).toBe(`~/c.passh: OK\n  SHA-256   ${sha(canonical)}\n  size      ${canonical.length} bytes\n`);
    expect(io.err).toEqual([
      "Backed up ~/v.passh to ~/c.passh.",
      "The vault isn't in canonical form, so the copy was written in canonical form;",
      "its SHA-256 differs from the vault's, and the stock age tool reads its blocks (§8).",
    ]);
    writeFileSync(vault, "garbage");
    const e = await errOf(runBackup({ source: vault, dest: "~/d.passh", io: captureIO(), env: fx.env }));
    expect(errorText(e)).toBe(`${vault} doesn't pass the structure check, so it isn't copied: not a passh vault`);
    mkdirSync(join(fx.e.home, "dirvault"));
    expect(errorText(await errOf(runBackup({ source: join(fx.e.home, "dirvault"), dest: "~/d.passh", io: captureIO(), env: fx.env })))).toBe(
      `${join(fx.e.home, "dirvault")}: not a passh vault: not a regular file`,
    );
  });
});

describe("backups (storage.md §5.4)", () => {
  test("this vault's backups; no match; can't be read; none", async () => {
    const fx = await fixture("backups");
    f = fx;
    const v = await fx.open();
    for (let i = 0; i < 2; i++) await v.save(addEntry(v.data, `e${i}`, { ...emptyContent(), password: "p" }).data);
    v.close();
    const dir = join(fx.state, "backups", v.data.vaultId);
    const names = readdirSync(dir).sort().reverse();
    const line = (n: string) => `${n.slice(9, 13)}-${n.slice(13, 15)}-${n.slice(15, 17)} ${n.slice(18, 20)}:${n.slice(20, 22)}:${n.slice(22, 24)}  r${n.match(/-r(\d+)\.passh$/)![1]}  ${join(dir, n)}\n`;
    let io = captureIO();
    await runBackups({ config: fx.config, vaultPath: fx.vault, io, env: fx.env });
    expect(io.out).toBe(names.map(line).join(""));
    expect(io.err).toEqual([]);
    // a damaged file: no match
    writeFileSync(join(fx.e.dir, "g.passh"), "garbage");
    io = captureIO();
    await runBackups({ config: fx.config, vaultPath: join(fx.e.dir, "g.passh"), io, env: fx.env });
    expect(io.out).toBe(names.map(line).join(""));
    expect(io.err).toEqual([
      "passh: note: no backup has this vault's current key block (it was changed by passwd or rekey and not saved since, or the file is damaged); listing every automatic backup on this machine",
    ]);
    // missing
    io = captureIO();
    const missing = join(fx.e.home, "m.passh");
    await runBackups({ config: fx.config, vaultPath: missing, io, env: fx.env });
    expect(io.err).toEqual([`passh: note: ~/m.passh can't be read (stat ${missing}: no such file or directory); listing every automatic backup on this machine`]);
    // none
    const empty = await fixture("backups2");
    try {
      io = captureIO();
      await runBackups({ config: empty.config, vaultPath: empty.vault, io, env: empty.env });
      expect(io.out).toBe("");
      expect(io.err).toEqual(["No automatic backups yet. passh makes one before each save (backup.keep = 10)."]);
      io = captureIO();
      mkdirSync(join(empty.e.dir, "d.passh"));
      await runBackups({ config: empty.config, vaultPath: join(empty.e.dir, "d.passh"), io, env: empty.env });
      expect(io.err).toEqual([
        `passh: note: ${join(empty.e.dir, "d.passh")} can't be read (not a passh vault: not a regular file); listing every automatic backup on this machine`,
        "No automatic backups yet. passh makes one before each save (backup.keep = 10).",
      ]);
    } finally {
      empty.cleanup();
    }
  });
});
