// Shared data types of the vault's data block (spec §4.2, vault-format.md §4).
// Owned by src/model; other modules import these types. Keep them stable: extend, don't rename.

/**
 * Unknown JSON members of an object, kept through every change (vault-format.md §4.5):
 * decoded member name → the member's value as compact raw JSON text (insignificant whitespace
 * removed, numbers and escapes as written). A duplicate name keeps its last value.
 */
export type Unknowns = Map<string, string>;

/** A time: whole seconds since 1970-01-01T00:00:00Z (UTC). The zero time is ZERO_TIME. */
export type Time = number;

/** Go's zero time, 0001-01-01T00:00:00Z, written for a missing or null time. */
export const ZERO_TIME: Time = -62135596800;

export interface Field {
  key: string;
  value: string;
  unknown: Unknowns;
}

export interface Entry {
  id: string;
  /** A valid, NFC-normalized path (vault-format.md §6). */
  path: string;
  password: string;
  username: string;
  url: string;
  /** Normalized tags (NFC, trimmed, unique, in order). */
  tags: string[];
  fields: Field[];
  notes: string;
  createdAt: Time;
  updatedAt: Time;
  unknown: Unknowns;
}

export interface Tombstone {
  id: string;
  deletedAt: Time;
  unknown: Unknowns;
}

export interface VaultData {
  /** Always "passh-vault-data" once read. */
  format: string;
  /** Always 1 once read. */
  version: number;
  vaultId: string;
  /** 0 … 2^64−1. */
  revision: bigint;
  savedAt: Time;
  entries: Entry[];
  deleted: Tombstone[];
  unknown: Unknowns;
}
