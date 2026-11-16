// Test-only hooks of the storage layer (spec §13.2 safety test 9: fault injection before and
// after each fsync and the rename). Production code never sets them: every call site is a
// no-op optional call (`faultPoint?.(…)`), and the lock timeout is the spec's 15 s unless a
// test lowers it.

/**
 * The points of a save where a test can stop the process (e.g. SIGKILL itself) or wait:
 * - `temp-written` / `temp-synced`: the temporary vault file before / after its fsync (§4.5 item 2);
 * - `read-back`: after the read-back (step 5);
 * - `backup-written` / `backup-synced` / `backup-renamed` / `backup-dir-synced`: the automatic
 *   backup's temporary file before / after its fsync, after its rename, after the folder fsync;
 * - `before-replace` / `after-replace`: around the exchange or rename of the vault (step 7);
 * - `old-removed`: after the replaced file was checked and unlinked;
 * - `dir-synced`: after the vault's folder fsync;
 * - `record-written` / `record-synced` / `record-renamed`: the rollback record's temporary file
 *   before / after its fsync, after its rename;
 * - `locked`: right after the vault lock was taken (step 1);
 * - `step2`, `step3`: before steps 2 and 3 (where a cancellation is honoured).
 */
export type FaultPoint =
  | "locked"
  | "step2"
  | "step3"
  | "temp-written"
  | "temp-synced"
  | "read-back"
  | "backup-written"
  | "backup-synced"
  | "backup-renamed"
  | "backup-dir-synced"
  | "before-replace"
  | "after-replace"
  | "old-removed"
  | "dir-synced"
  | "record-written"
  | "record-synced"
  | "record-renamed";

export interface VaultTestHooks {
  /** Called at each fault point; may throw, kill the process, or return a promise to wait on. */
  point?: (p: FaultPoint, info: { path: string }) => void | Promise<void>;
  /** Lock timeout in ms instead of storage.md §1.4's 15 s. */
  lockTimeoutMs?: number;
  /** Replaces the exchange system call (to reach the plain-rename fallback): 0 or an errno number. */
  exchangeSys?: (a: string, b: string) => number;
  /** The clock (ms since the epoch) for stamps and times. */
  now?: () => number;
}

/** The hooks; empty in production. */
export const vaultTestHooks: VaultTestHooks = {};

/** Runs the hook of a fault point, if any. */
export async function faultPoint(p: FaultPoint, path: string): Promise<void> {
  const f = vaultTestHooks.point;
  if (f) await f(p, { path });
}

/** The current time in ms (the hook's clock in tests). */
export function nowMs(): number {
  return vaultTestHooks.now ? vaultTestHooks.now() : Date.now();
}
