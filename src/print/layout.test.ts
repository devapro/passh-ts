// The layout grid (print.md §3): cells, widths, marks, wrapping; and --fields (§2.1).

import { describe, expect, test } from "bun:test";
import { cellsOf, cellText, cellWidth, chunkCells, hardWrap, marksOf, proseWrap, textWidth } from "./cells.ts";
import { bulletRows, rowLines, valueRows } from "./rows.ts";
import { isFieldKey, parseFields } from "./fields.ts";
import { UsageError } from "../errors.ts";

describe("cells (§3.2)", () => {
  test("invisible runes become one \\uXXXX cell, width = its length, never marked", () => {
    const c = cellsOf("a b", "spaces");
    expect(c.map((x) => x.text)).toEqual(["a", "\\u00a0", "b"]);
    expect(c[1]!.width).toBe(6);
    expect(c[1]!.mark).toBe("");
    expect(cellsOf(" ͸\u{10ffff}").map((x) => x.text)).toEqual(["\\u2007", "\\ue000", "\\u0378", "\\U0010ffff"]);
  });

  test("a combining mark joins an unmarked previous cell, else is escaped", () => {
    expect(cellsOf("é").map((x) => [x.text, x.width])).toEqual([["é", 1]]);
    expect(cellsOf("0́", "chars").map((x) => x.text)).toEqual(["0", "\\u0301"]);
    expect(cellsOf(" ́", "spaces").map((x) => x.text)).toEqual([" ", "\\u0301"]);
    expect(cellsOf(" ́", "chars").map((x) => x.text)).toEqual([" ́"]);
    expect(cellsOf("́x").map((x) => x.text)).toEqual(["\\u0301", "x"]);
    expect(cellsOf(" ́").map((x) => x.text)).toEqual(["\\u00a0", "\\u0301"]);
  });

  test("widths: W/F count 2, a spacing mark is its own cell of width 1", () => {
    expect(cellsOf("aः0").map((x) => [x.text, x.width])).toEqual([
      ["a", 1],
      ["ः", 1],
      ["0", 1],
    ]);
    expect(cellsOf("漢").map((x) => x.width)).toEqual([2]);
    expect(textWidth("漢字ab")).toBe(6);
    expect(textWidth("🔑")).toBe(2);
    expect(textWidth("é")).toBe(1); // Ambiguous counts 1
  });
});

describe("marks (§3.3)", () => {
  test("codes, spaces only in single-line values, width−1 blanks after wide cells", () => {
    expect(marksOf(cellsOf("Pa55 w0rd!", "spaces"))).toBe("    S D");
    expect(marksOf(cellsOf("Pa55 w0rd!", "chars"))).toBe("      D");
    expect(marksOf(cellsOf("0O1lI", "chars"))).toBe("DUDLU");
    expect(marksOf(cellsOf("漢0", "chars"))).toBe("  D");
    expect(marksOf(cellsOf("0漢", "chars"))).toBe("D");
    expect(marksOf(cellsOf("abc", "spaces"))).toBe("");
    expect(marksOf(cellsOf("5S8B", "spaces"))).toBe(""); // no other look-alikes
    expect(marksOf(cellsOf("zero\\u200bwidth", "spaces"))).toBe("       DD"); // S4's escape is text
  });
});

describe("wrapping (§3.4)", () => {
  test("value chunks of at most 68 columns, a wide cell never split", () => {
    const chunks = chunkCells(cellsOf("x".repeat(67) + "漢y"), 68);
    expect(chunks.map((c) => cellWidth(c))).toEqual([67, 3]);
    expect(chunkCells([], 68)).toEqual([[]]);
  });

  test("value rows: prefixes, continuation and marks", () => {
    const pw = "aB3$".repeat(20) + "lI0O";
    const rows = valueRows("password", [pw], "spaces");
    expect(rows.flatMap(rowLines)).toEqual(["  password  " + "aB3$".repeat(17), "          → aB3$aB3$aB3$lI0O", "                        LUDU"]);
  });

  test("a label wider than 9 columns gets its own row", () => {
    const rows = valueRows("recovery-email", ["me+gh@example.com"], "spaces");
    expect(rows.flatMap(rowLines)).toEqual(["  recovery-email", "            me+gh@example.com", "                       L"]);
    const long = valueRows("k".repeat(100), ["v"], "spaces").flatMap(rowLines);
    expect(long).toEqual(["  " + "k".repeat(78), "  " + "k".repeat(22), "            v"]);
  });

  test("notes lines: 12 blanks after the first; an empty line is empty; own blanks kept", () => {
    const rows = valueRows("notes", ["", "   ", "x"], "chars");
    expect(rows.flatMap(rowLines)).toEqual(["  notes", "               ", "            x"]);
    expect(valueRows("password", ["pw  "], "spaces").flatMap(rowLines)).toEqual(["  password  pw  ", "              SS"]);
  });

  test("hard wrap of names at 80 columns, never at spaces", () => {
    expect(hardWrap("n".repeat(100))).toEqual(["n".repeat(80), "n".repeat(20)]);
    expect(hardWrap("漢".repeat(41))).toEqual(["漢".repeat(40), "漢"]);
  });

  test("prose: white space collapses (NBSP too), greedy fill, long words broken", () => {
    expect(proseWrap("  a   b　c  ")).toEqual(["a b c"]);
    const words = Array.from({ length: 30 }, (_, i) => "w" + i).join(" ");
    const lines = proseWrap(words);
    for (const l of lines) expect(textWidth(l)).toBeLessThanOrEqual(80);
    expect(lines.join(" ")).toBe(words);
    expect(proseWrap("ab " + "x".repeat(170) + " cd")).toEqual(["ab", "x".repeat(80), "x".repeat(80), "x".repeat(10) + " cd"]);
    expect(proseWrap("")).toEqual([""]);
  });

  test("bullets: wrapped at 78, `• ` then two blanks", () => {
    const rows = bulletRows("word ".repeat(30));
    expect(rows[0]!.text.startsWith("• word")).toBe(true);
    expect(rows[1]!.text.startsWith("  word")).toBe(true);
    for (const r of rows) expect(textWidth(r.text)).toBeLessThanOrEqual(80);
  });

  test("cellText round trip", () => {
    const s = "á漢 x";
    expect(cellText(cellsOf(s))).toBe(s);
  });
});

describe("--fields (§2.1)", () => {
  test("default, trimming, duplicates, any case for the standard names", () => {
    const names = (v?: string) => parseFields(v).map((f) => (f.kind === "standard" ? f.name : "custom:" + f.key));
    expect(names(undefined)).toEqual(["password", "username", "url"]);
    expect(names("")).toEqual(["password", "username", "url"]);
    expect(names(" , ,")).toEqual(["password", "username", "url"]);
    expect(names(" Notes , PASSWORD,notes,fields,pin,PIN,pin")).toEqual(["notes", "password", "fields", "custom:pin", "custom:PIN"]);
    expect(names("ключ,a.b-c_d,1x")).toEqual(["custom:ключ", "custom:a.b-c_d", "custom:1x"]);
  });

  test("invalid names are usage errors", () => {
    for (const bad of ["a b", "_x", "-x", ".x", "x/y", "a\tb", "é​"]) {
      let err: unknown;
      try {
        parseFields("password," + bad);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(UsageError);
    }
    expect(() => parseFields("a b")).toThrow('invalid field "a b": use password, username, url, tags, notes, fields, or the key of a custom field');
  });

  test("field key grammar", () => {
    expect(isFieldKey("x")).toBe(true);
    expect(isFieldKey("é")).toBe(true);
    expect(isFieldKey("́e")).toBe(false);
    expect(isFieldKey("")).toBe(false);
  });
});
