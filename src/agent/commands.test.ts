// The command cores (agent-session.md §A2.3, §A2.9; cli.md §2.14–§2.16, §2.25 row 7)
// with injected dependencies: unlock (new agent, already unlocked, --ttl, replacing an
// agent of another key block, no terminal, readiness failures, the `running` race),
// lock, the stop after a key change, and doctor's rows. Agents are started through the
// launcher in an isolated environment and stopped in afterAll.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, type IsolatedEnv } from "../../test/helpers/env.ts";
import { agentSocketPath, defaultConfig, type Config } from "../config/index.ts";
import { UsageError } from "../errors.ts";
import { X25519Identity } from "../age/index.ts";
import { MIN, HOUR } from "../util/duration.ts";
import { captureIO } from "../util/io.ts";
import { agentStatus } from "./client.ts";
import { agentDoctorInfo, runLock, runUnlock, stopAgentAfterKeyChange, type UnlockOptions } from "./commands.ts";
import { Children, fakeAgent, launcherCommand, makeVault, rawRequest, type TestVault } from "./testdata/helpers.ts";

let e: IsolatedEnv;
let v: TestVault;
let sock: ReturnType<typeof agentSocketPath>;
let config: Config;
const kids = new Children();

beforeAll(async () => {
  e = isolatedEnv("agcmd");
  v = await makeVault(e.vault);
  sock = agentSocketPath(v.path, { env: e.env });
  config = { ...defaultConfig(), vault: v.path, agent: { idleTTL: 1n * MIN, maxTTL: 1n * HOUR } };
});
afterAll(async () => {
  if (existsSync(sock.path)) await rawRequest(sock.path, '{"v":1,"op":"stop"}\n', { waitMs: 2000 }).catch(() => {});
  await kids.killAll();
  e.cleanup();
});

function opener(vault: TestVault, calls: { n: number } = { n: 0 }) {
  return async () => {
    calls.n++;
    return { identity: X25519Identity.parse(vault.key), keyBlock: vault.keyBlock, realPath: vault.path };
  };
}

function unlockOpts(over: Partial<UnlockOptions> = {}): UnlockOptions & { io: ReturnType<typeof captureIO> } {
  const io = captureIO();
  return {
    config,
    vaultPath: v.path,
    io,
    tty: {},
    openWithPassphrase: opener(v),
    env: e.env,
    agentCommand: launcherCommand(e.env),
    ...over,
  } as UnlockOptions & { io: ReturnType<typeof captureIO> };
}

async function lock(): Promise<string[]> {
  const io = captureIO();
  await runLock({ config, vaultPath: v.path, io, env: e.env });
  return io.err;
}

describe("unlock (§A2.3)", () => {
  test("--ttl ≤ 0 is a usage error", async () => {
    const err = await runUnlock(unlockOpts({ ttl: 0n })).catch((x) => x);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toBe("--ttl must be more than zero");
    expect(err.exitCode).toBe(2);
  });

  test("no agent and no terminal", async () => {
    const calls = { n: 0 };
    const o = unlockOpts({ tty: null, openWithPassphrase: opener(v, calls) });
    await expect(runUnlock(o)).rejects.toThrow("passh unlock needs a terminal to ask for the passphrase (over SSH: `ssh -t host passh unlock`)");
    expect(calls.n).toBe(0);
  });

  test("starts an agent; then `Already unlocked` without a terminal; --ttl warns; lock stops it", async () => {
    const o = unlockOpts();
    await runUnlock(o);
    expect(o.io.err.length).toBe(2);
    expect(o.io.err[0]).toMatch(new RegExp(`^Unlocked ${v.path}: the agent \\(pid \\d+\\) exits in 1m if unused, in 1h at the latest\\.$`));
    expect(o.io.err[1]).toBe("Run `passh lock` to stop the agent now.");
    const pid = /pid (\d+)/.exec(o.io.err[0]!)![1];
    expect(existsSync(sock.path)).toBe(true);

    const calls = { n: 0 };
    const o2 = unlockOpts({ tty: null, openWithPassphrase: opener(v, calls) });
    await runUnlock(o2);
    expect(o2.io.err).toEqual([`Already unlocked: the agent (pid ${pid}) exits in 1m if unused, in 1h at the latest.`]);
    expect(calls.n).toBe(0);

    const o3 = unlockOpts({ ttl: 5n * MIN });
    await runUnlock(o3);
    expect(o3.io.err).toEqual([
      `Already unlocked: the agent (pid ${pid}) exits in 1m if unused, in 1h at the latest.`,
      "passh: warning: --ttl was not applied: the agent was already running; run `passh lock`, then `passh unlock --ttl …`",
    ]);

    expect(await lock()).toEqual([`Locked: the agent (pid ${pid}) stopped.`]);
    expect(existsSync(sock.path)).toBe(false);
    expect(await lock()).toEqual([`No agent is running for ${v.path}.`]);
  }, 30_000);

  test("--ttl sets the maximum of a new agent", async () => {
    const o = unlockOpts({ ttl: 90n * MIN, config: { ...config, agent: { idleTTL: 2n * HOUR, maxTTL: 1n * HOUR } } });
    await runUnlock(o);
    expect(o.io.err[0]).toMatch(/exits in 1h30m\.$/);
    await lock();
  }, 20_000);

  test("an agent of another key block is replaced (with a terminal) or stopped (without)", async () => {
    // An agent holding another vault's key block, on this vault's socket.
    const other = await makeVault(join(e.dir, "other.passh"));
    const c = await kids.start(e.env, [`--vault=${v.path}`, "--idle-ttl=1m", "--max-ttl=1h"], `${other.key}\n${other.digest}\n`);
    expect((await c.readReadiness()).kind).toBe("line");
    const o = unlockOpts();
    await runUnlock(o);
    expect(o.io.err[0]).toBe("passh: the running agent was unlocked with another key block (passwd elsewhere?); replacing it");
    expect(o.io.err[1]).toMatch(/^Unlocked .*: the agent \(pid \d+\) exits in 1m if unused, in 1h at the latest\.$/);
    expect(await c.exited).toBe(0);
    await lock();

    const c2 = await kids.start(e.env, [`--vault=${v.path}`, "--idle-ttl=1m", "--max-ttl=1h"], `${other.key}\n${other.digest}\n`);
    expect((await c2.readReadiness()).kind).toBe("line");
    const o2 = unlockOpts({ tty: null });
    await expect(runUnlock(o2)).rejects.toThrow("passh unlock needs a terminal");
    expect(o2.io.err).toEqual(["passh: the running agent was unlocked with another key block (passwd elsewhere?); replacing it"]);
    expect(await c2.exited).toBe(0);
  }, 30_000);

  test("an agent running, but the vault can't be read", async () => {
    const bad = join(e.dir, "garbage.passh");
    await Bun.write(bad, "hello\n");
    const f = fakeAgent(agentSocketPath(bad, { env: e.env }).path, '{"v":1,"ok":true,"pid":5}\n');
    try {
      await expect(runUnlock(unlockOpts({ vaultPath: bad }))).rejects.toThrow(`an agent is running, but the vault can't be checked against it: ${bad}: not a passh vault`);
    } finally {
      f.stop();
    }
  });

  test("status and key errors end unlock", async () => {
    const f = fakeAgent(sock.path, (r) => (r.includes('"key"') ? '{"v":1,"ok":false,"code":"bad_request","error":"zzz"}\n' : '{"v":1,"ok":true,"pid":5}\n'));
    try {
      await expect(runUnlock(unlockOpts())).rejects.toThrow("agent: the agent refused the request: zzz");
      expect(f.reqs.map((r) => JSON.parse(r).op)).toEqual(["status", "key"]);
    } finally {
      f.stop();
    }
  });

  test("readiness: exited, timeout, error line", async () => {
    await expect(runUnlock(unlockOpts({ agentCommand: ["/bin/true"] }))).rejects.toThrow("agent: starting the agent: the agent exited before it was ready");
    await expect(runUnlock(unlockOpts({ agentCommand: ["/bin/sh", "-c", "sleep 3", "sh"], readinessTimeoutMs: 200 }))).rejects.toThrow(
      "agent: starting the agent: the agent didn't report ready within 200ms",
    );
    await expect(runUnlock(unlockOpts({ agentCommand: ["/bin/sh", "-c", 'echo "error: agent: boom" >&3', "sh"] }))).rejects.toThrow("agent: starting the agent: boom");
    await expect(runUnlock(unlockOpts({ agentCommand: ["/bin/sh", "-c", 'echo "error: agent folder x is bad" >&3', "sh"] }))).rejects.toThrow(
      "agent: starting the agent: agent folder x is bad",
    );
  }, 20_000);

  test("readiness `running`: another unlock won the race", async () => {
    let winner: Awaited<ReturnType<typeof kids.start>> | undefined;
    const o = unlockOpts({
      openWithPassphrase: async () => {
        winner = await kids.start(e.env, [`--vault=${v.path}`, "--idle-ttl=1m", "--max-ttl=1h"], `${v.key}\n${v.digest}\n`);
        await winner.readReadiness();
        return { identity: X25519Identity.parse(v.key), keyBlock: v.keyBlock, realPath: v.path };
      },
    });
    await runUnlock(o);
    expect(o.io.err).toEqual([`Already unlocked: the agent (pid ${winner!.pid}) exits in 1m if unused, in 1h at the latest.`]);
    await lock();
    expect(await winner!.exited).toBe(0);
  }, 30_000);

  test("the key is wiped after the start", async () => {
    const w = await makeVault(join(e.dir, "wipe.passh"));
    let closed = false;
    const o = unlockOpts({
      vaultPath: w.path,
      openWithPassphrase: async () => ({ identity: w.identity, keyBlock: w.keyBlock, realPath: w.path, close: () => ((closed = true), w.identity.wipe()) }),
    });
    await runUnlock(o);
    expect(closed).toBe(true);
    expect(w.identity.wiped).toBe(true);
    const io = captureIO();
    await runLock({ config, vaultPath: w.path, io, env: e.env });
    expect(io.err[0]).toMatch(/^Locked: the agent \(pid \d+\) stopped\.$/);
  }, 20_000);
});

describe("stop after a key change (§A2.9)", () => {
  test("running → status line; none → nothing; failure → warning", async () => {
    let c = await kids.start(e.env, [`--vault=${v.path}`, "--idle-ttl=1m", "--max-ttl=1h"], `${v.key}\n${v.digest}\n`);
    await c.readReadiness();
    let io = captureIO();
    await stopAgentAfterKeyChange(v.path, io, "passwd", { env: e.env });
    expect(io.err).toEqual(["The agent was unlocked with the old key block and was stopped; run `passh unlock` again if you need it."]);
    expect(await c.exited).toBe(0);
    c = await kids.start(e.env, [`--vault=${v.path}`, "--idle-ttl=1m", "--max-ttl=1h"], `${v.key}\n${v.digest}\n`);
    await c.readReadiness();
    io = captureIO();
    await stopAgentAfterKeyChange(v.path, io, "rekey", { env: e.env });
    expect(io.err).toEqual(["The agent held the old key and was stopped; run `passh unlock` again if you need it."]);
    io = captureIO();
    await stopAgentAfterKeyChange(v.path, io, "recover", { env: e.env });
    expect(io.err).toEqual([]);
    const f = fakeAgent(sock.path, '{"v":1,"ok":true,"pid":77}\n');
    try {
      io = captureIO();
      await stopAgentAfterKeyChange(v.path, io, "passwd", { env: e.env, waitMs: 100 });
      expect(io.err).toEqual(["passh: warning: the agent couldn't be stopped: agent: waiting for the agent (pid 77) to exit: context deadline exceeded; stop it with `passh lock`"]);
    } finally {
      f.stop();
    }
  }, 30_000);
});

describe("doctor's agent rows (cli.md §2.25 row 7)", () => {
  test("missing folder, not running, running, folder error, status error", async () => {
    const e2 = isolatedEnv("agdoc");
    try {
      const w = await makeVault(e2.vault);
      const s2 = agentSocketPath(w.path, { env: e2.env });
      expect(await agentDoctorInfo(w.path, { env: e2.env })).toEqual({
        folder: { level: "info", message: `${s2.dir} doesn't exist yet; \`passh unlock\` creates it` },
        agent: { level: "info", message: "not running (`passh unlock` starts it)" },
      });
      // `~/` form when under $HOME.
      const homeEnv = { ...e2.env, XDG_STATE_HOME: "", HOME: join(e2.dir, "h") };
      expect((await agentDoctorInfo(w.path, { env: homeEnv })).folder.message).toBe("~/.local/state/passh/agent doesn't exist yet; `passh unlock` creates it");
      mkdirSync(s2.dir, { recursive: true, mode: 0o700 });
      chmodSync(s2.dir, 0o700);
      expect(await agentDoctorInfo(w.path, { env: e2.env })).toEqual({
        folder: { level: "ok", message: `${s2.dir} (0700, yours)` },
        agent: { level: "info", message: "not running (`passh unlock` starts it)" },
      });
      let f = fakeAgent(s2.path, '{"v":1,"ok":true,"pid":5,"idle_left_ms":99999,"max_left_ms":100000}\n');
      try {
        expect((await agentDoctorInfo(w.path, { env: e2.env })).agent).toEqual({ level: "info", message: "running: the agent (pid 5) exits in 1m40s if unused, in 1m40s at the latest" });
        expect(f.reqs).toEqual(['{"v":1,"op":"status"}\n']);
      } finally {
        f.stop();
      }
      f = fakeAgent(s2.path, '{"v":1,"ok":false,"code":"bad_request","error":"nope"}\n');
      try {
        expect((await agentDoctorInfo(w.path, { env: e2.env })).agent).toEqual({ level: "error", message: "agent: the agent refused the request: nope" });
      } finally {
        f.stop();
      }
      chmodSync(s2.dir, 0o755);
      expect(await agentDoctorInfo(w.path, { env: e2.env })).toEqual({
        folder: { level: "error", message: `agent folder ${s2.dir} has mode 0755, not 0700; refusing to use it (fix it with chmod 700, or remove it)` },
      });
      rmSync(s2.dir, { recursive: true });
    } finally {
      e2.cleanup();
    }
  });

  test("a running agent started by unlock", async () => {
    await runUnlock(unlockOpts());
    const info = await agentDoctorInfo(v.path, { env: e.env });
    expect(info.agent?.message).toMatch(/^running: the agent \(pid \d+\) exits in 1m if unused, in 1h at the latest$/);
    expect(await agentStatus(v.path, { env: e.env })).toBeDefined();
    await lock();
  }, 20_000);
});
