// Errors of the operating system, written like Go's (storage.md §0: "OS errors quoted
// inside a message carry the path the OS call got", cli.md notation `<op> <abs>: <reason>`):
//
//   Errno     a bare errno, text "permission denied"            (Go's syscall.Errno)
//   OSError   "<op> <path>: <reason>"                           (Go's *fs.PathError)
//             "<op> <path> <path2>: <reason>" for rename/link    (Go's *os.LinkError)
//
// The texts are Go's (Linux table, macOS where it differs); they are never translated
// (i18n.md §3). `.code` is the errno name ("ENOENT") for matching with isErrno.

import { ERRNO, errnoName, IS_DARWIN } from "../ffi/libc.ts";

const LINUX_TEXT: Record<string, string> = {
  EPERM: "operation not permitted",
  ENOENT: "no such file or directory",
  ESRCH: "no such process",
  EINTR: "interrupted system call",
  EIO: "input/output error",
  ENXIO: "no such device or address",
  E2BIG: "argument list too long",
  ENOEXEC: "exec format error",
  EBADF: "bad file descriptor",
  ECHILD: "no child processes",
  EAGAIN: "resource temporarily unavailable",
  EWOULDBLOCK: "resource temporarily unavailable",
  ENOMEM: "cannot allocate memory",
  EACCES: "permission denied",
  EFAULT: "bad address",
  ENOTBLK: "block device required",
  EBUSY: "device or resource busy",
  EEXIST: "file exists",
  EXDEV: "invalid cross-device link",
  ENODEV: "no such device",
  ENOTDIR: "not a directory",
  EISDIR: "is a directory",
  EINVAL: "invalid argument",
  ENFILE: "too many open files in system",
  EMFILE: "too many open files",
  ENOTTY: "inappropriate ioctl for device",
  ETXTBSY: "text file busy",
  EFBIG: "file too large",
  ENOSPC: "no space left on device",
  ESPIPE: "illegal seek",
  EROFS: "read-only file system",
  EMLINK: "too many links",
  EPIPE: "broken pipe",
  EDOM: "numerical argument out of domain",
  ERANGE: "numerical result out of range",
  EDEADLK: "resource deadlock avoided",
  ENAMETOOLONG: "file name too long",
  ENOLCK: "no locks available",
  ENOSYS: "function not implemented",
  ENOTEMPTY: "directory not empty",
  ELOOP: "too many levels of symbolic links",
  ENOTSOCK: "socket operation on non-socket",
  EOPNOTSUPP: "operation not supported",
  ENOTSUP: "operation not supported",
  EAFNOSUPPORT: "address family not supported by protocol",
  EADDRINUSE: "address already in use",
  EADDRNOTAVAIL: "cannot assign requested address",
  ENETDOWN: "network is down",
  ENETUNREACH: "network is unreachable",
  ECONNABORTED: "software caused connection abort",
  ECONNRESET: "connection reset by peer",
  ENOBUFS: "no buffer space available",
  EISCONN: "transport endpoint is already connected",
  ENOTCONN: "transport endpoint is not connected",
  ETIMEDOUT: "connection timed out",
  ECONNREFUSED: "connection refused",
  EHOSTUNREACH: "no route to host",
  EALREADY: "operation already in progress",
  EINPROGRESS: "operation now in progress",
  ESTALE: "stale NFS file handle",
  EDQUOT: "disk quota exceeded",
};

const DARWIN_TEXT: Record<string, string> = {
  EBUSY: "resource busy",
  EXDEV: "cross-device link",
  ERANGE: "result too large",
  EOPNOTSUPP: "operation not supported on socket",
  ENOTCONN: "socket is not connected",
  EISCONN: "socket is already connected",
  ETIMEDOUT: "operation timed out",
  EDQUOT: "disc quota exceeded",
  EAFNOSUPPORT: "address family not supported by protocol family",
  EADDRNOTAVAIL: "can't assign requested address",
};

/** Go's text for an errno name ("ENOENT" → "no such file or directory"). */
export function errnoText(code: string): string {
  if (IS_DARWIN && DARWIN_TEXT[code]) return DARWIN_TEXT[code]!;
  return LINUX_TEXT[code] ?? code;
}

/** A bare errno (Go's syscall.Errno): its text is the reason alone. */
export class Errno extends Error {
  readonly code: string;
  readonly errno: number;
  constructor(code: string, errno?: number) {
    super(errnoText(code));
    this.name = "Errno";
    this.code = code;
    this.errno = errno ?? ERRNO[code] ?? 0;
  }
}

/** An Errno from a platform errno number (as returned by src/ffi/libc.ts). */
export function errnoError(n: number): Errno {
  return new Errno(errnoName(n), n);
}

/**
 * An OS error on a path: `<op> <path>: <reason>` (Go's PathError), or with a second
 * path `<op> <path> <path2>: <reason>` (Go's LinkError: rename, link). The cause is the
 * Errno (or the original error when it carries no errno).
 */
export class OSError extends Error {
  readonly op: string;
  readonly path: string;
  readonly path2: string | undefined;
  /** The errno name ("ENOENT"), or "" when the cause isn't an errno. */
  readonly code: string;
  constructor(op: string, path: string, cause: Error, path2?: string) {
    super(`${op} ${path}${path2 !== undefined ? " " + path2 : ""}: ${cause.message}`, { cause });
    this.name = "OSError";
    this.op = op;
    this.path = path;
    this.path2 = path2;
    this.code = cause instanceof Errno ? cause.code : "";
  }
}

/** The errno name of a Node/Bun error ("ENOENT"), of an Errno or OSError, or undefined. */
export function errnoCode(e: unknown): string | undefined {
  for (let cur: unknown = e, depth = 0; cur && depth < 20; depth++) {
    if (cur instanceof Errno) return cur.code;
    if (cur instanceof OSError) return cur.code || undefined;
    if (typeof cur === "object" && cur !== null) {
      const c = (cur as { code?: unknown }).code;
      if (typeof c === "string" && /^E[A-Z0-9]+$/.test(c)) return c;
    }
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return undefined;
}

/** Reports whether e (or an error it wraps) is one of the errnos, by name ("ENOENT"). */
export function isErrno(e: unknown, ...codes: string[]): boolean {
  const c = errnoCode(e);
  if (c === undefined) return false;
  if (codes.includes(c)) return true;
  // Aliases: EWOULDBLOCK = EAGAIN; on Linux ENOTSUP = EOPNOTSUPP.
  const n = ERRNO[c];
  return n !== undefined && codes.some((x) => ERRNO[x] === n);
}

/** Turns any error from node:fs (or an errno number or name) into an Errno, keeping other errors. */
export function toErrno(err: unknown): Error {
  if (err instanceof Errno) return err;
  if (typeof err === "number") return errnoError(err);
  if (typeof err === "string" && /^E[A-Z0-9]+$/.test(err)) return new Errno(err);
  const c = errnoCode(err);
  if (c !== undefined) return new Errno(c);
  return err instanceof Error ? err : new Error(String(err));
}

/** An OSError for a failed call on a path: osError("open", "/x", e) → `open /x: permission denied`. */
export function osError(op: string, path: string, err: unknown, path2?: string): OSError {
  if (err instanceof OSError) err = err.cause;
  return new OSError(op, path, toErrno(err), path2);
}

/** The text of osError: `stat /x: no such file or directory`. */
export function osErrorText(op: string, path: string, err: unknown): string {
  return osError(op, path, err).message;
}
