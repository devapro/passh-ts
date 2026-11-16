import { describe, expect, test } from "bun:test";
import { ALPHABET, ALPHABET_SYMBOLS, generateFrom, generatePassword, parseLength, shellQuote, strengthBits, type RandomSource } from "./index.ts";
import { UsageError } from "../errors.ts";

/** A random source that replays a fixed byte stream and records how much was read. */
function stream(bytes: number[]): RandomSource & { read: number } {
  let pos = 0;
  const f = ((buf: Uint8Array) => {
    for (let i = 0; i < buf.length; i++) {
      if (pos >= bytes.length) throw new Error("stream exhausted");
      buf[i] = bytes[pos++]!;
    }
    f.read = pos;
  }) as RandomSource & { read: number };
  f.read = 0;
  return f;
}

describe("alphabets (import-export.md §3.1)", () => {
  test("sizes and indexes", () => {
    expect(ALPHABET.length).toBe(62);
    expect(ALPHABET_SYMBOLS.length).toBe(94);
    expect(ALPHABET[0]).toBe("A");
    expect(ALPHABET[26]).toBe("a");
    expect(ALPHABET[52]).toBe("0");
    expect(ALPHABET_SYMBOLS[62]).toBe("!");
    expect(ALPHABET_SYMBOLS[93]).toBe("~");
    // the 32 printable ASCII punctuation characters, in ASCII order
    const punct = [...ALPHABET_SYMBOLS.slice(62)].map((c) => c.charCodeAt(0));
    const want: number[] = [];
    for (let c = 0x21; c < 0x7f; c++) if (!/[A-Za-z0-9]/.test(String.fromCharCode(c))) want.push(c);
    expect(punct).toEqual(want);
  });
});

describe("algorithm (§3.2 vectors)", () => {
  test("default, length 5", () => {
    const r = stream([0xf8, 0xff, 0x00, 0x3d, 0x3e, 0xf7, 0x64]);
    expect(generatePassword(5, false, r)).toBe("A9A9m");
    expect(r.read).toBe(7); // reads exactly what it examines
  });
  test("symbols, length 4", () => {
    const r = stream([0xbc, 0x00, 0xff, 0x5d, 0xc8, 0xbb, 0x5e]);
    expect(generatePassword(4, true, r)).toBe("A~~A");
    expect(r.read).toBe(7);
  });
  test("reads only the missing count each round", () => {
    const reads: number[] = [];
    const r: RandomSource = (buf) => {
      reads.push(buf.length);
      buf.fill(reads.length === 1 ? 0xff : 0x00);
    };
    expect(generatePassword(3, false, r)).toBe("AAA");
    expect(reads).toEqual([3, 3]);
  });
  test("errors from the source", () => {
    expect(() => generatePassword(3, false, () => {
      throw new Error("boom");
    })).toThrow("reading random bytes: boom");
  });
  test("defaults", () => {
    const p = generatePassword();
    expect(p.length).toBe(24);
    expect(/^[A-Za-z0-9]+$/.test(p)).toBe(true);
    expect(generatePassword(4096, true).length).toBe(4096);
  });
  test("custom alphabets", () => {
    expect(generateFrom("ab", 4, stream([0, 1, 2, 3]))).toBe("abab");
    expect(() => generateFrom("a", 4)).toThrow();
    expect(() => generateFrom("aa", 4)).toThrow();
    expect(() => generateFrom("a b", 4)).toThrow();
    expect(generateFrom("αβγ", 2, stream([255, 0, 4]))).toBe("αβ");
  });
});

describe("strength and arguments", () => {
  test("bits", () => {
    expect(strengthBits(24)).toBe(142);
    expect(strengthBits(24, true)).toBe(157);
    expect(strengthBits(32, true)).toBe(209);
  });
  test("parseLength", () => {
    expect(parseLength("24")).toBe(24);
    expect(parseLength("+5")).toBe(5);
    expect(parseLength("007")).toBe(7);
    expect(parseLength("4096")).toBe(4096);
    for (const bad of ["0", "-0", "4097", "-5", "", " 5", "5x", "1e3", "99999999999999999999999"]) {
      let err: unknown;
      try {
        parseLength(bad);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(UsageError);
      expect((err as Error).message).toBe(`length ${JSON.stringify(bad)}: give a number from 1 to 4096`);
    }
  });
  test("shellQuote", () => {
    expect(shellQuote("work/github")).toBe("work/github");
    expect(shellQuote("a+b@c:d,e=f.g_h-i")).toBe("a+b@c:d,e=f.g_h-i");
    expect(shellQuote("bank/My Bank")).toBe("'bank/My Bank'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("")).toBe("''");
  });
});

describe("chi-square over 10^6 samples (spec §13.2 item 4)", () => {
  for (const symbols of [false, true]) {
    test(symbols ? "symbols" : "default", () => {
      const alphabet = symbols ? ALPHABET_SYMBOLS : ALPHABET;
      const n = alphabet.length;
      const index = new Map([...alphabet].map((c, i) => [c, i]));
      const counts = new Array<number>(n).fill(0);
      let total = 0;
      while (total < 1_000_000) {
        const p = generatePassword(4096, symbols);
        for (const c of p) counts[index.get(c)!]!++;
        total += p.length;
      }
      const expected = total / n;
      let chi = 0;
      for (const c of counts) chi += (c - expected) ** 2 / expected;
      // df = n − 1; critical values at p = 0.0001: df 61 ≈ 107.3, df 93 ≈ 144.1
      const critical = symbols ? 144.1 : 107.3;
      expect(chi).toBeLessThan(critical);
    });
  }
});
