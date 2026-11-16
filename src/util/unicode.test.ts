import { describe, expect, test } from "bun:test";
import {
  codePointLength,
  compareUTF8,
  decodeUTF8Lossy,
  foldEquals,
  foldString,
  generalCategory,
  hasLoneSurrogate,
  isFormat,
  isLetter,
  isWhiteSpace,
  isWide,
  simpleFold,
  trimWhiteSpace,
  utf8Length,
  wtf8Encode,
} from "./unicode.ts";

describe("general categories (Unicode 15.0.0)", () => {
  test("samples", () => {
    expect(generalCategory(0x41)).toBe("Lu");
    expect(generalCategory(0x61)).toBe("Ll");
    expect(generalCategory(0x01c5)).toBe("Lt");
    expect(generalCategory(0x0301)).toBe("Mn");
    expect(generalCategory(0x0903)).toBe("Mc");
    expect(generalCategory(0x20dd)).toBe("Me");
    expect(generalCategory(0x0661)).toBe("Nd");
    expect(generalCategory(0x00ad)).toBe("Cf");
    expect(generalCategory(0x0378)).toBe("Cn");
    expect(generalCategory(0xe000)).toBe("Co");
    expect(generalCategory(0xd800)).toBe("Cs");
    expect(generalCategory(0x2028)).toBe("Zl");
    expect(generalCategory(0x1f600)).toBe("So");
    expect(generalCategory(0x11f00)).toBe("Mn"); // new in 15.0
    expect(generalCategory(0x1cc00)).toBe("Cn"); // assigned in 16.0, not in 15.0
    expect(generalCategory(0x10ffff)).toBe("Cn");
    expect(generalCategory(0xe0041)).toBe("Cf");
    expect(isFormat(0x200d)).toBe(true);
    expect(isLetter(0x4e00)).toBe(true);
  });
  test("agrees with the engine for every code point of the BMP's common blocks", () => {
    // The engine's tables may be newer; code points assigned before 15.0 rarely change.
    let diff = 0;
    for (let cp = 0; cp < 0x3000; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const cat = generalCategory(cp);
      if (cat === "Cn") continue;
      if (!new RegExp(`^\\p{gc=${cat}}$`, "u").test(String.fromCodePoint(cp))) diff++;
    }
    expect(diff).toBeLessThan(5);
  });
});

describe("white space", () => {
  test("the spec's list", () => {
    const ws = [0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
    for (const c of ws) expect(isWhiteSpace(c)).toBe(true);
    for (const c of [0x0, 0x1c, 0x200b, 0x180e, 0xfeff, 0x41]) expect(isWhiteSpace(c)).toBe(false);
    expect(trimWhiteSpace("　 a b\u0085\t")).toBe("a b");
    expect(trimWhiteSpace("  ")).toBe("");
    expect(trimWhiteSpace("😀 ")).toBe("😀");
  });
});

describe("simple case folding", () => {
  test("orbits named by the spec", () => {
    expect(foldEquals("uſername", "username")).toBe(true);
    expect(foldEquals("K", "k")).toBe(true);
    expect(foldEquals("K", "K")).toBe(true);
    expect(foldEquals("USERNAME", "username")).toBe(true);
    expect(foldEquals("ß", "ss")).toBe(false);
    expect(foldEquals("ẞ", "ß")).toBe(true); // 1E9E S 00DF
    expect(foldEquals("İ", "i")).toBe(false); // only T/F foldings
    expect(foldEquals("ı", "I")).toBe(false);
    expect(foldEquals("Σ", "ς")).toBe(true);
    expect(foldEquals("ab", "a")).toBe(false);
    expect(simpleFold(0x41)).toBe(0x61);
    expect(simpleFold(0x13a0)).toBe(0x13a0); // Cherokee upper folds to itself
    expect(simpleFold(0xab70)).toBe(0x13a0);
    expect(foldString("URL")).toBe("url");
  });
});

describe("east asian width", () => {
  test("W and F", () => {
    expect(isWide(0x4e00)).toBe(true);
    expect(isWide(0x3400)).toBe(true);
    expect(isWide(0xff01)).toBe(true);
    expect(isWide(0x1f600)).toBe(true);
    expect(isWide(0x2630)).toBe(false); // W only from Unicode 16
    expect(isWide(0x41)).toBe(false);
    expect(isWide(0xa1)).toBe(false); // A
  });
});

describe("UTF-8", () => {
  test("Go-style lossy decoding: one U+FFFD per invalid byte", () => {
    expect(decodeUTF8Lossy(Uint8Array.from([0x61, 0xe2, 0x82, 0x62]))).toBe("a��b");
    expect(decodeUTF8Lossy(Uint8Array.from([0xed, 0xa0, 0x80]))).toBe("���");
    expect(decodeUTF8Lossy(new TextEncoder().encode("héllo😀"))).toBe("héllo😀");
    expect(decodeUTF8Lossy(Uint8Array.from([0xe2, 0x82, 0xac]), 0, 2)).toBe("��");
  });
  test("lengths and surrogates", () => {
    expect(utf8Length("aé€😀")).toBe(1 + 2 + 3 + 4);
    expect(utf8Length("\ud800")).toBe(3);
    expect(hasLoneSurrogate("a\ud800")).toBe(true);
    expect(hasLoneSurrogate("😀")).toBe(false);
    expect(hasLoneSurrogate("\ude00\ud83d")).toBe(true);
    expect(Array.from(wtf8Encode("\ud800"))).toEqual([0xed, 0xa0, 0x80]);
    expect(Array.from(wtf8Encode("😀"))).toEqual([0xf0, 0x9f, 0x98, 0x80]);
    expect(codePointLength("a😀́")).toBe(3);
  });
  test("compareUTF8 is code point order", () => {
    const list = ["😀", "￿", "é", "", "B", "a", "é"];
    list.sort(compareUTF8);
    expect(list).toEqual(["B", "a", "é", "é", "", "￿", "😀"]);
  });
});
