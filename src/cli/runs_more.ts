// Run functions of the remaining commands, by tree key (merged into src/cli/runs.ts by the
// lead): unlock, lock (cli.md §2.14–§2.15), verify, backup, backups (§2.19–§2.21), import
// pass, export (§2.22–§2.23), print, recovery-key print (§2.17, §2.24) and doctor (§2.25).

import type { CommandSpec, RunContext } from "./command.ts";
import { closeTerminal } from "./open.ts";
import { runLockCmd, runUnlockCmd } from "./cmd_agent.ts";
import { runBackupCmd, runBackupsCmd, runVerifyCmd } from "./cmd_files.ts";
import { runExportCmd, runImportPassCmd } from "./cmd_transfer.ts";
import { runPrintCmd, runRecoveryKeyPrintCmd } from "./cmd_print.ts";
import { runDoctor } from "./cmd_doctor.ts";

/** Runs a command and closes the terminal it opened (src/cli/open.ts commandTerminal), whatever happens. */
const withTerminal =
  (run: (ctx: RunContext) => Promise<void>): CommandSpec["run"] =>
  async (ctx) => {
    try {
      await run(ctx);
    } finally {
      closeTerminal();
    }
  };

export const RUNS_MORE: Partial<Record<string, CommandSpec["run"]>> = {
  unlock: withTerminal(runUnlockCmd),
  lock: withTerminal(runLockCmd),
  verify: withTerminal(runVerifyCmd),
  backup: withTerminal(runBackupCmd),
  backups: withTerminal(runBackupsCmd),
  "import pass": withTerminal(runImportPassCmd),
  export: withTerminal(runExportCmd),
  print: withTerminal(runPrintCmd),
  "recovery-key print": withTerminal(runRecoveryKeyPrintCmd),
  doctor: withTerminal(runDoctor),
};
