// The real CommandIO (src/util/io.ts) over the process streams (cli.md §1.3).

import { isatty } from "node:tty";
import type { CommandIO } from "../util/io.ts";
import { note, status, warn, warnOnce, writeStdout } from "./output.ts";

export const processIO: CommandIO = {
  stdout: writeStdout,
  status,
  note,
  warn,
  warnOnce,
  stdoutIsTerminal: () => isatty(1),
  stderrIsTerminal: () => isatty(2),
};
