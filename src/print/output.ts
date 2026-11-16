// Where a sheet goes (print.md §1.5, cli.md §2.17, §2.24): a new `-o` file (O_EXCL, 0600,
// fsynced, partial file removed on failure) or stdout, and the tmpfs warning.

import { chmodSync, closeSync, constants as C, lstatSync, openSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { errorf, type PasshError } from "../i18n/index.ts";
import { expandPath, tildePath, type Env } from "../config/paths.ts";
import { fsyncDir, fsyncFd, writeAll } from "../fsx/files.ts";
import { isErrno, osError } from "../fsx/oserror.ts";
import { IS_DARWIN, IS_LINUX, RAMFS_MAGIC, TMPFS_MAGIC, statfs } from "../ffi/libc.ts";

/** The `-o` path: `~` expanded, made absolute against the working directory. */
export function outputPath(raw: string, env: Env = process.env, cwd?: string): string {
  return expandPath(raw, { env, cwd });
}

/**
 * Refuses an existing `-o` path (`lstat`, so a dangling symlink counts): `<path> already
 * exists; passh doesn't overwrite files` (path with `~/`).
 */
export function checkOutputFree(abs: string, env: Env = process.env): void {
  try {
    lstatSync(abs);
  } catch (e) {
    if (isErrno(e, "ENOENT")) return;
    throw osError("lstat", abs, e);
  }
  throw errorf("%s already exists; passh doesn't overwrite files", tildePath(abs, env));
}

/**
 * Writes a new file (print.md §1.5): `O_WRONLY|O_CREAT|O_EXCL`, mode 0600 (chmod again,
 * failure ignored), written, fsynced, closed, the folder fsynced (best effort). On failure
 * the partial file is removed: `…; the partial file was removed` or `…; the partial file
 * <path> could not be removed (<err>): delete it`.
 */
export function writeNewOutput(abs: string, data: Uint8Array, env: Env = process.env): void {
  let fd: number;
  try {
    fd = openSync(abs, C.O_WRONLY | C.O_CREAT | C.O_EXCL, 0o600);
  } catch (e) {
    if (isErrno(e, "EEXIST")) throw errorf("%s already exists; passh doesn't overwrite files", tildePath(abs, env));
    throw osError("open", abs, e);
  }
  try {
    try {
      chmodSync(abs, 0o600);
    } catch {
      /* file systems without modes */
    }
    writeAll(fd, data, abs);
    fsyncFd(fd, abs);
    try {
      closeSync(fd);
    } catch (e) {
      fd = -1;
      throw osError("close", abs, e);
    }
    fd = -1;
  } catch (e) {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {}
    }
    throw partialRemoved(abs, e, env);
  }
  try {
    fsyncDir(dirname(abs));
  } catch {
    /* best effort */
  }
}

function partialRemoved(abs: string, cause: unknown, env: Env): PasshError {
  const err = cause instanceof Error ? cause : new Error(String(cause));
  try {
    lstatSync(abs);
    try {
      unlinkSync(abs);
    } catch (e) {
      return errorf("%w; the partial file %s could not be removed (%v): delete it", err, tildePath(abs, env), osError("remove", abs, e));
    }
  } catch {
    /* already gone */
  }
  return errorf("%w; the partial file was removed", err);
}

/**
 * Reports whether a folder is on tmpfs (print.md §1.5): Linux statfs type TMPFS_MAGIC or
 * RAMFS_MAGIC; macOS f_fstypename "tmpfs"; other systems never.
 */
export function onTmpfs(dir: string): boolean {
  if (!IS_LINUX && !IS_DARWIN) return false;
  const st = statfs(dir);
  if (typeof st === "number") return false;
  if (IS_DARWIN) return st.typeName === "tmpfs";
  return st.type === TMPFS_MAGIC || st.type === RAMFS_MAGIC;
}

/** The tmpfs warning text (without `passh: warning: `), or undefined when the file is on tmpfs. */
export function tmpfsWarning(abs: string, env: Env = process.env): PasshError | undefined {
  if (onTmpfs(dirname(abs))) return undefined;
  return errorf("%s isn't on tmpfs: the plaintext is on persistent disk. Delete it when you're done", tildePath(abs, env));
}

/** Quotes a path for a POSIX shell with '…' unless it only has `A–Z a–z 0–9 / . _ - + @ : , =`. */
export function shellQuote(s: string): string {
  if (s !== "" && /^[A-Za-z0-9/._\-+@:,=]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
