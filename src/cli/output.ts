// Streams (cli.md §1.3): stdout carries only data; status lines, notes, warnings and
// errors go to stderr, escaped with S4's multi-line form.

import { writeSync } from "node:fs";
import { T, renderError, errorf } from "../i18n/index.ts";
import { escapeMultiline } from "../sanitize/index.ts";

function writeAllSync(fd: number, data: Uint8Array): void {
  let off = 0;
  while (off < data.length) {
    try {
      off += writeSync(fd, data, off, data.length - off);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        Bun.sleepSync(1);
        continue;
      }
      throw e;
    }
  }
}

/** Ends the process by SIGPIPE's default action (cli.md §1.3: a closed pipe). */
export function dieBySigpipe(): never {
  try {
    process.kill(process.pid, "SIGPIPE");
  } catch {}
  // If SIGPIPE is ignored by the runtime, exit as a shell would report it.
  process.exit(141);
}

/** Writes data to stdout; EPIPE ends passh by SIGPIPE, other errors become `write /dev/stdout: …`. */
export function writeStdout(data: string | Uint8Array): void {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  try {
    writeAllSync(1, bytes);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EPIPE") dieBySigpipe();
    throw errorf("write /dev/stdout: %s", goErrnoText(err));
  }
}

function goErrnoText(e: NodeJS.ErrnoException): string {
  switch (e.code) {
    case "ENOSPC":
      return "no space left on device";
    case "EIO":
      return "input/output error";
    case "EBADF":
      return "bad file descriptor";
    default:
      return e.message;
  }
}

function writeStderr(text: string): void {
  try {
    writeAllSync(2, new TextEncoder().encode(text));
  } catch {
    // a failed write to stderr is ignored (cli.md §1.3)
  }
}

/** A status line, confirmation or hint: the text alone. `text` is already translated. */
export function status(text: string): void {
  writeStderr(escapeMultiline(text) + "\n");
}

/** A note: `passh: <text>`. */
export function note(text: string): void {
  writeStderr("passh: " + escapeMultiline(text) + "\n");
}

/** A warning: `passh: warning: <text>`. */
export function warn(text: string): void {
  writeStderr("passh: " + escapeMultiline(T("warning: ") + text) + "\n");
}

/** Warnings printed once per command (storage.md §3.3). */
const seenWarnings = new Set<string>();
export function warnOnce(text: string): void {
  if (seenWarnings.has(text)) return;
  seenWarnings.add(text);
  warn(text);
}

/** The error at exit: `passh: <message>`. */
export function printError(e: unknown): void {
  writeStderr("passh: " + escapeMultiline(renderError(e)) + "\n");
}

/** Raw stderr text (help on errors etc.), already formatted. */
export function stderrRaw(text: string): void {
  writeStderr(text);
}
