// `passh print` (cli.md §2.24, print.md §1.1–§1.2) and `passh recovery-key print` (cli.md
// §2.17, print.md §1.3): the CLI wiring of src/print's command cores, with the adapters they
// need: the terminal (prompts and the print page dialog), stdout, stderr and the clipboard of
// the dialog's `c` key.

import { isatty } from "node:tty";
import type { Config } from "../config/index.ts";
import { chooseClipboard, Clipboard, NoClipboardError } from "../clipboard/index.ts";
import { runPrint, runRecoveryKeyPrint, type OpenEntries, type OpenKey, type PrintDeps, type PrintFlags, type PrintTty, type RecoveryKeyPrintFlags } from "../print/index.ts";
import type { DialogClipboard } from "../printweb/index.ts";
import { confirmPhrase, type Tty } from "../tty/index.ts";
import type { RunContext } from "./command.ts";
import { commandConfig, commandIO, commandTerminal, openForCommand, requireVaultFile } from "./open.ts";

/** The terminal as src/print and the dialog use it (cli.md §1.6: `Type <PHRASE> to confirm: `). */
export function printTty(tty: Tty): PrintTty {
  return {
    say: (text) => tty.say(text),
    confirm: (phrase) => confirmPhrase(tty, phrase),
    print: (text) => tty.print(text),
    writeRaw: (data) => tty.writeRaw(data),
    enterRawMode: () => tty.enterRawMode(),
    restoreMode: () => tty.restoreMode(),
    reader: () => tty.reader(),
  };
}

/**
 * The dialog's clipboard (print.md §6.9, agent-session.md §A5): the method is chosen at the
 * first `c` (clipboard.command, else OSC 52 through the terminal); `none` when there is no
 * clipboard, `failed` for an unusable command or a failed copy. Each copy schedules the clear
 * after clipboard.clear_after; `settle` clears at once when one is still pending.
 */
export function dialogClipboard(cfg: Config, tty: () => Tty | null = commandTerminal): DialogClipboard {
  let cb: Clipboard | undefined;
  return {
    async copy(text) {
      if (!cb) {
        try {
          cb = new Clipboard(chooseClipboard(cfg.clipboard, tty()), Number(cfg.clipboard.clearAfter / 1_000_000n));
        } catch (e) {
          return e instanceof NoClipboardError ? "none" : "failed";
        }
      }
      try {
        await cb.copy(text);
        return "copied";
      } catch {
        return "failed";
      }
    },
    async settle() {
      if (cb) await cb.clearNow();
    },
  };
}

/**
 * The dependencies of src/print for one command run. The config is loaded at print.md §1.1
 * step 7 (it must exist, or `--vault`); the vault file is checked only when the key is needed
 * (step 10), as on the reference.
 */
function printDeps(ctx: RunContext): { deps: PrintDeps; config: () => Config } {
  let cfg: Config | undefined;
  const config = () => (cfg ??= commandConfig(ctx));
  const deps: PrintDeps = {
    loadConfig: config,
    tty: () => {
      const t = commandTerminal();
      return t ? printTty(t) : null;
    },
    stdout: { isTerminal: isatty(1), write: (data) => commandIO.stdout(data) },
    status: (text) => commandIO.status(text),
    note: (text) => commandIO.note(text),
    warn: (text) => commandIO.warn(text),
    clipboard: (c) => dialogClipboard(c),
  };
  return { deps, config };
}

/** The value of a string flag, or undefined when it wasn't given. */
function given(ctx: RunContext, name: string): string | undefined {
  return ctx.flags.changed(name) ? ctx.flags.string(name) : undefined;
}

/**
 * `print [--tag t]… [--folder f] [--fields list] [-o file] [--confirm-plaintext]` and
 * `print --web …`: src/print's steps; the key through the usual chain (agent, passphrase,
 * rollback question); the vault is closed before the sheet is built and served.
 */
export async function runPrintCmd(ctx: RunContext): Promise<void> {
  const flags: PrintFlags = {
    format: given(ctx, "format"),
    web: ctx.flags.bool("web"),
    output: given(ctx, "output"),
    confirmPlaintext: ctx.flags.bool("confirm-plaintext"),
    folder: given(ctx, "folder"),
    tags: ctx.flags.strings("tag"),
    fields: given(ctx, "fields"),
  };
  const { deps, config } = printDeps(ctx);
  const open: OpenEntries = async () => {
    const cfg = config();
    requireVaultFile(cfg);
    const v = await openForCommand(cfg, commandTerminal());
    try {
      return v.data.entries;
    } finally {
      v.close();
    }
  };
  await runPrint(flags, deps, open);
}

/**
 * `recovery-key print [-o file] [--web]`: src/print's steps; the key through the usual chain
 * (the agent counts, print.md §1.3 step 3).
 */
export async function runRecoveryKeyPrintCmd(ctx: RunContext): Promise<void> {
  const flags: RecoveryKeyPrintFlags = { format: given(ctx, "format"), web: ctx.flags.bool("web"), output: given(ctx, "output") };
  const { deps, config } = printDeps(ctx);
  const open: OpenKey = async () => {
    const cfg = config();
    requireVaultFile(cfg);
    const v = await openForCommand(cfg, commandTerminal());
    try {
      return { key: v.identity().format(), vaultId: v.data.vaultId };
    } finally {
      v.close();
    }
  };
  await runRecoveryKeyPrint(flags, deps, open);
}
