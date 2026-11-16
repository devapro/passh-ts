// Starting a program (agent-session.md §A7, S8): always a program path plus an argument
// list, never a shell. Unset stdio is /dev/null; the environment is inherited, with
// explicit KEY=value additions replacing inherited ones.

import { openSync } from "node:fs";
import { errorf, type PasshError } from "../i18n/index.ts";
import { osError } from "../fsx/oserror.ts";
import { lookPath } from "./lookpath.ts";
import { closeQuietly, makePipe } from "./pipe.ts";

/** Standard input of a child: bytes (written, then closed), /dev/null, a new /dev/tty, ours, or a descriptor. */
export type StdinSpec = Uint8Array | "null" | "tty" | "inherit" | number;
/** Standard output or error of a child: /dev/null, captured, a new /dev/tty, ours, or a descriptor. */
export type StdoutSpec = "null" | "pipe" | "tty" | "inherit" | number;

export interface RunOptions {
  /** argv[0] names the program (a name looked up in $PATH, or a path); the rest are its arguments. */
  argv: string[];
  /** The program file, already looked up (skips lookPath(argv[0])). */
  path?: string;
  /** How errors name the program (default argv[0]): `<display>: exit status 3`. */
  display?: string;
  stdin?: StdinSpec;
  stdout?: StdoutSpec;
  stderr?: StdoutSpec;
  /** Additions to the inherited environment; they replace inherited values (e.g. GPG_TTY). */
  env?: Record<string, string>;
  cwd?: string;
  /** Kill the child (SIGKILL) after this long; `timedOut` is then set. */
  timeoutMs?: number;
  /** With stdout "pipe": keep at most this many bytes; on more, stop reading and close the pipe. */
  stdoutLimit?: number;
  /**
   * An extra pipe on the child's fd 3 that the child writes (gpg --status-fd 3, import-export.md
   * §1.5): the first `limit` bytes are kept, the rest read and discarded; once the child has
   * exited, the pipe is closed after `closeAfterExitMs` if still open (held by a grandchild).
   */
  fd3?: { limit: number; closeAfterExitMs: number };
  /** Kills the child (SIGKILL) when aborted. */
  signal?: AbortSignal;
  /** Called once the child runs (e.g. to kill it from a signal handler). */
  onStart?: (child: ChildHandle) => void;
}

export interface ChildHandle {
  pid: number;
  kill(signal?: NodeJS.Signals | number): void;
}

export interface RunResult {
  /** The exit status, or null when a signal ended the child. */
  exitCode: number | null;
  /** The signal that ended the child ("SIGKILL"), or null. */
  signal: string | null;
  /** Captured stdout (stdout "pipe"), else empty. */
  stdout: Uint8Array;
  /** stdout went over stdoutLimit (and was closed). */
  stdoutOverflow: boolean;
  /** Captured fd 3 (first `fd3.limit` bytes). */
  fd3: Uint8Array;
  fd3Overflow: boolean;
  /** The timeout killed the child. */
  timedOut: boolean;
  /** Go's text for the end of the child: "exit status 3", "signal: killed"; "" for exit 0. */
  exitText: string;
}

/** Go's names of the signals (syscall.Signal.String on Linux), as in "signal: killed". */
export const GO_SIGNAL_TEXT: Record<string, string> = {
  SIGHUP: "hangup",
  SIGINT: "interrupt",
  SIGQUIT: "quit",
  SIGILL: "illegal instruction",
  SIGTRAP: "trace/breakpoint trap",
  SIGABRT: "aborted",
  SIGBUS: "bus error",
  SIGFPE: "floating point exception",
  SIGKILL: "killed",
  SIGUSR1: "user defined signal 1",
  SIGSEGV: "segmentation fault",
  SIGUSR2: "user defined signal 2",
  SIGPIPE: "broken pipe",
  SIGALRM: "alarm clock",
  SIGTERM: "terminated",
  SIGSTKFLT: "stack fault",
  SIGCHLD: "child exited",
  SIGCONT: "continued",
  SIGSTOP: "stopped (signal)",
  SIGTSTP: "stopped",
  SIGTTIN: "stopped (tty input)",
  SIGTTOU: "stopped (tty output)",
  SIGURG: "urgent I/O condition",
  SIGXCPU: "CPU time limit exceeded",
  SIGXFSZ: "file size limit exceeded",
  SIGVTALRM: "virtual timer expired",
  SIGPROF: "profiling timer expired",
  SIGWINCH: "window changed",
  SIGIO: "I/O possible",
  SIGPWR: "power failure",
  SIGSYS: "bad system call",
};

/** Go's name of a signal ("SIGTERM" → "terminated"). */
export function goSignalText(signal: string): string {
  return GO_SIGNAL_TEXT[signal] ?? signal.toLowerCase();
}

/** Go's ExitError text for an exit status or a signal. */
export function exitText(exitCode: number | null, signal: string | null): string {
  if (signal) return "signal: " + goSignalText(signal);
  if (exitCode !== null && exitCode !== 0) return `exit status ${exitCode}`;
  return "";
}

/** The error for a child that didn't succeed: `<display>: exit status 3` (null on success). */
export function exitError(display: string, r: Pick<RunResult, "exitCode" | "signal">): PasshError | null {
  const t = exitText(r.exitCode, r.signal);
  return t ? errorf("%s: %s", display, t) : null;
}

function openTty(): number {
  try {
    return openSync("/dev/tty", "r+");
  } catch (e) {
    throw osError("open", "/dev/tty", e);
  }
}

async function readAll(stream: ReadableStream<Uint8Array>, limit: number, discardOver: boolean, stop?: Promise<void>): Promise<{ data: Uint8Array; overflow: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let overflow = false;
  let stopped = false;
  const stopP = stop?.then(() => {
    stopped = true;
    void reader.cancel().catch(() => {});
    return { done: true as const, value: undefined };
  });
  try {
    for (;;) {
      const r = stopP ? await Promise.race([reader.read(), stopP]) : await reader.read();
      if (r.done || stopped) break;
      const v = r.value;
      if (kept + v.length > limit) {
        if (kept < limit) chunks.push(v.slice(0, limit - kept));
        kept = limit;
        overflow = true;
        if (!discardOver) {
          await reader.cancel().catch(() => {});
          break;
        }
        continue;
      }
      chunks.push(v);
      kept += v.length;
    }
  } catch {
    /* a closed pipe ends the reading */
  }
  const data = new Uint8Array(kept);
  let off = 0;
  for (const c of chunks) {
    data.set(c, off);
    off += c.length;
  }
  return { data, overflow };
}

/**
 * Runs a program to its end (S8: no shell). Lookup errors are thrown (`exec: exec: "x": …`);
 * a child that can't be started throws `<display>: fork/exec <path>: <reason>`. The
 * result reports the exit; exitError() turns a failure into `<display>: exit status n`.
 */
export async function runProcess(o: RunOptions): Promise<RunResult> {
  if (o.argv.length === 0) throw errorf("the command is empty");
  const display = o.display ?? o.argv[0]!;
  const path = o.path ?? lookPath(o.argv[0]!);
  const env: Record<string, string | undefined> = { ...process.env, ...(o.env ?? {}) };
  const parentFds: number[] = [];
  let fd3Read = -1;
  try {
    // One descriptor of /dev/tty serves every "tty" slot (the editor: stdin, stdout, stderr).
    let ttyFd = -1;
    const tty = (): number => {
      if (ttyFd < 0) {
        ttyFd = openTty();
        parentFds.push(ttyFd);
      }
      return ttyFd;
    };
    const mapOut = (s: StdoutSpec | undefined): "ignore" | "pipe" | "inherit" | number => {
      if (s === undefined || s === "null") return "ignore";
      if (s === "tty") return tty();
      return s;
    };
    let stdin: "ignore" | "pipe" | "inherit" | number;
    const si = o.stdin;
    if (si instanceof Uint8Array) stdin = "pipe";
    else if (si === undefined || si === "null") stdin = "ignore";
    else if (si === "tty") stdin = tty();
    else stdin = si;
    const stdio: Array<"ignore" | "pipe" | "inherit" | number> = [stdin, mapOut(o.stdout), mapOut(o.stderr)];
    if (o.fd3) {
      const [r, w] = makePipe();
      fd3Read = r;
      parentFds.push(w);
      stdio.push(w);
    }
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn({ cmd: [path, ...o.argv.slice(1)], env, cwd: o.cwd, stdio: stdio as any });
    } catch (e) {
      throw errorf("%s: %w", display, osError("fork/exec", path, e));
    }
    for (const fd of parentFds.splice(0)) closeQuietly(fd);
    const handle: ChildHandle = { pid: proc.pid, kill: (sig = "SIGKILL") => { try { proc.kill(sig as NodeJS.Signals); } catch { /* gone */ } } };
    o.onStart?.(handle);

    let timedOut = false;
    const timer = o.timeoutMs !== undefined ? setTimeout(() => { timedOut = true; handle.kill("SIGKILL"); }, o.timeoutMs) : undefined;
    const onAbort = () => handle.kill("SIGKILL");
    o.signal?.addEventListener("abort", onAbort, { once: true });
    if (o.signal?.aborted) onAbort();

    // Readers first, then the stdin write, all at once: a child that writes much before it
    // has read all its input (gpg) must never wait for us.
    const outP = o.stdout === "pipe" ? readAll(proc.stdout as ReadableStream<Uint8Array>, o.stdoutLimit ?? Number.MAX_SAFE_INTEGER, false) : Promise.resolve({ data: new Uint8Array(0), overflow: false });
    let fd3P: Promise<{ data: Uint8Array; overflow: boolean }> = Promise.resolve({ data: new Uint8Array(0), overflow: false });
    if (o.fd3) {
      const stopAfterExit = proc.exited.then(() => Bun.sleep(o.fd3!.closeAfterExitMs));
      fd3P = readAll(Bun.file(fd3Read).stream(), o.fd3.limit, true, stopAfterExit);
    }
    let inP: Promise<void> = Promise.resolve();
    if (si instanceof Uint8Array) {
      const sink = proc.stdin as import("bun").FileSink;
      inP = (async () => {
        try {
          sink.write(si);
          await sink.end();
        } catch {
          /* the child closed its stdin early (EPIPE) */
        }
      })();
    }
    const [out, st] = await Promise.all([outP, fd3P, proc.exited]);
    await Promise.race([inP, Bun.sleep(100)]);
    if (timer) clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
    const exitCode = proc.signalCode ? null : proc.exitCode;
    const signal = proc.signalCode ? String(proc.signalCode) : null;
    return {
      exitCode,
      signal,
      stdout: out.data,
      stdoutOverflow: out.overflow,
      fd3: st.data,
      fd3Overflow: st.overflow,
      timedOut,
      exitText: exitText(exitCode, signal),
    };
  } finally {
    for (const fd of parentFds) closeQuietly(fd);
    closeQuietly(fd3Read);
  }
}
