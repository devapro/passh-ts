import { describe, expect, test } from "bun:test";
import { InputDecoder, type InputMsg } from "./keys.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const names = (ms: InputMsg[]) => ms.map((m) => (m.type === "key" ? m.key : "paste:" + new TextDecoder().decode(m.bytes)));

function decode(...chunks: string[]): InputMsg[] {
  const d = new InputDecoder();
  const out: InputMsg[] = [];
  for (const c of chunks) out.push(...d.feed(enc(c)));
  out.push(...d.flush());
  return out;
}

describe("legacy keys", () => {
  test("control bytes", () => {
    expect(names(decode("\r\t\x7f\x08\x03\x04\x0a\x00"))).toEqual(["enter", "tab", "backspace", "ctrl+h", "ctrl+c", "ctrl+d", "ctrl+j", "ctrl+space"]);
  });
  test("printable text, with text set", () => {
    const ms = decode("aL? й👩");
    expect(names(ms)).toEqual(["a", "L", "?", "space", "й", "👩"]);
    expect(ms.map((m) => (m.type === "key" ? m.text : ""))).toEqual(["a", "L", "?", " ", "й", "👩"]);
  });
  test("cursor and editing keys", () => {
    expect(names(decode("\x1b[A\x1b[B\x1b[C\x1b[D\x1b[H\x1b[F\x1b[5~\x1b[6~\x1b[3~\x1b[2~\x1b[1~\x1b[4~\x1bOA\x1bOH"))).toEqual([
      "up",
      "down",
      "right",
      "left",
      "home",
      "end",
      "pgup",
      "pgdown",
      "delete",
      "insert",
      "home",
      "end",
      "up",
      "home",
    ]);
  });
  test("xterm modifiers", () => {
    expect(names(decode("\x1b[1;5D\x1b[1;3C\x1b[3;5~\x1b[3;3~\x1b[1;2A\x1b[Z"))).toEqual(["ctrl+left", "alt+right", "ctrl+delete", "alt+delete", "shift+up", "shift+tab"]);
  });
  test("Alt as an ESC prefix", () => {
    const ms = decode("\x1bb\x1bf\x1bd\x1b\x7f\x1b\r");
    expect(names(ms)).toEqual(["alt+b", "alt+f", "alt+d", "alt+backspace", "alt+enter"]);
    expect(ms.every((m) => m.type === "key" && m.text === "")).toBe(true);
  });
  test("a lone ESC waits, then is Esc", () => {
    const d = new InputDecoder();
    expect(d.feed(enc("\x1b"))).toEqual([]);
    expect(d.pending()).toBe(true);
    expect(names(d.flush())).toEqual(["esc"]);
  });
  test("a sequence split over reads", () => {
    expect(names(decode("\x1b", "[", "A"))).toEqual(["up"]);
  });
  test("a UTF-8 character split over reads", () => {
    const d = new InputDecoder();
    const b = enc("й");
    expect(d.feed(b.subarray(0, 1))).toEqual([]);
    expect(names(d.feed(b.subarray(1)))).toEqual(["й"]);
  });
  test("bytes that aren't UTF-8 are dropped", () => {
    const d = new InputDecoder();
    expect(names(d.feed(new Uint8Array([0xff, 0x61, 0xc3, 0x28])))).toEqual(["a", "("]);
  });
});

describe("extended keyboard protocols", () => {
  test("kitty CSI u", () => {
    expect(names(decode("\x1b[27u\x1b[99;5u\x1b[127;5u\x1b[13;3u\x1b[9;2u\x1b[98;3u\x1b[115;5u"))).toEqual([
      "esc",
      "ctrl+c",
      "ctrl+backspace",
      "alt+enter",
      "shift+tab",
      "alt+b",
      "ctrl+s",
    ]);
  });
  test("modifyOtherKeys", () => {
    expect(names(decode("\x1b[27;5;99~\x1b[27;3;98~\x1b[27;5;127~\x1b[27;2;65~"))).toEqual(["ctrl+c", "alt+b", "ctrl+backspace", "A"]);
  });
  test("terminal replies are ignored", () => {
    expect(names(decode("\x1b[?1u\x1b[?2026;2$y"))).toEqual([]);
  });
});

describe("bracketed paste", () => {
  test("one event with the exact bytes", () => {
    const ms = decode("\x1b[200~a\r\nb\x1b[A\x1b[201~x");
    expect(ms.length).toBe(2);
    expect(ms[0]!.type).toBe("paste");
    expect(new TextDecoder().decode((ms[0] as { bytes: Uint8Array }).bytes)).toBe("a\r\nb\x1b[A");
    expect(names([ms[1]!])).toEqual(["x"]);
  });
  test("split across reads, end marker split too", () => {
    const ms = decode("\x1b[200~hel", "lo\x1b[2", "01~");
    expect(names(ms)).toEqual(["paste:hello"]);
  });
  test("invalid UTF-8 is kept for the receiver to refuse", () => {
    const d = new InputDecoder();
    const ms = d.feed(new Uint8Array([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e, 0xff, 0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]));
    expect(ms[0]!.type).toBe("paste");
    expect([...(ms[0] as { bytes: Uint8Array }).bytes]).toEqual([0xff]);
  });
});
