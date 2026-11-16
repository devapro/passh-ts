// Interop of the agent (src/agent) with the reference implementation (reference/passh-go,
// run as a black box), in both directions:
//
//   a. passh-go's agent (started by `passh-go unlock` on a PTY) answers our client:
//      status, key (the key opens the vault), lock/stop, unlock's `Already unlocked`, the
//      key source's note for another key block, doctor's rows;
//   b. both agents get the same malformed requests from a raw socket client: their
//      answers are compared byte for byte (time fields aside);
//   c. our agent (the launcher, fed the key of a vault passh-go made) serves passh-go's
//      commands without a terminal: generate/ls/show, doctor, unlock (`Already
//      unlocked`), lock (stops our agent), then `vault is locked`;
//   d. our unlock starts our agent and passh-go uses it; passh-go's `passwd` stops our
//      agent with the reference's message.
//
// Every agent started here is stopped (lock, else kill) and every environment removed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, REF_BIN, run, type IsolatedEnv } from "../helpers/env.ts";
import { initVault, PASS } from "../helpers/passh.ts";
import { spawnPty } from "../helpers/pty.ts";
import { agentSocketPath, loadConfig, realPath } from "../../src/config/index.ts";
import { parseContainer } from "../../src/vaultfile/index.ts";
import { decryptData, keyBlockDigest, unwrapKeyBlock } from "../../src/keys/index.ts";
import { X25519Identity } from "../../src/age/index.ts";
import { captureIO } from "../../src/util/io.ts";
import {
  agentDoctorInfo,
  agentKey,
  agentKeySource,
  agentStatus,
  formatAgentTimes,
  runLock,
  runUnlock,
} from "../../src/agent/index.ts";
import { Children, launcherCommand, rawRequest } from "../../src/agent/testdata/helpers.ts";

let e: IsolatedEnv;
let real: string;
let sockPath: string;
let key = "";
let digest = "";
const kids = new Children();
const envs: IsolatedEnv[] = [];

async function refLock(env = e) {
  return run([REF_BIN, "lock"], env.env);
}

async function refUnlockPty(env = e, extra: string[] = []) {
  const p = spawnPty([REF_BIN, ...extra, "unlock"], env.env);
  await p.expect("Passphrase: ");
  p.line(PASS);
  return p.wait(30_000);
}

beforeAll(async () => {
  e = isolatedEnv("iagent");
  envs.push(e);
  await initVault([REF_BIN], e);
  real = realPath(e.vault);
  sockPath = agentSocketPath(real, { env: e.env }).path;
  const c = parseContainer(readFileSync(e.vault));
  digest = keyBlockDigest(c.keyBlock);
  const id = await unwrapKeyBlock(c.keyBlock, new TextEncoder().encode(PASS));
  key = id.format();
  id.wipe();
}, 60_000);

afterAll(async () => {
  for (const x of envs) await refLock(x).catch(() => {});
  await kids.killAll();
  for (const x of envs) x.cleanup();
});

const STATUS = '{"v":1,"op":"status"}\n';

describe("a. passh-go's agent, our client", () => {
  let pid = 0;
  beforeAll(async () => {
    const r = await refUnlockPty();
    expect(r.code).toBe(0);
    pid = Number(/pid (\d+)/.exec(r.output)![1]);
  }, 60_000);
  afterAll(async () => {
    await refLock();
  });

  test("status and times", async () => {
    const st = await agentStatus(real, { env: e.env });
    expect(st).toBeDefined();
    expect(Number(st!.pid)).toBe(pid);
    expect(st!.vault).toBe(real);
    expect(formatAgentTimes(st!.pid, st!.idleLeftMs, st!.maxLeftMs)).toMatch(new RegExp(`^the agent \\(pid ${pid}\\) exits in (15m|14m5\\ds) if unused, in (2h|1h59m) at the latest$`));
  });

  test("key: the key opens the vault's data block", async () => {
    const k = await agentKey(real, digest, { env: e.env });
    expect(k.kind).toBe("key");
    if (k.kind !== "key") return;
    expect(k.identity.format()).toBe(key);
    const json = new TextDecoder().decode(decryptData(parseContainer(readFileSync(e.vault)).dataBlock, k.identity, "agent"));
    expect(JSON.parse(json).version).toBe(1);
    k.identity.wipe();
  });

  test("another key block: our key source notes it and falls through", async () => {
    const io = captureIO();
    const id = await agentKeySource(io, { env: e.env }).getKey({ path: e.vault, realPath: real, keyBlock: new Uint8Array(1), keyBlockDigest: "0".repeat(64) });
    expect(id).toBeUndefined();
    expect(io.err).toEqual(["passh: the vault's key block isn't the one `passh unlock` opened (passwd elsewhere, or damaged): the agent's key isn't used; asking for the passphrase"]);
  });

  test("our unlock (no terminal) says `Already unlocked` like passh-go's", async () => {
    const config = loadConfig({ env: e.env });
    const io = captureIO();
    await runUnlock({ config, vaultPath: config.vault, ttl: 60_000_000_000n, io, tty: null, env: e.env, openWithPassphrase: () => Promise.reject(new Error("not asked")) });
    const ref = await run([REF_BIN, "unlock", "--ttl", "1m"], e.env);
    expect(ref.code).toBe(0);
    expect(io.err.join("\n") + "\n").toBe(ref.stderr);
  });

  test("doctor's agent rows", async () => {
    const ref = await run([REF_BIN, "doctor"], e.env);
    const info = await agentDoctorInfo(real, { env: e.env });
    const lines = ref.stdout.split("\n");
    expect(lines.find((l) => l.startsWith("ok     agent folder  "))).toBe(`ok     agent folder  ${info.folder.message}`);
    expect(lines.find((l) => /^\w+ +agent  /.test(l))).toBe(`info   agent         ${info.agent!.message}`);
  });

  test("our lock stops it: the process is gone", async () => {
    const io = captureIO();
    const config = loadConfig({ env: e.env });
    await runLock({ config, vaultPath: config.vault, io, env: e.env });
    expect(io.err).toEqual([`Locked: the agent (pid ${pid}) stopped.`]);
    expect(existsSync(sockPath)).toBe(false);
    // The agent exits right after removing its socket (a zombie until reaped counts as gone).
    const gone = () => {
      try {
        return /^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "latin1"));
      } catch {
        return true;
      }
    };
    const until = Date.now() + 3000;
    while (!gone() && Date.now() < until) await Bun.sleep(20);
    expect(gone()).toBe(true);
    const io2 = captureIO();
    await runLock({ config, vaultPath: config.vault, io: io2, env: e.env });
    const ref = await refLock();
    expect(io2.err.join("\n") + "\n").toBe(ref.stderr);
  });
});

describe("b. the same malformed requests to both agents", () => {
  let copy: string;
  let ourSock: string;
  beforeAll(async () => {
    // passh-go's agent on the vault, ours on a copy (same key block, another socket).
    expect((await refUnlockPty()).code).toBe(0);
    copy = join(e.dir, "copy.passh");
    writeFileSync(copy, readFileSync(e.vault));
    ourSock = agentSocketPath(realPath(copy), { env: e.env }).path;
    const c = await kids.start(e.env, [`--vault=${copy}`, "--idle-ttl=15m", "--max-ttl=2h"], `${key}\n${digest}\n`);
    expect(await c.readReadiness()).toEqual({ kind: "line", line: "ok", truncated: false });
  }, 60_000);
  afterAll(async () => {
    await refLock();
    if (existsSync(ourSock)) await rawRequest(ourSock, '{"v":1,"op":"stop"}\n');
  });

  const enc = new TextEncoder();
  const requests = (): Array<string | Uint8Array> => [
    STATUS,
    STATUS.replace("\n", "\r\n"),
    `{"v":1,"op":"key","key_block":"${digest}"}\n`,
    `{"v":1,"op":"key","key_block":"${digest}"}\r\n`,
    `{"V":1,"OP":"key","\\u212aey_block":"${digest}"}\n`,
    `{"v":1,"op":"key","key_block":"${digest}","key_block":null}\n`,
    "nonsense\n", "\n", "[]\n", '"x"\n', "null\n", "{}\n", '{"v":null}\n', '{"v":"1"}\n', '{"v":1.0}\n', '{"v":1e0}\n',
    '{"v":1,"op":5}\n', '{"v":1} x\n', '{"v":1}{}\n', '{"v":2,"op":"status"}\n', '{"v":-1}\n', '{"v":-0}\n', '{"v":01}\n',
    '{"v":9223372036854775807}\n', '{"v":9223372036854775808}\n', '{"v":true}\n', '{"v":"1","v":1}\n',
    '{"v":1,"op":null}\n', '{"v":1,"op":""}\n', '{"v":1}\n', '{"v":1,"op":"Status"}\n', '{"v":1,"op":"\\u017Ftatus"}\n',
    '{"v":1,"op":"st\\u00e9\\u0007"}\n', `{"v":1,"op":"${"x".repeat(40)}"}\n`, `{"v":1,"op":"${"é".repeat(40)}"}\n`,
    '{"v":1,"op":"<a>&\\u2028\\u2029"}\n', '{"v":1,"op":"a\\ud800b\\udc00c\\ud83d\\ude00"}\n', '{"v":1,"op":"\\"\\\\\\/\\b\\f\\n\\r\\t\\u0000\\u001f\\u007f"}\n',
    new Uint8Array([...enc.encode('{"v":1,"op":"st'), 0xff, 0xe2, 0x82, 0xc0, 0xaf, 0xed, 0xa0, 0x80, ...enc.encode('us"}\n')]),
    '{"v":1,"op":"stat\tus"}\n', '{"v":1,"op":"a\u0001"}\n', '{"v":1,"op":"status",}\n', '{"v":1,"op":"status","x":tru}\n',
    '{"v":1,"op":"status","x":[1,{"a":null}],"y":-1.5e+3}\n', ' {"v":1,"op":"status"} \n', STATUS + "GARBAGE",
    '{"v":1,"op":"key"}\n', '{"v":1,"op":"key","key_block":null}\n', '{"v":1,"op":"key","key_block":""}\n', '{"v":1,"op":"key","key_block":"ABC"}\n',
    `{"v":1,"op":"key","key_block":"${digest.toUpperCase()}"}\n`, `{"v":1,"op":"key","key_block":"${"0".repeat(64)}"}\n`, '{"v":1,"op":"key","key_block":5}\n',
    '{"v":2,"op":"nope"}\n', '{"v":1,"op":"nope","key_block":"x"}\n', '{"v":1,"op":"status","op":"key"}\n',
    "x".repeat(4096), '{"v":1,"op":"status"' + " ".repeat(4096 - 22) + "}\n", '{"v":1,"op":"status"' + " ".repeat(4097 - 22) + "}\n",
  ];

  /** Time fields and pids differ; everything else must be byte-identical. */
  const norm = (s: string) => s.replace(/"pid":\d+/, '"pid":N').replace(/"vault":"[^"]*"/, '"vault":V').replace(/"idle_left_ms":\d+,"max_left_ms":\d+/, "T");

  test("answers are identical", async () => {
    const diffs: string[] = [];
    for (const r of requests()) {
      const ref = await rawRequest(sockPath, r, { waitMs: 7000 });
      const ours = await rawRequest(ourSock, r, { waitMs: 7000 });
      if (ref.text === "" || norm(ref.text) !== norm(ours.text) || ref.ended !== ours.ended) diffs.push(`${JSON.stringify(typeof r === "string" ? r : Buffer.from(r).toString("latin1"))}\n  ref:  ${JSON.stringify(ref.text)}\n  ours: ${JSON.stringify(ours.text)}`);
    }
    expect(diffs).toEqual([]);
  }, 120_000);

  test("framing: no LF before a half-close gets no answer from either", async () => {
    const ref = await rawRequest(sockPath, STATUS.trim(), { halfClose: true, waitMs: 3000 });
    const ours = await rawRequest(ourSock, STATUS.trim(), { halfClose: true, waitMs: 3000 });
    expect(ref).toEqual({ text: "", ended: "closed" });
    expect(ours).toEqual(ref);
    // A complete line followed by a half-close is answered by both.
    expect(norm((await rawRequest(ourSock, STATUS, { halfClose: true })).text)).toBe(norm((await rawRequest(sockPath, STATUS, { halfClose: true })).text));
  });
});

describe("c. our agent serves passh-go's commands without a terminal", () => {
  let pid = 0;
  let child: Awaited<ReturnType<typeof kids.start>>;
  beforeAll(async () => {
    child = await kids.start(e.env, [`--vault=${e.vault}`, "--idle-ttl=15m", "--max-ttl=2h"], `${key}\n${digest}\n`);
    expect(await child.readReadiness()).toEqual({ kind: "line", line: "ok", truncated: false });
    pid = child.pid;
  }, 30_000);
  afterAll(async () => {
    if (existsSync(sockPath)) await rawRequest(sockPath, '{"v":1,"op":"stop"}\n');
  });

  test("generate, ls, show through our agent", async () => {
    const g = await run([REF_BIN, "generate", "work/github", "20"], e.env);
    expect(g.code).toBe(0);
    expect(g.stderr).toStartWith("Stored work/github: ");
    const ls = await run([REF_BIN, "ls"], e.env);
    expect(ls.code).toBe(0);
    expect(ls.stdout).toContain("github");
    const show = await run([REF_BIN, "show", "work/github", "--field", "password"], e.env);
    expect(show.code).toBe(0);
    expect(show.stdout.trim().length).toBe(20);
  });

  test("doctor's agent rows name our agent, and match ours", async () => {
    const ref = await run([REF_BIN, "doctor"], e.env);
    const info = await agentDoctorInfo(real, { env: e.env });
    expect(info.agent!.message).toContain(`(pid ${pid})`);
    expect(ref.stdout).toContain(`info   agent         ${info.agent!.message}\n`);
  });

  test("passh-go unlock: `Already unlocked` with our agent", async () => {
    const r = await run([REF_BIN, "unlock"], e.env);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(new RegExp(`^Already unlocked: the agent \\(pid ${pid}\\) exits in 15m if unused, in (2h|1h59m) at the latest\\.\\n$`));
  });

  test("passh-go lock stops our agent; then the vault is locked", async () => {
    const r = await refLock();
    expect(r).toMatchObject({ code: 0, stdout: "", stderr: `Locked: the agent (pid ${pid}) stopped.\n` });
    expect(await child.exited).toBe(0);
    expect(existsSync(sockPath)).toBe(false);
    const ls = await run([REF_BIN, "ls"], e.env);
    expect(ls.code).toBe(1);
    expect(ls.stderr).toBe("passh: vault is locked: run `passh unlock` in a terminal (over SSH: `ssh -t host passh unlock`)\n");
  });

  test("another key block in our agent: passh-go notes it", async () => {
    const other = X25519Identity.generate();
    const c = await kids.start(e.env, [`--vault=${e.vault}`, "--idle-ttl=15m", "--max-ttl=2h"], `${other.format()}\n${"0".repeat(64)}\n`);
    other.wipe();
    expect((await c.readReadiness()).kind).toBe("line");
    const ls = await run([REF_BIN, "ls"], e.env);
    expect(ls.stderr).toBe(
      "passh: the vault's key block isn't the one `passh unlock` opened (passwd elsewhere, or damaged): the agent's key isn't used; asking for the passphrase\n" +
        "passh: vault is locked: run `passh unlock` in a terminal (over SSH: `ssh -t host passh unlock`)\n",
    );
    expect((await refLock()).stderr).toBe(`Locked: the agent (pid ${c.pid}) stopped.\n`);
    expect(await c.exited).toBe(0);
  });
});

describe("d. our unlock starts our agent; passh-go uses it and stops it", () => {
  test("unlock, passh-go show/unlock, passh-go passwd stops it", async () => {
    const config = loadConfig({ env: e.env });
    const io = captureIO();
    await runUnlock({
      config,
      vaultPath: config.vault,
      io,
      tty: {},
      env: e.env,
      agentCommand: launcherCommand(e.env),
      openWithPassphrase: async () => {
        const c = parseContainer(readFileSync(e.vault));
        return { identity: await unwrapKeyBlock(c.keyBlock, new TextEncoder().encode(PASS)), keyBlock: c.keyBlock, realPath: real };
      },
    });
    expect(io.err[0]).toMatch(/^Unlocked .*: the agent \(pid \d+\) exits in 15m if unused, in 2h at the latest\.$/);
    const pid = Number(/pid (\d+)/.exec(io.err[0]!)![1]);
    const show = await run([REF_BIN, "show", "work/github", "--field", "password"], e.env);
    expect(show.code).toBe(0);
    const again = await run([REF_BIN, "unlock"], e.env);
    expect(again.stderr).toContain(`Already unlocked: the agent (pid ${pid})`);
    // passh-go passwd (on a PTY) stops our agent and says so.
    const p = spawnPty([REF_BIN, "passwd"], e.env);
    await p.expect("Current passphrase: ");
    p.line(PASS);
    await p.expect("New passphrase: ", 30_000);
    p.line(PASS + "2");
    await p.expect("Repeat passphrase: ");
    p.line(PASS + "2");
    const r = await p.wait(60_000);
    expect(r.code).toBe(0);
    expect(r.output).toContain("\r\nThe agent was unlocked with the old key block and was stopped; run `passh unlock` again if you need it.\r\n");
    expect(existsSync(sockPath)).toBe(false);
  }, 90_000);
});
