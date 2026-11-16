import { describe, expect, test } from "bun:test";
import { folderRows, indexOf, moveBy, resolveCursor, searchRows, tagRows, type Row } from "./browse.ts";
import { makeData } from "./fake.ts";

const data = makeData([
  { path: "work/x", id: "wx", tags: ["b", "a"] },
  { path: "work-old/y", id: "wy", tags: ["a"] },
  { path: "work", id: "w" },
  { path: "Bank/acct", id: "ba" },
  { path: "apple", id: "ap", tags: ["zz-gh"] },
  { path: "work/sub/deep", id: "wsd" },
]);
const ix = indexOf(data);
const texts = { none: "NONE", hint: "HINT", heading: (n: number, t: string) => `── ${n} with ${t} ──` };
const show = (rows: Row[]) => rows.map((r) => "  ".repeat(r.depth) + (r.kind === "folder" ? (r.open ? "v " : "> ") : r.kind === "tag" ? (r.selected ? "[x] " : "[ ] ") : "") + r.text + (r.count !== undefined ? ` (${r.count})` : ""));

describe("Folders view (tui.md §5.2)", () => {
  test("subfolders first, then entries, each by bytes; all closed", () => {
    expect(show(folderRows(ix, new Set()))).toEqual(["> Bank (1)", "> work (2)", "> work-old (1)", "apple", "work"]);
  });
  test("open folders show their children", () => {
    expect(show(folderRows(ix, new Set(["work", "work/sub"])))).toEqual(["> Bank (1)", "v work (2)", "  v sub (1)", "    deep", "  x", "> work-old (1)", "apple", "work"]);
  });
});

describe("Tags view (tui.md §5.3)", () => {
  test("tags with counts, then the hint", () => {
    expect(show(tagRows(ix, [], texts))).toEqual(["[ ] a (2)", "[ ] b (1)", "[ ] zz-gh (1)", "HINT"]);
  });
  test("selected tags: heading, then entries with all of them (AND), full paths in path order", () => {
    expect(show(tagRows(ix, ["a"], texts))).toEqual(["[x] a (2)", "[ ] b (1)", "[ ] zz-gh (1)", "── 2 with a ──", "work/x", "work-old/y"]);
    expect(show(tagRows(ix, ["b", "a"], texts)).slice(3)).toEqual(["── 1 with a + b ──", "work/x"]);
  });
  test("no tags", () => {
    expect(show(tagRows(indexOf(makeData([{ path: "x" }])), [], texts))).toEqual(["NONE"]);
  });
});

describe("search (tui.md §5.4)", () => {
  test("empty or blank query lists every entry in path order", () => {
    expect(searchRows(ix, "", "NO").map((r) => r.text)).toEqual(["Bank/acct", "apple", "work", "work/sub/deep", "work/x", "work-old/y"]);
    expect(searchRows(ix, "  ", "NO").length).toBe(6);
  });
  test("tags count at their score and win only when strictly higher", () => {
    const d = indexOf(makeData([{ path: "github", tags: ["gh"] }, { path: "work/github" }, { path: "work/gitlab", tags: ["zz-gh"] }]));
    const r = searchRows(d, "gh", "NO");
    expect(r.map((x) => [x.text, x.matchTag])).toEqual([
      ["github", "gh"],
      ["work/gitlab", "zz-gh"],
      ["work/github", undefined],
    ]);
  });
  test("no matches: the note", () => {
    const r = searchRows(ix, "qqq", "No matches.");
    expect(r).toEqual([{ kind: "note", key: "", depth: 0, text: "No matches." }]);
  });
  test("the query is used as typed: spaces are pattern characters", () => {
    expect(searchRows(indexOf(makeData([{ path: "a b" }, { path: "ab" }])), " ", "NO").length).toBe(2);
    expect(searchRows(indexOf(makeData([{ path: "a b" }, { path: "ab" }])), "a ", "NO").map((r) => r.text)).toEqual(["a b"]);
  });
});

describe("cursor (tui.md §5.5)", () => {
  const rows = folderRows(ix, new Set());
  test("remembered by item", () => {
    expect(resolveCursor(rows, { key: "e:ap", index: 0 })).toBe(3);
  });
  test("a gone item: the nearest selectable row at the same index, down first, then up", () => {
    expect(resolveCursor(rows, { key: "e:gone", index: 2 })).toBe(2);
    const withNote: Row[] = [{ kind: "tag", key: "t:a", depth: 0, text: "a" }, { kind: "note", key: "", depth: 0, text: "n" }, { kind: "entry", key: "e:1", depth: 0, text: "x" }];
    expect(resolveCursor(withNote, { key: "", index: 1 })).toBe(2);
    expect(resolveCursor(withNote.slice(0, 2), { key: "", index: 1 })).toBe(0);
    expect(resolveCursor(withNote, { key: "", index: 9 })).toBe(2);
  });
  test("moves skip note rows and stop at the ends", () => {
    const r: Row[] = [{ kind: "tag", key: "t:a", depth: 0, text: "a" }, { kind: "heading", key: "", depth: 0, text: "h" }, { kind: "entry", key: "e:1", depth: 0, text: "x" }];
    expect(moveBy(r, 0, 1)).toBe(2);
    expect(moveBy(r, 2, 1)).toBe(2);
    expect(moveBy(r, 2, -1)).toBe(0);
    expect(moveBy(r, 0, -5)).toBe(0);
  });
});
