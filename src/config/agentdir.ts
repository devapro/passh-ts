// The agent's socket location and folder (agent-session.md §A2.1–§A2.2, storage.md §8).

import { constants as C, chmodSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { codedError, errorf } from "../i18n/index.ts";
import { getuid } from "../ffi/libc.ts";
import { mkdirP, mkdirs } from "../fsx/dirs.ts";
import { closeQuiet, fstatBig } from "../fsx/files.ts";
import { isErrno, osError, toErrno } from "../fsx/oserror.ts";
import { h16, joinPath, stateDir, type Env } from "./paths.ts";

/** §A1: the longest Unix socket path (macOS sun_path 104 including the NUL). */
export const SOCKET_PATH_MAX = 103;

export interface AgentSocket {
  /** The agent folder. */
  dir: string;
  /** The socket path: dir + "/" + name. */
  path: string;
  /** `agent-<h16(real path)>.sock`. */
  name: string;
  /** The folder is `<state>/agent` (else a `passh-<uid>` fallback in $TMPDIR or /tmp). */
  inState: boolean;
}

/** `agent-` + the first 16 hex digits of SHA-256 of the real path + `.sock` (27 bytes). */
export function agentSocketName(vaultRealPath: string): string {
  return `agent-${h16(vaultRealPath)}.sock`;
}

/**
 * The socket of the vault's agent (§A2.1): `<state>/agent`, else `$TMPDIR/passh-<uid>`
 * (only if TMPDIR is set and absolute), else `/tmp/passh-<uid>`: the first whose socket
 * path is at most 103 bytes; none → `the agent's socket path is longer than 103 bytes
 * even in /tmp` (code "socket-path"). `uid` is the real uid. The state folder needs
 * $HOME unless $XDG_STATE_HOME is absolute (its errors are thrown).
 */
export function agentSocketPath(vaultRealPath: string, opts: { env?: Env; uid?: number | bigint } = {}): AgentSocket {
  const env = opts.env ?? process.env;
  const uid = opts.uid ?? getuid();
  const name = agentSocketName(vaultRealPath);
  const candidates: Array<{ dir: string; inState: boolean }> = [{ dir: joinPath(stateDir(env), "agent"), inState: true }];
  const tmp = env.TMPDIR;
  if (tmp !== undefined && tmp.startsWith("/")) candidates.push({ dir: joinPath(tmp, `passh-${uid}`), inState: false });
  candidates.push({ dir: `/tmp/passh-${uid}`, inState: false });
  for (const c of candidates) {
    const path = c.dir + "/" + name;
    if (Buffer.byteLength(path, "utf8") <= SOCKET_PATH_MAX) return { dir: c.dir, path, name, inState: c.inState };
  }
  throw codedError("socket-path", "the agent's socket path is longer than 103 bytes even in /tmp");
}

/** The mode as `%04o` ("0755", "2700"). */
function modeText(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

/**
 * Checks the agent folder (§A2.2) without creating it: open O_DIRECTORY|O_NOFOLLOW,
 * fstat, and require a directory owned by `uid` (the real uid) with permission bits
 * exactly 0700. Returns "ok", or "missing" (ENOENT: for a client, no agent). Failures
 * (codes "agent-dir"):
 * - `agent folder <dir> is not a directory (a symlink or a file); refusing to use it`
 * - `agent folder <dir> belongs to uid <n>, not to you (uid <m>); refusing to use it`
 * - `agent folder <dir> has mode <0nnn>, not 0700; refusing to use it (fix it with chmod 700, or remove it)`
 * - `opening the agent folder <dir>: <error>` / `checking the agent folder <dir>: <error>`
 */
export function checkPrivateDir(dir: string, uid: number = getuid()): "ok" | "missing" {
  let fd: number;
  try {
    fd = openSync(dir, C.O_RDONLY | (C.O_DIRECTORY ?? 0) | C.O_NOFOLLOW);
  } catch (e) {
    if (isErrno(e, "ENOENT")) return "missing";
    if (isErrno(e, "ELOOP", "ENOTDIR")) {
      throw codedError("agent-dir", "agent folder %s is not a directory (a symlink or a file); refusing to use it", dir);
    }
    throw codedError("agent-dir", "opening the agent folder %s: %w", dir, toErrno(e));
  }
  try {
    let st;
    try {
      st = fstatBig(fd, dir);
    } catch (e) {
      throw codedError("agent-dir", "checking the agent folder %s: %w", dir, toErrno(e));
    }
    if (!st.isDirectory()) throw codedError("agent-dir", "agent folder %s is not a directory (a symlink or a file); refusing to use it", dir);
    if (Number(st.uid) !== uid) throw codedError("agent-dir", "agent folder %s belongs to uid %d, not to you (uid %d); refusing to use it", dir, Number(st.uid), uid);
    const perm = Number(st.mode) & 0o7777;
    if (perm !== 0o700) {
      throw codedError("agent-dir", "agent folder %s has mode %s, not 0700; refusing to use it (fix it with chmod 700, or remove it)", dir, modeText(perm));
    }
    return "ok";
  } finally {
    closeQuiet(fd);
  }
}

/**
 * Creates the agent folder (§A2.2 "Create", agent only) and checks it:
 * - `<state>/agent`: the state folder's missing parents with `mkdir -p` 0700 reduced by
 *   the umask, the state folder (if missing) and the agent folder with mode exactly 0700
 *   (storage.md §8, §1.3);
 * - a fallback `passh-<uid>`: $TMPDIR or /tmp must exist; mkdir 0700 + chmod 0700.
 * An existing folder is never fixed, only checked (checkPrivateDir's errors).
 * Other errors: OSErrors (`mkdir <dir>: …`).
 */
export function createAgentDir(sock: AgentSocket, opts: { env?: Env; uid?: number } = {}): void {
  const uid = opts.uid ?? getuid();
  if (checkPrivateDir(sock.dir, uid) === "ok") return;
  if (sock.inState) {
    const state = dirname(sock.dir);
    mkdirP(dirname(state), 0o700);
    mkdirs(sock.dir);
  } else {
    try {
      mkdirSync(sock.dir, { mode: 0o700 });
      chmodSync(sock.dir, 0o700);
    } catch (e) {
      if (!isErrno(e, "EEXIST")) throw osError("mkdir", sock.dir, e);
    }
  }
  if (checkPrivateDir(sock.dir, uid) !== "ok") throw errorf("opening the agent folder %s: %w", sock.dir, toErrno("ENOENT"));
}
