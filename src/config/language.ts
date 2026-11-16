// Choosing the language before the command line is parsed (i18n.md §2).

import type { Language } from "../i18n/index.ts";
import { loadConfig } from "./config.ts";
import type { Env } from "./paths.ts";

/** The agent's internal child command: it loads no config and speaks English. */
export const AGENT_COMMAND = "__agent";

/**
 * Scans the arguments up to a `--` for `--config X`, `--config=X`, `--vault X`,
 * `--vault=X`; the last of each wins (`--configx`, `--vault-x` don't match). A flag
 * without a following argument is ignored.
 */
export function scanGlobalFlags(args: readonly string[]): { config?: string; vault?: string } {
  const out: { config?: string; vault?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") break;
    for (const name of ["config", "vault"] as const) {
      if (a === `--${name}`) {
        if (i + 1 < args.length) out[name] = args[++i]!;
      } else if (a.startsWith(`--${name}=`)) {
        out[name] = a.slice(name.length + 3);
      }
    }
  }
  return out;
}

/**
 * The language of this process (i18n.md §2): English for `__agent`; else the config's
 * `language`, resolved and loaded exactly as a command would (with `--config` and
 * `--vault` from the arguments); any failure gives English. `args` are the arguments
 * after the program name.
 */
export function chooseLanguage(args: readonly string[], env: Env = process.env): Language {
  if (args[0] === AGENT_COMMAND) return "en";
  const f = scanGlobalFlags(args);
  try {
    return loadConfig({ configFlag: f.config, vaultFlag: f.vault, env }).language;
  } catch {
    return "en";
  }
}
