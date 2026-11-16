// Creating a vault (`passh init`, storage.md §4.6): as a save, except that the folder is
// created, the target must not exist, the revision is 1, there is no backup, and the final
// rename never replaces anything.

import { join } from "node:path";
import type { X25519Identity } from "../age/index.ts";
import { realPath, stateDir, type Config, type Env } from "../config/index.ts";
import { cleanLeftovers, fsyncDir, isErrno, lstatIfExists, mkdirs, renameNoReplace } from "../fsx/index.ts";
import { errorf, T } from "../i18n/index.ts";
import { wrapKeyBlock } from "../keys/index.ts";
import { newVaultData } from "../model/index.ts";
import type { VaultData } from "../model/types.ts";
import type { CommandIO } from "../util/io.ts";
import { errExists, errInBackups } from "./errors.ts";
import { faultPoint, nowMs } from "./hooks.ts";
import { absPath, Vault } from "./open.ts";
import { updateRecordOrWarn } from "./rollback.ts";
import { encodeVault, takeVaultLock, writeAndCheck } from "./save.ts";
import type { OpenedVault } from "./types.ts";
import { basename, dirname, inBackupsFolder, isMissing } from "./util.ts";

export interface CreateOptions {
  config: Config;
  io: CommandIO;
  /** The new vault key. */
  identity: X25519Identity;
  /** The key block (wrapKeyBlock of the identity); or give `passphrase` and it is wrapped here (scrypt 2^18). */
  keyBlock?: Uint8Array;
  passphrase?: Uint8Array;
  /** The data to write (default: newVaultData()); its revision is written as 1. */
  data?: VaultData;
  env?: Env;
  signal?: AbortSignal;
}

/**
 * Creates the vault file (storage.md §4.6): `mkdirs` the folder (`creating the vault's
 * folder: …`); real path = real path of the folder + the file name; inside the backups folder
 * → the backup error; under the vault lock, an existing target → `<path>: a file already
 * exists there` (code "exists"); revision 1; temporary file and read-back as a save; the final
 * rename-no-replace; the rollback record gets revision 1. Returns the opened vault.
 */
export async function createVault(path: string, opts: CreateOptions): Promise<OpenedVault> {
  const env = opts.env ?? process.env;
  const abs = absPath(path, env);
  const state = stateDir(env);
  const folder = dirname(abs);
  try {
    mkdirs(folder);
  } catch (e) {
    throw errorf("creating the vault's folder: %w", e);
  }
  let real: string;
  try {
    real = join(realPath(folder, { env }), basename(abs));
  } catch (e) {
    throw errorf("creating the vault's folder: %w", e);
  }
  if (inBackupsFolder(real, state)) throw errInBackups();
  const keyBlock = opts.keyBlock ?? (await wrapKeyBlock(opts.identity, opts.passphrase ?? new Uint8Array(0)));
  const lock = await takeVaultLock(state, real, opts.signal);
  try {
    await faultPoint("locked", real);
    let exists;
    try {
      exists = lstatIfExists(real);
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    if (exists) throw errExists(abs);
    const dir = dirname(real);
    const name = basename(real);
    try {
      cleanLeftovers(dir, name);
    } catch (e) {
      throw errorf("removing leftover temporary files: %w", e);
    }
    const ms = nowMs();
    const data = opts.data ?? newVaultData(Math.floor(ms / 1000));
    const enc = encodeVault(data, 0n, keyBlock, opts.identity, Math.floor(ms / 1000), 1n);
    const t = await writeAndCheck(dir, name, enc, opts.identity);
    await faultPoint("before-replace", real);
    try {
      renameNoReplace(t.path, real);
    } catch (e) {
      t.remove();
      if (isErrno(e, "EEXIST")) throw errExists(abs);
      throw errorf("creating the vault file: %w", e);
    }
    await faultPoint("after-replace", real);
    t.close();
    try {
      fsyncDir(dir);
    } catch (e) {
      opts.io.warn(T("the vault's folder couldn't be flushed to disk: %v", e));
    }
    await updateRecordOrWarn(state, { vaultId: enc.data.vaultId, revision: enc.data.revision, savedAt: enc.data.savedAt }, opts.io);
    return new Vault({
      path: abs,
      realPath: real,
      state,
      env,
      config: opts.config,
      io: opts.io,
      data: enc.data,
      keyBlock,
      identity: opts.identity,
      keySource: "passphrase",
      openedHash: enc.hash,
      canonical: true,
      inBackups: false,
      keyBlockDamaged: false,
    });
  } finally {
    lock.release();
  }
}
