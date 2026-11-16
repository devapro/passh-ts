// A child process for the PTY tests of the CLI key sources: opens a vault with the passphrase
// prompt (or the paper key), the rollback question on /dev/tty, and prints one RESULT line.
//
//   bun run open-driver.ts pass <vault>     passphraseKeySource(openTty())
//   bun run open-driver.ts paper <vault>    readPaperKey, then recovery mode with that key

import { defaultConfig } from "../../config/index.ts";
import { errorText } from "../../i18n/index.ts";
import { openTty } from "../../tty/index.ts";
import { captureIO } from "../../util/io.ts";
import { ttyConfirmOlder } from "../commands.ts";
import { withOpenHint } from "../errors.ts";
import { paperKeySource, passphraseKeySource, readPaperKey } from "../keysources.ts";
import { openVault } from "../open.ts";
import type { KeySource } from "../types.ts";

const [mode, vault] = process.argv.slice(2);
const config = defaultConfig();
config.vault = vault!;
const tty = openTty();
const io = captureIO();
try {
  let sources: KeySource[];
  if (mode === "paper") {
    if (!tty) throw new Error("no terminal");
    sources = [paperKeySource(await readPaperKey(tty))];
  } else {
    sources = [passphraseKeySource(tty)];
  }
  const v = await openVault(vault!, { config, io, rollback: "prompt", sources, confirmOlder: ttyConfirmOlder(tty), recoveryMode: mode === "paper" });
  console.log(`RESULT ok r${v.data.revision} ${JSON.stringify(io.err)}`);
  v.close();
} catch (e) {
  console.log(`RESULT err ${JSON.stringify(errorText(withOpenHint(e)))} ${JSON.stringify(io.err)}`);
}
tty?.close();
process.exit(0);
