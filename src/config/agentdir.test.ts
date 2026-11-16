import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasCode } from "../i18n/index.ts";
import { agentSocketName, agentSocketPath, checkPrivateDir, createAgentDir } from "./agentdir.ts";

const ROOT = join(import.meta.dir, "../..");
let dir: string;
beforeAll(() => {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  dir = realpathSync(mkdtempSync(join(ROOT, "tmp", "agdir-")));
});
afterAll(() => {
  for (const d of ["parent000", "m000", "m0600"]) {
    try {
      chmodSync(join(dir, d), 0o700);
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
});
const err = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e as Error;
  }
  throw new Error("no error");
};

describe("socket location (agent-session.md §A2.1)", () => {
  test("the name", () => {
    // The spec's example: /home/alice/.local/share/passh/vault.passh
    expect(agentSocketName("/home/alice/.local/share/passh/vault.passh")).toBe("agent-7235202d1eb458e0.sock");
    expect(agentSocketName("/x").length).toBe(27);
  });
  test("the spec's example path", () => {
    const s = agentSocketPath("/home/alice/.local/share/passh/vault.passh", { env: { HOME: "/home/alice" }, uid: 1000 });
    expect(s.path).toBe("/home/alice/.local/state/passh/agent/agent-7235202d1eb458e0.sock");
    expect(s.dir).toBe("/home/alice/.local/state/passh/agent");
    expect(s.inState).toBe(true);
  });
  test("fallbacks by length: $TMPDIR/passh-<uid>, then /tmp/passh-<uid>", () => {
    const v = "/v.passh";
    const name = agentSocketName(v);
    // state + "/agent/" + 27 bytes: a state dir of 103 - 27 - 7 = 69 bytes still fits
    const fits = "/" + "s".repeat(68);
    expect(agentSocketPath(v, { env: { XDG_STATE_HOME: fits.slice(0, -6) }, uid: 7 }).path.length).toBe(103);
    expect(agentSocketPath(v, { env: { XDG_STATE_HOME: fits.slice(0, -6) }, uid: 7 }).inState).toBe(true);
    const long = "/" + "s".repeat(80);
    const t = agentSocketPath(v, { env: { XDG_STATE_HOME: long, TMPDIR: "/my/tmp/" }, uid: 7 });
    expect(t).toEqual({ dir: "/my/tmp/passh-7", path: "/my/tmp/passh-7/" + name, name, inState: false });
    // TMPDIR relative or unset: /tmp
    expect(agentSocketPath(v, { env: { XDG_STATE_HOME: long, TMPDIR: "rel" }, uid: 7 }).dir).toBe("/tmp/passh-7");
    expect(agentSocketPath(v, { env: { XDG_STATE_HOME: long }, uid: 7 }).dir).toBe("/tmp/passh-7");
    // TMPDIR too long as well: /tmp
    expect(agentSocketPath(v, { env: { XDG_STATE_HOME: long, TMPDIR: long }, uid: 7 }).dir).toBe("/tmp/passh-7");
    // multi-byte characters count in bytes
    const uni = "/" + "é".repeat(34); // 69 bytes
    expect(agentSocketPath(v, { env: { XDG_STATE_HOME: uni }, uid: 7 }).inState).toBe(false);
  });
  test("none fits", () => {
    const e = err(() => agentSocketPath("/v", { env: { XDG_STATE_HOME: "/" + "s".repeat(80) }, uid: 10n ** 70n }));
    expect(e.message).toBe("the agent's socket path is longer than 103 bytes even in /tmp");
    expect(hasCode(e, "socket-path")).toBe(true);
  });
  test("$HOME needed without XDG_STATE_HOME", () => {
    expect(err(() => agentSocketPath("/v", { env: {}, uid: 1 })).message).toBe("$HOME is not set");
  });
});

describe("agent folder check (agent-session.md §A2.2)", () => {
  const uid = process.getuid!();
  test("ok and missing", () => {
    const d = join(dir, "ok");
    mkdirSync(d, { mode: 0o700 });
    chmodSync(d, 0o700);
    expect(checkPrivateDir(d)).toBe("ok");
    expect(checkPrivateDir(join(dir, "missing"))).toBe("missing");
    expect(checkPrivateDir(join(dir, "missing", "deeper"))).toBe("missing");
  });
  test("wrong modes", () => {
    for (const [mode, text] of [
      [0o755, "0755"],
      [0o2700, "2700"],
      [0o1700, "1700"],
      [0o600, "0600"],
      [0o701, "0701"],
    ] as const) {
      const d = join(dir, `m${text}`);
      mkdirSync(d);
      chmodSync(d, mode);
      const e = err(() => checkPrivateDir(d));
      expect(e.message).toBe(`agent folder ${d} has mode ${text}, not 0700; refusing to use it (fix it with chmod 700, or remove it)`);
      expect(hasCode(e, "agent-dir")).toBe(true);
    }
  });
  test("a symlink or a file", () => {
    const real = join(dir, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(dir, "link"));
    writeFileSync(join(dir, "file"), "");
    for (const p of [join(dir, "link"), join(dir, "file")]) {
      expect(err(() => checkPrivateDir(p)).message).toBe(`agent folder ${p} is not a directory (a symlink or a file); refusing to use it`);
    }
  });
  test("another owner", () => {
    const d = join(dir, "own");
    mkdirSync(d, { mode: 0o700 });
    chmodSync(d, 0o700);
    expect(err(() => checkPrivateDir(d, uid + 1)).message).toBe(`agent folder ${d} belongs to uid ${uid}, not to you (uid ${uid + 1}); refusing to use it`);
  });
  test("can't open", () => {
    if (uid === 0) return;
    const d = join(dir, "m000");
    mkdirSync(d);
    chmodSync(d, 0);
    expect(err(() => checkPrivateDir(d)).message).toBe(`opening the agent folder ${d}: permission denied`);
    const p = join(dir, "parent000");
    mkdirSync(join(p, "agent"), { recursive: true });
    chmodSync(p, 0);
    expect(err(() => checkPrivateDir(join(p, "agent"))).message).toBe(`opening the agent folder ${join(p, "agent")}: permission denied`);
    chmodSync(p, 0o700);
  });
});

describe("createAgentDir", () => {
  test("in the state folder: parents umask-reduced, state and agent exactly 0700", () => {
    const xdg = join(dir, "xdg-a", "b");
    const env = { XDG_STATE_HOME: xdg };
    const s = agentSocketPath("/v", { env });
    const old = process.umask(0o022);
    try {
      createAgentDir(s, { env });
    } finally {
      process.umask(old);
    }
    expect(statSync(join(dir, "xdg-a")).mode & 0o777).toBe(0o700);
    expect(statSync(join(xdg, "passh")).mode & 0o7777).toBe(0o700);
    expect(statSync(join(xdg, "passh", "agent")).mode & 0o7777).toBe(0o700);
    createAgentDir(s, { env }); // existing: only checked
    chmodSync(join(xdg, "passh", "agent"), 0o750);
    expect(() => createAgentDir(s, { env })).toThrow("has mode 0750, not 0700");
  });
  test("an existing state folder is left as it is", () => {
    const xdg = join(dir, "xdg-b");
    mkdirSync(join(xdg, "passh"), { recursive: true });
    chmodSync(join(xdg, "passh"), 0o755);
    const env = { XDG_STATE_HOME: xdg };
    createAgentDir(agentSocketPath("/v", { env }), { env });
    expect(statSync(join(xdg, "passh")).mode & 0o7777).toBe(0o755);
    expect(statSync(join(xdg, "passh", "agent")).mode & 0o7777).toBe(0o700);
  });
  test("a fallback folder in $TMPDIR, which must exist", () => {
    const tmp = join(dir, "tmpdir");
    mkdirSync(tmp);
    const env = { XDG_STATE_HOME: "/" + "s".repeat(80), TMPDIR: tmp };
    const s = agentSocketPath("/v", { env });
    expect(s.inState).toBe(false);
    const old = process.umask(0o077);
    try {
      createAgentDir(s, { env });
    } finally {
      process.umask(old);
    }
    expect(statSync(s.dir).mode & 0o7777).toBe(0o700);
    const missing = agentSocketPath("/v", { env: { ...env, TMPDIR: join(dir, "no-tmp") } });
    expect(() => createAgentDir(missing, { env })).toThrow(`mkdir ${missing.dir}: no such file or directory`);
  });
});
