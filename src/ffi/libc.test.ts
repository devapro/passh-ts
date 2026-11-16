import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ERRNO, errnoName, flock, getuid, geteuid, getUmask, IS_LINUX, LOCK_EX, LOCK_NB, LOCK_UN, peerCred, socketFd, statfs, TMPFS_MAGIC, uname, getrlimit, RLIMIT_CORE } from "./libc.ts";

const ROOT = join(import.meta.dir, "../..");
let dir: string;
beforeAll(() => {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  dir = mkdtempSync(join(ROOT, "tmp", "libc-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("libc", () => {
  test("errno table", () => {
    expect(ERRNO.ENOENT).toBe(2);
    expect(ERRNO.EWOULDBLOCK).toBe(ERRNO.EAGAIN);
    expect(errnoName(ERRNO.EAGAIN!)).toBe("EAGAIN");
    expect(errnoName(9999)).toBe("errno 9999");
    if (IS_LINUX) {
      expect(ERRNO.EAGAIN).toBe(11);
      expect(ERRNO.ENOTSUP).toBe(95);
    }
  });
  test("flock: per open file, EWOULDBLOCK when busy", () => {
    const p = join(dir, "l");
    const a = openSync(p, "w");
    const b = openSync(p, "r");
    expect(flock(a, LOCK_EX | LOCK_NB)).toBe(0);
    expect(flock(b, LOCK_EX | LOCK_NB)).toBe(ERRNO.EWOULDBLOCK!);
    expect(flock(a, LOCK_UN)).toBe(0);
    expect(flock(b, LOCK_EX | LOCK_NB)).toBe(0);
    expect(flock(9999, LOCK_EX | LOCK_NB)).toBe(ERRNO.EBADF!);
    closeSync(a);
    closeSync(b);
  });
  test("uids, umask", () => {
    expect(getuid()).toBe(process.getuid!());
    expect(geteuid()).toBe(process.geteuid!());
    const m = getUmask();
    expect(process.umask()).toBe(m);
  });
  test("statfs", () => {
    const r = statfs(dir);
    expect(typeof r).toBe("object");
    expect(statfs(join(dir, "missing"))).toBe(ERRNO.ENOENT!);
    if (IS_LINUX) {
      const shm = statfs("/dev/shm");
      if (typeof shm === "object") {
        expect(shm.type).toBe(TMPFS_MAGIC);
        expect(shm.typeName).toBe("tmpfs");
      }
    }
  });
  test("uname", () => {
    const u = uname();
    if (typeof u === "number") throw new Error("uname failed");
    expect(u.nodename).toBe(hostname());
    expect(u.sysname).toBe(IS_LINUX ? "Linux" : "Darwin");
  });
  test("getrlimit", () => {
    const r = getrlimit(RLIMIT_CORE);
    expect(typeof r).toBe("object");
  });
  test("peer credentials of a Bun unix socket", async () => {
    const path = join(dir, "s.sock");
    let serverSide: ReturnType<typeof peerCred> | undefined;
    const done = Promise.withResolvers<void>();
    const srv = Bun.listen({
      unix: path,
      socket: {
        open(s) {
          serverSide = peerCred(socketFd(s));
          s.end();
          done.resolve();
        },
        data() {},
      },
    });
    let clientSide: ReturnType<typeof peerCred> | undefined;
    const c = await Bun.connect({ unix: path, socket: { data() {}, open(s) { clientSide = peerCred(socketFd(s)); } } });
    await done.promise;
    c.end();
    srv.stop(true);
    expect(serverSide).toEqual({ uid: process.getuid!(), gid: process.getgid!(), pid: process.pid });
    expect(typeof clientSide === "object" && clientSide.uid).toBe(process.getuid!());
    expect(peerCred(9999)).toBe(ERRNO.EBADF!);
    expect(socketFd({})).toBe(-1);
  });
  test("peer credentials of a node:net socket", async () => {
    const net = await import("node:net");
    const path = join(dir, "n.sock");
    const got = Promise.withResolvers<ReturnType<typeof peerCred>>();
    const server = net.createServer((sock) => {
      got.resolve(peerCred(socketFd(sock)));
      sock.end();
    });
    await new Promise<void>((r) => server.listen(path, r));
    const c = net.connect(path);
    const cred = await got.promise;
    c.destroy();
    server.close();
    expect(typeof cred === "object" && cred.uid).toBe(process.getuid!());
  });
});
