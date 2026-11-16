// Interop of the terminal layer (src/tty, src/clipboard, src/editor) with the reference
// implementation (reference/passh-go, run as a black box), on PTYs:
//
//   a. `Passphrase: ` (passh-go show x): Ctrl-C, Ctrl-D, SIGTERM/SIGHUP/SIGINT, over 4096
//      bytes, against readPassphrase;
//   b. pairs (passh-go init): mismatches, empties, EOF, Ctrl-C, SIGTERM, against readSecretPair;
//   c. masked lines (passh-go recover): stars, redraw, escape sequences, the 64 KiB limit;
//   d. cooked prompts (passh-go add / rm / recovery-key print): Ctrl-C as SIGINT, SIGTERM,
//      yes/no answers and retries, typed phrases;
//   e. copy (passh-go copy) with a fake clipboard.command and with OSC 52;
//   f. edit --editor (passh-go edit) with fake editors.
//
// Our side runs the drivers in src/*/testdata (the CLI isn't wired yet); where the CLI
// adds text around a prompt (the passphrase before `Delete …?`, `nothing was saved: `),
// the comparison covers the prompt's own part.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, REF_BIN, ROOT, run, writeConfig, type IsolatedEnv } from "../helpers/env.ts";
import { initVault, PASS, withPassphrase } from "../helpers/passh.ts";
import { spawnPty, type PtyProcess } from "../helpers/pty.ts";

const BUN = process.execPath;
const PROMPT = [BUN, "run", join(ROOT, "src/tty/testdata/prompt-driver.ts")];
const COPY = [BUN, "run", join(ROOT, "src/clipboard/testdata/copy-driver.ts")];
const EDIT = [BUN, "run", join(ROOT, "src/editor/testdata/edit-driver.ts")];

let e: IsolatedEnv;
let BIN: string;
let password = "";
const envs: IsolatedEnv[] = [];
afterAll(() => envs.forEach((x) => x.cleanup()));

type Keys = (p: PtyProcess) => Promise<void>;
interface Out {
  code: number;
  out: string;
}

async function pty(cmd: string[], keys: Keys, vars: Record<string, string> = {}, env = e): Promise<Out> {
  const p = spawnPty(cmd, { ...env.env, ...vars });
  try {
    await keys(p);
  } catch (err) {
    p.kill("SIGKILL");
    throw err;
  }
  const r = await p.wait(30_000);
  return { code: r.code, out: r.output };
}

const ref = (args: string[], keys: Keys, vars: Record<string, string> = {}, env = e) => pty([REF_BIN, ...args], keys, vars, env);
const passphrase: Keys = async (p) => {
  await p.expect("Passphrase: ");
  p.line(PASS);
};
/** Keys after the passphrase. */
const after = (k: Keys): Keys => async (p) => {
  await passphrase(p);
  await k(p);
};
/** The output from the first occurrence of `from` on. */
const from = (s: string, mark: string) => s.slice(s.indexOf(mark));

async function generate(path: string): Promise<void> {
  const r = await withPassphrase([REF_BIN], ["generate", path, "8", "-f"], e);
  if (r.code !== 0) throw new Error("generate failed: " + r.tty);
}

beforeAll(async () => {
  e = isolatedEnv("itty");
  envs.push(e);
  await initVault([REF_BIN], e);
  await generate("ok/x");
  password = (await withPassphrase([REF_BIN], ["show", "ok/x", "--field", "password"], e)).stdout;
  BIN = join(e.dir, "bin");
  mkdirSync(BIN);
  writeFileSync(
    join(BIN, "fakeclip"),
    `#!/bin/sh\ndata=$(od -An -tx1 | tr -d ' \\n')\nprintf '%s|%s\\n' "$*" "$data" >> "$FAKECLIP_LOG"\n[ -z "$data" ] && [ "$CLIPFAIL" = clear ] && exit 2\nexit 0\n`,
  );
  chmodSync(join(BIN, "fakeclip"), 0o755);
}, 60_000);

describe("a. Passphrase prompt", () => {
  const cases: Array<[string, Keys]> = [
    ["Ctrl-C", async (p) => { await p.expect("Passphrase: "); p.send("ab\x03"); }],
    ["Ctrl-D", async (p) => { await p.expect("Passphrase: "); p.send("\x04"); }],
    ["Ctrl-D after Ctrl-U", async (p) => { await p.expect("Passphrase: "); p.send("ab\x04"); await Bun.sleep(150); p.send("\x15\x04"); }],
    ["SIGTERM", async (p) => { await p.expect("Passphrase: "); p.send("abc"); await Bun.sleep(150); p.kill("SIGTERM"); }],
    ["SIGHUP", async (p) => { await p.expect("Passphrase: "); await Bun.sleep(150); p.kill("SIGHUP"); }],
    ["SIGINT", async (p) => { await p.expect("Passphrase: "); await Bun.sleep(150); p.kill("SIGINT"); }],
    ["over 4096 bytes", async (p) => { await p.expect("Passphrase: "); p.send("a".repeat(4097)); }],
  ];
  for (const [name, keys] of cases) {
    test(name, async () => {
      const r = await ref(["show", "x"], keys);
      const o = await pty([...PROMPT, "passphrase"], keys);
      expect(o).toEqual(r);
    });
  }

  test("retries: `Wrong passphrase. Try again.` between the prompts (shape for the CLI)", async () => {
    const keys: Keys = async (p) => {
      for (let i = 0; i < 3; i++) {
        await p.expect("Passphrase: ");
        p.line("wrong" + i);
      }
    };
    const r = await ref(["show", "x"], keys);
    expect(r.code).toBe(1);
    expect(r.out).toBe(`Passphrase: \r\nWrong passphrase. Try again.\r\nPassphrase: \r\nWrong passphrase. Try again.\r\nPassphrase: \r\npassh: ${e.vault}: wrong passphrase, or the key block is damaged\r\n`);
    const o = await pty([...PROMPT, "passphrase2"], async (p) => {
      await p.expect("Passphrase: ");
      p.line("wrong0");
      await p.expect("Passphrase: ");
      p.line("wrong1");
    });
    expect(o.out.startsWith(r.out.slice(0, r.out.indexOf("Passphrase: \r\nWrong", 1) + 1).slice(0, 60))).toBe(true);
  }, 30_000);

  test("CRLF after a passphrase reaches the next prompt as an empty line", async () => {
    const r = await ref(["show", "x"], async (p) => {
      await p.expect("Passphrase: ");
      p.send("wrong\r\n");
      await p.expect("Passphrase: ");
      await p.expect("Passphrase: ");
      p.send("\x03");
    });
    expect(r.out).toBe("Passphrase: \r\nWrong passphrase. Try again.\r\nPassphrase: \r\nWrong passphrase. Try again.\r\nPassphrase: \r\npassh: reading the passphrase: interrupted\r\n");
    const o = await pty([...PROMPT, "passphrase2"], async (p) => {
      await p.expect("Passphrase: ");
      p.send("one\r\n");
    });
    expect(o.out).toContain('"r":["one",""]');
  }, 30_000);
});

describe("b. pairs (init)", () => {
  const strong = "correct horse battery staple q";
  const cases: Array<[string, Keys]> = [
    ["3 mismatches", async (p) => { for (let i = 0; i < 3; i++) { await p.expect("New passphrase: "); p.line(strong); await p.expect("Repeat passphrase: "); p.line("nope" + i); } }],
    ["3 empties", async (p) => { for (let i = 0; i < 3; i++) { await p.expect("New passphrase: "); p.line(""); } }],
    ["EOF in the repetition", async (p) => { await p.expect("New passphrase: "); p.line(strong); await p.expect("Repeat passphrase: "); p.send("\x04"); }],
    ["Ctrl-C in the repetition", async (p) => { await p.expect("New passphrase: "); p.line(strong); await p.expect("Repeat passphrase: "); p.send("\x03"); }],
    ["SIGTERM in the repetition", async (p) => { await p.expect("New passphrase: "); p.line(strong); await p.expect("Repeat passphrase: "); await Bun.sleep(150); p.kill("SIGTERM"); }],
    ["CRLF pasted pair", async (p) => { await p.expect("New passphrase: "); p.send(strong + "\r\n" + strong + "\r\n"); await p.expect("New passphrase: "); await p.expect("Repeat passphrase: "); await p.expect("New passphrase: "); p.send("\x03"); }],
  ];
  for (const [name, keys] of cases) {
    test(name, async () => {
      const fresh = isolatedEnv("ipair");
      envs.push(fresh);
      const r = await ref(["init"], keys, {}, fresh);
      const o = await pty([...PROMPT, "pair"], keys);
      expect(o.code).toBe(r.code);
      expect(o.out).toBe(from(r.out, "New passphrase: "));
    }, 30_000);
  }
});

describe("c. masked lines (recover)", () => {
  const cases: Array<[string, Keys]> = [
    ["stars, delete, Ctrl-W redraw, CRLF, blank lines; Ctrl-C", async (p) => {
      await p.expect("> "); p.send("\r\r"); await Bun.sleep(80); p.send("ab cd"); await Bun.sleep(80); p.send("\x7f"); await Bun.sleep(80); p.send("\x17"); await Bun.sleep(80); p.send("xy\r\nzz\r\n"); await Bun.sleep(150); p.send("\x03");
    }],
    ["Ctrl-U redraw and escape sequences", async (p) => {
      await p.expect("> "); p.send("abc"); await Bun.sleep(80); p.send("\x15"); await Bun.sleep(80); p.send("q\x1b[Aw\x1bOPe\x1bxr"); await Bun.sleep(80); p.send("\x03");
    }],
    ["Ctrl-D on a non-empty line is ignored; DEL of UTF-8", async (p) => {
      await p.expect("> "); p.send("abc"); await Bun.sleep(80); p.send("\x04"); await Bun.sleep(150); p.send("\x7f\x7f\x7f\x7f"); await Bun.sleep(150); p.send("é\x7f€\x15"); await Bun.sleep(150); p.send("\x03");
    }],
    ["SIGTERM", async (p) => { await p.expect("> "); p.send("abc"); await Bun.sleep(150); p.kill("SIGTERM"); }],
    ["the limit", async (p) => {
      await p.expect("> "); for (let i = 0; i < 13; i++) { p.send("a".repeat(5000) + "\r"); await Bun.sleep(20); } p.send("b".repeat(600));
    }],
  ];
  for (const [name, keys] of cases) {
    test(name, async () => {
      const r = await ref(["recover"], keys);
      const o = await pty([...PROMPT, "masked"], keys);
      expect(o.code).toBe(r.code);
      expect(from(o.out, "> ")).toBe(from(r.out, "> "));
    }, 30_000);
  }
});

describe("d. cooked prompts", () => {
  test("Username: Ctrl-C is SIGINT (130), SIGTERM 143, no line break", async () => {
    const toUser = async (p: PtyProcess) => {
      await passphrase(p);
      await p.expect("generate): ");
      p.send("\r");
      await p.expect("Username: ");
    };
    for (const k of [async (p: PtyProcess) => p.send("us\x03"), async (p: PtyProcess) => { p.send("us"); await Bun.sleep(150); p.kill("SIGTERM"); }]) {
      const r = await ref(["add", "n/new"], async (p) => { await toUser(p); await k(p); });
      const o = await pty([...PROMPT, "line"], async (p) => { await p.expect("Username: "); await k(p); });
      expect(o.code).toBe(r.code);
      expect(o.out).toBe(from(r.out, "Username: "));
    }
  }, 30_000);

  const yesno: Array<[string, Keys]> = [
    ["3 answers not understood", async (p) => { for (let i = 0; i < 3; i++) { await p.expect("[y/N] "); p.send("x\r"); } }],
    ["end of input", async (p) => { await p.expect("[y/N] "); p.send("\x04"); }],
    ["Ctrl-C", async (p) => { await p.expect("[y/N] "); p.send("\x03"); }],
    ["SIGHUP", async (p) => { await p.expect("[y/N] "); await Bun.sleep(150); p.kill("SIGHUP"); }],
  ];
  for (const [name, keys] of yesno) {
    test(`yes/no: ${name}`, async () => {
      await generate("a/b");
      const r = await ref(["rm", "a/b"], after(keys));
      const o = await pty([...PROMPT, "yesno"], keys);
      expect(o.code).toBe(r.code);
      expect(o.out).toBe(from(r.out, "Delete a/b? "));
    }, 30_000);
  }

  test("yes/no: retry then yes (the prompt part)", async () => {
    await generate("a/b");
    const keys: Keys = async (p) => { await p.expect("[y/N] "); p.send("maybe\r"); await p.expect("[y/N] "); p.send("  YES \r"); };
    const r = await ref(["rm", "a/b"], after(keys));
    const o = await pty([...PROMPT, "yesno"], keys);
    expect(r.out).toContain("Deleted a/b.");
    const part = "Delete a/b? [y/N] maybe\r\nPlease answer y or n.\r\nDelete a/b? [y/N]   YES \r\n";
    expect(from(r.out, "Delete")).toStartWith(part);
    expect(o.out).toStartWith(part);
  }, 30_000);

  const phrases: Array<[string, Keys]> = [
    ["wrong phrase", async (p) => { await p.expect("to confirm: "); p.send(" print recovery key\r"); }],
    ["end of input", async (p) => { await p.expect("to confirm: "); p.send("\x04"); }],
    ["SIGTERM", async (p) => { await p.expect("to confirm: "); await Bun.sleep(150); p.kill("SIGTERM"); }],
  ];
  for (const [name, keys] of phrases) {
    test(`typed phrase: ${name}`, async () => {
      const r = await ref(["recovery-key", "print", "-o", join(e.dir, "rk.txt")], keys);
      const o = await pty([...PROMPT, "phrase"], keys);
      expect(o).toEqual(r);
    }, 30_000);
  }
});

describe("e. copy", () => {
  const log = () => join(e.dir, "clip.log");
  const readLog = () => {
    const s = existsSync(log()) ? readFileSync(log(), "utf8") : "";
    rmSync(log(), { force: true });
    return s;
  };
  const vars = () => ({ PATH: `${BIN}:${e.env.PATH}`, FAKECLIP_LOG: log(), COPY_VALUE: password });

  test("clipboard.command: messages, stdin, clear", async () => {
    await writeConfig(e, `[clipboard]\nclear_after = "1s"\ncommand = ["fakeclip", "-x", "a b"]\n`);
    const r = await ref(["copy", "ok/x"], passphrase, vars());
    const rl = readLog();
    const o = await pty([...COPY, "1000", "1", "fakeclip", "-x", "a b"], async () => {}, vars());
    expect(o.code).toBe(r.code);
    expect(o.out).toBe(from(r.out, "Copied"));
    expect(readLog()).toBe(rl);
  }, 30_000);

  test("SIGTERM while waiting clears at once, exit 0; a failed clear after it", async () => {
    await writeConfig(e, `[clipboard]\nclear_after = "1m"\ncommand = ["fakeclip"]\n`);
    for (const fail of ["", "clear"]) {
      const v = { ...vars(), CLIPFAIL: fail };
      const k: Keys = async (p) => { await p.expect("now."); await Bun.sleep(150); p.kill("SIGTERM"); };
      const r = await ref(["copy", "ok/x"], after(k), v);
      const o = await pty([...COPY, "60000", "1", "fakeclip"], k, v);
      expect(o.code).toBe(r.code);
      expect(o.out).toBe(from(r.out, "Copied"));
      readLog();
    }
  }, 30_000);

  test("OSC 52 bytes", async () => {
    await writeConfig(e, `[clipboard]\nclear_after = "1s"\n`);
    const r = await ref(["copy", "ok/x"], passphrase, vars());
    const o = await pty([...COPY, "1000", "1"], async () => {}, vars());
    expect(o.out).toBe(r.out.slice("Passphrase: \r\n".length));
  }, 30_000);

  test("no clipboard; command not found", async () => {
    await writeConfig(e, `[clipboard]\nosc52 = false\n`);
    const r1 = await ref(["copy", "ok/x"], async () => {}, vars());
    const o1 = await pty([...COPY, "1000", "0"], async () => {}, vars());
    expect(o1).toEqual(r1);
    await writeConfig(e, `[clipboard]\ncommand = ["nofakeclip"]\n`);
    const r2 = await ref(["copy", "ok/x"], async () => {}, vars());
    const o2 = await pty([...COPY, "1000", "1", "nofakeclip"], async () => {}, vars());
    expect(o2).toEqual(r2);
    await writeConfig(e, "");
    const r3 = await run([REF_BIN, "copy", "ok/x"], e.env);
    const o3 = await run([...COPY, "1000", "1"], e.env);
    expect(o3.stderr).toBe(r3.stderr);
  }, 30_000);
});

describe("f. edit --editor", () => {
  let BIN2: string;
  const log = () => join(e.dir, "ed.log");
  const readLog = () => {
    const s = existsSync(log()) ? readFileSync(log(), "utf8") : "";
    rmSync(log(), { force: true });
    return s;
  };
  beforeAll(() => {
    BIN2 = join(e.dir, "bin2");
    mkdirSync(BIN2, { recursive: true });
    writeFileSync(
      join(BIN, "fakeed"),
      `#!/bin/sh\nfor last; do :; done\n{ printf 'ARGS:'; for a; do printf '[%s]' "$a"; done; printf '\\n'; printf 'STAT:%s\\n' "$(stat -c '%a %F' "$last") $(stat -f -c %T "$last") $(stat -c %a "$(dirname "$last")")"; } >> "$FAKEED_LOG"\ncase "$FAKEED_ACTION" in fail) exit 3;; big) head -c 16777217 /dev/zero > "$last";; sleep) echo $$ > "$FAKEED_LOG.pid"; sleep 30;; esac\nexit 0\n`,
    );
    chmodSync(join(BIN, "fakeed"), 0o755);
    for (const n of ["vim", "nvim", "nano"]) symlinkSync(join(BIN, "fakeed"), join(BIN2, n));
  });
  const vars = (EDITOR: string, action = "") => ({ PATH: `${BIN2}:${BIN}:${e.env.PATH}`, FAKEED_LOG: log(), EDITOR, FAKEED_ACTION: action });
  /** The reference's CLI wraps edit failures as `nothing was saved: …`; the driver doesn't. */
  const norm = (s: string) => s.replace("passh: nothing was saved: ", "passh: ");
  const normLog = (s: string) => s.replace(/\/passh-edit-\d+\//g, "/passh-edit-N/");

  for (const [name, editor, action] of [
    ["other editor, failing", "fakeed --flag 'a b'", "fail"],
    ["vim, no change", "vim -X", ""],
    ["neovim, no change", "nvim", ""],
    ["nano, no change", "nano", ""],
    ["file over 16 MiB", "fakeed", "big"],
  ] as const) {
    test(name, async () => {
      const r = await ref(["edit", "ok/x", "--editor"], passphrase, vars(editor, action));
      const rl = normLog(readLog());
      const o = await pty(EDIT, async () => {}, vars(editor, action));
      const ol = normLog(readLog());
      expect(o.code).toBe(r.code);
      // our driver prints its result on stdout instead of `No change.`
      expect(o.out.replace(/RESULT \{"kind":"unchanged"\}/, "No change.")).toBe(norm(r.out.slice("Passphrase: \r\n".length)));
      expect(ol).toBe(rl);
    }, 30_000);
  }

  test("$EDITOR errors, before the passphrase", async () => {
    for (const v of ["'abc", '"abc', "abc\\", '""', "nope"]) {
      const r = await ref(["edit", "ok/x", "--editor"], async () => {}, vars(v));
      const o = await pty(EDIT, async () => {}, vars(v));
      expect(o).toEqual(r);
    }
  }, 30_000);

  test("SIGTERM while the editor runs", async () => {
    const wait: Keys = async (p) => {
      for (let i = 0; i < 100 && !existsSync(log() + ".pid"); i++) await Bun.sleep(50);
      await Bun.sleep(150);
      p.kill("SIGTERM");
    };
    rmSync(log() + ".pid", { force: true });
    const r = await ref(["edit", "ok/x", "--editor"], after(wait), vars("fakeed", "sleep"));
    rmSync(log() + ".pid", { force: true });
    const o = await pty(EDIT, wait, vars("fakeed", "sleep"));
    rmSync(log() + ".pid", { force: true });
    readLog();
    expect(o.code).toBe(r.code);
    expect(o.out).toBe(norm(r.out.slice("Passphrase: \r\n".length)));
  }, 30_000);
});
