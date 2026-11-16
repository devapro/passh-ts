// The terminal: /dev/tty opened read-write (agent-session.md §A4). All prompts read and
// write it, never stdin/stdout. No /dev/tty, or not a terminal → "no terminal" (null).

import { closeSync, openSync, writeSync } from "node:fs";
import { escapeMultiline } from "../sanitize/index.ts";
import { errorf } from "../i18n/index.ts";
import { errnoError } from "../fsx/oserror.ts";
import { isatty, makeRaw, tcflushInput, tcgetattr, tcsetattr, windowSize, type Termios, type WindowSize, type When } from "../ffi/termios.ts";
import { TtyReader } from "./source.ts";

const encoder = new TextEncoder();

export class Tty {
  /** The descriptor of /dev/tty (read-write). */
  readonly fd: number;
  /** A raw-mode prompt is running: line breaks are written as `\r\n`. */
  raw = false;
  private lastByte = 0x0a;
  private saved: Termios | null = null;
  private closed = false;

  constructor(fd: number) {
    this.fd = fd;
  }

  /** Opens /dev/tty read-write; null when there is none or it isn't a terminal ("no terminal"). */
  static open(path = "/dev/tty"): Tty | null {
    let fd: number;
    try {
      fd = openSync(path, "r+");
    } catch {
      return null;
    }
    if (!isatty(fd)) {
      try {
        closeSync(fd);
      } catch {}
      return null;
    }
    return new Tty(fd);
  }

  /** Writes bytes as they are, in one write(2) where the terminal takes them at once (OSC 52, echo). */
  writeRaw(data: string | Uint8Array): void {
    const b = typeof data === "string" ? encoder.encode(data) : data;
    if (b.length === 0) return;
    let off = 0;
    while (off < b.length) {
      try {
        off += writeSync(this.fd, b, off, b.length - off);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "EAGAIN" || code === "EINTR") continue;
        throw e;
      }
    }
    this.lastByte = b[b.length - 1]!;
  }

  /** Writes text for people: escaped (S4, multi-line form), `\n` as `\r\n` in raw mode. No final newline. */
  print(text: string): void {
    let s = escapeMultiline(text);
    if (this.raw) s = s.replace(/\n/g, "\r\n");
    this.writeRaw(s);
  }

  /** Writes a message line: print(text) and a line break. */
  say(text: string): void {
    this.print(text + "\n");
  }

  /** Reports whether the cursor is at the start of a line (the last byte written was a line break). */
  get atLineStart(): boolean {
    return this.lastByte === 0x0a;
  }

  /** Writes a line break unless the cursor is at the start of a line (after a prompt). */
  endLine(): void {
    if (!this.atLineStart) this.writeRaw(this.raw ? "\r\n" : "\n");
  }

  /** Marks the cursor as being at the start of a line (e.g. after the TUI left the screen). */
  markLineStart(): void {
    this.lastByte = 0x0a;
  }

  /** The terminal state (tcgetattr). Throws on failure. */
  getAttr(): Termios {
    const t = tcgetattr(this.fd);
    if (typeof t === "number") throw errorf("reading the terminal state: %w", errnoError(t));
    return t;
  }

  /** Sets the terminal state (tcsetattr). Throws on failure. */
  setAttr(t: Termios, when: When = "now"): void {
    const e = tcsetattr(this.fd, t, when);
    if (e !== 0) throw errorf("setting the terminal state: %w", errnoError(e));
  }

  /** Enters raw mode (cfmakeraw), saving the state first if not saved yet (TUI). */
  enterRawMode(): void {
    const cur = this.getAttr();
    if (!this.saved) this.saved = cur;
    this.setAttr(makeRaw(cur));
  }

  /** Restores the state saved by enterRawMode (no-op if none). */
  restoreMode(): void {
    if (!this.saved) return;
    const s = this.saved;
    this.saved = null;
    tcsetattr(this.fd, s);
  }

  /** Discards input received but not read (TCIFLUSH). */
  flushInput(): void {
    tcflushInput(this.fd);
  }

  /** The window size, or null if unknown. */
  windowSize(): WindowSize | null {
    return windowSize(this.fd);
  }

  /** Calls cb on SIGWINCH (with the new size); returns the unsubscribe function. */
  onResize(cb: (size: WindowSize | null) => void): () => void {
    const h = () => cb(this.windowSize());
    process.on("SIGWINCH", h);
    return () => process.off("SIGWINCH", h);
  }

  /** An async reader of the bytes available (TUI, dialogs). */
  reader(): TtyReader {
    return new TtyReader(this.fd);
  }

  /** Restores a saved raw-mode state and closes the descriptor. */
  close(): void {
    if (this.closed) return;
    this.restoreMode();
    this.closed = true;
    try {
      closeSync(this.fd);
    } catch {}
  }
}

/** Opens /dev/tty: a Tty, or null for "no terminal" (agent-session.md §A4). */
export function openTty(): Tty | null {
  return Tty.open();
}
