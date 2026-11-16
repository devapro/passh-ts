// Lock files (storage.md §1.4 "Lock files"): BSD flock(2) on an empty 0600 file that is
// never deleted. Busy: retry every 20 ms, give up 15 s after the first busy try.

import { constants as C, fchmodSync, openSync } from "node:fs";
import { codedError } from "../i18n/index.ts";
import { flock, LOCK_EX, LOCK_NB, ERRNO } from "../ffi/libc.ts";
import { formatGoDuration, MS } from "../util/duration.ts";
import { closeQuiet } from "./files.ts";
import { errnoError, isErrno, osError } from "./oserror.ts";

/** storage.md §1.4: give up this long after the first busy try. */
export const LOCK_TIMEOUT_MS = 15_000;
/** storage.md §1.4 (informative): the poll interval. */
export const LOCK_POLL_MS = 20;

/** Errnos of fchmod that are ignored (file systems without modes, storage.md §1.4 step 2). */
export const FCHMOD_TOLERATED = ["EPERM", "EINVAL", "ENOTSUP", "EOPNOTSUPP"];

export interface LockOptions {
  /** Give up this long after the first busy try (default 15 s; tests use less). */
  timeoutMs?: number;
  /** Poll interval (default 20 ms). */
  pollMs?: number;
  /** Cancels the wait (the TUI): fails with code "lock-cancelled". */
  signal?: AbortSignal;
}

/** A held lock. release() closes the descriptor, which drops the flock; the file stays. */
export class FileLock {
  readonly path: string;
  #fd: number;
  constructor(path: string, fd: number) {
    this.path = path;
    this.#fd = fd;
  }
  /** The descriptor holding the lock (-1 after release). */
  get fd(): number {
    return this.#fd;
  }
  get held(): boolean {
    return this.#fd >= 0;
  }
  release(): void {
    if (this.#fd < 0) return;
    closeQuiet(this.#fd);
    this.#fd = -1;
  }
  [Symbol.dispose](): void {
    this.release();
  }
}

/**
 * Opens the lock file `O_RDONLY|O_CREAT|O_NOFOLLOW` 0600 and sets its mode (`fchmod 0600`).
 * Errors: OSError `open <path>: …` / `chmod <path>: …`.
 */
export function openLockFile(path: string): number {
  let fd: number;
  try {
    fd = openSync(path, C.O_RDONLY | C.O_CREAT | C.O_NOFOLLOW, 0o600);
  } catch (e) {
    throw osError("open", path, e);
  }
  try {
    fchmodSync(fd, 0o600);
  } catch (e) {
    if (!isErrno(e, ...FCHMOD_TOLERATED)) {
      closeQuiet(fd);
      throw osError("chmod", path, e);
    }
  }
  return fd;
}

/**
 * One flock(LOCK_EX|LOCK_NB) attempt on fd (EINTR retried). Returns true when locked,
 * false when busy; other errors throw `locking <path>: <reason>` (code "lock-failed").
 */
export function tryFlock(fd: number, path: string): boolean {
  for (;;) {
    const r = flock(fd, LOCK_EX | LOCK_NB);
    if (r === 0) return true;
    if (r === ERRNO.EINTR) continue;
    if (r === ERRNO.EWOULDBLOCK || r === ERRNO.EAGAIN) return false;
    throw codedError("lock-failed", "locking %s: %w", path, errnoError(r));
  }
}

/** The error of a wait that was cancelled (code "lock-cancelled"). */
function cancelledError(signal: AbortSignal) {
  const r: unknown = signal.reason;
  // An AbortController's default reason is a DOMException; show Go's context text instead.
  const cause = r instanceof Error && r.name !== "AbortError" ? r : new Error("context canceled");
  return codedError("lock-cancelled", "stopped waiting for another passh process: %w", cause);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Takes a lock file (storage.md §1.4): open, fchmod, flock(LOCK_EX|LOCK_NB); busy →
 * retry every 20 ms; give up `timeoutMs` (15 s) after the first busy try with code
 * "lock-busy" (`another passh process has held <path> for 15s`; callers phrase it, e.g.
 * `vault is being saved by another passh process; …`); a cancelled signal stops with
 * `stopped waiting for another passh process: …` (code "lock-cancelled"); open errors are
 * OSErrors (`open <path>: …`), other flock errors `locking <path>: …` (code "lock-failed").
 * Lock files are never deleted.
 */
export async function acquireLock(path: string, opts: LockOptions = {}): Promise<FileLock> {
  const timeout = opts.timeoutMs ?? LOCK_TIMEOUT_MS;
  const poll = opts.pollMs ?? LOCK_POLL_MS;
  const fd = openLockFile(path);
  let firstBusy: number | undefined;
  try {
    for (;;) {
      if (tryFlock(fd, path)) return new FileLock(path, fd);
      const now = Date.now();
      if (firstBusy === undefined) firstBusy = now;
      if (opts.signal?.aborted) throw cancelledError(opts.signal);
      if (now - firstBusy >= timeout) {
        // SPEC-GAP: storage.md §1.4 gives no text for a lock that stays busy; callers
        // replace it where the spec has one (the vault lock).
        throw codedError("lock-busy", "another passh process has held %s for %s", path, formatGoDuration(BigInt(timeout) * MS));
      }
      await sleep(Math.min(poll, Math.max(1, firstBusy + timeout - now)), opts.signal);
      if (opts.signal?.aborted) throw cancelledError(opts.signal);
    }
  } catch (e) {
    closeQuiet(fd);
    throw e;
  }
}

/** One non-blocking attempt: the lock, or undefined when another process holds it. */
export function tryAcquireLock(path: string): FileLock | undefined {
  const fd = openLockFile(path);
  try {
    if (tryFlock(fd, path)) return new FileLock(path, fd);
  } catch (e) {
    closeQuiet(fd);
    throw e;
  }
  closeQuiet(fd);
  return undefined;
}

