// `passh passwd`, `passh rekey` (cli.md §2.16) and `passh recover` (cli.md §2.18): a new key
// block (and for rekey a new vault key), one save, then the vault's agent is stopped
// (agent-session.md §A2.9).

import { hasCode, T } from "../i18n/index.ts";
import { generateVaultKey, KeyErrorCode, weakPassphraseWarning, wrapKeyBlock } from "../keys/index.ts";
import { tildePath } from "../config/index.ts";
import { errorf } from "../i18n/index.ts";
import { PASSPHRASE_PAIR, openTty, readSecretPair, type Tty } from "../tty/index.ts";
import { stopAgentAfterKeyChange } from "../agent/index.ts";
import { paperKeySource, passphraseKeySource, readPaperKey, recoverWrongKeyError } from "../vault/index.ts";
import { escapeLine } from "../sanitize/index.ts";
import type { RunContext } from "./command.ts";
import { adoptTerminal, commandIO, configAndVault, openForCommand, requireTerminal } from "./open.ts";

/**
 * The new passphrase (cli.md §1.6): `New passphrase: ` / `Repeat passphrase: ` in one raw-mode
 * stay, the strength warning between them (never a refusal), 3 attempts.
 */
export function readNewPassphrase(tty: Tty): Promise<Uint8Array> {
  return readSecretPair(tty, { texts: PASSPHRASE_PAIR, check: (p) => weakPassphraseWarning(p) ?? undefined });
}

function currentPassphraseTerminal(cmd: "passwd" | "rekey"): Tty {
  const tty = openTty();
  if (!tty) {
    throw errorf(
      "passh %s needs the current passphrase, typed on a terminal; the agent's key isn't enough to change the passphrase or the vault key (over SSH: `ssh -t host passh %s`)",
      cmd,
      cmd,
    );
  }
  return adoptTerminal(tty)!;
}

/**
 * `passwd` and `rekey`: terminal (also with an agent); `Current passphrase: ` (never the agent,
 * 3 tries, rollback question as usual); the explanation and the new pair; save (passwd: a new
 * wrap of the same key; rekey: a new key, the data re-encrypted to it); the status lines; the
 * agent stop.
 */
async function changeKey(ctx: RunContext, kind: "passwd" | "rekey"): Promise<void> {
  const tty = currentPassphraseTerminal(kind);
  const cfg = configAndVault(ctx);
  const v = await openForCommand(cfg, tty, { sources: [passphraseKeySource(tty, { prompt: "Current passphrase: " })] });
  let real: string;
  try {
    tty.say(kind === "passwd" ? T("Choose the new passphrase.") : T("Choose the passphrase for the new vault key (it may be the same as before)."));
    const pass = await readNewPassphrase(tty);
    try {
      if (kind === "passwd") {
        await v.save(v.data, { keyBlock: await wrapKeyBlock(v.identity(), pass) });
      } else {
        const identity = generateVaultKey();
        await v.save(v.data, { keyBlock: await wrapKeyBlock(identity, pass), identity });
      }
    } finally {
      pass.fill(0);
    }
    real = v.realPath;
  } finally {
    v.close();
  }
  if (kind === "passwd") {
    commandIO.status(T("Passphrase changed. The paper recovery key stays valid."));
    commandIO.status(T("Copies and backups made before still open with the old passphrase."));
  } else {
    commandIO.status(T("The vault has a new key. The old passphrase and the old paper recovery key"));
    commandIO.status(T("no longer open new versions of it; copies made before still open with them."));
    commandIO.status(T("Print a new paper recovery key now: passh recovery-key print"));
  }
  await stopAgentAfterKeyChange(real, commandIO, kind);
}

export function runPasswd(ctx: RunContext): Promise<void> {
  return changeKey(ctx, "passwd");
}

export function runRekey(ctx: RunContext): Promise<void> {
  return changeKey(ctx, "rekey");
}

/**
 * `recover`: terminal; config and vault file; the paper key (masked lines, 3 tries); the open
 * with that key only (a key block too damaged to parse is accepted; rollback question as
 * usual; a key that doesn't open the data block: `this recovery key doesn't open <file>: …`);
 * `The recovery key opens the vault. Choose a new passphrase.`, the new pair; a new key block
 * (same vault key); `New passphrase set for <file>. …`; the agent stop.
 */
export async function runRecover(ctx: RunContext): Promise<void> {
  const tty = adoptTerminal(requireTerminal("recover"))!;
  const cfg = configAndVault(ctx);
  const identity = await readPaperKey(tty);
  let v;
  try {
    v = await openForCommand(cfg, tty, { sources: [paperKeySource(identity)], recoveryMode: true });
  } catch (e) {
    if (hasCode(e, KeyErrorCode.WrongRecoveryKey)) throw recoverWrongKeyError(escapeLine(tildePath(cfg.vault)));
    throw e;
  } finally {
    identity.wipe();
  }
  let real: string;
  try {
    tty.say(T("The recovery key opens the vault. Choose a new passphrase."));
    const pass = await readNewPassphrase(tty);
    try {
      await v.save(v.data, { keyBlock: await wrapKeyBlock(v.identity(), pass) });
    } finally {
      pass.fill(0);
    }
    real = v.realPath;
  } finally {
    v.close();
  }
  commandIO.status(T("New passphrase set for %s. The paper recovery key stays valid.", escapeLine(tildePath(cfg.vault))));
  await stopAgentAfterKeyChange(real, commandIO, "recover");
}
