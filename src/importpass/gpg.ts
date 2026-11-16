// Decrypting a store file with gpg (import-export.md §1.5, agent-session.md §A4 GPG_TTY, §A7):
// `gpg --quiet --status-fd 3 --decrypt`, the ciphertext on stdin, the plaintext from stdout
// into memory, status lines from fd 3, stderr to /dev/null; success is judged from the status
// lines and the exit status only.

import { codedError, errorf, type PasshError } from "../i18n/index.ts";
import { lookPath, runProcess } from "../exec/index.ts";
import { isWhiteSpace } from "../util/unicode.ts";

/** Ciphertext limit: a larger file is skipped as `too large` without starting gpg. */
export const CIPHERTEXT_LIMIT = 1024 * 1024;
/** Plaintext limit: on more, gpg's stdout is closed and the file skipped. */
export const PLAINTEXT_LIMIT = 4 * 1024 * 1024;
/** Status output kept (the rest is read and discarded). */
export const STATUS_LIMIT = 1024 * 1024;
/** The status pipe is closed this long after gpg exits if something (gpg-agent) still holds it. */
export const STATUS_CLOSE_AFTER_EXIT_MS = 2000;
/** gpg's arguments, exactly: no `--batch`, no file argument. */
export const GPG_ARGS = ["--quiet", "--status-fd", "3", "--decrypt"] as const;

/** The failure keywords of §1.5. */
const FAILURE_KEYWORDS = new Set(["DECRYPTION_FAILED", "BADMDC", "NODATA", "BADARMOR", "UNEXPECTED", "ERROR", "FAILURE", "BAD_PASSPHRASE"]);
/** GPG_ERR_CANCELED and GPG_ERR_FULLY_CANCELED. */
const CANCEL_CODES = new Set([99n, 198n]);
const MAX_UINT64 = (1n << 64n) - 1n;

/**
 * The gpg program (§1.5): `gpg2` if found in $PATH, else `gpg` (as pass does). Neither found:
 * `gpg not found: import pass needs GnuPG (gpg) to decrypt the store`.
 */
// SPEC-GAP: §1.5: a match found only through a relative $PATH entry (refused by §A7) counts as
// not found, and the next name is tried.
export function findGpg(env: Record<string, string | undefined> = process.env): string {
  for (const name of ["gpg2", "gpg"]) {
    try {
      return lookPath(name, env);
    } catch {
      /* next */
    }
  }
  throw codedError("gpg-not-found", "gpg not found: import pass needs GnuPG (gpg) to decrypt the store");
}

/** One `[GNUPG:] ` status line: its whitespace-separated fields, the first being the keyword. */
export interface StatusLine {
  fields: string[];
}

function splitFields(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (isWhiteSpace(ch.codePointAt(0)!)) {
      if (cur !== "") out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur !== "") out.push(cur);
  return out;
}

const PREFIX = "[GNUPG:] ";

/**
 * Parses gpg's status output (§1.5 "Status parsing"): split on LF, one trailing CR dropped;
 * only lines starting with `[GNUPG:] ` (with the space) count, split on white space.
 */
// SPEC-GAP: §1.5 doesn't say how status bytes that aren't UTF-8 are read: decoded with U+FFFD
// (gpg's status lines are ASCII; user ids in them are percent-escaped).
export function parseStatus(status: Uint8Array): StatusLine[] {
  const text = new TextDecoder().decode(status);
  const out: StatusLine[] = [];
  for (let line of text.split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.startsWith(PREFIX)) continue;
    const fields = splitFields(line.slice(PREFIX.length));
    if (fields.length > 0) out.push({ fields });
  }
  return out;
}

/** What gpg's run means for the file (§1.5). */
export type GpgVerdict = { kind: "ok" } | { kind: "canceled" } | { kind: "failed"; detail: PasshError };

/** An `ERROR`/`FAILURE` line whose third field is an unsigned decimal c with c & 0xFFFF = 99 or 198. */
function isCancelLine(l: StatusLine): boolean {
  const [kw, , code] = l.fields;
  if ((kw !== "ERROR" && kw !== "FAILURE") || code === undefined || !/^[0-9]+$/.test(code)) return false;
  const c = BigInt(code);
  return c <= MAX_UINT64 && CANCEL_CODES.has(c & 0xffffn);
}

/**
 * Judges a gpg run from its exit status (null: ended by a signal) and status output (§1.5):
 * a cancel at the passphrase prompt first; success needs exit status 0, `DECRYPTION_OKAY` and
 * no failure keyword; otherwise the first matching detail of the table.
 */
export function judgeGpg(exitCode: number | null, status: Uint8Array): GpgVerdict {
  const lines = parseStatus(status);
  if (lines.some(isCancelLine)) return { kind: "canceled" };
  const has = (kw: string) => lines.some((l) => l.fields[0] === kw);
  const okay = has("DECRYPTION_OKAY");
  const failures = lines.filter((l) => FAILURE_KEYWORDS.has(l.fields[0]!));
  if (exitCode === 0 && okay && failures.length === 0) return { kind: "ok" };
  const fail = (e: PasshError): GpgVerdict => ({ kind: "failed", detail: e });
  const noSeckey = lines.filter((l) => l.fields[0] === "NO_SECKEY");
  if (noSeckey.length > 0 && !okay) {
    // SPEC-GAP: §1.5: the ids are listed as gpg reports them, repeats kept (as the reference
    // does); a NO_SECKEY line without an id adds nothing.
    const ids = noSeckey.filter((l) => l.fields.length > 1).map((l) => l.fields[1]!);
    return fail(errorf("no secret key for key ID %s", ids.join(", ")));
  }
  if (has("BAD_PASSPHRASE")) return fail(errorf("bad passphrase"));
  if (has("MISSING_PASSPHRASE")) return fail(errorf("no passphrase given"));
  if (has("NODATA") || has("BADARMOR") || has("UNEXPECTED")) return fail(errorf("not an OpenPGP message (damaged file?)"));
  if (failures.length > 0) return fail(errorf("gpg reported %s", failures.map((l) => l.fields.join(" ")).join("; ")));
  // Go's ProcessState.ExitCode() is -1 for a child ended by a signal.
  if (exitCode !== 0) return fail(errorf("gpg failed (exit status %d)", exitCode ?? -1));
  return fail(errorf("gpg did not report a successful decryption"));
}

export interface GpgRun {
  verdict: GpgVerdict;
  /** The plaintext (only meaningful for an "ok" verdict); the caller wipes it. */
  plaintext: Uint8Array;
  /** The plaintext went over PLAINTEXT_LIMIT: gpg's stdout was closed. */
  overflow: boolean;
}

/**
 * Runs gpg once on a ciphertext (§1.5). `env` holds the additions to the inherited
 * environment (GPG_TTY). A gpg that can't be started throws `gpg: ‹error›`.
 */
export async function runGpg(gpgPath: string, ciphertext: Uint8Array, env: Record<string, string> = {}): Promise<GpgRun> {
  let r;
  try {
    r = await runProcess({
      argv: [gpgPath, ...GPG_ARGS],
      path: gpgPath,
      display: gpgPath,
      stdin: ciphertext,
      stdout: "pipe",
      stderr: "null",
      stdoutLimit: PLAINTEXT_LIMIT,
      fd3: { limit: STATUS_LIMIT, closeAfterExitMs: STATUS_CLOSE_AFTER_EXIT_MS },
      env,
    });
  } catch (e) {
    throw errorf("gpg: %w", e);
  }
  const verdict = judgeGpg(r.exitCode, r.fd3);
  return { verdict, plaintext: r.stdout, overflow: r.stdoutOverflow };
}
