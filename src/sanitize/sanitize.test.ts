import { describe, expect, test } from "bun:test";
import { escapeLine, escapeMultiline, needsEscaping } from "./index.ts";
import { runeWidth, stringWidth } from "./width.ts";

const bytes = (...b: number[]) => Uint8Array.from(b);

// agent-session.md §A9.1 test vectors (single-line form).
const vectors: Array<[string | Uint8Array, string]> = [
  ["a\tb\nc\rd", "a\\tb\\nc\\rd"],
  ["\x1b[31mred", "\\x1b[31mred"],
  ["x\x7fy\x00z", "x\\x7fy\\x00z"],
  [bytes(0xff, 0xc3, 0x28), "\\xff\\xc3("],
  ["a\u009bb", "a\\u009bb"],
  ["so\u00adft", "so\\u00adft"],
  ["\ufeffbom", "\\ufeffbom"],
  ["l\u2028p", "l\\u2028p"],
  ["\u202eevil", "\\u202eevil"],
  ["tag\u{E0041}", "tag\\U000e0041"],
  // joiner kept
  ["👨\u200d👩", "👨\u200d👩"],
  ["क\u200dष", "क\u200dष"],
  ["©\u200d®", "©\u200d®"],
  ["\u0301\u200dé", "\u0301\u200dé"],
  ["é\u200d١", "é\u200d١"],
  // joiner escaped
  ["a\u200d👩", "a\\u200d👩"],
  ["\u200d👩", "\\u200d👩"],
  ["👩\u200d", "👩\\u200d"],
  ["«\u200dé", "«\\u200dé"],
  ["é\u200d1", "é\\u200d1"],
  ["क\u200d\u200dष", "क\\u200d\\u200dष"],
  ["\u200b\u200d👩", "\\u200b\\u200d👩"],
  [new Uint8Array([0xff, ...new TextEncoder().encode("\u200d👩")]), "\\xff\\u200d👩"],
  ["\ufffd\u200d👩", "\ufffd\\u200d👩"],
  // unchanged
  ["\u0301x\u00a0\ufffd\ue000\u0378\uffff", "\u0301x\u00a0\ufffd\ue000\u0378\uffff"],
  ["C:\\x1b", "C:\\x1b"],
];

describe("escapeLine (§A9.1 vectors)", () => {
  for (const [input, want] of vectors) {
    test(JSON.stringify(typeof input === "string" ? input : Array.from(input)), () => {
      expect(escapeLine(input)).toBe(want);
      // the same bytes as a Uint8Array or string give the same output
      if (typeof input === "string") expect(escapeLine(new TextEncoder().encode(input))).toBe(want);
    });
  }
});

describe("escapeMultiline", () => {
  test("first row keeps TAB and LF, escapes CR", () => {
    expect(escapeMultiline("a\tb\nc\rd")).toBe("a\tb\nc\\rd");
  });
  test("other rows as single-line", () => {
    for (const [input, want] of vectors.slice(1)) expect(escapeMultiline(input)).toBe(want);
  });
  test("CRLF", () => expect(escapeMultiline("a\r\nb")).toBe("a\\r\nb"));
});

describe("properties", () => {
  test("escaping twice changes nothing", () => {
    for (const [input] of vectors) {
      const once = escapeLine(input);
      expect(escapeLine(once)).toBe(once);
      const m = escapeMultiline(input);
      expect(escapeMultiline(m)).toBe(m);
    }
  });
  test("lone surrogates are invalid bytes", () => {
    expect(escapeLine("a\ud800b")).toBe("a\\xed\\xa0\\x80b");
    expect(escapeLine("\udfff")).toBe("\\xed\\xbf\\xbf");
    expect(escapeLine("😀")).toBe("😀");
  });
  test("other C0 and invalid sequences", () => {
    expect(escapeLine("\x01\x1f\x0b\x0c")).toBe("\\x01\\x1f\\x0b\\x0c");
    expect(escapeLine(bytes(0xe2, 0x82))).toBe("\\xe2\\x82");
    expect(escapeLine(bytes(0xc0, 0xaf))).toBe("\\xc0\\xaf"); // overlong
    expect(escapeLine(bytes(0xed, 0xa0, 0x80))).toBe("\\xed\\xa0\\x80"); // surrogate
    expect(escapeLine(bytes(0xf4, 0x90, 0x80, 0x80))).toBe("\\xf4\\x90\\x80\\x80"); // > U+10FFFF
    expect(escapeLine("\u0085")).toBe("\\u0085");
    expect(escapeLine("\u061c\u2060\u2066\u206f\u{E0001}\u{E007F}")).toBe("\\u061c\\u2060\\u2066\\u206f\\U000e0001\\U000e007f");
    expect(escapeLine("\u200c")).toBe("\\u200c");
    expect(escapeLine("ب\u200cب")).toBe("ب\u200cب");
  });
  test("needsEscaping", () => {
    expect(needsEscaping("plain")).toBe(false);
    expect(needsEscaping("é")).toBe(false);
    expect(needsEscaping("a\tb")).toBe(true);
    expect(needsEscaping(bytes(0xff))).toBe(true);
    expect(needsEscaping("\ud800")).toBe(true);
  });
});

describe("width (print.md §3.2)", () => {
  test("rune widths", () => {
    expect(runeWidth(0x61)).toBe(1);
    expect(runeWidth(0x6f22)).toBe(2); // 漢
    expect(runeWidth(0x903)).toBe(1); // Mc
    expect(runeWidth(0x301)).toBe(0); // Mn
    expect(runeWidth(0x20dd)).toBe(0); // Me
    expect(runeWidth(0xff21)).toBe(2); // Fullwidth A
    expect(runeWidth(0xff61)).toBe(1); // Halfwidth
    expect(runeWidth(0x00a1)).toBe(1); // Ambiguous
    expect(runeWidth(0x1f600)).toBe(2); // emoji W
    expect(runeWidth(0x20000)).toBe(2);
    expect(runeWidth(0x3fffd)).toBe(2);
    expect(runeWidth(0x1100)).toBe(2);
  });
  test("string widths", () => {
    expect(stringWidth("aः0")).toBe(3);
    expect(stringWidth("漢字")).toBe(4);
    expect(stringWidth("e\u0301")).toBe(1);
    expect(stringWidth("")).toBe(0);
    expect(stringWidth("😀x")).toBe(3);
  });
});
