// Byte sources for the line editor and the TUI: reading /dev/tty without blocking the
// event loop (see signals.ts). A read waits with poll(2) (macOS: select(2), as poll
// doesn't work on /dev/tty there) with timeout 0 between short timers (1 ms growing to
// 30 ms while idle: under 1% CPU at an idle prompt), then read(2)s exactly what it needs,
// so type-ahead beyond the answer stays in the kernel for the next prompt or the editor.
// Reads are therefore always interruptible: §A4's fallback (stop catching and re-raise
// the signal where a read can't be interrupted) is never needed.

import { readSync } from "node:fs";
import { pollIn, POLLNVAL, EINTR } from "../ffi/termios.ts";
import { osError } from "../fsx/oserror.ts";
import { SignalInterrupt, type SignalWatch } from "./signals.ts";

/** One byte at a time; null at end of input. */
export interface ByteSource {
  readByte(): Promise<number | null>;
}

const MAX_IDLE_MS = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Waits until fd has input (or end of input / hangup). Throws SignalInterrupt when the
 * watch caught a signal, an AbortError-like Error when `abort` fires.
 */
export async function waitReadable(fd: number, watch?: SignalWatch | null, abort?: AbortSignal): Promise<void> {
  let idle = 1;
  for (;;) {
    if (watch?.received) throw new SignalInterrupt(watch.received);
    if (abort?.aborted) throw abortError(abort);
    const r = pollIn(fd, 0);
    if (r > 0) {
      if (r & POLLNVAL) throw osError("read", "/dev/tty", "EBADF");
      return;
    }
    if (r < 0 && -r !== EINTR) throw osError("poll", "/dev/tty", -r);
    await sleep(idle);
    idle = Math.min(idle * 2, MAX_IDLE_MS);
  }
}

function abortError(a: AbortSignal): Error {
  const e = a.reason instanceof Error ? a.reason : new Error("aborted");
  return e;
}

/** Reads from a terminal descriptor byte by byte (see waitReadable). */
export class FdByteSource implements ByteSource {
  private readonly one = new Uint8Array(1);
  constructor(
    readonly fd: number,
    readonly watch: SignalWatch | null = null,
  ) {}

  async readByte(): Promise<number | null> {
    for (;;) {
      await waitReadable(this.fd, this.watch);
      let n: number;
      try {
        n = readSync(this.fd, this.one, 0, 1, null);
      } catch (e) {
        if ((e as { code?: string }).code === "EAGAIN" || (e as { code?: string }).code === "EINTR") continue;
        if (this.watch?.received) throw new SignalInterrupt(this.watch.received);
        throw osError("read", "/dev/tty", e);
      }
      if (n === 0) return null;
      return this.one[0]!;
    }
  }
}

/** A source over fixed bytes (tests); `null` entries stand for end of input (Ctrl-D in cooked mode). */
export class ArrayByteSource implements ByteSource {
  private i = 0;
  constructor(private readonly items: ReadonlyArray<number | null>) {}
  static of(...parts: Array<string | Uint8Array | null>): ArrayByteSource {
    const items: Array<number | null> = [];
    for (const p of parts) {
      if (p === null) items.push(null);
      else for (const b of typeof p === "string" ? new TextEncoder().encode(p) : p) items.push(b);
    }
    return new ArrayByteSource(items);
  }
  async readByte(): Promise<number | null> {
    if (this.i >= this.items.length) return null;
    return this.items[this.i++]!;
  }
  /** Bytes not read yet. */
  get remaining(): number {
    return this.items.length - this.i;
  }
}

/**
 * Async reading for the TUI and dialogs: `read()` resolves with the bytes available now
 * (at least one), or null at end of input. The event loop stays free while it waits.
 */
export class TtyReader {
  private closed = false;
  constructor(readonly fd: number) {}

  async read(max = 4096, abort?: AbortSignal): Promise<Uint8Array | null> {
    if (this.closed) return null;
    for (;;) {
      await waitReadable(this.fd, null, abort);
      const buf = new Uint8Array(max);
      let n: number;
      try {
        n = readSync(this.fd, buf, 0, max, null);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "EAGAIN" || code === "EINTR") continue;
        throw osError("read", "/dev/tty", e);
      }
      if (n === 0) return null;
      return buf.subarray(0, n);
    }
  }

  /** Stops reading: later reads return null. */
  close(): void {
    this.closed = true;
  }
}
