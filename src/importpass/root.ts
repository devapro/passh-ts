// The pass store opened as a root (import-export.md §1.2–§1.3, §1.5; spec §4.9, §13.2 item 1):
// every path is resolved inside the store, one component at a time, following symlinks only
// while they stay inside it, like Go's os.Root (the reference walks an os.Root):
//
// - an absolute symlink target always counts as leaving the store, even when it points into it;
// - `..` that would go above the store's folder leaves it, also inside a chain of links;
// - at most 8 symlinks are followed in one resolution (more: ELOOP, "too many levels of
//   symbolic links");
// - every component before the last must be a folder (ENOTDIR), `.` components are dropped,
//   a trailing `/` makes the last component a folder.
//
// Names are bytes (Buffer): store file names need not be UTF-8 (§1.4 "it is not valid UTF-8").
// Files are opened by their resolved real path with O_NOFOLLOW; on Linux the open descriptor's
// /proc/self/fd link is then checked to lie inside the store, so a folder swapped for a
// symlink between the resolution and the open is caught ("path escapes from parent").

import { closeSync, constants as C, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, realpathSync, statSync, type Stats } from "node:fs";
import { errorf } from "../i18n/index.ts";
import { Errno, osError, toErrno } from "../fsx/oserror.ts";

// SPEC-GAP: §1.3 doesn't give the number of links followed; the reference stops at 8 (a chain
// of 9 links is `unreadable: too many levels of symbolic links`), Go's os.Root limit.
/** Go's os.Root limit on the symlinks followed in one resolution (observed on the reference: 8). */
export const ROOT_MAX_SYMLINKS = 8;

/** Go's errPathEscapes: a path, or a symlink on it, leads outside the root. */
export class PathEscapesError extends Error {
  constructor() {
    super("path escapes from parent");
    this.name = "PathEscapesError";
  }
}

const SLASH = 0x2f;
const EMPTY = Buffer.alloc(0);

/** Splits a store-relative path into components: repeated `/` collapse, `.` dropped except last. */
function splitComponents(p: Buffer): { parts: Buffer[]; trailingSlash: boolean } {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i <= p.length; i++) {
    if (i < p.length && p[i] !== SLASH) continue;
    if (i > start) parts.push(p.subarray(start, i));
    start = i + 1;
  }
  const trailingSlash = p.length > 0 && p[p.length - 1] === SLASH;
  // "." components are removed, except at the end (Go's splitPathInRoot).
  const out = parts.filter((c, k) => !(isDot(c) && k < parts.length - 1));
  return { parts: out, trailingSlash };
}

function isDot(c: Buffer): boolean {
  return c.length === 1 && c[0] === 0x2e;
}

function isDotDot(c: Buffer): boolean {
  return c.length === 2 && c[0] === 0x2e && c[1] === 0x2e;
}

/** Joins components with `/`. */
export function joinRel(...parts: Buffer[]): Buffer {
  const out: Buffer[] = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push(Buffer.from("/"));
    out.push(p);
  });
  return Buffer.concat(out);
}

export interface Resolved {
  /** The real components (no symlinks, no `.`/`..`) below the store; [] is the store itself. */
  parts: Buffer[];
  /** stat of the resolved file (follows nothing: it is not a symlink). */
  stats: Stats;
}

/** An opened pass store. */
export class StoreRoot {
  /** The store as given (absolute, cleaned): `‹dir›` in messages. */
  readonly dir: string;
  /** The store folder's real path, as bytes. */
  readonly real: Buffer;
  #fd: number;

  private constructor(dir: string, real: Buffer, fd: number) {
    this.dir = dir;
    this.real = real;
    this.#fd = fd;
  }

  /**
   * Opens the store folder (§1.2), following a symlinked store. A missing store, or one
   * that isn't a folder, fails with `pass store: open ‹dir›: ‹OS error›`.
   */
  static open(dir: string): StoreRoot {
    let fd: number;
    try {
      fd = openSync(dir, C.O_RDONLY | (C.O_DIRECTORY ?? 0));
    } catch (e) {
      throw errorf("pass store: %w", osError("open", dir, e));
    }
    let real: Buffer;
    try {
      real = Buffer.from(realpathSync(Buffer.from(dir), { encoding: "buffer" }));
    } catch (e) {
      closeSync(fd);
      throw errorf("pass store: %w", osError("open", dir, e));
    }
    return new StoreRoot(dir, real, fd);
  }

  close(): void {
    if (this.#fd < 0) return;
    try {
      closeSync(this.#fd);
    } catch {
      /* ignored */
    }
    this.#fd = -1;
  }

  /** The absolute path (bytes) of real components below the store. */
  abs(parts: readonly Buffer[]): Buffer {
    if (parts.length === 0) return this.real;
    return Buffer.concat([this.real, Buffer.from("/"), joinRel(...parts)]);
  }

  /** lstat of a real store-relative path (no symlink on the way). Throws Errno. */
  lstat(rel: Buffer): Stats {
    try {
      return lstatSync(rel.length === 0 ? this.real : this.abs([rel]));
    } catch (e) {
      throw toErrno(e);
    }
  }

  /**
   * Checks that a real folder of the store can be listed and its entries reached (read and
   * search permission), then lists it: the names, `.` and `..` excluded, sorted by bytes.
   * Throws Errno (e.g. EACCES "permission denied").
   */
  // SPEC-GAP: §1.3 "a folder that can't be listed": on the reference a folder without search
  // permission (mode 0600) counts too (`unreadable: permission denied`), not only one without
  // read permission; so both are checked.
  readDir(rel: Buffer): Buffer[] {
    const p = rel.length === 0 ? this.real : this.abs([rel]);
    try {
      statSync(Buffer.concat([p, Buffer.from("/.")]));
      const names = readdirSync(p, { encoding: "buffer" }) as unknown as Buffer[];
      return names.map((n) => Buffer.from(n)).sort(Buffer.compare);
    } catch (e) {
      throw toErrno(e);
    }
  }

  /**
   * Resolves a store-relative path inside the store (Go's os.Root rules, see the file
   * comment). With `followLast`, a symlink in the last component is followed too (root.Stat);
   * otherwise it is returned as the symlink (root.Lstat). Throws PathEscapesError, or an
   * Errno (ENOENT, ENOTDIR, EACCES, ELOOP, ENAMETOOLONG, …).
   */
  resolve(rel: Buffer, followLast = true): Resolved {
    let { parts, trailingSlash } = splitComponents(rel);
    let symlinks = 0;
    let i = 0;
    for (;;) {
      if (i >= parts.length) {
        // the store folder itself
        return { parts: [], stats: this.lstat(EMPTY) };
      }
      const part = parts[i]!;
      const last = i === parts.length - 1;
      if (isDotDot(part)) {
        if (i === 0) throw new PathEscapesError();
        parts = [...parts.slice(0, i - 1), ...parts.slice(i + 1)];
        i--;
        if (parts.length === 0) return { parts: [], stats: this.lstat(EMPTY) };
        continue;
      }
      if (isDot(part)) {
        if (!last) {
          // a `.` spliced in from a link target
          parts = [...parts.slice(0, i), ...parts.slice(i + 1)];
          continue;
        }
        // the last component: the folder resolved so far
        const dirParts = parts.slice(0, i);
        const st = this.statReal(dirParts);
        if (!st.isDirectory()) throw new Errno("ENOTDIR");
        return { parts: dirParts, stats: st };
      }
      const here = parts.slice(0, i + 1);
      const st = this.statReal(here);
      if (st.isSymbolicLink() && (!last || followLast || trailingSlash)) {
        if (++symlinks > ROOT_MAX_SYMLINKS) throw new Errno("ELOOP");
        let target: Buffer;
        try {
          target = Buffer.from(readlinkSync(this.abs(here), { encoding: "buffer" }));
        } catch (e) {
          throw toErrno(e);
        }
        if (target.length === 0) throw new Errno("ENOENT");
        if (target[0] === SLASH) throw new PathEscapesError();
        const t = splitComponents(target);
        if (last) trailingSlash = t.trailingSlash;
        parts = [...parts.slice(0, i), ...t.parts, ...parts.slice(i + 1)];
        continue;
      }
      if ((!last || trailingSlash) && !st.isDirectory()) throw new Errno("ENOTDIR");
      if (last) return { parts: here, stats: st };
      i++;
    }
  }

  /** root.Stat: the file a store-relative path leads to, following symlinks inside the store. */
  stat(rel: Buffer): Stats {
    return this.resolve(rel, true).stats;
  }

  private statReal(parts: readonly Buffer[]): Stats {
    try {
      return lstatSync(this.abs(parts));
    } catch (e) {
      throw toErrno(e);
    }
  }

  /**
   * Opens a store file for reading through the root (§1.5): resolved inside the store, then
   * opened `O_RDONLY|O_NONBLOCK|O_NOFOLLOW`; on Linux the descriptor's real location is
   * checked to be the resolved path. Returns the descriptor; the caller checks its type with
   * fstat and closes it. Throws PathEscapesError or Errno.
   */
  openFile(rel: Buffer): number {
    const r = this.resolve(rel, true);
    const p = this.abs(r.parts);
    let fd: number;
    try {
      fd = openSync(p, C.O_RDONLY | C.O_NONBLOCK | C.O_NOFOLLOW);
    } catch (e) {
      // O_NOFOLLOW on a symlink: the file was swapped for a link after the resolution.
      const err = toErrno(e);
      if (err instanceof Errno && err.code === "ELOOP") throw new PathEscapesError();
      throw err;
    }
    if (process.platform === "linux") {
      let where: Buffer | undefined;
      try {
        where = Buffer.from(readlinkSync(`/proc/self/fd/${fd}`, { encoding: "buffer" }));
      } catch {
        where = undefined; // no /proc: nothing to check
      }
      if (where !== undefined && !where.equals(p)) {
        closeSync(fd);
        throw new PathEscapesError();
      }
    }
    return fd;
  }
}

/** fstat of an open descriptor; throws Errno. */
export function fstatFd(fd: number): Stats {
  try {
    return fstatSync(fd);
  } catch (e) {
    throw toErrno(e);
  }
}
