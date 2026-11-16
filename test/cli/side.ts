// Side-by-side runs for the CLI suites: the same command on the reference (reference/passh-go,
// a black box) and on ours (bun run src/main.ts), each in its own isolated env holding a
// byte-identical copy of the same vault, compared on exit status, stdout, stderr and what
// reached the terminal.

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { run, type IsolatedEnv } from "../helpers/env.ts";
import { spawnPty, type PtyProcess } from "../helpers/pty.ts";
import { PASS } from "../helpers/passh.ts";
import { makePair, normalize, OURS, REF, type Pair } from "./vaults.ts";

export type Side = "ref" | "ours";

/** A step of a PTY dialogue: wait for `expect` (text or regexp), then send `send` (+ Enter unless raw). */
export type Answer = [string | RegExp, string] | [string | RegExp, string, "raw"] | ((p: PtyProcess, e: IsolatedEnv) => Promise<void>);

export interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
  /** Everything on the terminal (prompts, /dev/tty messages); "" without a terminal. */
  tty: string;
}

export interface RunOptions {
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** On a PTY (else without a terminal, setsid). */
  pty?: boolean;
  /** PTY dialogue; default: answer `Passphrase: ` once. A process that ends before a prompt ends the dialogue. */
  answers?: Answer[];
  /** PTY: stdout stays on the terminal (not redirected), e.g. `show --field` on a terminal. */
  stdoutOnTty?: boolean;
  /** PTY: stdout goes to this file instead (e.g. /dev/full); stdout then reads "". */
  stdoutTo?: string;
  /** stdin for runs without a terminal. */
  stdin?: string;
  /** Text replacements applied to every output after the env folder is replaced. */
  replace?: Array<[RegExp, string]>;
  /** The working directory. */
  cwd?: (e: IsolatedEnv) => string;
  timeoutMs?: number;
}

/** The default dialogue: the passphrase. */
export const PASSPHRASE: Answer = ["Passphrase: ", PASS];

function bin(side: Side): string[] {
  return side === "ref" ? REF : OURS;
}

function readAndRemove(f: string): string {
  try {
    const s = readFileSync(f, "utf8");
    rmSync(f, { force: true });
    return s;
  } catch {
    return "";
  }
}

function finish(e: IsolatedEnv, o: RunOptions, out: Outcome): Outcome {
  const norm = (s: string) => {
    let t = normalize(s, e);
    for (const [re, to] of o.replace ?? []) t = t.replace(re, to);
    return t;
  };
  return { code: out.code, stdout: norm(out.stdout), stderr: norm(out.stderr), tty: norm(out.tty) };
}

/** Runs one command on one side. */
export async function runSide(side: Side, e: IsolatedEnv, args: string[], o: RunOptions = {}): Promise<Outcome> {
  const env = { ...e.env, ...(o.env ?? {}) };
  if (!o.pty) {
    const r = await run([...bin(side), ...args], env, { stdin: o.stdin, timeoutMs: o.timeoutMs, cwd: o.cwd?.(e) });
    return finish(e, o, { code: r.code, stdout: r.stdout, stderr: r.stderr, tty: "" });
  }
  const tag = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const outFile = join(e.dir, `o-${tag}`);
  const errFile = join(e.dir, `e-${tag}`);
  const script = o.stdoutOnTty ? 'r="$2"; shift 2; exec "$@" 2>"$r"' : 'o="$1"; r="$2"; shift 2; exec "$@" 2>"$r" >"$o"';
  const p = spawnPty(["/bin/sh", "-c", script, "sh", o.stdoutTo ?? outFile, errFile, ...bin(side), ...args], env, { cwd: o.cwd?.(e) });
  const answers = o.answers ?? [PASSPHRASE];
  try {
    for (const a of answers) {
      if (typeof a === "function") {
        await a(p, e);
        continue;
      }
      await p.expect(a[0], o.timeoutMs ?? 20_000);
      if (a[2] === "raw") p.send(a[1]);
      else p.line(a[1]);
    }
  } catch (err) {
    // A process that ended before a prompt (an error before the key, a refusal): compare what it did.
    if (!/process exited/.test((err as Error).message)) {
      p.kill("SIGKILL");
      const r = await p.wait(5_000);
      throw new Error(`${side} ${args.join(" ")}: ${(err as Error).message}\nterminal so far: ${JSON.stringify(r.output)}`);
    }
  }
  const r = await p.wait(o.timeoutMs ?? 60_000);
  return finish(e, o, { code: r.code, stdout: o.stdoutOnTty || o.stdoutTo ? "" : readAndRemove(outFile), stderr: readAndRemove(errFile), tty: r.output });
}

/** Runs the command on both sides of a pair; returns both outcomes. */
export async function both(pair: Pair, args: string[], o: RunOptions = {}): Promise<{ ref: Outcome; ours: Outcome }> {
  const ref = await runSide("ref", pair.ref, args, o);
  const ours = await runSide("ours", pair.ours, args, o);
  return { ref, ours };
}

export { makePair, type Pair };
