// The agent process `passh __agent …` (agent-session.md §A2.3 "Child", cli.md §2.27):
// (a) fd 3 must be a FIFO, (b) umask 077, (c) core dumps off, (d) arguments, (e) the key
// and the key block digest on stdin, (f) signals, (g) folder and socket, (h) readiness
// `ok` on fd 3, (i) serve. The child never reads a config file and speaks English: its
// readiness texts are the reference's.

import { closeSync, fstatSync, readSync, writeSync } from "node:fs";
import { agentSocketPath, realPath } from "../config/index.ts";
import { disableCoreDumps } from "../harden/index.ts";
import { goQuote } from "../i18n/quote.ts";
import { decodeRune } from "../i18n/quote.ts";
import { DurationError, parseGoDuration } from "../util/duration.ts";
import { isWhiteSpace } from "../util/unicode.ts";
import { isHexDigest, parseKeyText } from "./protocol.ts";
import { AgentServer, BindError } from "./server.ts";

/** What `unlock` writes on the agent's stdin, at most (§A1). */
export const STDIN_MAX = 511;

/** The readiness descriptor (§A2.3). */
const READY_FD = 3;

export interface ChildArgs {
  vault: string;
  idleTtl: bigint;
  maxTtl: bigint;
}

/**
 * Parses the child's arguments like Go's flag package (the reference's): `-name=value`,
 * `--name=value`, `-name value`, a repeated flag keeps its last value, `--` ends the flags,
 * the first non-flag argument is `unexpected argument "<arg>"`. Then `--vault` must be
 * absolute and both TTLs positive. Throws Error with the reference's text (without `agent: `).
 */
export function parseChildArgs(args: readonly string[]): ChildArgs {
  let vault = "";
  let idleTtl = 0n;
  let maxTtl = 0n;
  let i = 0;
  for (;;) {
    if (i >= args.length) break;
    const s = args[i]!;
    if (s.length < 2 || s[0] !== "-") break;
    let minuses = 1;
    if (s[1] === "-") {
      minuses = 2;
      if (s.length === 2) {
        i++;
        break;
      }
    }
    let name = s.slice(minuses);
    if (name.length === 0 || name[0] === "-" || name[0] === "=") throw new Error(`bad flag syntax: ${s}`);
    i++;
    let value: string | undefined;
    const eq = name.indexOf("=", 1);
    if (eq >= 1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (name !== "vault" && name !== "idle-ttl" && name !== "max-ttl") {
      if (name === "help" || name === "h") throw new Error("flag: help requested");
      throw new Error(`flag provided but not defined: -${name}`);
    }
    if (value === undefined) {
      if (i >= args.length) throw new Error(`flag needs an argument: -${name}`);
      value = args[i++]!;
    }
    if (name === "vault") {
      vault = value;
      continue;
    }
    let d: bigint;
    try {
      d = parseGoDuration(value);
    } catch (e) {
      if (e instanceof DurationError) throw new Error(`invalid value ${goQuote(value)} for flag -${name}: parse error`);
      throw e;
    }
    if (name === "idle-ttl") idleTtl = d;
    else maxTtl = d;
  }
  if (i < args.length) throw new Error(`unexpected argument ${goQuote(args[i]!)}`);
  if (!vault.startsWith("/")) throw new Error("--vault must be an absolute path");
  if (idleTtl <= 0n || maxTtl <= 0n) throw new Error("--idle-ttl and --max-ttl must be positive");
  return { vault, idleTtl, maxTtl };
}

/** Go's bytes.TrimSpace on a byte slice (Unicode White_Space; invalid UTF-8 isn't space). */
function trimBytes(b: Uint8Array): Uint8Array {
  let a = 0;
  let e = b.length;
  while (a < e) {
    const [cp, n] = decodeRune(b, a);
    if (cp < 0 || !isWhiteSpace(cp)) break;
    a += n;
  }
  while (e > a) {
    // Find the start of the last character.
    let s = e - 1;
    while (s > a && (b[s]! & 0xc0) === 0x80 && e - s < 4) s--;
    const [cp, n] = decodeRune(b, s);
    if (cp < 0 || s + n !== e || !isWhiteSpace(cp)) break;
    e = s;
  }
  return b.subarray(a, e);
}

export interface StdinKey {
  /** The key text (ASCII bytes, a copy the caller owns and wipes). */
  key: Uint8Array;
  digest: string;
}

/**
 * Reads what `unlock` sent (§A2.3 (e)): at most 511 bytes; lines trimmed, blank ones
 * dropped; exactly two: a valid key and a 64-character lower-case hex digest. The input
 * buffer is wiped. Throws Error with the reference's texts (without `agent: `).
 */
export function parseStdinKey(input: Uint8Array): StdinKey {
  try {
    if (input.length > STDIN_MAX) throw new Error("the key on stdin is too long");
    const lines: Uint8Array[] = [];
    let start = 0;
    for (let i = 0; i <= input.length; i++) {
      if (i === input.length || input[i] === 0x0a) {
        const t = trimBytes(input.subarray(start, i));
        if (t.length > 0) lines.push(t);
        start = i + 1;
      }
    }
    if (lines.length === 0) throw new Error("the key on stdin: nothing was sent");
    if (lines.length > 2) throw new Error("the key on stdin: unexpected extra lines");
    const id = parseKeyText(lines[0]!);
    if (typeof id === "string") throw new Error(`the key on stdin: ${id}`);
    id.wipe();
    if (lines.length < 2) throw new Error("the key block digest is missing on stdin");
    const digest = new TextDecoder().decode(lines[1]!);
    if (!isHexDigest(digest)) throw new Error("the key block digest on stdin is not a SHA-256");
    return { key: Uint8Array.from(lines[0]!), digest };
  } finally {
    input.fill(0);
  }
}

/** Reads fd 0 to EOF, at most `limit` + 1 bytes (enough to see that it is too long). */
function readStdin(limit: number): Uint8Array {
  const buf = new Uint8Array(limit + 1);
  let n = 0;
  for (;;) {
    if (n >= buf.length) break;
    let r: number;
    try {
      r = readSync(0, buf, n, buf.length - n, null);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "EAGAIN" || code === "EINTR") {
        Bun.sleepSync(1);
        continue;
      }
      if (code === "EOF") break;
      buf.fill(0);
      throw e;
    }
    if (r === 0) break;
    n += r;
  }
  const out = buf.slice(0, n);
  buf.fill(0);
  return out;
}

function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, " ");
}

/** Test hooks for runAgentChild. */
export interface ChildHooks {
  /** Reads stdin (default: fd 0). */
  readStdin?: () => Uint8Array;
  /** Called with the server once it serves. */
  onServing?: (s: AgentServer) => void;
}

/**
 * The agent child. `argv` is what follows `__agent` (a leading `__agent` is skipped).
 * Returns the exit status: 2 when run by hand, 1 when it couldn't start (readiness
 * `error: …` or `running`), 0 after serving.
 */
export async function runAgentChild(argv: readonly string[], hooks: ChildHooks = {}): Promise<number> {
  const args = argv[0] === "__agent" ? argv.slice(1) : argv;
  // (a) fd 3 must be a FIFO (the readiness pipe), else it was started by hand.
  let fifo = false;
  try {
    fifo = fstatSync(READY_FD).isFIFO();
  } catch {
    fifo = false;
  }
  if (!fifo) {
    try {
      writeSync(2, "passh: __agent is started by `passh unlock`, not by hand\n");
    } catch {
      /* stderr closed */
    }
    return 2;
  }
  let readyDone = false;
  const ready = (line: string) => {
    if (readyDone) return;
    readyDone = true;
    try {
      writeSync(READY_FD, oneLine(line) + "\n");
    } catch {
      /* the parent is gone */
    }
    try {
      closeSync(READY_FD);
    } catch {
      /* closed */
    }
  };
  const fail = (text: string) => {
    ready("error: " + text);
    return 1;
  };

  // (b) umask 077.
  process.umask(0o077);
  // (c) core dumps off (S7); failure is fatal here (§A8).
  const h = disableCoreDumps();
  // SPEC-GAP: §A2.3 (c) gives no text; `agent: disabling core dumps: <OS error>`.
  if (h) return fail(`agent: disabling core dumps: ${h.message}`);
  // (d) arguments and the vault's real path.
  let parsed: ChildArgs;
  try {
    parsed = parseChildArgs(args);
  } catch (e) {
    return fail(`agent: ${(e as Error).message}`);
  }
  let real: string;
  try {
    real = realPath(parsed.vault);
  } catch (e) {
    return fail(`agent: resolving the vault path: ${(e as Error).message}`);
  }
  // (e) the key and the digest.
  let key: StdinKey;
  try {
    key = parseStdinKey((hooks.readStdin ?? (() => readStdin(STDIN_MAX)))());
  } catch (e) {
    return fail(`agent: ${(e as Error).message}`);
  }
  // (f) SIGTERM and SIGINT end the agent; SIGHUP is ignored.
  let server: AgentServer | undefined;
  let signalled = false;
  const onSignal = () => {
    signalled = true;
    if (server) void server.shutdown("signal");
  };
  const ignore = () => {};
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.on("SIGHUP", ignore);
  const cleanupSignals = () => {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    process.off("SIGHUP", ignore);
  };
  // (g) the folder and the socket.
  let started: AgentServer | "running";
  try {
    const socket = agentSocketPath(real);
    started = await AgentServer.start({
      vault: real,
      idleTtlMs: Number(parsed.idleTtl) / 1e6,
      maxTtlMs: Number(parsed.maxTtl) / 1e6,
      key: key.key,
      digest: key.digest,
      socket,
    });
  } catch (e) {
    key.key.fill(0);
    cleanupSignals();
    if (e instanceof BindError) return fail(e.message);
    return fail(`agent: ${(e as Error).message}`);
  }
  if (started === "running") {
    key.key.fill(0);
    cleanupSignals();
    ready("running");
    return 1;
  }
  server = started;
  if (signalled) {
    await server.shutdown("signal");
    cleanupSignals();
    ready("error: agent: interrupted");
    return 1;
  }
  // (h) readiness.
  ready("ok");
  hooks.onServing?.(server);
  // (i) serve until stopped, expired, replaced or signalled.
  await server.done;
  cleanupSignals();
  return 0;
}
