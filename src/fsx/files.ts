// Small file primitives with Go-style OS errors (storage.md §1.4): reading with a size
// limit, writing all bytes, fsync of files and folders, creating a new file that never
// replaces anything.

import { closeSync, constants as C, fstatSync, fsyncSync, lstatSync, openSync, readSync, statSync, unlinkSync, writeSync, type BigIntStats } from "node:fs";
import { codedError } from "../i18n/index.ts";
import { isErrno, osError } from "./oserror.ts";

/** storage.md §1.4: a vault file that is opened, verified, copied or backed up. */
export const MAX_VAULT_SIZE = 64 * 1024 * 1024;
/** storage.md §1.4: a config file. */
export const MAX_CONFIG_SIZE = 1024 * 1024;

/** Writes every byte of data at the descriptor's offset; errors read `write <path>: …`. */
export function writeAll(fd: number, data: Uint8Array, path: string): void {
  let off = 0;
  while (off < data.length) {
    let n: number;
    try {
      n = writeSync(fd, data, off, data.length - off);
    } catch (e) {
      if (isErrno(e, "EINTR", "EAGAIN")) continue;
      throw osError("write", path, e);
    }
    if (n <= 0) throw osError("write", path, "EIO");
    off += n;
  }
}

/** fsync of a file descriptor; errors read `sync <path>: …` (Go's File.Sync). */
export function fsyncFd(fd: number, path: string): void {
  try {
    fsyncSync(fd);
  } catch (e) {
    throw osError("sync", path, e);
  }
}

/** Closes a descriptor, ignoring errors. */
export function closeQuiet(fd: number | undefined): void {
  if (fd === undefined || fd < 0) return;
  try {
    closeSync(fd);
  } catch {
    /* ignored */
  }
}

/** Closes a descriptor; errors read `close <path>: …`. */
export function closeFd(fd: number, path: string): void {
  try {
    closeSync(fd);
  } catch (e) {
    throw osError("close", path, e);
  }
}

/** Removes a file, ignoring a missing one; errors read `remove <path>: …`. */
export function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if (isErrno(e, "ENOENT")) return;
    throw osError("remove", path, e);
  }
}

/** Removes a file, ignoring every error. */
export function removeQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* ignored */
  }
}

/** Reports whether two stats describe the same file (device and inode). */
export function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** fstat with bigint fields; errors read `stat <path>: …`. */
export function fstatBig(fd: number, path: string): BigIntStats {
  try {
    return fstatSync(fd, { bigint: true });
  } catch (e) {
    throw osError("stat", path, e);
  }
}

/** lstat with bigint fields, or undefined if the path doesn't exist; errors read `lstat <path>: …`. */
export function lstatIfExists(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (e) {
    if (isErrno(e, "ENOENT")) return undefined;
    throw osError("lstat", path, e);
  }
}

/** Reports whether the descriptor still is the file at path (not removed or replaced). */
export function stillAt(fd: number, path: string): boolean {
  let a: BigIntStats, b: BigIntStats;
  try {
    a = fstatSync(fd, { bigint: true });
    b = lstatSync(path, { bigint: true });
  } catch {
    return false;
  }
  return sameFile(a, b);
}

/** "64 MiB", "1 MiB", or "<n> bytes". */
export function formatLimit(limit: number): string {
  const MiB = 1024 * 1024;
  if (limit % MiB === 0) return `${limit / MiB} MiB`;
  return `${limit} bytes`;
}

/** The error for a file that isn't a regular file (code "not-regular"). */
export function notRegularError() {
  return codedError("not-regular", "not a regular file");
}

/** The error for a file over the limit (code "too-large"): `the file is larger than 64 MiB`. */
export function tooLargeError(limit: number) {
  return codedError("too-large", "the file is larger than %s", formatLimit(limit));
}

/** Reads from fd until EOF or until more than `limit` bytes were read. Returns the bytes (≤ limit + 1). */
function readUpTo(fd: number, limit: number, path: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const max = limit + 1;
  while (total < max) {
    const buf = new Uint8Array(Math.min(Math.max(max - total, 1), 1 << 20));
    let n: number;
    try {
      n = readSync(fd, buf, 0, buf.length, null);
    } catch (e) {
      if (isErrno(e, "EINTR", "EAGAIN")) continue;
      throw osError("read", path, e);
    }
    if (n === 0) break;
    chunks.push(n === buf.length ? buf : buf.subarray(0, n));
    total += n;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Reads a file that must be a regular file (`stat`, following symlinks) of at most
 * `limit` bytes (storage.md §1.4). Throws OSError (`stat <path>: …`, `open <path>: …`,
 * `read <path>: …`), or a PasshError with code "not-regular" (`not a regular file`) or
 * "too-large" (`the file is larger than 64 MiB`), which callers phrase for their context.
 */
export function readRegularFile(path: string, limit: number = MAX_VAULT_SIZE): Uint8Array {
  let st;
  try {
    st = statSync(path);
  } catch (e) {
    throw osError("stat", path, e);
  }
  if (!st.isFile()) throw notRegularError();
  if (st.size > limit) throw tooLargeError(limit);
  let fd: number;
  try {
    fd = openSync(path, C.O_RDONLY | C.O_NONBLOCK);
  } catch (e) {
    throw osError("open", path, e);
  }
  try {
    // The file may have been replaced between stat and open.
    if (!fstatBig(fd, path).isFile()) throw notRegularError();
    const data = readUpTo(fd, limit, path);
    if (data.length > limit) throw tooLargeError(limit);
    return data;
  } finally {
    closeQuiet(fd);
  }
}

/**
 * Opens and reads a file of at most `limit` bytes without a type check (the config
 * file, storage.md §2.2 step 1): errors `open <path>: …`, `read <path>: …` (a folder gives
 * `read <path>: is a directory`), or code "too-large".
 */
export function readFileLimited(path: string, limit: number): Uint8Array {
  let fd: number;
  try {
    fd = openSync(path, C.O_RDONLY);
  } catch (e) {
    throw osError("open", path, e);
  }
  try {
    const data = readUpTo(fd, limit, path);
    if (data.length > limit) throw tooLargeError(limit);
    return data;
  } finally {
    closeQuiet(fd);
  }
}

/** Errnos that count as success for a folder fsync (storage.md §1.4: FUSE, network file systems). */
const FSYNC_DIR_TOLERATED = ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EBADF", "ENOTTY"];

/**
 * Flushes a folder to disk (storage.md §1.4 "Folder fsync"): open it and fsync it;
 * EINVAL, ENOTSUP, EOPNOTSUPP, EBADF and ENOTTY count as success. Errors read
 * `open <dir>: …` or `sync <dir>: …`.
 */
export function fsyncDir(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, C.O_RDONLY | (C.O_DIRECTORY ?? 0));
  } catch (e) {
    throw osError("open", dir, e);
  }
  try {
    fsyncSync(fd);
  } catch (e) {
    if (!isErrno(e, ...FSYNC_DIR_TOLERATED)) throw osError("sync", dir, e);
  } finally {
    closeQuiet(fd);
  }
}

/**
 * Creates a new file with O_CREAT|O_EXCL (so nothing, not even a dangling symlink, is
 * ever replaced), mode reduced by the umask, writes the data, fsyncs and closes it;
 * a write, fsync or close error removes the new file (storage.md §2.4). No folder fsync.
 * Errors: `open <path>: file exists`, `write <path>: …`, `sync <path>: …`, `close <path>: …`.
 */
export function writeNewFile(path: string, data: Uint8Array, mode = 0o600): void {
  let fd: number;
  try {
    fd = openSync(path, C.O_WRONLY | C.O_CREAT | C.O_EXCL, mode);
  } catch (e) {
    throw osError("open", path, e);
  }
  try {
    writeAll(fd, data, path);
    fsyncFd(fd, path);
  } catch (e) {
    closeQuiet(fd);
    removeQuiet(path);
    throw e;
  }
  try {
    closeFd(fd, path);
  } catch (e) {
    removeQuiet(path);
    throw e;
  }
}
