import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, closeSync } from "node:fs";
import { join } from "node:path";
import { hasCode } from "../i18n/index.ts";
import { ERRNO } from "../ffi/libc.ts";
import {
  acquireLock,
  cleanLeftovers,
  createTempFile,
  Errno,
  errnoText,
  exchange,
  fsyncDir,
  isErrno,
  mkdirP,
  mkdirs,
  osError,
  osErrorText,
  readFileLimited,
  readRegularFile,
  renameNoReplace,
  tempTestHooks,
  tryAcquireLock,
  tryFlock,
  writeNewFile,
  writeTempFile,
  MAX_VAULT_SIZE,
  OSError,
} from "./index.ts";

const ROOT = join(import.meta.dir, "../..");
const HOLD = join(import.meta.dir, "testdata/hold.ts");
let dir: string;

beforeAll(() => {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  dir = mkdtempSync(join(ROOT, "tmp", "fsx-"));
});
afterAll(() => {
  try {
    chmodSync(dir, 0o700);
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function sub(name: string): string {
  const p = join(dir, name);
  mkdirSync(p, { recursive: true });
  return p;
}

function withUmask<T>(mask: number, fn: () => T): T {
  const old = process.umask(mask);
  try {
    return fn();
  } finally {
    process.umask(old);
  }
}

const isRoot = process.getuid?.() === 0;

/** Starts hold.ts in another process; resolves once it holds the lock or temp file. */
async function hold(args: string[]): Promise<{ line: string; release(): Promise<void> }> {
  const p = Bun.spawn([process.execPath, "run", HOLD, ...args], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = p.stdout.getReader();
  let buf = "";
  while (!buf.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("holder exited: " + buf);
    buf += new TextDecoder().decode(value);
  }
  return {
    line: buf.trim(),
    async release() {
      p.stdin.end();
      await p.exited;
    },
  };
}

describe("oserror", () => {
  test("Go texts", () => {
    expect(errnoText("ENOENT")).toBe("no such file or directory");
    expect(errnoText("EACCES")).toBe("permission denied");
    expect(errnoText("ELOOP")).toBe("too many levels of symbolic links");
    expect(new Errno("EPERM").message).toBe("operation not permitted");
  });
  test("osError from node errors", () => {
    let err: unknown;
    try {
      openSync(join(dir, "nope", "x"), "r");
    } catch (e) {
      err = e;
    }
    const e = osError("open", "/x/nope/x", err);
    expect(e).toBeInstanceOf(OSError);
    expect(e.message).toBe("open /x/nope/x: no such file or directory");
    expect(e.code).toBe("ENOENT");
    expect(isErrno(e, "ENOENT")).toBe(true);
    expect(osErrorText("stat", "/home/alice/v.passh", { code: "ENOENT" })).toBe("stat /home/alice/v.passh: no such file or directory");
    expect(osError("rename", "/a", "EEXIST", "/b").message).toBe("rename /a /b: file exists");
    expect(osError("open", "/a", ERRNO.EACCES).message).toBe("open /a: permission denied");
  });
  test("aliases", () => {
    expect(isErrno(new Errno("EAGAIN"), "EWOULDBLOCK")).toBe(true);
    expect(isErrno(new Errno("EOPNOTSUPP"), "ENOTSUP")).toBe(process.platform === "linux");
  });
});

describe("mkdirs", () => {
  test("creates every missing folder with mode 0700 whatever the umask", () => {
    for (const mask of [0o022, 0o077, 0o002, 0o000, 0o277]) {
      const base = sub(`mk-${mask.toString(8)}`);
      const d = join(base, "a", "b", "c");
      withUmask(mask, () => mkdirs(d));
      for (const p of [join(base, "a"), join(base, "a", "b"), d]) expect(statSync(p).mode & 0o7777).toBe(0o700);
    }
  });
  test("existing folders are not changed, symlinks to folders followed", () => {
    const base = sub("mk-exist");
    const a = join(base, "a");
    mkdirSync(a);
    chmodSync(a, 0o755);
    symlinkSync(a, join(base, "link"));
    mkdirs(join(base, "link", "b"));
    expect(statSync(a).mode & 0o7777).toBe(0o755);
    expect(statSync(join(a, "b")).mode & 0o7777).toBe(0o700);
    mkdirs(join(base, "link", "b")); // again: nothing to do
  });
  test("a component that isn't a folder", () => {
    const base = sub("mk-file");
    writeFileSync(join(base, "f"), "");
    let err: unknown;
    try {
      mkdirs(join(base, "f", "x"));
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toBe(`${join(base, "f")} is not a folder`);
    expect(hasCode(err, "not-folder")).toBe(true);
  });
});

describe("mkdirP", () => {
  test("mode reduced by the umask", () => {
    const base = sub("mkp");
    withUmask(0o027, () => mkdirP(join(base, "x", "y"), 0o777));
    expect(statSync(join(base, "x")).mode & 0o777).toBe(0o750);
    expect(statSync(join(base, "x", "y")).mode & 0o777).toBe(0o750);
    withUmask(0o022, () => mkdirP(join(base, "z"), 0o700));
    expect(statSync(join(base, "z")).mode & 0o777).toBe(0o700);
  });
  test("a file in the way", () => {
    const base = sub("mkp-file");
    writeFileSync(join(base, "f"), "");
    expect(() => mkdirP(join(base, "f", "x"))).toThrow(`mkdir ${join(base, "f")}: not a directory`);
  });
});

describe("fsyncDir", () => {
  test("a folder", () => {
    fsyncDir(sub("fs"));
  });
  test("a missing folder", () => {
    const p = join(dir, "missing-dir");
    expect(() => fsyncDir(p)).toThrow(`open ${p}: no such file or directory`);
  });
});

describe("readRegularFile", () => {
  test("reads, follows symlinks", () => {
    const base = sub("rr");
    writeFileSync(join(base, "f"), "hello");
    symlinkSync(join(base, "f"), join(base, "l"));
    expect(new TextDecoder().decode(readRegularFile(join(base, "l"), 64))).toBe("hello");
  });
  test("limits", () => {
    const base = sub("rr-lim");
    writeFileSync(join(base, "f"), "0123456789");
    expect(readRegularFile(join(base, "f"), 10).length).toBe(10);
    let err: unknown;
    try {
      readRegularFile(join(base, "f"), 9);
    } catch (e) {
      err = e;
    }
    expect(hasCode(err, "too-large")).toBe(true);
    expect((err as Error).message).toBe("the file is larger than 9 bytes");
    expect(MAX_VAULT_SIZE).toBe(67108864);
  });
  test("not a regular file", () => {
    const base = sub("rr-dir");
    const fifo = join(base, "fifo");
    Bun.spawnSync(["mkfifo", fifo]);
    for (const p of [base, fifo]) {
      let err: unknown;
      try {
        readRegularFile(p);
      } catch (e) {
        err = e;
      }
      expect(hasCode(err, "not-regular")).toBe(true);
      expect((err as Error).message).toBe("not a regular file");
    }
  });
  test("missing and unreadable", () => {
    const base = sub("rr-err");
    expect(() => readRegularFile(join(base, "x"))).toThrow(`stat ${join(base, "x")}: no such file or directory`);
    if (!isRoot) {
      writeFileSync(join(base, "u"), "x");
      chmodSync(join(base, "u"), 0);
      expect(() => readRegularFile(join(base, "u"))).toThrow(`open ${join(base, "u")}: permission denied`);
    }
  });
});

describe("readFileLimited", () => {
  test("a folder, limits", () => {
    const base = sub("rl");
    expect(() => readFileLimited(base, 100)).toThrow(`read ${base}: is a directory`);
    writeFileSync(join(base, "f"), "x".repeat(1024));
    expect(readFileLimited(join(base, "f"), 1024).length).toBe(1024);
    expect(() => readFileLimited(join(base, "f"), 1023)).toThrow("the file is larger than 1023 bytes");
  });
});

describe("writeNewFile", () => {
  test("creates 0600, never replaces", () => {
    const base = sub("wn");
    const p = join(base, "c.toml");
    withUmask(0o022, () => writeNewFile(p, new TextEncoder().encode("x\n")));
    expect(readFileSync(p, "utf8")).toBe("x\n");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(() => writeNewFile(p, new Uint8Array(1))).toThrow(`open ${p}: file exists`);
    symlinkSync(join(base, "target"), join(base, "dangling"));
    expect(() => writeNewFile(join(base, "dangling"), new Uint8Array(1))).toThrow("file exists");
    expect(existsSync(join(base, "target"))).toBe(false);
  });
});

describe("lock files", () => {
  test("acquire, exclude, release; the file stays, mode 0600", async () => {
    const base = sub("lk");
    const p = join(base, "vault-x.lock");
    const l = await withUmask(0o000, () => acquireLock(p));
    expect(statSync(p).mode & 0o777).toBe(0o600);
    // Locks are per open file: a second open in the same process is excluded too.
    expect(tryAcquireLock(p)).toBeUndefined();
    const t0 = Date.now();
    let err: unknown;
    try {
      await acquireLock(p, { timeoutMs: 150 });
    } catch (e) {
      err = e;
    }
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(hasCode(err, "lock-busy")).toBe(true);
    expect((err as Error).message).toBe(`another passh process has held ${p} for 150ms`);
    l.release();
    l.release();
    const l2 = await acquireLock(p, { timeoutMs: 100 });
    l2.release();
    expect(existsSync(p)).toBe(true);
  });
  test("cancellation", async () => {
    const p = join(sub("lk-c"), "x.lock");
    const l = await acquireLock(p);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expect(acquireLock(p, { signal: ac.signal })).rejects.toThrow("stopped waiting for another passh process: context canceled");
    const ac2 = new AbortController();
    ac2.abort(new Error("the TUI was locked"));
    let err: unknown;
    try {
      await acquireLock(p, { signal: ac2.signal });
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toBe("stopped waiting for another passh process: the TUI was locked");
    expect(hasCode(err, "lock-cancelled")).toBe(true);
    l.release();
  });
  test("contention with another process", async () => {
    const p = join(sub("lk-p"), "revisions.lock");
    const h = await hold(["lock", p]);
    expect(h.line).toBe("ready");
    await expect(acquireLock(p, { timeoutMs: 100 })).rejects.toThrow("another passh process has held");
    // The holder exits while we wait: we get the lock.
    const waiting = acquireLock(p, { timeoutMs: 10_000 });
    setTimeout(() => void h.release(), 100);
    const l = await waiting;
    expect(l.held).toBe(true);
    l.release();
  });
  test("open errors", async () => {
    const base = sub("lk-e");
    await expect(acquireLock(join(base, "no", "x.lock"))).rejects.toThrow(`open ${join(base, "no", "x.lock")}: no such file or directory`);
    symlinkSync(join(base, "elsewhere"), join(base, "l.lock"));
    await expect(acquireLock(join(base, "l.lock"))).rejects.toThrow(`open ${join(base, "l.lock")}: too many levels of symbolic links`);
    expect(existsSync(join(base, "elsewhere"))).toBe(false);
  });
});

describe("temporary files", () => {
  test("name, mode, lock, write", () => {
    const base = sub("tmpf");
    const t = withUmask(0o000, () => createTempFile(base, "vault.passh"));
    expect(t.path.startsWith(join(base, ".vault.passh.tmp-"))).toBe(true);
    expect(/^\.vault\.passh\.tmp-(0|[1-9][0-9]*)$/.test(t.path.slice(base.length + 1))).toBe(true);
    expect(statSync(t.path).mode & 0o777).toBe(0o600);
    // Held under flock: another open file can't lock it.
    const fd = openSync(t.path, "r");
    expect(tryFlock(fd, t.path)).toBe(false);
    closeSync(fd);
    t.write(new TextEncoder().encode("data"));
    expect(readFileSync(t.path, "utf8")).toBe("data");
    t.remove();
    expect(existsSync(t.path)).toBe(false);
    const t2 = writeTempFile(base, "backup", new TextEncoder().encode("b"));
    expect(readFileSync(t2.path, "utf8")).toBe("b");
    t2.closeChecked();
    // Unlocked now.
    const fd2 = openSync(t2.path, "r");
    expect(tryFlock(fd2, t2.path)).toBe(true);
    closeSync(fd2);
  });
  test("a file removed before it was locked: start again; the third time fails", () => {
    const base = sub("tmp-gone");
    let n = 0;
    tempTestHooks.afterCreate = (p) => {
      if (n++ < 2) unlinkSync(p);
    };
    try {
      const t = createTempFile(base, "v");
      expect(n).toBe(3);
      t.remove();
      n = -10;
      let err: unknown;
      try {
        createTempFile(base, "v");
      } catch (e) {
        err = e;
      }
      expect((err as Error).message).toBe("temporary files keep disappearing");
      expect(hasCode(err, "temp-disappearing")).toBe(true);
    } finally {
      tempTestHooks.afterCreate = undefined;
    }
    expect(readdirSync(base)).toEqual([]);
  });
  test("cleanLeftovers removes leftovers, skips writes in progress and other files", async () => {
    const base = sub("clean");
    for (const n of [".v.passh.tmp-123", ".v.passh.tmp-", ".v.passh.tmp-abc", ".other.tmp-1", "v.passh", ".v.passh.tmp"]) writeFileSync(join(base, n), "x");
    symlinkSync(join(base, "v.passh"), join(base, ".v.passh.tmp-link"));
    mkdirSync(join(base, ".v.passh.tmp-dir"));
    const mine = createTempFile(base, "v.passh");
    const other = await hold(["temp", base, "v.passh"]);
    const removed = cleanLeftovers(base, "v.passh").sort();
    expect(removed).toEqual([".v.passh.tmp-", ".v.passh.tmp-123", ".v.passh.tmp-abc"]);
    const left = readdirSync(base).sort();
    expect(left).toContain(mine.path.slice(base.length + 1));
    expect(left).toContain(other.line.slice(base.length + 1));
    for (const n of [".other.tmp-1", "v.passh", ".v.passh.tmp", ".v.passh.tmp-link", ".v.passh.tmp-dir"]) expect(left).toContain(n);
    await other.release();
    mine.close();
    // Now both are leftovers.
    expect(cleanLeftovers(base, "v.passh").length).toBe(2);
    expect(lstatSync(join(base, ".v.passh.tmp-link")).isSymbolicLink()).toBe(true);
  });
});

describe("renames", () => {
  test("exchange", () => {
    const base = sub("xchg");
    writeFileSync(join(base, "a"), "A");
    writeFileSync(join(base, "b"), "B");
    expect(exchange(join(base, "a"), join(base, "b"))).toBe("exchanged");
    expect(readFileSync(join(base, "a"), "utf8")).toBe("B");
    expect(readFileSync(join(base, "b"), "utf8")).toBe("A");
    let err: unknown;
    try {
      exchange(join(base, "a"), join(base, "missing"));
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toBe(`rename ${join(base, "a")} ${join(base, "missing")}: no such file or directory`);
    expect(isErrno(err, "ENOENT")).toBe(true);
    expect(exchange("x", "y", { sys: () => ERRNO.EINVAL! })).toBe("unsupported");
    expect(exchange("x", "y", { sys: () => ERRNO.ENOSYS! })).toBe("unsupported");
    expect(() => exchange("x", "y", { sys: () => ERRNO.EACCES! })).toThrow("rename x y: permission denied");
  });
  test("rename-no-replace", () => {
    const base = sub("nr");
    const a = join(base, "a");
    const b = join(base, "b");
    writeFileSync(a, "A");
    expect(renameNoReplace(a, b).method).toBe("noreplace");
    expect(readFileSync(b, "utf8")).toBe("A");
    writeFileSync(a, "A2");
    let err: unknown;
    try {
      renameNoReplace(a, b);
    } catch (e) {
      err = e;
    }
    expect(isErrno(err, "EEXIST")).toBe(true);
    expect((err as Error).message).toBe(`rename ${a} ${b}: file exists`);
    expect(readFileSync(a, "utf8")).toBe("A2");
  });
  test("rename-no-replace fallbacks", () => {
    const base = sub("nr-fb");
    const a = join(base, "a");
    const b = join(base, "b");
    const unsupported = () => ERRNO.EINVAL!;
    // link + unlink
    writeFileSync(a, "A");
    expect(renameNoReplace(a, b, { sys: unsupported }).method).toBe("link");
    expect(existsSync(a)).toBe(false);
    expect(readFileSync(b, "utf8")).toBe("A");
    // link: EEXIST stays EEXIST
    writeFileSync(a, "A2");
    expect(() => renameNoReplace(a, b, { sys: unsupported })).toThrow("file exists");
    // link + a failed unlink: done, with a warning (spec audit #9)
    const c = join(base, "c");
    const r = renameNoReplace(a, c, { sys: unsupported, unlink: () => { throw Object.assign(new Error("x"), { code: "EACCES" }); } });
    expect(r.method).toBe("link");
    expect(r.unlinkError?.message).toBe(`remove ${a}: permission denied`);
    expect(readFileSync(c, "utf8")).toBe("A2");
    unlinkSync(a);
    // no hard links (FAT): lstat + rename
    const noLink = () => {
      throw Object.assign(new Error("x"), { code: "EPERM" });
    };
    writeFileSync(a, "A3");
    expect(() => renameNoReplace(a, b, { sys: unsupported, link: noLink })).toThrow(`rename ${a} ${b}: file exists`);
    const d = join(base, "d");
    expect(renameNoReplace(a, d, { sys: unsupported, link: noLink }).method).toBe("rename");
    expect(readFileSync(d, "utf8")).toBe("A3");
    // other errors of the system call fail
    expect(() => renameNoReplace(d, join(base, "e"), { sys: () => ERRNO.EACCES! })).toThrow("permission denied");
  });
});

describe("file system type", () => {
  test("isTmpfs, fsMagic, errors", async () => {
    const { isTmpfs, fsMagic, fsType, nodeName } = await import("./fsinfo.ts");
    expect(isTmpfs(dir)).toBe(false);
    if (process.platform === "linux" && existsSync("/dev/shm")) {
      expect(isTmpfs("/dev/shm")).toBe(true);
      expect(fsMagic("/dev/shm")).toBe(0x01021994);
    }
    expect(() => fsType(join(dir, "missing"))).toThrow(`statfs ${join(dir, "missing")}: no such file or directory`);
    expect(nodeName()).toBe((await import("node:os")).hostname());
  });
});
