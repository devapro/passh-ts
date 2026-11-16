// `passh print` and `passh recovery-key print` (print.md §1, cli.md §2.17, §2.24): the order
// of checks, confirmation, unlock and output. The CLI parses the flags and passes their raw
// values; everything after parsing happens here, in the spec's order, against injected
// dependencies (config, terminal, vault, stdout, clock), so no command-line or TUI module
// is imported.

import type { Entry } from "../model/types.ts";
import type { Config } from "../config/config.ts";
import { stateDir, tildePath, type Env } from "../config/paths.ts";
import { T, TN, errorf, type PasshError } from "../i18n/index.ts";
import { UsageError } from "../errors.ts";
import { normalizeTag, parseFolder } from "../paths/index.ts";
import { runDialog, type DialogClipboard, type DialogTty } from "../printweb/dialog.ts";
import { startPrintPage, type PrintPage, type PrintPageResult, type PrintWebSettings } from "../printweb/server.ts";
import { parseFields } from "./fields.ts";
import { checkOutputFree, onTmpfs, outputPath, shellQuote, tmpfsWarning, writeNewOutput } from "./output.ts";
import { buildRecoverySheet } from "./recovery.ts";
import { buildPasswordSheet, type Sheet } from "./sheet.ts";
import { renderText } from "./text.ts";

/** The flags of `passh print` as parsed (raw values). */
export interface PrintFlags {
  /** The hidden, removed `--format`: set when given (any value). */
  format?: string;
  web: boolean;
  /** `-o`/`--output`, as typed (not expanded); undefined when not given. */
  output?: string;
  confirmPlaintext: boolean;
  /** `--folder`, undefined when not given. */
  folder?: string;
  /** `--tag` values after the strings-flag split (an empty value already dropped). */
  tags: readonly string[];
  /** `--fields`, undefined when not given. */
  fields?: string;
}

/** The flags of `passh recovery-key print`. */
export interface RecoveryKeyPrintFlags {
  format?: string;
  web: boolean;
  output?: string;
}

/** The terminal (src/tty's Tty, wrapped by the CLI): prompts and the dialog. */
export interface PrintTty extends DialogTty {
  /** A line for people on /dev/tty (an explanation before a prompt). */
  say(text: string): void;
  /**
   * `Type <PHRASE> to confirm: ` (cooked, one try, agent-session.md §A4): resolves when
   * the trimmed answer equals the phrase; throws `not confirmed: you didn't type <PHRASE>`
   * or `not confirmed: no answer` (end of input).
   */
  confirm(phrase: string): Promise<void>;
}

/** What the commands need from the CLI. */
export interface PrintDeps {
  /** Loads the config (cli.md §1.2); throws its errors. Called at print.md §1.1 step 7. */
  loadConfig(): Config;
  /** Opens /dev/tty; null when there is no terminal. The caller closes it after the command. */
  tty(): PrintTty | null;
  /** stdout (data only). */
  stdout: { isTerminal: boolean; write(data: Uint8Array): void | Promise<void> };
  /** stderr, the text alone (status, confirmations). */
  status(text: string): void;
  /** stderr, `passh: <text>`. */
  note(text: string): void;
  /** stderr, `passh: warning: <text>`. */
  warn(text: string): void;
  /** The clipboard for the print page dialog (`c`). */
  clipboard(config: Config): DialogClipboard;
  env?: Env;
  cwd?: string;
  now?: () => Date;
  /** `<state>` for the certificate; default from the environment (storage.md §1.1). */
  stateDir?: string;
}

/** Unlocks the vault (key chain of spec §5.1) and returns its entries; the vault is closed again by the caller's callback. */
export type OpenEntries = () => Promise<readonly Entry[]>;

/** Unlocks the vault and returns its key (`AGE-SECRET-KEY-1…`) and `vault_id`. */
export type OpenKey = () => Promise<{ key: string; vaultId: string }>;

const NEEDS_TERMINAL_WEB = "the print page needs a terminal (over SSH: use `ssh -t`)";

/** print.md §1.1 steps 1–6: flags, folder, tags, fields. Returns the normalized values. */
function checkPrintFlags(f: PrintFlags) {
  if (f.format !== undefined) throw new UsageError("PDF output was removed; use --web to print from a browser (it can save as PDF), or omit --format for the text sheet");
  if (f.web && f.output !== undefined) throw new UsageError("--output can't be used with --web");
  if (f.web && f.confirmPlaintext) throw new UsageError("--confirm-plaintext can't be used with --web: the print page needs a terminal");
  const folder = f.folder !== undefined ? parseFolder(f.folder) : "";
  const tags = f.tags.map((t) => normalizeTag(t));
  const fields = parseFields(f.fields);
  return { folder, tags, fields };
}

/** The `[print_web]` settings of a config. */
export function printWebSettings(c: Config): PrintWebSettings {
  return { enabled: c.printWeb.enabled, port: c.printWeb.port, interfaces: c.printWeb.interfaces, allowFrom: c.printWeb.allowFrom.map((x) => x.text), hostnames: c.printWeb.hostnames, ttl: c.printWeb.ttl };
}

function printPageOff(): PasshError {
  return errorf("the print page is off: set enabled = true in the [print_web] table of the config file");
}

/**
 * `passh print` without `--web` (print.md §1.1): checks, destination, confirmation, unlock,
 * sheet, write, then `passh: printed N entries (text sheet) to <dest>; …` on stderr.
 */
export async function runPrint(flags: PrintFlags, deps: PrintDeps, open: OpenEntries): Promise<void> {
  if (flags.web) return runPrintWeb(flags, deps, open);
  const env = deps.env ?? process.env;
  const { folder, tags, fields } = checkPrintFlags(flags);
  deps.loadConfig();
  // 8. destination
  let abs: string | undefined;
  if (flags.output !== undefined) {
    abs = outputPath(flags.output, env, deps.cwd);
    checkOutputFree(abs, env);
  } else if (deps.stdout.isTerminal) {
    throw errorf("refusing to write the sheet to a terminal: add -o file or redirect stdout");
  }
  // 9. confirmation (spec §7.1 rules)
  const tty = deps.tty();
  if (tty) {
    tty.say(T("The sheet holds your passwords unencrypted."));
    await tty.confirm("EXPORT PLAINTEXT");
  } else if (!flags.confirmPlaintext) {
    throw errorf("printing needs confirmation: without a terminal, add --confirm-plaintext");
  }
  // 10, 11. unlock, build
  const entries = await open();
  const sheet = buildPasswordSheet({ entries, folder, tags, fields, printedAt: (deps.now ?? (() => new Date()))() });
  // 12. render and write
  const data = new TextEncoder().encode(renderText(sheet));
  let dest: string;
  if (abs !== undefined) {
    writeNewOutput(abs, data, env);
    const w = tmpfsWarning(abs, env);
    if (w) deps.warn(w.localize());
    dest = tildePath(abs, env);
  } else {
    await deps.stdout.write(data);
    dest = "stdout";
  }
  // 13.
  deps.note(TN(sheet.count, "printed %d entry (text sheet) to %s; print it, then delete the file", "printed %d entries (text sheet) to %s; print it, then delete the file", sheet.count, dest));
}

/**
 * `passh print --web` (print.md §1.2): steps 1–7 of §1.1, `print_web.enabled`, a terminal,
 * `PRINT`, unlock and sheet, then the server and its dialog. Served → `Done: <result>.`;
 * any other end throws the result (exit 1).
 */
export async function runPrintWeb(flags: PrintFlags, deps: PrintDeps, open: OpenEntries): Promise<void> {
  const { folder, tags, fields } = checkPrintFlags({ ...flags, web: true });
  const config = deps.loadConfig();
  if (!config.printWeb.enabled) throw printPageOff();
  const tty = deps.tty();
  if (!tty) throw errorf(NEEDS_TERMINAL_WEB);
  await tty.confirm("PRINT");
  const entries = await open();
  const sheet = buildPasswordSheet({ entries, folder, tags, fields, printedAt: (deps.now ?? (() => new Date()))() });
  await serve(sheet, config, tty, deps);
}

/**
 * `passh recovery-key print [-o file] [--web]` (print.md §1.3, cli.md §2.17).
 */
export async function runRecoveryKeyPrint(flags: RecoveryKeyPrintFlags, deps: PrintDeps, open: OpenKey): Promise<void> {
  if (flags.format !== undefined) throw new UsageError("PDF output was removed; use --web to print from a browser (it can save as PDF), or omit --format for the text sheet");
  if (flags.web && flags.output !== undefined) throw new UsageError("--output can't be used with --web");
  const env = deps.env ?? process.env;
  const config = deps.loadConfig();
  const now = deps.now ?? (() => new Date());
  if (flags.web) {
    if (!config.printWeb.enabled) throw printPageOff();
    const tty = deps.tty();
    if (!tty) throw errorf(NEEDS_TERMINAL_WEB);
    await tty.confirm("PRINT RECOVERY KEY");
    const { key, vaultId } = await open();
    await serve(buildRecoverySheet({ key, vaultId, printedAt: now(), web: true }), config, tty, deps);
    return;
  }
  let abs: string | undefined;
  if (flags.output !== undefined) {
    abs = outputPath(flags.output, env, deps.cwd);
    checkOutputFree(abs, env);
  } else if (deps.stdout.isTerminal) {
    throw errorf("refusing to write the recovery key to a terminal: add -o file or redirect stdout");
  }
  const tty = deps.tty();
  if (!tty) throw errorf("passh %s needs a terminal (over SSH: use `ssh -t`)", "recovery-key print");
  await tty.confirm("PRINT RECOVERY KEY");
  const { key, vaultId } = await open();
  const data = new TextEncoder().encode(renderText(buildRecoverySheet({ key, vaultId, printedAt: now(), web: false })));
  if (abs !== undefined) {
    writeRecoverySheet(abs, data, deps, env);
  } else {
    await deps.stdout.write(data);
    deps.status(T("Wrote the paper recovery key to %s.", "stdout"));
  }
}

/**
 * Writes a recovery sheet to a new file and reports it (cli.md §2.17, also `passh init`):
 * the tmpfs warning, `Wrote the paper recovery key to <file>.` and `passh: print it, keep
 * the sheet offline, then delete the file: rm <path>` (absolute path, shell-quoted).
 */
export function writeRecoverySheet(abs: string, data: Uint8Array, deps: Pick<PrintDeps, "status" | "note" | "warn">, env: Env = process.env): void {
  writeNewOutput(abs, data, env);
  const w = tmpfsWarning(abs, env);
  if (w) deps.warn(w.localize());
  deps.status(T("Wrote the paper recovery key to %s.", tildePath(abs, env)));
  deps.note(T("print it, keep the sheet offline, then delete the file: rm %s", shellQuote(abs)));
}

/**
 * The default answer of `passh init`'s `Write the text sheet to [<default>]: ` (print.md
 * §1.3), as shown: `/dev/shm/passh-recovery.txt` if /dev/shm is tmpfs, else `~/passh-recovery.txt`.
 */
export function defaultRecoverySheetPath(): string {
  return onTmpfs("/dev/shm") ? "/dev/shm/passh-recovery.txt" : "~/passh-recovery.txt";
}

/** The recovery sheet's text for a key (for `passh init`, which asks for the file itself). */
export function recoverySheetText(key: string, vaultId: string, printedAt: Date): Uint8Array {
  return new TextEncoder().encode(renderText(buildRecoverySheet({ key, vaultId, printedAt, web: false })));
}

/** Starts the server for a sheet and runs the dialog (print.md §1.2 step 5). */
async function serve(sheet: Sheet, config: Config, tty: PrintTty, deps: PrintDeps): Promise<void> {
  const page: PrintPage = await startPrintPage({ sheet, settings: printWebSettings(config), stateDir: deps.stateDir ?? stateDir(deps.env ?? process.env) });
  const result: PrintPageResult = await runDialog(page, tty, deps.clipboard(config));
  if (result.outcome === "served") {
    deps.status(T("Done: %s.", result.message));
    return;
  }
  throw result.message;
}
