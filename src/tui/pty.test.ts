// PTY smoke tests: the real runtime (/dev/tty, raw mode, alternate screen, key decoding,
// rendering) driving the TUI over the fake backend (src/tui/testdata/run-fake.ts).

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, ROOT } from "../../test/helpers/env.ts";
import { spawnPty, type PtyProcess } from "../../test/helpers/pty.ts";
import { Screen } from "./testdata/vt.ts";

const DRIVER = join(ROOT, "src/tui/testdata/run-fake.ts");
const env = isolatedEnv("tuipty");
afterAll(() => env.cleanup());

class Term {
  readonly scr: Screen;
  private len = 0;
  constructor(
    readonly p: PtyProcess,
    cols: number,
    rows: number,
  ) {
    this.scr = new Screen(cols, rows);
  }
  feed(): Screen {
    const o = this.p.output();
    this.scr.write(o.slice(this.len));
    this.len = o.length;
    return this.scr;
  }
  text(): string {
    return this.feed().text();
  }
  /** Waits until the screen shows the text. */
  async see(what: string, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.text().includes(what)) return;
      await Bun.sleep(25);
    }
    throw new Error(`screen never showed ${JSON.stringify(what)}:\n${this.text()}`);
  }
  async keys(s: string): Promise<void> {
    this.p.send(s);
    await Bun.sleep(80);
  }
}

function start(args: string[] = [], cols = 80, rows = 24, stdoutFile?: string): Term {
  const p = spawnPty([process.execPath, "run", DRIVER, ...args], env.env, { cols, rows, stdoutFile });
  return new Term(p, cols, rows);
}

describe("the TUI in a PTY", () => {
  test("unlock, browse, search, reveal, copy (OSC 52), lock, quit; the terminal is restored", async () => {
    const t = start(["--clear-after", "60000"]);
    try {
      await t.see("Passphrase");
      expect(t.scr.altActive).toBe(true);
      expect(t.scr.modes).toContain("?2004h");
      await t.keys("secret\r");
      await t.see("Unlocked: 5 entries, revision 1.");
      expect(t.text()).toContain("│ ▸ bank                (1) │ bank/");
      // browse: into work, open github's detail
      await t.keys("jj");
      await t.keys("\r");
      await t.see("▾ work");
      await t.keys("j\r");
      await t.see("username  arsenii");
      await t.keys("\x1b");
      await Bun.sleep(150);
      // search
      await t.keys("/");
      await t.keys("jira");
      await t.see("/ jira");
      await t.keys("\r");
      // reveal
      await t.keys("r");
      await t.see("jira-pass");
      await t.see("shown for 10 s more (r hides)");
      await t.keys("r");
      await Bun.sleep(100);
      expect(t.text()).not.toContain("jira-pass");
      // copy: OSC 52 on the terminal, the value never on screen
      await t.keys("c");
      await t.see("Password copied · clears in 60 s (L clears it now)");
      expect(t.scr.osc52()).toEqual(["jira-pass"]);
      expect(t.text()).not.toContain("jira-pass");
      // lock: clears the clipboard at once
      await t.keys("L");
      await t.see("Locked.");
      await t.see("Clipboard cleared.");
      expect(t.scr.osc52()).toEqual(["jira-pass", ""]);
      await t.keys("\x03");
      const r = await t.p.wait(10_000);
      t.feed();
      expect(r.code).toBe(0);
      expect(t.scr.altActive).toBe(false);
      expect(t.scr.cursorVisible).toBe(true);
      expect(t.scr.modes.slice(-4)).toContain("?2004l");
      expect(r.output).toContain("\x1b[<u");
    } finally {
      t.p.kill("SIGKILL");
    }
  }, 30_000);

  test("quitting with a pending clear: the countdown on the normal screen, then cleared", async () => {
    const t = start(["--clear-after", "2500"]);
    try {
      await t.see("Passphrase");
      await t.keys("secret\r");
      await t.see("Unlocked");
      await t.keys("jjj");
      await t.keys("c");
      await t.see("Password copied");
      await t.keys("q");
      const r = await t.p.wait(15_000);
      expect(r.code).toBe(0);
      const tail = r.output.slice(r.output.lastIndexOf("\x1b[?1049l"));
      expect(tail).toMatch(/\r\x1b\[KClipboard clears in [1-3] s — Ctrl-C clears now/);
      expect(tail).toContain("\x1b]52;c;\x07");
      expect(tail).toContain("\r\x1b[KClipboard cleared.");
      expect(tail).toContain("[fake] exit 0");
    } finally {
      t.p.kill("SIGKILL");
    }
  }, 30_000);

  test("SIGTERM: locked first, then exit 143 with the message", async () => {
    const t = start();
    try {
      await t.see("Passphrase");
      await t.keys("secret\r");
      await t.see("Unlocked");
      t.p.kill("SIGTERM");
      const r = await t.p.wait(10_000);
      expect(r.code).toBe(143);
      expect(r.output).toContain("passh: locked and stopped: received terminated");
      expect(r.output).toContain("close");
    } finally {
      t.p.kill("SIGKILL");
    }
  }, 30_000);

  test("a resize redraws in the narrow layout", async () => {
    const t = start([], 80, 24);
    try {
      await t.see("Passphrase");
      await t.keys("secret\r");
      await t.see("Unlocked");
      t.p.resize(40, 20);
      t.scr.resize(40, 20);
      await t.see("passh · unlocked · locks in");
      expect(t.text()).toContain("[Folders]  Tags");
      expect(t.text()).not.toContain("┌");
      await t.keys("q");
      await t.p.wait(10_000);
    } finally {
      t.p.kill("SIGKILL");
    }
  }, 30_000);

  test("bracketed paste into the passphrase field", async () => {
    const t = start();
    try {
      await t.see("Passphrase");
      await t.keys("\x1b[200~sec\nret\x1b[201~");
      await t.see("Paste refused: the passphrase is one line.");
      await t.keys("\x1b[200~secret\x1b[201~\r");
      await t.see("Unlocked");
      await t.keys("q");
      expect((await t.p.wait(10_000)).code).toBe(0);
    } finally {
      t.p.kill("SIGKILL");
    }
  }, 30_000);

  test("the standalone form (passh edit): Ctrl-S returns the values", async () => {
    const out = join(env.dir, "form-out.json");
    const t = start(["--form"], 80, 24, out);
    try {
      await t.see("edit work/github");
      await t.see("ctrl+s save · esc cancel");
      expect(t.text()).not.toContain("locks in");
      await t.keys("\t");
      await t.keys("\x15bob");
      await t.keys("\x13");
      const r = await t.p.wait(10_000);
      expect(r.code).toBe(0);
      const res = JSON.parse(readFileSync(out, "utf8"));
      expect(res).toEqual({ kind: "save", values: { password: "s3cr3t", username: "bob", url: "https://github.com", tags: ["work", "dev"], notes: "line one\nline two" } });
    } finally {
      t.p.kill("SIGKILL");
    }
  }, 30_000);

  test("the standalone form: Ctrl-C is a key (asks before discarding)", async () => {
    const out = join(env.dir, "form-out2.json");
    const t = start(["--form"], 80, 24, out);
    try {
      await t.see("edit work/github");
      await t.keys("\tx");
      await t.keys("\x03");
      await t.see("Discard the changes?");
      await t.keys("\x03");
      const r = await t.p.wait(10_000);
      expect(r.code).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ kind: "cancel" });
    } finally {
      t.p.kill("SIGKILL");
    }
  }, 30_000);
});
