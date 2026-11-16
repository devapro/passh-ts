// Side by side with the reference: `passwd`, `rekey` (cli.md §2.16) and `recover` (§2.18),
// with and without a running agent (agent-session.md §A2.9: the agent is stopped afterwards;
// the agent is the reference's, started by `passh-go unlock` in each env and always stopped).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { formatRecoveryKey } from "../../src/keys/index.ts";
import { PASS } from "../helpers/passh.ts";
import { both, makePair, runSide, type Answer, type Pair } from "./side.ts";
import { buildVault, placeVault, readVault, readVaultWithPassphrase, type BuiltVault } from "./vaults.ts";
import type { IsolatedEnv } from "../helpers/env.ts";

let vault: BuiltVault;
let other: BuiltVault;
const pairs: Pair[] = [];
const NEWPASS = "seven random words make a good passphrase";

beforeAll(async () => {
  vault = await buildVault([{ path: "github", password: "pw", tags: ["t"] }, { path: "x/y" }]);
  other = await buildVault([{ path: "z" }]);
});
afterAll(async () => {
  for (const p of pairs) {
    for (const e of [p.ref, p.ours]) await runSide("ref", e, ["lock"]).catch(() => {});
    p.cleanup();
  }
});

async function fresh(name: string, bytes = vault.bytes): Promise<Pair> {
  const p = await makePair(name, bytes);
  pairs.push(p);
  return p;
}

async function unlock(e: IsolatedEnv): Promise<void> {
  const r = await runSide("ref", e, ["unlock"], { pty: true });
  expect(r.code).toBe(0);
}

/** `<pid>` of agents differs between the sides. */
const PID: Array<[RegExp, string]> = [[/pid \d+/g, "pid N"]];

const CUR = "Current passphrase: ";
const pair = (pass: string): Answer[] => [
  ["New passphrase: ", pass],
  ["Repeat passphrase: ", pass],
];

async function same(p: Pair, args: string[], o: Parameters<typeof both>[2]) {
  const r = await both(p, args, { replace: PID, ...o });
  expect(r.ours).toEqual(r.ref);
  return r.ref;
}

describe("passwd", () => {
  test("a wrong try, a weak passphrase; the vault opens with the new one, in both implementations", async () => {
    const p = await fresh("passwd");
    const r = await same(p, ["passwd"], { pty: true, answers: [[CUR, "wrong"], [CUR, PASS], ...pair("abc")] });
    expect(r.code).toBe(0);
    for (const e of [p.ref, p.ours]) {
      const { data } = await readVaultWithPassphrase(e.vault, "abc");
      expect(data.revision).toBe(vault.data.revision + 1n);
      expect(data.entries.map((x) => x.path)).toEqual(["github", "x/y"]);
    }
    // the paper key stays valid: same vault key
    expect(readVault(p.ours.vault, vault.identity).vaultId).toBe(vault.data.vaultId);
    const a = await runSide("ref", p.ours, ["ls"], { pty: true, answers: [["Passphrase: ", "abc"]] });
    const b = await runSide("ours", p.ref, ["ls"], { pty: true, answers: [["Passphrase: ", "abc"]] });
    expect(a.code).toBe(0);
    expect(b.stdout.split("\n").slice(1)).toEqual(a.stdout.split("\n").slice(1));
  }, 120_000);

  test("with an agent running: it is stopped", async () => {
    const p = await fresh("pwagent");
    await unlock(p.ref);
    await unlock(p.ours);
    const r = await same(p, ["passwd"], { pty: true, answers: [[CUR, PASS], ...pair(NEWPASS)] });
    expect(r.stderr).toContain("The agent was unlocked with the old key block and was stopped");
    const after = await same(p, ["ls"], {});
    expect(after.stderr).toContain("vault is locked");
  }, 120_000);

  test("without a terminal (also with an agent), end of input, mismatches, Ctrl-C", async () => {
    const p = await fresh("pwerr");
    await same(p, ["passwd"], {});
    await same(p, ["rekey"], {});
    await same(p, ["passwd", "x"], {});
    await unlock(p.ref);
    await unlock(p.ours);
    await same(p, ["passwd"], {});
    for (const e of [p.ref, p.ours]) await runSide("ref", e, ["lock"]);
    await same(p, ["passwd"], { pty: true, answers: [[CUR, "\x04", "raw"]] });
    await same(p, ["passwd"], { pty: true, answers: [[CUR, "a"], [CUR, "b"], [CUR, "c"]] });
    await same(p, ["passwd"], { pty: true, answers: [[CUR, PASS], ["New passphrase: ", "\x04", "raw"]] });
    await same(p, ["passwd"], { pty: true, answers: [[CUR, PASS], ["New passphrase: ", ""], ["New passphrase: ", "a"], ["Repeat passphrase: ", "b"], ["New passphrase: ", "\x03", "raw"]] });
    await same(p, ["rekey"], { pty: true, answers: [[CUR, PASS], ["New passphrase: ", "a"], ["Repeat passphrase: ", "\x03", "raw"]] });
    await same(p, ["passwd"], { pty: true, answers: [[CUR, PASS], ["New passphrase: ", "x"], ["Repeat passphrase: ", "y"], ["New passphrase: ", "x"], ["Repeat passphrase: ", "y"], ["New passphrase: ", "x"], ["Repeat passphrase: ", "y"]] });
    // nothing changed
    for (const e of [p.ref, p.ours]) expect((await readVaultWithPassphrase(e.vault, PASS)).data.revision).toBe(vault.data.revision);
  }, 180_000);
});

describe("the agent as the key source (cli.md §1.5, agent-session.md §A2.8)", () => {
  test("commands without a terminal use the running agent; a changed key block gets the note", async () => {
    const p = await fresh("agentkey");
    await unlock(p.ref);
    await unlock(p.ours);
    for (const args of [["ls"], ["show", "github", "--field", "password"], ["find", "git"], ["tags"], ["generate", "new"], ["tag", "github", "--add", "z"], ["mv", "x/y", "x/z"], ["rm", "-f", "x/z"], ["rm", "github"], ["ls", "--tag", "z"]]) {
      await same(p, args, {});
    }
    // each side's vault (changed by its own commands through the agent) opens in the other
    const a = await runSide("ours", p.ref, ["ls"], {});
    const b = await runSide("ref", p.ours, ["ls"], {});
    expect(a.code).toBe(0);
    expect(b.stdout.split("\n").slice(1)).toEqual(a.stdout.split("\n").slice(1));
  }, 180_000);

  test("a key block changed since unlock: the note, then the passphrase or `vault is locked`", async () => {
    const p = await fresh("agentchg");
    await unlock(p.ref);
    await unlock(p.ours);
    // another key block for the same vault (as after `passwd` on another machine)
    const changed = await buildVault([], PASS);
    const lines = new TextDecoder().decode(vault.bytes).split("-----END AGE ENCRYPTED FILE-----");
    const other = new TextDecoder().decode(changed.bytes).split("-----END AGE ENCRYPTED FILE-----");
    // other's key block (wrapping another key) with this vault's data block: the passphrase opens
    // the key block, the data then doesn't decrypt; only the note and the error matter here
    const mixed = other[0] + "-----END AGE ENCRYPTED FILE-----" + lines[1] + "-----END AGE ENCRYPTED FILE-----" + lines[2];
    for (const e of [p.ref, p.ours]) placeVault(e.vault, new TextEncoder().encode(mixed));
    await same(p, ["ls"], {});
    await same(p, ["ls"], { pty: true });
  }, 180_000);
});

describe("rekey", () => {
  test("a new vault key, with an agent running", async () => {
    const p = await fresh("rekey");
    await unlock(p.ref);
    await unlock(p.ours);
    const r = await same(p, ["rekey"], { pty: true, answers: [[CUR, PASS], ...pair(PASS)] });
    expect(r.stderr).toContain("The agent held the old key and was stopped");
    for (const e of [p.ref, p.ours]) {
      const { data, identity } = await readVaultWithPassphrase(e.vault, PASS);
      expect(identity.format()).not.toBe(vault.identity.format());
      expect(data.entries.length).toBe(2);
    }
    // the old paper key no longer opens it
    const rec = await same(p, ["recover"], { pty: true, answers: [["> ", formatRecoveryKey(vault.identity)], ["> ", ""]] });
    expect(rec.code).toBe(1);
  }, 120_000);
});

describe("recover", () => {
  const typeKey = (k: string): Answer[] => [["> ", k], ["> ", ""]];

  test("the paper key, then a new passphrase; the vault opens with it", async () => {
    const p = await fresh("recover");
    const r = await same(p, ["recover"], { pty: true, answers: [...typeKey(formatRecoveryKey(vault.identity).toLowerCase()), ...pair(NEWPASS)] });
    expect(r.code).toBe(0);
    for (const e of [p.ref, p.ours]) expect((await readVaultWithPassphrase(e.vault, NEWPASS)).data.vaultId).toBe(vault.data.vaultId);
  }, 120_000);

  test("typos, then the key; an empty key; another vault's key; three bad keys", async () => {
    const p = await fresh("recerr");
    const key = formatRecoveryKey(vault.identity);
    const typo = key.slice(0, -1) + (key.endsWith("Q") ? "P" : "Q");
    await same(p, ["recover"], { pty: true, answers: [...typeKey("AGE-SECRET-KEY-1XX"), ...typeKey(typo), ...typeKey(key.replace(/ /g, "-")), ...pair(NEWPASS)] });
    await same(p, ["recover"], { pty: true, answers: [["> ", ""], ["> ", "\x04", "raw"]] });
    await same(p, ["recover"], { pty: true, answers: typeKey(formatRecoveryKey(other.identity)) });
    await same(p, ["recover"], { pty: true, answers: [...typeKey("x"), ...typeKey("AGE-SECRET-KEY-1BIO"), ...typeKey("AGE-SECRET-KEY-1" + "Q".repeat(58))] });
    await same(p, ["recover"], {});
    await same(p, ["recover", "x"], {});
  }, 180_000);

  test("a damaged key block: recover writes a new one; other commands stop with the hint", async () => {
    const lines = new TextDecoder().decode(vault.bytes).split("\n");
    lines[2] = "@" + lines[2]!.slice(1);
    const p = await fresh("recdmg", new TextEncoder().encode(lines.join("\n")));
    await same(p, ["passwd"], { pty: true, answers: [] });
    await same(p, ["ls"], { pty: true, answers: [] });
    const r = await same(p, ["recover"], { pty: true, answers: [...typeKey(formatRecoveryKey(vault.identity)), ...pair(NEWPASS)] });
    expect(r.code).toBe(0);
    for (const e of [p.ref, p.ours]) expect((await readVaultWithPassphrase(e.vault, NEWPASS)).data.entries.length).toBe(2);
    expect(readFileSync(p.ours.vault).length).toBe(readFileSync(p.ref.vault).length);
  }, 120_000);

  test("with an agent running: it is stopped", async () => {
    const p = await fresh("recagent");
    await unlock(p.ref);
    await unlock(p.ours);
    const r = await same(p, ["recover"], { pty: true, answers: [...typeKey(formatRecoveryKey(vault.identity)), ...pair(NEWPASS)] });
    expect(r.stderr).toContain("was stopped");
  }, 120_000);

  test("missing vault before the key is asked", async () => {
    const p = await fresh("recnov");
    for (const e of [p.ref, p.ours]) placeVault(e.vault + ".gone", new Uint8Array(0));
    await same(p, ["recover", "--vault", "/nonexistent/v.passh"], { pty: true, answers: [] });
  }, 60_000);
});
