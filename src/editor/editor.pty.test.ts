// The external editor on a real PTY (src/editor/testdata/edit-driver.ts) with fake
// editors: #!/bin/sh scripts under tmp/ (only the tests use a shell; passh starts the
// editor without one). Expected texts are the reference binary's.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv } from "../../test/helpers/env.ts";
import { spawnPty, type PtyProcess } from "../../test/helpers/pty.ts";

const env = isolatedEnv("edpty");
afterAll(() => env.cleanup());
const DRIVER = [process.execPath, "run", join(import.meta.dir, "testdata/edit-driver.ts")];
const BIN = join(env.dir, "bin");
const BIN2 = join(env.dir, "bin2");
const LOG = join(env.dir, "ed.log");
mkdirSync(BIN);
mkdirSync(BIN2);

const FAKE = `#!/bin/sh
for last; do :; done
{
  printf 'ARGS:'; for a; do printf '[%s]' "$a"; done; printf '\\n'
  printf 'STAT:%s %s %s\\n' "$(stat -c '%a %F' "$last")" "$(stat -f -c %T "$last")" "$(stat -c %a "$(dirname "$last")")"
  printf 'STDIO:%s %s\\n' "$(readlink /proc/$$/fd/0)" "$(readlink /proc/$$/fd/2)"
  printf 'FILE:%s\\n' "$last"
} >> "$FAKEED_LOG"
case "$FAKEED_ACTION" in
  append) printf 'extra line\\n' >> "$last" ;;
  same) printf 'pw\\nSAME\\n' > "$last" ;;
  fail) exit 3 ;;
  invalid) printf 'INVALID\\n' > "$last" ;;
  badutf8) printf '\\377\\376\\n' > "$last" ;;
  big) head -c 16777217 /dev/zero > "$last" ;;
  swap) printf 'secret' > "$(dirname "$last")/.entry.txt.swp" ;;
  sleep) echo $$ > "$FAKEED_LOG.pid"; sleep 30 ;;
esac
exit 0
`;
writeFileSync(join(BIN, "fakeed"), FAKE);
chmodSync(join(BIN, "fakeed"), 0o755);
for (const n of ["vim", "nvim", "nano"]) symlinkSync(join(BIN, "fakeed"), join(BIN2, n));

function log(): string {
  const s = existsSync(LOG) ? readFileSync(LOG, "utf8") : "";
  rmSync(LOG, { force: true });
  return s;
}

async function edit(vars: Record<string, string>, keys: (p: PtyProcess) => Promise<void> = async () => {}): Promise<{ code: number; out: string; log: string }> {
  const p = spawnPty(DRIVER, { ...env.env, PATH: `${BIN2}:${BIN}:${env.env.PATH}`, FAKEED_LOG: LOG, ...vars });
  await keys(p);
  const r = await p.wait(20_000);
  return { code: r.code, out: r.output, log: log() };
}

const WARNING =
  "warning: passh can't control backup, swap or history files of fakeed: they may keep a copy of the entry on disk. Graphical editors must also wait until the file is closed (e.g. code --wait).\r\n";

describe("external editor (agent-session.md §A6)", () => {
  test("an other editor: warning, file 0600 on tmpfs in a 0700 folder, /dev/tty, removed afterwards", async () => {
    const r = await edit({ EDITOR: "fakeed --flag 'a b'", FAKEED_ACTION: "append" });
    expect(r.code).toBe(0);
    expect(r.out).toBe(WARNING + 'RESULT {"kind":"changed","value":"secret\\nusername: alice\\nextra line\\n"}\r\n');
    const file = /FILE:(.*)/.exec(r.log)![1]!;
    expect(file.startsWith(env.runtimeDir + "/passh-edit-")).toBe(true);
    expect(file.endsWith("/entry.txt")).toBe(true);
    expect(r.log).toContain(`ARGS:[--flag][a b][${file}]`);
    expect(r.log).toContain("STAT:600 regular file tmpfs 700");
    expect(r.log).toContain("STDIO:/dev/tty /dev/tty");
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(env.runtimeDir).filter((n) => n.startsWith("passh-edit-"))).toEqual([]);
  });

  test("vim, neovim, nano: leak-safe flags and --", async () => {
    const v = await edit({ EDITOR: "vim -X", FAKEED_ACTION: "append" });
    expect(v.out).not.toContain("warning:");
    expect(v.log).toMatch(/ARGS:\[-X\]\[-n\]\[-u\]\[NONE\]\[-i\]\[NONE\]\[-c\]\[set nobackup nowritebackup noundofile noswapfile\]\[--\]\[\/.*entry\.txt\]/);
    const n = await edit({ EDITOR: "nvim", FAKEED_ACTION: "" });
    expect(n.out).toBe('RESULT {"kind":"unchanged"}\r\n');
    expect(n.log).toMatch(/ARGS:\[-n\]\[--clean\]\[-i\]\[NONE\]\[-c\]\[set nobackup nowritebackup noundofile noswapfile\]\[--\]\[/);
    const o = await edit({ EDITOR: "nano", FAKEED_ACTION: "same" });
    expect(o.out).toBe('RESULT {"kind":"unchanged"}\r\n');
    expect(o.log).toMatch(/ARGS:\[--ignorercfiles\]\[--nohelp\]\[--\]\[/);
  });

  test("editor errors", async () => {
    const f = await edit({ EDITOR: "fakeed", FAKEED_ACTION: "fail" });
    expect(f.code).toBe(1);
    expect(f.out).toBe(WARNING + `passh: the editor failed (${BIN}/fakeed: exit status 3); nothing was changed\r\n`);
    const b = await edit({ EDITOR: "fakeed", FAKEED_ACTION: "big" });
    expect(b.out).toBe(WARNING + "passh: the edited file is larger than 16 MiB\r\n");
    const e = await edit({ EDITOR: "'abc" });
    expect(e.out).toBe(`passh: $EDITOR: unterminated single quote in "'abc"\r\n`);
  });

  test("invalid text: Edit it again? yes reopens on the user's text, no ends", async () => {
    const r = await edit({ EDITOR: "fakeed", FAKEED_ACTION: "invalid" }, async (p) => {
      await p.expect("[Y/n] ");
      p.send("\r");
      await p.expect("[Y/n] ");
      p.send("n\r");
    });
    expect(r.code).toBe(1);
    expect(r.out).toBe(
      WARNING +
        "The entry isn't valid: line 2: invalid entry\r\nEdit it again? [Y/n] \r\nThe entry isn't valid: line 2: invalid entry\r\nEdit it again? [Y/n] n\r\npassh: line 2: invalid entry\r\n",
    );
    const files = [...r.log.matchAll(/FILE:(.*)/g)].map((m) => m[1]);
    expect(files.length).toBe(2);
    expect(files[0]).toBe(files[1]!);
  });

  test("swap files are wiped too", async () => {
    const r = await edit({ EDITOR: "fakeed", FAKEED_ACTION: "swap" });
    expect(r.out).toBe(WARNING + 'RESULT {"kind":"unchanged"}\r\n');
    expect(readdirSync(env.runtimeDir).filter((n) => n.startsWith("passh-edit-"))).toEqual([]);
  });

  test("a signal kills the editor: editing interrupted", async () => {
    rmSync(LOG + ".pid", { force: true });
    const r = await edit({ EDITOR: "fakeed", FAKEED_ACTION: "sleep" }, async (p) => {
      for (let i = 0; i < 100 && !existsSync(LOG + ".pid"); i++) await Bun.sleep(50);
      await Bun.sleep(100);
      p.kill("SIGTERM");
    });
    expect(r.code).toBe(1);
    expect(r.out).toBe(WARNING + "passh: editing interrupted by terminated; nothing was changed\r\n");
    expect(readdirSync(env.runtimeDir).filter((n) => n.startsWith("passh-edit-"))).toEqual([]);
  });

  test("an editor killed by a signal of its own: the editor failed", async () => {
    rmSync(LOG + ".pid", { force: true });
    const r = await edit({ EDITOR: "fakeed", FAKEED_ACTION: "sleep" }, async () => {
      for (let i = 0; i < 100 && !existsSync(LOG + ".pid"); i++) await Bun.sleep(50);
      await Bun.sleep(100);
      process.kill(Number(readFileSync(LOG + ".pid", "utf8")), "SIGTERM");
    });
    expect(r.out).toBe(WARNING + `passh: the editor failed (${BIN}/fakeed: signal: terminated); nothing was changed\r\n`);
  });
});
