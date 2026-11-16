// PTY test driver for `passh copy`'s flow: chooses the method from the arguments, copies
// a value, waits and clears, printing status lines on stderr like the CLI. Exit status as
// the CLI's. Usage: bun run copy-driver.ts <clearAfterMs> <osc52: 0|1> [command words…]

import { exitCodeOf } from "../../errors.ts";
import { renderError } from "../../i18n/index.ts";
import { escapeMultiline } from "../../sanitize/index.ts";
import { openTty } from "../../tty/index.ts";
import { chooseClipboard, Clipboard, copyAndWait } from "../index.ts";

const [clearAfter, osc52, ...command] = process.argv.slice(2);

try {
  const tty = openTty();
  const method = chooseClipboard({ command, osc52: osc52 === "1" }, tty, { path: "ok/x", field: "password" });
  const cb = new Clipboard(method, Number(clearAfter));
  await copyAndWait({
    clipboard: cb,
    value: new TextEncoder().encode(process.env.COPY_VALUE ?? "Pnzk"),
    field: "password",
    path: "ok/x",
    status: (line) => process.stderr.write(escapeMultiline(line) + "\n"),
  });
  process.exit(0);
} catch (e) {
  process.stderr.write("passh: " + escapeMultiline(renderError(e)) + "\n");
  process.exit(exitCodeOf(e));
}
