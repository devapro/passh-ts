// The TUI (`passh` without arguments, tui.md) and the standalone entry form (`passh edit`
// without --editor, tui.md §11.7).
//
//   const code = await runTui(backend);            // 0 on quit; throws to end otherwise
//   const r = await runEntryForm({ title, original, fieldKeys });
//
// runTui resolves with exit status 0 after a normal quit. It throws:
//   - a PasshError "the TUI needs a terminal: …" (exit 1) when /dev/tty isn't a terminal;
//   - the rollback question's "stopped: this copy is older …" error (exit 1) after "no";
//   - a SignalError "locked and stopped: received <signal>" (exit 128 + n) after a signal.
// Before it returns or throws, it has left the alternate screen, restored the terminal,
// written its report lines to stderr ("passh: Saved work/x.", "passh: Stopping the agent
// failed: …"), waited for a pending clipboard clear with a countdown on /dev/tty after a
// normal quit, and made a final bounded attempt to clear the clipboard.

import { T, errorf, renderError } from "../i18n/index.ts";
import { SignalError } from "../errors.ts";
import { escapeMultiline } from "../sanitize/index.ts";
import { App, LOCK_BOUND_MS, raceTimer, systemClock, type Clock, type Msg, type SignalName } from "./app.ts";
import type { EntryValues, TuiBackend } from "./backend.ts";
import { EntryForm, type FormText } from "./form.ts";
import type { InputMsg } from "./keys.ts";
import { openTerminal, runLoop, type LoopOptions, type Program, type Terminal } from "./runtime.ts";
import type { Line } from "./text.ts";
import { MIN_H, MIN_W, render } from "./view.ts";

export type { TuiBackend, TuiConfig, VaultSession, UnlockResult, SaveResult, ReloadResult, CopyResult, PrintPage, PrintRequest, PrintState, RollbackQuestion, EntryValues } from "./backend.ts";
export type { Clock } from "./app.ts";
export type { Terminal } from "./runtime.ts";
export { terminalFromTty } from "./runtime.ts";

export interface RunTuiOptions {
  /** The terminal (default: /dev/tty through src/tty). */
  terminal?: Terminal;
  clock?: Clock;
  /** Where the report lines go after the TUI has left the screen (default: stderr). */
  stderr?: (s: string) => void;
  loop?: LoopOptions;
}

class AppProgram implements Program<Msg> {
  constructor(readonly app: App) {}
  update(m: Msg) {
    return this.app.update(m);
  }
  render(): Line[] {
    return render(this.app);
  }
  done(): boolean {
    return this.app.screen === "bye";
  }
  resize(cols: number, rows: number): Msg {
    return { type: "resize", cols, rows };
  }
  init(): Msg {
    return { type: "start" };
  }
  tick(): Msg {
    return { type: "tick" };
  }
  signal(sig: SignalName): Msg {
    return { type: "signal", sig };
  }
  input(m: InputMsg): Msg {
    return m;
  }
}

function sigError(sig: SignalName): SignalError {
  const name = sig === "SIGHUP" ? "hangup" : sig === "SIGINT" ? "interrupt" : "terminated";
  return new SignalError(sig, "locked and stopped: received %s", name);
}

/** Runs the TUI (tui.md §1) until the user quits, a signal arrives or the rollback question is declined. */
export async function runTui(backend: TuiBackend, opts: RunTuiOptions = {}): Promise<number> {
  const own = opts.terminal ? null : openTerminal();
  const term = opts.terminal ?? own;
  if (!term) throw errorf("the TUI needs a terminal: run passh in one (over SSH: `ssh -t host passh`); without a terminal, use the commands (passh --help) after `passh unlock`");
  const clock = opts.clock ?? systemClock;
  const stderr = opts.stderr ?? ((s: string) => void process.stderr.write(s));
  const app = new App(backend, { clock });
  try {
    await runLoop(new AppProgram(app), term, opts.loop);
  } catch (e) {
    own?.close();
    throw e;
  }
  const plan = app.exit ?? { code: 0, lines: [], waitClear: false };
  for (const l of plan.lines) stderr("passh: " + escapeMultiline(l) + "\n");
  let error = plan.error;
  let code = plan.code;
  if (plan.waitClear && !error) {
    const sig = await waitForClear(backend, term, clock);
    if (sig && sig !== "SIGINT") {
      error = sigError(sig);
      code = 128 + (sig === "SIGHUP" ? 1 : 15);
    }
  }
  // a final bounded clipboard clear (tui.md §1.2)
  if (backend.pendingClear()) {
    const ctl = new AbortController();
    try {
      await raceTimer(backend.clearNow(ctl.signal), LOCK_BOUND_MS, false);
    } catch (e) {
      stderr("passh: " + escapeMultiline(T("Clearing the clipboard failed: %s", renderError(e))) + "\n");
    }
    ctl.abort();
  }
  own?.close();
  if (error) throw error;
  return code;
}

/**
 * After a normal quit: waits for a pending clipboard clear, rewriting
 * "Clipboard clears in N s — Ctrl-C clears now" every second on the terminal (tui.md §1.2).
 * A signal clears at once; returns the signal, if one ended the wait.
 */
async function waitForClear(backend: TuiBackend, term: Terminal, clock: Clock): Promise<SignalName | null> {
  const pc = backend.pendingClear();
  if (!pc) return null;
  let sig: SignalName | null = null;
  let wake: () => void = () => {};
  const handlers: Array<[SignalName, () => void]> = (["SIGINT", "SIGTERM", "SIGHUP"] as SignalName[]).map((s) => [
    s,
    () => {
      sig ??= s;
      wake();
    },
  ]);
  for (const [s, h] of handlers) process.on(s, h);
  let settled = false;
  let outcome: unknown = null;
  pc.done.then(
    () => {
      settled = true;
      wake();
    },
    (e) => {
      settled = true;
      outcome = e;
      wake();
    },
  );
  try {
    while (!settled && !sig) {
      const left = pc.clearAt - clock.wall();
      if (left > 0) term.write("\r\x1b[K" + escapeMultiline(T("Clipboard clears in %d s — Ctrl-C clears now", Math.ceil(left / 1000))));
      const wait = left > 0 ? Math.min(1000, left - Math.floor((left - 1) / 1000) * 1000) : 1000;
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, Math.max(10, wait));
      });
    }
    if (sig) {
      const ctl = new AbortController();
      try {
        const ok = await raceTimer(backend.clearNow(ctl.signal).then(() => true), LOCK_BOUND_MS, false);
        outcome = ok ? null : new Error(T("timed out after %s", "5s"));
      } catch (e) {
        outcome = e;
      }
      ctl.abort();
    }
    term.write("\r\x1b[K" + escapeMultiline(outcome ? T("Clearing the clipboard failed: %s", renderError(outcome)) : T("Clipboard cleared.")) + "\n");
  } finally {
    for (const [s, h] of handlers) process.off(s, h);
  }
  return sig;
}

// ---------------------------------------------------------------------------
// The standalone form (tui.md §11.7)

export interface EntryFormOptions {
  /** The title, e.g. "edit work/github" (raw; escaped when drawn). */
  title: string;
  /** The entry's values (the base of the save rule). */
  original: EntryValues;
  /** Custom field keys (listed, not editable). */
  fieldKeys: string[];
  /** Start values, if not the original's (e.g. an edit applied again after a reload). */
  initial?: FormText;
  /** A first message in the form's status line. */
  message?: string;
  terminal?: Terminal;
  clock?: Clock;
  loop?: LoopOptions;
}

export type EntryFormResult =
  | { kind: "save"; values: EntryValues }
  /** Esc/Ctrl-C (after the discard question when something changed). */
  | { kind: "cancel" }
  /** SIGHUP, SIGTERM or SIGINT ended the form; nothing is returned. */
  | { kind: "signal"; signal: SignalName };

type FormMsg = InputMsg | { type: "resize"; cols: number; rows: number } | { type: "tick" } | { type: "signal"; sig: SignalName };

class FormProgram implements Program<FormMsg> {
  cols = 80;
  rows = 24;
  result: EntryFormResult | null = null;
  constructor(
    readonly form: EntryForm,
    readonly clock: Clock,
  ) {}
  update(m: FormMsg) {
    if (this.result) return [];
    switch (m.type) {
      case "resize":
        this.cols = m.cols;
        this.rows = m.rows;
        break;
      case "tick":
        this.form.tick(this.clock.mono());
        break;
      case "signal":
        this.form.wipe();
        this.result = { kind: "signal", signal: m.sig };
        break;
      default: {
        const out = this.form.update(m, this.clock.mono(), true);
        if (out.kind === "save") this.result = { kind: "save", values: out.values };
        else if (out.kind === "cancel") {
          this.form.wipe();
          this.result = { kind: "cancel" };
        }
      }
    }
    return [];
  }
  render(): Line[] {
    if (this.cols < MIN_W || this.rows < MIN_H) return [[{ t: T("passh: window too small"), s: 0 }]];
    return this.form.view(this.cols, this.rows, this.clock.mono());
  }
  done(): boolean {
    return this.result !== null;
  }
  resize(cols: number, rows: number): FormMsg {
    return { type: "resize", cols, rows };
  }
  init(): null {
    return null;
  }
  tick(): FormMsg {
    return { type: "tick" };
  }
  signal(sig: SignalName): FormMsg {
    return { type: "signal", sig };
  }
  input(m: InputMsg): FormMsg {
    return m;
  }
}

/**
 * Runs the built-in entry form on its own alternate screen (tui.md §11.7): no title line,
 * countdown, idle lock or banner; Ctrl-C is a key. Throws "the entry form needs a terminal"
 * when /dev/tty isn't a terminal.
 */
export async function runEntryForm(opts: EntryFormOptions): Promise<EntryFormResult> {
  const own = opts.terminal ? null : openTerminal();
  const term = opts.terminal ?? own;
  if (!term) throw errorf("the entry form needs a terminal");
  const clock = opts.clock ?? systemClock;
  const form = new EntryForm({ title: opts.title, original: opts.original, initial: opts.initial, fieldKeys: opts.fieldKeys });
  if (opts.message) form.setMessage(opts.message);
  const prog = new FormProgram(form, clock);
  try {
    await runLoop(prog, term, opts.loop);
  } finally {
    own?.close();
  }
  return prog.result ?? { kind: "cancel" };
}
