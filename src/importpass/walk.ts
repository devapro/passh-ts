// The walk of the store (import-export.md §1.3) and the path mapping and planning (§1.4).
// Nothing is read or decrypted here.

import { errorf } from "../i18n/index.ts";
import { errnoCode, osError, toErrno } from "../fsx/oserror.ts";
import { findEntry } from "../model/ops.ts";
import type { VaultData } from "../model/types.ts";
import { parsePath, pathProblem } from "../paths/index.ts";
import { escapeLine } from "../sanitize/index.ts";
import { joinRel, PathEscapesError, StoreRoot } from "./root.ts";
import type { Skip } from "./skips.ts";
import { statSync } from "node:fs";

const GPG = Buffer.from(".gpg");

function isGpgName(name: Buffer): boolean {
  return name.length >= GPG.length && name.subarray(name.length - GPG.length).equals(GPG);
}

export interface WalkResult {
  /** The files to import, store-relative, in walk order (depth-first, pre-order, names by bytes). */
  files: Buffer[];
  /** Items skipped by the walk. */
  skips: Skip[];
}

const notFollowed = () => errorf("not followed");

/**
 * What a symlink found by the walk leads to (§1.3 second table), resolved inside the store:
 * "plan" (a `.gpg` link to a regular file), a skip, or null (ignored silently).
 */
function classifyLink(root: StoreRoot, rel: Buffer, gpg: boolean): "plan" | Skip | null {
  let st;
  try {
    st = root.stat(rel);
  } catch (e) {
    if (e instanceof PathEscapesError) return { file: rel, reason: "outside", detail: notFollowed() };
    const code = errnoCode(e);
    if (code === "ENOENT") return gpg ? { file: rel, reason: "broken" } : null;
    if (code === "ELOOP" || code === "EACCES" || code === "EPERM") return gpg ? { file: rel, reason: "unreadable", detail: toErrno(e) } : null;
    // SPEC-GAP: §1.3 lists permission errors and loops as `unreadable`; other errors of the
    // resolution (a file used as a folder, ENOTDIR; a name too long, ENAMETOOLONG) are reported
    // as leading outside the store, for both kinds of names, as the reference does.
    return { file: rel, reason: "outside", detail: notFollowed() };
  }
  if (st.isDirectory()) return { file: rel, reason: "folder-link", detail: notFollowed() };
  if (st.isFile()) return gpg ? "plan" : null;
  return gpg ? { file: rel, reason: "not-regular" } : null;
}

/**
 * Walks the store (§1.3): depth-first, pre-order, each folder's names in byte order. Names
 * starting with `.` are ignored (a folder isn't entered); folders are entered (also one named
 * `x.gpg`); regular `.gpg` files are planned; FIFOs, devices and sockets named `.gpg` are
 * skipped; symlinks are resolved through the root (classifyLink); a folder that can't be listed
 * is skipped as `unreadable`. If the store folder itself can't be read the walk fails:
 * `pass store ‹dir›: ‹error›`.
 */
export function walkStore(root: StoreRoot): WalkResult {
  const files: Buffer[] = [];
  const skips: Skip[] = [];
  // fs.WalkDir starts with a stat of the root.
  try {
    statSync(Buffer.concat([root.real, Buffer.from("/.")]));
  } catch (e) {
    throw errorf("pass store %s: %w", root.dir, osError("statat", ".", e));
  }
  let top: Buffer[];
  try {
    top = root.readDir(Buffer.alloc(0));
  } catch (e) {
    // SPEC-GAP: §1.2 gives `pass store ‹dir›: ‹error›` without the error's form; the stat
    // above reads `statat .: …` as on the reference; this listing error (not reachable once the
    // folder opened and passed that stat) is written `openat .: …`.
    throw errorf("pass store %s: %w", root.dir, osError("openat", ".", e));
  }
  const visit = (dir: Buffer, names: Buffer[]): void => {
    for (const name of names) {
      if (name[0] === 0x2e) continue; // `.git`, `.gpg-id`, `.extensions`, …
      const rel = dir.length === 0 ? name : joinRel(dir, name);
      const gpg = isGpgName(name);
      let st;
      try {
        st = root.lstat(rel);
      } catch (e) {
        // Gone since the listing: ignored, like a file that disappears during fs.WalkDir.
        if (errnoCode(e) === "ENOENT") continue;
        if (gpg) skips.push({ file: rel, reason: "unreadable", detail: toErrno(e) });
        continue;
      }
      if (st.isDirectory()) {
        let sub: Buffer[];
        try {
          sub = root.readDir(rel);
        } catch (e) {
          skips.push({ file: rel, reason: "unreadable", detail: toErrno(e) });
          continue;
        }
        visit(rel, sub);
      } else if (st.isFile()) {
        if (gpg) files.push(rel);
      } else if (st.isSymbolicLink()) {
        const c = classifyLink(root, rel, gpg);
        if (c === "plan") files.push(rel);
        else if (c) skips.push(c);
      } else if (gpg) {
        skips.push({ file: rel, reason: "not-regular" });
      }
    }
  };
  visit(Buffer.alloc(0), top);
  return { files, skips };
}

/** A file planned for import (§1.4). */
export interface PlanItem {
  /** The store file, store-relative. */
  file: Buffer;
  /** The entry path: the file path without `.gpg`, validated and in NFC. */
  path: string;
  /** The vault already has this path and `--overwrite` was given. */
  replace: boolean;
}

export interface Plan {
  items: PlanItem[];
  skips: Skip[];
}

/**
 * Path mapping and planning (§1.4), in walk order: one trailing `.gpg` removed and the path
 * validator applied (`invalid path: ‹rule›`); a path an earlier file produced is a duplicate
 * (`same path as ‹earlier file›`); a path the vault has is skipped (`use --overwrite to replace
 * it`) unless `overwrite`, which plans a replace.
 */
export function planImport(files: readonly Buffer[], data: Pick<VaultData, "entries">, overwrite: boolean): Plan {
  const items: PlanItem[] = [];
  const skips: Skip[] = [];
  const seen = new Map<string, Buffer>();
  for (const file of files) {
    const bare = file.subarray(0, file.length - GPG.length);
    const problem = pathProblem(bare);
    if (problem) {
      skips.push({ file, reason: "invalid-path", detail: problem });
      continue;
    }
    const path = parsePath(bare);
    const earlier = seen.get(path);
    if (earlier) {
      skips.push({ file, reason: "duplicate", detail: errorf("same path as %s", escapeLine(earlier)) });
      continue;
    }
    seen.set(path, file);
    const exists = findEntry(data as VaultData, path) !== undefined;
    if (exists && !overwrite) {
      skips.push({ file, reason: "in-vault", detail: errorf("use --overwrite to replace it") });
      continue;
    }
    items.push({ file, path, replace: exists });
  }
  return { items, skips };
}
