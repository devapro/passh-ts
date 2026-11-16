// The temporary base of `edit --editor` (agent-session.md §A6, S1), Linux only:
// $XDG_RUNTIME_DIR if absolute, a real directory (not a symlink) owned by the user, and on
// tmpfs or ramfs (statfs magic 0x01021994 / 0x858458f6); else /dev/shm if a directory on
// tmpfs/ramfs. Nothing else. Elsewhere (macOS, even with a tmpfs mounted) there is none.

import { lstatSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { codedError, type PasshError } from "../i18n/index.ts";
import { getuid, IS_LINUX, RAMFS_MAGIC, statfs, TMPFS_MAGIC } from "../ffi/libc.ts";

/** Prefix of the edit folders (doctor lists leftovers). */
export const EDIT_DIR_PREFIX = "passh-edit-";

/** Reports whether path is on tmpfs or ramfs (Linux statfs magic). */
export function onMemoryFs(path: string): boolean {
  if (!IS_LINUX) return false;
  const s = statfs(path);
  if (typeof s === "number") return false;
  return s.type === TMPFS_MAGIC || s.type === RAMFS_MAGIC;
}

function xdgRuntimeDir(env: Record<string, string | undefined>): string | undefined {
  const v = env.XDG_RUNTIME_DIR;
  return v === undefined || v === "" ? undefined : v;
}

function xdgOk(dir: string): boolean {
  if (!isAbsolute(dir)) return false;
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory()) return false;
    if (st.uid !== getuid()) return false;
  } catch {
    return false;
  }
  return onMemoryFs(dir);
}

function shmOk(): boolean {
  try {
    if (!statSync("/dev/shm").isDirectory()) return false;
  } catch {
    return false;
  }
  return onMemoryFs("/dev/shm");
}

export type TmpBase = { ok: true; base: string } | { ok: false; error: PasshError };

/**
 * The folder that will hold the edit folder, or the reason there is none (code "no-tmpfs"):
 * `no tmpfs for the temporary file (checked $XDG_RUNTIME_DIR (<value>) and /dev/shm): the
 * entry would be written to disk in plain text; use the built-in form (passh edit without
 * --editor)`. The CLI adds `; using the built-in form instead` to its note.
 */
export function findTmpBase(env: Record<string, string | undefined> = process.env): TmpBase {
  const tail = "the entry would be written to disk in plain text; use the built-in form (passh edit without --editor)";
  if (!IS_LINUX) {
    // SPEC-GAP: the spec gives no wording for systems other than Linux.
    return { ok: false, error: codedError("no-tmpfs", "no tmpfs for the temporary file (passh looks for one only on Linux): " + tail) };
  }
  const xdg = xdgRuntimeDir(env);
  if (xdg !== undefined && xdgOk(xdg)) return { ok: true, base: xdg };
  if (shmOk()) return { ok: true, base: "/dev/shm" };
  if (xdg !== undefined) return { ok: false, error: codedError("no-tmpfs", "no tmpfs for the temporary file (checked $XDG_RUNTIME_DIR (%s) and /dev/shm): " + tail, xdg) };
  return { ok: false, error: codedError("no-tmpfs", "no tmpfs for the temporary file (checked /dev/shm): " + tail) };
}

/**
 * The user's leftover `passh-edit-*` folders in both bases ($XDG_RUNTIME_DIR if absolute,
 * then /dev/shm), absolute paths, for doctor (§A6 "Cleanup"). Only real directories owned
 * by the user count.
 */
export function leftoverEditFolders(env: Record<string, string | undefined> = process.env): string[] {
  const bases: string[] = [];
  const xdg = xdgRuntimeDir(env);
  if (xdg !== undefined && isAbsolute(xdg)) bases.push(xdg);
  if (!bases.includes("/dev/shm")) bases.push("/dev/shm");
  const uid = getuid();
  const out: string[] = [];
  for (const base of bases) {
    let names: string[];
    try {
      names = readdirSync(base);
    } catch {
      continue;
    }
    for (const n of names.sort()) {
      if (!n.startsWith(EDIT_DIR_PREFIX)) continue;
      const p = join(base, n);
      try {
        const st = lstatSync(p);
        if (st.isDirectory() && st.uid === uid && !out.includes(p)) out.push(p);
      } catch {
        /* vanished */
      }
    }
  }
  return out;
}
