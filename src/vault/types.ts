// The contract of src/vault (storage.md §3–§7): opening, key sources, saving.
// Written by the lead so the agent, import/export, CLI and TUI work can start in parallel;
// the storage agent implements it and may extend it (not break it) — report changes.

import type { X25519Identity } from "../age/index.ts";
import type { VaultData } from "../model/types.ts";
import type { Config, Env } from "../config/index.ts";
import type { CommandIO } from "../util/io.ts";

/** Where a vault key came from (vault-format.md §3.3 maps decryption failures by it). */
export type KeySourceKind = "agent" | "passphrase" | "paper";

/** What a key source gets: the file being opened and its key block. */
export interface KeyRequest {
  /** The vault path as passh got it (absolute, not symlink-resolved): `<abs>` in messages. */
  path: string;
  /** The real path (storage.md §0); the agent socket is named by it. */
  realPath: string;
  /** The binary key block (de-armored block 1). */
  keyBlock: Uint8Array;
  /** Lower-case hex SHA-256 of keyBlock (agent protocol `key_block`). */
  keyBlockDigest: string;
  /** Cancels a wait (TUI). */
  signal?: AbortSignal;
  /**
   * The environment of this open (OpenOptions.env, else process.env): for `<state>` and the
   * `~/` form of paths in the source's messages (added by the storage agent).
   */
  env?: Env;
}

/**
 * A source of the vault key, tried in order by openVault (spec §5.1, agent-session.md §A2.8).
 * `getKey` returns the identity, or undefined to fall through to the next source (no agent,
 * no terminal, key_block_changed …), or throws to fail the open (wrong passphrase after 3
 * tries, a refused work factor, an interrupted prompt …). A source prints its own notes and
 * warnings (e.g. `can't use the agent of <file>: …`).
 */
export interface KeySource {
  readonly kind: KeySourceKind;
  getKey(req: KeyRequest): Promise<X25519Identity | undefined>;
}

/**
 * How the rollback check of storage.md §7.4 behaves for this open:
 * - "prompt": with a terminal, ask `Continue with this copy? [y/N] ` (via `confirmOlder`);
 *   without one (confirmOlder undefined), warn and continue, record unchanged;
 * - "report": verify --full: never prompt; `OpenedVault.rollback` carries the comparison.
 */
export type RollbackMode = "prompt" | "report";

export interface OpenOptions {
  config: Config;
  /** Key sources in order; all falling through → the `vault is locked: …` error (code "locked"). */
  sources: KeySource[];
  rollback: RollbackMode;
  /**
   * Asks the rollback question on /dev/tty: prints `warning: <text>` and
   * `Continue with this copy? [y/N] `; resolves true for yes. Undefined = no terminal.
   */
  confirmOlder?: (text: string) => Promise<boolean>;
  /** `passh recover`: a damaged key block falls back to the last armored block (vault-format §3.6). */
  recoveryMode?: boolean;
  /** Warnings (ignored lines, rollback without a terminal, record problems) go here. */
  io: CommandIO;
  signal?: AbortSignal;
  /**
   * The environment for `<state>`, `$PWD` and `~` (added by the storage agent; default
   * process.env). Tests pass an isolated one.
   */
  env?: Env;
}

/** The comparison with the rollback record (storage.md §6.2 `rollback` line). */
export type RollbackReport =
  | { kind: "unseen" }
  | { kind: "same"; seen: bigint }
  | { kind: "newer"; seen: bigint }
  | { kind: "older"; seen: bigint; seenSavedAt: number };

export interface SaveOptions {
  /** A new key block (passwd, rekey, recover); else the opened one is copied byte for byte. */
  keyBlock?: Uint8Array;
  /** A new vault key (rekey); else the opened one. */
  identity?: X25519Identity;
  signal?: AbortSignal;
}

export interface OpenedVault {
  /** As given (absolute, cleaned): `<abs>`. */
  readonly path: string;
  readonly realPath: string;
  /** The decoded data. Changes only after a successful save (storage.md §4.2 last paragraph). */
  readonly data: VaultData;
  readonly keyBlock: Uint8Array;
  readonly keySource: KeySourceKind;
  /** SHA-256 hex of the bytes opened (or last saved). */
  readonly openedHash: string;
  readonly canonical: boolean;
  /** The file's real path is inside `<state>/backups/`: opens, never saves. */
  readonly inBackups: boolean;
  /** Opened in recovery mode with a damaged key block: only a save with a new key block works. */
  readonly keyBlockDamaged: boolean;
  /** Set for rollback mode "report". */
  readonly rollback?: RollbackReport;
  /** The vault key (wiped by close()). */
  identity(): X25519Identity;
  /**
   * Saves `data` as the next revision (storage.md §4.2): lock, change check, encrypt,
   * temporary file, read-back, backup, exchange/rename, record. Throws coded errors:
   * "changed" (`vault changed on disk after it was opened …`), "busy" (`vault is being
   * saved by another passh process …`), "in-backups", "key-block-damaged", others.
   * On success `this.data` becomes the saved data (with the new revision and saved_at).
   */
  save(data: VaultData, opts?: SaveOptions): Promise<void>;
  /** Changed on disk since opened/saved (storage.md §3.3): retargeted, gone, or other bytes. */
  changedOnDisk(): Promise<boolean>;
  /** A new open of the same path (storage.md §3.3 reload): current key first if the key block is unchanged. */
  reload(opts: OpenOptions): Promise<OpenedVault>;
  /** Wipes the key; the object must not be used afterwards. */
  close(): void;
}
