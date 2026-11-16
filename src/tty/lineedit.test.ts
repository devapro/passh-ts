import { describe, expect, test } from "bun:test";
import { hasCode } from "../i18n/index.ts";
import { inputTooLong, lastCharLength, masksOf, newEditState, passphraseTooLong, readEditedLine, type EditOptions } from "./lineedit.ts";
import { ArrayByteSource } from "./source.ts";
import { goTrimSpace, constantTimeEqual } from "./prompts.ts";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const opts = (limit = 4096): EditOptions => ({ limit, tooLong: passphraseTooLong });

async function line(input: string | Array<string | null>, o: EditOptions = opts()): Promise<string | "EOF"> {
  const src = typeof input === "string" ? ArrayByteSource.of(input) : ArrayByteSource.of(...input);
  const r = await readEditedLine(src, newEditState(), o);
  return r.kind === "eof" ? "EOF" : dec(r.bytes);
}

describe("line editor (agent-session.md §A4)", () => {
  test("CR or LF ends the line", async () => {
    expect(await line("abc\rdef")).toBe("abc");
    expect(await line("abc\ndef")).toBe("abc");
    expect(await line("\r")).toBe("");
  });

  test("an LF right after a CR that ended the previous line of the same read is skipped", async () => {
    const src = ArrayByteSource.of("a\r\nb\r\n\n");
    const st = newEditState();
    const read = async () => {
      const r = await readEditedLine(src, st, opts());
      return r.kind === "eof" ? "EOF" : dec(r.bytes);
    };
    expect(await read()).toBe("a");
    expect(await read()).toBe("b");
    expect(await read()).toBe(""); // the second LF is a line of its own
  });

  test("a fresh state doesn't skip an LF (separate prompts, as the reference)", async () => {
    const src = ArrayByteSource.of("a\r\nb\r");
    expect(dec(((await readEditedLine(src, newEditState(), opts())) as { bytes: Uint8Array }).bytes)).toBe("a");
    expect(dec(((await readEditedLine(src, newEditState(), opts())) as { bytes: Uint8Array }).bytes)).toBe("");
  });

  test("Ctrl-C interrupts", async () => {
    const err = await line("ab\x03cd\r").catch((e) => e);
    expect(err.message).toBe("interrupted");
    expect(hasCode(err, "interrupted")).toBe(true);
  });

  test("Ctrl-D ends input only on an empty line", async () => {
    expect(await line("\x04")).toBe("EOF");
    expect(await line("ab\x04c\r")).toBe("abc");
    expect(await line("ab\x15\x04")).toBe("EOF");
  });

  test("end of the source", async () => {
    expect(await line("")).toBe("EOF");
    expect(await line("ab")).toBe("ab");
  });

  test("DEL and BS delete the last UTF-8 character", async () => {
    expect(await line("ab\x7f\r")).toBe("a");
    expect(await line("aé\x7f\r")).toBe("a");
    expect(await line("a€\x08\r")).toBe("a");
    expect(await line("a😀\x7f\r")).toBe("a");
    expect(await line("\x7f\x7fa\r")).toBe("a");
    // an invalid trailing byte goes alone
    const src = ArrayByteSource.of(new Uint8Array([0x61, 0xc3, 0xa9, 0xa9, 0x7f, 0x0d]));
    const r = await readEditedLine(src, newEditState(), opts());
    expect(Array.from((r as { bytes: Uint8Array }).bytes)).toEqual([0x61, 0xc3, 0xa9]);
  });

  test("Ctrl-U clears, Ctrl-W deletes trailing spaces and the last word", async () => {
    expect(await line("abc\x15d\r")).toBe("d");
    expect(await line("ab cd\x17\r")).toBe("ab ");
    expect(await line("ab cd  \x17\r")).toBe("ab ");
    expect(await line("ab cd\x17\x17\r")).toBe("");
    expect(await line("x é€\x17\r")).toBe("x ");
  });

  test("escape sequences are swallowed; ESC + other drops the ESC", async () => {
    expect(await line("a\x1b[Ab\x1b[1;5Cc\x1bOPd\r")).toBe("abcd");
    expect(await line("a\x1bxb\r")).toBe("axb");
    expect(await line("a\x1b\r")).toBe("a");
    expect(await line("a\x1b[1\rb")).toBe("a"); // a CSI cut by CR: CR still ends the line
  });

  test("other control bytes are ignored", async () => {
    expect(await line("a\tb\x01\x02\x05\x00c\r")).toBe("abc");
  });

  test("limit", async () => {
    expect(await line("a".repeat(4096) + "\r")).toBe("a".repeat(4096));
    const err = await line("a".repeat(4097) + "\r").catch((e) => e);
    expect(err.message).toBe("passphrase longer than 4096 bytes");
    const err2 = await line("abcd", { limit: 3, tooLong: inputTooLong }).catch((e) => e);
    expect(err2.message).toBe("input longer than 3 bytes");
  });

  test("masked echo", async () => {
    let out = "";
    const o: EditOptions = { limit: 100, tooLong: inputTooLong, mask: { promptLine: "> ", echo: (s) => (out += s) } };
    expect(await line("ab cd\x7f\x17xy\r", o)).toBe("ab xy");
    expect(out).toBe("** **\b \b\r> ** \x1b[K**");
    out = "";
    expect(await line("é€\x15q\r", o)).toBe("q");
    expect(out).toBe("**\r> \x1b[K*");
  });

  test("helpers", () => {
    expect(lastCharLength([])).toBe(0);
    expect(lastCharLength([0x61])).toBe(1);
    expect(lastCharLength([0xc3, 0xa9])).toBe(2);
    expect(lastCharLength([0xe2, 0x82, 0xac])).toBe(3);
    expect(lastCharLength([0xf0, 0x9f, 0x98, 0x80])).toBe(4);
    expect(lastCharLength([0x61, 0xc3])).toBe(1);
    expect(lastCharLength([0xc0, 0x80])).toBe(1); // overlong
    expect(masksOf([0x61, 0x20, 0xc3, 0xa9])).toBe("* *");
    expect(goTrimSpace(" \t\u0085a b \n")).toBe("a b");
    expect(goTrimSpace("﻿a")).toBe("﻿a");
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(false);
  });
});
