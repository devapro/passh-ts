// The in-memory state of an opened vault, shared by open.ts and save.ts.

import type { X25519Identity } from "../age/index.ts";
import type { Config, Env } from "../config/index.ts";
import type { VaultData } from "../model/types.ts";
import type { CommandIO } from "../util/io.ts";
import type { KeySourceKind, RollbackReport } from "./types.ts";

export interface VaultState {
  /** As given (absolute, cleaned): `<path>`. */
  path: string;
  realPath: string;
  /** `<state>`. */
  state: string;
  env: Env;
  config: Config;
  io: CommandIO;
  data: VaultData;
  /** The binary key block (empty in recovery mode with a damaged key block). */
  keyBlock: Uint8Array;
  identity: X25519Identity | null;
  keySource: KeySourceKind;
  openedHash: string;
  canonical: boolean;
  inBackups: boolean;
  keyBlockDamaged: boolean;
  rollback?: RollbackReport;
}

/** `<state>/locks/vault-<h32(real path)>.lock`. */
export function vaultLockName(h32RealPath: string): string {
  return `vault-${h32RealPath}.lock`;
}
