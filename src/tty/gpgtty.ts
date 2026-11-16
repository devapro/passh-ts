// GPG_TTY for `import pass` (agent-session.md §A4 last bullet, import-export.md §1.5):
// if $GPG_TTY is set and not empty, gpg inherits it unchanged (even a wrong value).
// Otherwise passh adds GPG_TTY=<device>: the device of /dev/tty, found as the
// /proc/self/fd/<n> link target when that names a device other than /dev/tty, else by
// the device number (TIOCGDEV on Linux) looked up among the character devices in
// /dev/pts, then /dev (never /dev/tty itself); without /dev/tty, or when its device isn't
// found, the device of the first of stdin, stderr, stdout that is a terminal (found the
// same way); with none, nothing is added.
//
// macOS (untested): there is no /proc and no TIOCGDEV; the process table's e_tdev isn't
// read (best effort), so /dev/tty's device is found only through the standard
// descriptors' device numbers (fstat st_rdev) looked up in /dev.

import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync } from "node:fs";
import { IS_LINUX, isatty, splitDev, ttyDeviceNumber } from "../ffi/termios.ts";

type Dev = { major: number; minor: number };

function linkTarget(fd: number): string | null {
  if (!IS_LINUX) return null;
  try {
    const t = readlinkSync(`/proc/self/fd/${fd}`);
    if (!t.startsWith("/dev/") || t === "/dev/tty") return null;
    if (!lstatSync(t).isCharacterDevice()) return null;
    return t;
  } catch {
    return null;
  }
}

function findDevice(dev: Dev): string | null {
  for (const dir of ["/dev/pts", "/dev"]) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    names.sort();
    for (const n of names) {
      const p = `${dir}/${n}`;
      if (p === "/dev/tty") continue;
      try {
        const st = lstatSync(p);
        if (!st.isCharacterDevice()) continue;
        const d = splitDev(st.rdev);
        if (d.major === dev.major && d.minor === dev.minor) return p;
      } catch {
        /* vanished or unreadable */
      }
    }
  }
  return null;
}

/** The device of a terminal descriptor (not /dev/tty), or null. */
function deviceOf(fd: number): string | null {
  const link = linkTarget(fd);
  if (link) return link;
  const viaIoctl = ttyDeviceNumber(fd);
  if (viaIoctl) {
    const p = findDevice(viaIoctl);
    if (p) return p;
  }
  try {
    const st = fstatSync(fd);
    const d = splitDev(st.rdev);
    const p = findDevice(d);
    if (p) return p;
  } catch {
    /* not a file */
  }
  return null;
}

/** The terminal device for GPG_TTY (e.g. /dev/pts/3), or null when there is none. */
export function terminalDevice(): string | null {
  let fd = -1;
  try {
    fd = openSync("/dev/tty", constants.O_RDONLY | (constants.O_NOCTTY ?? 0));
  } catch {
    fd = -1;
  }
  if (fd >= 0) {
    try {
      if (isatty(fd)) {
        const p = deviceOf(fd);
        if (p) return p;
      }
    } finally {
      try {
        closeSync(fd);
      } catch {}
    }
  }
  for (const std of [0, 2, 1]) {
    if (!isatty(std)) continue;
    const p = deviceOf(std);
    if (p) return p;
  }
  return null;
}

/** The environment additions for gpg: {} when $GPG_TTY is set and not empty, else {GPG_TTY: device} or {}. */
export function gpgTtyEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const cur = env.GPG_TTY;
  if (cur !== undefined && cur !== "") return {};
  const dev = terminalDevice();
  return dev ? { GPG_TTY: dev } : {};
}
