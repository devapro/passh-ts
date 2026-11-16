// Shared fixtures of the vault tests: an isolated environment with a vault created by our code
// (key block wrapped with a low scrypt work factor, so tests stay fast).

import { join } from "node:path";
import { isolatedEnv, type IsolatedEnv } from "../../../test/helpers/env.ts";
import { defaultConfig, type Config } from "../../config/index.ts";
import { generateVaultKey, wrapKeyBlock, X25519Identity } from "../../keys/index.ts";
import { captureIO, type CapturedIO } from "../../util/io.ts";
import { createVault } from "../create.ts";
import { identityKeySource } from "../keysources.ts";
import { openVault } from "../open.ts";
import type { OpenedVault, OpenOptions } from "../types.ts";

export const TEST_PASS = new TextEncoder().encode("test passphrase");

export interface Fixture {
  e: IsolatedEnv;
  env: Record<string, string>;
  config: Config;
  vault: string;
  state: string;
  identity: X25519Identity;
  keyBlock: Uint8Array;
  io: CapturedIO;
  open(extra?: Partial<OpenOptions>): Promise<OpenedVault>;
  cleanup(): void;
}

/** A fresh isolated environment and a new vault in it (revision 1). */
export async function fixture(name = "vault", opts: { keep?: number; logN?: number; create?: boolean } = {}): Promise<Fixture> {
  const e = isolatedEnv(name);
  const config = defaultConfig();
  const vault = join(e.dataHome, "passh", "vault.passh");
  config.vault = vault;
  if (opts.keep !== undefined) config.backup.keep = opts.keep;
  const identity = generateVaultKey();
  const keyBlock = await wrapKeyBlock(identity, TEST_PASS, opts.logN ?? 10);
  const io = captureIO();
  if (opts.create !== false) {
    const v = await createVault(vault, { config, io, identity: copyOf(identity), keyBlock, env: e.env });
    v.close();
  }
  const f: Fixture = {
    e,
    env: e.env,
    config,
    vault,
    state: join(e.stateHome, "passh"),
    identity,
    keyBlock,
    io,
    open(extra = {}) {
      return openVault(vault, { config, io: f.io, rollback: "prompt", sources: [identityKeySource(identity, "passphrase")], env: e.env, ...extra });
    },
    cleanup() {
      e.cleanup();
    },
  };
  return f;
}

/** A copy of a key (the vault wipes the one it holds on close). */
export function copyOf(id: X25519Identity): X25519Identity {
  return X25519Identity.fromBytes(id.secretBytes());
}
