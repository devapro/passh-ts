// `passh init [--vault file]` (cli.md §2.2, storage.md §2.5): a new vault, the config file if
// there is none, and the optional paper recovery sheet (print.md §5).

import { lstatSync } from "node:fs";
import { configFileText, defaultVaultFile, expandPath, loadConfig, tildePath, writeConfigFile, type Config } from "../config/index.ts";
import { errorf, renderError, T } from "../i18n/index.ts";
import { generateVaultKey, X25519Identity } from "../keys/index.ts";
import { isErrno, osError } from "../fsx/index.ts";
import { SignalError } from "../errors.ts";
import { askYesNo, confirmPhrase, readLine, type Tty } from "../tty/index.ts";
import { escapeLine } from "../sanitize/index.ts";
import { checkOutputFree, defaultRecoverySheetPath, recoverySheetText, writeRecoverySheet } from "../print/index.ts";
import { createVault } from "../vault/index.ts";
import type { RunContext } from "./command.ts";
import { adoptTerminal, commandIO, needsTerminalError } from "./open.ts";
import { readNewPassphrase } from "./cmd_keys.ts";
import { openTty } from "../tty/index.ts";

/** Tries at `Write the text sheet to [<default>]: ` (cli.md §2.2 step 8). */
const SHEET_PATH_TRIES = 3;

/**
 * Step 1 (storage.md §2.5): the config, located as usual; an existing file must be valid and,
 * unlike for other commands, must have `vault` even with `--vault` (the reference reports
 * `vault is required, …` then). A missing file gives the defaults. `--vault` is expanded first.
 */
// SPEC-GAP: storage.md §2.5 step 1 says a config without `vault` fails only "when `--vault`
// isn't given"; the reference refuses it with `--vault` too. Reproduced.
function initConfig(ctx: RunContext): { cfg: Config; flagVault: string | undefined } {
  let flagVault: string | undefined;
  if (ctx.global.vault) {
    try {
      flagVault = expandPath(ctx.global.vault);
    } catch (e) {
      throw errorf("--vault: %w", e);
    }
  }
  const cfg = loadConfig({ configFlag: ctx.global.config, allowMissing: true });
  return { cfg, flagVault };
}

/** Step 3: anything at the target, even a dangling symlink, stops init. */
function checkTargetFree(target: string): void {
  try {
    lstatSync(target);
  } catch (e) {
    if (isErrno(e, "ENOENT")) return;
    // SPEC-GAP: cli.md §2.2 step 3 gives no text for an lstat error other than ENOENT; the OS error.
    throw osError("lstat", target, e);
  }
  throw errorf("%s already exists; passh init doesn't overwrite a vault", escapeLine(tildePath(target)));
}

/**
 * Step 8, yes: `Write the text sheet to [<default>]: ` (an existing file: the error, asked
 * again, 3 tries), `Type PRINT RECOVERY KEY to confirm: `, the sheet written as `-o` files are.
 */
async function printSheet(tty: Tty, key: string, vaultId: string): Promise<void> {
  const def = defaultRecoverySheetPath();
  let abs = "";
  for (let i = 0; ; i++) {
    const ans = await readLine(tty, T("Write the text sheet to [%s]: ", def));
    // SPEC-GAP: end of input at this prompt isn't specified; it takes the default, as an empty answer.
    const given = ans === null || ans.trim() === "" ? def : ans;
    try {
      abs = expandPath(given);
      checkOutputFree(abs);
      break;
    } catch (e) {
      if (i + 1 >= SHEET_PATH_TRIES) throw e;
      tty.say(renderError(e));
    }
  }
  await confirmPhrase(tty, "PRINT RECOVERY KEY");
  writeRecoverySheet(abs, recoverySheetText(key, vaultId, new Date()), commandIO);
  commandIO.status(T("For a version with the key as a QR code: passh recovery-key print --web"));
}

/**
 * Order (cli.md §2.2): the config (an existing one must be valid); the target (`--vault`, the
 * config's `vault`, `<data folder>/vault.passh`); nothing may be there; a terminal; the
 * explanation and the new passphrase pair; the vault; the config file; the recovery sheet.
 */
export async function runInit(ctx: RunContext): Promise<void> {
  const { cfg, flagVault } = initConfig(ctx);
  const target = flagVault ?? (cfg.vault !== "" ? cfg.vault : defaultVaultFile());
  checkTargetFree(target);
  const tty = adoptTerminal(openTty());
  if (!tty) throw needsTerminalError("init");
  const shown = escapeLine(tildePath(target));
  tty.say(T("Creating the vault %s.", shown));
  tty.say(T("Choose a passphrase: 6 or more random words are best."));
  const pass = await readNewPassphrase(tty);
  const identity = generateVaultKey();
  let vaultId: string;
  try {
    // createVault keeps the identity it gets and close() wipes it: give it a copy.
    const v = await createVault(target, { config: cfg, io: commandIO, identity: X25519Identity.fromBytes(identity.secretBytes()), passphrase: pass });
    vaultId = v.data.vaultId;
    v.close();
  } finally {
    pass.fill(0);
  }
  commandIO.status(T("Created the vault %s.", shown));

  // Step 7: the config file.
  if (!cfg.file) {
    try {
      if (!cfg.location) throw errorf("$HOME is not set");
      writeConfigFile(cfg.location.path, configFileText(target));
    } catch (e) {
      identity.wipe();
      throw errorf("the vault was created, but the config file wasn't: %w", e);
    }
    commandIO.status(T("Wrote the config file %s.", escapeLine(tildePath(cfg.location.path))));
  } else {
    const named = cfg.vault;
    if (named !== "" && named !== target) {
      commandIO.status(T("The config file %s exists and wasn't changed; it names the vault %s.", escapeLine(tildePath(cfg.file)), escapeLine(tildePath(named))));
      commandIO.status(T("Use --vault %s with each command, or change vault in the config file.", shown));
    }
  }

  // Step 8: the recovery sheet.
  let yes = false;
  try {
    yes = await askYesNo(tty, T("Print the recovery key now?"), true);
  } catch (e) {
    if (e instanceof SignalError) {
      identity.wipe();
      throw e;
    }
    // end of input or 3 answers not understood: no valid answer = no
    yes = false;
  }
  if (!yes) {
    identity.wipe();
    commandIO.status(T("Print the paper recovery key now and keep the sheet offline:"));
    commandIO.status(T("  passh recovery-key print -o <file>   (or --web, with the key as a QR code)"));
    commandIO.status(T("Without it, a forgotten passphrase means the data is lost."));
    return;
  }
  const key = identity.format();
  identity.wipe();
  try {
    await printSheet(tty, key, vaultId);
  } catch (e) {
    // A signal keeps its exit status 128 + n through the wrapping (exitCodeOf).
    throw errorf("the vault was created, but the recovery sheet wasn't written: %w; run `passh recovery-key print` later", e);
  }
}
