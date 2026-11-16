// Starting the agent process (agent-session.md §A2.3): passh re-executes its own binary
// in a new session, cwd "/", stdin a pipe (the key, S2: never argv, environment or a file),
// stdout and stderr /dev/null, fd 3 the write end of a readiness pipe, no other descriptors.
// The parent writes stdin, closes it, then reads one readiness line from fd 3's other end.

import { fstatSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { closeQuietly, makePipe } from "./pipe.ts";

/** Readiness line limit (§A1). */
export const READINESS_MAX = 1024;
/** Readiness wait (§A1). */
export const READINESS_TIMEOUT_MS = 10_000;

/**
 * The command that runs this passh: the compiled binary itself (process.execPath), or,
 * when running from source, [bun, run, <abs>/src/main.ts].
 */
export function selfCommand(): string[] {
  if (isCompiled()) return [process.execPath];
  return [process.execPath, "run", resolve(join(import.meta.dir, "..", "main.ts"))];
}

/** Reports whether this process is a `bun build --compile` binary. */
export function isCompiled(): boolean {
  const main = typeof Bun !== "undefined" ? Bun.main : "";
  return main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(main) || import.meta.path.startsWith("/$bunfs/");
}

export type Readiness =
  /** A line (without its `\n`; cut at 1024 bytes when no `\n` came within them). */
  | { kind: "line"; line: string; truncated: boolean }
  /** The pipe closed without a line (the agent exited before it was ready). */
  | { kind: "closed" }
  /** No line within the wait. */
  | { kind: "timeout" };

export interface AgentChild {
  pid: number;
  /** Reads the one readiness line (§A2.3), waiting at most timeoutMs (default 10 s). Call once. */
  readReadiness(timeoutMs?: number): Promise<Readiness>;
  /** Kills the child (default SIGKILL). */
  kill(signal?: NodeJS.Signals | number): void;
  /** Resolves with the exit status once the child has exited (the parent never needs to wait). */
  exited: Promise<number>;
}

export interface SpawnAgentOptions {
  /** The arguments after the program, e.g. ["__agent", "--vault=/…", "--idle-ttl=15m0s", "--max-ttl=2h0m0s"]. */
  args: string[];
  /** What the child reads on stdin (the key and the digest). Zeroed here once written. */
  stdinData: Uint8Array;
  /** The program (default selfCommand()). */
  command?: string[];
  /** Default "/". */
  cwd?: string;
}

/**
 * Starts the agent child and writes its stdin. Throws if the child can't be started.
 * The child is unref'd: this process can exit while the agent runs.
 */
export async function spawnAgentChild(o: SpawnAgentOptions): Promise<AgentChild> {
  const cmd = [...(o.command ?? selfCommand()), ...o.args];
  // Real pipes for stdin and fd 3 (Bun's own "pipe" slots are socket pairs).
  const [inRd, inWr] = makePipe();
  let rd: number, wr: number;
  try {
    [rd, wr] = makePipe();
  } catch (e) {
    closeQuietly(inRd);
    closeQuietly(inWr);
    throw e;
  }
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd,
      cwd: o.cwd ?? "/",
      env: { ...process.env },
      detached: true, // setsid(): a new session, no controlling terminal
      stdio: [inRd, "ignore", "ignore", wr] as any,
    });
  } catch (e) {
    for (const fd of [inRd, inWr, rd, wr]) closeQuietly(fd);
    throw e;
  }
  closeQuietly(inRd);
  closeQuietly(wr);
  proc.unref();
  try {
    // ≤ 511 bytes (§A1): far below the pipe buffer, so the write never blocks.
    let off = 0;
    while (off < o.stdinData.length) off += writeSync(inWr, o.stdinData, off, o.stdinData.length - off);
  } catch {
    /* the child exited early (EPIPE): the readiness pipe tells why */
  } finally {
    closeQuietly(inWr);
    o.stdinData.fill(0);
  }
  let used = false;
  return {
    pid: proc.pid,
    exited: proc.exited,
    kill(sig = "SIGKILL") {
      try {
        proc.kill(sig as NodeJS.Signals);
      } catch {
        /* gone */
      }
    },
    async readReadiness(timeoutMs = READINESS_TIMEOUT_MS) {
      if (used) throw new Error("readReadiness called twice");
      used = true;
      try {
        return await readOneLine(rd, timeoutMs);
      } finally {
        closeFd(rd);
      }
    },
  };
}

/** Closes fd unless it is already closed (a stream may have closed it). */
function closeFd(fd: number): void {
  try {
    fstatSync(fd);
  } catch {
    return;
  }
  closeQuietly(fd);
}

async function readOneLine(fd: number, timeoutMs: number): Promise<Readiness> {
  const reader = Bun.file(fd).stream().getReader();
  const buf: number[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), timeoutMs)));
  try {
    for (;;) {
      const r = await Promise.race([reader.read(), timeout]);
      if (r === "timeout") return { kind: "timeout" };
      if (r.done) {
        if (buf.length === 0) return { kind: "closed" };
        return { kind: "line", line: decode(buf), truncated: false };
      }
      for (const b of r.value) {
        if (b === 0x0a) return { kind: "line", line: decode(buf), truncated: false };
        buf.push(b);
        if (buf.length >= READINESS_MAX) return { kind: "line", line: decode(buf), truncated: true };
      }
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

function decode(b: number[]): string {
  return new TextDecoder().decode(new Uint8Array(b));
}
