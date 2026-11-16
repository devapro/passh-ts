// The agent child (agent-session.md §A2.3 "Child", cli.md §2.27): argument and stdin
// parsing (texts observed on the reference agent), and the real process started through
// the launcher as `passh unlock` starts it: readiness, the protocol, expiry, the socket
// ownership check, signals, `running`, file modes, and the key never in argv/environ
// (§13.2 item 6). Every child is stopped in afterAll.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isolatedEnv, type IsolatedEnv } from "../../test/helpers/env.ts";
import { agentSocketPath } from "../config/index.ts";
import { parseChildArgs, parseStdinKey } from "./child.ts";
import { Children, LAUNCHER, makeVault, rawRequest, waitFor, type TestVault } from "./testdata/helpers.ts";

const enc = new TextEncoder();

function argsError(args: string[]): string {
  try {
    const a = parseChildArgs(args);
    return `ok ${a.vault} ${a.idleTtl} ${a.maxTtl}`;
  } catch (e) {
    return (e as Error).message;
  }
}

describe("arguments (Go flag package rules)", () => {
  const V = "/v.passh";
  const table: Array<[string[], string]> = [
    [[], "--vault must be an absolute path"],
    [["--vault=v.passh", "--idle-ttl=1m", "--max-ttl=1h"], "--vault must be an absolute path"],
    [[`--vault=${V}`, "--idle-ttl=0s", "--max-ttl=1h"], "--idle-ttl and --max-ttl must be positive"],
    [[`--vault=${V}`, "--idle-ttl=1m", "--max-ttl=-1h"], "--idle-ttl and --max-ttl must be positive"],
    [[`--vault=${V}`, "--idle-ttl=1m"], "--idle-ttl and --max-ttl must be positive"],
    [[`--vault=${V}`, "--idle-ttl=bad", "--max-ttl=1h"], 'invalid value "bad" for flag -idle-ttl: parse error'],
    [[`--vault=${V}`, "--idle-ttl=1", "--max-ttl=1h"], 'invalid value "1" for flag -idle-ttl: parse error'],
    [[`--vault=${V}`, "--idle-ttl=1m", "--max-ttl=1h", "x"], 'unexpected argument "x"'],
    [[`--vault=${V}`, "--idle-ttl=1m", "--max-ttl=1h", "--", "x"], 'unexpected argument "x"'],
    [[`--vault=${V}`, "--idle-ttl=1m", "--max-ttl=1h", "--foo=1"], "flag provided but not defined: -foo"],
    [["-h"], "flag: help requested"],
    [["--vault"], "flag needs an argument: -vault"],
    [["---vault=x"], "bad flag syntax: ---vault=x"],
    [["--vault", V, "--idle-ttl=1m", "--max-ttl=1h"], `ok ${V} 60000000000 3600000000000`],
    [["-vault=" + V, "-idle-ttl", "1m", "-max-ttl=1h"], `ok ${V} 60000000000 3600000000000`],
    [["--vault=/x", `--vault=${V}`, "--idle-ttl=15m0s", "--max-ttl=2h0m0s", "--"], `ok ${V} 900000000000 7200000000000`],
  ];
  for (const [args, want] of table) test(JSON.stringify(args), () => expect(argsError(args)).toBe(want));
});

describe("stdin (§A2.3 (e))", () => {
  const key = "AGE-SECRET-KEY-1H73CLMYM040VPHQ0JRRVF2RH4LK7UPR03HNQNVQQHJZMTLQJ6HQSN7H9NF";
  const digest = "54fabfdbfccea0ea512601f2683ad3b67fd4c0e0f4574d960245c7452597550a";
  const good = `${key}\n${digest}\n`;
  const run = (s: string) => {
    try {
      const r = parseStdinKey(enc.encode(s));
      return `ok ${new TextDecoder().decode(r.key) === key} ${r.digest === digest}`;
    } catch (e) {
      return (e as Error).message;
    }
  };
  const table: Array<[string, string, string]> = [
    ["good", good, "ok true true"],
    ["no final LF", `${key}\n${digest}`, "ok true true"],
    ["blank lines and spaces", `\n  ${key}  \r\n\n\t${digest}\n\n`, "ok true true"],
    ["NBSP trimmed", ` ${key} \n${digest}\n`, "ok true true"],
    ["511 bytes", good + " ".repeat(511 - good.length), "ok true true"],
    ["512 bytes", good + " ".repeat(512 - good.length), "the key on stdin is too long"],
    ["empty", "", "the key on stdin: nothing was sent"],
    ["white space only", "\n  \n\t\n", "the key on stdin: nothing was sent"],
    ["one line", key + "\n", "the key block digest is missing on stdin"],
    ["bad key, one line", "AGE-SECRET-KEY-1XYZ\n", "the key on stdin: not a valid vault key"],
    ["bad key", `AGE-SECRET-KEY-1XYZ\n${digest}\n`, "the key on stdin: not a valid vault key"],
    ["lower case", `${key.toLowerCase()}\n${digest}\n`, "the key on stdin: not a vault key"],
    ["digest first", `${digest}\n${key}\n`, "the key on stdin: not a vault key"],
    ["129 bytes", `AGE-SECRET-KEY-1${"Q".repeat(113)}\n${digest}\n`, "the key on stdin: not a vault key"],
    ["128 bytes, bad checksum", `AGE-SECRET-KEY-1${"Q".repeat(112)}\n${digest}\n`, "the key on stdin: not a valid vault key"],
    ["bare prefix", `AGE-SECRET-KEY-1\n${digest}\n`, "the key on stdin: not a vault key"],
    ["CR only", `${key}\r${digest}\r`, "the key on stdin: not a vault key"],
    ["NUL", `${key}\0\n${digest}\n`, "the key on stdin: not a vault key"],
    ["bad digest", `${key}\n${digest.toUpperCase()}\n`, "the key block digest on stdin is not a SHA-256"],
    ["short digest", `${key}\n${digest.slice(1)}\n`, "the key block digest on stdin is not a SHA-256"],
    ["three lines", good + "x\n", "the key on stdin: unexpected extra lines"],
    ["three lines, all bad", "xx\nyy\nzz\n", "the key on stdin: unexpected extra lines"],
  ];
  for (const [name, s, want] of table) test(name, () => expect(run(s)).toBe(want));
  test("the input buffer is wiped", () => {
    const b = enc.encode(good);
    parseStdinKey(b);
    expect(b.every((x) => x === 0)).toBe(true);
  });
});

describe("the agent process", () => {
  let e: IsolatedEnv;
  let v: TestVault;
  let sock: ReturnType<typeof agentSocketPath>;
  const kids = new Children();
  const STATUS = '{"v":1,"op":"status"}\n';
  beforeAll(async () => {
    e = isolatedEnv("agchild");
    v = await makeVault(e.vault);
    sock = agentSocketPath(v.path, { env: e.env });
  });
  afterAll(async () => {
    // Stop politely first (removes the socket), then make sure.
    if (existsSync(sock.path)) await rawRequest(sock.path, '{"v":1,"op":"stop"}\n', { waitMs: 2000 }).catch(() => {});
    await kids.killAll();
    e.cleanup();
  });
  const start = (args: string[], stdin = `${v.key}\n${v.digest}\n`) => kids.start(e.env, args, stdin);
  const std = (idle = "1m", max = "1h") => [`--vault=${v.path}`, `--idle-ttl=${idle}`, `--max-ttl=${max}`];

  test("run by hand (fd 3 not a FIFO): usage message, exit 2", async () => {
    const p = Bun.spawn([process.execPath, "run", LAUNCHER, "__agent", ...std()], { env: e.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(2);
    expect(await new Response(p.stderr).text()).toBe("passh: __agent is started by `passh unlock`, not by hand\n");
    const f = join(e.dir, "fd3file");
    writeFileSync(f, "");
    const p2 = Bun.spawn([process.execPath, "run", LAUNCHER, "__agent"], { env: e.env, stdio: ["ignore", "pipe", "pipe", Bun.file(f)] as any });
    expect(await p2.exited).toBe(2);
  });

  test("serves; modes; the key in no argv or environment; a second start says running; stop exits 0", async () => {
    const c = await start(std());
    expect(await c.readReadiness()).toEqual({ kind: "line", line: "ok", truncated: false });
    expect(statSync(sock.dir).mode & 0o7777).toBe(0o700);
    expect(lstatSync(sock.path).mode & 0o7777).toBe(0o600);
    const st = await rawRequest(sock.path, STATUS);
    expect(st.text).toBe(`{"v":1,"ok":true,"pid":${c.pid},"vault":"${v.path}","idle_left_ms":${JSON.parse(st.text).idle_left_ms},"max_left_ms":${JSON.parse(st.text).max_left_ms}}\n`);
    expect((await rawRequest(sock.path, `{"v":1,"op":"key","key_block":"${v.digest}"}\n`)).text).toBe(`{"v":1,"ok":true,"key":"${v.key}"}\n`);
    // §13.2 item 6: /proc/<pid>/cmdline and environ.
    if (existsSync(`/proc/${c.pid}/cmdline`)) {
      const cmdline = readFileSync(`/proc/${c.pid}/cmdline`, "latin1");
      const environ = readFileSync(`/proc/${c.pid}/environ`, "latin1");
      expect(cmdline).toContain("__agent");
      expect(cmdline).not.toContain(v.key);
      expect(cmdline.toLowerCase()).not.toContain(v.key.toLowerCase().slice(16));
      expect(environ).not.toContain(v.key.slice(16));
      expect(environ).not.toContain(v.digest);
    }
    const c2 = await start(std());
    expect(await c2.readReadiness()).toEqual({ kind: "line", line: "running", truncated: false });
    expect(await c2.exited).toBe(1);
    const stop = await rawRequest(sock.path, '{"v":1,"op":"stop"}\n');
    expect(stop.text).toContain(`"pid":${c.pid}`);
    expect(await c.exited).toBe(0);
    expect(existsSync(sock.path)).toBe(false);
  }, 20_000);

  test("readiness errors", async () => {
    const cases: Array<[string[], string, string]> = [
      [[], `${v.key}\n${v.digest}\n`, "error: agent: --vault must be an absolute path"],
      [["--vault=/nonexist/v.passh", "--idle-ttl=1m", "--max-ttl=1h"], `${v.key}\n${v.digest}\n`, "error: agent: resolving the vault path: lstat /nonexist: no such file or directory"],
      [std(), "", "error: agent: the key on stdin: nothing was sent"],
      [std(), `${v.key}\n`, "error: agent: the key block digest is missing on stdin"],
    ];
    for (const [args, stdin, want] of cases) {
      const c = await start(args, stdin);
      expect(await c.readReadiness()).toEqual({ kind: "line", line: want, truncated: false });
      expect(await c.exited).toBe(1);
    }
    // A file at the socket path.
    writeFileSync(sock.path, "x");
    try {
      const c = await start(std());
      expect(await c.readReadiness()).toEqual({ kind: "line", line: `error: agent: ${sock.path} exists and is not a socket; refusing to replace it`, truncated: false });
    } finally {
      rmSync(sock.path);
    }
  }, 30_000);

  test("idle expiry: the process exits and removes its socket", async () => {
    const c = await start(std("400ms", "1h"));
    expect((await c.readReadiness()).kind).toBe("line");
    expect(existsSync(sock.path)).toBe(true);
    const t0 = Date.now();
    expect(await c.exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(existsSync(sock.path)).toBe(false);
  }, 20_000);

  test("max expiry while in use", async () => {
    const c = await start(std("300ms", "900ms"));
    expect((await c.readReadiness()).kind).toBe("line");
    const t0 = Date.now();
    let served = 0;
    while (Date.now() - t0 < 3000 && existsSync(sock.path)) {
      const r = await rawRequest(sock.path, `{"v":1,"op":"key","key_block":"${v.digest}"}\n`, { waitMs: 1000 }).catch(() => ({ text: "" }));
      if (r.text.includes('"key"')) served++;
      await Bun.sleep(100);
    }
    expect(await c.exited).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(600);
    expect(served).toBeGreaterThan(3);
  }, 20_000);

  test("socket removed → exits; socket replaced → exits and leaves the new one", async () => {
    let c = await start(std());
    expect((await c.readReadiness()).kind).toBe("line");
    rmSync(sock.path);
    expect(await c.exited).toBe(0);
    c = await start(std());
    expect((await c.readReadiness()).kind).toBe("line");
    renameSync(sock.path, join(dirname(sock.path), "moved"));
    writeFileSync(sock.path, "new");
    expect(await c.exited).toBe(0);
    expect(readFileSync(sock.path, "utf8")).toBe("new");
    rmSync(sock.path);
    rmSync(join(dirname(sock.path), "moved"));
  }, 20_000);

  test("SIGHUP is ignored; SIGTERM and SIGINT stop it cleanly", async () => {
    const c = await start(std());
    expect((await c.readReadiness()).kind).toBe("line");
    c.kill("SIGHUP");
    await Bun.sleep(300);
    expect((await rawRequest(sock.path, STATUS)).text).toContain('"ok":true');
    c.kill("SIGTERM");
    expect(await c.exited).toBe(0);
    expect(existsSync(sock.path)).toBe(false);
    const c2 = await start(std());
    expect((await c2.readReadiness()).kind).toBe("line");
    c2.kill("SIGINT");
    expect(await c2.exited).toBe(0);
    expect(existsSync(sock.path)).toBe(false);
  }, 20_000);

  test("readiness comes quickly enough", async () => {
    const t0 = Date.now();
    const c = await start(std());
    expect((await c.readReadiness()).kind).toBe("line");
    expect(Date.now() - t0).toBeLessThan(5000);
    await rawRequest(sock.path, '{"v":1,"op":"stop"}\n');
    await waitFor(() => !existsSync(sock.path), 3000, "the socket to go");
    expect(await c.exited).toBe(0);
  });
});
