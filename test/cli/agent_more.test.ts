// Side by side with the reference: `passh unlock [--ttl d]` and `passh lock` (cli.md §2.14,
// §2.15, agent-session.md §A2.3, §A2.9): usage errors, no terminal, a new agent, `Already
// unlocked` (also with `--ttl`), `--ttl` times, wrong passphrases, an agent of an older key
// block, a vault that can't be checked against a running agent, lock with and without an
// agent; and interop: each implementation's client with the other's agent. Every agent
// started here is stopped (lock, then a kill of anything left under the test folders).

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { bothMore, killAgentsUnder, makePair, PASS, PASSPHRASE_STEP, runMore, visible, type MoreRunOptions, type Pair } from "./side_more.ts";
import { buildVault, placeVault, type BuiltVault } from "./vaults.ts";

setDefaultTimeout(90_000);

let vault: BuiltVault;
let other: BuiltVault;
const pairs: Pair[] = [];

beforeAll(async () => {
  vault = await buildVault([{ path: "a", password: "x" }]);
  other = await buildVault([{ path: "b", password: "y" }]);
});

afterAll(async () => {
  for (const p of pairs) {
    for (const e of [p.ref, p.ours]) {
      try {
        await runMore("ref", e, ["lock"], { timeoutMs: 10_000 });
      } catch {}
      killAgentsUnder(e.dir);
    }
    p.cleanup();
  }
});

async function newPair(extra = "", bytes: Uint8Array | null = vault.bytes): Promise<Pair> {
  const p = await makePair("agt", bytes ?? undefined, extra);
  pairs.push(p);
  return p;
}

async function same(p: Pair, args: string[], o: MoreRunOptions = {}) {
  const r = await bothMore(p, args, o);
  expect(visible(r.ours)).toEqual(visible(r.ref));
  return r;
}

const unlockPty: MoreRunOptions = { pty: true, steps: [PASSPHRASE_STEP] };

describe("unlock: errors before the agent", () => {
  test("--ttl ≤ 0 or invalid is a usage error, before the config", async () => {
    const p = await newPair("", null);
    rmSync(p.ref.configFile);
    rmSync(p.ours.configFile);
    for (const ttl of ["0", "0s", "-1s", "5", "abc", ""]) {
      const r = await same(p, ["unlock", "--ttl", ttl]);
      expect(r.ref.code).toBe(2);
    }
    await same(p, ["unlock", "extra"]);
  });

  test("no config, no vault", async () => {
    const p = await newPair("", null);
    await same(p, ["unlock"]);
    await same(p, ["lock"]);
    rmSync(p.ref.configFile);
    rmSync(p.ours.configFile);
    await same(p, ["unlock"]);
    await same(p, ["lock"]);
  });

  test("no terminal and no agent", async () => {
    const r = await same(await newPair(), ["unlock"]);
    expect(r.ref.stderr).toContain("passh unlock needs a terminal to ask for the passphrase");
  });

  test("wrong passphrase three times", async () => {
    const p = await newPair();
    const r = await same(p, ["unlock"], { pty: true, steps: [["Passphrase: ", "no"], ["Passphrase: ", "nope"], ["Passphrase: ", "still no"]] });
    expect(r.ref.code).toBe(1);
  });

  test("Ctrl-D at the passphrase prompt", async () => {
    await same(await newPair(), ["unlock"], { pty: true, steps: [["Passphrase: ", "\x04", "raw"]] });
  });
});

describe("unlock and lock", () => {
  test("a new agent, Already unlocked (+ --ttl warning), lock, lock again", async () => {
    const p = await newPair();
    const u = await same(p, ["unlock"], unlockPty);
    expect(u.ref.code).toBe(0);
    expect(u.ours.rawStderr).toMatch(/^Unlocked <ENV>\/data\/passh\/vault\.passh: the agent \(pid \d+\) exits in (15m|14m5\ds) if unused, in (2h|1h59m) at the latest\.\nRun `passh lock` to stop the agent now\.\n$/);
    // Without a terminal: the running agent serves this key block.
    const a = await same(p, ["unlock"]);
    expect(a.ref.stderr).toBe("Already unlocked: the agent (pid N) exits in <T>.\n");
    const t = await same(p, ["unlock", "--ttl", "5m"]);
    expect(t.ref.stderr).toContain("passh: warning: --ttl was not applied");
    // On a terminal too: no passphrase prompt.
    await same(p, ["unlock"], { pty: true });
    await same(p, ["doctor"]);
    const l = await same(p, ["lock"]);
    expect(l.ref.stderr).toBe("Locked: the agent (pid N) stopped.\n");
    const l2 = await same(p, ["lock"]);
    expect(l2.ref.stderr).toBe("No agent is running for <ENV>/data/passh/vault.passh.\n");
    // The vault is locked again for the key commands (both implementations' agents gone).
    await same(p, ["verify", "--full"]);
  });

  test("--ttl shorter than the idle time, and longer", async () => {
    const p = await newPair();
    const u = await same(p, ["unlock", "--ttl", "10m"], unlockPty);
    expect(u.ours.rawStderr).toMatch(/the agent \(pid \d+\) exits in (10m|9m5\ds)\./);
    await same(p, ["lock"]);
    const u2 = await same(p, ["unlock", "--ttl=30m"], unlockPty);
    expect(u2.ours.rawStderr).toMatch(/exits in (15m|14m5\ds) if unused, in (30m|29m5\ds) at the latest\./);
    await same(p, ["lock"]);
  });

  test("agent.idle_ttl and agent.max_ttl from the config", async () => {
    const p = await newPair('[agent]\nidle_ttl = "1h30m"\nmax_ttl = "3h"\n');
    const u = await same(p, ["unlock"], unlockPty);
    expect(u.ours.rawStderr).toMatch(/exits in (1h30m|1h29m) if unused, in (3h|2h59m) at the latest\./);
    await same(p, ["lock"]);
  });

  test("an agent of an older key block is replaced", async () => {
    const p = await newPair();
    await same(p, ["unlock"], unlockPty);
    // passwd elsewhere: same path, another key block.
    for (const e of [p.ref, p.ours]) placeVault(e.vault, other.bytes);
    const r = await same(p, ["unlock"], unlockPty);
    expect(r.ref.stderr).toContain("passh: the running agent was unlocked with another key block (passwd elsewhere?); replacing it\nUnlocked ");
    await same(p, ["lock"]);
  });

  test("an agent of an older key block, and no terminal", async () => {
    const p = await newPair();
    await same(p, ["unlock"], unlockPty);
    for (const e of [p.ref, p.ours]) placeVault(e.vault, other.bytes);
    await same(p, ["unlock"]);
    await same(p, ["lock"]);
  });

  test("the vault can't be checked against the running agent", async () => {
    const p = await newPair();
    await same(p, ["unlock"], unlockPty);
    for (const e of [p.ref, p.ours]) writeFileSync(e.vault, "not a vault\n");
    const r = await same(p, ["unlock"]);
    expect(r.ref.stderr).toContain("an agent is running, but the vault can't be checked against it");
    await same(p, ["lock"]);
  });

  test("lock with a missing vault file can't reach the agent", async () => {
    const p = await newPair();
    await same(p, ["unlock"], unlockPty);
    for (const e of [p.ref, p.ours]) rmSync(e.vault);
    await same(p, ["lock"]);
    for (const e of [p.ref, p.ours]) placeVault(e.vault, vault.bytes);
    await same(p, ["lock"]);
  });
});

describe("interop: one implementation's client, the other's agent", () => {
  for (const [starter, client] of [
    ["ref", "ours"],
    ["ours", "ref"],
  ] as const) {
    test(`${starter}'s agent, ${client}'s unlock, verify --full and lock`, async () => {
      const p = await newPair();
      const e = p.ours;
      const u = await runMore(starter, e, ["unlock"], unlockPty);
      expect(u.code).toBe(0);
      const a = await runMore(client, e, ["unlock"]);
      expect(a.code).toBe(0);
      expect(a.stderr).toBe("Already unlocked: the agent (pid N) exits in <T>.\n");
      const v = await runMore(client, e, ["verify", "--full"]);
      expect(v.code).toBe(0);
      expect(v.stdout).toContain("  entries   1\n");
      const d = await runMore(client, e, ["doctor"]);
      expect(d.stdout).toContain("info   agent         running: the agent (pid N)");
      const l = await runMore(client, e, ["lock"]);
      expect(l.stderr).toBe("Locked: the agent (pid N) stopped.\n");
      const l2 = await runMore(starter, e, ["lock"]);
      expect(l2.stderr).toContain("No agent is running for ");
    });
  }
});

test("passphrase constant is the helper's", () => {
  expect(PASS.length).toBeGreaterThan(0);
});
