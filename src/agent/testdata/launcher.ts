// Test launcher for the agent child until src/main.ts dispatches `__agent`: run as
// `bun run src/agent/testdata/launcher.ts __agent --vault=… --idle-ttl=… --max-ttl=…`.
// Like main.ts: core dumps off first (S7), then the child (which never reads a config).

import { disableCoreDumps } from "../../harden/index.ts";
import { runAgentChild } from "../child.ts";

disableCoreDumps();
runAgentChild(process.argv.slice(2)).then(
  (code) => process.exit(code),
  () => process.exit(1),
);
