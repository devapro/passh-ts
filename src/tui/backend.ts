// What the TUI needs from the rest of passh (tui.md; spec §5.1–§5.3, §6.3, §7.4).
//
// The TUI never does I/O itself: every call below runs in a background job (a command of
// the runtime), and its result comes back as a message. Calls that may take long get an
// AbortSignal; the TUI aborts it when a lock or quit cancels the job (tui.md §10.2). Results
// are plain data; failures that the TUI shows in a specific way are kinds of the result,
// anything else is an `error` (an Error whose text, in the language, is shown after the
// TUI's own prefix, e.g. "Reload failed: <error>").
//
// The real implementation (src/cli, over src/vault, src/agent, src/clipboard, src/printweb)
// is the lead's; src/tui/fake.ts is an in-memory one for tests.

import type { Entry, Field, Unknowns, VaultData } from "../model/types.ts";

// ---------------------------------------------------------------------------
// Configuration

export interface TuiConfig {
  /** `session.idle_ttl` in milliseconds (default 5 min): the idle lock (tui.md §10.1). */
  idleTtlMs: number;
  /** `session.stop_agent` (default true): every lock, quitting included, stops the agent. */
  stopAgent: boolean;
  /** `clipboard.clear_after` in milliseconds (default 30 s): the print dialog's copy note. */
  clearAfterMs: number;
  /** `print_web.enabled` (default false): `P` refuses when off (tui.md §7.8). */
  printWebEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Unlocking (tui.md §4)

/**
 * The outcome of one unlock attempt (agent or passphrase). Kinds map to the rows of
 * tui.md §4.4; the backend classifies its errors, the TUI chooses the words.
 */
export type UnlockResult =
  /** Unlocked. `rollback` is set when the copy is older than one seen before (§4.10, tui.md §9). */
  | { kind: "unlocked"; session: VaultSession; warnings: string[]; rollback?: RollbackQuestion }
  /** No agent runs for this vault, or the agent client can't be set up (silently go on). */
  | { kind: "no-agent" }
  /** The key block doesn't open with this passphrase, or it is damaged. */
  | { kind: "wrong-passphrase" }
  /**
   * The data block doesn't open with a key that fits the key block: the "damaged" state.
   * `error` is the vault's "data is damaged; restore a backup" error with the backup list.
   */
  | { kind: "damaged"; error: unknown }
  /** The agent was unlocked for another key block (passwd elsewhere?). */
  | { kind: "agent-other-key-block" }
  /** Any other agent failure (folder check, foreign peer, timeout, …). */
  | { kind: "agent-failed"; error: unknown }
  /** The key block asks for a scrypt work factor above 2^18 (refused before scrypt). */
  | { kind: "work-factor"; error: unknown }
  /** Anything else: truncated, not a passh vault, newer version, I/O … (shown as is). */
  | { kind: "error"; error: unknown };

/**
 * The rollback question (spec §4.10) of an open that found an older copy. The data is
 * decrypted but not shown until the user answers.
 */
export interface RollbackQuestion {
  /** The warning text without the "Warning: " prefix ("this copy is older than …"). */
  warning: string;
  /** Yes: record the lower revision (forced update). Resolves with warnings (e.g. the record wasn't updated). */
  accept(): Promise<string[]>;
  /** The error a "no" ends the TUI with: "stopped: this copy is older …; nothing was changed". */
  readonly declined: Error;
}

// ---------------------------------------------------------------------------
// The open vault

/** The editable values of an entry (the form's five fields; tags already normalized). */
export interface EntryValues {
  password: string;
  username: string;
  url: string;
  tags: string[];
  notes: string;
}

/** What an add keeps beyond the form's values (a recreated add, tui.md §8.2). */
export interface AddExtra {
  fields: Field[];
  unknown: Unknowns;
}

/** The result of one change (one save of spec §4.6, tui.md §7.7). */
export type SaveResult =
  /** Saved: the new data (what the TUI shows from now on); `id` is the changed entry's id. */
  | { kind: "saved"; data: VaultData; id: string; warnings: string[] }
  /** Nothing would change (edit or tags with the same values): no save was made. */
  | { kind: "unchanged" }
  /** The vault file changed on disk (before or during the save): nothing was saved. */
  | { kind: "changed" }
  /** The job was aborted (a lock or quit) before the file was written: nothing was saved. */
  | { kind: "cancelled" }
  /**
   * Any other failure, nothing saved: validation (`<path>: already exists`, `invalid path: …`),
   * another passh saving (`vault is being saved by another passh process; …`), an automatic
   * backup refusing saves, I/O. The TUI shows the error's text.
   */
  | { kind: "failed"; error: unknown };

/** The result of a reload (`R`, tui.md §8.3). */
export type ReloadResult =
  | { kind: "reloaded"; data: VaultData; warnings: string[] }
  /** The reloaded copy is older than one seen before: ask (tui.md §9); answer() continues the job. */
  | { kind: "rollback"; warning: string; answer(yes: boolean, signal: AbortSignal): Promise<ReloadResult> }
  /** The key block changed and neither the current key nor the agent opens it. */
  | { kind: "rekeyed" }
  /** Any other failure (also "no" to the rollback question: the "stopped: …" error). */
  | { kind: "failed"; error: unknown };

/**
 * An unlocked vault: the decrypted data and the vault key. Every change is one save; the
 * data in the session changes only when a save or reload succeeds.
 */
export interface VaultSession {
  /** The data as opened (or as last saved or reloaded). */
  data(): VaultData;
  /** Adds an entry (spec §4.2: new id, created_at = updated_at = now). Fails if the path exists. */
  add(path: string, values: EntryValues, extra: AddExtra | null, signal: AbortSignal): Promise<SaveResult>;
  /**
   * Replaces the five editable values of the entry with this id (the form, tui.md §11.5);
   * custom fields, path, id, created_at and unknown keys stay. "unchanged" when equal.
   */
  edit(id: string, values: EntryValues, signal: AbortSignal): Promise<SaveResult>;
  /** Moves (renames) an entry; the destination must not exist. */
  move(id: string, dst: string, signal: AbortSignal): Promise<SaveResult>;
  /** Adds then removes tags (as `passh tag --add … --remove …`); "unchanged" when equal. */
  tag(id: string, add: string[], remove: string[], signal: AbortSignal): Promise<SaveResult>;
  /** Removes an entry (a tombstone is added). */
  remove(id: string, signal: AbortSignal): Promise<SaveResult>;
  /**
   * Whether the vault file is no longer the one opened or last saved (content hash, file
   * gone, symlink retargeted; storage.md §3.3). Throws if the check itself fails.
   */
  checkChanged(signal: AbortSignal): Promise<boolean>;
  /** Opens the file again; the current key first, then the agent (a typed passphrase is never kept). */
  reload(signal: AbortSignal): Promise<ReloadResult>;
  /** Closes the vault: wipes the key and the data. Called once, at every lock. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Clipboard (spec §6.3, agent-session.md §A5)

export type CopyResult =
  /**
   * Copied. `clearAt` is when the clear is due (wall-clock ms); `cleared` settles when the
   * scheduled clear has run: "cleared", or "superseded" when a newer copy replaced this
   * schedule (or the clear was done at once by clearNow); it rejects when the clear failed.
   */
  | { kind: "copied"; clearAt: number; cleared: Promise<"cleared" | "superseded"> }
  /** No clipboard: `error` is the `no clipboard: <reason>; copy with: passh show …` error. */
  | { kind: "no-clipboard"; error: unknown }
  | { kind: "failed"; error: unknown };

/** A clear that is still pending: when it is due and its outcome. */
export interface PendingClear {
  clearAt: number;
  done: Promise<"cleared" | "superseded">;
}

// ---------------------------------------------------------------------------
// Print page (spec §7.4, print.md §6, tui.md §7.8–§7.9)

export type PrintScope = { kind: "all" } | { kind: "folder"; folder: string } | { kind: "tags"; tags: string[] };

export interface PrintRequest {
  scope: PrintScope;
  /** Field names in sheet order: some of "password", "username", "url", "fields". */
  fields: string[];
  /** A copy of the data the sheet is built from. */
  data: VaultData;
}

export type PrintState =
  | { running: true }
  /**
   * Stopped. `served`: the page was served (the normal end). `outcome` is the result text
   * of print.md §6.7 in the language (e.g. "the page was served to 192.168.1.23; …").
   */
  | { running: false; served: boolean; outcome: string };

/** A running print page (the server lives inside the passh process). */
export interface PrintPage {
  /** One URL per bound address, in bind order. */
  urls: string[];
  /** SHA-256 fingerprint, upper-case hex pairs joined by ":". */
  fingerprint: string;
  /** The certificate notice when a new certificate was made ("made a new certificate …"). */
  certNotice?: string;
  /** Skipped addresses ("lo: 127.0.0.1 is a loopback address, not private"). */
  skipped: string[];
  /** When the page stops by itself (wall-clock ms). */
  expiresAt: number;
  /** The terminal QR code of a URL as text lines (print.md §6.9), or null if it can't be made. */
  qr(url: string): string[] | null;
  /** Polled every second. */
  state(): PrintState;
  /** Stops the server; resolves when it has stopped. */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// The backend

export interface TuiBackend {
  readonly config: TuiConfig;
  /** The vault file for the lock screen, `$HOME` written as `~` (raw; the TUI escapes it). */
  readonly vaultDisplay: string;

  /**
   * Asks the vault's agent for the key of the vault's current key block (a key request).
   * "no-agent" when none runs or the client can't be set up.
   */
  unlockWithAgent(signal: AbortSignal): Promise<UnlockResult>;
  /**
   * Unwraps the key block exactly once with the passphrase (scrypt) and opens the vault.
   * The TUI wipes `passphrase` after the call has settled.
   */
  unlockWithPassphrase(passphrase: Uint8Array, signal: AbortSignal): Promise<UnlockResult>;
  /** A status request: does an agent run for this vault (after `L` or the idle lock)? */
  agentRunning(signal: AbortSignal): Promise<boolean>;
  /** Stops the vault's agent: true if one was stopped, false if none ran. Throws on failure. */
  stopAgent(signal: AbortSignal): Promise<boolean>;

  /** Copies a value (password, username or a print page URL) and schedules its clear. */
  copy(value: string, field: "password" | "username" | "url", path: string, signal: AbortSignal): Promise<CopyResult>;
  /** The pending clear, if a copied value hasn't been cleared yet. */
  pendingClear(): PendingClear | null;
  /** Clears a pending value at once: true if one was cleared, false if none was pending. Throws on failure. */
  clearNow(signal: AbortSignal): Promise<boolean>;

  /** Starts the print page server (tui.md §7.8). Throws on failure ("Print page: <error>"). */
  startPrintPage(req: PrintRequest, signal: AbortSignal): Promise<PrintPage>;
}

/** A copy of an entry, for comparing and keeping (tui.md §8.2). */
export function cloneEntry(e: Entry): Entry {
  return {
    ...e,
    tags: [...e.tags],
    fields: e.fields.map((f) => ({ key: f.key, value: f.value, unknown: new Map(f.unknown) })),
    unknown: new Map(e.unknown),
  };
}

function sameUnknowns(a: Unknowns, b: Unknowns): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** Whether two entries are the same in every stored respect (tui.md §8.2 "unchanged on disk"). */
export function sameEntry(a: Entry, b: Entry): boolean {
  if (a.id !== b.id || a.path !== b.path || a.password !== b.password || a.username !== b.username || a.url !== b.url || a.notes !== b.notes) return false;
  if (a.createdAt !== b.createdAt || a.updatedAt !== b.updatedAt) return false;
  if (a.tags.length !== b.tags.length || a.tags.some((t, i) => b.tags[i] !== t)) return false;
  if (a.fields.length !== b.fields.length) return false;
  for (let i = 0; i < a.fields.length; i++) {
    const f = a.fields[i]!;
    const g = b.fields[i]!;
    if (f.key !== g.key || f.value !== g.value || !sameUnknowns(f.unknown, g.unknown)) return false;
  }
  return sameUnknowns(a.unknown, b.unknown);
}
