// Errors of opening and saving (storage.md §3–§4, cli.md §1.5). Each has a stable code for
// hasCode(); the English text is the catalogue key.

import { codedError, errorf, T, type PasshError } from "../i18n/index.ts";

/** Codes of the errors below (and of the wrapped errors from lower layers that matter here). */
export const VaultErrorCode = {
  /** storage.md §4.2: the file changed since it was opened. */
  Changed: "changed",
  /** storage.md §4.2 step 1: the vault lock stayed busy for 15 s. */
  Busy: "busy",
  /** storage.md §4.2 step 1: the file is inside `<state>/backups/`. */
  InBackups: "in-backups",
  /** storage.md §4.2 step 0: recovery mode, no new key block. */
  KeyBlockDamaged: "key-block-damaged",
  /** spec §5.1: no key source gave a key. */
  Locked: "locked",
  /** storage.md §7.4: the user declined the rollback question. */
  RollbackDeclined: "rollback-declined",
  /** storage.md §4.6: init over an existing file. */
  Exists: "exists",
  /** storage.md §4.2: a cancelled save (TUI). */
  Cancelled: "cancelled",
  /** storage.md §2.6: no vault file. */
  NoVault: "no-vault",
  /** storage.md §3.2: the data block doesn't open or isn't valid (with the backups list). */
  DataDamaged: "data-damaged",
} as const;

/**
 * `vault changed on disk after it was opened (another passh, a sync tool or a copy); nothing
 * was saved: reload and repeat the change` (code "changed").
 */
export function errChanged(): PasshError {
  return codedError(
    VaultErrorCode.Changed,
    "vault changed on disk after it was opened (another passh, a sync tool or a copy); nothing was saved: reload and repeat the change",
  );
}

/** `vault is being saved by another passh process; nothing was saved: try again` (code "busy"). */
export function errBusy(cause?: unknown): PasshError {
  const e = codedError(VaultErrorCode.Busy, "vault is being saved by another passh process; nothing was saved: try again");
  if (cause !== undefined) (e as { cause?: unknown }).cause = cause;
  return e;
}

/** `this is an automatic backup: copy it out first (e.g. over the vault file) and open the copy`. */
export function errInBackups(): PasshError {
  return codedError(VaultErrorCode.InBackups, "this is an automatic backup: copy it out first (e.g. over the vault file) and open the copy");
}

/** `the key block is damaged: set a new passphrase first (passh recover)` (storage.md §4.2 step 0). */
export function errKeyBlockDamaged(): PasshError {
  return codedError(VaultErrorCode.KeyBlockDamaged, "the key block is damaged: set a new passphrase first (passh recover)");
}

/** ``vault is locked: run `passh unlock` in a terminal (over SSH: `ssh -t host passh unlock`)`` (spec §5.1). */
export function errLocked(): PasshError {
  return codedError(VaultErrorCode.Locked, "vault is locked: run `passh unlock` in a terminal (over SSH: `ssh -t host passh unlock`)");
}

/** `stopped: this copy is older than one seen before on this machine; nothing was changed` (§7.4). */
export function errRollbackDeclined(): PasshError {
  return codedError(VaultErrorCode.RollbackDeclined, "stopped: this copy is older than one seen before on this machine; nothing was changed");
}

/** `<path>: a file already exists there` (storage.md §4.6, init). */
export function errExists(path: string): PasshError {
  return codedError(VaultErrorCode.Exists, "%s: a file already exists there", path);
}

/**
 * A save stopped by its AbortSignal before step 2 or 3 (storage.md §4.2 last paragraph).
 * SPEC-GAP: the spec gives no text; the TUI words its own message from the code.
 */
export function errCancelled(): PasshError {
  return codedError(VaultErrorCode.Cancelled, "the save was cancelled; nothing was saved");
}

/** ``no vault at <~path>: run `passh init` to create one, or pass --vault <file>`` (storage.md §2.6). */
export function errNoVault(tilde: string): PasshError {
  return codedError(VaultErrorCode.NoVault, "no vault at %s: run `passh init` to create one, or pass --vault <file>", tilde);
}

/** `vault <~path>: <OS error>` (storage.md §2.6, a `stat` error other than ENOENT). */
export function errVaultStat(tilde: string, cause: unknown): PasshError {
  return errorf("vault %s: %w", tilde, cause);
}

/** `<path>: <error>`, keeping the error's code reachable through the cause chain. */
export function withPath(path: string, e: unknown): PasshError {
  return errorf("%s: %w", path, e);
}

/**
 * The hint line the CLI adds after a damaged key block (block 1) or a refused work factor
 * (storage.md §3.1, cli.md §1.5). Undefined for other errors.
 */
export function openHint(e: unknown): string | undefined {
  if (isWorkFactorError(e)) {
    return "The key block only protects the vault key with the passphrase: if the data block is intact, `passh recover` with the paper recovery key writes a new key block; or restore a backup (passh backups)";
  }
  if (isKeyBlockContainerDamage(e)) {
    return "The key block only protects the vault key with the passphrase: if the data block is intact, `passh recover` with the paper recovery key writes a new key block";
  }
  return undefined;
}

function chain(e: unknown): unknown[] {
  const out: unknown[] = [];
  for (let cur: unknown = e, d = 0; cur && d < 50; d++) {
    out.push(cur);
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return out;
}

function isWorkFactorError(e: unknown): boolean {
  return chain(e).some((x) => (x as { code?: unknown }).code === "work-factor");
}

function isKeyBlockContainerDamage(e: unknown): boolean {
  return chain(e).some((x) => {
    const c = x as { name?: unknown; kind?: unknown; block?: unknown };
    return c.name === "ContainerError" && c.kind === "damaged" && c.block === 1;
  });
}

/**
 * The error with the CLI's hint line appended (storage.md §3.1): `<error>\n<hint>`, or the
 * error itself when no hint applies. Codes stay reachable through the cause.
 */
export function withOpenHint(e: unknown): unknown {
  if (hinted.has(e as object)) return e;
  const hint = openHint(e);
  if (hint === undefined) return e;
  const out = errorf("%w\n%s", e, new HintText(hint));
  hinted.add(out);
  return out;
}

const hinted = new WeakSet<object>();

/** A hint rendered in the current language when the error is shown. */
class HintText {
  constructor(readonly text: string) {}
  toString(): string {
    return this.text;
  }
  localize(): string {
    return T(this.text);
  }
}
