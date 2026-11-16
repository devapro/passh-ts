import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { hasCode } from "../i18n/index.ts";
import { exitError, exitText, lookPath, NOT_FOUND, RELATIVE, runProcess, spawnAgentChild, splitWords } from "./index.ts";

const ROOT = join(import.meta.dir, "../..");
mkdirSync(join(ROOT, "tmp"), { recursive: true });
const DIR = mkdtempSync(join(ROOT, "tmp", "exec-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

function script(name: string, body: string): string {
  const p = join(DIR, name);
  writeFileSync(p, "#!/bin/sh\n" + body + "\n");
  chmodSync(p, 0o755);
  return p;
}

describe("splitWords (agent-session.md §A7)", () => {
  const ok: Array<[string, string[]]> = [
    ["vim", ["vim"]],
    ["  vim  -X\t-n\nfoo ", ["vim", "-X", "-n", "foo"]],
    ["code --wait", ["code", "--wait"]],
    ["'a b' c", ["a b", "c"]],
    ['"a b" c', ["a b", "c"]],
    ["a'b c'd", ["ab cd"]],
    ['"a\\"b\\\\c\\$d\\`e"', ['a"b\\c$d`e']],
    ['"a\\nb"', ["a\\nb"]],
    ["'a\\b'", ["a\\b"]],
    ["a\\ b", ["a b"]],
    ["\\'x", ["'x"]],
    ['""', [""]],
    ["'' x", ["", "x"]],
    ["a '' b", ["a", "", "b"]],
    ["$HOME ~/x $(rm) *.txt a;b|c&d<e>f", ["$HOME", "~/x", "$(rm)", "*.txt", "a;b|c&d<e>f"]],
    ["", []],
    ["   ", []],
    ["é 😀", ["é", "😀"]],
  ];
  for (const [input, want] of ok) test(JSON.stringify(input), () => expect(splitWords(input)).toEqual(want));

  test("errors", () => {
    expect(() => splitWords("'abc")).toThrow(`unterminated single quote in "'abc"`);
    expect(() => splitWords('"abc')).toThrow(`unterminated double quote in "\\"abc"`);
    expect(() => splitWords('"abc\\"')).toThrow("unterminated double quote");
    expect(() => splitWords("abc\\")).toThrow(`trailing backslash in "abc\\\\"`);
    expect(() => splitWords("a 'b\tc")).toThrow(`unterminated single quote in "a 'b\\tc"`);
  });
});

describe("lookPath", () => {
  const exe = script("prog", "exit 0");
  writeFileSync(join(DIR, "noexec"), "x");
  test("a name with a slash is used as it is", () => {
    expect(lookPath(exe)).toBe(exe);
    expect(() => lookPath(join(DIR, "missing"))).toThrow(`exec: exec: "${join(DIR, "missing")}": stat ${join(DIR, "missing")}: no such file or directory`);
    expect(() => lookPath(join(DIR, "noexec"))).toThrow("permission denied");
    expect(() => lookPath(DIR + "/")).toThrow("is a directory");
  });
  test("search in $PATH", () => {
    expect(lookPath("prog", { PATH: "/nonexistent:" + DIR })).toBe(exe);
    expect(() => lookPath("noexec", { PATH: DIR })).toThrow("executable file not found in $PATH");
    const e = (() => {
      try {
        lookPath("nope-xyz", { PATH: DIR });
      } catch (x) {
        return x;
      }
    })();
    expect((e as Error).message).toBe('exec: exec: "nope-xyz": executable file not found in $PATH');
    expect(hasCode(e, NOT_FOUND)).toBe(true);
    expect(() => lookPath("prog", {})).toThrow("executable file not found in $PATH");
  });
  test("a match through a relative entry is refused", () => {
    const rel = relative(process.cwd(), DIR);
    let e: unknown;
    try {
      lookPath("prog", { PATH: rel + ":" + DIR });
    } catch (x) {
      e = x;
    }
    expect((e as Error).message).toBe('exec: exec: "prog": cannot run executable found relative to current directory');
    expect(hasCode(e, RELATIVE)).toBe(true);
    // an empty entry means "." (the repository root here, without "prog")
    expect(lookPath("prog", { PATH: ":" + DIR })).toBe(exe);
  });
});

describe("runProcess", () => {
  test("stdin bytes, captured stdout, exit status", async () => {
    const r = await runProcess({ argv: ["cat"], stdin: new TextEncoder().encode("héllo"), stdout: "pipe" });
    expect(new TextDecoder().decode(r.stdout)).toBe("héllo");
    expect(r.exitCode).toBe(0);
    expect(r.exitText).toBe("");
    const f = await runProcess({ argv: ["sh", "-c", "exit 3"] });
    expect(f.exitCode).toBe(3);
    expect(exitError("sh", f)?.message).toBe("sh: exit status 3");
  });

  test("large stdin and stdout at once (no deadlock)", async () => {
    const big = new Uint8Array(3 * 1024 * 1024).fill(0x61);
    const r = await runProcess({ argv: ["cat"], stdin: big, stdout: "pipe", timeoutMs: 10_000 });
    expect(r.timedOut).toBe(false);
    expect(r.stdout.length).toBe(big.length);
  });

  test("unset stdio is /dev/null; the environment is inherited with additions replacing", async () => {
    process.env.PASSH_TEST_INHERITED = "inherited";
    process.env.PASSH_TEST_REPLACED = "old";
    const r = await runProcess({
      argv: ["sh", "-c", 'readlink /proc/self/fd/0; readlink /proc/self/fd/2; echo "$PASSH_TEST_INHERITED $PASSH_TEST_REPLACED $GPG_TTY"; ls /proc/self/fd | wc -l'],
      stdout: "pipe",
      env: { PASSH_TEST_REPLACED: "new", GPG_TTY: "/dev/pts/9" },
    });
    delete process.env.PASSH_TEST_INHERITED;
    delete process.env.PASSH_TEST_REPLACED;
    const lines = new TextDecoder().decode(r.stdout).trim().split("\n");
    expect(lines[0]).toBe("/dev/null");
    expect(lines[1]).toBe("/dev/null");
    expect(lines[2]).toBe("inherited new /dev/pts/9");
    expect(Number(lines[3])).toBeLessThanOrEqual(5); // 0, 1, 2 and ls's own directory fd
  });

  test("timeout kills", async () => {
    const t0 = Date.now();
    const r = await runProcess({ argv: ["sleep", "5"], timeoutMs: 200 });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe("SIGKILL");
    expect(r.exitText).toBe("signal: killed");
    expect(exitText(null, "SIGTERM")).toBe("signal: terminated");
  });

  test("stdout limit closes the pipe", async () => {
    const r = await runProcess({ argv: ["sh", "-c", "head -c 3000000 /dev/zero; echo done >&2"], stdout: "pipe", stdoutLimit: 1000 });
    expect(r.stdout.length).toBe(1000);
    expect(r.stdoutOverflow).toBe(true);
  });

  test("fd 3 status pipe: kept up to the limit, closed after exit", async () => {
    const r = await runProcess({ argv: ["sh", "-c", "echo '[GNUPG:] DECRYPTION_OKAY' >&3; printf x >&3; [ -p /proc/self/fd/3 ] && echo fifo"], stdout: "pipe", fd3: { limit: 10, closeAfterExitMs: 2000 } });
    expect(new TextDecoder().decode(r.fd3)).toBe("[GNUPG:] D");
    expect(r.fd3Overflow).toBe(true);
    expect(new TextDecoder().decode(r.stdout).trim()).toBe("fifo");
    const t0 = Date.now();
    // a grandchild keeps fd 3 open: the pipe is closed 300 ms after the child's exit
    const g = await runProcess({ argv: ["sh", "-c", "echo a >&3; (sleep 3 >&3 &) ; exit 0"], fd3: { limit: 100, closeAfterExitMs: 300 } });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(new TextDecoder().decode(g.fd3)).toBe("a\n");
  });

  test("abort kills; onStart gives the pid", async () => {
    const ac = new AbortController();
    let pid = 0;
    const p = runProcess({ argv: ["sleep", "5"], signal: ac.signal, onStart: (c) => (pid = c.pid) });
    await Bun.sleep(100);
    expect(pid).toBeGreaterThan(0);
    ac.abort();
    const r = await p;
    expect(r.signal).toBe("SIGKILL");
  });

  test("lookup errors are thrown", async () => {
    expect(runProcess({ argv: ["nope-xyz-123"] })).rejects.toThrow('exec: exec: "nope-xyz-123": executable file not found in $PATH');
  });
});

describe("spawnAgentChild (agent-session.md §A2.3)", () => {
  test("new session, cwd /, stdin pipe, null stdout/stderr, fd 3 a FIFO, no other fds, readiness line", async () => {
    const out = join(DIR, "agent-report");
    const body = [
      `fd0=$(readlink /proc/$$/fd/0 | cut -c1-5); fd1=$(readlink /proc/$$/fd/1); fd2=$(readlink /proc/$$/fd/2)`,
      `fds=$(ls /proc/$$/fd | sort -n | tr '\\n' ' ')`,
      `[ -p /proc/$$/fd/3 ] && fifo=yes`,
      `read -r key; read -r digest`,
      `{`,
      `  echo "key=$key digest=$digest"`,
      `  echo "cwd=$(pwd)"`,
      `  echo "sid=$(ps -o sid= -p $$ | tr -d ' ') pid=$$"`,
      `  echo "fd3=$fifo"`,
      `  echo "fd0=$fd0 fd1=$fd1 fd2=$fd2"`,
      `  echo "fds=$fds"`,
      `} > "${out}"`,
      `echo ok >&3`,
    ].join("\n");
    const agent = script("fake-agent", body);
    const data = new TextEncoder().encode("AGE-SECRET-KEY-1ABC\n" + "a".repeat(64) + "\n");
    const child = await spawnAgentChild({ command: [agent], args: ["__agent", "--vault=/x"], stdinData: data });
    expect(data.every((b) => b === 0)).toBe(true);
    const r = await child.readReadiness(5000);
    expect(r).toEqual({ kind: "line", line: "ok", truncated: false });
    await child.exited;
    const report = readFileSync(out, "utf8");
    expect(report).toContain("key=AGE-SECRET-KEY-1ABC digest=" + "a".repeat(64));
    expect(report).toContain("cwd=/\n");
    const sid = /sid=(\d+) pid=(\d+)/.exec(report)!;
    expect(sid[1]).toBe(sid[2]!);
    expect(report).toContain("fd3=yes");
    expect(report).toContain("fd0=pipe: fd1=/dev/null fd2=/dev/null");
    // 0–3, plus the shell's own: 4 (the $(…) pipe) and 10 (dash's script file)
    expect(report).toMatch(/fds=0 1 2 3 (4 )?(10 )?\n/);
  });

  test("closed without a line, timeout, long line", async () => {
    const quit = script("quit-agent", "exit 1");
    const c1 = await spawnAgentChild({ command: [quit], args: [], stdinData: new Uint8Array(1) });
    expect(await c1.readReadiness(5000)).toEqual({ kind: "closed" });
    const slow = script("slow-agent", "sleep 3");
    const c2 = await spawnAgentChild({ command: [slow], args: [], stdinData: new Uint8Array(1) });
    expect(await c2.readReadiness(200)).toEqual({ kind: "timeout" });
    c2.kill();
    const long = script("long-agent", "head -c 2000 /dev/zero | tr '\\0' x >&3");
    const c3 = await spawnAgentChild({ command: [long], args: [], stdinData: new Uint8Array(1) });
    const r3 = await c3.readReadiness(5000);
    expect(r3.kind === "line" && r3.line.length === 1024 && r3.truncated).toBe(true);
    const err = script("err-agent", "echo 'error: agent: bad key' >&3; exit 1");
    const c4 = await spawnAgentChild({ command: [err], args: [], stdinData: new Uint8Array(1) });
    expect(await c4.readReadiness(5000)).toEqual({ kind: "line", line: "error: agent: bad key", truncated: false });
    expect(existsSync(DIR)).toBe(true);
  });
});


