// Prompts on a real PTY (src/tty/testdata/prompt-driver.ts). The expected bytes are the
// reference binary's for the same keys (see test/interop/tty.test.ts).

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isolatedEnv, run } from "../../test/helpers/env.ts";
import { spawnPty, type PtyProcess } from "../../test/helpers/pty.ts";

const env = isolatedEnv("ttypty");
afterAll(() => env.cleanup());
const DRIVER = [process.execPath, "run", join(import.meta.dir, "testdata/prompt-driver.ts")];
const RESTORED = '"restored":true,"after":"echo=true icanon=true"';

async function drive(args: string[], keys: (p: PtyProcess) => Promise<void>): Promise<{ code: number; out: string }> {
  const p = spawnPty([...DRIVER, ...args], env.env);
  await keys(p);
  const r = await p.wait(15_000);
  return { code: r.code, out: r.output };
}

const expectResult = (out: string, r: unknown) => expect(out).toContain(`RESULT {"r":${JSON.stringify(r)},${RESTORED}}`);

describe("raw secret prompt", () => {
  test("no echo, editing keys, terminal restored", async () => {
    const { code, out } = await drive(["passphrase"], async (p) => {
      await p.expect("Passphrase: ");
      p.send("héllo\x7fé wor\x17ld\x1b[A\r");
    });
    expect(code).toBe(0);
    expect(out.startsWith("Passphrase: \r\nRESULT")).toBe(true);
    expectResult(out, "héllé ld");
  });

  test("Ctrl-C → interrupted, exit 1", async () => {
    const { code, out } = await drive(["passphrase"], async (p) => {
      await p.expect("Passphrase: ");
      p.send("ab\x03");
    });
    expect(code).toBe(1);
    expect(out).toBe("Passphrase: \r\npassh: reading the passphrase: interrupted\r\n");
  });

  test("Ctrl-D on an empty line → EOF", async () => {
    const { code, out } = await drive(["passphrase"], async (p) => {
      await p.expect("Passphrase: ");
      p.send("ab\x04");
      await Bun.sleep(100);
      p.send("\x15\x04");
    });
    expect(code).toBe(1);
    expect(out).toBe("Passphrase: \r\npassh: reading the passphrase: EOF\r\n");
  });

  for (const [sig, code, name] of [
    ["SIGTERM", 143, "terminated"],
    ["SIGHUP", 129, "hangup"],
    ["SIGINT", 130, "interrupt"],
  ] as const) {
    test(`${sig} while waiting → ${code}, terminal restored, typed input discarded`, async () => {
      const r = await drive(["passphrase"], async (p) => {
        await p.expect("Passphrase: ");
        p.send("abc");
        await Bun.sleep(150);
        p.kill(sig);
      });
      expect(r.code).toBe(code);
      expect(r.out).toBe(`Passphrase: \r\npassh: reading the passphrase: interrupted (${name})\r\n`);
    });
  }

  test("over 4096 bytes", async () => {
    const { code, out } = await drive(["passphrase"], async (p) => {
      await p.expect("Passphrase: ");
      p.send("a".repeat(4097));
    });
    expect(code).toBe(1);
    expect(out).toBe("Passphrase: \r\npassh: reading the passphrase: passphrase longer than 4096 bytes\r\n");
  });

  test("CRLF: separate prompts don't skip the LF (as the reference)", async () => {
    const { out } = await drive(["passphrase2"], async (p) => {
      await p.expect("Passphrase: ");
      p.send("one\r\n");
    });
    expect(out).toBe('Passphrase: \r\nWrong passphrase. Try again.\r\nPassphrase: \r\nRESULT {"r":["one",""],' + RESTORED + "}\r\n");
  });
});

describe("pairs", () => {
  test("empty, mismatch, failure after 3", async () => {
    const { code, out } = await drive(["pair"], async (p) => {
      await p.expect("New passphrase: ");
      p.line("");
      for (let i = 0; i < 2; i++) {
        await p.expect("New passphrase: ");
        p.line("abcdefg");
        await p.expect("Repeat passphrase: ");
        p.line("nope");
      }
    });
    expect(code).toBe(1);
    expect(out).toBe(
      "New passphrase: \r\nThe passphrase must not be empty.\r\nNew passphrase: \r\nRepeat passphrase: \r\nPassphrases don't match. Try again.\r\nNew passphrase: \r\nRepeat passphrase: \r\nPassphrases don't match. Try again.\r\npassh: passphrases don't match\r\n",
    );
  });

  test("check text between the prompts; match", async () => {
    const { code, out } = await drive(["pair"], async (p) => {
      await p.expect("New passphrase: ");
      p.line("abc");
      await p.expect("Repeat passphrase: ");
      p.line("abc");
    });
    expect(code).toBe(0);
    expect(out.startsWith("New passphrase: \r\nwarning: weak passphrase; use 6 or more random words\r\nRepeat passphrase: \r\nRESULT")).toBe(true);
    expectResult(out, "abc");
  });

  test("EOF in the repetition → EOF", async () => {
    const { code, out } = await drive(["pair"], async (p) => {
      await p.expect("New passphrase: ");
      p.line("abcdef");
      await p.expect("Repeat passphrase: ");
      p.send("\x04");
    });
    expect(code).toBe(1);
    expect(out).toBe("New passphrase: \r\nRepeat passphrase: \r\npassh: EOF\r\n");
  });

  test("password pair: empty = generate", async () => {
    const { out } = await drive(["pairpw"], async (p) => {
      await p.expect("Password (empty to generate): ");
      p.line("");
    });
    expect(out.startsWith("Password (empty to generate): \r\nRESULT")).toBe(true);
    expectResult(out, "");
  });
});

describe("masked lines", () => {
  test("stars, delete, redraw, CRLF paste, blank lines", async () => {
    const { code, out } = await drive(["masked"], async (p) => {
      await p.expect("> ");
      p.send("\r\r");
      await Bun.sleep(80);
      p.send("ab cd");
      await Bun.sleep(80);
      p.send("\x7f");
      await Bun.sleep(80);
      p.send("\x17");
      await Bun.sleep(80);
      p.send("xy\r\nzz\r\n\r\n");
    });
    expect(code).toBe(0);
    expect(out.startsWith("Type the key; it shows as *.\r\n> \r\n> \r\n> ** **\b \b\r> ** \x1b[K**\r\n> **\r\n> \r\nRESULT")).toBe(true);
    expectResult(out, "ab xy\nzz");
  });

  test("Ctrl-U redraw, escape sequences, Ctrl-C", async () => {
    const { code, out } = await drive(["masked"], async (p) => {
      await p.expect("> ");
      p.send("abc");
      await Bun.sleep(80);
      p.send("\x15");
      await Bun.sleep(80);
      p.send("q\x1b[Aw\x1bOPe\x1bxr");
      await Bun.sleep(80);
      p.send("\x03");
    });
    expect(code).toBe(1);
    expect(out).toBe("Type the key; it shows as *.\r\n> ***\r> \x1b[K*****\r\npassh: interrupted\r\n");
  });

  test("SIGTERM", async () => {
    const { code, out } = await drive(["masked"], async (p) => {
      await p.expect("> ");
      p.send("abc");
      await Bun.sleep(150);
      p.kill("SIGTERM");
    });
    expect(code).toBe(143);
    expect(out).toBe("Type the key; it shows as *.\r\n> ***\r\npassh: interrupted (terminated)\r\n");
  });

  test("the limit: 65535 bytes, each finished line counting its length + 1", async () => {
    const { code, out } = await drive(["masked"], async (p) => {
      await p.expect("> ");
      for (let i = 0; i < 13; i++) {
        p.send("a".repeat(5000) + "\r");
        await Bun.sleep(20);
      }
      p.send("b".repeat(600));
    });
    expect(code).toBe(1);
    expect(out.endsWith("> " + "*".repeat(522) + "\r\npassh: input longer than 522 bytes\r\n")).toBe(true);
  }, 30_000);
});

describe("cooked prompts", () => {
  test("plain line with echo", async () => {
    const { out } = await drive(["line"], async (p) => {
      await p.expect("Username: ");
      p.send("us er\r");
    });
    expect(out.startsWith("Username: us er\r\nRESULT")).toBe(true);
    expectResult(out, "us er");
  });

  test("Ctrl-C is SIGINT → 130; SIGTERM → 143; no line break added", async () => {
    const a = await drive(["line"], async (p) => {
      await p.expect("Username: ");
      p.send("us\x03");
    });
    expect(a.code).toBe(130);
    expect(a.out).toBe("Username: ^Cpassh: interrupted (interrupt)\r\n");
    const b = await drive(["line"], async (p) => {
      await p.expect("Username: ");
      p.send("us");
      await Bun.sleep(150);
      p.kill("SIGTERM");
    });
    expect(b.code).toBe(143);
    expect(b.out).toBe("Username: uspassh: interrupted (terminated)\r\n");
  });

  test("Ctrl-D: end of input on an empty line; after text, the text", async () => {
    const { out } = await drive(["lines", "2"], async (p) => {
      await p.expect("L0: ");
      p.send("y\x04");
      await Bun.sleep(150);
      p.send("\x04");
      await p.expect("L1: ");
      p.send("\x04");
    });
    expect(out.startsWith("L0: yL1: RESULT")).toBe(true);
    expectResult(out, ["y", null]);
  });

  test("yes/no: retries, trimming, case", async () => {
    const { out } = await drive(["yesno"], async (p) => {
      await p.expect("[y/N] ");
      p.send("maybe\r");
      await p.expect("[y/N] ");
      p.send("  YES \r");
    });
    expect(out.startsWith("Delete a/b? [y/N] maybe\r\nPlease answer y or n.\r\nDelete a/b? [y/N]   YES \r\nRESULT")).toBe(true);
    expectResult(out, true);
  });

  test("yes/no: 3 answers not understood → not confirmed; EOF → EOF; empty → default", async () => {
    const a = await drive(["yesno"], async (p) => {
      for (let i = 0; i < 3; i++) {
        await p.expect("[y/N] ");
        p.send("x\r");
      }
    });
    expect(a.code).toBe(1);
    expect(a.out.endsWith("Please answer y or n.\r\npassh: not confirmed\r\n")).toBe(true);
    const b = await drive(["yesno"], async (p) => {
      await p.expect("[y/N] ");
      p.send("\x04");
    });
    expect(b.out).toBe("Delete a/b? [y/N] passh: EOF\r\n");
    const c = await drive(["yesno", "Print?", "yes"], async (p) => {
      await p.expect("[Y/n] ");
      p.send("\r");
    });
    expectResult(c.out, true);
  });

  test("typed phrase", async () => {
    const a = await drive(["phrase"], async (p) => {
      await p.expect("to confirm: ");
      p.send(" print recovery key\r");
    });
    expect(a.code).toBe(1);
    expect(a.out).toBe("Type PRINT RECOVERY KEY to confirm:  print recovery key\r\npassh: not confirmed: you didn't type PRINT RECOVERY KEY\r\n");
    const b = await drive(["phrase"], async (p) => {
      await p.expect("to confirm: ");
      p.send("\x04");
    });
    expect(b.out).toBe("Type PRINT RECOVERY KEY to confirm: passh: not confirmed: no answer\r\n");
    const c = await drive(["phrase"], async (p) => {
      await p.expect("to confirm: ");
      p.send("  PRINT RECOVERY KEY \t\r");
    });
    expectResult(c.out, "confirmed");
  });
});

describe("terminal helpers", () => {
  test("say escapes (S4 multi-line)", async () => {
    const { out } = await drive(["say"], async () => {});
    expect(out.startsWith("a\\x1b[31mb\tc\r\nd\\re\r\n")).toBe(true);
  });

  test("window size, raw reads, GPG_TTY", async () => {
    expect((await drive(["winsize"], async () => {})).out).toContain('"r":{"cols":100,"rows":30}');
    const raw = await drive(["raw-read"], async (p) => {
      await Bun.sleep(300);
      p.send("\x1b[A");
    });
    expectResult(raw.out, [27, 91, 65]);
    const g = await drive(["gpgtty"], async () => {});
    const m = /"dev":"(\/dev\/[^"]+)","env":\{"GPG_TTY":"\1"\},"keep":\{\}/.exec(g.out);
    expect(m).not.toBeNull();
    expect(m![1]).not.toBe("/dev/tty");
  });

  test("no terminal", async () => {
    const r = await run([...DRIVER, "notty"], env.env);
    expect(r.stdout).toBe('RESULT {"tty":true,"dev":null}\n');
  });
});
