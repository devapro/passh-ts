// What the entry and key commands share (cli.md §1.2, §1.5, §1.7, §1.8): loading the config
// with the global flags, the vault-exists check, the key sources (the vault's agent, then the
// passphrase on /dev/tty), the rollback question, the hint line after a damaged key block,
// looking up an entry (`not found`, `is a folder`), and the terminal errors.

import { loadConfig, tildePath, type Config } from "../config/index.ts";
import { codedError, errorf, type PasshError } from "../i18n/index.ts";
import { folderExists, isInFolder } from "../paths/index.ts";
import { findEntry, type Entry, type VaultData } from "../model/index.ts";
import { escapeLine } from "../sanitize/index.ts";
import { openTty, type Tty } from "../tty/index.ts";
import type { CommandIO } from "../util/io.ts";
import { agentKeySource } from "../agent/index.ts";
import { checkVaultExists, ttyConfirmOlder, withOpenHint, passphraseKeySource, openVault, type KeySource, type OpenedVault } from "../vault/index.ts";
import type { RunContext } from "./command.ts";
import { processIO } from "./io.ts";

/** The IO of a command run: the process streams (tests of the run functions may swap it). */
export let commandIO: CommandIO = processIO;

/** Replaces the IO (tests). Returns the previous one. */
export function setCommandIO(io: CommandIO): CommandIO {
  const prev = commandIO;
  commandIO = io;
  return prev;
}

/**
 * The config of a command (cli.md §1.2, storage.md §2.1): `--config`, `$PASSH_CONFIG` or the
 * default location; `--vault` replaces the file's `vault` and makes a missing file (except one
 * named by `--config`) the defaults.
 */
export function commandConfig(ctx: RunContext, opts: { allowMissing?: boolean } = {}): Config {
  return loadConfig({ configFlag: ctx.global.config, vaultFlag: ctx.global.vault, allowMissing: opts.allowMissing });
}

/**
 * The vault file must exist (cli.md §1.2): ``no vault at <file>: run `passh init` to create
 * one, or pass --vault <file>``; another `stat` error: `vault <file>: <OS error>`.
 */
export function requireVaultFile(cfg: Config): void {
  checkVaultExists(cfg.vault);
}

/** The config, then the vault-exists check (every command that uses the vault file). */
export function configAndVault(ctx: RunContext): Config {
  const cfg = commandConfig(ctx);
  requireVaultFile(cfg);
  return cfg;
}

/** ``passh <cmd> needs a terminal (over SSH: use `ssh -t`)`` (cli.md §1.7, agent-session.md §A4). */
export function needsTerminalError(cmd: string): PasshError {
  return errorf("passh %s needs a terminal (over SSH: use `ssh -t`)", cmd);
}

/** /dev/tty, or the `needs a terminal` error. */
export function requireTerminal(cmd: string): Tty {
  const tty = openTty();
  if (!tty) throw needsTerminalError(cmd);
  return tty;
}

/**
 * The terminal of this command run, opened once and closed at the end ({@link closeTerminal}).
 * null: no terminal (cli.md §1.7: "terminal" means /dev/tty opens and is a terminal).
 */
let terminal: Tty | null | undefined;

export function commandTerminal(): Tty | null {
  if (terminal === undefined) terminal = openTty();
  return terminal;
}

/** Sets the command's terminal (a Tty opened by the command itself). */
export function adoptTerminal(tty: Tty | null): Tty | null {
  terminal = tty;
  return tty;
}

/** Closes the command's terminal, if one was opened. */
export function closeTerminal(): void {
  terminal?.close();
  terminal = undefined;
}

/**
 * The key sources of cli.md §1.5 / agent-session.md §A2.8, in order: the vault's agent, then
 * (with a terminal) `Passphrase: ` on /dev/tty, up to 3 tries. Without either, openVault
 * fails with ``vault is locked: run `passh unlock` in a terminal …``.
 */
export function defaultKeySources(io: CommandIO, tty: Tty | null): KeySource[] {
  return [agentKeySource(io), passphraseKeySource(tty)];
}

export interface OpenForCommand {
  /** Default: the vault's agent, then the passphrase prompt. */
  sources?: KeySource[];
  /** `passh recover`: a damaged key block falls back to the last armored block. */
  recoveryMode?: boolean;
}

/**
 * Opens the configured vault with its key (cli.md §1.5): the key sources, the lenient-parse
 * warnings (once per command), the rollback question on /dev/tty (without a terminal a
 * warning, and the command goes on). A damaged key block or a refused work factor gets the
 * hint line of storage.md §3.1 under the error.
 */
export async function openForCommand(cfg: Config, tty: Tty | null, opts: OpenForCommand = {}): Promise<OpenedVault> {
  const io = commandIO;
  try {
    return await openVault(cfg.vault, {
      config: cfg,
      sources: opts.sources ?? defaultKeySources(io, tty),
      rollback: "prompt",
      confirmOlder: ttyConfirmOlder(tty),
      recoveryMode: opts.recoveryMode,
      io,
    });
  } catch (e) {
    throw withOpenHint(e);
  }
}

/**
 * Runs `body` with the opened vault and closes it afterwards (the key is wiped). The vault is
 * the configured one; config and vault-exists checks come first.
 */
export async function withVault<R>(ctx: RunContext, body: (v: OpenedVault, cfg: Config) => Promise<R> | R, opts: OpenForCommand & { tty?: Tty | null } = {}): Promise<R> {
  const cfg = configAndVault(ctx);
  const tty = opts.tty !== undefined ? opts.tty : commandTerminal();
  const v = await openForCommand(cfg, tty, opts);
  try {
    return await body(v, cfg);
  } finally {
    v.close();
  }
}

// ---------------------------------------------------------------------------
// Entries (cli.md §1.8)

/**
 * ``<path> is a folder, not an entry: list it with `passh ls <path>` `` (cli.md §1.8): the
 * path escaped single-line (it can't hold a line break, so the S4 multi-line form of stderr
 * doesn't change it).
 */
export function isFolderError(path: string): PasshError {
  const p = escapeLine(path);
  return errorf("%s is a folder, not an entry: list it with `passh ls %s`", p, p);
}

/** `<path>: not found` (code "not-found"). */
export function entryNotFound(path: string): PasshError {
  return codedError("not-found", "%s: not found", escapeLine(path));
}

/** The entry at a path, or the `is a folder` / `not found` error (cli.md §1.8). */
export function lookupEntry(data: VaultData, path: string): Entry {
  const e = findEntry(data, path);
  if (e) return e;
  if (folderExists(data.entries.map((x) => x.path), path)) throw isFolderError(path);
  throw entryNotFound(path);
}

/** Reports whether any entry lies inside a folder. */
export function anyInside(data: VaultData, folder: string): boolean {
  return data.entries.some((e) => isInFolder(e.path, folder));
}

/** `<~path>` of a file, escaped single-line (cli.md notation `<file>`). */
export function shownFile(abs: string): string {
  return escapeLine(tildePath(abs));
}
