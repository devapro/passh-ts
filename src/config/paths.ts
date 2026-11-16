// Paths: base folders (storage.md §1.1), expansion of paths from flags and the
// environment (§2.1), the real path (§0), the `<~path>` form and the h32/h16 hashes (§0).

import { lstatSync, readlinkSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { codedError } from "../i18n/index.ts";
import { Errno, osError } from "../fsx/oserror.ts";

/** An environment: process.env or a test's own. */
export type Env = Record<string, string | undefined>;

/** Options shared by the path functions: the environment and the current folder. */
export interface PathOptions {
  env?: Env;
  /** The current folder (absolute); default: $PWD if it names the current folder, else getcwd. */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Lexical helpers

/** Go's path.Clean: collapse `//`, drop `.`, resolve `..` lexically; "" → ".". */
export function cleanPath(p: string): string {
  if (p === "") return ".";
  const rooted = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!rooted) out.push("..");
      continue;
    }
    out.push(part);
  }
  const s = (rooted ? "/" : "") + out.join("/");
  return s === "" ? "." : s;
}

/** Joins and cleans (Go's filepath.Join). */
export function joinPath(...parts: string[]): string {
  const nonEmpty = parts.filter((p) => p !== "");
  return nonEmpty.length === 0 ? "" : cleanPath(nonEmpty.join("/"));
}

function isAbs(p: string | undefined): p is string {
  return p !== undefined && p.startsWith("/");
}

// ---------------------------------------------------------------------------
// Base folders (storage.md §1.1)

/**
 * $HOME, cleaned. It must be set and absolute: `$HOME is not set` /
 * `$HOME ("<v>") is not an absolute path` (code "home"). No passwd-database fallback.
 */
export function homeDir(env: Env = process.env): string {
  const h = env.HOME;
  if (h === undefined || h === "") throw codedError("home", "$HOME is not set");
  if (!isAbs(h)) throw codedError("home", "$HOME (%q) is not an absolute path", h);
  return cleanPath(h);
}

function xdgBase(env: Env, name: string, fallback: string): string {
  const v = env[name];
  // An XDG variable that is empty or not absolute is ignored.
  if (isAbs(v)) return joinPath(v, "passh");
  return joinPath(homeDir(env), fallback, "passh");
}

/** The config folder: `$XDG_CONFIG_HOME/passh`, else `$HOME/.config/passh`. */
export function configDir(env: Env = process.env): string {
  return xdgBase(env, "XDG_CONFIG_HOME", ".config");
}

/** The data folder: `$XDG_DATA_HOME/passh`, else `$HOME/.local/share/passh` (init's default vault). */
export function dataDir(env: Env = process.env): string {
  return xdgBase(env, "XDG_DATA_HOME", ".local/share");
}

/** The state folder `<state>`: `$XDG_STATE_HOME/passh`, else `$HOME/.local/state/passh`. */
export function stateDir(env: Env = process.env): string {
  return xdgBase(env, "XDG_STATE_HOME", ".local/state");
}

/** The default config file: `<config folder>/config.toml`. */
export function defaultConfigFile(env: Env = process.env): string {
  return joinPath(configDir(env), "config.toml");
}

/** The default vault of `init`: `<data folder>/vault.passh`. */
export function defaultVaultFile(env: Env = process.env): string {
  return joinPath(dataDir(env), "vault.passh");
}

// ---------------------------------------------------------------------------
// Current folder, expansion

/**
 * The current folder like Go's os.Getwd: `$PWD` if it is absolute and names the current
 * folder (same device and inode as "."), else getcwd(3).
 */
export function currentDir(env: Env = process.env): string {
  const pwd = env.PWD;
  if (isAbs(pwd)) {
    try {
      const dot = statSync(".", { bigint: true });
      const d = statSync(pwd, { bigint: true });
      if (dot.dev === d.dev && dot.ino === d.ino) return pwd;
    } catch {
      /* fall through */
    }
  }
  return process.cwd();
}

/**
 * Expands a path from a flag or the environment (storage.md §2.1): `~` and `~/…` with
 * $HOME (`~user` is not expanded), a relative path against the current folder, then
 * cleaned. Errors: the $HOME errors of homeDir.
 */
export function expandPath(p: string, opts: PathOptions = {}): string {
  const env = opts.env ?? process.env;
  if (p === "~") return homeDir(env);
  if (p.startsWith("~/")) return joinPath(homeDir(env), p.slice(2));
  if (p.startsWith("/")) return cleanPath(p);
  return joinPath(opts.cwd ?? currentDir(env), p);
}

/**
 * The `<~path>` form (storage.md §0): a leading `$HOME/` written as `~/`. $HOME unset,
 * not absolute or `/`, or a path not strictly under it: the path unchanged.
 */
export function tildePath(abs: string, env: Env = process.env): string {
  const h = env.HOME;
  if (!isAbs(h)) return abs;
  const home = cleanPath(h);
  if (home === "/") return abs;
  if (abs.length > home.length + 1 && abs.startsWith(home + "/")) return "~/" + abs.slice(home.length + 1);
  return abs;
}

// ---------------------------------------------------------------------------
// Real path (storage.md §0)

/** storage.md §0 step 3: more than this many symlinks is an error. */
export const MAX_LINKS = 255;

/**
 * The real path of `p` (storage.md §0; not realpath(3)), computed on the path's text:
 * 1. made absolute against the current folder;
 * 2. cleaned lexically (`..` resolved before any symlink is looked at);
 * 3. each component lstat'ed from the left; a symlink is replaced by its target as
 *    readlink returns it (relative to the link's folder) and resolution continues inside
 *    it, `..` from a target going back one component of what is resolved so far; more
 *    than 255 links, or a missing component, is an error;
 * 4. cleaned.
 * Errors (like Go's filepath.EvalSymlinks): `lstat <p>: <reason>`, `readlink <p>: …`,
 * `not a directory` (a file used as a folder), `EvalSymlinks: too many links`.
 */
export function realPath(p: string, opts: PathOptions = {}): string {
  const abs = p.startsWith("/") ? cleanPath(p) : joinPath(opts.cwd ?? currentDir(opts.env ?? process.env), p);
  return cleanPath(walkSymlinks(abs));
}

/** Go's filepath.walkSymlinks for an absolute Unix path. */
function walkSymlinks(input: string): string {
  let path = input;
  let volLen = path.startsWith("/") ? 1 : 0;
  let vol = path.slice(0, volLen);
  let dest = vol;
  let links = 0;
  for (let start = volLen, end = volLen; start < path.length; start = end) {
    while (start < path.length && path[start] === "/") start++;
    end = start;
    while (end < path.length && path[end] !== "/") end++;
    if (end === start) break;
    const comp = path.slice(start, end);
    if (comp === ".") continue;
    if (comp === "..") {
      let r = dest.length - 1;
      while (r >= volLen && dest[r] !== "/") r--;
      if (r < volLen || dest.slice(r + 1) === "..") {
        if (dest.length > volLen) dest += "/";
        dest += "..";
      } else {
        dest = dest.slice(0, r);
      }
      continue;
    }
    if (dest.length > 0 && !dest.endsWith("/")) dest += "/";
    dest += comp;
    let st;
    try {
      st = lstatSync(dest);
    } catch (e) {
      throw osError("lstat", dest, e);
    }
    if (!st.isSymbolicLink()) {
      if (!st.isDirectory() && end < path.length) throw new Errno("ENOTDIR");
      continue;
    }
    links++;
    if (links > MAX_LINKS) throw new Error("EvalSymlinks: too many links");
    let link: string;
    try {
      link = readlinkSync(dest, "utf8");
    } catch (e) {
      throw osError("readlink", dest, e);
    }
    path = link + path.slice(end);
    if (link.startsWith("/")) {
      // Absolute target: start again from the root.
      dest = "/";
      end = 1;
      vol = "/";
      volLen = 1;
    } else {
      // Relative target: replace the last component of dest.
      let r = dest.length - 1;
      while (r >= volLen && dest[r] !== "/") r--;
      dest = r < volLen ? vol : dest.slice(0, r);
      end = 0;
    }
  }
  return dest;
}

// ---------------------------------------------------------------------------
// Hashes (storage.md §0)

function sha256(s: string | Uint8Array): Buffer {
  return createHash("sha256").update(typeof s === "string" ? Buffer.from(s, "utf8") : s).digest();
}

/** h32(s): the first 16 bytes of SHA-256 of the bytes of s, as 32 lower-case hex digits. */
export function h32(s: string | Uint8Array): string {
  return sha256(s).subarray(0, 16).toString("hex");
}

/** h16(s): the first 8 bytes of SHA-256 of the bytes of s, as 16 lower-case hex digits. */
export function h16(s: string | Uint8Array): string {
  return sha256(s).subarray(0, 8).toString("hex");
}
