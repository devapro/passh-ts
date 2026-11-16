// A real pipe(2) for the extra descriptors of a child (fd 3: the agent's readiness pipe,
// gpg's --status-fd). Bun's own "pipe" slots beyond stdio are socket pairs, but the agent
// requires a FIFO on fd 3 (agent-session.md §A2.3 (a)), so the pipe is made here.

import { closeSync } from "node:fs";
import { dlopen, FFIType, read, type Pointer } from "bun:ffi";

const IS_DARWIN = process.platform === "darwin";
const O_CLOEXEC_LINUX = 0o2000000;

type Fn = (...args: any[]) => any;
let lib: { symbols: Record<string, Fn> } | undefined;

function libc(): { symbols: Record<string, Fn> } {
  if (lib) return lib;
  const names = IS_DARWIN ? ["/usr/lib/libSystem.B.dylib", "libc.dylib"] : ["libc.so.6", "libc.so"];
  const symbols: Record<string, { args: FFIType[]; returns: FFIType }> = IS_DARWIN
    ? { pipe: { args: [FFIType.ptr], returns: FFIType.i32 }, __error: { args: [], returns: FFIType.ptr } }
    : { pipe2: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 }, __errno_location: { args: [], returns: FFIType.ptr } };
  let last: unknown;
  for (const n of names) {
    try {
      lib = dlopen(n, symbols) as unknown as { symbols: Record<string, Fn> };
      return lib;
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** A pipe: [read end, write end]. Linux: both close-on-exec (pipe2 O_CLOEXEC). Throws on failure. */
export function makePipe(): [number, number] {
  const fds = new Int32Array(2);
  const l = libc();
  // macOS: plain pipe(); Bun's spawn starts children with only the descriptors it is given.
  const r = IS_DARWIN ? l.symbols.pipe!(fds) : l.symbols.pipe2!(fds, O_CLOEXEC_LINUX);
  if (r !== 0) {
    const p = l.symbols[IS_DARWIN ? "__error" : "__errno_location"]!() as Pointer | null;
    const errno = p ? read.i32(p, 0) : 0;
    throw new Error(`pipe: errno ${errno}`);
  }
  return [fds[0]!, fds[1]!];
}

/** Closes a descriptor, ignoring errors. */
export function closeQuietly(fd: number | null | undefined): void {
  if (fd === null || fd === undefined || fd < 0) return;
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
}
