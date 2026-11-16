// `passh verify [file] [--full]` (cli.md §2.19, storage.md §6.2), `passh backup <dest>`
// (cli.md §2.20, storage.md §6.1) and `passh backups` (cli.md §2.21, storage.md §5.4): the
// CLI wiring of src/vault's command cores.

import { defaultConfig, type Config } from "../config/index.ts";
import { hasCode } from "../i18n/index.ts";
import { verifyKeySource } from "../agent/index.ts";
import { passphraseKeySource, runBackup, runBackups, runVerify } from "../vault/index.ts";
import type { RunContext } from "./command.ts";
import { commandConfig, commandIO, commandTerminal, configAndVault } from "./open.ts";

/**
 * The config of `verify <file>` (cli.md §2.19): a config file that exists must be valid, and
 * one named by `--config` must exist; a missing config file found through `$PASSH_CONFIG` or
 * the default location gives the defaults (no vault). Other failures to locate it (`$HOME is
 * not set`) fail, as on the reference.
 *
 * Audit #10 (an invalid default config file fails `verify <file>`): current behaviour kept, as
 * cli.md §2.19 states it ("a config file that exists … must still be valid").
 */
function configForFile(ctx: RunContext): Config {
  try {
    return commandConfig(ctx);
  } catch (e) {
    if (hasCode(e, "no-config") && !ctx.global.config) return defaultConfig();
    throw e;
  }
}

/**
 * `verify [file] [--full]`: without `[file]` the configured vault (config required, the
 * vault must exist: `no vault at …`); with it, the file, and the config as configForFile.
 * `--full` asks the file's own agent, then the configured vault's (if another existing file),
 * then the passphrase on /dev/tty; never the rollback question.
 *
 * Audits #13 (the open repeats the lenient warnings as `passh: warning: <abs>: …`), #34 (a
 * damaged, newer or unreadable record reports `this machine hasn't seen this vault before`)
 * and #35 (the older-copy warning also with rollback.warn = false): current behaviour kept,
 * as src/vault's runVerify implements it.
 */
export async function runVerifyCmd(ctx: RunContext): Promise<void> {
  const file = ctx.args[0];
  const full = ctx.flags.bool("full");
  const cfg = file === undefined ? commandConfig(ctx) : configForFile(ctx);
  const sources = full ? [verifyKeySource(commandIO, cfg.vault === "" ? undefined : cfg.vault), passphraseKeySource(commandTerminal())] : undefined;
  await runVerify({ file, config: cfg, full, io: commandIO, sources });
}

/** `backup <dest>`: the configured vault (it must exist), copied, checked and read back. */
export async function runBackupCmd(ctx: RunContext): Promise<void> {
  const cfg = configAndVault(ctx);
  await runBackup({ source: cfg.vault, dest: ctx.args[0]!, io: commandIO });
}

/** `backups`: needs the config (or `--vault`), not the vault file, not the passphrase. */
export async function runBackupsCmd(ctx: RunContext): Promise<void> {
  const cfg = commandConfig(ctx);
  await runBackups({ config: cfg, vaultPath: cfg.vault, io: commandIO });
}
