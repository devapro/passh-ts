// `passh show <path> [--field f] [--raw]` (cli.md §2.5) and `passh copy <path> [--field f]`
// (cli.md §2.6, agent-session.md §A5).

import { errorf } from "../i18n/index.ts";
import { formatEntryText } from "../entrytext/index.ts";
import { fieldValue, type Entry } from "../model/index.ts";
import { parsePath } from "../paths/index.ts";
import { escapeLine, escapeMultiline } from "../sanitize/index.ts";
import { chooseClipboard, Clipboard, copyAndWait } from "../clipboard/index.ts";
import { nsToMs } from "../util/duration.ts";
import type { RunContext } from "./command.ts";
import { commandConfig, commandIO, commandTerminal, lookupEntry, openForCommand, requireVaultFile } from "./open.ts";

/** `<path> has no field "<f>"` (cli.md §1.8). */
function noFieldError(path: string, field: string) {
  return errorf("%s has no field %q", escapeLine(path), field);
}

/** A field's value (cli.md §1.8), or the `has no field` error. */
export function entryField(e: Entry, path: string, field: string): string {
  const v = fieldValue(e, field);
  if (v === undefined) throw noFieldError(path, field);
  return v;
}

/**
 * `show`: the text form escaped with S4 (multi-line) on any stdout, exact bytes with `--raw`;
 * `--field f`: the value escaped and `\n` on a terminal, the exact value without a final
 * newline otherwise (or with `--raw`). `--field ""` asks for a custom field with an empty key.
 */
export async function runShow(ctx: RunContext): Promise<void> {
  const path = parsePath(ctx.args[0]!);
  const raw = ctx.flags.bool("raw");
  const field = ctx.flags.changed("field") ? (ctx.flags.string("field") ?? "") : undefined;
  const cfg = commandConfig(ctx);
  requireVaultFile(cfg);
  const v = await openForCommand(cfg, commandTerminal());
  let out: string;
  try {
    const e = lookupEntry(v.data, path);
    if (field !== undefined) {
      const value = entryField(e, path, field);
      out = raw || !commandIO.stdoutIsTerminal() ? value : escapeMultiline(value) + "\n";
    } else {
      const text = formatEntryText(e);
      out = raw ? text : escapeMultiline(text);
    }
  } finally {
    v.close();
  }
  commandIO.stdout(out);
}

/**
 * `copy`: path; config; the clipboard method, before unlocking (none: `no clipboard: <reason>;
 * copy with: passh show <path> --field <field> | pbcopy`); key; entry and field (an empty
 * value: `<path>: the <field> is empty; nothing was copied`). The vault is closed before the
 * wait; then the copy, `Copied the <field> of <path> (<method>); …`, the clear and
 * `Clipboard cleared.` (a signal clears at once, exit 0).
 */
export async function runCopy(ctx: RunContext): Promise<void> {
  const path = parsePath(ctx.args[0]!);
  const field = ctx.flags.string("field") ?? "password";
  const cfg = commandConfig(ctx);
  const tty = commandTerminal();
  // SPEC-GAP: agent-session.md §A5 names `--field <field>` in the hint; for an empty field name
  // the reference shows `--field password` (SPEC-GAPS #41), and so do we.
  const method = chooseClipboard(cfg.clipboard, tty, { path: ctx.args[0]!, field: field === "" ? "password" : field });
  // SPEC-GAP: cli.md §1.2 puts the vault-exists check with the config; the reference checks the
  // clipboard method first (`copy x --vault /missing` without a terminal → `no clipboard: …`).
  requireVaultFile(cfg);
  const v = await openForCommand(cfg, tty);
  let value: string;
  try {
    const e = lookupEntry(v.data, path);
    value = entryField(e, path, field);
    if (value === "") throw errorf("%s: the %s is empty; nothing was copied", escapeLine(path), escapeLine(field));
  } finally {
    v.close();
  }
  await copyAndWait({
    clipboard: new Clipboard(method, nsToMs(cfg.clipboard.clearAfter)),
    value: new TextEncoder().encode(value),
    field: escapeLine(field),
    path: escapeLine(path),
    status: (line) => commandIO.status(line),
  });
}
