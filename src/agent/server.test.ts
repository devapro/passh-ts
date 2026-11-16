// The agent's server in process (agent-session.md §A2.4–§A2.6): binding, framing over a
// real socket, the peer check, the per-connection deadline, expiry with a fake clock,
// the socket ownership check, stop and the shutdown order.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isolatedEnv, type IsolatedEnv } from "../../test/helpers/env.ts";
import { agentSocketPath } from "../config/index.ts";
import { getuid } from "../ffi/libc.ts";
import { AgentServer, BindError, type AgentServerOptions } from "./server.ts";
import { fakeClock, makeVault, rawRequest, waitFor, type TestVault } from "./testdata/helpers.ts";

const envs: IsolatedEnv[] = [];
const servers: AgentServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.shutdown("stop");
});
afterAll(() => envs.forEach((e) => e.cleanup()));

async function setup(over: Partial<AgentServerOptions> = {}) {
  const e = isolatedEnv("agsrv");
  envs.push(e);
  const v = await makeVault(e.vault);
  const socket = agentSocketPath(v.path, { env: e.env });
  const clock = fakeClock();
  const key = new TextEncoder().encode(v.key);
  const r = await AgentServer.start({
    vault: v.path,
    idleTtlMs: 60_000,
    maxTtlMs: 3_600_000,
    key,
    digest: v.digest,
    socket,
    env: e.env,
    clock,
    pid: 4242,
    ...over,
  });
  if (r === "running") throw new Error("unexpected running");
  servers.push(r);
  return { e, v, socket, clock, key, server: r, path: socket.path };
}

const STATUS = '{"v":1,"op":"status"}\n';
const STOP = '{"v":1,"op":"stop"}\n';
const KEY = (d: string) => `{"v":1,"op":"key","key_block":"${d}"}\n`;

describe("binding (§A2.2, §A2.4)", () => {
  test("creates the folders 0700 and the socket 0600", async () => {
    const { socket } = await setup();
    expect(statSync(socket.dir).mode & 0o7777).toBe(0o700);
    expect(statSync(dirname(socket.dir)).mode & 0o7777).toBe(0o700);
    const st = lstatSync(socket.path);
    expect(st.isSocket()).toBe(true);
    expect(st.mode & 0o7777).toBe(0o600);
    expect(socket.path.endsWith(".sock")).toBe(true);
  });

  test("a live agent on the socket gives running; a stale one is replaced", async () => {
    const { v, socket, e } = await setup();
    const opts = { vault: v.path, idleTtlMs: 1000, maxTtlMs: 1000, key: new Uint8Array(4), digest: v.digest, socket, env: e.env };
    expect(await AgentServer.start(opts)).toBe("running");
    // Make a stale socket: a bound socket file nobody listens on.
    await servers.pop()!.shutdown("stop");
    const l = Bun.listen({ unix: socket.dir + "/stale", socket: { data() {} } });
    renameSync(socket.dir + "/stale", socket.path);
    l.stop(true);
    expect(lstatSync(socket.path).isSocket()).toBe(true);
    const s = await AgentServer.start(opts);
    expect(s).toBeInstanceOf(AgentServer);
    servers.push(s as AgentServer);
    expect((await rawRequest(socket.path, STATUS)).text).toContain('"ok":true');
  });

  test("a file at the socket path is refused", async () => {
    const e = isolatedEnv("agbind");
    envs.push(e);
    const v = await makeVault(e.vault);
    const socket = agentSocketPath(v.path, { env: e.env });
    mkdirSync(socket.dir, { recursive: true, mode: 0o700 });
    writeFileSync(socket.path, "x");
    const opts = { vault: v.path, idleTtlMs: 1000, maxTtlMs: 1000, key: new Uint8Array(4), digest: v.digest, socket, env: e.env };
    const err = await AgentServer.start(opts).catch((x) => x);
    expect(err).toBeInstanceOf(BindError);
    expect(err.message).toBe(`agent: ${socket.path} exists and is not a socket; refusing to replace it`);
    expect(statSync(socket.path).isFile()).toBe(true);
    // A folder with the wrong mode: the folder check's own text (no `agent: ` prefix).
    rmSync(socket.path);
    chmodSync(socket.dir, 0o755);
    const err2 = await AgentServer.start(opts).catch((x) => x);
    expect(err2.message).toBe(`agent folder ${socket.dir} has mode 0755, not 0700; refusing to use it (fix it with chmod 700, or remove it)`);
    // No temporary socket names are left behind.
    chmodSync(socket.dir, 0o700);
    expect(require("node:fs").readdirSync(socket.dir)).toEqual([]);
  });
});

describe("protocol over the socket (§A2.5)", () => {
  test("status, key (exact bytes), refusals", async () => {
    const { path, v } = await setup();
    const st = await rawRequest(path, STATUS);
    expect(st.text).toBe(`{"v":1,"ok":true,"pid":4242,"vault":"${v.path}","idle_left_ms":60000,"max_left_ms":3600000}\n`);
    expect((await rawRequest(path, KEY(v.digest))).text).toBe(`{"v":1,"ok":true,"key":"${v.key}"}\n`);
    expect((await rawRequest(path, KEY("0".repeat(64)))).text).toBe(
      '{"v":1,"ok":false,"code":"key_block_changed","error":"the vault\'s key block isn\'t the one this agent was unlocked with"}\n',
    );
    expect((await rawRequest(path, '{"v":1,"op":"x"}\n')).text).toBe('{"v":1,"ok":false,"code":"bad_request","error":"unknown request \\"x\\""}\n');
  });

  test("framing: CRLF, bytes after the LF, no LF before a half-close, 4096 bytes", async () => {
    const { path } = await setup();
    expect((await rawRequest(path, STATUS.replace("\n", "\r\n"))).text).toContain('"ok":true');
    expect((await rawRequest(path, STATUS + "GARBAGE")).text).toContain('"ok":true');
    const half = await rawRequest(path, STATUS.trim(), { halfClose: true, waitMs: 2000 });
    expect(half).toEqual({ text: "", ended: "closed" });
    // A complete line and a half-close: still answered.
    expect((await rawRequest(path, STATUS, { halfClose: true })).text).toContain('"ok":true');
    const max = '{"v":1,"op":"status"' + " ".repeat(4096 - 22) + "}\n";
    expect(max.length).toBe(4096);
    expect((await rawRequest(path, max)).text).toContain('"ok":true');
    const tooLong = '{"v":1,"op":"status"' + " ".repeat(4097 - 22) + "}\n";
    expect((await rawRequest(path, tooLong)).text).toBe('{"v":1,"ok":false,"code":"bad_request","error":"request too large"}\n');
    expect((await rawRequest(path, "x".repeat(10000))).text).toBe('{"v":1,"ok":false,"code":"bad_request","error":"request too large"}\n');
  });

  test("a peer of another uid is closed unanswered", async () => {
    const { path } = await setup({ peerUid: getuid() + 1 });
    expect(await rawRequest(path, STATUS, { waitMs: 2000 })).toEqual({ text: "", ended: "closed" });
  });

  test("nothing complete within the deadline: closed without an answer; others are served meanwhile", async () => {
    const { path } = await setup({ connDeadlineMs: 300 });
    const t0 = Date.now();
    const idle = rawRequest(path, "", { noWrite: true, waitMs: 3000 });
    const partial = rawRequest(path, '{"v":1', { waitMs: 3000 });
    expect((await rawRequest(path, STATUS)).text).toContain('"ok":true');
    expect(await idle).toEqual({ text: "", ended: "closed" });
    expect(await partial).toEqual({ text: "", ended: "closed" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });
});

describe("expiry (§A2.6)", () => {
  test("idle: only a served key request restarts it; status and refusals don't", async () => {
    const { path, v, clock, server } = await setup({ idleTtlMs: 10_000, maxTtlMs: 100_000 });
    clock.advance(6000);
    await rawRequest(path, STATUS);
    await rawRequest(path, KEY("0".repeat(64)));
    expect((await rawRequest(path, STATUS)).text).toContain('"idle_left_ms":4000,"max_left_ms":94000');
    await rawRequest(path, KEY(v.digest));
    expect((await rawRequest(path, STATUS)).text).toContain('"idle_left_ms":10000,"max_left_ms":94000');
    clock.advance(9999);
    server.tick();
    expect(server.stoppedBy).toBeUndefined();
    clock.advance(1);
    // Expired but not yet noticed by the loop: key → expired, status still answered (clamped to 1).
    expect((await rawRequest(path, KEY(v.digest))).text).toBe('{"v":1,"ok":false,"code":"expired","error":"the agent has expired"}\n');
    expect((await rawRequest(path, STATUS)).text).toContain('"idle_left_ms":1,"max_left_ms":84000');
    server.tick();
    expect(await server.done).toBe("expired");
    expect(existsSync(path)).toBe(false);
  });

  test("max: since start, whatever the use", async () => {
    const { path, v, clock, server } = await setup({ idleTtlMs: 10_000, maxTtlMs: 25_000 });
    for (let i = 0; i < 4; i++) {
      clock.advance(6000);
      expect((await rawRequest(path, KEY(v.digest))).text).toContain('"key"');
    }
    clock.advance(1000);
    server.tick();
    expect(await server.done).toBe("expired");
  });

  test("time while the machine sleeps counts (wall clock); a clock set back doesn't extend it (monotonic)", async () => {
    const a = await setup({ idleTtlMs: 10_000, maxTtlMs: 100_000 });
    a.clock.advance(10_000, "wall");
    a.server.tick();
    expect(await a.server.done).toBe("expired");
    const b = await setup({ idleTtlMs: 10_000, maxTtlMs: 100_000 });
    b.clock.advance(-50_000, "wall");
    b.clock.advance(10_000, "mono");
    b.server.tick();
    expect(await b.server.done).toBe("expired");
  });

  test("the real loop notices expiry without a tick", async () => {
    const { server, path } = await setup({ clock: undefined, idleTtlMs: 150, maxTtlMs: 10_000 });
    const t0 = Date.now();
    expect(await server.done).toBe("expired");
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(existsSync(path)).toBe(false);
  });
});

describe("socket ownership and shutdown (§A2.6)", () => {
  test("socket removed → exits", async () => {
    const { path, server } = await setup({ ownershipCheckMs: 20 });
    rmSync(path);
    expect(await server.done).toBe("socket");
  });

  test("socket replaced → exits and leaves the new one alone", async () => {
    const { path, server, socket } = await setup({ ownershipCheckMs: 20 });
    renameSync(path, socket.dir + "/moved");
    writeFileSync(path, "new");
    expect(await server.done).toBe("socket");
    expect(statSync(path).isFile()).toBe(true);
  });

  test("stop: answers the status from before stopping, removes the socket, wipes the key", async () => {
    const { path, server, key, clock } = await setup();
    clock.advance(1000);
    const r = await rawRequest(path, STOP);
    expect(r.text).toContain('"idle_left_ms":59000,"max_left_ms":3599000');
    expect(await server.done).toBe("stop");
    expect(existsSync(path)).toBe(false);
    expect(key.every((b) => b === 0)).toBe(true);
  });

  test("shutdown waits for connections in progress", async () => {
    const { path, server } = await setup({ connDeadlineMs: 400 });
    const idle = rawRequest(path, "", { noWrite: true, waitMs: 3000 });
    await waitFor(() => server.connections === 1, 2000, "the idle connection");
    const t0 = Date.now();
    await rawRequest(path, STOP);
    await server.done;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect((await idle).ended).toBe("closed");
  });
});
