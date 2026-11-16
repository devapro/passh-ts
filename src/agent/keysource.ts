// The agent as a key source (agent-session.md §A2.8, spec §5.1): ask the vault's agent
// for the key of the key block being opened; fall through silently when there is no
// agent, with a note for a changed key block, with a warning for any other agent error.

import { existsSync } from "node:fs";
import { realPath as resolveRealPath, tildePath, type Env } from "../config/index.ts";
import { T } from "../i18n/index.ts";
import type { CommandIO } from "../util/io.ts";
import type { KeyRequest, KeySource } from "../vault/types.ts";
import type { X25519Identity } from "../age/index.ts";
import { agentKey, type ClientOptions } from "./client.ts";

export interface AgentKeySourceOptions extends ClientOptions {
  /** Environment for `~/` in messages (default: opts.env, else process.env). */
  env?: Env;
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

/** The note for `key_block_changed` (§A2.8). */
export function keyBlockChangedNote(): string {
  return T("the vault's key block isn't the one `passh unlock` opened (passwd elsewhere, or damaged): the agent's key isn't used; asking for the passphrase");
}

/**
 * Asks one agent. Returns the identity or undefined; prints the warning for agent errors
 * (`can't use the agent of <file>: <error>`) and, with `noteChanged`, the key-block note.
 */
async function ask(
  io: CommandIO,
  file: string,
  agentRealPath: string,
  req: KeyRequest,
  opts: AgentKeySourceOptions,
  noteChanged: boolean,
): Promise<X25519Identity | undefined> {
  let r;
  try {
    r = await agentKey(agentRealPath, req.keyBlockDigest, { ...opts, signal: req.signal ?? opts.signal });
  } catch (e) {
    if (isAbort(e) || (req.signal?.aborted && e === req.signal.reason)) throw e;
    io.warn(T("can't use the agent of %s: %s", tildePath(file, opts.env ?? process.env), e));
    return undefined;
  }
  if (r.kind === "key") return r.identity;
  if (r.kind === "key_block_changed" && noteChanged) io.note(keyBlockChangedNote());
  return undefined;
}

/**
 * The agent of the file being opened (§A2.8): `kind` "agent". Served key → the identity
 * (a data block that then doesn't decrypt is the caller's "data is damaged"); no agent →
 * undefined, silently; `key_block_changed` → the note, undefined; other errors (folder
 * check, foreign peer, version, malformed, timeout) → `passh: warning: can't use the agent
 * of <file>: <error>` (`<file>`: the path as given, `~/` form), undefined.
 */
export function agentKeySource(io: CommandIO, opts: AgentKeySourceOptions = {}): KeySource {
  return {
    kind: "agent",
    getKey: (req) => ask(io, req.path, req.realPath, req, opts, true),
  };
}

/**
 * `verify --full <file>` (§A2.8, cli.md §2.19): the file's own agent, then the configured
 * vault's, when that is another existing file (compared by real path; useful only for a
 * copy with the same key block). The configured vault's agent answering
 * `key_block_changed` is silent (its key block is expected to differ); its other errors
 * warn with the configured vault's `<file>`.
 */
export function verifyKeySource(io: CommandIO, configuredVault: string | undefined, opts: AgentKeySourceOptions = {}): KeySource {
  return {
    kind: "agent",
    async getKey(req) {
      const own = await ask(io, req.path, req.realPath, req, opts, true);
      if (own) return own;
      if (!configuredVault || !existsSync(configuredVault)) return undefined;
      let cfgReal: string;
      try {
        cfgReal = resolveRealPath(configuredVault, { env: opts.env });
      } catch {
        return undefined;
      }
      if (cfgReal === req.realPath) return undefined;
      return ask(io, configuredVault, cfgReal, req, opts, false);
    },
  };
}
