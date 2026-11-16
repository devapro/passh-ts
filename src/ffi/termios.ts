// Terminal control through bun:ffi (agent-session.md §A4): tcgetattr/tcsetattr, a
// cfmakeraw(3) equivalent, tcflush(TCIFLUSH), isatty, poll(2), the window size
// (TIOCGWINSZ) and the controlling terminal's device number (TIOCGDEV, Linux).
//
// Struct layouts: Linux (glibc) here, macOS in termios-darwin.ts. A termios value is kept
// as an opaque byte copy of the C struct, so saving and restoring never loses a field.
// Linux is tested; the macOS layout and its variadic ioctl call are written from the
// headers and the AAPCS64 calling convention, untested.
//
// Every call returns 0 (or a result) on success and a positive errno on failure.

import { dlopen, FFIType, read, type Pointer } from "bun:ffi";
import { DARWIN_LAYOUT } from "./termios-darwin.ts";

export const IS_LINUX = process.platform === "linux";
export const IS_DARWIN = process.platform === "darwin";

/** Offsets, sizes and flag values of struct termios on one system. */
export interface TermiosLayout {
  size: number;
  /** Bytes of tcflag_t: 4 on Linux, 8 on macOS. Flags are read and written in the low 32 bits. */
  flagSize: number;
  iflag: number;
  oflag: number;
  cflag: number;
  lflag: number;
  cc: number;
  nccs: number;
  VMIN: number;
  VTIME: number;
  VINTR: number;
  VEOF: number;
  IGNBRK: number;
  BRKINT: number;
  PARMRK: number;
  ISTRIP: number;
  INLCR: number;
  IGNCR: number;
  ICRNL: number;
  IXON: number;
  OPOST: number;
  ONLCR: number;
  ECHO: number;
  ECHONL: number;
  ICANON: number;
  ISIG: number;
  IEXTEN: number;
  CSIZE: number;
  PARENB: number;
  CS8: number;
  TCSANOW: number;
  TCSADRAIN: number;
  TCSAFLUSH: number;
  TCIFLUSH: number;
  TIOCGWINSZ: number;
  /** 0 where the system has no TIOCGDEV. */
  TIOCGDEV: number;
}

//   struct termios {            offset (glibc, every Linux architecture Bun runs on)
//     tcflag_t c_iflag;          0
//     tcflag_t c_oflag;          4
//     tcflag_t c_cflag;          8
//     tcflag_t c_lflag;         12
//     cc_t     c_line;          16
//     cc_t     c_cc[32];        17
//     speed_t  c_ispeed;        52
//     speed_t  c_ospeed;        56
//   };                          size 60
const LINUX_LAYOUT: TermiosLayout = {
  size: 60,
  flagSize: 4,
  iflag: 0,
  oflag: 4,
  cflag: 8,
  lflag: 12,
  cc: 17,
  nccs: 32,
  VMIN: 6,
  VTIME: 5,
  VINTR: 0,
  VEOF: 4,
  IGNBRK: 0o1,
  BRKINT: 0o2,
  PARMRK: 0o10,
  ISTRIP: 0o40,
  INLCR: 0o100,
  IGNCR: 0o200,
  ICRNL: 0o400,
  IXON: 0o2000,
  OPOST: 0o1,
  ONLCR: 0o4,
  ECHO: 0o10,
  ECHONL: 0o100,
  ICANON: 0o2,
  ISIG: 0o1,
  IEXTEN: 0o100000,
  CSIZE: 0o60,
  PARENB: 0o400,
  CS8: 0o60,
  TCSANOW: 0,
  TCSADRAIN: 1,
  TCSAFLUSH: 2,
  TCIFLUSH: 0,
  TIOCGWINSZ: 0x5413,
  // _IOR('T', 0x32, unsigned int)
  TIOCGDEV: 0x80045432,
};

/** The struct layout of this system. */
export const LAYOUT: TermiosLayout = IS_DARWIN ? DARWIN_LAYOUT : LINUX_LAYOUT;

/** poll(2) event bits (the same on Linux and macOS). */
export const POLLIN = 0x1;
export const POLLERR = 0x8;
export const POLLHUP = 0x10;
export const POLLNVAL = 0x20;

/** errno values used here (Linux; macOS differs only where noted). */
export const EINTR = 4;
export const ENOTTY = 25;
export const EBADF = 9;

// ---------------------------------------------------------------------------
// Loading

type Fn = (...args: any[]) => any;
type Lib = { symbols: Record<string, Fn> };

const LIBC_NAMES = IS_DARWIN ? ["/usr/lib/libSystem.B.dylib", "libc.dylib"] : ["libc.so.6", "libc.so"];
const DARWIN_ARM64 = IS_DARWIN && process.arch === "arm64";

function ioctlArgs(): FFIType[] {
  // Apple's arm64 ABI passes variadic arguments on the stack. Bun's FFI can't call a
  // variadic function, so on darwin/arm64 the pointer is passed as the ninth argument:
  // eight register arguments (fd, request, six fillers), then the first stack slot,
  // which is exactly where ioctl's va_arg reads it. Untested (no Mac here).
  if (DARWIN_ARM64) return [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.ptr];
  return [FFIType.i32, FFIType.u64, FFIType.ptr];
}

let lib: Lib | undefined;
function libc(): Lib {
  if (lib) return lib;
  const symbols = {
    [IS_DARWIN ? "__error" : "__errno_location"]: { args: [], returns: FFIType.ptr },
    tcgetattr: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    tcsetattr: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    tcflush: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    isatty: { args: [FFIType.i32], returns: FFIType.i32 },
    poll: { args: [FFIType.ptr, IS_DARWIN ? FFIType.u32 : FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    ...(IS_DARWIN ? { select: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } } : {}),
    ioctl: { args: ioctlArgs(), returns: FFIType.i32 },
  };
  let last: unknown;
  for (const name of LIBC_NAMES) {
    try {
      lib = dlopen(name, symbols) as unknown as Lib;
      return lib;
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

function errno(): number {
  const p = libc().symbols[IS_DARWIN ? "__error" : "__errno_location"]!() as Pointer | null;
  return p ? read.i32(p, 0) : 0;
}

function ioctl(fd: number, request: number, arg: Uint8Array): number {
  const f = libc().symbols.ioctl!;
  const r = DARWIN_ARM64 ? f(fd, BigInt(request), 0n, 0n, 0n, 0n, 0n, 0n, arg) : f(fd, BigInt(request), arg);
  return r === -1 ? errno() || ENOTTY : 0;
}

// ---------------------------------------------------------------------------
// termios

/** A saved terminal state: a copy of the C struct. */
export type Termios = Uint8Array;

/** tcgetattr(3): the terminal's state, or an errno (ENOTTY for a file that isn't a terminal). */
export function tcgetattr(fd: number): Termios | number {
  const buf = new Uint8Array(LAYOUT.size + 16);
  if (libc().symbols.tcgetattr!(fd, buf) !== 0) return errno() || ENOTTY;
  return buf;
}

export type When = "now" | "drain" | "flush";

/** tcsetattr(3). `when`: TCSANOW (default), TCSADRAIN or TCSAFLUSH. Returns 0 or an errno. */
export function tcsetattr(fd: number, t: Termios, when: When = "now"): number {
  const w = when === "now" ? LAYOUT.TCSANOW : when === "drain" ? LAYOUT.TCSADRAIN : LAYOUT.TCSAFLUSH;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (libc().symbols.tcsetattr!(fd, w, t) === 0) return 0;
    const e = errno();
    if (e !== EINTR) return e || ENOTTY;
  }
  return EINTR;
}

function getFlag(t: Termios, off: number): number {
  return new DataView(t.buffer, t.byteOffset, t.byteLength).getUint32(off, true);
}

function setFlag(t: Termios, off: number, v: number): void {
  new DataView(t.buffer, t.byteOffset, t.byteLength).setUint32(off, v >>> 0, true);
}

/** The local mode flags (c_lflag, low 32 bits). */
export function lflag(t: Termios): number {
  return getFlag(t, LAYOUT.lflag);
}

/** The input mode flags (c_iflag, low 32 bits). */
export function iflag(t: Termios): number {
  return getFlag(t, LAYOUT.iflag);
}

/** The output mode flags (c_oflag, low 32 bits). */
export function oflag(t: Termios): number {
  return getFlag(t, LAYOUT.oflag);
}

/** Reports whether the state echoes input (ECHO). */
export function echoOn(t: Termios): boolean {
  return (lflag(t) & LAYOUT.ECHO) !== 0;
}

/** Reports whether the state is canonical (line-buffered, ICANON). */
export function canonicalOn(t: Termios): boolean {
  return (lflag(t) & LAYOUT.ICANON) !== 0;
}

/**
 * A raw copy of a state, as cfmakeraw(3) (agent-session.md §A4): echo, canonical mode,
 * signal keys, output processing, CR/NL translation and flow control off; 8 bits;
 * VMIN 1, VTIME 0. The original isn't changed.
 */
export function makeRaw(t: Termios): Termios {
  const r = new Uint8Array(t);
  const L = LAYOUT;
  setFlag(r, L.iflag, getFlag(r, L.iflag) & ~(L.IGNBRK | L.BRKINT | L.PARMRK | L.ISTRIP | L.INLCR | L.IGNCR | L.ICRNL | L.IXON));
  setFlag(r, L.oflag, getFlag(r, L.oflag) & ~L.OPOST);
  setFlag(r, L.lflag, getFlag(r, L.lflag) & ~(L.ECHO | L.ECHONL | L.ICANON | L.ISIG | L.IEXTEN));
  setFlag(r, L.cflag, (getFlag(r, L.cflag) & ~(L.CSIZE | L.PARENB)) | L.CS8);
  r[L.cc + L.VMIN] = 1;
  r[L.cc + L.VTIME] = 0;
  return r;
}

/**
 * Discards input received but not read (tcflush TCIFLUSH; on macOS libc implements it
 * as ioctl TIOCFLUSH with FREAD). Returns 0 or an errno.
 */
export function tcflushInput(fd: number): number {
  return libc().symbols.tcflush!(fd, LAYOUT.TCIFLUSH) === 0 ? 0 : errno() || ENOTTY;
}

/** isatty(3). */
export function isatty(fd: number): boolean {
  return libc().symbols.isatty!(fd) === 1;
}

// ---------------------------------------------------------------------------
// poll, window size, device

/**
 * poll(2) on one descriptor for input: the revents bits (0 on timeout), or -errno.
 * EINTR (a signal arrived) is returned as -EINTR, so the caller can look at its signals.
 */
export function pollIn(fd: number, timeoutMs: number): number {
  if (IS_DARWIN) return selectIn(fd, timeoutMs);
  const pfd = new Uint8Array(8);
  const dv = new DataView(pfd.buffer);
  dv.setInt32(0, fd, true);
  dv.setInt16(4, POLLIN, true);
  const n = libc().symbols.poll!(pfd, IS_DARWIN ? 1 : 1n, Math.max(0, Math.floor(timeoutMs))) as number;
  if (n < 0) return -(errno() || EINTR);
  if (n === 0) return 0;
  return dv.getUint16(6, true);
}

/**
 * macOS: poll(2) doesn't work on /dev/tty (POLLNVAL), select(2) does. fd_set is 1024 bits
 * (32 int32 words); struct timeval is {long tv_sec; int tv_usec} (16 bytes). Untested.
 */
function selectIn(fd: number, timeoutMs: number): number {
  if (fd >= 1024) return -EBADF;
  const set = new Int32Array(32);
  set[fd >> 5] = 1 << (fd & 31);
  const tv = new Uint8Array(16);
  const dv = new DataView(tv.buffer);
  const ms = Math.max(0, Math.floor(timeoutMs));
  dv.setBigInt64(0, BigInt(Math.floor(ms / 1000)), true);
  dv.setInt32(8, (ms % 1000) * 1000, true);
  const n = libc().symbols.select!(fd + 1, set, null, null, tv) as number;
  if (n < 0) return -(errno() || EINTR);
  if (n === 0) return 0;
  return (set[fd >> 5]! & (1 << (fd & 31))) !== 0 ? POLLIN : 0;
}

export interface WindowSize {
  cols: number;
  rows: number;
}

/** The terminal's size (TIOCGWINSZ), or null if it can't be read or is 0×0. */
export function windowSize(fd: number): WindowSize | null {
  const ws = new Uint8Array(8);
  if (ioctl(fd, LAYOUT.TIOCGWINSZ, ws) !== 0) return null;
  const dv = new DataView(ws.buffer);
  const rows = dv.getUint16(0, true);
  const cols = dv.getUint16(2, true);
  if (rows === 0 && cols === 0) return null;
  return { cols, rows };
}

/**
 * The device number of the terminal behind fd (Linux TIOCGDEV: for /dev/tty, the real
 * terminal, e.g. /dev/pts/3), as {major, minor}; null where unsupported or failing.
 */
export function ttyDeviceNumber(fd: number): { major: number; minor: number } | null {
  if (!LAYOUT.TIOCGDEV) return null;
  const buf = new Uint8Array(8);
  if (ioctl(fd, LAYOUT.TIOCGDEV, buf) !== 0) return null;
  const dev = new DataView(buf.buffer).getUint32(0, true);
  // The kernel's new_encode_dev: minor low 8 bits, major 12 bits, minor high bits above.
  return { major: (dev & 0xfff00) >>> 8, minor: (dev & 0xff) | ((dev >>> 12) & 0xfff00) };
}

/** Splits a stat rdev (glibc's 64-bit dev_t encoding on Linux, macOS's 32-bit one) into major/minor. */
export function splitDev(rdev: number | bigint): { major: number; minor: number } {
  const d = BigInt(rdev);
  if (IS_DARWIN) return { major: Number((d >> 24n) & 0xffn), minor: Number(d & 0xffffffn) };
  const major = Number(((d >> 8n) & 0xfffn) | ((d >> 32n) & ~0xfffn));
  const minor = Number((d & 0xffn) | ((d >> 12n) & ~0xffn & 0xffffffffn));
  return { major, minor };
}
