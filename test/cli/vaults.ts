// Test helper for the CLI suites: builds vault files directly (keys, container, data model),
// so both implementations can be run on byte-identical copies of the same vault, and reads
// vault files back to check what a command saved.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decryptData, encryptData, generateVaultKey, unwrapKeyBlock, wrapKeyBlock, type X25519Identity } from "../../src/keys/index.ts";
import { encodeContainer, parseContainer } from "../../src/vaultfile/index.ts";
import { newId, newVaultData, parseVaultData, serializeVaultData, type Entry, type VaultData } from "../../src/model/index.ts";
import { isolatedEnv, REF_BIN, TS_SRC_CMD, writeConfig, type IsolatedEnv } from "../helpers/env.ts";
import { PASS } from "../helpers/passh.ts";

export const REF = [REF_BIN];
export const OURS = TS_SRC_CMD;

export interface EntrySpec {
  path: string;
  password?: string;
  username?: string;
  url?: string;
  tags?: string[];
  fields?: Array<[string, string]>;
  notes?: string;
}

/** A vault's bytes and key, built once and copied into every env. */
export interface BuiltVault {
  bytes: Uint8Array;
  identity: X25519Identity;
  keyBlock: Uint8Array;
  data: VaultData;
}

const T0 = 1_763_200_000; // 2025-11-15T09:46:40Z

/** Builds a vault holding the entries, with the passphrase (scrypt 2^18, like passh). */
export async function buildVault(entries: EntrySpec[], passphrase = PASS, mutate?: (d: VaultData) => void): Promise<BuiltVault> {
  const identity = generateVaultKey();
  const keyBlock = await wrapKeyBlock(identity, new TextEncoder().encode(passphrase));
  const data = newVaultData(T0);
  data.revision = 5n;
  data.entries = entries.map(
    (s, i): Entry => ({
      id: newId(),
      path: s.path,
      password: s.password ?? "",
      username: s.username ?? "",
      url: s.url ?? "",
      tags: s.tags ?? [],
      fields: (s.fields ?? []).map(([key, value]) => ({ key, value, unknown: new Map() })),
      notes: s.notes ?? "",
      createdAt: T0 + i,
      updatedAt: T0 + i,
      unknown: new Map(),
    }),
  );
  mutate?.(data);
  const bytes = encodeContainer(keyBlock, encryptData(serializeVaultData(data), identity));
  return { bytes, identity, keyBlock, data };
}

/** Re-encrypts new data with the same key and key block (a vault changed "elsewhere"). */
export function rebuild(v: BuiltVault, data: VaultData): Uint8Array {
  return encodeContainer(v.keyBlock, encryptData(serializeVaultData(data), v.identity));
}

/** Decrypts a vault file with the identity. */
export function readVault(path: string, identity: X25519Identity): VaultData {
  const c = parseContainer(new Uint8Array(readFileSync(path)));
  return parseVaultData(decryptData(c.dataBlock, identity, "passphrase"));
}

/** Decrypts a vault file with the passphrase (after passwd/rekey/recover). */
export async function readVaultWithPassphrase(path: string, passphrase = PASS): Promise<{ data: VaultData; identity: X25519Identity }> {
  const c = parseContainer(new Uint8Array(readFileSync(path)));
  const identity = await unwrapKeyBlock(c.keyBlock, new TextEncoder().encode(passphrase));
  return { data: parseVaultData(decryptData(c.dataBlock, identity, "passphrase")), identity };
}

/** Writes a vault file (folders 0700, file 0600). */
export function placeVault(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600 });
}

/** Two isolated envs (reference, ours) with a config naming each one's vault. */
export interface Pair {
  ref: IsolatedEnv;
  ours: IsolatedEnv;
  cleanup(): void;
}

export async function makePair(name: string, bytes?: Uint8Array, configExtra = ""): Promise<Pair> {
  const ref = isolatedEnv(name.slice(0, 6) + "r");
  const ours = isolatedEnv(name.slice(0, 6) + "o");
  for (const e of [ref, ours]) {
    await writeConfig(e, configExtra);
    if (bytes) placeVault(e.vault, bytes);
  }
  return {
    ref,
    ours,
    cleanup() {
      ref.cleanup();
      ours.cleanup();
    },
  };
}

/** Replaces each env's own folder in a text with `<ENV>`, so outputs of two envs compare. */
export function normalize(text: string, e: IsolatedEnv): string {
  return text.split(e.dir).join("<ENV>").split(e.runtimeDir).join("<RUN>");
}

export function copyInto(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
  copyFileSync(src, dst);
}

export { join, PASS };
