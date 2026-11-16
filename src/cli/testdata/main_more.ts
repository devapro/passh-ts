// Test entry: src/main.ts with RUNS_MORE merged into RUNS (until the lead merges them), for
// the side-by-side tests in test/cli/*_more.test.ts. The agent child is started through
// src/main.ts (src/exec selfCommand), which needs no run functions.

import { runCli } from "../index.ts";
import { RUNS } from "../runs.ts";
import { RUNS_MORE } from "../runs_more.ts";
import { disableCoreDumps } from "../../harden/index.ts";
import { AGENT_COMMAND, chooseLanguage } from "../../config/index.ts";
import { setLanguage, T } from "../../i18n/index.ts";
import { warn } from "../output.ts";
import "../../i18n/catalogs.ts";

Object.assign(RUNS, RUNS_MORE);

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const hardenError = disableCoreDumps();
  if (argv.includes(AGENT_COMMAND)) {
    const { runAgentChild } = await import("../../agent/index.ts");
    return runAgentChild(argv.slice(argv.indexOf(AGENT_COMMAND) + 1));
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
