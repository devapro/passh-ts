// The command cores around the agent, with their dependencies injected (the CLI wires
// them): `passh unlock` (agent-session.md §A2.3, cli.md §2.14), `passh lock` (§A2.9,
// cli.md §2.15), stopping the agent after passwd/rekey/recover (§A2.9, cli.md §2.16,
// §2.18), and doctor's read-only agent rows (cli.md §2.25 row 7).

import { checkPrivateDir, realPath as resolveRealPath, tildePath, type Config, type Env } from "../config/index.ts";
import { errorf, renderError, T } from "../i18n/index.ts";
import { UsageError } from "../errors.ts";
import { escapeLine } from "../sanitize/index.ts";
import { OSError } from "../fsx/oserror.ts";
import { readRegularFile } from "../fsx/files.ts";
import { parseContainer } from "../vaultfile/index.ts";
import { keyBlockDigest } from "../keys/index.ts";
import { formatGoDuration } from "../util/duration.ts";
import { spawnAgentChild, READINESS_TIMEOUT_MS, type AgentChild } from "../exec/index.ts";
import type { X25519Identity } from "../age/index.ts";
import type { CommandIO } from "../util/io.ts";
import { agentKey, agentStatus, socketFor, stopAgentAndWait, type AgentStatus, type ClientOptions } from "./client.ts";
import { agentError } from "./protocol.ts";
import { formatAgentTimes } from "./times.ts";

/** What `unlock` needs from the vault it opened with the passphrase (§A2.3 step 4). */
export interface UnlockOpened {
  /** The vault key (wiped by `close`, or by runUnlock when there is no `close`). */
  identity: X25519Identity;
  /** The binary key block (its digest goes to the agent). */
  keyBlock: Uint8Array;
  /** The vault's real path (the agent's `--vault`). */
  realPath: string;
  /** Wipes the key (e.g. OpenedVault.close). */
  close?(): void;
}

export interface UnlockOptions {
  config: Config;
  /** The vault path as configured (absolute; `<file>` in messages, `~/` form). */
  vaultPath: string;
  /** `--ttl` in nanoseconds, if given (replaces agent.max_ttl). */
  ttl?: bigint;
  io: CommandIO;
  /** The terminal (src/tty openTty()); null = no terminal. */
  tty: unknown | null;
  /** §A2.3 step 4: the full open with the passphrase only (3 tries, rollback check). */
  openWithPassphrase: () => Promise<UnlockOpened>;
  /** Environment for the socket and `~/` (default process.env). */
  env?: Env;
  /** The program to start as the agent (default: this passh, src/exec selfCommand()). */
  agentCommand?: string[];
  /** Readiness wait (default 10 s). */
  readinessTimeoutMs?: number;
}

function clientOpts(env: Env | undefined): ClientOptions {
  return env ? { env } : {};
}

function times(st: AgentStatus): string {
  return formatAgentTimes(st.pid, st.idleLeftMs, st.maxLeftMs);
}

/** `<file>` (cli.md notation): the path as given, `~/` form. */
function fileName(path: string, env: Env | undefined): string {
  return tildePath(path, env ?? process.env);
}

/**
 * Reads and leniently parses the vault file (storage.md §3.1 steps 2 and 4) to get its
 * key block's digest; errors as there.
 */
function vaultDigest(path: string): string {
  let bytes: Uint8Array;
  try {
    bytes = readRegularFile(path);
  } catch (e) {
    if (e instanceof OSError) throw errorf("opening the vault: %w", e);
    throw errorf("%s: not a passh vault: %w", path, e);
  }
  try {
    return keyBlockDigest(parseContainer(bytes).keyBlock);
  } catch (e) {
    throw errorf("%s: %w", path, e);
  }
}

function alreadyUnlocked(o: UnlockOptions, st: AgentStatus): void {
  o.io.status(T("Already unlocked: %s.", times(st)));
  if (o.ttl !== undefined) o.io.warn(T("--ttl was not applied: the agent was already running; run `passh lock`, then `passh unlock --ttl …`"));
}

/**
 * `passh unlock [--ttl d]` (§A2.3 steps 1–7). Prints its results on stderr through `io`;
 * throws errors (UsageError for `--ttl` ≤ 0). The key reaches the agent only through its
 * stdin pipe (S2).
 */
export async function runUnlock(o: UnlockOptions): Promise<void> {
  // 1. --ttl > 0 (the config is loaded and the vault exists: the CLI checked).
  if (o.ttl !== undefined && o.ttl <= 0n) throw new UsageError("--ttl must be more than zero");
  const copts = clientOpts(o.env);
  const real = resolveRealPath(o.vaultPath, { env: o.env });
  // 2. An agent already running?
  const st = await agentStatus(real, copts);
  if (st) {
    let digest: string;
    try {
      digest = vaultDigest(o.vaultPath);
    } catch (e) {
      throw errorf("an agent is running, but the vault can't be checked against it: %w", e);
    }
    const k = await agentKey(real, digest, copts);
    if (k.kind === "key") {
      k.identity.wipe();
      // The key request restarted the idle time: report the times after it.
      const st2 = await agentStatus(real, copts);
      if (st2) {
        alreadyUnlocked(o, st2);
        return;
      }
    }
    // key_block_changed, or the agent vanished: replace it.
    o.io.note(T("the running agent was unlocked with another key block (passwd elsewhere?); replacing it"));
    await stopAgentAndWait(real, copts);
  }
  // 3. A terminal for the passphrase.
  if (o.tty === null || o.tty === undefined) {
    throw errorf("passh unlock needs a terminal to ask for the passphrase (over SSH: `ssh -t host passh unlock`)");
  }
  // 4. Open with the passphrase only.
  const opened = await o.openWithPassphrase();
  const digest = keyBlockDigest(opened.keyBlock);
  // 5. Start the agent: key and digest on its stdin only (S2), never argv or environment.
  const idle = o.config.agent.idleTTL;
  const max = o.ttl ?? o.config.agent.maxTTL;
  const stdin = agentStdin(opened.identity, digest);
  if (opened.close) opened.close();
  else opened.identity.wipe();
  let child: AgentChild;
  try {
    child = await spawnAgentChild({
      args: ["__agent", `--vault=${opened.realPath}`, `--idle-ttl=${formatGoDuration(idle)}`, `--max-ttl=${formatGoDuration(max)}`],
      stdinData: stdin,
      command: o.agentCommand,
    });
  } catch (e) {
    stdin.fill(0);
    throw agentError("starting the agent: %w", e);
  } finally {
    stdin.fill(0);
  }
  const ready = await child.readReadiness(o.readinessTimeoutMs ?? READINESS_TIMEOUT_MS);
  if (ready.kind === "closed") {
    child.kill();
    throw agentError("starting the agent: the agent exited before it was ready");
  }
  if (ready.kind === "timeout") {
    child.kill();
    throw agentError("starting the agent: the agent didn't report ready within %s", formatGoDuration(BigInt(o.readinessTimeoutMs ?? READINESS_TIMEOUT_MS) * 1_000_000n));
  }
  const line = ready.line;
  if (line === "ok") {
    let st3: AgentStatus | undefined;
    let cause: unknown;
    try {
      st3 = await agentStatus(real, copts);
    } catch (e) {
      cause = e;
    }
    if (!st3) {
      // SPEC-GAP: §A2.3 doesn't say whether a started agent that doesn't answer is
      // killed; it is (it holds the key and nobody can reach it). "No agent" reads
      // `its socket is gone`.
      child.kill();
      const why = cause instanceof Error ? cause.message.replace(/^agent: /, "") : "its socket is gone";
      throw agentError("the agent (pid %d) started but doesn't answer: %s", child.pid, why);
    }
    o.io.status(T("Unlocked %s: %s.", fileName(o.vaultPath, o.env), times(st3)));
    o.io.status(T("Run `passh lock` to stop the agent now."));
    return;
  }
  if (line === "running") {
    // 6. Another unlock won the race: use its agent (the key request restarts its idle time).
    child.kill();
    const k = await agentKey(real, digest, copts);
    if (k.kind === "key") {
      k.identity.wipe();
      const st4 = await agentStatus(real, copts);
      if (st4) {
        // SPEC-GAP: step 6 doesn't mention --ttl; it wasn't applied, so the warning is printed too.
        alreadyUnlocked(o, st4);
        return;
      }
    }
    // SPEC-GAP: step 6 doesn't say what happens when the winner's agent refuses this key block or vanished.
    if (k.kind === "key_block_changed") throw agentError("the vault's key block isn't the one this agent was unlocked with");
    throw agentError("starting the agent: another agent started meanwhile and exited");
  }
  child.kill();
  if (line.startsWith("error: ")) throw agentError("starting the agent: %s", line.slice(7).replace(/^agent: /, ""));
  // SPEC-GAP: §A2.3 lists ok, running, error: …; anything else is reported as it is.
  throw agentError("starting the agent: unexpected readiness line %q", line);
}

/** The agent's stdin (§A2.3): `<AGE-SECRET-KEY-1…>\n<digest>\n`, as bytes the caller wipes (audit #26: no JS string of the key). */
function agentStdin(identity: X25519Identity, digest: string): Uint8Array {
  const key = identity.encode();
  const d = new TextEncoder().encode(digest);
  const out = new Uint8Array(key.length + 1 + d.length + 1);
  out.set(key, 0);
  out[key.length] = 0x0a;
  out.set(d, key.length + 1);
  out[out.length - 1] = 0x0a;
  key.fill(0);
  return out;
}

export interface LockOptions {
  config: Config;
  /** The vault path as configured (absolute); it must exist (the CLI checked). */
  vaultPath: string;
  io: CommandIO;
  env?: Env;
}

/**
 * `passh lock` (§A2.9): `stop`, then wait until the socket path is gone. Prints
 * `Locked: the agent (pid <n>) stopped.` or `No agent is running for <file>.`.
 */
export async function runLock(o: LockOptions): Promise<void> {
  const real = resolveRealPath(o.vaultPath, { env: o.env });
  const st = await stopAgentAndWait(real, clientOpts(o.env));
  if (!st) {
    o.io.status(T("No agent is running for %s.", escapeLine(fileName(o.vaultPath, o.env))));
    return;
  }
  o.io.status(T("Locked: the agent (pid %d) stopped.", st.pid));
}

/**
 * After passwd, recover (new key block) and rekey (new key): stops the vault's agent
 * (§A2.9). A running agent gets the status line; a failed stop only warns.
 */
export async function stopAgentAfterKeyChange(realPath: string, io: CommandIO, kind: "passwd" | "rekey" | "recover", opts: { env?: Env; waitMs?: number } = {}): Promise<void> {
  let st: AgentStatus | undefined;
  try {
    st = await stopAgentAndWait(realPath, { ...clientOpts(opts.env), waitMs: opts.waitMs });
  } catch (e) {
    io.warn(T("the agent couldn't be stopped: %s; stop it with `passh lock`", e));
    return;
  }
  if (!st) return;
  if (kind === "rekey") io.status(T("The agent held the old key and was stopped; run `passh unlock` again if you need it."));
  else io.status(T("The agent was unlocked with the old key block and was stopped; run `passh unlock` again if you need it."));
}

export type DoctorLevel = "ok" | "info" | "error";

export interface DoctorRow {
  level: DoctorLevel;
  /** The message (translated, not escaped). */
  message: string;
}

export interface AgentDoctorInfo {
  /** The `agent folder` row. */
  folder: DoctorRow;
  /** The `agent` row; absent when the folder check failed. */
  agent?: DoctorRow;
}

/**
 * doctor's row 7 (cli.md §2.25), read-only: the folder (`<dir> doesn't exist yet; …`,
 * `<dir> (0700, yours)`, or the check error) and a status request, which doesn't restart
 * the idle time (`not running (…)`, `running: <times>`, or the error).
 */
export async function agentDoctorInfo(vaultRealPath: string, opts: { env?: Env; uid?: number } = {}): Promise<AgentDoctorInfo> {
  const env = opts.env ?? process.env;
  let dir: string;
  try {
    dir = socketFor(vaultRealPath, { env, uid: opts.uid }).dir;
  } catch (e) {
    return { folder: { level: "error", message: renderError(e).replace(/^agent: /, "") } };
  }
  let state: "ok" | "missing";
  try {
    state = checkPrivateDir(dir, opts.uid);
  } catch (e) {
    return { folder: { level: "error", message: renderError(e) } };
  }
  const notRunning: DoctorRow = { level: "info", message: T("not running (`passh unlock` starts it)") };
  if (state === "missing") {
    return { folder: { level: "info", message: T("%s doesn't exist yet; `passh unlock` creates it", tildePath(dir, env)) }, agent: notRunning };
  }
  const folder: DoctorRow = { level: "ok", message: T("%s (0700, yours)", tildePath(dir, env)) };
  try {
    const st = await agentStatus(vaultRealPath, { env, uid: opts.uid });
    if (!st) return { folder, agent: notRunning };
    return { folder, agent: { level: "info", message: T("running: %s", times(st)) } };
  } catch (e) {
    return { folder, agent: { level: "error", message: renderError(e) } };
  }
}
