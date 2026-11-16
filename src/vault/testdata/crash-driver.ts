// A child process for the fault-injection test (spec §13.2 safety test 9): saves one change
// and kills itself with SIGKILL at the named fault point. The vault key comes on stdin.
//
//   bun run crash-driver.ts <vault> <fault point>  < key

import { defaultConfig } from "../../config/index.ts";
import { X25519Identity } from "../../keys/index.ts";
import { addEntry, emptyContent } from "../../model/index.ts";
import { captureIO } from "../../util/io.ts";
import { vaultTestHooks, type FaultPoint } from "../hooks.ts";
import { identityKeySource } from "../keysources.ts";
import { openVault } from "../open.ts";

const [vault, point] = process.argv.slice(2) as [string, FaultPoint];
const key = (await new Response(Bun.stdin.stream()).text()).trim();
const id = X25519Identity.parse(key);
const config = defaultConfig();
config.vault = vault;
vaultTestHooks.point = (p) => {
  if (p === point) {
    process.stdout.write(`REACHED ${p}\n`);
    process.kill(process.pid, "SIGKILL");
  }
};
const v = await openVault(vault, { config, io: captureIO(), rollback: "report", sources: [identityKeySource(id, "passphrase")] });
await v.save(addEntry(v.data, `crash/${point}/${Date.now()}`, { ...emptyContent(), password: "p" }).data);
process.stdout.write("SAVED\n");
