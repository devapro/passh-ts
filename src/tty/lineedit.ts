// The line editor of raw-mode prompts (agent-session.md §A4), byte by byte:
//
//   CR or LF        ends the line; an LF right after a CR that ended the previous line of
//                   the same read is skipped (CRLF pastes into the masked multi-line input)
//   0x03 Ctrl-C     "interrupted"
//   0x04 Ctrl-D     end of input on an empty line; ignored otherwise
//   0x7F / 0x08     delete the last UTF-8 character
//   0x15 Ctrl-U     clear the line
//   0x17 Ctrl-W     delete trailing spaces, then the last word
//   ESC [ (0x20–0x3F)* (0x40–0x7E), ESC O (0x40–0x7E)   swallowed (arrow and function keys)
//   ESC + anything else                                 the ESC is dropped
//   other < 0x20    ignored
//   over the limit  error (`passphrase longer than 4096 bytes`, `input longer than …`)
//
// Echo, for masked input only: `*` per character (a space as a space), `\b \b` per
// deleted character, and after Ctrl-U/W a redraw: `\r` + the prompt's last line + masks
// + `ESC [K`. Passphrases echo nothing.

import { codedError, errorf, type PasshError } from "../i18n/index.ts";
import type { ByteSource } from "./source.ts";

export const CTRL_C = 0x03;
export const CTRL_D = 0x04;
export const BS = 0x08;
export const LF = 0x0a;
export const CR = 0x0d;
export const CTRL_U = 0x15;
export const CTRL_W = 0x17;
export const ESC = 0x1b;
export const DEL = 0x7f;

/** Ctrl-C typed at a raw prompt: a key, not a signal (exit 1, cli.md §1.4). */
export function interruptedError(): PasshError {
  return codedError("interrupted", "interrupted");
}

/** End of input (Ctrl-D on an empty line): Go's bare `EOF` (spec audit #41: reproduced). */
export function eofError(): PasshError {
  return codedError("eof", "EOF");
}

/** State kept across the lines of one read (the CRLF rule). */
export interface EditState {
  /** The previous line ended with CR: an LF next is skipped. */
  skipLF: boolean;
}

export function newEditState(): EditState {
  return { skipLF: false };
}

export interface EditOptions {
  /** Maximum bytes of the line; one more fails with tooLong(limit). */
  limit: number;
  tooLong: (limit: number) => Error;
  /** Masked echo; absent: no echo. */
  mask?: { promptLine: string; echo: (s: string) => void };
}

export type EditResult = { kind: "line"; bytes: Uint8Array } | { kind: "eof" };

/** The error for a passphrase over the limit. */
export function passphraseTooLong(limit: number): PasshError {
  return errorf("passphrase longer than %d bytes", limit);
}

/** The error for masked or plain input over the limit. */
export function inputTooLong(limit: number): PasshError {
  return errorf("input longer than %d bytes", limit);
}

/** Byte length of the last UTF-8 character of buf (1 for an invalid trailing byte), as Go's DecodeLastRune. */
export function lastCharLength(buf: number[]): number {
  const n = buf.length;
  if (n === 0) return 0;
  // Look back at most 4 bytes for a lead byte whose sequence ends exactly at the end.
  for (let size = 1; size <= Math.min(4, n); size++) {
    const lead = buf[n - size]!;
    if (size === 1) {
      if (lead < 0x80) return 1;
      continue;
    }
    if ((lead & 0xc0) === 0x80) continue;
    const need = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 0;
    if (need !== size) return 1;
    // Validate the sequence (no overlong, no surrogate, ≤ U+10FFFF).
    let cp = lead & (size === 2 ? 0x1f : size === 3 ? 0x0f : 0x07);
    for (let k = 1; k < size; k++) {
      const b = buf[n - size + k]!;
      if ((b & 0xc0) !== 0x80) return 1;
      cp = (cp << 6) | (b & 0x3f);
    }
    const min = size === 2 ? 0x80 : size === 3 ? 0x800 : 0x10000;
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return 1;
    return size;
  }
  return 1;
}

/** The masks of a line: `*` per character, a space as a space. */
export function masksOf(buf: number[]): string {
  let s = "";
  for (const b of buf) {
    if (b === 0x20) s += " ";
    else if ((b & 0xc0) !== 0x80) s += "*";
  }
  return s;
}

/**
 * Reads one line through the editor. Returns the line (without its end) or end of input;
 * throws interruptedError() for Ctrl-C, opts.tooLong(limit) over the limit, and whatever
 * the source throws (SignalInterrupt).
 */
export async function readEditedLine(src: ByteSource, st: EditState, opts: EditOptions): Promise<EditResult> {
  const buf: number[] = [];
  const echo = opts.mask?.echo;
  const redraw = () => {
    if (opts.mask) opts.mask.echo("\r" + opts.mask.promptLine + masksOf(buf) + "\x1b[K");
  };
  let esc: 0 | 1 | 2 | 3 = 0; // 0 none, 1 after ESC, 2 in ESC [, 3 after ESC O
  for (;;) {
    const b = await src.readByte();
    if (b === null) {
      // The terminal reported end of input (not possible in raw mode, but a pipe or a
      // hung-up terminal can): treat as Ctrl-D on an empty line, else end the line.
      if (buf.length === 0) return { kind: "eof" };
      return { kind: "line", bytes: Uint8Array.from(buf) };
    }
    const skip = st.skipLF;
    st.skipLF = false;
    if (esc === 1) {
      if (b === 0x5b) {
        esc = 2;
        continue;
      }
      if (b === 0x4f) {
        esc = 3;
        continue;
      }
      esc = 0; // the ESC is dropped; b is handled below
    } else if (esc === 2) {
      if (b >= 0x20 && b <= 0x3f) continue;
      esc = 0;
      if (b >= 0x40 && b <= 0x7e) continue;
      // not a CSI byte: the sequence ends; b is handled below
    } else if (esc === 3) {
      esc = 0;
      if (b >= 0x40 && b <= 0x7e) continue;
    }
    switch (b) {
      case CR:
        st.skipLF = true;
        return { kind: "line", bytes: Uint8Array.from(buf) };
      case LF:
        if (skip) continue;
        return { kind: "line", bytes: Uint8Array.from(buf) };
      case CTRL_C:
        throw interruptedError();
      case CTRL_D:
        if (buf.length === 0) return { kind: "eof" };
        continue;
      case DEL:
      case BS: {
        const n = lastCharLength(buf);
        if (n === 0) continue;
        buf.length -= n;
        echo?.("\b \b");
        continue;
      }
      case CTRL_U:
        buf.length = 0;
        redraw();
        continue;
      case CTRL_W:
        while (buf.length > 0 && buf[buf.length - 1] === 0x20) buf.pop();
        while (buf.length > 0 && buf[buf.length - 1] !== 0x20) buf.pop();
        redraw();
        continue;
      case ESC:
        esc = 1;
        continue;
    }
    if (b < 0x20) continue;
    if (buf.length + 1 > opts.limit) throw opts.tooLong(opts.limit);
    buf.push(b);
    if (echo) {
      if (b === 0x20) echo(" ");
      else if ((b & 0xc0) !== 0x80) echo("*");
    }
  }
}
