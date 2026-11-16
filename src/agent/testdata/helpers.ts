// Test helpers for src/agent: an in-process raw client, fake agents, a fake clock, vault
// files made with our own modules, and agent children started through the launcher in an
// isolated environment (and always stopped).

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { X25519Identity } from "../../age/index.ts";
import { encryptData, keyBlockDigest, wrapKeyBlock } from "../../keys/index.ts";
import { encodeContainer } from "../../vaultfile/index.ts";
import { spawnAgentChild, type AgentChild } from "../../exec/index.ts";
import type { Clock } from "../times.ts";

export const LAUNCHER = join(import.meta.dir, "launcher.ts");

/**
 * The agent command for tests: the launcher under `env -i` with exactly the isolated
 * environment (spawnAgentChild passes this process's environment, which may be the real
 * user's). `env` execs bun, so the pid stays the agent's.
 */
export function launcherCommand(env: Record<string, string>): string[] {
  return ["/usr/bin/env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), process.execPath, "run", LAUNCHER];
}

/** A fake clock for the server: both clocks advance together unless told otherwise. */
export function fakeClock(start = 1_000_000) {
  const t = { mono: start, wall: 1_700_000_000_000 };
  const clock: Clock & { advance(ms: number, which?: "both" | "mono" | "wall"): void } = {
    mono: () => t.mono,
    wall: () => t.wall,
    advance(ms, which = "both") {
      if (which !== "wall") t.mono += ms;
      if (which !== "mono") t.wall += ms;
    },
  };
  return clock;
}

export interface TestVault {
  path: string;
  identity: X25519Identity;
  keyBlock: Uint8Array;
  digest: string;
  key: string;
}

/** Writes a vault file (low scrypt work factor; the agent never decrypts it). */
export async function makeVault(path: string, passphrase = "pass"): Promise<TestVault> {
  const identity = X25519Identity.generate();
  const keyBlock = await wrapKeyBlock(identity, new TextEncoder().encode(passphrase), 10);
  const data = encryptData(new TextEncoder().encode('{"version":1,"entries":[]}'), identity);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, encodeContainer(keyBlock, data), { mode: 0o600 });
  return { path, identity, keyBlock, digest: keyBlockDigest(keyBlock), key: identity.format() };
}

export interface RawReply {
  /** Everything received. */
  text: string;
  /** How it ended: the peer closed, or our wait ran out. */
  ended: "closed" | "waited";
}

/** A raw client: connects, writes `data` (optionally half-closes), collects until close. */
export async function rawRequest(path: string, data: string | Uint8Array, opts: { halfClose?: boolean; waitMs?: number; noWrite?: boolean } = {}): Promise<RawReply> {
  let got = Buffer.alloc(0);
  let done!: (how: "closed" | "waited") => void;
  const fin = new Promise<"closed" | "waited">((r) => (done = r));
  const s = await Bun.connect({
    unix: path,
    socket: {
      open(sock) {
        if (!opts.noWrite) sock.write(data);
        if (opts.halfClose) sock.shutdown();
      },
      data(_s, d) {
        got = Buffer.concat([got, Buffer.from(d)]);
      },
      close() {
        done("closed");
      },
      end() {
        done("closed");
      },
      error() {
        done("closed");
      },
    },
  });
  const t = setTimeout(() => done("waited"), opts.waitMs ?? 7000);
  const ended = await fin;
  clearTimeout(t);
  try {
    s.terminate();
  } catch {}
  return { text: got.toString("latin1"), ended };
}

export type FakeAnswer = string | null | "HANG" | ((req: string) => string | null | "HANG" | "CLOSE" | "VANISH");

/** A fake agent on `path` (folder 0700, socket 0600) answering every request with `answer`. */
export function fakeAgent(path: string, answer: FakeAnswer) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  rmSync(path, { force: true });
  const reqs: string[] = [];
  const srv = Bun.listen({
    unix: path,
    socket: {
      data(s, d) {
        const req = Buffer.from(d).toString("latin1");
        reqs.push(req);
        const a = typeof answer === "function" ? answer(req) : answer;
        if (a === "HANG") return;
        if (a === "VANISH") {
          rmSync(path, { force: true });
          s.end();
          return;
        }
        if (a === null || a === "CLOSE") {
          s.end();
          return;
        }
        s.write(a);
        s.end();
      },
    },
  });
  chmodSync(path, 0o600);
  return {
    reqs,
    stop() {
      try {
        srv.stop(true);
      } catch {}
      rmSync(path, { force: true });
    },
  };
}

/** Agent children started by a test file; killAll() in afterAll stops every one. */
export class Children {
  private readonly all: AgentChild[] = [];

  async start(env: Record<string, string>, args: string[], stdin: string | Uint8Array): Promise<AgentChild> {
    const c = await spawnAgentChild({
      command: launcherCommand(env),
      args: ["__agent", ...args],
      stdinData: typeof stdin === "string" ? new TextEncoder().encode(stdin) : stdin,
    });
    this.all.push(c);
    return c;
  }

  track(c: AgentChild): void {
    this.all.push(c);
  }

  async killAll(): Promise<void> {
    for (const c of this.all.splice(0)) {
      c.kill("SIGKILL");
      await Promise.race([c.exited, Bun.sleep(2000)]);
    }
  }
}

/** Waits until cond() holds (polling), or fails after timeoutMs. */
export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000, what = "condition"): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}
