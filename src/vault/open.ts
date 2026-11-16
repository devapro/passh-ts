// Opening a vault (spec §4.5, storage.md §3): real path, read, hash, container, key, data
// block, JSON, rollback check; recovery mode (vault-format.md §3.6); changes and reload (§3.3).

import type { X25519Identity } from "../age/index.ts";
import { cleanPath, currentDir, joinPath, realPath, stateDir, type Env } from "../config/index.ts";
import { codedError, errorf, hasCode, T } from "../i18n/index.ts";
import { decryptData, KeyErrorCode, keyBlockDigest } from "../keys/index.ts";
import { parseVaultData } from "../model/index.ts";
import type { VaultData } from "../model/types.ts";
import { ContainerError, parseContainer, parseContainerForRecovery, type Container } from "../vaultfile/index.ts";
import { damagedBackupList } from "./backups.ts";
import { errLocked, VaultErrorCode, withPath } from "./errors.ts";
import { currentKeySource } from "./keysources.ts";
import { checkRollback } from "./rollback.ts";
import { saveVault } from "./save.ts";
import type { VaultState } from "./state.ts";
import type { KeyRequest, KeySourceKind, OpenedVault, OpenOptions, RollbackReport, SaveOptions } from "./types.ts";
import { inBackupsFolder, isMissing, isShapeError, readVaultBytes, sha256Hex } from "./util.ts";

/** Makes a path absolute and clean (storage.md §0 `<path>`). */
export function absPath(p: string, env: Env = process.env): string {
  return p.startsWith("/") ? cleanPath(p) : joinPath(currentDir(env), p);
}

/** An opened vault (the OpenedVault contract of types.ts). */
export class Vault implements OpenedVault {
  readonly #st: VaultState;
  #closed = false;

  constructor(st: VaultState) {
    this.#st = st;
  }

  get path(): string {
    return this.#st.path;
  }
  get realPath(): string {
    return this.#st.realPath;
  }
  get data(): VaultData {
    return this.#st.data;
  }
  get keyBlock(): Uint8Array {
    return this.#st.keyBlock;
  }
  get keySource(): KeySourceKind {
    return this.#st.keySource;
  }
  get openedHash(): string {
    return this.#st.openedHash;
  }
  get canonical(): boolean {
    return this.#st.canonical;
  }
  get inBackups(): boolean {
    return this.#st.inBackups;
  }
  get keyBlockDamaged(): boolean {
    return this.#st.keyBlockDamaged;
  }
  get rollback(): RollbackReport | undefined {
    return this.#st.rollback;
  }
  /** `<state>` of this open. */
  get stateDir(): string {
    return this.#st.state;
  }

  identity(): X25519Identity {
    this.#check();
    return this.#st.identity!;
  }

  async save(data: VaultData, opts?: SaveOptions): Promise<void> {
    this.#check();
    await saveVault(this.#st, data, opts);
  }

  async changedOnDisk(): Promise<boolean> {
    this.#check();
    return changedOnDisk(this.#st);
  }

  async reload(opts: OpenOptions): Promise<OpenedVault> {
    this.#check();
    const st = this.#st;
    const sources = st.identity ? [currentKeySource(st.identity, st.keyBlock, st.keySource), ...opts.sources] : opts.sources;
    return openVault(st.path, { ...opts, sources });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#st.identity?.wipe();
    this.#st.identity = null;
  }

  #check(): void {
    if (this.#closed) throw new Error("vault used after close()");
  }
}

/**
 * Changed on disk (storage.md §3.3): the real path differs from the one opened (symlink
 * retargeted), the file is gone, or its SHA-256 differs from the opened hash. A byte-identical
 * replacement is no change. Other errors are thrown (the TUI shows "Checking the vault file failed").
 */
export function changedOnDisk(st: VaultState): boolean {
  let real: string;
  try {
    real = realPath(st.path, { env: st.env });
  } catch (e) {
    if (isMissing(e)) return true;
    throw e;
  }
  if (real !== st.realPath) return true;
  let b: Uint8Array;
  try {
    b = readVaultBytes(real);
  } catch (e) {
    if (isMissing(e) || isShapeError(e)) return true;
    throw e;
  }
  return sha256Hex(b) !== st.openedHash;
}

interface Parsed {
  container: Container;
  keyBlockDamaged: boolean;
  keyBlockError?: ContainerError;
}

function parseFile(abs: string, bytes: Uint8Array, recovery: boolean, opts: OpenOptions): Parsed {
  let p: Parsed;
  try {
    if (recovery) {
      const rc = parseContainerForRecovery(bytes);
      p = { container: rc, keyBlockDamaged: rc.keyBlockDamaged, keyBlockError: rc.keyBlockError };
    } else {
      p = { container: parseContainer(bytes), keyBlockDamaged: false };
    }
  } catch (e) {
    throw withPath(abs, e);
  }
  for (const w of p.container.warnings) opts.io.warnOnce(T("%s: %s", abs, w));
  if (p.keyBlockDamaged) opts.io.warnOnce(T("%s: the key block is damaged; setting a new passphrase rewrites it", abs));
  return p;
}

/**
 * Opens a vault (storage.md §3.1, in order): real path (`opening the vault: …`); read with the
 * limits (`<path>: not a passh vault: not a regular file` / `…: the file is larger than 64
 * MiB`, else `opening the vault: <os error>`); the opened hash; the container (`<path>: <parse
 * error>`; ignored text → warnings `<path>: ignored …` through io.warnOnce); the key sources in
 * order (all falling through → `vault is locked: …`, code "locked"); the data block (§3.2:
 * `<path>: data is damaged; restore a backup` and the list of backups, …); the JSON (`<path>:
 * made by a newer passh; upgrade passh (data version)`, invalid data); the rollback check
 * (§7.4) and the record update. Steps 1–4 come before any key is asked for.
 *
 * Errors carry codes (hasCode): "locked", "data-damaged", "data-not-to-key",
 * "wrong-recovery-key", "newer-data", "rollback-declined", the container's ("not-vault",
 * "newer-container", "truncated", "damaged"), the key sources' ("wrong-passphrase",
 * "work-factor", …). The CLI adds the hint line of §3.1 with withOpenHint.
 */
export async function openVault(path: string, opts: OpenOptions): Promise<OpenedVault> {
  const env = opts.env ?? process.env;
  const abs = absPath(path, env);
  // SPEC-GAP: §3.1 doesn't place the state folder; the reference fails with `$HOME is not set`
  // before anything else when it can't be computed (it needs it for the agent and the record).
  const state = stateDir(env);
  // 1
  let real: string;
  try {
    real = realPath(abs, { env });
  } catch (e) {
    throw errorf("opening the vault: %w", e);
  }
  // 2. SPEC-GAP: read through the real path (the reference's OS errors name it), so the bytes
  // and the real path are of one file.
  let bytes: Uint8Array;
  try {
    bytes = readVaultBytes(real);
  } catch (e) {
    if (isShapeError(e)) throw withPath(abs, e);
    throw errorf("opening the vault: %w", e);
  }
  // 3
  const hash = sha256Hex(bytes);
  // 4
  const parsed = parseFile(abs, bytes, opts.recoveryMode === true, opts);
  const { container } = parsed;
  // 5
  const req: KeyRequest = {
    path: abs,
    realPath: real,
    keyBlock: container.keyBlock,
    keyBlockDigest: keyBlockDigest(container.keyBlock),
    signal: opts.signal ?? undefined,
    env,
  };
  let identity: X25519Identity | undefined;
  let kind: KeySourceKind = "passphrase";
  for (const s of opts.sources) {
    identity = await s.getKey(req);
    if (identity) {
      kind = s.kind;
      break;
    }
  }
  if (!identity) throw errLocked();
  try {
    // 6
    let plain: Uint8Array;
    try {
      plain = decryptData(container.dataBlock, identity, kind);
    } catch (e) {
      if (parsed.keyBlockDamaged && parsed.keyBlockError) throw withPath(abs, parsed.keyBlockError);
      if (hasCode(e, KeyErrorCode.WrongRecoveryKey)) throw withPath(abs, e);
      if (hasCode(e, KeyErrorCode.DataDamaged) || hasCode(e, KeyErrorCode.DataNotToKey)) {
        throw errorf("%s: %w%v", abs, e, damagedBackupList(state, container.keyBlock, identity));
      }
      throw e;
    }
    // 7
    let data: VaultData;
    try {
      data = parseVaultData(plain);
    } catch (e) {
      if (hasCode(e, "newer-data")) throw withPath(abs, e);
      if (hasCode(e, "invalid-data")) {
        throw codedError(VaultErrorCode.DataDamaged, "%s: data is damaged; restore a backup (%w)%v", abs, e, damagedBackupList(state, container.keyBlock, identity));
      }
      throw e;
    } finally {
      plain.fill(0);
    }
    // 8
    const inBackups = inBackupsFolder(real, state);
    const report = await checkRollback({
      state,
      vaultId: data.vaultId,
      revision: data.revision,
      savedAt: data.savedAt,
      inBackups,
      mode: opts.rollback,
      warn: opts.config.rollback.warn,
      confirmOlder: opts.confirmOlder,
      io: opts.io,
    });
    const st: VaultState = {
      path: abs,
      realPath: real,
      state,
      env,
      config: opts.config,
      io: opts.io,
      data,
      keyBlock: container.keyBlock,
      identity,
      keySource: kind,
      openedHash: hash,
      canonical: container.canonical,
      inBackups,
      keyBlockDamaged: parsed.keyBlockDamaged,
      rollback: opts.rollback === "report" ? report : undefined,
    };
    return new Vault(st);
  } catch (e) {
    identity.wipe();
    throw e;
  }
}
