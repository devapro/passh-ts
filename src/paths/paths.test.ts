import { describe, expect, test } from "bun:test";
import { hasCode } from "../i18n/index.ts";
import {
  allFolders,
  baseName,
  buildTree,
  comparePaths,
  countInFolder,
  countTags,
  dedupeTags,
  folderExists,
  foldersOf,
  hasAllTags,
  isInFolder,
  isValidPath,
  isValidTag,
  listEntries,
  moveDestination,
  normalizeTag,
  parentFolder,
  parseFolder,
  parsePath,
  parseTagList,
  renderTree,
  sortPaths,
} from "./index.ts";

function errOf(f: () => unknown): Error {
  try {
    f();
  } catch (e) {
    return e as Error;
  }
  throw new Error("no error");
}

describe("parsePath (vault-format.md §6.1)", () => {
  const bad: Array<[string | Uint8Array, string]> = [
    ["", "it is empty"],
    [new Uint8Array([]), "it is empty"],
    [new Uint8Array([0x61, 0xff]), "it is not valid UTF-8"],
    ["a\ud800", "it is not valid UTF-8"],
    ["x".repeat(1025), "it is longer than 1024 bytes"],
    ["é".repeat(513), "it is longer than 1024 bytes"],
    ["a\u0001", "it contains a control character"],
    ["a\u0085b", "it contains a control character"],
    ["a\u007f", "it contains a control character"],
    ["a\tb", "it contains a control character"],
    ["/a", "it starts with /"],
    ["/", "it starts with /"],
    ["a/", "it ends with /"],
    ["a//b", "it has an empty segment (//)"],
    ["a/./b", 'it has a "." or ".." segment'],
    ["..", 'it has a "." or ".." segment'],
    ["a/..", 'it has a "." or ".." segment'],
    ["-a", "a segment starts with -"],
    ["a/-b//c", "a segment starts with -"],
    ["a//-b", "it has an empty segment (//)"],
  ];
  for (const [input, reason] of bad) {
    test(`refuses ${JSON.stringify(typeof input === "string" ? input.slice(0, 20) : Array.from(input))}`, () => {
      const e = errOf(() => parsePath(input));
      expect(e.message).toBe("invalid path: " + reason);
      expect(hasCode(e, "invalid-path")).toBe(true);
      const f = errOf(() => parseFolder(input));
      expect(f.message).toBe("invalid folder: " + reason);
      expect(hasCode(f, "invalid-folder")).toBe(true);
    });
  }
  const good = [" a", "a ", "a b/ c ", "...", ".hidden", "a.", "~2", "\\", "🔑/ключ", "a​b", "‮evil", "x".repeat(1024), "a/b-c/d-", "a-/b"];
  for (const p of good) {
    test(`accepts ${JSON.stringify(p.slice(0, 20))}`, () => {
      expect(parsePath(p)).toBe(p);
      expect(isValidPath(p)).toBe(true);
    });
  }
  test("NFC", () => {
    expect(parsePath("café")).toBe("café");
    expect(parsePath(new TextEncoder().encode("café/x"))).toBe("café/x");
    expect(isValidPath("café")).toBe(false);
    // 1024 bytes are counted after NFC
    expect(parsePath("é".repeat(512))).toBe("é".repeat(512));
  });
});

describe("order and folders (§6.2)", () => {
  test("comparePaths", () => {
    expect(sortPaths(["work-old/y", "work/x", "work"])).toEqual(["work", "work/x", "work-old/y"]);
    expect(sortPaths(["homelab", "My Bank", "a b", "a/b", "a"])).toEqual(["My Bank", "a", "a/b", "a b", "homelab"]);
    expect(sortPaths(["\u{1F600}", "￿", "", "é"])).toEqual(["é", "", "￿", "\u{1F600}"]);
    expect(comparePaths("a", "a")).toBe(0);
    expect(sortPaths(["Bank", "apple"])).toEqual(["Bank", "apple"]);
  });
  test("isInFolder", () => {
    expect(isInFolder("work/x", "work")).toBe(true);
    expect(isInFolder("workshop/x", "work")).toBe(false);
    expect(isInFolder("work", "work")).toBe(false);
    expect(isInFolder("work/a/b", "work/a")).toBe(true);
    expect(isInFolder("x", "")).toBe(true);
  });
  test("helpers", () => {
    expect(foldersOf("a/b/c")).toEqual(["a", "a/b"]);
    expect(foldersOf("c")).toEqual([]);
    expect(parentFolder("a/b/c")).toBe("a/b");
    expect(parentFolder("c")).toBe("");
    expect(baseName("a/b/c")).toBe("c");
    expect(allFolders(["work/x", "work-old/y", "work/a/b"])).toEqual(["work", "work/a", "work-old"]);
    expect(folderExists(["work/x"], "work")).toBe(true);
    expect(folderExists(["work"], "work")).toBe(false);
    expect(countInFolder(["work/x", "work/a/b", "work"], "work")).toBe(2);
  });
  test("moveDestination (cli.md §2.10)", () => {
    expect(moveDestination("work/x", "archive/")).toBe("archive/x");
    expect(moveDestination("work", "archive/")).toBe("archive/work");
    expect(moveDestination("work/x", "bank")).toBe("bank");
    expect(errOf(() => moveDestination("x", "a//")).message).toBe("invalid path: it has an empty segment (//)");
    expect(errOf(() => moveDestination("x", "/")).message).toBe("invalid path: it starts with /");
  });
});

describe("tree (cli.md §2.3)", () => {
  const paths = ["work", "work/github", "work/a b'c", "bank/My Bank", "x/y"];
  test("ls tree", () => {
    const lines = renderTree(buildTree(paths));
    expect(lines).toEqual(["├── bank/", "│   └── My Bank", "├── work/", "│   ├── a b'c", "│   └── github", "├── work", "└── x/", "    └── y"]);
  });
  test("below a folder", () => {
    expect(renderTree(buildTree(paths, "work"))).toEqual(["├── a b'c", "└── github"]);
    expect(renderTree(buildTree(["a/b/c", "a/b/d", "a/e"], "a"))).toEqual(["├── b/", "│   ├── c", "│   └── d", "└── e"]);
  });
  test("byte order of names", () => {
    expect(renderTree(buildTree(["homelab", "My Bank"]))).toEqual(["├── My Bank", "└── homelab"]);
  });
  test("TUI: folders first", () => {
    const t = buildTree(["z", "a/x", "b", "c/y"], "", { foldersFirst: true });
    expect(t.map((n) => n.name + (n.folder ? "/" : ""))).toEqual(["a/", "c/", "b", "z"]);
  });
  test("escape callback", () => {
    expect(renderTree(buildTree(["a​b"]), (s) => s.replace("​", "\\u200b"))).toEqual(["└── a\\u200bb"]);
  });
});

describe("listEntries (cli.md §2.3)", () => {
  const entries = [
    { path: "work", tags: ["2fa"] },
    { path: "work/github", tags: ["work", "2fa"] },
    { path: "work/x", tags: [] },
    { path: "bank/a", tags: ["2fa"] },
  ];
  test("tree, empty, entry, no such folder", () => {
    const t = listEntries(entries, undefined, ["2fa"]);
    expect(t.kind === "tree" && renderTree(t.nodes)).toEqual(["├── bank/", "│   └── a", "├── work/", "│   └── github", "└── work"]);
    expect(listEntries(entries, undefined, ["none"])).toEqual({ kind: "empty" });
    expect(listEntries(entries, "work", ["none"])).toEqual({ kind: "empty" });
    expect(listEntries(entries, "work/github", [])).toEqual({ kind: "entry", path: "work/github" });
    expect(listEntries([{ path: "work", tags: ["2fa"] }, { path: "work/x", tags: [] }], "work", ["2fa"])).toEqual({ kind: "entry", path: "work" });
    expect(errOf(() => listEntries(entries, "work/github", ["x"])).message).toBe("work/github: no such folder");
    expect(errOf(() => listEntries(entries, "nosuch")).message).toBe("nosuch: no such folder");
    expect(hasCode(errOf(() => listEntries(entries, "nosuch")), "no-such-folder")).toBe(true);
  });
});

describe("tags (§4.3, cli.md §1.8)", () => {
  test("normalizeTag", () => {
    expect(normalizeTag("  work ")).toBe("work");
    expect(normalizeTag("é")).toBe("é");
    expect(normalizeTag("a\u0085")).toBe("a");
    expect(normalizeTag(" x　")).toBe("x");
    expect(isValidTag("Work")).toBe(true);
    expect(isValidTag(" x")).toBe(false);
  });
  const bad: Array<[string | Uint8Array, string]> = [
    ["", "invalid tag: a tag can't be empty"],
    ["  ", "invalid tag: a tag can't be empty"],
    [" a,b ", 'invalid tag "a,b": it contains a comma'],
    [" a\tb ", 'invalid tag "a\\tb": it contains a control character'],
    ["a\u0080", 'invalid tag "a\\u0080": it contains a control character'],
    [new Uint8Array([0x61, 0xff]), 'invalid tag "a\\xff": not valid UTF-8'],
  ];
  for (const [t, msg] of bad) {
    test(msg, () => {
      const e = errOf(() => normalizeTag(t));
      expect(e.message).toBe(msg);
      expect(hasCode(e, "invalid-tag")).toBe(true);
    });
  }
  test("parseTagList", () => {
    expect(parseTagList("a, , b, a")).toEqual(["a", "b"]);
    expect(parseTagList("")).toEqual([]);
    expect(parseTagList(" ,  ,")).toEqual([]);
    expect(parseTagList("Work, work")).toEqual(["Work", "work"]);
    expect(errOf(() => parseTagList("a, b\tc")).message).toBe('invalid tag "b\\tc": it contains a control character');
    expect(errOf(() => parseTagList(new Uint8Array([0x61, 0x2c, 0x62, 0xff]))).message).toBe('invalid tag "b\\xff": not valid UTF-8');
    expect(parseTagList(new TextEncoder().encode("x, y"))).toEqual(["x", "y"]);
  });
  test("dedupe, AND, counts", () => {
    expect(dedupeTags(["a", "b", "a"])).toEqual(["a", "b"]);
    expect(hasAllTags(["a", "b"], ["b", "a"])).toBe(true);
    expect(hasAllTags(["a"], ["a", "b"])).toBe(false);
    expect(hasAllTags(["a"], [])).toBe(true);
    expect(countTags([{ tags: ["work", "2fa"] }, { tags: ["work"] }, { tags: ["bank", "Zed"] }])).toEqual([
      { tag: "2fa", count: 1 },
      { tag: "Zed", count: 1 },
      { tag: "bank", count: 1 },
      { tag: "work", count: 2 },
    ]);
  });
});
