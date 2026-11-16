// File system type checks (agent-session.md §A6: the editor's tmpfs base; the plaintext
// warnings of export and print, which count a memory file system as not persistent).

import { IS_DARWIN, RAMFS_MAGIC, statfs, TMPFS_MAGIC, uname, type StatfsInfo } from "../ffi/libc.ts";
import { errnoError, osError } from "./oserror.ts";

/** statfs(2) of a path; errors read `statfs <path>: <reason>`. */
export function fsType(path: string): StatfsInfo {
  const r = statfs(path);
  if (typeof r === "number") throw osError("statfs", path, errnoError(r));
  return r;
}

/** The file system's magic number (Linux f_type; on macOS f_type, which isn't a magic number). */
export function fsMagic(path: string): number {
  return fsType(path).type;
}

/**
 * Reports whether the path is on a memory file system: Linux tmpfs or ramfs (statfs
 * magic 0x01021994 / 0x858458f6), macOS `tmpfs` (f_fstypename). Errors as fsType.
 * Note: `edit --editor` uses no base at all on macOS (§A6), whatever this returns.
 */
export function isTmpfs(path: string): boolean {
  const t = fsType(path);
  if (IS_DARWIN) return t.typeName === "tmpfs";
  return t.type === TMPFS_MAGIC || t.type === RAMFS_MAGIC;
}

/** The host name for the passphrase-strength user inputs (uname nodename; "" if unknown). */
export function nodeName(): string {
  const u = uname();
  return typeof u === "number" ? "" : u.nodename;
}
