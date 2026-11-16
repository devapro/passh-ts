// The commands that change entries without prompts for content: `passh generate` (cli.md
// §2.9, import-export.md §3.3), `passh mv` (§2.10), `passh rm` (§2.11), `passh tag` (§2.12).
// Each change is one save (spec §4.6); arguments and flags are checked before unlocking.

import { codedError, errorf, T, TN } from "../i18n/index.ts";
import { UsageError } from "../errors.ts";
import { addEntry, editTags, emptyContent, findEntry, moveEntry, moveFolder, removeEntry, setPassword } from "../model/index.ts";
import { moveDestination, parsePath } from "../paths/index.ts";
import { escapeLine } from "../sanitize/index.ts";
import { DEFAULT_LENGTH, generatePassword, parseLength, shellQuote, strengthBits } from "../gen/index.ts";
import { askYesNo } from "../tty/index.ts";
import type { RunContext } from "./command.ts";
import { commandIO, commandTerminal, configAndVault, lookupEntry, openForCommand, withVault } from "./open.ts";

/**
 * `generate <path> [len] [--symbols] [-f]` (import-export.md §3.3): path, then `len` (a usage
 * error), then the key; an existing path needs `--force` (then only the password changes).
 * The password is never printed; stderr gets the two lines of §3.3.
 */
export async function runGenerate(ctx: RunContext): Promise<void> {
  const path = parsePath(ctx.args[0]!);
  const length = ctx.args.length > 1 ? parseLength(ctx.args[1]!) : DEFAULT_LENGTH;
  const symbols = ctx.flags.bool("symbols");
  const force = ctx.flags.bool("force");
  const replaced = await withVault(ctx, async (v) => {
    const old = findEntry(v.data, path);
    if (old && !force) throw errorf("%s already exists: use --force to replace its password (its other values are kept)", escapeLine(path));
    const password = generatePassword(length, symbols);
    const r = old ? setPassword(v.data, path, password) : addEntry(v.data, path, { ...emptyContent(), password });
    if (r.changed) await v.save(r.data);
    return old !== undefined;
  });
  const kind = symbols ? T("letters, digits and symbols") : T("letters and digits");
  const bits = strengthBits(length, symbols);
  commandIO.status(
    replaced
      ? T("Replaced the password of %s: a new %d-character password (%s, %d bits).", escapeLine(path), length, kind, bits)
      : T("Stored %s: a new %d-character password (%s, %d bits).", escapeLine(path), length, kind, bits),
  );
  commandIO.status(T("Show it with: passh show %s --field password", shellQuote(path)));
}

/**
 * `mv <src> <dst>` (cli.md §2.10): `<src>` validated as it is; a `<dst>` ending in `/` means
 * "into that folder". An entry named `<src>` moves (`Moved <src> to <dst>.`); else the folder
 * `<src>` moves with everything in it (`Moved the folder <src>/ to <dst>/ (<n> entries).`).
 */
export async function runMv(ctx: RunContext): Promise<void> {
  const src = parsePath(ctx.args[0]!);
  const dst = moveDestination(src, ctx.args[1]!);
  const msg = await withVault(ctx, async (v) => {
    if (findEntry(v.data, src)) {
      const r = moveEntry(v.data, src, dst);
      await v.save(r.data);
      return T("Moved %s to %s.", escapeLine(src), escapeLine(dst));
    }
    // The model's errors (`<path>: not found`, `<path>: already exists`, `can't move the folder
    // <src> into itself`) carry raw paths; a path holds no line break or TAB, so the S4
    // multi-line form of the error line escapes them as the single-line form would.
    const r = moveFolder(v.data, src, dst);
    await v.save(r.data);
    return TN(r.moved, "Moved the folder %s/ to %s/ (%d entry).", "Moved the folder %s/ to %s/ (%d entries).", escapeLine(src), escapeLine(dst), r.moved);
  });
  commandIO.status(msg);
}

/**
 * `rm <path> [-f]` (cli.md §2.11): path; a terminal unless `--force` (`passh rm asks for
 * confirmation on a terminal: run it in one, or add --force`); key; entry; `Delete <path>?
 * [y/N] ` (no or empty → `not deleted`); a tombstone; `Deleted <path>.`.
 */
// SPEC-GAP: cli.md §2.11 lists "terminal unless --force" after the path; the reference checks it
// before the config too (no config + no terminal → the terminal error). Reproduced.
export async function runRm(ctx: RunContext): Promise<void> {
  const path = parsePath(ctx.args[0]!);
  const force = ctx.flags.bool("force");
  const tty = commandTerminal();
  if (!force && !tty) throw errorf("passh rm asks for confirmation on a terminal: run it in one, or add --force");
  const cfg = configAndVault(ctx);
  const v = await openForCommand(cfg, tty);
  try {
    lookupEntry(v.data, path);
    if (!force && !(await askYesNo(tty!, T("Delete %s?", escapeLine(path)), false))) throw codedError("not-deleted", "not deleted");
    const r = removeEntry(v.data, path);
    await v.save(r.data);
  } finally {
    v.close();
  }
  commandIO.status(T("Deleted %s.", escapeLine(path)));
}

/**
 * `tag <path> [--add t]… [--remove t]…` (cli.md §2.12): neither flag (or only empty values) is
 * a usage error, checked first; tags are normalized after unlocking, as the reference does;
 * removal after addition; nothing is saved when unchanged.
 */
// SPEC-GAP: cli.md §2.12 doesn't say when the tag values are checked; the reference checks them
// after unlocking and after the entry lookup (`tag nope --add ,` → `nope: not found`; without a
// terminal or agent `vault is locked` comes first). "Neither flag" is judged on the values:
// `--remove ""` adds nothing, so it is the usage error, which comes before the path check.
export async function runTag(ctx: RunContext): Promise<void> {
  const add = ctx.flags.strings("add");
  const remove = ctx.flags.strings("remove");
  if (add.length === 0 && remove.length === 0) throw new UsageError("give --add and/or --remove");
  const path = parsePath(ctx.args[0]!);
  const { tags, changed } = await withVault(ctx, async (v) => {
    lookupEntry(v.data, path);
    const r = editTags(v.data, path, add, remove);
    if (r.changed) await v.save(r.data);
    return { tags: r.tags, changed: r.changed };
  });
  const p = escapeLine(path);
  if (tags.length === 0) commandIO.status(changed ? T("%s: no tags", p) : T("%s: no tags (unchanged)", p));
  else {
    const list = tags.map((t) => escapeLine(t)).join(", ");
    commandIO.status(changed ? T("%s: tags %s", p, list) : T("%s: tags %s (unchanged)", p, list));
  }
}
