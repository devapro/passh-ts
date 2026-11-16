import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasCode, renderError } from "../i18n/index.ts";
import { SignalWatch } from "../tty/signals.ts";
import { chooseClipboard, Clipboard, ClearError, CommandMethod, copyAndWait, NoClipboardError, OSC52_CLEAR, osc52Sequence, shellQuote, type ClipboardMethod } from "./index.ts";

const ROOT = join(import.meta.dir, "../..");
mkdirSync(join(ROOT, "tmp"), { recursive: true });
const DIR = mkdtempSync(join(ROOT, "tmp", "clip-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

/** A method that records what it was given. */
class FakeMethod implements ClipboardMethod {
  readonly kind = "command" as const;
  values: string[] = [];
  failClear = false;
  localize() {
    return "fake";
  }
  toString() {
    return "fake";
  }
  async set(v: Uint8Array) {
    if (v.length === 0 && this.failClear) throw new Error("fake: exit status 2");
    this.values.push(new TextDecoder().decode(v));
  }
}

describe("OSC 52 (agent-session.md §A5)", () => {
  test("bytes", () => {
    expect(osc52Sequence("Pnzk")).toBe("\x1b]52;c;UG56aw==\x07");
    expect(osc52Sequence("PnzkHksG")).toBe("\x1b]52;c;UG56a0hrc0c=\x07");
    expect(osc52Sequence("é")).toBe("\x1b]52;c;w6k=\x07");
    expect(osc52Sequence(new Uint8Array([0xff, 0x00]))).toBe("\x1b]52;c;/wA=\x07");
    const long = "x".repeat(10000);
    expect(osc52Sequence(long)).not.toContain("\n");
    expect(OSC52_CLEAR).toBe("\x1b]52;c;\x07");
  });
});

describe("shell quoting", () => {
  const cases: Array<[string, string]> = [
    ["ok/x", "ok/x"],
    ["x=y,@%+:./-_", "x=y,@%+:./-_"],
    ["a b/c'd", "'a b/c'\\''d'"],
    ["user name", "'user name'"],
    ["é", "'é'"],
    ["", "''"],
    ["$HOME", "'$HOME'"],
  ];
  for (const [i, o] of cases) test(JSON.stringify(i), () => expect(shellQuote(i)).toBe(o));
});

describe("chooseClipboard", () => {
  test("no clipboard: reasons and hint", () => {
    const e1 = (() => {
      try {
        chooseClipboard({ command: [], osc52: false }, null, { path: "a b/c'd", field: "user name" });
      } catch (e) {
        return e;
      }
    })();
    expect(e1).toBeInstanceOf(NoClipboardError);
    expect((e1 as Error).message).toBe("no clipboard: clipboard.osc52 is off and clipboard.command is empty; copy with: passh show 'a b/c'\\''d' --field 'user name' | pbcopy");
    expect(hasCode(e1, "no-clipboard")).toBe(true);
    expect(() => chooseClipboard({ command: [], osc52: true }, null, { path: "ok/x", field: "password" })).toThrow(
      "no clipboard: OSC 52 needs a terminal and there is none, and clipboard.command is empty; copy with: passh show ok/x --field password | pbcopy",
    );
    expect(renderError(e1)).toBe((e1 as Error).message);
  });

  test("command: looked up in $PATH, no fallback", () => {
    expect(() => chooseClipboard({ command: ["nope-clip-xyz"], osc52: true }, null)).toThrow('clipboard.command: exec: exec: "nope-clip-xyz": executable file not found in $PATH');
    const m = chooseClipboard({ command: ["cat", "-u"], osc52: true }, null);
    expect(m).toBeInstanceOf(CommandMethod);
    expect(m.toString()).toBe('command "cat -u"');
    expect(new CommandMethod(["x", 'a"b', "c\\d", "é\t\x07"], "/bin/x").toString()).toBe('command "x a\\"b c\\\\d é\\\\t\\\\x07"');
  });

  test("command: value on stdin; failure and timeout texts", async () => {
    const log = join(DIR, "log");
    const ok = join(DIR, "clip-ok");
    writeFileSync(ok, `#!/bin/sh\ncat >> "${log}"; echo "|" >> "${log}"\n`);
    chmodSync(ok, 0o755);
    const m = chooseClipboard({ command: [ok], osc52: false }, null);
    await m.set(new TextEncoder().encode("s3cret"));
    await m.set(new Uint8Array(0));
    expect(readFileSync(log, "utf8")).toBe("s3cret|\n|\n");
    const bad = join(DIR, "clip-bad");
    writeFileSync(bad, "#!/bin/sh\ncat >/dev/null; exit 4\n");
    chmodSync(bad, 0o755);
    const mb = new CommandMethod(["clip-bad"], bad);
    expect(mb.set(new Uint8Array([1]))).rejects.toThrow("clipboard command: clip-bad: exit status 4");
  });
});

describe("Clipboard schedule", () => {
  test("copies, clears after clear_after", async () => {
    const f = new FakeMethod();
    const cb = new Clipboard(f, 100);
    const p = await cb.copy("a");
    expect(p.clearAt).toBeGreaterThan(Date.now());
    expect(await p.done).toBe("cleared");
    expect(f.values).toEqual(["a", ""]);
    expect(cb.pending()).toBeNull();
  });

  test("a newer copy cancels the older clear", async () => {
    const f = new FakeMethod();
    const cb = new Clipboard(f, 150);
    const p1 = await cb.copy("a");
    await Bun.sleep(100);
    const p2 = await cb.copy("b");
    expect(await p1.done).toBe("superseded");
    await Bun.sleep(80); // the first clear would have run by now
    expect(f.values).toEqual(["a", "b"]);
    expect(await p2.done).toBe("cleared");
    expect(f.values).toEqual(["a", "b", ""]);
  });

  test("clearNow, cancel, failures", async () => {
    const f = new FakeMethod();
    const cb = new Clipboard(f, 10_000);
    expect(await cb.clearNow()).toBe(false);
    const p = await cb.copy("a");
    expect(await cb.clearNow()).toBe(true);
    expect(await p.done).toBe("superseded");
    expect(f.values).toEqual(["a", ""]);
    const p2 = await cb.copy("b");
    cb.cancel();
    expect(await p2.done).toBe("superseded");
    f.failClear = true;
    await cb.copy("c");
    const e = await cb.clearNow().catch((x) => x);
    expect(e).toBeInstanceOf(ClearError);
    expect(e.message).toBe("fake: exit status 2");
    expect(hasCode(e, "clear-failed")).toBe(true);
    const cb2 = new Clipboard(f, 50);
    const p3 = await cb2.copy("d");
    expect(p3.done).rejects.toBeInstanceOf(ClearError);
  });

  test("a Uint8Array value is zeroed after the copy", async () => {
    const f = new FakeMethod();
    const v = new TextEncoder().encode("secret");
    await new Clipboard(f, 10_000).copy(v);
    expect(v.every((b) => b === 0)).toBe(true);
  });
});

describe("copyAndWait (cli.md §2.6)", () => {
  test("messages, wait, clear", async () => {
    const f = new FakeMethod();
    const lines: string[] = [];
    await copyAndWait({ clipboard: new Clipboard(f, 1000), value: "pw", field: "password", path: "ok/x", status: (l) => lines.push(l) });
    expect(lines).toEqual(["Copied the password of ok/x (fake); the clipboard clears in 1s, Ctrl-C clears it now.", "Clipboard cleared."]);
    expect(f.values).toEqual(["pw", ""]);
  });

  test("a signal clears at once and returns", async () => {
    const f = new FakeMethod();
    const lines: string[] = [];
    const watch = new SignalWatch(["SIGUSR2"]).start();
    const t0 = Date.now();
    const p = copyAndWait({ clipboard: new Clipboard(f, 60_000), value: "pw", field: "password", path: "ok/x", status: (l) => lines.push(l), watch });
    await Bun.sleep(50);
    process.kill(process.pid, "SIGUSR2");
    await p;
    watch.stop();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(lines[1]).toBe("Clipboard cleared.");
    expect(f.values).toEqual(["pw", ""]);
  });

  test("failed clears", async () => {
    const f = new FakeMethod();
    f.failClear = true;
    const e = await copyAndWait({ clipboard: new Clipboard(f, 50), value: "pw", field: "password", path: "ok/x", status: () => {} }).catch((x) => x);
    expect(e.message).toBe("clearing the clipboard failed: fake: exit status 2");
    expect(hasCode(e, "clear-failed")).toBe(true);
    const watch = new SignalWatch(["SIGUSR2"]).start();
    const p = copyAndWait({ clipboard: new Clipboard(f, 60_000), value: "pw", field: "password", path: "ok/x", status: () => {}, watch });
    await Bun.sleep(50);
    process.kill(process.pid, "SIGUSR2");
    const e2 = await p.catch((x) => x);
    watch.stop();
    expect(e2.message).toBe("interrupted (user defined signal 2), and clearing the clipboard failed: fake: exit status 2");
  });
});
