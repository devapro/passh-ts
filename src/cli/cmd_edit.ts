// `passh edit <path> [--editor]` (cli.md §2.8): the built-in entry form (tui.md §11.7) or the
// entry's text form in $EDITOR (agent-session.md §A6, spec §5.6, S1), then one save, with the
// reload-and-apply-again offer when the vault changed on disk meanwhile.

import { codedError, errorf, findError, hasCode, renderError, T } from "../i18n/index.ts";
import { SignalError, SIGNALS } from "../errors.ts";
import { formatEntryText, parseEntryText } from "../entrytext/index.ts";
import { editEntry, findEntryById, pairFields, type Entry, type EntryChange, type VaultData } from "../model/index.ts";
import { parsePath } from "../paths/index.ts";
import { escapeLine } from "../sanitize/index.ts";
import { askYesNo, type Tty } from "../tty/index.ts";
import { chooseEditor, editExternally, findTmpBase, type EditorChoice } from "../editor/index.ts";
import { runEntryForm } from "../tui/index.ts";
import { ttyConfirmOlder, type OpenedVault, withOpenHint } from "../vault/index.ts";
import type { Config } from "../config/index.ts";
import type { RunContext } from "./command.ts";
import { adoptTerminal, commandIO, configAndVault, defaultKeySources, lookupEntry, openForCommand, requireTerminal } from "./open.ts";

/** Save attempts in all, the first included (cli.md §2.8). */
const SAVE_ATTEMPTS = 3;

/** What an edit produced: the change to apply, by entry id. */
interface Edited {
  /** The edited values; `fields` only for `--editor` (the form doesn't edit custom fields). */
  change: EntryChange;
  /** The edited custom fields as typed (re-paired with the stored ones after a reload). */
  textFields?: Array<{ key: string; value: string }>;
}

/**
 * Ends passh by a signal that arrived at a prompt after the editor or the form ran: the
 * reference can't interrupt that read (the terminal was left in blocking mode) and re-raises
 * the signal (agent-session.md §A4), so it dies by it without a message.
 */
function dieBySignal(signal: string): never {
  const sig = signal as NodeJS.Signals;
  process.removeAllListeners(sig);
  try {
    process.kill(process.pid, sig);
  } catch {
    /* fall through */
  }
  process.exit(128 + (SIGNALS[signal] ?? 0));
}

function rethrowPromptSignal(e: unknown): never {
  const sig = findError(e, (x): x is SignalError => x instanceof SignalError);
  if (sig) dieBySignal(sig.signal);
  throw e;
}

/** The change an edited text makes (vault-format.md §5.2, §4.5 field pairing). */
function changeFromText(text: Uint8Array, stored: Entry): Edited {
  const c = parseEntryText(text);
  return {
    change: { password: c.password, username: c.username, url: c.url, tags: c.tags, fields: pairFields(stored.fields, c.fields), notes: c.notes },
    textFields: c.fields.map((f) => ({ key: f.key, value: f.value })),
  };
}

/** `--editor`: the text form in the external editor; null for "No change.". */
async function editInEditor(tty: Tty, editor: EditorChoice, base: string, data: VaultData, entry: Entry): Promise<Edited | null> {
  let result: Edited | undefined;
  const out = await editExternally<Edited>({
    tty,
    editor,
    base,
    text: new TextEncoder().encode(formatEntryText(entry)),
    validate: (b) => {
      try {
        const ed = changeFromText(b, entry);
        const r = editEntry(data, entry.id, ed.change);
        result = ed;
        return { ok: true, value: ed, unchanged: !r.changed };
      } catch (e) {
        return { ok: false, error: e };
      }
    },
  }).catch((e: unknown) => {
    if (findError(e, (x): x is SignalError => x instanceof SignalError)) rethrowPromptSignal(e);
    throw errorf("nothing was saved: %w", e);
  });
  if (out.kind === "unchanged") return null;
  return out.value ?? result ?? null;
}

/** The built-in form (tui.md §11.7); null for "No change.". */
async function editInForm(path: string, data: VaultData, entry: Entry): Promise<Edited | null> {
  const r = await runEntryForm({
    title: T("edit %s", path),
    original: { password: entry.password, username: entry.username, url: entry.url, tags: [...entry.tags], notes: entry.notes },
    fieldKeys: entry.fields.map((f) => f.key),
  });
  // SPEC-GAP: cli.md §2.8 lists a signal among the failures (`nothing was saved: <error>`); the
  // reference ends the form on SIGTERM or SIGINT as a cancel (`cancelled; nothing was saved`,
  // exit 1) and dies by SIGHUP (129, no message). Reproduced.
  if (r.kind === "signal" && r.signal === "SIGHUP") dieBySignal(r.signal);
  if (r.kind === "cancel" || r.kind === "signal") throw codedError("cancelled", "cancelled; nothing was saved");
  const change: EntryChange = { password: r.values.password, username: r.values.username, url: r.values.url, tags: r.values.tags, notes: r.values.notes };
  return editEntry(data, entry.id, change).changed ? { change } : null;
}

/**
 * Saves the edit (cli.md §2.8). A vault changed on disk asks `The vault changed on disk since
 * it was opened; reload and apply your edit again? [y/N] `: yes reloads, finds the entry by id
 * under its current path and applies the edited values again (3 save attempts in all); no →
 * `not saved: the vault changed on disk since it was opened`; the entry gone → `not saved:
 * <path> was deleted or replaced in the vault on disk`.
 */
async function saveEdit(v: OpenedVault, cfg: Config, tty: Tty, entry: Entry, ed: Edited): Promise<{ v: OpenedVault; unchanged: boolean }> {
  let cur = v;
  let data = cur.data;
  for (let attempt = 1; ; attempt++) {
    const r = editEntry(data, entry.id, ed.change);
    if (!r.changed) return { v: cur, unchanged: true };
    try {
      await cur.save(r.data);
      return { v: cur, unchanged: false };
    } catch (e) {
      if (!hasCode(e, "changed") || attempt >= SAVE_ATTEMPTS) throw e;
    }
    let again: boolean;
    try {
      again = await askYesNo(tty, T("The vault changed on disk since it was opened; reload and apply your edit again?"), false);
    } catch (e) {
      rethrowPromptSignal(e);
    }
    if (!again) throw errorf("not saved: the vault changed on disk since it was opened");
    let next: OpenedVault;
    try {
      next = await cur.reload({ config: cfg, sources: defaultKeySources(commandIO, tty), rollback: "prompt", confirmOlder: ttyConfirmOlder(tty), io: commandIO });
    } catch (e) {
      throw withOpenHint(e);
    }
    cur.close();
    cur = next;
    data = cur.data;
    const now = findEntryById(data, entry.id);
    if (!now) throw errorf("not saved: %s was deleted or replaced in the vault on disk", escapeLine(entry.path));
    if (ed.textFields) ed.change = { ...ed.change, fields: pairFields(now.fields, ed.textFields) };
  }
}

/**
 * Order: path; terminal; with `--editor` the tmpfs base (none: note `passh: <reason>; using
 * the built-in form instead`, and the form is used) and the editor lookup (`$EDITOR: …`), both
 * before unlocking; config and vault file; key; entry. Results: `No change.` (exit 0),
 * `cancelled; nothing was saved`, `nothing was saved: <error>`, or `Saved <path>.`.
 */
export async function runEdit(ctx: RunContext): Promise<void> {
  const path = parsePath(ctx.args[0]!);
  const tty = adoptTerminal(requireTerminal("edit"))!;
  let editor: { editor: EditorChoice; base: string } | undefined;
  if (ctx.flags.bool("editor")) {
    const b = findTmpBase();
    if (!b.ok) commandIO.note(T("%s; using the built-in form instead", renderError(b.error)));
    else editor = { editor: chooseEditor(), base: b.base };
  }
  const cfg = configAndVault(ctx);
  let v = await openForCommand(cfg, tty);
  try {
    const entry = lookupEntry(v.data, path);
    const ed = editor ? await editInEditor(tty, editor.editor, editor.base, v.data, entry) : await editInForm(path, v.data, entry);
    if (!ed) {
      commandIO.status(T("No change."));
      return;
    }
    const saved = await saveEdit(v, cfg, tty, entry, ed);
    v = saved.v;
    commandIO.status(saved.unchanged ? T("No change.") : T("Saved %s.", escapeLine(path)));
  } finally {
    v.close();
  }
}
