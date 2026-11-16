// Run functions of the commands, by tree key. Filled in by the cmd_*.ts modules.

import type { CommandSpec } from "./command.ts";
import { errorf } from "../i18n/index.ts";
import { writeStdout } from "./output.ts";
import { VERSION_STRING } from "./version.ts";

const notYet = (name: string): CommandSpec["run"] => () => {
  throw errorf("%s is not implemented yet", name);
};

export const RUNS: Partial<Record<string, CommandSpec["run"]>> = {
  root: notYet("the TUI"),
  version: () => writeStdout(`passh ${VERSION_STRING}\n`),
};

for (const k of ["add", "backup", "backups", "copy", "doctor", "edit", "export", "find", "generate", "import pass", "init", "lock", "ls", "mv", "passwd", "print", "recover", "recovery-key print", "rekey", "rm", "show", "tag", "tags", "unlock", "verify"]) {
  RUNS[k] = notYet(k);
}
