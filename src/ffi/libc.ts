// Generic libc bindings through bun:ffi (spec §10.1): the few system calls Node's fs
// module doesn't offer. Linux (glibc, `libc.so.6`) is tested; the macOS variant
// (libSystem) is written from the headers and untested.
//
// Every call returns 0 (or a result object) on success and a positive errno on failure;
// errno is read right after the call through `__errno_location()` (Linux) or
// `__error()` (macOS) on the same thread. Callers turn errnos into errors with
// src/fsx/oserror.ts (errnoError, osError).
//
// Constants that differ between the systems are taken from the platform's table below
// (ERRNO); flock's LOCK_* and RLIMIT_CORE are the same on both.
//
// Sockets: Bun's own sockets (Bun.listen / Bun.connect with `unix:`, and node:net)
// expose the OS descriptor as `socket.fd`, so the agent can use them directly and ask
// for the peer's credentials with peerCred(socket.fd); no FFI socket primitives are needed.

import { dlopen, FFIType, read, type Pointer } from "bun:ffi";

export const IS_LINUX = process.platform === "linux";
export const IS_DARWIN = process.platform === "darwin";

/** flock(2) operations (same values on Linux and macOS). */
export const LOCK_SH = 1;
export const LOCK_EX = 2;
export const LOCK_NB = 4;
export const LOCK_UN = 8;

/** RLIMIT_CORE (4 on Linux and macOS). */
export const RLIMIT_CORE = 4;

/** statfs f_type magic numbers of Linux memory file systems (agent-session.md §A6). */
export const TMPFS_MAGIC = 0x01021994;
export const RAMFS_MAGIC = 0x858458f6;

const LINUX_ERRNO: Record<string, number> = {
  EPERM: 1, ENOENT: 2, ESRCH: 3, EINTR: 4, EIO: 5, ENXIO: 6, E2BIG: 7, ENOEXEC: 8, EBADF: 9, ECHILD: 10,
  EAGAIN: 11, ENOMEM: 12, EACCES: 13, EFAULT: 14, ENOTBLK: 15, EBUSY: 16, EEXIST: 17, EXDEV: 18, ENODEV: 19,
  ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENFILE: 23, EMFILE: 24, ENOTTY: 25, ETXTBSY: 26, EFBIG: 27, ENOSPC: 28,
  ESPIPE: 29, EROFS: 30, EMLINK: 31, EPIPE: 32, EDOM: 33, ERANGE: 34, EDEADLK: 35, ENAMETOOLONG: 36,
  ENOLCK: 37, ENOSYS: 38, ENOTEMPTY: 39, ELOOP: 40, ENOTSOCK: 88, EOPNOTSUPP: 95, EAFNOSUPPORT: 97,
  EADDRINUSE: 98, EADDRNOTAVAIL: 99, ENETDOWN: 100, ENETUNREACH: 101, ECONNABORTED: 103, ECONNRESET: 104,
  ENOBUFS: 105, EISCONN: 106, ENOTCONN: 107, ETIMEDOUT: 110, ECONNREFUSED: 111, EHOSTUNREACH: 113,
  EALREADY: 114, EINPROGRESS: 115, ESTALE: 116, EDQUOT: 122,
};

const DARWIN_ERRNO: Record<string, number> = {
  EPERM: 1, ENOENT: 2, ESRCH: 3, EINTR: 4, EIO: 5, ENXIO: 6, E2BIG: 7, ENOEXEC: 8, EBADF: 9, ECHILD: 10,
  EDEADLK: 11, ENOMEM: 12, EACCES: 13, EFAULT: 14, ENOTBLK: 15, EBUSY: 16, EEXIST: 17, EXDEV: 18, ENODEV: 19,
  ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENFILE: 23, EMFILE: 24, ENOTTY: 25, ETXTBSY: 26, EFBIG: 27, ENOSPC: 28,
  ESPIPE: 29, EROFS: 30, EMLINK: 31, EPIPE: 32, EDOM: 33, ERANGE: 34, EAGAIN: 35, EINPROGRESS: 36,
  EALREADY: 37, ENOTSOCK: 38, ENOTSUP: 45, EAFNOSUPPORT: 47, EADDRINUSE: 48, EADDRNOTAVAIL: 49,
  ENETDOWN: 50, ENETUNREACH: 51, ECONNABORTED: 53, ECONNRESET: 54, ENOBUFS: 55, EISCONN: 56, ENOTCONN: 57,
  ETIMEDOUT: 60, ECONNREFUSED: 61, ELOOP: 62, ENAMETOOLONG: 63, EHOSTUNREACH: 65, ENOTEMPTY: 66,
  EDQUOT: 69, ESTALE: 70, ENOLCK: 77, ENOSYS: 78, EOPNOTSUPP: 102,
};

/** errno numbers of this platform by name. On Linux ENOTSUP = EOPNOTSUPP and EWOULDBLOCK = EAGAIN. */
export const ERRNO: Readonly<Record<string, number>> = (() => {
  const t: Record<string, number> = { ...(IS_DARWIN ? DARWIN_ERRNO : LINUX_ERRNO) };
  if (t.ENOTSUP === undefined) t.ENOTSUP = t.EOPNOTSUPP!;
  t.EWOULDBLOCK = t.EAGAIN!;
  return t;
})();

const ERRNO_NAMES: Map<number, string> = (() => {
  const m = new Map<number, string>();
  // First name wins: EAGAIN before EWOULDBLOCK, EOPNOTSUPP before ENOTSUP on Linux.
  for (const [name, n] of Object.entries(IS_DARWIN ? DARWIN_ERRNO : LINUX_ERRNO)) if (!m.has(n)) m.set(n, name);
  return m;
})();

/** The name of an errno of this platform ("ENOENT"), or `errno <n>` for an unknown one. */
export function errnoName(n: number): string {
  return ERRNO_NAMES.get(n) ?? `errno ${n}`;
}

// ---------------------------------------------------------------------------
// Loading

type Lib = { symbols: Record<string, (...args: any[]) => any> };

const LIBC_NAMES = IS_DARWIN ? ["/usr/lib/libSystem.B.dylib", "libc.dylib"] : ["libc.so.6"];

function openLib(symbols: Record<string, { args: FFIType[]; returns: FFIType }>): Lib {
  let last: unknown;
  for (const name of LIBC_NAMES) {
    try {
      return dlopen(name, symbols) as unknown as Lib;
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

let core: Lib | undefined;
function lib(): Lib {
  if (!core) {
    core = openLib({
      [IS_DARWIN ? "__error" : "__errno_location"]: { args: [], returns: FFIType.ptr },
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      getrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      setrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      getuid: { args: [], returns: FFIType.u32 },
      geteuid: { args: [], returns: FFIType.u32 },
      uname: { args: [FFIType.ptr], returns: FFIType.i32 },
      getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    });
  }
  return core;
}

/** Optional symbols are loaded one by one: a missing one (old libc) must not break the rest. */
const optional = new Map<string, ((...args: any[]) => any) | null>();
function optionalSymbol(name: string, args: FFIType[], returns: FFIType): ((...args: any[]) => any) | null {
  if (optional.has(name)) return optional.get(name)!;
  let fn: ((...args: any[]) => any) | null = null;
  try {
    fn = openLib({ [name]: { args, returns } }).symbols[name] ?? null;
  } catch {
    fn = null;
  }
  optional.set(name, fn);
  return fn;
}

function errno(): number {
  const p = lib().symbols[IS_DARWIN ? "__error" : "__errno_location"]!() as Pointer | null;
  return p ? read.i32(p, 0) : 0;
}

function cstr(s: string): Buffer | undefined {
  if (s.includes("\0")) return undefined;
  return Buffer.from(s + "\0", "utf8");
}

// ---------------------------------------------------------------------------
// Calls

/** flock(2). Returns 0 or an errno (EWOULDBLOCK when LOCK_NB finds the lock busy). */
export function flock(fd: number, op: number): number {
  const r = lib().symbols.flock!(fd, op) as number;
  return r === 0 ? 0 : errno();
}

const AT_FDCWD = -100;
const RENAME_NOREPLACE = 1; // Linux
const RENAME_EXCHANGE = 2; // Linux
const RENAME_SWAP = 0x2; // macOS renamex_np
const RENAME_EXCL = 0x4; // macOS renamex_np

/** renameat2 syscall numbers, for a libc without the renameat2 wrapper (glibc < 2.28). */
const SYS_RENAMEAT2: Record<string, number> = { x64: 316, arm64: 276, arm: 382, ia32: 353 };

function renameFlags(a: string, b: string, linuxFlags: number, darwinFlags: number): number {
  const ca = cstr(a);
  const cb = cstr(b);
  if (!ca || !cb) return ERRNO.EINVAL!;
  if (IS_DARWIN) {
    const fn = optionalSymbol("renamex_np", [FFIType.ptr, FFIType.ptr, FFIType.u32], FFIType.i32);
    if (!fn) return ERRNO.ENOSYS!;
    return fn(ca, cb, darwinFlags) === 0 ? 0 : errno();
  }
  if (!IS_LINUX) return ERRNO.ENOSYS!;
  const fn = optionalSymbol("renameat2", [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], FFIType.i32);
  if (fn) return fn(AT_FDCWD, ca, AT_FDCWD, cb, linuxFlags) === 0 ? 0 : errno();
  const nr = SYS_RENAMEAT2[process.arch];
  const sys = optionalSymbol("syscall", [FFIType.i64, FFIType.i64, FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.u64], FFIType.i64);
  if (nr === undefined || !sys) return ERRNO.ENOSYS!;
  const r = sys(BigInt(nr), BigInt(AT_FDCWD), ca, BigInt(AT_FDCWD), cb, BigInt(linuxFlags));
  return Number(r) === 0 ? 0 : errno();
}

/** Atomically swaps two names (Linux RENAME_EXCHANGE, macOS RENAME_SWAP). 0 or an errno. */
export function renameExchange(a: string, b: string): number {
  return renameFlags(a, b, RENAME_EXCHANGE, RENAME_SWAP);
}

/** Renames without replacing (Linux RENAME_NOREPLACE, macOS RENAME_EXCL). 0 or an errno (EEXIST). */
export function renameNoReplace(a: string, b: string): number {
  return renameFlags(a, b, RENAME_NOREPLACE, RENAME_EXCL);
}

/** setrlimit(2) with soft and hard limits. 0 or an errno. */
export function setrlimit(resource: number, soft: bigint, hard: bigint): number {
  const buf = new BigUint64Array([soft, hard]);
  return lib().symbols.setrlimit!(resource, buf) === 0 ? 0 : errno();
}

/** getrlimit(2): the soft and hard limits, or an errno. */
export function getrlimit(resource: number): { soft: bigint; hard: bigint } | number {
  const buf = new BigUint64Array(2);
  if (lib().symbols.getrlimit!(resource, buf) !== 0) return errno();
  return { soft: buf[0]!, hard: buf[1]! };
}

/** The real uid (getuid). */
export function getuid(): number {
  return typeof process.getuid === "function" ? process.getuid() : (lib().symbols.getuid!() as number);
}

/** The effective uid (geteuid). */
export function geteuid(): number {
  return typeof process.geteuid === "function" ? process.geteuid() : (lib().symbols.geteuid!() as number);
}

/** The process umask, without changing it. */
export function getUmask(): number {
  // process.umask() with no argument reads it (Node's deprecated form, still supported).
  return process.umask();
}

export interface StatfsInfo {
  /** Linux: f_type, the file system magic number. macOS: f_type (not a magic number). */
  type: number;
  /** macOS: f_fstypename ("apfs", "tmpfs", …). Linux: a name for the known magic numbers, else "". */
  typeName: string;
}

const LINUX_FS_NAMES: Record<number, string> = {
  [TMPFS_MAGIC]: "tmpfs",
  [RAMFS_MAGIC]: "ramfs",
  0xef53: "ext4",
  0x58465342: "xfs",
  0x9123683e: "btrfs",
  0x4d44: "vfat",
  0x2011bab0: "exfat",
  0x65735546: "fuse",
  0x6969: "nfs",
  0x794c7630: "overlayfs",
  0x01021997: "v9fs",
};

/** statfs(2) of a path: the file system type, or an errno. */
export function statfs(path: string): StatfsInfo | number {
  const c = cstr(path);
  if (!c) return ERRNO.EINVAL!;
  if (IS_DARWIN) {
    // struct statfs (64-bit inodes): f_type at 60 (u32), f_fstypename[16] at 72; size 2168.
    const fn = optionalSymbol("statfs$INODE64", [FFIType.ptr, FFIType.ptr], FFIType.i32) ?? optionalSymbol("statfs", [FFIType.ptr, FFIType.ptr], FFIType.i32);
    if (!fn) return ERRNO.ENOSYS!;
    const buf = new Uint8Array(4096);
    if (fn(c, buf) !== 0) return errno();
    const dv = new DataView(buf.buffer);
    const name = buf.subarray(72, 88);
    const end = name.indexOf(0);
    return { type: dv.getUint32(60, true), typeName: new TextDecoder().decode(name.subarray(0, end < 0 ? 16 : end)) };
  }
  // Linux 64-bit: struct statfs starts with long f_type.
  const fn = optionalSymbol("statfs", [FFIType.ptr, FFIType.ptr], FFIType.i32);
  if (!fn) return ERRNO.ENOSYS!;
  const buf = new Uint8Array(512);
  if (fn(c, buf) !== 0) return errno();
  const t = Number(new DataView(buf.buffer).getBigUint64(0, true) & 0xffffffffn);
  return { type: t, typeName: LINUX_FS_NAMES[t] ?? "" };
}

export interface Utsname {
  sysname: string;
  nodename: string;
  release: string;
  version: string;
  machine: string;
}

/** uname(2), or an errno. */
export function uname(): Utsname | number {
  // Linux: 6 fields of 65 bytes; macOS: 5 fields of 256 bytes.
  const len = IS_DARWIN ? 256 : 65;
  const buf = new Uint8Array(len * 6);
  if (lib().symbols.uname!(buf) !== 0) return errno();
  const field = (i: number) => {
    const f = buf.subarray(i * len, (i + 1) * len);
    const end = f.indexOf(0);
    return new TextDecoder().decode(f.subarray(0, end < 0 ? len : end));
  };
  return { sysname: field(0), nodename: field(1), release: field(2), version: field(3), machine: field(4) };
}

export interface PeerCred {
  uid: number;
  gid: number;
  /** The peer's pid (Linux SO_PEERCRED; macOS LOCAL_PEERPID), 0 if unknown. */
  pid: number;
}

/**
 * The credentials of the peer of a connected AF_UNIX socket (agent-session.md §A2.2
 * "uids": the peer's effective uid). Linux getsockopt(SO_PEERCRED); macOS getpeereid
 * (+ LOCAL_PEERPID). `fd` is the socket's descriptor, e.g. `socket.fd` of a Bun socket.
 * Returns an errno on failure.
 */
export function peerCred(fd: number): PeerCred | number {
  if (IS_DARWIN) {
    const fn = optionalSymbol("getpeereid", [FFIType.i32, FFIType.ptr, FFIType.ptr], FFIType.i32);
    if (!fn) return ERRNO.ENOSYS!;
    const uid = new Uint32Array(1);
    const gid = new Uint32Array(1);
    if (fn(fd, uid, gid) !== 0) return errno();
    // SOL_LOCAL = 0, LOCAL_PEERPID = 0x002
    const pid = new Int32Array(1);
    const plen = new Uint32Array([4]);
    const ok = lib().symbols.getsockopt!(fd, 0, 0x002, pid, plen) === 0;
    return { uid: uid[0]!, gid: gid[0]!, pid: ok ? pid[0]! : 0 };
  }
  // SOL_SOCKET = 1, SO_PEERCRED = 17; struct ucred { pid_t pid; uid_t uid; gid_t gid; }
  const buf = new Uint8Array(12);
  const len = new Uint32Array([12]);
  if (lib().symbols.getsockopt!(fd, 1, 17, buf, len) !== 0) return errno();
  const dv = new DataView(buf.buffer);
  return { pid: dv.getInt32(0, true), uid: dv.getUint32(4, true), gid: dv.getUint32(8, true) };
}

/**
 * The OS descriptor of a connected socket: Bun's own sockets (Bun.listen / Bun.connect)
 * have `fd` at run time (not declared in @types/bun); node:net sockets have `_handle.fd`.
 * Returns -1 when there is none.
 */
export function socketFd(s: unknown): number {
  const o = s as { fd?: unknown; _handle?: { fd?: unknown } } | null;
  if (o && typeof o.fd === "number") return o.fd;
  if (o && o._handle && typeof o._handle.fd === "number") return o._handle.fd;
  return -1;
}
