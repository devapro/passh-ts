// The CLI entry: builds the command tree, runs it, maps errors to exit statuses
// (cli.md §1.3–§1.4).

import { execute, usageHint } from "./command.ts";
import { buildTree } from "./tree.ts";
import { printError, stderrRaw, writeStdout } from "./output.ts";
import { exitCodeOf, SilentExit, UsageError } from "../errors.ts";
import { RUNS } from "./runs.ts";

import { VERSION_STRING as VERSION } from "./version.ts";

/** Runs passh with the arguments after the program name; returns the exit status. */
export async function runCli(argv: string[]): Promise<number> {
  const root = buildTree(RUNS);
  try {
    const r = await execute(root, argv, VERSION);
    if (r.stdout !== undefined) writeStdout(r.stdout);
    return 0;
  } catch (e) {
    if (e instanceof SilentExit) return e.exitCode;
    printError(e);
    if (e instanceof UsageError) stderrRaw(usageHint() + "\n");
    return exitCodeOf(e);
  }
}
