// `passh add <path> [-f|--force]` (cli.md §2.7): the entry typed at prompts on /dev/tty.

import { T } from "../i18n/index.ts";
import { addEntry, findEntry, type EntryContent } from "../model/index.ts";
import { parsePath, parseTagList } from "../paths/index.ts";
import { escapeLine } from "../sanitize/index.ts";
import { DEFAULT_LENGTH, generatePassword } from "../gen/index.ts";
import { PASSWORD_PAIR, readLineBytes, readSecretPair, type Tty } from "../tty/index.ts";
import { errorf } from "../i18n/index.ts";
import { decodeUTF8Lossy, isValidUTF8 } from "../util/unicode.ts";
import { renderError } from "../i18n/index.ts";
import type { RunContext } from "./command.ts";
import { adoptTerminal, commandIO, configAndVault, openForCommand, requireTerminal } from "./open.ts";

/** Tries at the tags prompt (cli.md §2.7 step 3). */
const TAG_TRIES = 3;

/**
 * Typed bytes as text. Bytes that aren't valid UTF-8 can't be stored (vault-format.md §4.3):
 * the text then carries a lone surrogate, so the entry's content check after the prompts
 * fails with `invalid entry: <name> is not valid UTF-8`, as the reference does, and nothing is
 * saved.
 */
function typedText(b: Uint8Array): string {
  return isValidUTF8(b) ? decodeUTF8Lossy(b) : decodeUTF8Lossy(b) + "\ud800";
}

/** A cooked line as text; end of input is the empty line (cli.md §2.7 step 2). */
async function line(tty: Tty, prompt: string): Promise<string> {
  const b = await readLineBytes(tty, prompt);
  return b === null ? "" : typedText(b);
}

/**
 * `Tags (comma-separated): `: an invalid list prints its error and asks again; the third
 * invalid list ends the command with that error.
 */
async function readTags(tty: Tty): Promise<string[]> {
  for (let i = 0; ; i++) {
    const b = (await readLineBytes(tty, T("Tags (comma-separated): "))) ?? new Uint8Array(0);
    try {
      return parseTagList(b);
    } catch (e) {
      if (i + 1 >= TAG_TRIES) throw e;
      tty.say(renderError(e));
    }
  }
}

/** `Notes (end with an empty line):`, then lines until an empty line or end of input, joined with `\n`. */
async function readNotes(tty: Tty): Promise<string> {
  tty.say(T("Notes (end with an empty line):"));
  const lines: string[] = [];
  for (;;) {
    const b = await readLineBytes(tty, "");
    if (b === null || b.length === 0) break;
    lines.push(typedText(b));
  }
  return lines.join("\n");
}

/**
 * Order: path; terminal; key; an existing path without `--force` (``<path> already exists:
 * use --force to replace it``) before any prompt; then the prompts; one save. With `--force`
 * the typed content replaces the old content entirely (custom fields dropped); identical
 * content saves nothing but still says `Saved <path>.`. A changed vault on disk fails the
 * save with the input lost (audit #5: current behaviour kept).
 */
export async function runAdd(ctx: RunContext): Promise<void> {
  const path = parsePath(ctx.args[0]!);
  const force = ctx.flags.bool("force");
  const tty = adoptTerminal(requireTerminal("add"))!;
  const cfg = configAndVault(ctx);
  const v = await openForCommand(cfg, tty);
  let generated = false;
  try {
    if (findEntry(v.data, path) && !force) throw errorf("%s already exists: use --force to replace it", escapeLine(path));
    const pw = await readSecretPair(tty, { texts: PASSWORD_PAIR });
    let password: string;
    if (pw.length === 0) {
      password = generatePassword(DEFAULT_LENGTH);
      generated = true;
    } else {
      password = typedText(pw);
      pw.fill(0);
    }
    const content: EntryContent = {
      password,
      username: await line(tty, T("Username: ")),
      url: await line(tty, T("URL: ")),
      tags: await readTags(tty),
      fields: [],
      notes: await readNotes(tty),
    };
    const r = addEntry(v.data, path, content, { overwrite: force });
    if (r.changed) await v.save(r.data);
  } finally {
    v.close();
  }
  // SPEC-GAP: cli.md §2.7 doesn't say whether `Generated a 24-character password.` comes before
  // or after the save; it is printed with `Saved <path>.`, after a successful save.
  if (generated) commandIO.status(T("Generated a %d-character password.", DEFAULT_LENGTH));
  commandIO.status(T("Saved %s.", escapeLine(path)));
}
