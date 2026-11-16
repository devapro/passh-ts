// PTY test driver for the external editor: chooses the editor from the environment, finds
// the tmpfs base, edits a fixed text and prints `RESULT <json>` on stdout, or `passh:
// <error>` on stderr with the CLI's exit status. Validation: the text must be UTF-8 and
// must not contain "INVALID"; "SAME" counts as an entry equal to the old one.
// Usage: bun run edit-driver.ts [text]

import { exitCodeOf } from "../../errors.ts";
import { errorf, renderError } from "../../i18n/index.ts";
import { escapeMultiline } from "../../sanitize/index.ts";
import { openTty } from "../../tty/index.ts";
import { decodeUTF8Strict } from "../../util/unicode.ts";
import { chooseEditor, editExternally, findTmpBase } from "../index.ts";

async function main(): Promise<unknown> {
  const tty = openTty();
  if (!tty) throw errorf("passh edit needs a terminal (over SSH: use `ssh -t`)");
  const editor = chooseEditor();
  const base = findTmpBase();
  if (!base.ok) {
    process.stderr.write("passh: " + escapeMultiline(renderError(base.error)) + "; using the built-in form instead\n");
    return { builtin: true };
  }
  const text = new TextEncoder().encode(process.argv[2] ?? "secret\nusername: alice\n");
  const out = await editExternally({
    tty,
    editor,
    base: base.base,
    text,
    validate: (b) => {
      const s = decodeUTF8Strict(b);
      if (s === undefined) return { ok: false, error: errorf("line 1: the text is not valid UTF-8") };
      if (s.includes("INVALID")) return { ok: false, error: errorf("line 2: invalid entry") };
      return { ok: true, value: s, unchanged: s.includes("SAME") };
    },
  });
  tty.close();
  return out.kind === "changed" ? { kind: out.kind, value: out.value } : out;
}

try {
  const r = await main();
  process.stdout.write("RESULT " + JSON.stringify(r) + "\n");
  process.exit(0);
} catch (e) {
  process.stderr.write("passh: " + escapeMultiline(renderError(e)) + "\n");
  process.exit(exitCodeOf(e));
}
