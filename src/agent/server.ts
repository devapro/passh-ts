// The agent's server (agent-session.md §A2.4 binding, §A2.5 protocol, §A2.6 serving and
// expiry): one request and one response per connection, the peer uid check, a 5 s
// deadline per connection, TTLs counted with max(monotonic, wall clock), the socket
// ownership check every second, and the shutdown order (stopping, socket removed if still
// ours, listener closed, connections drained, key wiped).
//
// Bun note: Bun.listen({unix}) unlinks the socket *path it was given* when the listener
// stops, even if that path now names another agent's socket. So the agent binds a
// temporary name in its 0700 folder, chmods it 0600 and moves it into place with
// rename-no-replace (EEXIST plays the part of bind's EADDRINUSE). Stopping the listener
// then only unlinks the (long gone) temporary name, and the real socket path is removed
// by the agent itself, only while it still has the recorded device and inode.

import { chmodSync, unlinkSync, type BigIntStats } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Socket, UnixSocketListener } from "bun";
import { constantTimeEqual } from "../age/index.ts";
import { createAgentDir, type AgentSocket } from "../config/index.ts";
import { getuid, peerCred, socketFd } from "../ffi/libc.ts";
import { errnoCode, isErrno, osError, toErrno } from "../fsx/oserror.ts";
import { lstatIfExists, sameFile } from "../fsx/files.ts";
import { renameNoReplace } from "../fsx/rename.ts";
import { errorf } from "../i18n/index.ts";
import { decodeRequest, encodeKeyResponse, encodeRefusal, encodeStatus, frameLine, refusal, WIRE, type Refusal, type StatusFields } from "./protocol.ts";
import { elapsedMs, now, systemClock, type Clock, type Instant } from "./times.ts";

/** One connection's deadline, both sides (§A1). */
export const CONN_DEADLINE_MS = 5000;
/** The socket ownership check (§A1). */
export const OWNERSHIP_CHECK_MS = 1000;
/** Binding: tries (§A2.4). */
const BIND_TRIES = 3;

export interface AgentServerOptions {
  /** The agent's real vault path (status `vault`). */
  vault: string;
  /** TTLs in milliseconds (> 0). */
  idleTtlMs: number;
  maxTtlMs: number;
  /** The key text `AGE-SECRET-KEY-1…` as ASCII bytes. The server owns it and wipes it at shutdown. */
  key: Uint8Array;
  /** Lower-case hex SHA-256 of the key block the key was unlocked with. */
  digest: string;
  /** The socket and its folder (src/config agentSocketPath). */
  socket: AgentSocket;
  /** Environment for the folder creation (state folder); default process.env. */
  env?: Record<string, string | undefined>;
  clock?: Clock;
  /** The agent's uid (default getuid()): the folder's owner, and what peers must have. */
  uid?: number;
  /** Test hook: the uid peers must have (default: uid). */
  peerUid?: number;
  /** The pid reported by status (default process.pid). */
  pid?: number;
  /** Test hooks. */
  connDeadlineMs?: number;
  ownershipCheckMs?: number;
}

export type ShutdownReason = "stop" | "expired" | "socket" | "signal" | "error";

interface Conn {
  buf: Uint8Array;
  len: number;
  answered: boolean;
  /** Bytes still to write, then end(). */
  pending: Uint8Array | null;
  /** Wipe `pending`'s buffer once written (the key response). */
  secret: Uint8Array | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
}

/** The binding failed in a way that ends the agent: the readiness `error: <text>` (§A2.3). */
export class BindError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "BindError";
  }
}

/**
 * The agent's server. `AgentServer.start` creates the folder and binds the socket; then
 * `done` resolves with the reason once the agent has shut down (key wiped).
 */
export class AgentServer {
  private readonly o: Required<Omit<AgentServerOptions, "env" | "peerUid">> & { env: Record<string, string | undefined>; peerUid: number };
  private readonly start: Instant;
  private lastUse: Instant;
  private stopping = false;
  private listener: UnixSocketListener<Conn> | undefined;
  private recorded: BigIntStats | undefined;
  private readonly conns = new Set<Socket<Conn>>();
  private loopTimer: ReturnType<typeof setTimeout> | undefined;
  private drainWaiters: Array<() => void> = [];
  private resolveDone!: (r: ShutdownReason) => void;
  /** Resolves once the agent has shut down. */
  readonly done: Promise<ShutdownReason>;
  private reason: ShutdownReason | undefined;

  private constructor(o: AgentServerOptions) {
    const uid = o.uid ?? getuid();
    this.o = {
      ...o,
      clock: o.clock ?? systemClock,
      uid,
      pid: o.pid ?? process.pid,
      connDeadlineMs: o.connDeadlineMs ?? CONN_DEADLINE_MS,
      ownershipCheckMs: o.ownershipCheckMs ?? OWNERSHIP_CHECK_MS,
      env: o.env ?? process.env,
      peerUid: o.peerUid ?? uid,
    };
    this.start = now(this.o.clock);
    this.lastUse = this.start;
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  /**
   * §A2.3 step (g): creates the folder (§A2.2) and binds the socket (§A2.4). Returns the
   * server, serving; or "running" when a live agent answers on the socket. Throws
   * BindError (folder errors as they are, bind errors prefixed `agent: `).
   */
  static async start(o: AgentServerOptions): Promise<AgentServer | "running"> {
    const s = new AgentServer(o);
    const r = await s.bind();
    if (r === "running") return r;
    s.loop();
    return s;
  }

  // -------------------------------------------------------------------------
  // Binding (§A2.4)

  private async bind(): Promise<"ok" | "running"> {
    const sock = this.o.socket;
    try {
      createAgentDir(sock, { env: this.o.env, uid: this.o.uid });
    } catch (e) {
      throw new BindError((e as Error).message, e);
    }
    // A temporary name in the 0700 folder; ".t" + 8 hex digits is shorter than the
    // 27-byte socket name, so it fits whenever the socket path does.
    let tmp = "";
    for (let i = 0; ; i++) {
      tmp = `${sock.dir}/.t${randomBytes(4).toString("hex")}`;
      try {
        this.listener = this.listen(tmp);
        break;
      } catch (e) {
        if (i < 5 && isErrno(e, "EADDRINUSE")) continue;
        throw new BindError(errorf("agent: listen unix %s: bind: %w", sock.path, toErrno(e)).message, e);
      }
    }
    try {
      chmodSync(tmp, 0o600);
    } catch (e) {
      this.closeListener();
      throw new BindError("agent: " + osError("chmod", sock.path, e).message, e);
    }
    for (let attempt = 0; attempt < BIND_TRIES; attempt++) {
      try {
        renameNoReplace(tmp, sock.path);
      } catch (e) {
        if (!isErrno(e, "EEXIST")) {
          this.closeListener();
          throw new BindError(errorf("agent: listen unix %s: bind: %w", sock.path, toErrno(e)).message, e);
        }
        // EADDRINUSE: lstat the path; gone → retry; not a socket → refuse; a socket →
        // connect: it answers → "running"; ECONNREFUSED/ENOENT → a crashed agent's
        // leftover: remove it and retry.
        let st: BigIntStats | undefined;
        try {
          st = lstatIfExists(sock.path);
        } catch (e2) {
          this.closeListener();
          throw new BindError("agent: " + (e2 as Error).message, e2);
        }
        if (!st) continue;
        if (!st.isSocket()) {
          this.closeListener();
          throw new BindError(`agent: ${sock.path} exists and is not a socket; refusing to replace it`);
        }
        const probe = await probeSocket(sock.path, this.o.connDeadlineMs);
        if (probe === "answers") {
          this.closeListener();
          return "running";
        }
        if (probe === "stale") {
          try {
            unlinkSync(sock.path);
          } catch (e3) {
            if (!isErrno(e3, "ENOENT")) {
              this.closeListener();
              throw new BindError("agent: " + osError("remove", sock.path, e3).message, e3);
            }
          }
          continue;
        }
        this.closeListener();
        throw new BindError(errorf("agent: connecting to %s: %w", sock.path, probe).message, probe);
      }
      // Bound: lstat must show a socket; record its device and inode.
      const st = lstatIfExists(sock.path);
      if (!st || !st.isSocket()) {
        this.closeListener();
        throw new BindError(`agent: ${sock.path} exists and is not a socket; refusing to replace it`);
      }
      this.recorded = st;
      return "ok";
    }
    this.closeListener();
    throw new BindError(`agent: ${sock.path} keeps reappearing`);
  }

  private listen(path: string): UnixSocketListener<Conn> {
    const self = this;
    return Bun.listen<Conn>({
      unix: path,
      allowHalfOpen: true,
      socket: {
        binaryType: "uint8array",
        open(s) {
          self.onOpen(s);
        },
        data(s, chunk) {
          self.onData(s, chunk as Uint8Array);
        },
        drain(s) {
          self.flush(s);
        },
        end(s) {
          // A close or half-close before a complete line: no answer (§A2.5 framing).
          if (!s.data.answered) self.closeConn(s, true);
        },
        close(s) {
          self.onClose(s);
        },
        error(s) {
          self.closeConn(s, true);
        },
      },
    } as Parameters<typeof Bun.listen<Conn>>[0]) as UnixSocketListener<Conn>;
  }

  private closeListener(): void {
    const l = this.listener;
    this.listener = undefined;
    try {
      l?.stop(false);
    } catch {
      /* already stopped */
    }
  }

  // -------------------------------------------------------------------------
  // Connections (§A2.5, §A2.6)

  private onOpen(s: Socket<Conn>): void {
    s.data = { buf: new Uint8Array(512), len: 0, answered: false, pending: null, secret: null, timer: undefined, closed: false };
    this.conns.add(s);
    // Check 1: the peer's uid must be the agent's; else closed unanswered.
    const cred = peerCred(socketFd(s));
    if (typeof cred === "number" || cred.uid !== this.o.peerUid) {
      this.closeConn(s, true);
      return;
    }
    s.data.timer = setTimeout(() => this.closeConn(s, true), this.o.connDeadlineMs);
  }

  private onData(s: Socket<Conn>, chunk: Uint8Array): void {
    const c = s.data;
    if (!c || c.answered || c.closed) return;
    if (c.len + chunk.length > c.buf.length) {
      const nb = new Uint8Array(Math.max(c.buf.length * 2, c.len + chunk.length));
      nb.set(c.buf.subarray(0, c.len));
      c.buf.fill(0);
      c.buf = nb;
    }
    c.buf.set(chunk, c.len);
    c.len += chunk.length;
    const f = frameLine(c.buf.subarray(0, c.len));
    if (f.kind === "more") return;
    c.answered = true;
    if (f.kind === "too_large") {
      this.send(s, encodeRefusal(refusal("bad_request", WIRE.tooLarge)));
      return;
    }
    this.handle(s, f.line);
  }

  private handle(s: Socket<Conn>, line: Uint8Array): void {
    const req = decodeRequest(line);
    if (req.refused) {
      this.send(s, encodeRefusal(req));
      return;
    }
    switch (req.op) {
      case "status":
        this.send(s, encodeStatus(this.status()));
        return;
      case "stop": {
        const st = this.status();
        this.send(s, encodeStatus(st));
        void this.shutdown("stop");
        return;
      }
      case "key": {
        const r = this.keyCheck(req.keyBlock);
        if (r) {
          this.send(s, encodeRefusal(r));
          return;
        }
        this.lastUse = now(this.o.clock);
        const resp = encodeKeyResponse(this.o.key);
        this.send(s, resp, true);
        return;
      }
    }
  }

  /** Checks 8 and 9 (§A2.5); undefined when the key is served. */
  private keyCheck(keyBlock: string): Refusal | undefined {
    const enc = new TextEncoder();
    if (!constantTimeEqual(enc.encode(keyBlock), enc.encode(this.o.digest))) return refusal("key_block_changed", WIRE.keyBlockChanged);
    if (this.stopping || this.expired(now(this.o.clock))) return refusal("expired", WIRE.expired);
    return undefined;
  }

  private send(s: Socket<Conn>, bytes: Uint8Array, secret = false): void {
    const c = s.data;
    c.pending = bytes;
    c.secret = secret ? bytes : null;
    this.flush(s);
  }

  /** Writes what is pending; when all is written, ends the connection (both sides close). */
  private flush(s: Socket<Conn>): void {
    const c = s.data;
    if (!c || !c.pending || c.closed) return;
    const n = s.write(c.pending);
    if (n < 0) {
      this.closeConn(s, true);
      return;
    }
    if (n < c.pending.length) {
      c.pending = c.pending.subarray(n);
      return;
    }
    c.pending = null;
    if (c.secret) {
      c.secret.fill(0);
      c.secret = null;
    }
    this.closeConn(s, false);
  }

  private closeConn(s: Socket<Conn>, abort: boolean): void {
    const c = s.data;
    if (!c || c.closed) return;
    c.closed = true;
    clearTimeout(c.timer);
    c.buf.fill(0);
    if (c.secret) {
      c.secret.fill(0);
      c.secret = null;
    }
    c.pending = null;
    try {
      if (abort) s.terminate();
      else s.end();
    } catch {
      /* gone */
    }
    // Bun calls close() later; count the connection as finished now.
    this.finish(s);
  }

  private onClose(s: Socket<Conn>): void {
    const c = s.data;
    if (c && !c.closed) {
      c.closed = true;
      clearTimeout(c.timer);
      c.buf.fill(0);
      if (c.secret) c.secret.fill(0);
    }
    this.finish(s);
  }

  private finish(s: Socket<Conn>): void {
    if (!this.conns.delete(s)) return;
    if (this.conns.size === 0) for (const w of this.drainWaiters.splice(0)) w();
  }

  // -------------------------------------------------------------------------
  // Time (§A2.6)

  private expired(at: Instant): boolean {
    return elapsedMs(this.start, at) >= this.o.maxTtlMs || elapsedMs(this.lastUse, at) >= this.o.idleTtlMs;
  }

  /** The status answer now: times left clamped to ≥ 1 ms. */
  status(): StatusFields {
    const at = now(this.o.clock);
    const idle = Math.max(1, Math.trunc(this.o.idleTtlMs - elapsedMs(this.lastUse, at)));
    const max = Math.max(1, Math.trunc(this.o.maxTtlMs - elapsedMs(this.start, at)));
    return { pid: this.o.pid, vault: this.o.vault, idleLeftMs: idle, maxLeftMs: max };
  }

  /**
   * Main loop: check expiry; sleep until the earlier of 1 s and the next expiry (≥ 1 ms);
   * on wake, lstat the socket path and exit if it is missing or replaced.
   */
  private loop(): void {
    if (this.stopping) return;
    const at = now(this.o.clock);
    if (this.expired(at)) {
      void this.shutdown("expired");
      return;
    }
    const next = Math.min(this.o.maxTtlMs - elapsedMs(this.start, at), this.o.idleTtlMs - elapsedMs(this.lastUse, at));
    const delay = Math.max(1, Math.min(this.o.ownershipCheckMs, Math.ceil(next)));
    this.loopTimer = setTimeout(() => {
      if (this.stopping) return;
      if (!this.socketStillOurs()) {
        void this.shutdown("socket");
        return;
      }
      this.loop();
    }, delay);
  }

  /** Re-runs the main loop's checks now (tests with a fake clock). */
  tick(): void {
    clearTimeout(this.loopTimer);
    if (this.stopping) return;
    if (!this.socketStillOurs()) {
      void this.shutdown("socket");
      return;
    }
    this.loop();
  }

  private socketStillOurs(): boolean {
    let st: BigIntStats | undefined;
    try {
      st = lstatIfExists(this.o.socket.path);
    } catch {
      return false;
    }
    return st !== undefined && this.recorded !== undefined && sameFile(st, this.recorded);
  }

  // -------------------------------------------------------------------------
  // Shutdown (§A2.6)

  /**
   * Shuts down, in order: mark stopping; remove the socket path only if it still has the
   * recorded device/inode; close the listener; wait for connections in progress;
   * overwrite the key with zeros. Then `done` resolves.
   */
  async shutdown(reason: ShutdownReason): Promise<void> {
    if (this.stopping) return this.done.then(() => undefined);
    this.stopping = true;
    this.reason = reason;
    clearTimeout(this.loopTimer);
    if (this.socketStillOurs()) {
      try {
        unlinkSync(this.o.socket.path);
      } catch {
        /* removed meanwhile */
      }
    }
    this.closeListener();
    if (this.conns.size > 0) await new Promise<void>((r) => this.drainWaiters.push(r));
    this.o.key.fill(0);
    this.resolveDone(reason);
  }

  /** The reason the agent stopped, once it has. */
  get stoppedBy(): ShutdownReason | undefined {
    return this.reason;
  }

  /** Connections in progress (tests). */
  get connections(): number {
    return this.conns.size;
  }
}

/**
 * Connects to an existing socket (§A2.4): "answers" when the connection is accepted,
 * "stale" for ECONNREFUSED/ENOENT (a crashed agent's leftover), else the error.
 */
async function probeSocket(path: string, deadlineMs: number): Promise<"answers" | "stale" | Error> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sock: Socket<undefined> | undefined;
  let timedOut = false;
  try {
    const conn = Bun.connect({
      unix: path,
      socket: { data() {}, error() {}, connectError() {} },
    });
    const timeout = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), deadlineMs)));
    const r = await Promise.race([conn, timeout]);
    if (r === "timeout") {
      timedOut = true;
      conn.then((s) => s.terminate(), () => {});
      return errorf("dial unix %s: i/o timeout", path);
    }
    sock = r;
    return "answers";
  } catch (e) {
    if (timedOut) return toErrno(e);
    const code = errnoCode(e);
    if (code === "ECONNREFUSED" || code === "ENOENT") return "stale";
    return errorf("dial unix %s: connect: %w", path, toErrno(e));
  } finally {
    clearTimeout(timer);
    try {
      sock?.terminate();
    } catch {}
  }
}
