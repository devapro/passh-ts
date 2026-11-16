// Side-by-side runs for the *_more suites (unlock, lock, verify, backup, backups, import pass,
// export, print, recovery-key print, doctor): the reference (reference/passh-go, a black box)
// and ours through src/cli/testdata/main_more.ts (RUNS_MORE merged), each in its own isolated
// env (test/helpers/env.ts) holding a byte-identical copy of the same vault. Every spawn gets
// the isolated env only, never process.env.

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { run, ROOT, REF_BIN, type IsolatedEnv } from "../helpers/env.ts";
import { spawnPty, type PtyProcess } from "../helpers/pty.ts";
import { PASS } from "../helpers/passh.ts";
import { makePair, normalize, type Pair } from "./vaults.ts";

export type Side = "ref" | "ours";

export const REF_MORE = [REF_BIN];
export const OURS_MORE = [process.execPath, "run", join(ROOT, "src/cli/testdata/main_more.ts")];

/** A step of a PTY dialogue: wait for `expect`, then send `send` (+ Enter unless "raw"). */
export type Step = [string | RegExp, string] | [string | RegExp, string, "raw"] | ((p: PtyProcess, e: IsolatedEnv) => Promise<void>);

export interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
  /** What reached the terminal (prompts, /dev/tty messages); "" without a terminal. */
  tty: string;
  /** stdout as bytes (before normalization). */
  stdoutBytes: Uint8Array;
  /** stderr with only the env folders replaced (pids and times kept). */
  rawStderr: string;
}

export interface MoreRunOptions {
  /** Extra environment variables (on top of the isolated env), or a function of the env. */
  env?: Record<string, string> | ((e: IsolatedEnv) => Record<string, string>);
  /** Variables removed from the isolated env. */
  unset?: string[];
  /** Run on a PTY (else without a terminal, setsid). */
  pty?: boolean;
  /** PTY dialogue; default: none (a process that ends early ends it). */
  steps?: Step[];
  /** PTY: stdout stays on the terminal. */
  stdoutOnTty?: boolean;
  /** PTY: stderr stays on the terminal (then `stderr` is ""; it is part of `tty`). */
  stderrOnTty?: boolean;
  /** stdin for runs without a terminal. */
  stdin?: string;
  /** Extra replacements after the env folder is replaced. */
  replace?: Array<[RegExp, string]>;
  cwd?: (e: IsolatedEnv) => string;
  timeoutMs?: number;
}

export const PASSPHRASE_STEP: Step = ["Passphrase: ", PASS];

/** Machine- and time-dependent numbers: pids, agent times, memory and swap sizes. */
export const VOLATILE: Array<[RegExp, string]> = [
  [/pid \d+/g, "pid N"],
  [/exits in [0-9hms]+( if unused, in [0-9hms]+ at the latest)?/g, "exits in <T>"],
  [/[\d.]+ (GiB|MiB|KiB) available/g, "<MEM> available"],
  [/(\d+ swap areas? (is|are) active) \([^)]*\)/g, "$1 (<SWAP>)"],
];

function envFor(e: IsolatedEnv, o: MoreRunOptions): Record<string, string> {
  const extra = typeof o.env === "function" ? o.env(e) : (o.env ?? {});
  const env: Record<string, string> = { ...e.env, ...extra };
  for (const k of o.unset ?? []) delete env[k];
  return env;
}

function finish(e: IsolatedEnv, o: MoreRunOptions, out: Omit<Outcome, "rawStderr">): Outcome {
  const norm = (s: string) => {
    let t = normalize(s, e);
    for (const [re, to] of [...VOLATILE, ...(o.replace ?? [])]) t = t.replace(re, to);
    return t;
  };
  return { code: out.code, stdout: norm(out.stdout), stderr: norm(out.stderr), tty: norm(out.tty), stdoutBytes: out.stdoutBytes, rawStderr: normalize(out.stderr, e) };
}

function readAndRemove(f: string): Uint8Array {
  try {
    const b = new Uint8Array(readFileSync(f));
    rmSync(f, { force: true });
    return b;
  } catch {
    return new Uint8Array(0);
  }
}

/** Runs one command on one side. */
export async function runMore(side: Side, e: IsolatedEnv, args: string[], o: MoreRunOptions = {}): Promise<Outcome> {
  const bin = side === "ref" ? REF_MORE : OURS_MORE;
  const env = envFor(e, o);
  if (!o.pty) {
    const r = await run([...bin, ...args], env, { stdin: o.stdin, timeoutMs: o.timeoutMs, cwd: o.cwd?.(e) });
    return finish(e, o, { code: r.code, stdout: r.stdout, stderr: r.stderr, tty: "", stdoutBytes: r.stdoutBytes });
  }
  const tag = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const outFile = join(e.dir, `o-${tag}`);
  const errFile = join(e.dir, `e-${tag}`);
  const script =
    o.stdoutOnTty && o.stderrOnTty
      ? 'shift 2; exec "$@"'
      : o.stdoutOnTty
        ? 'r="$2"; shift 2; exec "$@" 2>"$r"'
        : o.stderrOnTty
          ? 'o="$1"; shift 2; exec "$@" >"$o"'
          : 'o="$1"; r="$2"; shift 2; exec "$@" 2>"$r" >"$o"';
  const p = spawnPty(["/bin/sh", "-c", script, "sh", outFile, errFile, ...bin, ...args], env, { cwd: o.cwd?.(e) });
  try {
    for (const s of o.steps ?? []) {
      if (typeof s === "function") {
        await s(p, e);
        continue;
      }
      await p.expect(s[0], o.timeoutMs ?? 20_000);
      if (s[2] === "raw") p.send(s[1]);
      else p.line(s[1]);
    }
  } catch (err) {
    if (!/process exited/.test((err as Error).message)) {
      p.kill("SIGKILL");
      const r = await p.wait(5_000);
      throw new Error(`${side} ${args.join(" ")}: ${(err as Error).message}\nterminal so far: ${JSON.stringify(r.output)}`);
    }
  }
  const r = await p.wait(o.timeoutMs ?? 60_000);
  const out = o.stdoutOnTty ? new Uint8Array(0) : readAndRemove(outFile);
  const err = new TextDecoder().decode(readAndRemove(errFile));
  return finish(e, o, { code: r.code, stdout: new TextDecoder().decode(out), stderr: err, tty: r.output, stdoutBytes: out });
}

/** Runs the command on both sides of a pair (reference first). */
export async function bothMore(pair: Pair, args: string[], o: MoreRunOptions = {}): Promise<{ ref: Outcome; ours: Outcome }> {
  const ref = await runMore("ref", pair.ref, args, o);
  const ours = await runMore("ours", pair.ours, args, o);
  return { ref, ours };
}

/** The comparable part of an outcome. */
export function visible(o: Outcome): { code: number; stdout: string; stderr: string; tty: string } {
  return { code: o.code, stdout: o.stdout, stderr: o.stderr, tty: o.tty };
}

/** Stops any agent of a pair's vaults (both sides), ignoring errors: for afterAll/afterEach. */
export async function lockBoth(pair: Pair): Promise<void> {
  for (const side of ["ref", "ours"] as const) {
    try {
      await runMore("ref", pair[side], ["lock"], { timeoutMs: 10_000 });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Kills every agent process (`__agent --vault=<path>`) whose vault lies under `dir` (Linux
 * /proc), and removes nothing else: the safety net after a test that started agents.
 * Returns the pids killed.
 */
export function killAgentsUnder(dir: string): number[] {
  const killed: number[] = [];
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return killed;
  }
  for (const pid of pids) {
    let argv: string[];
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, "latin1").split("\0");
    } catch {
      continue;
    }
    if (!argv.includes("__agent")) continue;
    const v = argv.find((a) => a.startsWith("--vault="));
    if (!v || !v.slice(8).startsWith(dir + "/")) continue;
    try {
      process.kill(Number(pid), "SIGTERM");
      killed.push(Number(pid));
    } catch {
      /* gone */
    }
  }
  return killed;
}

export { makePair, PASS, type Pair };
