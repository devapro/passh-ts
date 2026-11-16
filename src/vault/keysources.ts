// Key sources of the CLI (spec §5.1, cli.md §1.5, §2.18; agent-session.md §A2.8): the
// passphrase prompt on /dev/tty, the paper recovery key, a key already in hand. The agent's
// source is src/agent's (it implements the same KeySource interface).

import { codedError, hasCode, T, type PasshError } from "../i18n/index.ts";
import { KeyErrorCode, parseRecoveryKey, unwrapKeyBlock, X25519Identity } from "../keys/index.ts";
import { readMaskedLines, readPassphrase, type ByteSource, type Tty } from "../tty/index.ts";
import { withPath } from "./errors.ts";
import { bytesEqual } from "./util.ts";
import type { KeyRequest, KeySource, KeySourceKind } from "./types.ts";

/** Passphrase tries (agent-session.md §A1). */
export const PASSPHRASE_TRIES = 3;

export interface PassphraseSourceOptions {
  /** The prompt's English text (translated when shown): `Passphrase: ` (default) or `Current passphrase: `. */
  prompt?: string;
  /** Tries (default 3). */
  tries?: number;
  /** Test hook: the byte source instead of the terminal. */
  source?: ByteSource;
}

/**
 * The passphrase on /dev/tty (cli.md §1.5): `Passphrase: `, up to 3 tries, `Wrong passphrase.
 * Try again.` before each retry. The error is that of the last try: `<abs>: wrong passphrase,
 * or the key block is damaged`, or, for a last empty passphrase, `passphrase is empty` without a
 * path. A work factor above 2^18 ends at the first try: `<abs>: key block asks for scrypt work
 * factor 2^N; …` (the CLI adds the hint line with withOpenHint). A key block that holds no single
 * vault key ends at once: `<abs>: the key block is damaged: it doesn't hold exactly one vault
 * key`. Prompt errors (`reading the passphrase: EOF`, `… interrupted`, signals) end at once.
 * Without a terminal (tty null), falls through (undefined).
 */
export function passphraseKeySource(tty: Tty | null | undefined, opts: PassphraseSourceOptions = {}): KeySource {
  return {
    kind: "passphrase",
    async getKey(req: KeyRequest): Promise<X25519Identity | undefined> {
      if (!tty) return undefined;
      const tries = opts.tries ?? PASSPHRASE_TRIES;
      let last: unknown;
      for (let i = 0; i < tries; i++) {
        if (i > 0) tty.say(T("Wrong passphrase. Try again."));
        const pass = await readPassphrase(tty, T(opts.prompt ?? "Passphrase: "), { source: opts.source });
        try {
          return await unwrapKeyBlock(req.keyBlock, pass);
        } catch (e) {
          if (hasCode(e, KeyErrorCode.EmptyPassphrase)) {
            last = e;
            continue;
          }
          if (hasCode(e, KeyErrorCode.WrongPassphrase)) {
            last = withPath(req.path, e);
            continue;
          }
          if (hasCode(e, KeyErrorCode.WorkFactor) || hasCode(e, KeyErrorCode.BadKeyBlock)) throw withPath(req.path, e);
          throw e;
        } finally {
          pass.fill(0);
        }
      }
      throw last;
    },
  };
}

/** A source that gives a key already in hand (a copy, so the caller's key survives a failed open). */
export function identityKeySource(identity: X25519Identity, kind: KeySourceKind): KeySource {
  return {
    kind,
    async getKey(): Promise<X25519Identity> {
      return X25519Identity.fromBytes(identity.secretBytes());
    },
  };
}

/**
 * The paper recovery key as a key source (`passh recover`, cli.md §2.18): the key typed with
 * readPaperKey before the open. Its kind "paper" makes a data block that doesn't open read
 * `<path>: this key doesn't open this vault (…)` (recover replaces it with recoverWrongKeyError).
 */
export function paperKeySource(identity: X25519Identity): KeySource {
  return identityKeySource(identity, "paper");
}

/**
 * The current key, tried first by a reload when the key block bytes are unchanged
 * (storage.md §3.3); a changed key block falls through to the other sources.
 */
export function currentKeySource(identity: X25519Identity, keyBlock: Uint8Array, kind: KeySourceKind): KeySource {
  return {
    kind,
    async getKey(req: KeyRequest): Promise<X25519Identity | undefined> {
      if (keyBlock.length === 0 || !bytesEqual(req.keyBlock, keyBlock)) return undefined;
      return X25519Identity.fromBytes(identity.secretBytes());
    },
  };
}

export interface PaperKeyOptions {
  tries?: number;
  source?: ByteSource;
}

/**
 * Reads the paper recovery key on /dev/tty (cli.md §2.18 step 2, vault-format.md §3.6):
 * `Type the recovery key from the paper sheet (AGE-SECRET-KEY-1…); it shows as *.` and
 * `Spaces, line breaks and letter case don't matter. End with an empty line.`, then masked
 * lines with the prompt `> `. An invalid key: `<error>. Type it again.`, 3 tries (the third
 * error ends the command); empty input fails at once (`not a valid recovery key: nothing was
 * typed`).
 */
// SPEC-GAP: the reference reads the paper key before opening the file (so before the container
// check and its warnings); `recover` calls readPaperKey, then openVault with paperKeySource.
export async function readPaperKey(tty: Tty, opts: PaperKeyOptions = {}): Promise<X25519Identity> {
  const tries = opts.tries ?? PASSPHRASE_TRIES;
  tty.say(T("Type the recovery key from the paper sheet (AGE-SECRET-KEY-1…); it shows as *."));
  tty.say(T("Spaces, line breaks and letter case don't matter. End with an empty line."));
  for (let i = 0; ; i++) {
    const typed = await readMaskedLines(tty, { prompt: "> ", source: opts.source });
    try {
      return parseRecoveryKey(typed);
    } catch (e) {
      if (hasCode(e, KeyErrorCode.RecoveryKeyEmpty) || i + 1 >= tries) throw e;
      tty.say(T("%v. Type it again.", e));
    } finally {
      typed.fill(0);
    }
  }
}

/**
 * `this recovery key doesn't open <~path>: it belongs to another vault, or the vault was rekeyed
 * after the sheet was printed` (cli.md §2.18 step 3), code wrong-recovery-key: what `passh
 * recover` prints instead of the generic paper-key error of openVault.
 */
export function recoverWrongKeyError(tildePath: string): PasshError {
  return codedError(
    KeyErrorCode.WrongRecoveryKey,
    "this recovery key doesn't open %s: it belongs to another vault, or the vault was rekeyed after the sheet was printed",
    tildePath,
  );
}
