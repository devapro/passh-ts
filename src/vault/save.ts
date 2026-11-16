// Saving (spec §4.6, storage.md §4): locks, the change check, encryption, the temporary file,
// the read-back, the automatic backup, the exchange with put-back, the rollback record.

import { unlinkSync } from "node:fs";
import { join } from "node:path";
import type { X25519Identity } from "../age/index.ts";
import { h32, realPath } from "../config/index.ts";
import {
  acquireLock,
  cleanLeftovers,
  createTempFile,
  exchange,
  fsyncDir,
  fsyncFd,
  isErrno,
  mkdirs,
  osError,
  OSError,
  readRegularFile,
  rename,
  renameNoReplace,
  writeAll,
  type FileLock,
  type TempFile,
} from "../fsx/index.ts";
import { errorf, hasCode, T, type PasshError } from "../i18n/index.ts";
import { decryptData } from "../keys/index.ts";
import { encryptData } from "../keys/index.ts";
import { parseVaultData, prepareSave, serializeVaultData, validateVaultData } from "../model/index.ts";
import type { VaultData } from "../model/types.ts";
import { encodeContainer, MAX_VAULT_FILE_SIZE, parseContainer } from "../vaultfile/index.ts";
import { writeBackup } from "./backups.ts";
import { errBusy, errCancelled, errChanged, errInBackups, errKeyBlockDamaged } from "./errors.ts";
import { faultPoint, nowMs, vaultTestHooks } from "./hooks.ts";
import { updateRecordOrWarn } from "./rollback.ts";
import { vaultLockName, type VaultState } from "./state.ts";
import type { SaveOptions } from "./types.ts";
import { baseName, basename, bytesEqual, dirname, inBackupsFolder, isMissing, isShapeError, sha256Hex, stamp } from "./util.ts";

/** Takes the vault lock (storage.md §4.2 step 1): `mkdirs <state>/locks`, then the lock file. */
export async function takeVaultLock(state: string, real: string, signal?: AbortSignal): Promise<FileLock> {
  const locks = join(state, "locks");
  try {
    mkdirs(locks);
  } catch (e) {
    throw errorf("creating the state folder: %w", e);
  }
  try {
    return await acquireLock(join(locks, vaultLockName(h32(real))), { timeoutMs: vaultTestHooks.lockTimeoutMs, signal });
  } catch (e) {
    if (hasCode(e, "lock-busy")) throw errBusy(e);
    if (e instanceof OSError) throw errorf("opening the lock file: %w", e);
    throw e;
  }
}

/** Reads the vault again (steps 2 and 6): its hash, or "changed" when it is gone or not a vault-shaped file. */
function rereadHash(real: string): string {
  let b: Uint8Array;
  try {
    b = readRegularFile(real, MAX_VAULT_FILE_SIZE);
  } catch (e) {
    // SPEC-GAP: a file that is no longer a regular file of at most 64 MiB can't be the one
    // opened: "changed", like a missing one.
    if (isMissing(e) || isShapeError(e)) throw errChanged();
    throw errorf("reading the vault file again: %w", e);
  }
  return sha256Hex(b);
}

function rereadBytes(real: string): Uint8Array {
  try {
    return readRegularFile(real, MAX_VAULT_FILE_SIZE);
  } catch (e) {
    if (isMissing(e) || isShapeError(e)) throw errChanged();
    throw errorf("reading the vault file again: %w", e);
  }
}

/** The new file as bytes (step 3). */
export interface Encoded {
  data: VaultData;
  json: Uint8Array;
  keyBlock: Uint8Array;
  file: Uint8Array;
  hash: string;
}

/** Step 3: the next revision, saved_at, serialize, encrypt, encode the canonical container. */
export function encodeVault(data: VaultData, openedRevision: bigint, keyBlock: Uint8Array, identity: X25519Identity, nowSec: number, fixedRevision?: bigint): Encoded {
  const saved = prepareSave(data, openedRevision, nowSec);
  if (fixedRevision !== undefined) saved.revision = fixedRevision;
  validateVaultData(saved);
  const json = serializeVaultData(saved);
  const dataBlock = encryptData(json, identity);
  const file = encodeContainer(keyBlock, dataBlock);
  return { data: saved, json, keyBlock, file, hash: sha256Hex(file) };
}

/** Steps 4–5: the temporary file and its read-back. Any failure removes it. */
export async function writeAndCheck(dir: string, name: string, enc: Encoded, identity: X25519Identity): Promise<TempFile> {
  let t: TempFile;
  try {
    t = createTempFile(dir, name);
  } catch (e) {
    throw errorf("writing the new vault file: %w; the vault is unchanged", e);
  }
  try {
    writeAll(t.fd, enc.file, t.path);
    await faultPoint("temp-written", t.path);
    fsyncFd(t.fd, t.path);
    await faultPoint("temp-synced", t.path);
  } catch (e) {
    t.remove();
    throw errorf("writing the new vault file: %w; the vault is unchanged", e);
  }
  const problem = readBackProblem(t.path, enc, identity);
  if (problem) {
    t.remove();
    throw errorf("the new vault file didn't read back as written; the vault is unchanged: %w", problem);
  }
  await faultPoint("read-back", t.path);
  return t;
}

/**
 * Step 5: same bytes; parses; same key block; the data block decrypts with the key; the
 * plaintext equals a fresh serialization; it decodes with the same vault_id, revision and
 * number of entries. Returns the problem, or undefined.
 * SPEC-GAP: the spec gives no texts for the details; these are ours.
 */
function readBackProblem(path: string, enc: Encoded, identity: X25519Identity): Error | undefined {
  try {
    const back = readRegularFile(path, MAX_VAULT_FILE_SIZE);
    if (!bytesEqual(back, enc.file)) return errorf("the bytes read differ from those written");
    const c = parseContainer(back);
    if (!bytesEqual(c.keyBlock, enc.keyBlock)) return errorf("the key block differs");
    const plain = decryptData(c.dataBlock, identity, "passphrase");
    try {
      if (!bytesEqual(plain, serializeVaultData(enc.data))) return errorf("the data differs from what was serialized");
      const d = parseVaultData(plain);
      if (d.vaultId !== enc.data.vaultId || d.revision !== enc.data.revision || d.entries.length !== enc.data.entries.length) {
        return errorf("vault_id, revision or number of entries differ");
      }
    } finally {
      plain.fill(0);
    }
    return undefined;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/** `<path> (a temporary name: move it elsewhere before the next save, which would remove it)`. */
class TempNameNote {
  constructor(readonly path: string) {}
  toString(): string {
    return `${this.path} (a temporary name: move it elsewhere before the next save, which would remove it)`;
  }
  localize(): string {
    return T("%s (a temporary name: move it elsewhere before the next save, which would remove it)", this.path);
  }
}

/**
 * Move aside (storage.md §4.3 step 3): rename-no-replace to `<base>.conflict-<stamp>.passh`,
 * then `-2` … `-99`. If none works, the file stays at its temporary name.
 */
export function moveAside(tempPath: string, real: string): string | TempNameNote {
  const dir = dirname(real);
  const base = baseName(real);
  const st = stamp();
  for (let n = 1; n <= 99; n++) {
    const target = join(dir, n === 1 ? `${base}.conflict-${st}.passh` : `${base}.conflict-${st}-${n}.passh`);
    try {
      renameNoReplace(tempPath, target);
      return target;
    } catch (e) {
      if (isErrno(e, "EEXIST")) continue;
      break;
    }
  }
  return new TempNameNote(tempPath);
}

function readOld(path: string): { kind: "bytes"; bytes: Uint8Array } | { kind: "other" } | { kind: "missing" } | { kind: "unreadable"; error: unknown } {
  try {
    return { kind: "bytes", bytes: readRegularFile(path, MAX_VAULT_FILE_SIZE) };
  } catch (e) {
    if (isErrno(e, "ENOENT")) return { kind: "missing" };
    if (isShapeError(e)) return { kind: "other" };
    return { kind: "unreadable", error: e };
  }
}

/**
 * Replacing the vault (storage.md §4.3): exchange(temp, real); unsupported → rename. The
 * temporary name then holds the previous vault: the opened one is removed; another one is
 * exchanged back (the save fails with "changed"), or kept beside the vault when that fails.
 */
export async function replaceVault(t: TempFile, real: string, openedHash: string, newFile: Uint8Array, io: { warn(t: string): void }): Promise<void> {
  await faultPoint("before-replace", real);
  let how: "exchanged" | "unsupported";
  try {
    how = exchange(t.path, real, vaultTestHooks.exchangeSys ? { sys: vaultTestHooks.exchangeSys } : undefined);
  } catch (e) {
    t.remove();
    if (isErrno(e, "ENOENT")) throw errChanged();
    throw errorf("replacing the vault file: %w; the vault is unchanged", e);
  }
  if (how === "unsupported") {
    try {
      rename(t.path, real);
    } catch (e) {
      t.remove();
      throw errorf("replacing the vault file: %w; the vault is unchanged", e);
    }
    await faultPoint("after-replace", real);
    return;
  }
  await faultPoint("after-replace", real);
  const old = readOld(t.path);
  if (old.kind === "missing") return;
  if (old.kind === "unreadable") {
    const where = moveAside(t.path, real);
    io.warn(T("the replaced vault file couldn't be checked (%v); it is kept in %v", old.error, where));
    return;
  }
  if (old.kind === "bytes" && sha256Hex(old.bytes) === openedHash) {
    try {
      unlinkSync(t.path);
    } catch (e) {
      if (!isErrno(e, "ENOENT")) io.warn(T("the replaced vault file couldn't be removed (the next save removes it): %v", osError("remove", t.path, e)));
    }
    await faultPoint("old-removed", real);
    return;
  }
  // Replaced between step 6 and the exchange: put it back.
  try {
    const r = exchange(t.path, real, vaultTestHooks.exchangeSys ? { sys: vaultTestHooks.exchangeSys } : undefined);
    if (r === "unsupported") throw osError("rename", t.path, "EINVAL", real);
  } catch (e) {
    const where = moveAside(t.path, real);
    t.close();
    throw errorf("%w; the save couldn't be undone (%v): the vault now holds this save, the other version is in %v", errChanged(), e, where);
  }
  const back = readOld(t.path);
  if (back.kind !== "bytes" || !bytesEqual(back.bytes, newFile)) {
    if (back.kind === "missing") {
      t.close();
      throw errChanged();
    }
    const where = moveAside(t.path, real);
    t.close();
    throw errorf("%w; a file that was in its place is kept in %v", errChanged(), where);
  }
  t.remove();
  throw errChanged();
}

/** Step 7's end: close the temporary file's descriptor and fsync the folder; errors warn. */
function finishReplace(t: TempFile, dir: string, io: { warn(t: string): void }): void {
  try {
    t.closeChecked();
  } catch (e) {
    // SPEC-GAP: the spec says "an error is a warning" without a text.
    io.warn(T("the new vault file couldn't be closed: %v", e));
  }
  try {
    fsyncDir(dir);
  } catch (e) {
    io.warn(T("the vault's folder couldn't be flushed to disk: %v", e));
  }
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw errCancelled();
}

/**
 * OpenedVault.save (storage.md §4.2 steps 0–8). On success the state holds the saved data,
 * the new hash, key block and key; on failure nothing in it changes.
 */
export async function saveVault(st: VaultState, data: VaultData, opts: SaveOptions = {}): Promise<void> {
  // 0
  if (st.keyBlockDamaged && !opts.keyBlock) throw errKeyBlockDamaged();
  const identity = opts.identity ?? st.identity;
  if (!identity) throw errKeyBlockDamaged();
  // 1
  let real: string;
  try {
    real = realPath(st.path, { env: st.env });
  } catch (e) {
    if (isMissing(e)) throw errChanged();
    throw errorf("reading the vault file again: %w", e);
  }
  if (real !== st.realPath) throw errChanged();
  if (inBackupsFolder(real, st.state)) throw errInBackups();
  const lock = await takeVaultLock(st.state, real, opts.signal);
  try {
    await faultPoint("locked", real);
    const dir = dirname(real);
    const name = basename(real);
    try {
      cleanLeftovers(dir, name);
    } catch (e) {
      throw errorf("removing leftover temporary files: %w", e);
    }
    // 2
    checkCancelled(opts.signal);
    await faultPoint("step2", real);
    if (rereadHash(real) !== st.openedHash) throw errChanged();
    // 3
    checkCancelled(opts.signal);
    await faultPoint("step3", real);
    const ms = nowMs();
    const keyBlock = opts.keyBlock ?? st.keyBlock;
    const enc = encodeVault(data, st.data.revision, keyBlock, identity, Math.floor(ms / 1000));
    // 4, 5
    const t = await writeAndCheck(dir, name, enc, identity);
    // 6
    let current: Uint8Array;
    try {
      current = rereadBytes(real);
    } catch (e) {
      t.remove();
      throw e;
    }
    if (sha256Hex(current) !== st.openedHash) {
      t.remove();
      throw errChanged();
    }
    if (st.config.backup.keep > 0) {
      try {
        await writeBackup({
          state: st.state,
          vaultId: st.data.vaultId,
          bytes: current,
          revision: st.data.revision,
          keep: st.config.backup.keep,
          stamp: stamp(ms),
          vaultRealPath: real,
          io: st.io,
        });
      } catch (e) {
        t.remove();
        throw errorf("making the automatic backup: %w; the vault is unchanged", e);
      }
    }
    // 7
    await replaceVault(t, real, st.openedHash, enc.file, st.io);
    finishReplace(t, dir, st.io);
    await faultPoint("dir-synced", real);
    // 8
    st.openedHash = enc.hash;
    st.data = enc.data;
    if (opts.keyBlock) st.keyBlock = opts.keyBlock;
    if (opts.identity && opts.identity !== st.identity) {
      st.identity?.wipe();
      st.identity = opts.identity;
    }
    st.keyBlockDamaged = false;
    st.canonical = true;
    await updateRecordOrWarn(st.state, { vaultId: enc.data.vaultId, revision: enc.data.revision, savedAt: enc.data.savedAt }, st.io);
  } finally {
    lock.release();
  }
}

export type { PasshError };
