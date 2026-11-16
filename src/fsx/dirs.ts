// Creating folders (storage.md §1.3).

import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { codedError, errorf } from "../i18n/index.ts";
import { fsyncDir } from "./files.ts";
import { isErrno, osError } from "./oserror.ts";

/** The prefixes of an absolute path from the top: /a/b/c → ["/a", "/a/b", "/a/b/c"]. */
function prefixes(dir: string): string[] {
  const parts = dir.split("/").filter((p) => p !== "");
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    cur += "/" + p;
    out.push(cur);
  }
  return out;
}

function isDirOrMissing(p: string): boolean | undefined {
  try {
    return statSync(p).isDirectory();
  } catch (e) {
    if (isErrno(e, "ENOENT")) return undefined;
    throw osError("stat", p, e);
  }
}

/**
 * mkdirs (storage.md §1.3), for the vault's folder, `<state>` and everything under it:
 * for each missing component from the top, `mkdir` 0700, `chmod 0700` (the umask doesn't
 * apply) and fsync the parent. An existing component that isn't a folder fails with
 * `<path> is not a folder` (code "not-folder"); existing folders are never changed or
 * checked (symlinks to folders are followed). `dir` must be absolute.
 */
export function mkdirs(dir: string): void {
  if (!dir.startsWith("/")) throw errorf("mkdirs: %s is not an absolute path", dir);
  for (const p of prefixes(dir)) {
    const isDir = isDirOrMissing(p);
    if (isDir === true) continue;
    if (isDir === false) throw notFolder(p);
    try {
      mkdirSync(p, { mode: 0o700 });
    } catch (e) {
      if (isErrno(e, "EEXIST")) {
        // Created meanwhile by someone else: use it if it is a folder.
        if (isDirOrMissing(p) === true) continue;
        throw notFolder(p);
      }
      throw osError("mkdir", p, e);
    }
    try {
      chmodSync(p, 0o700);
    } catch (e) {
      throw osError("chmod", p, e);
    }
    fsyncDir(dirname(p));
  }
}

function notFolder(p: string) {
  return codedError("not-folder", "%s is not a folder", p);
}

/**
 * `mkdir -p` with `mode` reduced by the umask (storage.md §1.3 exceptions: the config
 * file's folders, and the parents of `<state>` when `unlock` creates it), like Go's
 * os.MkdirAll: an existing folder is fine; an existing non-folder fails with
 * `mkdir <path>: not a directory`; other errors read `mkdir <path>: …`.
 */
export function mkdirP(dir: string, mode = 0o700): void {
  if (!dir.startsWith("/")) throw errorf("mkdirP: %s is not an absolute path", dir);
  for (const p of prefixes(dir)) {
    const isDir = isDirOrMissing(p);
    if (isDir === true) continue;
    if (isDir === false) throw osError("mkdir", p, "ENOTDIR");
    try {
      mkdirSync(p, { mode });
    } catch (e) {
      if (isErrno(e, "EEXIST") && isDirOrMissing(p) === true) continue;
      throw osError("mkdir", p, e);
    }
  }
}
