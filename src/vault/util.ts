// Small helpers of the storage layer: hashes, stamps, paths, reading a vault file.

import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { realPath, stateDir, type Env } from "../config/index.ts";
import { errnoCode, readRegularFile } from "../fsx/index.ts";
import { errFileTooLarge, errNotRegularFile, MAX_VAULT_FILE_SIZE } from "../vaultfile/index.ts";
import { hasCode } from "../i18n/index.ts";
import { nowMs } from "./hooks.ts";

/** Lower-case hex SHA-256. */
export function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** storage.md §0 **stamp**: UTC `YYYYMMDDTHHMMSSZ`. */
export function stamp(ms: number = nowMs()): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** `YYYYMMDD-HHMMSS` in UTC (`passh backup` into a folder, storage.md §6.1). */
export function backupFileStamp(ms: number = nowMs()): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/** Reports whether `child` is strictly inside folder `parent` (both absolute and clean). */
export function isInside(child: string, parent: string): boolean {
  if (parent === "/") return child !== "/" && child.startsWith("/");
  return child.startsWith(parent + "/");
}

/** The real path of `<state>/backups`, or undefined when it doesn't exist (nothing can be inside it). */
export function realBackupsDir(state: string): string | undefined {
  try {
    return realPath(state + "/backups");
  } catch {
    return undefined;
  }
}

/** Reports whether a real path lies inside the real path of `<state>/backups/` (storage.md §5.5). */
export function inBackupsFolder(real: string, state: string): boolean {
  const b = realBackupsDir(state);
  return b !== undefined && isInside(real, b);
}

/** `<state>` from the environment (`$HOME is not set` when it can't be computed). */
export function stateFolder(env: Env): string {
  return stateDir(env);
}

/** The vault file's name minus a trailing `.passh` (conflict files, `passh backup` into a folder). */
export function baseName(path: string): string {
  const b = basename(path);
  return b.endsWith(".passh") ? b.slice(0, -".passh".length) : b;
}

export { dirname, basename };

/**
 * Reads a vault file for opening or copying (storage.md §1.4 limits, §3.1 step 2):
 * `not a passh vault: not a regular file` (code not-regular), `not a passh vault: the file is
 * larger than 64 MiB` (code too-large), or the OS error (`open <path>: …`). The caller adds
 * `<path>: ` before the first two and its own context before OS errors.
 */
export function readVaultBytes(path: string): Uint8Array {
  try {
    return readRegularFile(path, MAX_VAULT_FILE_SIZE);
  } catch (e) {
    if (hasCode(e, "not-regular")) throw errNotRegularFile();
    if (hasCode(e, "too-large")) throw errFileTooLarge();
    throw e;
  }
}

/** Reports whether an error is a vault-shape error (not regular, too large) rather than an OS error. */
export function isShapeError(e: unknown): boolean {
  return hasCode(e, "not-regular") || hasCode(e, "too-large");
}

/** Reports whether an error is ENOENT (or ENOTDIR: a component is gone). */
export function isMissing(e: unknown): boolean {
  const c = errnoCode(e);
  return c === "ENOENT" || c === "ENOTDIR";
}

/** Byte equality. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
