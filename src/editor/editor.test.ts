import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getuid } from "../ffi/libc.ts";
import { hasCode } from "../i18n/index.ts";
import { chooseEditor, detectKind, editorArgv, editorFlags, findTmpBase, kindOfName, leftoverEditFolders, onMemoryFs, removeEditFolder } from "./index.ts";

const ROOT = join(import.meta.dir, "../..");
mkdirSync(join(ROOT, "tmp"), { recursive: true });
const DIR = mkdtempSync(join(ROOT, "tmp", "editor-"));
const SHM = existsSync("/dev/shm") && onMemoryFs("/dev/shm") ? mkdtempSync("/dev/shm/passh-ts-editor-test-") : null;
afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  if (SHM) rmSync(SHM, { recursive: true, force: true });
});

function exe(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  chmodSync(p, 0o755);
  return p;
}

describe("editor kind and flags (agent-session.md §A6)", () => {
  test("names", () => {
    expect(kindOfName("vim")).toBe("vim");
    expect(kindOfName("vim.basic")).toBe("vim");
    expect(kindOfName("vim.gtk3")).toBe("vim");
    expect(kindOfName("nvim")).toBe("neovim");
    expect(kindOfName("nvim.appimage")).toBe("neovim");
    expect(kindOfName("nano")).toBe("nano");
    expect(kindOfName("vi")).toBeUndefined();
    expect(kindOfName("busybox")).toBeUndefined();
    expect(kindOfName("gvim")).toBeUndefined();
    expect(kindOfName("nano.real")).toBeUndefined();
  });

  test("symlink target, then resolved path, then word", () => {
    const bin = join(DIR, "kind");
    const real = exe(bin, "vim.basic");
    symlinkSync(real, join(bin, "vi"));
    expect(detectKind(join(bin, "vi"), "vi")).toBe("vim");
    const bb = exe(bin, "busybox");
    symlinkSync(bb, join(bin, "vi2"));
    expect(detectKind(join(bin, "vi2"), "vi2")).toBe("other");
    const other = exe(bin, "fakeed");
    symlinkSync(other, join(bin, "nvim"));
    expect(detectKind(join(bin, "nvim"), "nvim")).toBe("neovim");
    expect(detectKind(other, "nano")).toBe("nano");
  });

  test("argv", () => {
    const vim = { source: "$EDITOR" as const, words: ["vim", "-X"], path: "/usr/bin/vim", kind: "vim" as const, name: "vim" };
    expect(editorArgv(vim, "/run/x/entry.txt")).toEqual(["/usr/bin/vim", "-X", "-n", "-u", "NONE", "-i", "NONE", "-c", "set nobackup nowritebackup noundofile noswapfile", "--", "/run/x/entry.txt"]);
    expect(editorFlags("neovim")).toEqual(["-n", "--clean", "-i", "NONE", "-c", "set nobackup nowritebackup noundofile noswapfile"]);
    expect(editorFlags("nano")).toEqual(["--ignorercfiles", "--nohelp"]);
    const code = { source: "$EDITOR" as const, words: ["code", "--wait"], path: "/usr/bin/code", kind: "other" as const, name: "code" };
    expect(editorArgv(code, "/f")).toEqual(["/usr/bin/code", "--wait", "/f"]);
  });
});

describe("chooseEditor", () => {
  const bin = join(DIR, "choose");
  const fake = exe(bin, "fakeed");
  const PATH = bin;
  test("$EDITOR, then $VISUAL, then vi", () => {
    expect(chooseEditor({ PATH, EDITOR: "fakeed --x 'a b'" })).toEqual({ source: "$EDITOR", words: ["fakeed", "--x", "a b"], path: fake, kind: "other", name: "fakeed" });
    expect(chooseEditor({ PATH, EDITOR: " \t\n", VISUAL: "fakeed" }).source).toBe("$VISUAL");
    expect(chooseEditor({ PATH, EDITOR: "", VISUAL: "fake\\ed" }).words).toEqual(["fakeed"]);
    exe(bin, "vi");
    expect(chooseEditor({ PATH }).source).toBe("vi");
  });
  test("errors", () => {
    expect(() => chooseEditor({ PATH, EDITOR: "'abc" })).toThrow(`$EDITOR: unterminated single quote in "'abc"`);
    expect(() => chooseEditor({ PATH, VISUAL: '"abc' })).toThrow(`$VISUAL: unterminated double quote in "\\"abc"`);
    expect(() => chooseEditor({ PATH, EDITOR: "abc\\" })).toThrow(`$EDITOR: trailing backslash in "abc\\\\"`);
    expect(() => chooseEditor({ PATH, EDITOR: '""' })).toThrow("$EDITOR: the editor command is empty");
    expect(() => chooseEditor({ PATH, EDITOR: '"" fakeed' })).toThrow("$EDITOR: the editor command is empty");
    expect(() => chooseEditor({ PATH, EDITOR: "nope" })).toThrow('$EDITOR: exec: exec: "nope": executable file not found in $PATH');
    expect(() => chooseEditor({ PATH: "/nonexistent" })).toThrow(/^exec: exec: "vi": executable file not found in \$PATH$/);
  });
});

describe.if(process.platform === "linux")("tmpfs base", () => {
  test("$XDG_RUNTIME_DIR on tmpfs, else /dev/shm, else the reason", () => {
    if (!SHM) return;
    const xdg = join(SHM, "run");
    mkdirSync(xdg, { mode: 0o700 });
    expect(findTmpBase({ XDG_RUNTIME_DIR: xdg })).toEqual({ ok: true, base: xdg });
    // a disk folder, a symlink, a relative path: /dev/shm instead
    expect(findTmpBase({ XDG_RUNTIME_DIR: DIR })).toEqual({ ok: true, base: "/dev/shm" });
    symlinkSync(xdg, join(SHM, "link"));
    expect(findTmpBase({ XDG_RUNTIME_DIR: join(SHM, "link") })).toEqual({ ok: true, base: "/dev/shm" });
    expect(findTmpBase({ XDG_RUNTIME_DIR: "rel/dir" })).toEqual({ ok: true, base: "/dev/shm" });
    expect(findTmpBase({})).toEqual({ ok: true, base: "/dev/shm" });
  });

  test("leftover folders", () => {
    if (!SHM) return;
    const xdg = join(SHM, "run2");
    mkdirSync(join(xdg, "passh-edit-123"), { recursive: true });
    mkdirSync(join(xdg, "other"));
    writeFileSync(join(xdg, "passh-edit-file"), "x");
    const found = leftoverEditFolders({ XDG_RUNTIME_DIR: xdg });
    expect(found[0]).toBe(join(xdg, "passh-edit-123"));
    expect(found).not.toContain(join(xdg, "passh-edit-file"));
    expect(found.every((p) => p.startsWith(xdg) || p.startsWith("/dev/shm/passh-edit-"))).toBe(true);
    expect(getuid()).toBeGreaterThanOrEqual(0);
  });

  test("cleanup overwrites every file with zeros before removing the folder", () => {
    if (!SHM) return;
    const dir = join(SHM, "passh-edit-999");
    mkdirSync(join(dir, "sub"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "entry.txt"), "secret text");
    writeFileSync(join(dir, "sub", ".entry.txt.swp"), "swap");
    // hard links outside the folder show what was left in the files' blocks
    linkSync(join(dir, "entry.txt"), join(SHM, "witness1"));
    linkSync(join(dir, "sub", ".entry.txt.swp"), join(SHM, "witness2"));
    removeEditFolder(dir);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(SHM, "witness1"))).toEqual(Buffer.alloc(11));
    expect(readFileSync(join(SHM, "witness2"))).toEqual(Buffer.alloc(4));
  });

  test("cleanup failure text", () => {
    let e: unknown;
    try {
      removeEditFolder(join(DIR, "missing-folder"));
    } catch (x) {
      e = x;
    }
    expect((e as Error).message).toMatch(/^removing the temporary folder (.*)missing-folder: open \1missing-folder: no such file or directory; remove it yourself, it holds the entry in plain text$/);
    expect(hasCode(e, "nope")).toBe(false);
  });
});
