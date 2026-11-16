// Run functions of the commands, by tree key. Filled in by the cmd_*.ts modules.

import type { CommandSpec, RunContext } from "./command.ts";
import { errorf } from "../i18n/index.ts";
import { writeStdout } from "./output.ts";
import { VERSION_STRING } from "./version.ts";
import { closeTerminal } from "./open.ts";
import { runFind, runLs, runTags } from "./cmd_ls.ts";
import { runCopy, runShow } from "./cmd_show.ts";
import { runGenerate, runMv, runRm, runTag } from "./cmd_change.ts";
import { runAdd } from "./cmd_add.ts";
import { runEdit } from "./cmd_edit.ts";
import { runPasswd, runRecover, runRekey } from "./cmd_keys.ts";
import { runInit } from "./cmd_init.ts";
import { runTuiCommand } from "./cmd_tui.ts";
import { RUNS_MORE } from "./runs_more.ts";

const notYet = (name: string): CommandSpec["run"] => () => {
  throw errorf("%s is not implemented yet", name);
};

/** Runs a command and closes the terminal it opened, whatever happens. */
const withTerminal =
  (run: (ctx: RunContext) => Promise<void>): CommandSpec["run"] =>
  async (ctx) => {
    try {
      await run(ctx);
    } finally {
      closeTerminal();
    }
  };

export const RUNS: Partial<Record<string, CommandSpec["run"]>> = {
  // `passh` alone: the TUI (cli.md §2.1); it opens and closes its own /dev/tty.
  root: runTuiCommand,
  version: () => writeStdout(`passh ${VERSION_STRING}\n`),
};

// unlock, lock, verify, backup, backups, import pass, export, print, recovery-key print, doctor.
for (const k of ["backup", "backups", "doctor", "export", "import pass", "lock", "print", "recovery-key print", "unlock", "verify"]) {
  RUNS[k] = RUNS_MORE[k] ?? notYet(k);
}

// The entry and key commands (cli.md §2.2–§2.13, §2.16, §2.18).
const ENTRY_AND_KEY_COMMANDS: Record<string, (ctx: RunContext) => Promise<void>> = {
  init: runInit,
  ls: runLs,
  find: runFind,
  show: runShow,
  copy: runCopy,
  add: runAdd,
  edit: runEdit,
  generate: runGenerate,
  mv: runMv,
  rm: runRm,
  tag: runTag,
  tags: runTags,
  passwd: runPasswd,
  rekey: runRekey,
  recover: runRecover,
};
for (const [k, run] of Object.entries(ENTRY_AND_KEY_COMMANDS)) RUNS[k] = withTerminal(run);
