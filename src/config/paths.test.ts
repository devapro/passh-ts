import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { hasCode } from "../i18n/index.ts";
import { cleanPath, configDir, currentDir, dataDir, defaultConfigFile, defaultVaultFile, expandPath, h16, h32, homeDir, realPath, stateDir, tildePath } from "./paths.ts";

const ROOT = join(import.meta.dir, "../..");
let dir: string; // real (symlink-free) test folder
beforeAll(() => {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  dir = realpathSync(mkdtempSync(join(ROOT, "tmp", "paths-")));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const err = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e as Error;
  }
  throw new Error("no error");
};

describe("cleanPath", () => {
  test("Go's path.Clean", () => {
    const cases: Array<[string, string]> = [
      ["", "."],
      ["/", "/"],
      ["//a//b/", "/a/b"],
      ["/a/./b/../c", "/a/c"],
      ["/..", "/"],
      ["/../a", "/a"],
      ["a/../..", ".."],
      ["../../x", "../../x"],
      ["a/b/../../..", ".."],
      ["./", "."],
    ];
    for (const [i, o] of cases) expect(cleanPath(i)).toBe(o);
  });
});

describe("base folders (storage.md §1.1)", () => {
  test("XDG and $HOME", () => {
    const env = { HOME: "/home/a/" };
    expect(homeDir(env)).toBe("/home/a");
    expect(configDir(env)).toBe("/home/a/.config/passh");
    expect(dataDir(env)).toBe("/home/a/.local/share/passh");
    expect(stateDir(env)).toBe("/home/a/.local/state/passh");
    expect(defaultConfigFile(env)).toBe("/home/a/.config/passh/config.toml");
    expect(defaultVaultFile(env)).toBe("/home/a/.local/share/passh/vault.passh");
    const xdg = { XDG_CONFIG_HOME: "/x/c", XDG_DATA_HOME: "/x/d/", XDG_STATE_HOME: "/x/s" };
    expect(configDir(xdg)).toBe("/x/c/passh");
    expect(dataDir(xdg)).toBe("/x/d/passh");
    expect(stateDir(xdg)).toBe("/x/s/passh");
    // empty or relative XDG values are ignored
    expect(stateDir({ ...env, XDG_STATE_HOME: "" })).toBe("/home/a/.local/state/passh");
    expect(stateDir({ ...env, XDG_STATE_HOME: "rel" })).toBe("/home/a/.local/state/passh");
  });
  test("$HOME errors", () => {
    expect(err(() => homeDir({})).message).toBe("$HOME is not set");
    expect(err(() => homeDir({ HOME: "" })).message).toBe("$HOME is not set");
    expect(err(() => homeDir({ HOME: "rel" })).message).toBe('$HOME ("rel") is not an absolute path');
    expect(hasCode(err(() => stateDir({})), "home")).toBe(true);
  });
});

describe("expandPath (storage.md §2.1)", () => {
  const env = { HOME: "/home/a" };
  test("forms", () => {
    expect(expandPath("~", { env })).toBe("/home/a");
    expect(expandPath("~/", { env })).toBe("/home/a");
    expect(expandPath("~/x/../y", { env })).toBe("/home/a/y");
    expect(expandPath("~bob/x", { env, cwd: "/w" })).toBe("/w/~bob/x");
    expect(expandPath("a//b/./c/..", { env, cwd: "/w/d" })).toBe("/w/d/a/b");
    expect(expandPath("/abs//x/", { env })).toBe("/abs/x");
    expect(err(() => expandPath("~/x", { env: {} })).message).toBe("$HOME is not set");
    expect(expandPath("/abs", { env: {} })).toBe("/abs");
  });
  test("current folder: $PWD when it names it", () => {
    const cwd = process.cwd();
    expect(currentDir({ PWD: cwd })).toBe(cwd);
    expect(currentDir({ PWD: "/" })).toBe(cwd); // not the current folder
    expect(currentDir({ PWD: "relative" })).toBe(cwd);
    expect(currentDir({})).toBe(cwd);
  });
});

describe("tildePath", () => {
  test("a leading $HOME/ as ~/", () => {
    const env = { HOME: "/home/a" };
    expect(tildePath("/home/a/v.passh", env)).toBe("~/v.passh");
    expect(tildePath("/home/a", env)).toBe("/home/a");
    expect(tildePath("/home/ab/v", env)).toBe("/home/ab/v");
    expect(tildePath("/x/v", env)).toBe("/x/v");
    expect(tildePath("/home/a/v", { HOME: "/home/a/" })).toBe("~/v");
    expect(tildePath("/v.passh", { HOME: "/" })).toBe("/v.passh");
    expect(tildePath("/home/a/v", {})).toBe("/home/a/v");
    expect(tildePath("/home/a/v", { HOME: "home/a" })).toBe("/home/a/v");
  });
});

describe("realPath (storage.md §0)", () => {
  test("no symlink: the clean absolute path byte for byte", () => {
    const f = join(dir, "plain.passh");
    writeFileSync(f, "");
    expect(realPath(f)).toBe(f);
    expect(realPath(dir + "//./plain.passh")).toBe(f);
    expect(realPath("plain.passh", { cwd: dir })).toBe(f);
  });
  test("lexical .. before symlinks", () => {
    const base = join(dir, "lex");
    mkdirSync(join(base, "a", "deep", "er"), { recursive: true });
    mkdirSync(join(base, "b"));
    writeFileSync(join(base, "b", "v"), "");
    writeFileSync(join(base, "a", "deep", "v"), "");
    symlinkSync(join(base, "a", "deep", "er"), join(base, "a", "link"));
    // /a/link/../b → /a/b lexically, not er/../b
    mkdirSync(join(base, "a", "b"));
    writeFileSync(join(base, "a", "b", "v"), "");
    expect(realPath(join(base, "a", "link") + "/../b/v")).toBe(join(base, "a", "b", "v"));
  });
  test("absolute and relative targets, chains", () => {
    const base = join(dir, "links");
    mkdirSync(join(base, "real", "sub"), { recursive: true });
    writeFileSync(join(base, "real", "sub", "v.passh"), "");
    symlinkSync(join(base, "real"), join(base, "abs")); // absolute target
    symlinkSync("real/sub", join(base, "rel")); // relative target
    symlinkSync("rel", join(base, "chain")); // a link to a link
    symlinkSync("sub/v.passh", join(base, "real", "file-link")); // a file link
    expect(realPath(join(base, "abs", "sub", "v.passh"))).toBe(join(base, "real", "sub", "v.passh"));
    expect(realPath(join(base, "rel", "v.passh"))).toBe(join(base, "real", "sub", "v.passh"));
    expect(realPath(join(base, "chain", "v.passh"))).toBe(join(base, "real", "sub", "v.passh"));
    expect(realPath(join(base, "abs", "file-link"))).toBe(join(base, "real", "sub", "v.passh"));
  });
  test(".. inside a link target goes back from the resolved path", () => {
    const base = join(dir, "dotdot");
    mkdirSync(join(base, "x", "y"), { recursive: true });
    mkdirSync(join(base, "z"));
    writeFileSync(join(base, "z", "v"), "");
    // x/y/up -> ../../z : resolved against x/y, so it reaches base/z
    symlinkSync("../../z", join(base, "x", "y", "up"));
    expect(realPath(join(base, "x", "y", "up", "v"))).toBe(join(base, "z", "v"));
    // a link whose target goes through another link, then "..": back from that link's
    // resolved target (x/y → x), not lexically (yy/.. → base)
    symlinkSync(join(base, "x", "y"), join(base, "yy"));
    symlinkSync("yy/../z", join(base, "w"));
    mkdirSync(join(base, "x", "z"));
    writeFileSync(join(base, "x", "z", "v"), "");
    expect(realPath(join(base, "w", "v"))).toBe(join(base, "x", "z", "v"));
  });
  test("errors: missing component, a file as a folder, loops", () => {
    const base = join(dir, "errs");
    mkdirSync(base);
    writeFileSync(join(base, "f"), "");
    expect(err(() => realPath(join(base, "missing", "v"))).message).toBe(`lstat ${join(base, "missing")}: no such file or directory`);
    expect(err(() => realPath(join(base, "missing"))).message).toBe(`lstat ${join(base, "missing")}: no such file or directory`);
    expect(err(() => realPath(join(base, "f", "v"))).message).toBe("not a directory");
    symlinkSync("loop2", join(base, "loop1"));
    symlinkSync("loop1", join(base, "loop2"));
    expect(err(() => realPath(join(base, "loop1"))).message).toBe("EvalSymlinks: too many links");
    symlinkSync(join(base, "nowhere"), join(base, "dangling"));
    expect(err(() => realPath(join(base, "dangling"))).message).toBe(`lstat ${join(base, "nowhere")}: no such file or directory`);
  });
  test("255 links are fine, 256 are not", () => {
    const base = join(dir, "many");
    mkdirSync(base);
    writeFileSync(join(base, "target"), "");
    let prev = "target";
    for (let i = 1; i <= 256; i++) {
      symlinkSync(prev, join(base, `l${i}`));
      prev = `l${i}`;
    }
    expect(realPath(join(base, "l255"))).toBe(join(base, "target"));
    expect(err(() => realPath(join(base, "l256"))).message).toBe("EvalSymlinks: too many links");
  });
  test("no Unicode normalization", () => {
    const base = join(dir, "uni");
    mkdirSync(base);
    const nfc = "café";
    writeFileSync(join(base, nfc), "");
    expect(realPath(join(base, nfc))).toBe(join(base, nfc));
  });
});

describe("hashes", () => {
  test("h32 and h16 of the bytes", () => {
    // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(h32("abc")).toBe("ba7816bf8f01cfea414140de5dae2223");
    expect(h16("abc")).toBe("ba7816bf8f01cfea");
    expect(h32(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223");
    expect(h16("é")).toBe(h16(new Uint8Array([0xc3, 0xa9])));
  });
});
