// Errors that carry an exit status (cli.md §1.4). Everything else exits 1.

import { PasshError, E } from "./i18n/index.ts";

/** A usage error: exit status 2, followed by the usage hint (cli.md §1.3, §1.4). */
export class UsageError extends PasshError {
  constructor(format: string, ...args: unknown[]) {
    super(format, args, { exitCode: 2, code: "usage" });
    this.name = "UsageError";
  }
}

/** Signal numbers used for 128 + n (cli.md §1.4). */
export const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGPIPE: 13, SIGTERM: 15 };

/** Go's names for the signals passh catches, as in `interrupted (<signal name>)`. */
export const SIGNAL_NAMES: Record<string, string> = {
  SIGHUP: "hangup",
  SIGINT: "interrupt",
  SIGTERM: "terminated",
  SIGQUIT: "quit",
};

/**
 * A prompt or TUI ended by a signal: exit 128 + n (cli.md §1.4), message
 * `interrupted (<signal name>)` unless a caller wraps it.
 */
export class SignalError extends PasshError {
  readonly signal: string;
  constructor(signal: string, format = "interrupted (%s)", ...args: unknown[]) {
    super(format, args.length ? args : [SIGNAL_NAMES[signal] ?? signal], { exitCode: 128 + (SIGNALS[signal] ?? 0), code: "signal" });
    this.name = "SignalError";
    this.signal = signal;
  }
}

/** Ends the command with a status and no message (e.g. `doctor` with errors). */
export class SilentExit extends Error {
  readonly exitCode: number;
  constructor(exitCode: number) {
    super(E("exit status %d", exitCode));
    this.name = "SilentExit";
    this.exitCode = exitCode;
  }
}

/** The exit status an error ends the command with. */
export function exitCodeOf(e: unknown): number {
  if (e instanceof SilentExit) return e.exitCode;
  // A signal keeps its 128 + n through wrapping (errorf("…: %w", signalError)).
  for (let cur: unknown = e, depth = 0; cur instanceof Error && depth < 50; cur = cur.cause, depth++) {
    if (cur instanceof SignalError) return cur.exitCode;
  }
  if (e instanceof PasshError) return e.exitCode;
  return 1;
}
