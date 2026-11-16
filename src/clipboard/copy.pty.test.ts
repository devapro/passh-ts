// `passh copy`'s flow on a real PTY (src/clipboard/testdata/copy-driver.ts) with a fake
// clipboard command (a #!/bin/sh script under tmp/, test only). Expected texts are the
// reference binary's.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, run } from "../../test/helpers/env.ts";
import { spawnPty, type PtyProcess } from "../../test/helpers/pty.ts";

const env = isolatedEnv("cppty");
afterAll(() => env.cleanup());
const DRIVER = [process.execPath, "run", join(import.meta.dir, "testdata/copy-driver.ts")];
const BIN = join(env.dir, "bin");
const LOG = join(env.dir, "clip.log");
mkdirSync(BIN);
writeFileSync(
  join(BIN, "fakeclip"),
  `#!/bin/sh
data=$(od -An -tx1 | tr -d ' \\n')
printf '%s|%s\\n' "$*" "$data" >> "$FAKECLIP_LOG"
[ -z "$data" ] && [ "$CLIPFAIL" = clear ] && exit 2
[ "$CLIPFAIL" = copy ] && exit 4
exit 0
`,
);
chmodSync(join(BIN, "fakeclip"), 0o755);
const ENV = { ...env.env, PATH: `${BIN}:${env.env.PATH}`, FAKECLIP_LOG: LOG };

function log(): string {
  const s = existsSync(LOG) ? readFileSync(LOG, "utf8") : "";
  rmSync(LOG, { force: true });
  return s;
}

async function copy(args: string[], keys: (p: PtyProcess) => Promise<void> = async () => {}, vars: Record<string, string> = {}) {
  const p = spawnPty([...DRIVER, ...args], { ...ENV, ...vars });
  const t0 = Date.now();
  await keys(p);
  const r = await p.wait(20_000);
  return { code: r.code, out: r.output, ms: Date.now() - t0, log: log() };
}

const COPIED = (method: string, d: string) => `Copied the password of ok/x (${method}); the clipboard clears in ${d}, Ctrl-C clears it now.\r\n`;

describe("copy (agent-session.md §A5)", () => {
  test("command: value on stdin, clear with empty stdin after clear_after", async () => {
    const r = await copy(["1000", "1", "fakeclip", "-x", "a b"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(COPIED('command "fakeclip -x a b"', "1s") + "Clipboard cleared.\r\n");
    expect(r.log).toBe("-x a b|506e7a6b\n-x a b|\n");
    expect(r.ms).toBeGreaterThanOrEqual(950);
  });

  test("SIGTERM and Ctrl-C clear at once, exit 0", async () => {
    const a = await copy(["60000", "1", "fakeclip"], async (p) => {
      await p.expect("now.");
      await Bun.sleep(100);
      p.kill("SIGTERM");
    });
    expect(a.code).toBe(0);
    expect(a.out).toBe(COPIED('command "fakeclip"', "1m") + "Clipboard cleared.\r\n");
    expect(a.log).toBe("|506e7a6b\n|\n");
    const b = await copy(["60000", "1", "fakeclip"], async (p) => {
      await p.expect("now.");
      await Bun.sleep(100);
      p.send("\x03");
    });
    expect(b.code).toBe(0);
    expect(b.out).toBe(COPIED('command "fakeclip"', "1m") + "^CClipboard cleared.\r\n");
  });

  test("OSC 52 bytes on the terminal", async () => {
    const r = await copy(["500", "1"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("\x1b]52;c;UG56aw==\x07" + COPIED("OSC 52 through the terminal", "1s") + "\x1b]52;c;\x07Clipboard cleared.\r\n");
  });

  test("failures", async () => {
    const nf = await copy(["500", "1", "nofakeclip"]);
    expect(nf.out).toBe('passh: clipboard.command: exec: exec: "nofakeclip": executable file not found in $PATH\r\n');
    const off = await copy(["500", "0"]);
    expect(off.out).toBe("passh: no clipboard: clipboard.osc52 is off and clipboard.command is empty; copy with: passh show ok/x --field password | pbcopy\r\n");
    const cf = await copy(["500", "1", "fakeclip"], async () => {}, { CLIPFAIL: "copy" });
    expect(cf.code).toBe(1);
    expect(cf.out).toBe("passh: clipboard command: fakeclip: exit status 4\r\n");
    const cl = await copy(["300", "1", "fakeclip", "arg"], async () => {}, { CLIPFAIL: "clear" });
    expect(cl.code).toBe(1);
    expect(cl.out).toBe(COPIED('command "fakeclip arg"', "0s") + "passh: clearing the clipboard failed: clipboard command: fakeclip: exit status 2\r\n");
    const cs = await copy(["60000", "1", "fakeclip", "arg"], async (p) => {
      await p.expect("now.");
      p.kill("SIGHUP");
    }, { CLIPFAIL: "clear" });
    expect(cs.code).toBe(1);
    expect(cs.out.endsWith("passh: interrupted (hangup), and clearing the clipboard failed: clipboard command: fakeclip: exit status 2\r\n")).toBe(true);
  });

  test("no terminal: OSC 52 impossible", async () => {
    const r = await run([...DRIVER, "500", "1"], ENV);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("passh: no clipboard: OSC 52 needs a terminal and there is none, and clipboard.command is empty; copy with: passh show ok/x --field password | pbcopy\n");
  });
});
