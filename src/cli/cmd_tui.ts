// `passh` with no arguments: the TUI (cli.md §2.1, tui.md §1).
//
// Checks, in order: the config and the vault file (cli.md §1.2), then the terminal (§1.7);
// then the TUI over the real backend. Exit statuses: 0 after a quit; 128 + n after a signal
// (the TUI locks first and throws the SignalError); 1 after "no" to the rollback question or
// another error (thrown).

import { errorf, type PasshError } from "../i18n/index.ts";
import { openTty } from "../tty/index.ts";
import { runTui, terminalFromTty } from "../tui/index.ts";
import { SilentExit } from "../errors.ts";
import type { RunContext } from "./command.ts";
import { configAndVault } from "./open.ts";
import { createTuiBackend } from "./tuibackend.ts";

/** The error without a terminal (cli.md §1.7, tui.md §1.1 step 2). */
export function tuiNeedsTerminal(): PasshError {
  return errorf("the TUI needs a terminal: run passh in one (over SSH: `ssh -t host passh`); without a terminal, use the commands (passh --help) after `passh unlock`");
}

/** Runs the TUI (the root command's run). */
export async function runTuiCommand(ctx: RunContext): Promise<void> {
  const cfg = configAndVault(ctx);
  const tty = openTty();
  if (!tty) throw tuiNeedsTerminal();
  const term = terminalFromTty(tty);
  try {
    const backend = createTuiBackend(cfg, { tty });
    const code = await runTui(backend, { terminal: term });
    if (code !== 0) throw new SilentExit(code);
  } finally {
    term.close();
  }
}
