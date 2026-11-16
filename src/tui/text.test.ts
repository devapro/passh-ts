import { describe, expect, test } from "bun:test";
import { countdown, escapeUnits, filterFrame, renderLine, S, truncate, truncLine, wrap, wrapItems, lineText } from "./text.ts";
import { escapeLine } from "../sanitize/index.ts";

describe("text helpers", () => {
  test("wrap breaks at spaces, and inside long words", () => {
    expect(wrap("the quick brown fox", 9)).toEqual(["the quick", "brown fox"]);
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrap("", 5)).toEqual([""]);
    expect(wrap("日本語テキスト", 6)).toEqual(["日本語", "テキス", "ト"]);
  });
  test("wrapItems breaks only between items", () => {
    expect(wrapItems(["a b", "c d", "e f"], " · ", 9)).toEqual(["a b · c d", "e f"]);
  });
  test("truncate by display width", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("日本語", 4)).toBe("日…");
    expect(truncate("abc", 3)).toBe("abc");
    expect(lineText(truncLine([{ t: "abc", s: 0 }, { t: "def", s: S.bold }], 5))).toBe("abcd…");
  });
  test("countdowns round up; m:ss, then h:mm:ss", () => {
    expect(countdown(300_000)).toBe("5:00");
    expect(countdown(251_001)).toBe("4:12");
    expect(countdown(1)).toBe("0:01");
    expect(countdown(0)).toBe("0:00");
    expect(countdown(3_600_000)).toBe("1:00:00");
    expect(countdown(3_725_000)).toBe("1:02:05");
  });
  test("escapeUnits matches escapeLine and keeps joiners in context", () => {
    for (const s of ["a\tb", "👨‍👩", "a‍👩", "‮evil", "x\x7fy"]) {
      const cs = Array.from(s);
      expect(escapeUnits(cs).join("")).toBe(escapeLine(s));
    }
  });
});

describe("the final frame filter (tui.md §12)", () => {
  test("keeps the allowed SGR sequences", () => {
    const s = renderLine([{ t: "a", s: S.bold | S.reverse }, { t: "b", s: S.red }, { t: "c", s: S.yellow | S.faint }, { t: "d", s: S.cyan }]);
    expect(filterFrame(s)).toBe(s);
    expect(filterFrame("\x1b[0m\x1b[22;27;39m\x1b[90;97m")).toBe("\x1b[0m\x1b[22;27;39m\x1b[90;97m");
  });
  test("escapes every other escape sequence and control character; tabs become spaces", () => {
    expect(filterFrame("\x1b]52;c;aGk=\x07")).toBe("\\x1b]52;c;aGk=\\x07");
    expect(filterFrame("\x1b[2J")).toBe("\\x1b[2J");
    expect(filterFrame("\x1b[38;5;1m")).toBe("\\x1b[38;5;1m");
    expect(filterFrame("\x1b[4m")).toBe("\\x1b[4m");
    expect(filterFrame("a\tb")).toBe("a b");
    expect(filterFrame("a\rb\x9bc")).toBe("a\\rb\\u009bc");
  });
});
