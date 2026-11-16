// Automatic backups (spec §4.7, storage.md §5): folder and file names, writing one under the
// backups lock, rotation, listing in order, and matching backups to a vault by key block.

import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { h32 } from "../config/index.ts";
import { acquireLock, cleanLeftovers, createTempFile, fsyncDir, fsyncFd, isErrno, mkdirs, osError, renameNoReplace, writeAll } from "../fsx/index.ts";
import { errorf, T } from "../i18n/index.ts";
import { dataHeaderOpensWith, type X25519Identity } from "../keys/index.ts";
import { parseContainer } from "../vaultfile/index.ts";
import { compareUTF8 } from "../util/unicode.ts";
import type { CommandIO } from "../util/io.ts";
import { faultPoint, vaultTestHooks } from "./hooks.ts";
import { bytesEqual, readVaultBytes, stamp as makeStamp } from "./util.ts";

/** One automatic backup file. */
export interface BackupFile {
  /** The backups folder's name (`<dir>`). */
  folder: string;
  name: string;
  /** Absolute path. */
  path: string;
  seq: bigint;
  /** `YYYYMMDDTHHMMSSZ` from the name. */
  stamp: string;
  /** The revision of the file backed up, from the name. */
  revision: bigint;
}

/** A backups folder with its backups, newest first. */
export interface BackupFolder {
  name: string;
  path: string;
  backups: BackupFile[];
}

const DIR_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NAME_RE = /^([0-9]{1,20})-([0-9]{8}T[0-9]{6}Z)-r([0-9]{1,20})\.passh$/;
const MAX_SEQ = 1n << 62n;
const MAX_REV = (1n << 64n) - 1n;
/** storage.md §5.2: at most this many names are tried on EEXIST. */
const MAX_NAME_TRIES = 1000;

/** `<state>/backups`. */
export function backupsRoot(state: string): string {
  return join(state, "backups");
}

/** storage.md §5.1: `<dir>` = vault_id if it is a safe name (every UUID is), else `id-<h32(vault_id)>`. */
export function backupDirName(vaultId: string): string {
  return DIR_RE.test(vaultId) ? vaultId : "id-" + h32(vaultId);
}

/** `<state>/locks/backups-<h32(vault_id)>.lock`. */
export function backupsLockPath(state: string, vaultId: string): string {
  return join(state, "locks", `backups-${h32(vaultId)}.lock`);
}

/** The name of a backup: `<seq>-<stamp>-r<rev>.passh`, seq zero-padded to at least 8 digits. */
export function backupName(seq: bigint, stamp: string, revision: bigint): string {
  return `${seq.toString().padStart(8, "0")}-${stamp}-r${revision.toString()}.passh`;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** A valid stamp `YYYYMMDDTHHMMSSZ` (a real date and time; no leap second). */
export function validStamp(s: string): boolean {
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const h = Number(s.slice(9, 11));
  const mi = Number(s.slice(11, 13));
  const se = Number(s.slice(13, 15));
  if (mo < 1 || mo > 12) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = mo === 2 && leap ? 29 : MONTH_DAYS[mo - 1]!;
  return d >= 1 && d <= dim && h <= 23 && mi <= 59 && se <= 59;
}

/**
 * Parses a backup's file name (storage.md §5.1): `^(\d{1,20})-(\d{8}T\d{6}Z)-r(\d{1,20})\.passh$`
 * with 1 ≤ seq ≤ 2^62, a valid stamp and a revision that fits 64 bits. The seq-0 names of
 * development builds before v0.1.0 are not recognized (the spec allows ignoring them).
 */
export function parseBackupName(name: string): { seq: bigint; stamp: string; revision: bigint } | undefined {
  const m = NAME_RE.exec(name);
  if (!m) return undefined;
  const seq = BigInt(m[1]!);
  const revision = BigInt(m[3]!);
  if (seq < 1n || seq > MAX_SEQ || revision > MAX_REV || !validStamp(m[2]!)) return undefined;
  return { seq, stamp: m[2]!, revision };
}

/** Newest first (storage.md §5.3): seq descending; a tie by path ascending. */
export function compareNewestFirst(a: BackupFile, b: BackupFile): number {
  if (a.seq !== b.seq) return a.seq > b.seq ? -1 : 1;
  return compareUTF8(a.path, b.path);
}

/** The backups of one folder, newest first. A missing folder has none. Regular files only (no symlinks). */
export function listFolder(dir: string, folderName: string): BackupFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (isErrno(e, "ENOENT", "ENOTDIR")) return [];
    throw osError("open", dir, e);
  }
  const out: BackupFile[] = [];
  for (const name of names) {
    const p = parseBackupName(name);
    if (!p) continue;
    const path = join(dir, name);
    try {
      if (!lstatSync(path).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ folder: folderName, name, path, ...p });
  }
  return out.sort(compareNewestFirst);
}

/**
 * Every backups folder on the machine (`<state>/backups/*`, real folders only), in byte order
 * of their names, each with its backups newest first (storage.md §5.3). Folders without
 * backups are left out.
 */
export function listAllBackups(state: string): BackupFolder[] {
  const root = backupsRoot(state);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (e) {
    if (isErrno(e, "ENOENT", "ENOTDIR")) return [];
    throw osError("open", root, e);
  }
  const folders: BackupFolder[] = [];
  for (const ent of entries) {
    // SPEC-GAP: only real folders count (a symlink to a folder is ignored, like a symlinked backup).
    if (!ent.isDirectory()) continue;
    const path = join(root, ent.name);
    const backups = listFolder(path, ent.name);
    if (backups.length > 0) folders.push({ name: ent.name, path, backups });
  }
  return folders.sort((a, b) => compareUTF8(a.name, b.name));
}

/**
 * The folders that belong to a vault (storage.md §3.2 step 2): one of their backups has the
 * same key block bytes, or (with a key) a data block whose age header the key unwraps (header
 * only). Unreadable or unparsable backups are skipped for matching.
 */
export function matchingFolders(folders: BackupFolder[], keyBlock: Uint8Array | undefined, identity?: X25519Identity): BackupFolder[] {
  return folders.filter((f) =>
    f.backups.some((b) => {
      let c;
      try {
        c = parseContainer(readVaultBytes(b.path));
      } catch {
        return false;
      }
      if (keyBlock && keyBlock.length > 0 && bytesEqual(c.keyBlock, keyBlock)) return true;
      return identity !== undefined && dataHeaderOpensWith(c.dataBlock, identity);
    }),
  );
}

/** `YYYY-MM-DD HH:MM:SS` from a stamp. */
export function stampDisplay(s: string): string {
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}`;
}

/** One listing line: `YYYY-MM-DD HH:MM:SS  r<rev>  <path>` (the path as given). */
export function backupLine(b: BackupFile, path: string = b.path): string {
  return `${stampDisplay(b.stamp)}  r${b.revision}  ${path}`;
}

/**
 * The list that follows "data is damaged" (storage.md §3.2 steps 1–4), rendered in the
 * language when shown. Paths are absolute (audit #29: current behaviour kept; `passh backups`
 * uses `~/`).
 */
export class DamagedBackupList {
  constructor(
    readonly matched: boolean,
    readonly backups: BackupFile[],
  ) {}

  #render(tr: (s: string) => string): string {
    if (this.backups.length === 0) return "\n" + tr("no automatic backups of this vault were found; use another copy (passh verify --full <copy>)");
    const head = this.matched ? tr("automatic backups of this vault, newest first:") : tr("automatic backups on this machine, newest first:");
    return "\n" + head + this.backups.map((b) => "\n  " + backupLine(b)).join("");
  }

  toString(): string {
    return this.#render((s) => s);
  }

  localize(): string {
    return this.#render((s) => T(s));
  }
}

/** Builds the list for a vault's key block and the key that was used (storage.md §3.2). */
export function damagedBackupList(state: string, keyBlock: Uint8Array | undefined, identity?: X25519Identity): DamagedBackupList {
  let folders: BackupFolder[];
  try {
    folders = listAllBackups(state);
  } catch {
    folders = [];
  }
  const matched = matchingFolders(folders, keyBlock, identity);
  const use = matched.length > 0 ? matched : folders;
  return new DamagedBackupList(matched.length > 0, use.flatMap((f) => f.backups));
}

export interface WriteBackupOptions {
  state: string;
  vaultId: string;
  /** The vault's bytes as read at save step 6. */
  bytes: Uint8Array;
  /** The revision of the file backed up (the opened revision). */
  revision: bigint;
  /** `backup.keep` (> 0). */
  keep: number;
  /** The save's clock (step 3), as a stamp. */
  stamp?: string;
  /** The vault's real path: never removed by rotation. */
  vaultRealPath: string;
  io: CommandIO;
}

/**
 * Writes one backup (storage.md §5.2): under the backups lock, `mkdirs` the folder, clean
 * leftovers of `backup`, seq = highest + 1, temporary file, rename-no-replace to the name (on
 * EEXIST seq + 1, at most 1000 times), fsync the folder, rotate. Returns the backup's path.
 * Rotation failures are the warning `old automatic backups couldn't be removed: …`; other
 * failures throw (the caller adds `making the automatic backup: …; the vault is unchanged`).
 */
export async function writeBackup(o: WriteBackupOptions): Promise<string> {
  const lock = await acquireLock(backupsLockPath(o.state, o.vaultId), { timeoutMs: vaultTestHooks.lockTimeoutMs });
  try {
    const name = backupDirName(o.vaultId);
    const dir = join(backupsRoot(o.state), name);
    mkdirs(dir);
    cleanLeftovers(dir, "backup");
    const existing = listFolder(dir, name);
    let seq = existing.length > 0 ? existing.reduce((m, b) => (b.seq > m ? b.seq : m), 0n) + 1n : 1n;
    const st = o.stamp ?? makeStamp();
    const t = createTempFile(dir, "backup");
    let written = "";
    try {
      writeAll(t.fd, o.bytes, t.path);
      await faultPoint("backup-written", t.path);
      fsyncFd(t.fd, t.path);
      await faultPoint("backup-synced", t.path);
      for (let i = 0; ; i++) {
        const target = join(dir, backupName(seq, st, o.revision));
        try {
          renameNoReplace(t.path, target);
          written = target;
          break;
        } catch (e) {
          if (isErrno(e, "EEXIST") && i + 1 < MAX_NAME_TRIES) {
            seq++;
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      t.remove();
      throw e;
    }
    t.close();
    await faultPoint("backup-renamed", written);
    fsyncDir(dir);
    await faultPoint("backup-dir-synced", written);
    rotate(dir, name, o.keep, written, o.vaultRealPath, o.io);
    return written;
  } finally {
    lock.release();
  }
}

/**
 * Rotation (storage.md §5.3): keep the first `keep` (newest first), unlink the rest, never the
 * backup just written nor the vault's real path. Failures warn.
 */
export function rotate(dir: string, folderName: string, keep: number, justWritten: string, vaultRealPath: string, io: CommandIO): void {
  const errs: Error[] = [];
  let list: BackupFile[];
  try {
    list = listFolder(dir, folderName);
  } catch (e) {
    io.warn(T("old automatic backups couldn't be removed: %v", e));
    return;
  }
  for (const b of list.slice(keep)) {
    if (b.path === justWritten || b.path === vaultRealPath) continue;
    try {
      unlinkSync(b.path);
    } catch (e) {
      if (isErrno(e, "ENOENT")) continue;
      errs.push(osError("remove", b.path, e));
    }
  }
  if (errs.length > 0) {
    // SPEC-GAP: several failures: one warning, the errors joined by "; ".
    io.warn(T("old automatic backups couldn't be removed: %v", errorf("%s", errs.map((e) => e.message).join("; "))));
  }
}
