// Side by side with the reference: `passh init [--vault file]` (cli.md §2.2, storage.md §2.5):
// the config file written or left alone, the recovery sheet question and its failures.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PASS } from "../helpers/passh.ts";
import { both, makePair, runSide, type Answer, type Outcome, type Pair } from "./side.ts";
import { readVaultWithPassphrase } from "./vaults.ts";

const pairs: Pair[] = [];
afterAll(() => {
  for (const p of pairs) p.cleanup();
});

/** A pair with no config file and no vault. */
async function fresh(name: string, withConfig = false): Promise<Pair> {
  const p = await makePair(name);
  if (!withConfig) for (const e of [p.ref, p.ours]) rmSync(e.configFile, { force: true });
  pairs.push(p);
  return p;
}

const NEW: Answer[] = [
  ["New passphrase: ", PASS],
  ["Repeat passphrase: ", PASS],
];
const Q = "[Y/n] ";
const SHEET = /\]: $/;
const TMPNAME: Array<[RegExp, string]> = [[/\.tmp-\d+/g, ".tmp-N"]];

async function same(p: Pair, args: string[], o: Parameters<typeof both>[2]): Promise<{ ref: Outcome; ours: Outcome }> {
  const r = await both(p, args, { replace: TMPNAME, ...o });
  expect(r.ours).toEqual(r.ref);
  return r;
}

/** The config files both sides wrote are the same (env folder normalized). */
function sameConfig(p: Pair) {
  const read = (e: Pair["ref"]) => readFileSync(e.configFile, "utf8").split(e.dir).join("<ENV>");
  expect(read(p.ours)).toBe(read(p.ref));
  expect(statSync(p.ours.configFile).mode & 0o777).toBe(statSync(p.ref.configFile).mode & 0o777);
}

describe("init", () => {
  test("no config file: the vault, the config file, no sheet", async () => {
    const p = await fresh("init1");
    const r = await same(p, ["init"], { pty: true, answers: [...NEW, [Q, "n"]] });
    expect(r.ref.code).toBe(0);
    sameConfig(p);
    for (const e of [p.ref, p.ours]) {
      const { data } = await readVaultWithPassphrase(e.vault, PASS);
      expect(data.revision).toBe(1n);
      expect(data.entries).toEqual([]);
      expect(statSync(e.vault).mode & 0o777).toBe(0o600);
    }
    // each side's vault opens in the other implementation
    expect((await runSide("ref", p.ours, ["ls"], { pty: true })).code).toBe(0);
    expect((await runSide("ours", p.ref, ["ls"], { pty: true })).code).toBe(0);
    // again: the vault exists, before any prompt or terminal check
    await same(p, ["init"], {});
    await same(p, ["init"], { pty: true, answers: [] });
  }, 120_000);

  test("a config file naming this vault, another vault; --vault under $HOME; weak passphrase", async () => {
    const p = await fresh("init2", true);
    await same(p, ["init"], { pty: true, answers: [["New passphrase: ", "abc"], ["Repeat passphrase: ", "abc"], [Q, "\x04", "raw"]] });
    await same(p, ["init", "--vault", "~/v2.passh"], { pty: true, answers: [...NEW, [Q, "x"], [Q, "x"], [Q, "x"]] });
    await same(p, ["--vault", "sub/v3.passh", "init"], { pty: true, answers: [...NEW, [Q, "N"]], cwd: (e) => e.home });
    for (const e of [p.ref, p.ours]) expect(existsSync(join(e.home, "sub/v3.passh"))).toBe(true);
  }, 120_000);

  test("errors: no terminal, invalid config, --config missing, unwritable folder, Ctrl-C at the passphrase", async () => {
    const p = await fresh("init3");
    await same(p, ["init"], {});
    await same(p, ["init", "--config", "/nonexistent/c.toml"], {});
    await same(p, ["init", "x"], {});
    await same(p, ["init", "--vault", "/proc/nope/v.passh"], { pty: true, answers: NEW });
    await same(p, ["init"], { pty: true, answers: [["New passphrase: ", "\x03", "raw"]] });
    await same(p, ["init"], { pty: true, answers: [["New passphrase: ", "a"], ["Repeat passphrase: ", "b"], ["New passphrase: ", ""], ["New passphrase: ", "\x04", "raw"]] });
    for (const e of [p.ref, p.ours]) writeFileSync(e.configFile, "vault = 1\n");
    await same(p, ["init"], {});
    for (const e of [p.ref, p.ours]) writeFileSync(e.configFile, '[session]\nidle_ttl = "5m"\n');
    await same(p, ["init"], {});
    await same(p, ["init", "--vault", "~/w.passh"], { pty: true, answers: [...NEW, [Q, "n"]] });
  }, 180_000);

  test("the recovery sheet: written, the file exists ×3, the phrase mistyped, end of input", async () => {
    const p = await fresh("init4");
    const KEY: Array<[RegExp, string]> = [...TMPNAME];
    const r = await same(p, ["init"], { pty: true, answers: [...NEW, [Q, "y"], [SHEET, "~/rk.txt"], ["to confirm: ", "PRINT RECOVERY KEY"]], replace: KEY });
    expect(r.ref.code).toBe(0);
    const sheet = (e: Pair["ref"]) =>
      readFileSync(join(e.home, "rk.txt"), "utf8")
        .replace(/\d{4}-\d\d-\d\d \d\d:\d\d/g, "<DATE>")
        .replace(/\d{4}-\d\d-\d\d/g, "<DATE>")
        .replace(/vault_id [0-9a-f-]+/, "vault_id <ID>")
        .replace(/^[0-9A-Z]{4}( [0-9A-Z]{2,4})+$/gm, "<KEY>");
    expect(sheet(p.ours)).toBe(sheet(p.ref));
    for (const e of [p.ref, p.ours]) expect(statSync(join(e.home, "rk.txt")).mode & 0o777).toBe(0o600);
    // the sheet holds the vault's key
    for (const e of [p.ref, p.ours]) {
      const text = readFileSync(join(e.home, "rk.txt"), "utf8");
      const lines = text.split("\n");
      const i = lines.indexOf("AGE-SECRET-KEY-1");
      const key = "AGE-SECRET-KEY-1" + lines.slice(i + 1, i + 4).join("").replace(/ /g, "");
      const { identity } = await readVaultWithPassphrase(e.vault, PASS);
      expect(identity.format()).toBe(key);
    }

    const p2 = await fresh("init5");
    for (const e of [p2.ref, p2.ours]) writeFileSync(join(e.home, "rk.txt"), "x");
    await same(p2, ["init", "--vault", "~/a.passh"], { pty: true, answers: [...NEW, [Q, ""], [SHEET, "~/rk.txt"], [SHEET, "~/rk.txt"], [SHEET, "~/rk.txt"]] });
    await same(p2, ["init", "--vault", "~/b.passh"], { pty: true, answers: [...NEW, [Q, "yes"], [SHEET, "~/rk.txt"], [SHEET, "~/rk2.txt"], ["to confirm: ", "print recovery key"]] });
    await same(p2, ["init", "--vault", "~/c.passh"], { pty: true, answers: [...NEW, [Q, "y"], [SHEET, "~/rk2.txt"], ["to confirm: ", "\x04", "raw"]] });
    await same(p2, ["init", "--vault", "~/d.passh"], { pty: true, answers: [...NEW, [Q, "y"], [SHEET, "\x03", "raw"]] });
    await same(p2, ["init", "--vault", "~/e.passh"], { pty: true, answers: [...NEW, [Q, "y"], [SHEET, "/proc/x/rk.txt"], ["to confirm: ", "PRINT RECOVERY KEY"]] });
  }, 180_000);

  test("the default sheet path (/dev/shm/passh-recovery.txt when it is tmpfs)", async () => {
    const def = "/dev/shm/passh-recovery.txt";
    if (existsSync(def) || !existsSync("/dev/shm")) return; // never touch a file that isn't ours
    const p = await fresh("init6");
    try {
      for (const side of ["ref", "ours"] as const) {
        const e = side === "ref" ? p.ref : p.ours;
        const r = await runSide(side, e, ["init"], { pty: true, answers: [...NEW, [Q, "y"], [SHEET, ""], ["to confirm: ", "PRINT RECOVERY KEY"]] });
        expect(r.code).toBe(0);
        expect(r.stderr).toContain(`Wrote the paper recovery key to ${def}.`);
        expect(existsSync(def)).toBe(true);
        rmSync(def, { force: true });
      }
    } finally {
      rmSync(def, { force: true });
    }
  }, 120_000);
});
