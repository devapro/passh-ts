// Client calls (agent-session.md §A2.7) against fake agents: "no agent" cases, every
// client-side error of §A2.5/§A2.7 (texts observed on the reference client), the folder
// check, the peer check, deadlines, `lock`'s wait; and the agent as a key source (§A2.8).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, type IsolatedEnv } from "../../test/helpers/env.ts";
import { agentSocketPath } from "../config/index.ts";
import { getuid } from "../ffi/libc.ts";
import { captureIO } from "../util/io.ts";
import { agentKey, agentStatus, agentStop, stopAgentAndWait, type ClientOptions } from "./client.ts";
import { agentKeySource, verifyKeySource } from "./keysource.ts";
import { fakeAgent, makeVault, type FakeAnswer, type TestVault } from "./testdata/helpers.ts";

let e: IsolatedEnv;
let v: TestVault;
let sock: ReturnType<typeof agentSocketPath>;
let opts: ClientOptions;
beforeAll(async () => {
  e = isolatedEnv("agcli");
  v = await makeVault(e.vault);
  sock = agentSocketPath(v.path, { env: e.env });
  opts = { env: e.env };
});
afterAll(() => e.cleanup());

async function withFake<T>(answer: FakeAnswer, fn: () => Promise<T>): Promise<{ result: T | undefined; error: string | undefined; reqs: string[] }> {
  const f = fakeAgent(sock.path, answer);
  try {
    const result = await fn();
    return { result, error: undefined, reqs: f.reqs };
  } catch (err) {
    return { result: undefined, error: (err as Error).message, reqs: f.reqs };
  } finally {
    f.stop();
  }
}

describe("status/stop answers (texts as the reference client's, via `passh lock`)", () => {
  const table: Array<[string, FakeAnswer, string]> = [
    ["status", '{"v":1,"ok":true,"pid":77,"vault":"/x","idle_left_ms":1000,"max_left_ms":5000}\n', "pid 77"],
    ["no members", '{"v":1,"ok":true}\n', "pid 0"],
    ["v2", '{"v":2,"ok":true}\n', "agent: the running agent speaks protocol version 2, this passh 1; kill it and run `passh unlock` again"],
    ["v missing", '{"ok":true,"pid":5}\n', "agent: the running agent speaks protocol version 0, this passh 1; kill it and run `passh unlock` again"],
    ["v string", '{"v":"1","ok":true}\n', "agent: malformed answer"],
    ["not json", "hello\n", "agent: malformed answer"],
    ["expired", '{"v":1,"ok":false,"code":"expired","error":"the agent has expired"}\n', "none"],
    ["key_block_changed", '{"v":1,"ok":false,"code":"key_block_changed","error":"x"}\n', "none"],
    ["version", '{"v":1,"ok":false,"code":"version","error":"the agent speaks protocol version 1, not 0"}\n', "agent: the agent speaks protocol version 1, not 0"],
    ["other code", '{"v":1,"ok":false,"code":"weird","error":"some error"}\n', "agent: the agent refused the request: some error"],
    ["ok missing", '{"v":1}\n', "agent: the agent refused the request: "],
    ["pid string", '{"v":1,"ok":true,"pid":"5"}\n', "agent: malformed answer"],
    ["closed, no answer", null, "agent: the agent closed the connection without answering"],
    ["closed mid-line", '{"v":1,"ok":tr', "agent: reading the answer: connection closed in the middle of a message"],
    ["too long", '{"v":1,"ok":true,"vault":"' + "x".repeat(5000) + '"}\n', "agent: reading the answer: message too large"],
    ["crlf", '{"v":1,"ok":true,"pid":9}\r\n', "pid 9"],
    ["exited meanwhile", () => "VANISH", "none"],
  ];
  for (const [name, a, want] of table) {
    test(name, async () => {
      const r = await withFake(a, () => agentStop(v.path, opts));
      expect(r.reqs[0]).toBe('{"v":1,"op":"stop"}\n');
      expect(r.error ?? (r.result ? `pid ${r.result.pid}` : "none")).toBe(want);
    });
  }

  test("a hanging agent costs the deadline", async () => {
    const t0 = Date.now();
    const r = await withFake("HANG", () => agentStatus(v.path, { ...opts, deadlineMs: 300 }));
    expect(r.error).toBe("agent: reading the answer: context deadline exceeded");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
  });

  test("`lock`'s wait for the socket to vanish", async () => {
    const r = await withFake('{"v":1,"ok":true,"pid":77}\n', () => stopAgentAndWait(v.path, { ...opts, waitMs: 200 }));
    expect(r.error).toBe("agent: waiting for the agent (pid 77) to exit: context deadline exceeded");
    const r2 = await withFake(() => "VANISH", () => stopAgentAndWait(v.path, opts));
    expect(r2.result).toBeUndefined();
    expect(r2.error).toBeUndefined();
  });
});

describe("key answers", () => {
  const K = (k: string) => `{"v":1,"ok":true,"key":${k}}\n`;
  test("a valid key", async () => {
    const r = await withFake(K(`"${v.key}"`), () => agentKey(v.path, v.digest, opts));
    expect(r.reqs[0]).toBe(`{"v":1,"op":"key","key_block":"${v.digest}"}\n`);
    expect(r.result?.kind).toBe("key");
    if (r.result?.kind === "key") expect(r.result.identity.equals(v.identity)).toBe(true);
  });
  const table: Array<[string, string, string]> = [
    ["no key", '{"v":1,"ok":true}\n', "agent: the agent's answer holds no vault key"],
    ["key null", K("null"), "agent: the agent's answer holds no vault key"],
    ["lower case", K(`"${"AGE-SECRET-KEY-1" + "q".repeat(58)}"`), "agent: the agent's answer holds no valid vault key: not a vault key"],
    ["bad checksum", K(`"AGE-SECRET-KEY-1${"Q".repeat(58)}"`), "agent: the agent's answer holds no valid vault key: not a valid vault key"],
    ["refused", '{"v":1,"ok":false,"code":"bad_request","error":"nope"}\n', "agent: the agent refused the request: nope"],
  ];
  for (const [name, a, want] of table) {
    test(name, async () => expect((await withFake(a, () => agentKey(v.path, v.digest, opts))).error).toBe(want));
  }
  test("key_block_changed and expired", async () => {
    expect((await withFake('{"v":1,"ok":false,"code":"key_block_changed","error":"x"}\n', () => agentKey(v.path, v.digest, opts))).result).toEqual({ kind: "key_block_changed" });
    expect((await withFake('{"v":1,"ok":false,"code":"expired","error":"x"}\n', () => agentKey(v.path, v.digest, opts))).result).toEqual({ kind: "none" });
  });
});

describe("folder, socket and peer (§A2.2, §A2.7)", () => {
  test("no folder → no agent", async () => {
    const e2 = isolatedEnv("agnofold");
    try {
      const v2 = await makeVault(e2.vault);
      expect(await agentStatus(v2.path, { env: e2.env })).toBeUndefined();
    } finally {
      e2.cleanup();
    }
  });

  test("the folder checks fail as `agent: <folder error>`", async () => {
    mkdirSync(sock.dir, { recursive: true, mode: 0o700 });
    chmodSync(sock.dir, 0o755);
    try {
      await expect(agentStatus(v.path, opts)).rejects.toThrow(`agent: agent folder ${sock.dir} has mode 0755, not 0700; refusing to use it (fix it with chmod 700, or remove it)`);
    } finally {
      chmodSync(sock.dir, 0o700);
    }
    const real = join(e.dir, "realagent");
    mkdirSync(real, { mode: 0o700 });
    rmSync(sock.dir, { recursive: true });
    symlinkSync(real, sock.dir);
    try {
      await expect(agentStatus(v.path, opts)).rejects.toThrow(`agent: agent folder ${sock.dir} is not a directory (a symlink or a file); refusing to use it`);
    } finally {
      rmSync(sock.dir);
      mkdirSync(sock.dir, { mode: 0o700 });
    }
  });

  test("no socket, a file or a folder at the socket path → no agent; mode 000 → connect error", async () => {
    mkdirSync(sock.dir, { recursive: true, mode: 0o700 });
    expect(await agentStatus(v.path, opts)).toBeUndefined();
    writeFileSync(sock.path, "x");
    expect(await agentStatus(v.path, opts)).toBeUndefined();
    rmSync(sock.path);
    mkdirSync(sock.path);
    expect(await agentStatus(v.path, opts)).toBeUndefined();
    rmSync(sock.path, { recursive: true });
    if (getuid() !== 0) {
      const r = await withFake('{"v":1,"ok":true}\n', async () => {
        chmodSync(sock.path, 0);
        return agentStatus(v.path, opts);
      });
      expect(r.error).toBe(`agent: connecting to ${sock.path}: dial unix ${sock.path}: connect: permission denied`);
    }
  });

  test("a foreign peer is refused", async () => {
    const r = await withFake('{"v":1,"ok":true}\n', () => agentStatus(v.path, { ...opts, peerUid: getuid() + 1 }));
    expect(r.error).toBe(`agent: refusing the agent socket ${sock.path}: peer is uid ${getuid()}, not uid ${getuid() + 1}`);
    expect(r.reqs).toEqual([]);
  });
});

describe("the agent as a key source (§A2.8)", () => {
  const req = () => ({ path: v.path, realPath: v.path, keyBlock: v.keyBlock, keyBlockDigest: v.digest });
  test("served, none, key_block_changed, other errors", async () => {
    let io = captureIO();
    let r = await withFake(`{"v":1,"ok":true,"key":"${v.key}"}\n`, () => agentKeySource(io, opts).getKey(req()));
    expect(r.result?.equals(v.identity)).toBe(true);
    expect(io.err).toEqual([]);

    io = captureIO();
    r = await withFake('{"v":1,"ok":false,"code":"expired","error":"x"}\n', () => agentKeySource(io, opts).getKey(req()));
    expect(r.result).toBeUndefined();
    expect(io.err).toEqual([]);

    io = captureIO();
    r = await withFake('{"v":1,"ok":false,"code":"key_block_changed","error":"x"}\n', () => agentKeySource(io, opts).getKey(req()));
    expect(r.result).toBeUndefined();
    expect(io.err).toEqual(["passh: the vault's key block isn't the one `passh unlock` opened (passwd elsewhere, or damaged): the agent's key isn't used; asking for the passphrase"]);

    io = captureIO();
    r = await withFake('{"v":1,"ok":false,"code":"bad_request","error":"nope"}\n', () => agentKeySource(io, opts).getKey(req()));
    expect(r.result).toBeUndefined();
    expect(io.err).toEqual([`passh: warning: can't use the agent of ${v.path}: agent: the agent refused the request: nope`]);
  });

  test("`~/` form of the file", async () => {
    const io = captureIO();
    const inHome = join(e.home, "v.passh");
    const v2 = await makeVault(inHome);
    const s2 = agentSocketPath(v2.path, { env: e.env });
    const f = fakeAgent(s2.path, "x\n");
    try {
      await agentKeySource(io, opts).getKey({ path: inHome, realPath: inHome, keyBlock: v2.keyBlock, keyBlockDigest: v2.digest });
    } finally {
      f.stop();
    }
    expect(io.err).toEqual(["passh: warning: can't use the agent of ~/v.passh: agent: malformed answer"]);
  });

  test("verify --full: the file's agent, then the configured vault's (its key_block_changed is silent)", async () => {
    const copy = join(e.dir, "copy.passh");
    writeFileSync(copy, require("node:fs").readFileSync(v.path));
    const copySock = agentSocketPath(copy, { env: e.env });
    const creq = { path: copy, realPath: copy, keyBlock: v.keyBlock, keyBlockDigest: v.digest };
    // Only the configured vault's agent runs and serves.
    let io = captureIO();
    let r = await withFake(`{"v":1,"ok":true,"key":"${v.key}"}\n`, () => verifyKeySource(io, v.path, opts).getKey(creq));
    expect(r.result?.equals(v.identity)).toBe(true);
    expect(io.err).toEqual([]);
    // Configured vault's agent: key_block_changed → silent.
    io = captureIO();
    r = await withFake('{"v":1,"ok":false,"code":"key_block_changed","error":"x"}\n', () => verifyKeySource(io, v.path, opts).getKey(creq));
    expect(r.result).toBeUndefined();
    expect(io.err).toEqual([]);
    // Both refuse: two warnings, the file's first.
    io = captureIO();
    const own = fakeAgent(copySock.path, '{"v":1,"ok":false,"code":"bad_request","error":"nope2"}\n');
    try {
      r = await withFake('{"v":1,"ok":false,"code":"bad_request","error":"nope"}\n', () => verifyKeySource(io, v.path, opts).getKey(creq));
    } finally {
      own.stop();
    }
    expect(io.err).toEqual([
      `passh: warning: can't use the agent of ${copy}: agent: the agent refused the request: nope2`,
      `passh: warning: can't use the agent of ${v.path}: agent: the agent refused the request: nope`,
    ]);
    // The same file (by real path) is asked once.
    io = captureIO();
    r = await withFake('{"v":1,"ok":false,"code":"bad_request","error":"nope"}\n', () => verifyKeySource(io, v.path, opts).getKey(req()));
    expect(r.reqs.length).toBe(1);
    expect(io.err.length).toBe(1);
  });
});
