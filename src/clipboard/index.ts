// The clipboard (spec §6.3, S6; agent-session.md §A5): the method (clipboard.command or
// OSC 52), the copy and the clear, the schedule (a newer copy cancels the older clear),
// and `passh copy`'s flow (copyAndWait). The config values come in as plain parameters.

import { codedError, errorf, PasshError, T, E, type Localizable } from "../i18n/index.ts";
import { escapeLine } from "../sanitize/index.ts";
import { formatShortDuration } from "../util/duration.ts";
import { exitError, goSignalText, lookPath, runProcess } from "../exec/index.ts";
import { SignalWatch } from "../tty/signals.ts";
import type { Tty } from "../tty/tty.ts";
import { OSC52_CLEAR, osc52Sequence } from "./osc52.ts";
import { shellQuote } from "./shellquote.ts";

export { osc52Sequence, OSC52_CLEAR } from "./osc52.ts";
export { shellQuote } from "./shellquote.ts";

/** Clipboard command timeout, copy or clear (§A1). */
export const COMMAND_TIMEOUT_MS = 10_000;

const encoder = new TextEncoder();

/** A way to set the clipboard. `set` with an empty value clears it. */
export interface ClipboardMethod extends Localizable {
  readonly kind: "osc52" | "command";
  /** `OSC 52 through the terminal` or `command "<argv>"`, in the language (localize) or English (toString). */
  localize(): string;
  toString(): string;
  set(value: Uint8Array): Promise<void>;
}

/** OSC 52 through the terminal: one write to /dev/tty, never stdout. */
export class Osc52Method implements ClipboardMethod {
  readonly kind = "osc52" as const;
  constructor(readonly tty: Tty) {}
  localize(): string {
    return T("OSC 52 through the terminal");
  }
  toString(): string {
    return "OSC 52 through the terminal";
  }
  async set(value: Uint8Array): Promise<void> {
    this.tty.writeRaw(value.length === 0 ? OSC52_CLEAR : osc52Sequence(value));
  }
}

/** clipboard.command: the value on its stdin, stdout and stderr /dev/null, killed after 10 s. */
export class CommandMethod implements ClipboardMethod {
  readonly kind = "command" as const;
  /** argv as configured; path is argv[0] looked up in $PATH. */
  constructor(
    readonly argv: string[],
    readonly path: string,
  ) {}
  private shown(): string {
    // The configured words, escaped single-line, then Go-quoted (`command "xclip -selection clipboard"`).
    return escapeLine(this.argv.join(" "));
  }
  localize(): string {
    return T("command %q", this.shown());
  }
  toString(): string {
    return E("command %q", this.shown());
  }
  async set(value: Uint8Array): Promise<void> {
    const r = await runProcess({
      argv: this.argv,
      path: this.path,
      display: this.argv[0]!,
      stdin: value,
      stdout: "null",
      stderr: "null",
      timeoutMs: COMMAND_TIMEOUT_MS,
    }).catch((e) => {
      throw errorf("clipboard command: %w", e);
    });
    const err = exitError(this.argv[0]!, r);
    if (err) throw errorf("clipboard command: %w", err);
  }
}

/** The `no clipboard: <reason>; copy with: …` error (code "no-clipboard"). `reason` is its reason alone. */
export class NoClipboardError extends PasshError {
  readonly reason: PasshError;
  constructor(reason: PasshError, hint?: { path: string; field: string }) {
    if (hint) super("no clipboard: %s; copy with: passh show %s --field %s | pbcopy", [reason, shellQuote(hint.path), shellQuote(hint.field)], { code: "no-clipboard" });
    else super("no clipboard: %s", [reason], { code: "no-clipboard" });
    this.name = "NoClipboardError";
    this.reason = reason;
  }
}

export interface ClipboardConfig {
  /** clipboard.command (empty: none). */
  command: string[];
  /** clipboard.osc52. */
  osc52: boolean;
}

/**
 * Chooses the method, once per command (§A5): clipboard.command if not empty (its program
 * must be found in $PATH: else `clipboard.command: exec: exec: "<name>": …`, no fallback);
 * else OSC 52 if enabled and there is a terminal; else NoClipboardError, whose text names
 * `passh show <path> --field <field> | pbcopy` when `hint` is given (path and field as the
 * user gave them; quoted here for a POSIX shell).
 */
export function chooseClipboard(cfg: ClipboardConfig, tty: Tty | null, hint?: { path: string; field: string }): ClipboardMethod {
  if (cfg.command.length > 0) {
    const name = cfg.command[0]!;
    if (name === "") throw errorf("clipboard.command: the program name is empty");
    let path: string;
    try {
      path = lookPath(name);
    } catch (e) {
      throw errorf("clipboard.command: %w", e);
    }
    return new CommandMethod([...cfg.command], path);
  }
  if (cfg.osc52 && tty) return new Osc52Method(tty);
  const reason = cfg.osc52
    ? errorf("OSC 52 needs a terminal and there is none, and clipboard.command is empty")
    : errorf("clipboard.osc52 is off and clipboard.command is empty");
  throw new NoClipboardError(reason, hint);
}

/**
 * A failed clear (informative, §A5): its text is its cause's; it has the code
 * "clear-failed" ("clearing the clipboard failed"), which callers branch on, never the text.
 */
export class ClearError extends PasshError {
  constructor(cause: unknown) {
    super("%w", [cause], { code: "clear-failed", cause });
    this.name = "ClearError";
  }
}

export type ClearOutcome = "cleared" | "superseded";

/** A clear that is due: when (wall-clock ms) and its outcome (rejects with ClearError). */
export interface PendingClear {
  clearAt: number;
  done: Promise<ClearOutcome>;
}

interface Schedule extends PendingClear {
  startMono: number;
  startWall: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  settle(outcome: ClearOutcome | { error: unknown }): void;
  running: boolean;
}

function toBytes(v: string | Uint8Array): Uint8Array {
  return typeof v === "string" ? encoder.encode(v) : v;
}

/**
 * The clipboard of one process: copies, and clears `clearAfterMs` later (S6). A newer copy
 * cancels the older schedule (an old timer never clears a newer value). The due time is
 * checked by wall clock as well as by the monotonic clock (spec audit #1, proposed fix
 * implemented): a machine that slept past the deadline clears within a second of waking.
 * A clear sends the empty value whatever the clipboard holds then.
 */
export class Clipboard {
  private schedule: Schedule | null = null;

  constructor(
    readonly method: ClipboardMethod,
    readonly clearAfterMs: number,
  ) {}

  /** Copies value and schedules the clear. Throws when the copy fails (nothing scheduled then). */
  async copy(value: string | Uint8Array): Promise<PendingClear> {
    const bytes = toBytes(value);
    await this.method.set(bytes);
    if (typeof value !== "string") bytes.fill(0);
    this.cancel();
    const s = this.newSchedule();
    this.schedule = s;
    this.tick(s);
    return { clearAt: s.clearAt, done: s.done };
  }

  /** The pending clear, or null. */
  pending(): PendingClear | null {
    return this.schedule ? { clearAt: this.schedule.clearAt, done: this.schedule.done } : null;
  }

  /**
   * Clears at once if a clear is pending (its `done` settles "superseded"). Returns false
   * when nothing was pending. Throws ClearError when the clear fails.
   */
  async clearNow(): Promise<boolean> {
    const s = this.schedule;
    if (!s) return false;
    this.schedule = null;
    if (s.timer) clearTimeout(s.timer);
    s.settle("superseded");
    await this.clearWith();
    return true;
  }

  /** Drops the pending schedule without clearing (its `done` settles "superseded"). */
  cancel(): void {
    const s = this.schedule;
    if (!s) return;
    this.schedule = null;
    if (s.timer) clearTimeout(s.timer);
    s.settle("superseded");
  }

  private async clearWith(): Promise<void> {
    try {
      await this.method.set(new Uint8Array(0));
    } catch (e) {
      throw new ClearError(e);
    }
  }

  private newSchedule(): Schedule {
    let settle!: Schedule["settle"];
    const done = new Promise<ClearOutcome>((resolve, reject) => {
      let settled = false;
      settle = (o) => {
        if (settled) return;
        settled = true;
        if (typeof o === "string") resolve(o);
        else reject(o.error);
      };
    });
    done.catch(() => {}); // a failed clear nobody waits for isn't an unhandled rejection
    const startWall = Date.now();
    return { clearAt: startWall + this.clearAfterMs, done, startMono: performance.now(), startWall, timer: undefined, settle, running: false };
  }

  private tick(s: Schedule): void {
    if (this.schedule !== s) return;
    const elapsed = Math.max(performance.now() - s.startMono, Date.now() - s.startWall);
    const left = this.clearAfterMs - elapsed;
    if (left > 0) {
      s.timer = setTimeout(() => this.tick(s), Math.min(left, 1000));
      return;
    }
    s.running = true;
    void this.clearWith().then(
      () => {
        if (this.schedule === s) this.schedule = null;
        s.settle("cleared");
      },
      (e) => {
        if (this.schedule === s) this.schedule = null;
        s.settle({ error: e });
      },
    );
  }

  /** Lets the process exit while a clear is pending (TUI); the default keeps it alive. */
  unref(): void {
    const t = this.schedule?.timer as { unref?: () => void } | undefined;
    t?.unref?.();
  }
}

export interface CopyAndWaitOptions {
  /** The method and clear_after (chooseClipboard; config clipboard.clear_after in ms). */
  clipboard: Clipboard;
  /** The value: never printed. A Uint8Array is zeroed after the copy. */
  value: string | Uint8Array;
  /** The field name and entry path, escaped single-line by the caller. */
  field: string;
  path: string;
  /** Writes one status line to stderr (the caller escapes, S4 multi-line). */
  status: (line: string) => void;
  /** A watch started before the copy (default: started here, before the copy). */
  watch?: SignalWatch;
}

/**
 * `passh copy` after the value is known (cli.md §2.6, §A5): SIGINT, SIGTERM and SIGHUP are
 * caught from before the copy; copy; `Copied the <f> of <path> (<method>); the clipboard
 * clears in <D>, Ctrl-C clears it now.`; wait; clear; `Clipboard cleared.`. A signal
 * clears at once and returns normally (exit 0). Failures: the copy's error; a failed
 * clear → `clearing the clipboard failed: <cause>` (after a signal: `interrupted (<why>),
 * and clearing the clipboard failed: <cause>`), code "clear-failed", exit 1.
 */
export async function copyAndWait(o: CopyAndWaitOptions): Promise<void> {
  const own = !o.watch;
  const watch = o.watch ?? new SignalWatch().start();
  try {
    const cb = o.clipboard;
    const pending = await cb.copy(o.value);
    o.status(T("Copied the %s of %s (%s); the clipboard clears in %s, Ctrl-C clears it now.", o.field, o.path, cb.method, formatShortDuration(cb.clearAfterMs)));
    const r = await Promise.race([
      pending.done.then(
        (v) => ({ kind: "done" as const, v }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
      watch.whenSignaled().then((signal) => ({ kind: "signal" as const, signal })),
    ]);
    if (r.kind === "signal") {
      try {
        await cb.clearNow();
      } catch (e) {
        const cause = e instanceof ClearError ? e.cause : e;
        throw codedError("clear-failed", "interrupted (%s), and clearing the clipboard failed: %w", goSignalText(r.signal), cause);
      }
    } else if (r.kind === "failed") {
      const cause = r.error instanceof ClearError ? r.error.cause : r.error;
      throw codedError("clear-failed", "clearing the clipboard failed: %w", cause);
    }
    o.status(T("Clipboard cleared."));
  } finally {
    if (own) watch.stop();
  }
}
