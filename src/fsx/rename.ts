// Renames (storage.md §1.4 "Renames"): exchange, rename-no-replace, and their fallbacks.

import { linkSync, renameSync, unlinkSync } from "node:fs";
import { renameExchange as sysExchange, renameNoReplace as sysNoReplace, ERRNO } from "../ffi/libc.ts";
import { lstatIfExists } from "./files.ts";
import { errnoError, isErrno, osError, type OSError } from "./oserror.ts";

/** Errnos meaning "the system or file system can't do this rename" (storage.md §1.4). */
const UNSUPPORTED = new Set(["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].map((n) => ERRNO[n]!));

/** Reports whether an errno number means "unsupported" (EINVAL, ENOSYS, ENOTSUP, EOPNOTSUPP). */
export function isUnsupportedErrno(n: number): boolean {
  return UNSUPPORTED.has(n);
}

/** The system calls the renames use; tests replace them to reach the fallbacks. */
export interface RenameDeps {
  /** renameat2/renamex_np with the exchange or no-replace flag: 0 or an errno. */
  sys(a: string, b: string): number;
  link(a: string, b: string): void;
  unlink(a: string): void;
  rename(a: string, b: string): void;
}

const NODE_DEPS = { link: linkSync, unlink: unlinkSync, rename: renameSync };

/**
 * exchange(a, b): atomically swaps the two names (Linux renameat2(RENAME_EXCHANGE),
 * macOS renamex_np(RENAME_SWAP)). Returns "exchanged", or "unsupported" (EINVAL, ENOSYS,
 * ENOTSUP, EOPNOTSUPP) so the caller can fall back to a plain rename (storage.md §4.3).
 * Other errors throw an OSError `rename <a> <b>: <reason>` (ENOENT when one is missing).
 */
export function exchange(a: string, b: string, deps: Pick<RenameDeps, "sys"> = { sys: sysExchange }): "exchanged" | "unsupported" {
  const r = deps.sys(a, b);
  if (r === 0) return "exchanged";
  if (isUnsupportedErrno(r)) return "unsupported";
  throw osError("rename", a, errnoError(r), b);
}

/** A plain rename(2), replacing b; errors `rename <a> <b>: …`. */
export function rename(a: string, b: string): void {
  try {
    renameSync(a, b);
  } catch (e) {
    throw osError("rename", a, e, b);
  }
}

export interface NoReplaceResult {
  /** How the rename was done: the system call, link + unlink, or lstat + rename. */
  method: "noreplace" | "link" | "rename";
  /**
   * With "link": removing the old name failed after the link succeeded. The file is in
   * place under the new name; the old name is left (the next write cleans it).
   */
  unlinkError?: OSError;
}

/**
 * rename-no-replace(a, b) (storage.md §1.4): Linux renameat2(RENAME_NOREPLACE), macOS
 * renamex_np(RENAME_EXCL). EEXIST if b exists: thrown as an OSError with code "EEXIST"
 * (`rename <a> <b>: file exists`; match it with isErrno(e, "EEXIST")).
 * Unsupported → link(a, b) + unlink(a) (EEXIST stays EEXIST); if link fails otherwise
 * (FAT) → lstat(b) exists → EEXIST, else rename(2).
 *
 * Known issue #9 of the spec audit (proposed fix implemented): after a successful link, a
 * failed unlink of `a` is returned as `unlinkError` instead of failing the rename.
 */
export function renameNoReplace(a: string, b: string, deps: Partial<RenameDeps> = {}): NoReplaceResult {
  const d: RenameDeps = { sys: sysNoReplace, ...NODE_DEPS, ...deps };
  const r = d.sys(a, b);
  if (r === 0) return { method: "noreplace" };
  if (!isUnsupportedErrno(r)) throw osError("rename", a, errnoError(r), b);
  try {
    d.link(a, b);
  } catch (e) {
    if (isErrno(e, "EEXIST")) throw osError("rename", a, "EEXIST", b);
    // No hard links (FAT): lstat, then a plain rename.
    if (lstatIfExists(b) !== undefined) throw osError("rename", a, "EEXIST", b);
    try {
      d.rename(a, b);
    } catch (e2) {
      throw osError("rename", a, e2, b);
    }
    return { method: "rename" };
  }
  try {
    d.unlink(a);
  } catch (e) {
    if (isErrno(e, "ENOENT")) return { method: "link" };
    return { method: "link", unlinkError: osError("remove", a, e) };
  }
  return { method: "link" };
}
