// The config file `passh init` writes (storage.md §2.4, cli.md §2.2 step 7): the toml block
// of spec §3.3 byte for byte (LF, final LF), with the vault's path as a TOML basic string.

import { dirname } from "node:path";
import { errorf } from "../i18n/index.ts";
import { mkdirP } from "../fsx/dirs.ts";
import { writeNewFile } from "../fsx/files.ts";
import { cleanPath, type Env } from "./paths.ts";

/** The vault line of the template; the value is replaced. */
const VAULT_LINE_PREFIX = "vault    = ";
const DEFAULT_VAULT_VALUE = '"~/.local/share/passh/vault.passh"';

/** spec §3.3's toml block, byte for byte (a test keeps the two identical). */
export const CONFIG_TEMPLATE = `vault    = "~/.local/share/passh/vault.passh"
language = "en"         # en, ru or sr (Serbian, Latin script)

[session]
idle_ttl   = "5m"       # TUI locks after this much inactivity
stop_agent = true       # a TUI lock also stops the agent (§5.3)

[agent]                 # started only by \`passh unlock\` (§5.3)
idle_ttl = "15m"        # exits after this long without a request
max_ttl  = "2h"         # and after this long in any case

[backup]
keep = 10               # previous versions kept in ~/.local/state/passh/backups/ (0 = off)

[rollback]
warn = true             # warn when a vault is older than one seen before (§4.10)

[clipboard]
clear_after = "30s"
osc52       = true      # copy through the terminal (works over SSH)
command     = []        # optional local tool instead, e.g. ["pbcopy"] or ["wl-copy"]

[print_web]             # §7.4; off unless enabled
enabled    = false
port       = 8443
interfaces = ["wg0", "eth0"]
allow_from = []         # extra CIDR limit; default = subnets of the bound addresses
hostnames  = []         # optional names for the certificate, e.g. ["pi.local"]
ttl        = "5m"       # 1–15 min
`;

/** Reports whether a JS string holds a lone surrogate (bytes that weren't valid UTF-8). */
function hasLoneSurrogate(s: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
}

/**
 * A TOML basic string as storage.md §2.4 writes the vault: `"` → `\"`, `\` → `\\`,
 * U+0000–U+001F and U+007F → `\uXXXX` (upper-case hex), everything else as is.
 */
export function tomlBasicString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (c < 0x20 || c === 0x7f) out += "\\u" + c.toString(16).toUpperCase().padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

/**
 * The value of `vault` for the file: `~/…` for a path under $HOME (with $HOME ≠ `/`),
 * else the absolute path. A path that isn't valid UTF-8 fails:
 * `vault path "<p>" is not valid UTF-8, which TOML can't hold`.
 */
export function configVaultValue(vault: string, env: Env = process.env): string {
  if (hasLoneSurrogate(vault)) throw errorf("vault path %q is not valid UTF-8, which TOML can't hold", vault);
  let v = vault;
  const h = env.HOME;
  if (h !== undefined && h.startsWith("/")) {
    const home = cleanPath(h);
    if (home !== "/" && vault.length > home.length + 1 && vault.startsWith(home + "/")) v = "~/" + vault.slice(home.length + 1);
  }
  return tomlBasicString(v);
}

/** The text of the config file for a new vault (absolute path). */
export function configFileText(vault: string, env: Env = process.env): string {
  const line = VAULT_LINE_PREFIX + DEFAULT_VAULT_VALUE;
  return CONFIG_TEMPLATE.replace(line, VAULT_LINE_PREFIX + configVaultValue(vault, env));
}

/**
 * Writes a new config file (storage.md §1.2, §2.4): missing folders above it with
 * `mkdir -p` 0700 reduced by the umask, the file 0600 reduced by the umask, with
 * O_CREAT|O_EXCL (never overwriting, not even through a dangling symlink), fsynced and
 * closed; a write error removes the new file. No folder fsync.
 * Spec audit #11 (modes reduced by the umask) is kept as the spec describes it.
 */
export function writeConfigFile(path: string, text: string): void {
  mkdirP(dirname(path), 0o700);
  writeNewFile(path, new TextEncoder().encode(text), 0o600);
}
