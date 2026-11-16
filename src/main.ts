// passh entry point: hardening first (S7, agent-session.md §A8), the language before the
// command line is parsed (i18n.md §2), then the CLI or the agent child (cli.md §2.27).

import { runCli } from "./cli/index.ts";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  return runCli(argv);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`passh: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
