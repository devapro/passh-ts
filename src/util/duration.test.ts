import { describe, expect, test } from "bun:test";
import { parseGoDuration, formatGoDuration, formatShortDuration, SEC, MIN, HOUR, MS } from "./duration.ts";

describe("parseGoDuration", () => {
  test("valid", () => {
    expect(parseGoDuration("30s")).toBe(30n * SEC);
    expect(parseGoDuration("1.5h")).toBe(90n * MIN);
    expect(parseGoDuration("1h30m")).toBe(90n * MIN);
    expect(parseGoDuration(".5s")).toBe(500n * MS);
    expect(parseGoDuration("5.s")).toBe(5n * SEC);
    expect(parseGoDuration("0")).toBe(0n);
    expect(parseGoDuration("-5m")).toBe(-5n * MIN);
    expect(parseGoDuration("+5m")).toBe(5n * MIN);
    expect(parseGoDuration("10µs")).toBe(10_000n);
    expect(parseGoDuration("10μs")).toBe(10_000n);
  });
  test("errors with Go's texts", () => {
    const err = (s: string) => {
      try {
        parseGoDuration(s);
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(err("5")).toBe('time: missing unit in duration "5"');
    expect(err("5d")).toBe('time: unknown unit "d" in duration "5d"');
    expect(err("")).toBe('time: invalid duration ""');
    expect(err(".s")).toBe('time: invalid duration ".s"');
    expect(err("x")).toBe('time: invalid duration "x"');
    expect(err("1 h")).toBe('time: unknown unit " h" in duration "1 h"');
    expect(err("3000000h")).toBe('time: invalid duration "3000000h"');
  });
});

describe("formatGoDuration", () => {
  test("Duration.String", () => {
    expect(formatGoDuration(15n * MIN)).toBe("15m0s");
    expect(formatGoDuration(2n * HOUR)).toBe("2h0m0s");
    expect(formatGoDuration(90n * MIN)).toBe("1h30m0s");
    expect(formatGoDuration(1500n * MS)).toBe("1.5s");
    expect(formatGoDuration(500n * MS)).toBe("500ms");
    expect(formatGoDuration(0n)).toBe("0s");
    expect(formatGoDuration(1500n)).toBe("1.5µs");
  });
});

describe("formatShortDuration (<D>)", () => {
  test("agent-session.md §A2.3 rounding", () => {
    expect(formatShortDuration(2 * 3600_000)).toBe("2h");
    expect(formatShortDuration(90 * 60_000)).toBe("1h30m");
    expect(formatShortDuration(3600_000 + 59_000)).toBe("1h");
    expect(formatShortDuration(15 * 60_000)).toBe("15m");
    expect(formatShortDuration(14 * 60_000 + 59_000)).toBe("14m59s");
    expect(formatShortDuration(45_000)).toBe("45s");
    expect(formatShortDuration(400)).toBe("0s");
    expect(formatShortDuration(500)).toBe("1s");
    expect(formatShortDuration(-5)).toBe("0s");
  });
});
