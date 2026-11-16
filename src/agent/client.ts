// Client calls to the agent (agent-session.md §A2.7): one request per connection, the
// folder check without creating it, connect with a deadline, the peer uid check, the
// answer parsed per §A2.5. "No agent" (no folder, no socket, refused, expired, exited
// meanwhile) is a result, not an error; everything else throws `agent: …` (code "agent").

import { agentSocketPath, checkPrivateDir, type AgentSocket, type Env } from "../config/index.ts";
import { getuid, peerCred, socketFd } from "../ffi/libc.ts";
import { errnoCode, toErrno } from "../fsx/oserror.ts";
import { lstatIfExists } from "../fsx/files.ts";
import { PasshError } from "../i18n/index.ts";
import type { X25519Identity } from "../age/index.ts";
import { agentError, keyFromAnswer, MAX_LINE, parseAnswer, type Answer } from "./protocol.ts";

/** A client call without its own deadline gets 5 s (§A1). */
export const CLIENT_DEADLINE_MS = 5000;
/** `lock`: poll for the socket to vanish every 10 ms, at most 5 s (§A1). */
export const LOCK_POLL_MS = 10;
export const LOCK_WAIT_MS = 5000;

export interface ClientOptions {
  /** Environment for the socket location (XDG_STATE_HOME, HOME, TMPDIR); default process.env. */
  env?: Env;
  /** The real uid (default getuid()). */
  uid?: number;
  /** The call's deadline in milliseconds (default 5 s). */
  deadlineMs?: number;
  /** Cancels the call (TUI): it then rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Test hook: the uid the agent must have (default: uid). */
  peerUid?: number;
}

/** What the agent said, when one answered. */
export interface AgentStatus {
  pid: bigint;
  /** The agent's real vault path (not checked by the client). */
  vault: string;
  idleLeftMs: bigint;
  maxLeftMs: bigint;
}

export type AgentResult =
  | { kind: "answer"; answer: Answer }
  /** No agent (§A2.7): no folder, no socket, ECONNREFUSED, expired, exited meanwhile. */
  | { kind: "none" }
  /** `key_block_changed` (counts as "no agent" for status and stop). */
  | { kind: "key_block_changed" };

/** The socket of a vault's agent (§A2.1), errors as `agent: …`. */
export function socketFor(realPath: string, opts: ClientOptions = {}): AgentSocket {
  try {
    return agentSocketPath(realPath, { env: opts.env, uid: opts.uid });
  } catch (e) {
    throw agentError("%w", e);
  }
}

type Outcome =
  | { kind: "line"; line: Uint8Array }
  | { kind: "too_large" }
  | { kind: "eof"; partial: boolean }
  | { kind: "reset"; err: Error }
  | { kind: "connect"; err: unknown }
  | { kind: "connect_timeout" }
  | { kind: "timeout" }
  | { kind: "peer"; uid: number }
  | { kind: "peer_error"; err: Error }
  | { kind: "aborted"; reason: unknown };

/** One connection: connect, check the peer, write the request, read one line. */
function exchange(path: string, request: Uint8Array, uid: number, deadlineMs: number, signal?: AbortSignal): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    let settled = false;
    let opened = false;
    let sock: { terminate(): void } | undefined;
    let buf = new Uint8Array(256);
    let len = 0;
    let pending: Uint8Array | null = null;
    const finish = (o: Outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        sock?.terminate();
      } catch {
        /* closed */
      }
      buf.fill(0);
      resolve(o);
    };
    const timer = setTimeout(() => finish(opened ? { kind: "timeout" } : { kind: "connect_timeout" }), deadlineMs);
    const onAbort = () => finish({ kind: "aborted", reason: signal?.reason });
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort);
    }
    const write = (s: { write(b: Uint8Array): number }) => {
      if (!pending) return;
      const n = s.write(pending);
      if (n < 0) return; // closed: the close/end handler reports it
      pending = n < pending.length ? pending.subarray(n) : null;
    };
    let conn: Promise<unknown>;
    try {
      conn = Bun.connect({
        unix: path,
        allowHalfOpen: true,
        socket: {
          binaryType: "uint8array",
          open(s) {
            if (settled) {
              s.terminate();
              return;
            }
            opened = true;
            sock = s;
            // §A2.7 step 4: the agent's peer uid must be ours.
            const cred = peerCred(socketFd(s));
            if (typeof cred === "number") {
              finish({ kind: "peer_error", err: toErrno(cred) });
              return;
            }
            if (cred.uid !== uid) {
              finish({ kind: "peer", uid: cred.uid });
              return;
            }
            pending = request;
            write(s);
          },
          drain(s) {
            write(s);
          },
          data(_s, chunk: Uint8Array) {
            if (settled) return;
            if (len + chunk.length > buf.length) {
              const nb = new Uint8Array(Math.max(buf.length * 2, len + chunk.length));
              nb.set(buf.subarray(0, len));
              buf.fill(0);
              buf = nb;
            }
            buf.set(chunk, len);
            len += chunk.length;
            const limit = Math.min(len, MAX_LINE);
            for (let i = 0; i < limit; i++) {
              if (buf[i] === 0x0a) {
                finish({ kind: "line", line: buf.slice(0, i) });
                return;
              }
            }
            if (len >= MAX_LINE) finish({ kind: "too_large" });
          },
          end() {
            finish({ kind: "eof", partial: len > 0 });
          },
          close(_s, err) {
            if (err) finish({ kind: "reset", err });
            else finish({ kind: "eof", partial: len > 0 });
          },
          error(_s, err) {
            finish({ kind: "reset", err });
          },
          connectError(_s, err) {
            finish({ kind: "connect", err });
          },
        },
      } as Parameters<typeof Bun.connect>[0]);
    } catch (e) {
      finish({ kind: "connect", err: e });
      return;
    }
    conn.then(
      (s) => {
        if (settled) (s as { terminate(): void }).terminate();
      },
      (e) => finish({ kind: "connect", err: e }),
    );
  });
}

function pathGone(path: string): boolean {
  try {
    return lstatIfExists(path) === undefined;
  } catch {
    return false;
  }
}

/**
 * Sends one request to the vault's agent (§A2.7) and parses the answer (§A2.5).
 * `request` is the JSON line with its `\n`.
 */
export async function agentRequest(realPath: string, request: string, opts: ClientOptions = {}): Promise<AgentResult> {
  const uid = opts.uid ?? getuid();
  const sock = socketFor(realPath, opts);
  // Step 2: the folder check, without creating it.
  let dir: "ok" | "missing";
  try {
    dir = checkPrivateDir(sock.dir, uid);
  } catch (e) {
    throw agentError("%w", e);
  }
  if (dir === "missing") return { kind: "none" };
  const o = await exchange(sock.path, new TextEncoder().encode(request), opts.peerUid ?? uid, opts.deadlineMs ?? CLIENT_DEADLINE_MS, opts.signal);
  switch (o.kind) {
    case "aborted":
      throw o.reason ?? new DOMException("aborted", "AbortError");
    case "connect": {
      const code = errnoCode(o.err);
      if (code === "ENOENT" || code === "ECONNREFUSED") return { kind: "none" };
      throw agentError("connecting to %s: dial unix %s: connect: %w", sock.path, sock.path, toErrno(o.err));
    }
    case "connect_timeout":
      throw agentError("connecting to %s: dial unix %s: i/o timeout", sock.path, sock.path);
    case "peer":
      throw agentError("refusing the agent socket %s: peer is uid %d, not uid %d", sock.path, o.uid, opts.peerUid ?? uid);
    case "peer_error":
      throw agentError("refusing the agent socket %s: %w", sock.path, o.err);
    case "timeout":
      throw agentError("reading the answer: context deadline exceeded");
    case "too_large":
      throw agentError("reading the answer: message too large");
    case "eof":
      if (pathGone(sock.path)) return { kind: "none" };
      if (o.partial) throw agentError("reading the answer: connection closed in the middle of a message");
      throw agentError("the agent closed the connection without answering");
    case "reset": {
      if (pathGone(sock.path)) return { kind: "none" };
      const code = errnoCode(o.err);
      if (code === "ECONNRESET" || code === "EPIPE" || code === undefined) throw agentError("the agent closed the connection without answering");
      throw agentError("reading the answer: %w", toErrno(o.err));
    }
    case "line": {
      try {
        const p = parseAnswer(o.line);
        if (p.kind === "expired") return { kind: "none" };
        if (p.kind === "key_block_changed") return { kind: "key_block_changed" };
        return { kind: "answer", answer: p.answer };
      } finally {
        o.line.fill(0);
      }
    }
  }
}

function toStatus(a: Answer): AgentStatus {
  return { pid: a.pid, vault: a.vault, idleLeftMs: a.idleLeftMs, maxLeftMs: a.maxLeftMs };
}

/** `status` (§A2.5): the agent's times, or undefined when there is no agent. */
export async function agentStatus(realPath: string, opts: ClientOptions = {}): Promise<AgentStatus | undefined> {
  const r = await agentRequest(realPath, '{"v":1,"op":"status"}\n', opts);
  return r.kind === "answer" ? toStatus(r.answer) : undefined;
}

/** `stop` (§A2.5): the status from just before stopping, or undefined when there is no agent. */
export async function agentStop(realPath: string, opts: ClientOptions = {}): Promise<AgentStatus | undefined> {
  const r = await agentRequest(realPath, '{"v":1,"op":"stop"}\n', opts);
  return r.kind === "answer" ? toStatus(r.answer) : undefined;
}

export type KeyOutcome =
  | { kind: "key"; identity: X25519Identity }
  | { kind: "none" }
  | { kind: "key_block_changed" };

/**
 * `key` with the key block's digest (§A2.5): the vault key (validated: key-text rule and
 * bech32 X25519 identity), "none", or "key_block_changed". A served key restarts the
 * agent's idle time.
 */
export async function agentKey(realPath: string, digest: string, opts: ClientOptions = {}): Promise<KeyOutcome> {
  const r = await agentRequest(realPath, `{"v":1,"op":"key","key_block":"${digest}"}\n`, opts);
  if (r.kind !== "answer") return r;
  return { kind: "key", identity: keyFromAnswer(r.answer) };
}

/**
 * `passh lock`'s stop (§A2.9): send `stop`, then wait until the socket path is gone
 * (10 ms polling, at most 5 s; timeout → `agent: waiting for the agent (pid <n>) to exit:
 * context deadline exceeded`). Returns the stopped agent's status, or undefined when
 * there was none.
 */
export async function stopAgentAndWait(realPath: string, opts: ClientOptions & { waitMs?: number; pollMs?: number } = {}): Promise<AgentStatus | undefined> {
  const st = await agentStop(realPath, opts);
  if (!st) return undefined;
  const path = socketFor(realPath, opts).path;
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
  for (;;) {
    let gone: boolean;
    try {
      gone = lstatIfExists(path) === undefined;
    } catch (e) {
      throw agentError("waiting for the agent (pid %d) to exit: %w", st.pid, e);
    }
    if (gone) return st;
    if (Date.now() >= deadline) throw agentError("waiting for the agent (pid %d) to exit: context deadline exceeded", st.pid);
    await Bun.sleep(opts.pollMs ?? LOCK_POLL_MS);
  }
}

/** Reports whether an error is one of the client's `agent: …` errors. */
export function isAgentError(e: unknown): e is PasshError {
  return e instanceof PasshError && e.code === "agent";
}
