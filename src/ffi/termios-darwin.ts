// macOS <termios.h> and <sys/ioctl.h> values (from the public headers; untested on a Mac).
// tcflag_t and speed_t are `unsigned long` (8 bytes on 64-bit), NCCS = 20.
//
//   struct termios {            offset
//     tcflag_t c_iflag;          0
//     tcflag_t c_oflag;          8
//     tcflag_t c_cflag;         16
//     tcflag_t c_lflag;         24
//     cc_t     c_cc[NCCS];      32
//     speed_t  c_ispeed;        56   (aligned)
//     speed_t  c_ospeed;        64
//   };                          size 72

import type { TermiosLayout } from "./termios.ts";

export const DARWIN_LAYOUT: TermiosLayout = {
  size: 72,
  flagSize: 8,
  iflag: 0,
  oflag: 8,
  cflag: 16,
  lflag: 24,
  cc: 32,
  nccs: 20,
  VMIN: 16,
  VTIME: 17,
  VINTR: 8,
  VEOF: 0,
  IGNBRK: 0x1,
  BRKINT: 0x2,
  PARMRK: 0x8,
  ISTRIP: 0x20,
  INLCR: 0x40,
  IGNCR: 0x80,
  ICRNL: 0x100,
  IXON: 0x200,
  OPOST: 0x1,
  ONLCR: 0x2,
  ECHO: 0x8,
  ECHONL: 0x10,
  ICANON: 0x100,
  ISIG: 0x80,
  IEXTEN: 0x400,
  CSIZE: 0x300,
  PARENB: 0x1000,
  CS8: 0x300,
  TCSANOW: 0,
  TCSADRAIN: 1,
  TCSAFLUSH: 2,
  // tcflush(TCIFLUSH) is ioctl(TIOCFLUSH, FREAD) in macOS's libc (agent-session.md §A4).
  TCIFLUSH: 1,
  // _IOR('t', 104, struct winsize)
  TIOCGWINSZ: 0x40087468,
  // macOS has no TIOCGDEV; GPG_TTY uses the standard descriptors' device numbers instead.
  TIOCGDEV: 0,
};
