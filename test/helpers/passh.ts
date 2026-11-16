// Helpers that drive a passh binary (ours or the reference) through its prompts.
// Both implementations print the same prompts, so the same helpers work for both.

import { spawnPty } from "./pty.ts";
import { join } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import type { IsolatedEnv } from "./env.ts";

export const PASS = "correct horse battery staple x";

/** `passh init` with a passphrase, declining the recovery key sheet. Returns the PTY output. */
export async function initVault(cmd: string[], e: IsolatedEnv, passphrase = PASS, extraArgs: string[] = []): Promise<string> {
  const p = spawnPty([...cmd, "init", ...extraArgs], e.env);
  await p.expect("New passphrase: ");
  p.line(passphrase);
  await p.expect("Repeat passphrase: ");
  p.line(passphrase);
  await p.expect("[Y/n] ", 30_000);
  p.line("n");
  const r = await p.wait();
  if (r.code !== 0) throw new Error(`init failed (${r.code}): ${r.output}`);
  return r.output;
}

export interface PromptedResult {
  code: number;
  /** stdout only (separate from the terminal). */
  stdout: string;
  /** stderr, /dev/tty prompts and messages: everything that went to the PTY. */
  tty: string;
}

/**
 * Runs a command on a PTY with stdout piped, answering every `Passphrase: ` prompt with
 * the passphrase, and the given extra answers to other prompts (in order: [prompt, answer]).
 */
export async function withPassphrase(cmd: string[], args: string[], e: IsolatedEnv, passphrase = PASS, answers: Array<[string | RegExp, string]> = []): Promise<PromptedResult> {
  const outFile = join(e.dir, `stdout-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const p = spawnPty([...cmd, ...args], e.env, { stdoutFile: outFile });
  const queue = [...answers];
  const done = p.wait(60_000);
  let finished = false;
  done.then(() => (finished = true));
  // Answer prompts until the process exits.
  while (!finished) {
    const next = queue[0];
    const pattern = next ? next[0] : null;
    try {
      const got = await p.expect(pattern ? new RegExp(`Passphrase: |${pattern instanceof RegExp ? pattern.source : escapeRe(pattern)}`) : "Passphrase: ", 60_000);
      if (got.endsWith("Passphrase: ") && !(pattern && matches(got, pattern) && !/Passphrase: $/.test(String(pattern)))) {
        p.line(passphrase);
      } else if (next) {
        queue.shift();
        p.line(next[1]);
      }
    } catch {
      break;
    }
  }
  const r = await done;
  let stdout = "";
  try {
    stdout = readFileSync(outFile, "utf8");
    rmSync(outFile, { force: true });
  } catch {}
  return { code: r.code, stdout, tty: r.output };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matches(text: string, pattern: string | RegExp): boolean {
  return typeof pattern === "string" ? text.endsWith(pattern) : pattern.test(text);
}
