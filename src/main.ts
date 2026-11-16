// passh entry point: hardening first (S7, agent-session.md §A8), the language before the
// command line is parsed (i18n.md §2), then the CLI or the agent child (cli.md §2.27).

import { runCli } from "./cli/index.ts";
import { disableCoreDumps } from "./harden/index.ts";
import { AGENT_COMMAND, chooseLanguage } from "./config/index.ts";
import { setLanguage, T } from "./i18n/index.ts";
import { warn } from "./cli/output.ts";
import "./i18n/catalogs.ts";

/**
 * The index of the hidden `__agent` command (cli.md §2.27), also after the global flags
 * (`passh --vault x __agent …` runs the agent child like the reference); -1 if absent.
 */
function agentCommandIndex(argv: string[]): number {
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--config" || a === "--vault") i += 2;
    else if (a.startsWith("--config=") || a.startsWith("--vault=")) i += 1;
    else break;
  }
  return argv[i] === AGENT_COMMAND ? i : -1;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const hardenError = disableCoreDumps();
  const agentAt = agentCommandIndex(argv);
  if (agentAt >= 0) {
    // The agent child loads no config and speaks English (i18n.md §2); it checks fd 3 itself.
    const { runAgentChild } = await import("./agent/index.ts");
    return runAgentChild(argv.slice(agentAt + 1));
  }
  setLanguage(chooseLanguage(argv, process.env));
  if (hardenError) warn(T("disabling core dumps: %s", hardenError));
  return runCli(argv);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`passh: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
