import { describe, expect, test } from "bun:test";
import { fuzzyFind, fuzzyMatch, rankEntries } from "./index.ts";

// cli.md, "Fuzzy matching" vectors.
const vectors: Array<[string, string, number | null, number[]]> = [
  ["gh", "github", 6, [0, 3]],
  ["gh", "work/github", -4, [5, 8]],
  ["wg", "work/github", 21, [0, 5]],
  ["GIT", "work/github", 17, [5, 6, 7]],
  ["tk", "The Black Knight", 16, [0, 10]],
  ["abcd", "abcd", 75, [0, 1, 2, 3]],
  ["abcd", "abXcd", 29, [0, 1, 3, 4]],
  ["abc", "abx_bc", 42, [0, 4, 5]],
  ["gh", "myGitHub", 24, [2, 5]],
  ["aa", "banana", -9, [1, 3]],
  ["b", "éb", -12, [2]],
  ["z", "abcdz", -19, [4]],
  ["k", "Kelvin", 3, [0]],
  ["é", "café", -19, [3]],
  ["é", "café", null, []],
  ["ba", "ab", null, []],
  [" ", "a b", -7, [1]],
];

describe("fuzzyMatch (spec vectors)", () => {
  for (const [p, s, score, pos] of vectors) {
    test(`${JSON.stringify(p)} in ${JSON.stringify(s)}`, () => {
      const m = fuzzyMatch(p, s);
      if (score === null) expect(m).toBeUndefined();
      else expect(m).toEqual({ score, positions: pos });
    });
  }
  test("empty pattern never matches", () => expect(fuzzyMatch("", "abc")).toBeUndefined());
  test("ſ and S", () => {
    expect(fuzzyMatch("s", "ſ")?.positions).toEqual([0]);
    expect(fuzzyMatch("ſ", "S")?.positions).toEqual([0]);
    expect(fuzzyMatch("ß", "ss")).toBeUndefined();
  });
  test("invalid bytes are one U+FFFD character each", () => {
    const m = fuzzyMatch("a", new Uint8Array([0xff, 0x61]));
    expect(m).toEqual({ score: -5 + 1 - 2, positions: [1] }); // leading penalty −5, 1 chosen, 2 bytes
  });
});

describe("fuzzyFind", () => {
  test("sorted by score, ties in input order", () => {
    const r = fuzzyFind("gh", ["work/github", "github", "x", "gh"]);
    expect(r.map((m) => [m.str, m.score])).toEqual([
      ["gh", 10 + 5 + 2 - 2],
      ["github", 6],
      ["work/github", -4],
    ]);
    expect(r[1]!.indexes).toEqual([0, 3]);
    expect(fuzzyFind("é", ["café"])[0]!.indexes).toEqual([3]);
  });
});

describe("rankEntries", () => {
  test("cli.md §2.4 example", () => {
    const entries = [
      { path: "github", tags: ["gh"] },
      { path: "work/github", tags: [] },
      { path: "work/gitlab", tags: ["zz-gh"] },
    ];
    const r = rankEntries("gh", entries, { mode: "find" });
    expect(r.map((h) => [h.entry.path, h.tag, h.score])).toEqual([
      ["github", "gh", 14],
      ["work/gitlab", "zz-gh", 6],
      ["work/github", undefined, -4],
    ]);
  });
  test("first tag in the list wins among the best", () => {
    const entries = [
      { path: "a", tags: ["gx2", "gx1"] },
      { path: "b", tags: ["gx1", "gx2"] },
    ];
    const r = rankEntries("gx", entries, { mode: "find" });
    expect(r.map((h) => [h.entry.path, h.tag])).toEqual([
      ["a", "gx2"],
      ["b", "gx2"],
    ]);
  });
  test("find: ties by path segments; empty query nothing", () => {
    const entries = [
      { path: "work-old/y", tags: [] },
      { path: "work/y", tags: [] },
    ];
    expect(rankEntries("y", entries, { mode: "find" }).map((h) => h.entry.path)).toEqual(["work/y", "work-old/y"]);
    expect(rankEntries("", entries, { mode: "find" })).toEqual([]);
    expect(rankEntries(" ", [{ path: "a b", tags: [] }], { mode: "find" }).length).toBe(1);
  });
  test("tui: tag counts t, ties by bytes, blank lists all", () => {
    const entries = [
      { path: "a/yy", tags: [] },
      { path: "a-/y", tags: [] },
      { path: "b", tags: ["gh"] },
    ];
    // "a" scores 7 in both paths: ties by bytes put "a-/y" first, by segments "a/yy"
    expect(rankEntries("a", entries, { mode: "tui" }).map((h) => [h.entry.path, h.score])).toEqual([["a-/y", 7], ["a/yy", 7]]);
    expect(rankEntries("a", entries, { mode: "tui", tuiTies: "segments" }).map((h) => h.entry.path)).toEqual(["a/yy", "a-/y"]);
    expect(rankEntries("a", entries, { mode: "find" }).map((h) => h.entry.path)).toEqual(["a/yy", "a-/y"]);
    expect(rankEntries("  ", entries, { mode: "tui" }).map((h) => h.entry.path)).toEqual(["a/yy", "a-/y", "b"]);
    expect(rankEntries("", entries, { mode: "tui" }).length).toBe(3);
    const g = rankEntries("gh", [{ path: "gh", tags: ["gh"] }], { mode: "tui" });
    expect(g[0]!.tag).toBeUndefined(); // equal score: the path wins
    const h = rankEntries("gh", [{ path: "github", tags: ["gh"] }], { mode: "tui" });
    expect([h[0]!.tag, h[0]!.score]).toEqual(["gh", 15]);
  });
});
