// Temporary files and cleaning leftovers (storage.md §1.4).
//
// `.<target>.tmp-<n>` in the target's folder, created 0600 with O_CREAT|O_EXCL and held
// under flock(LOCK_EX) until it is renamed into place or removed, so a cleaner never
// removes a write in progress.

import { constants as C, fchmodSync, lstatSync, openSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { codedError } from "../i18n/index.ts";
import { flock, LOCK_EX, LOCK_NB, ERRNO } from "../ffi/libc.ts";
import { closeFd, closeQuiet, fsyncFd, removeQuiet, stillAt, writeAll } from "./files.ts";
import { FCHMOD_TOLERATED } from "./lock.ts";
import { errnoError, isErrno, osError } from "./oserror.ts";

/** Not normative: how many names are tried when one exists (storage.md §1.4). */
const MAX_NAME_TRIES = 10_000;
/** storage.md §1.4 step 1: the third disappearance fails. */
const MAX_DISAPPEARANCES = 3;

/** The prefix of the temporary files of `target`: `.<target>.tmp-`. */
export function tempPrefix(target: string): string {
  return `.${target}.tmp-`;
}

/** Test hooks: afterCreate runs between creating a temporary file and locking it (a cleaner's window). */
export const tempTestHooks: { afterCreate?: (path: string) => void } = {};

function randomName(target: string): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]!;
  return tempPrefix(target) + n.toString(10);
}

/** A temporary file being written; its descriptor holds the flock. */
export class TempFile {
  readonly path: string;
  readonly dir: string;
  #fd: number;
  constructor(dir: string, path: string, fd: number) {
    this.dir = dir;
    this.path = path;
    this.#fd = fd;
  }
  /** The descriptor (opened O_RDWR, so the caller may read the file back through it); -1 once closed. */
  get fd(): number {
    return this.#fd;
  }
  /**
   * Step 3: writes all of data and fsyncs. Any error removes the file and throws
   * (`write <path>: …`, `sync <path>: …`).
   */
  write(data: Uint8Array): void {
    try {
      writeAll(this.#fd, data, this.path);
      fsyncFd(this.#fd, this.path);
    } catch (e) {
      this.remove();
      throw e;
    }
  }
  /** Removes the file and closes the descriptor, ignoring errors (a failed write). */
  remove(): void {
    if (this.#fd >= 0 && stillAt(this.#fd, this.path)) removeQuiet(this.path);
    this.close();
  }
  /**
   * Closes the descriptor, which drops the lock (after the file was renamed into place).
   * Errors are thrown (`close <path>: …`) so the caller can warn (storage.md §4.2 step 7).
   */
  closeChecked(): void {
    if (this.#fd < 0) return;
    const fd = this.#fd;
    this.#fd = -1;
    closeFd(fd, this.path);
  }
  /** Closes the descriptor, ignoring errors. */
  close(): void {
    if (this.#fd < 0) return;
    closeQuiet(this.#fd);
    this.#fd = -1;
  }
}

/**
 * Creates a temporary file for `target` in `dir` (storage.md §1.4 steps 1–2): created
 * 0600 with O_CREAT|O_EXCL (another name on a collision), flock(LOCK_EX|LOCK_NB) held
 * until renamed or removed (failure: removed, `locking the temporary file: …`, code
 * "temp-lock"); if a cleaner removed it before the lock was taken, start again, the third
 * time failing with `temporary files keep disappearing` (code "temp-disappearing"); then
 * fchmod 0600, ignoring EPERM, EINVAL, ENOTSUP and EOPNOTSUPP. Other errors are
 * OSErrors (`open <path>: …`).
 */
export function createTempFile(dir: string, target: string): TempFile {
  for (let gone = 0; ; ) {
    let path = "";
    let fd = -1;
    for (let i = 0; ; i++) {
      path = join(dir, randomName(target));
      try {
        fd = openSync(path, C.O_RDWR | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
        break;
      } catch (e) {
        if (isErrno(e, "EEXIST") && i + 1 < MAX_NAME_TRIES) continue;
        throw osError("open", path, e);
      }
    }
    tempTestHooks.afterCreate?.(path);
    let r: number;
    do r = flock(fd, LOCK_EX | LOCK_NB);
    while (r === ERRNO.EINTR);
    if (r !== 0) {
      closeQuiet(fd);
      removeQuiet(path);
      throw codedError("temp-lock", "locking the temporary file: %w", errnoError(r));
    }
    if (!stillAt(fd, path)) {
      closeQuiet(fd);
      if (++gone >= MAX_DISAPPEARANCES) throw codedError("temp-disappearing", "temporary files keep disappearing");
      continue;
    }
    try {
      fchmodSync(fd, 0o600);
    } catch (e) {
      if (!isErrno(e, ...FCHMOD_TOLERATED)) {
        closeQuiet(fd);
        removeQuiet(path);
        throw osError("chmod", path, e);
      }
    }
    return new TempFile(dir, path, fd);
  }
}

/** createTempFile, then write and fsync the data (step 3); any error removes the file. */
export function writeTempFile(dir: string, target: string, data: Uint8Array): TempFile {
  const t = createTempFile(dir, target);
  t.write(data);
  return t;
}

/**
 * Cleans the leftovers of `target` in `dir` (storage.md §1.4 "Cleaning leftovers"): every
 * regular file (not a symlink) whose name starts with `.<target>.tmp-` is opened
 * O_RDONLY|O_NOFOLLOW|O_NONBLOCK and locked with flock(LOCK_EX|LOCK_NB): busy (a write in
 * progress) → skipped; still at its name → unlinked. Returns the names removed. Errors:
 * `open <dir>: …` (reading the folder), `open <file>: …`, `remove <file>: …`,
 * `locking <file>: …` (a flock error other than busy; the file is kept).
 */
export function cleanLeftovers(dir: string, target: string): string[] {
  const prefix = tempPrefix(target);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    throw osError("open", dir, e);
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const p = join(dir, name);
    try {
      if (!lstatSync(p).isFile()) continue;
    } catch (e) {
      if (isErrno(e, "ENOENT")) continue;
      throw osError("lstat", p, e);
    }
    let fd: number;
    try {
      fd = openSync(p, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    } catch (e) {
      if (isErrno(e, "ENOENT", "ELOOP")) continue;
      throw osError("open", p, e);
    }
    try {
      let r: number;
      do r = flock(fd, LOCK_EX | LOCK_NB);
      while (r === ERRNO.EINTR);
      if (r === ERRNO.EWOULDBLOCK || r === ERRNO.EAGAIN) continue;
      if (r !== 0) throw codedError("lock-failed", "locking %s: %w", p, errnoError(r));
      if (!stillAt(fd, p)) continue;
      try {
        unlinkSync(p);
      } catch (e) {
        if (isErrno(e, "ENOENT")) continue;
        throw osError("remove", p, e);
      }
      removed.push(name);
    } finally {
      closeQuiet(fd);
    }
  }
  return removed;
}
