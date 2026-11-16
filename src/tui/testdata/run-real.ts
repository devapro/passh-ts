// A driver for PTY tests: `passh` (no arguments) through runTuiCommand, with the real
// backend, as the CLI would run it (errors printed as `passh: <error>`, exit statuses of
// cli.md §1.4). Arguments: [--vault <file>] [--config <file>].
//
// Used until the root command is registered in src/cli/runs.ts; then `bun run src/main.ts`
// does the same.

import { runTuiCommand } from "../../cli/cmd_tui.ts";
import type { RunContext } from "../../cli/command.ts";
import { exitCodeOf } from "../../errors.ts";
import { renderError } from "../../i18n/index.ts";
import { escapeMultiline } from "../../sanitize/index.ts";
import "../../i18n/catalogs.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const ctx = { args: [], global: { vault: flag("--vault"), config: flag("--config") } } as unknown as RunContext;
try {
  await runTuiCommand(ctx);
  process.exit(0);
} catch (e) {
  const code = exitCodeOf(e);
  if (!(e && typeof e === "object" && (e as { name?: string }).name === "SilentExit")) process.stderr.write("passh: " + escapeMultiline(renderError(e)) + "\n");
  process.exit(code);
}
