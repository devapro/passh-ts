// Side by side with the reference: `passh doctor` (cli.md §2.25) in many situations: healthy
// vault, config problems, missing / odd / damaged / non-canonical vault files, modes, leftover
// temporary files, the state and agent folders, an agent running, `edit --editor` leftovers,
// $HOME unset, no terminal and the clipboard test on a terminal. Memory and swap numbers are
// normalized (machine-dependent), and so are pids and agent times.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IsolatedEnv } from "../helpers/env.ts";
import { bothMore, killAgentsUnder, makePair, PASSPHRASE_STEP, runMore, visible, type MoreRunOptions, type Pair } from "./side_more.ts";
import { buildVault, placeVault, type BuiltVault } from "./vaults.ts";
import { formatSize, memAvailable, parseSwaps } from "../../src/cli/cmd_doctor.ts";

setDefaultTimeout(60_000);

let vault: BuiltVault;
const pairs: Pair[] = [];
const isRoot = process.getuid?.() === 0;

beforeAll(async () => {
  vault = await buildVault([
    { path: "work/github", password: "pw1", username: "alice", tags: ["dev"] },
    { path: "mail", password: "pw2" },
  ]);
});

afterAll(() => {
  for (const p of pairs) {
    killAgentsUnder(p.ref.dir);
    killAgentsUnder(p.ours.dir);
    // A folder made unreadable by a test would stop the cleanup.
    for (const e of [p.ref, p.ours]) {
      for (const d of [e.dir, join(e.dataHome, "passh"), join(e.stateHome, "passh"), join(e.stateHome, "passh", "agent")]) {
        try {
          chmodSync(d, 0o700);
        } catch {}
      }
    }
    p.cleanup();
  }
});

/** A pair holding the vault, with `setup` applied to both envs. */
async function pairWith(setup?: (e: IsolatedEnv) => void, configExtra = "", bytes: Uint8Array | null = vault.bytes): Promise<Pair> {
  const p = await makePair("doc", bytes ?? undefined, configExtra);
  pairs.push(p);
  for (const e of [p.ref, p.ours]) setup?.(e);
  return p;
}

async function same(p: Pair, args: string[] = ["doctor"], o: MoreRunOptions = {}) {
  const r = await bothMore(p, args, o);
  expect(visible(r.ours)).toEqual(visible(r.ref));
  return r.ref;
}

describe("doctor without a terminal", () => {
  test("healthy vault", async () => {
    const r = await same(await pairWith());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ok     vault         <ENV>/data/passh/vault.passh: structure OK");
    expect(r.stdout).toContain("skip   clipboard     not tested without a terminal");
  });

  test("no config file", async () => {
    const r = await same(await pairWith((e) => rmSync(e.configFile)));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("skip   clipboard     no config, so no clipboard settings to check");
  });

  test("invalid config file", async () => {
    const r = await same(await pairWith((e) => writeFileSync(e.configFile, 'vault = "x"\nbogus = 1\nlanguage = "de"\n')));
    expect(r.code).toBe(1);
  });

  test("--config names a missing file", async () => {
    const p = await pairWith();
    await same(p, ["--config", "nope.toml", "doctor"], { cwd: (e) => e.home });
  });

  test("--vault overrides the config's vault", async () => {
    const p = await pairWith((e) => placeVault(join(e.home, "other.passh"), vault.bytes));
    const r = await same(p, ["--vault", "~/other.passh", "doctor"]);
    expect(r.stdout).toContain("info   config        --vault overrides the config's vault");
    expect(r.stdout).toContain("~/other.passh: structure OK");
  });

  test("--vault without a config file", async () => {
    const p = await pairWith((e) => {
      rmSync(e.configFile);
      placeVault(join(e.home, "v.passh"), vault.bytes);
    });
    const r = await same(p, ["--vault", "~/v.passh", "doctor"]);
    expect(r.stdout).toContain("using --vault and the defaults");
  });

  test("missing vault", async () => {
    const r = await same(await pairWith(undefined, "", null));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("doesn't exist: run `passh init`");
  });

  for (const mode of [0o644, 0o640, 0o400, 0o700]) {
    test(`vault mode ${mode.toString(8)}`, async () => {
      await same(await pairWith((e) => chmodSync(e.vault, mode)));
    });
  }

  test("leftover temporary files (regular files only, byte order)", async () => {
    const p = await pairWith((e) => {
      const d = join(e.dataHome, "passh");
      for (const n of [".vault.passh.tmp-123", ".vault.passh.tmp-", ".vault.passh.tmp-a\nb", ".vault.passh.tmp-É", ".other.tmp-1"]) writeFileSync(join(d, n), "");
      mkdirSync(join(d, ".vault.passh.tmp-dir"));
      symlinkSync("/nonexistent", join(d, ".vault.passh.tmp-link"));
    });
    const r = await same(p);
    expect(r.stdout).toContain("4 files left by an interrupted save");
  });

  test("one leftover temporary file", async () => {
    await same(await pairWith((e) => writeFileSync(join(e.dataHome, "passh", ".vault.passh.tmp-9"), "")));
  });

  test.skipIf(isRoot)("vault folder not writable", async () => {
    const p = await pairWith((e) => chmodSync(join(e.dataHome, "passh"), 0o500));
    const r = await same(p);
    expect(r.code).toBe(1);
  });

  test.skipIf(isRoot)("vault folder can't be listed", async () => {
    const p = await pairWith((e) => chmodSync(join(e.dataHome, "passh"), 0o300));
    const r = await same(p);
    expect(r.stdout).toContain("can't list the vault's folder");
  });

  test.skipIf(isRoot)("vault can't be read", async () => {
    const r = await same(await pairWith((e) => chmodSync(e.vault, 0o000)));
    expect(r.stdout).toContain("permission denied");
    expect(r.stdout).toContain("skip   agent ");
  });

  test.skipIf(isRoot)("vault's folder can't be searched (lstat error)", async () => {
    const p = await pairWith((e) => chmodSync(join(e.dataHome, "passh"), 0o600));
    await same(p);
  });

  test("vault is a folder", async () => {
    await same(await pairWith((e) => {
      rmSync(e.vault);
      mkdirSync(e.vault);
    }));
  });

  test("vault larger than 64 MiB", async () => {
    await same(await pairWith((e) => truncateSync(e.vault, 64 * 1024 * 1024 + 1)));
  });

  test("damaged structure", async () => {
    const r = await same(await pairWith((e) => writeFileSync(e.vault, vault.bytes.subarray(0, 700))));
    expect(r.stdout).toContain("(SHA-256 ");
    expect(r.stdout).toContain("agent folder");
  });

  test("not a passh vault", async () => {
    await same(await pairWith((e) => writeFileSync(e.vault, "hello\n")));
  });

  test("non-canonical, with ignored lines", async () => {
    const text = new TextDecoder().decode(vault.bytes);
    const crlf = ("junk\n" + text + "after\nmore\n").replace(/\n/g, "\r\n");
    const r = await same(await pairWith((e) => writeFileSync(e.vault, crlf, { mode: 0o600 })));
    expect(r.stdout).toContain("ignored 1 line of text before the passh-vault line");
    expect(r.stdout).toContain("ignored 2 lines of text after the last END line");
    expect(r.stdout).toContain("not in canonical form");
  });

  test("vault is a symlink; temp files beside the target", async () => {
    const p = await pairWith((e) => {
      const target = join(e.home, "real", "v.passh");
      placeVault(target, vault.bytes);
      rmSync(e.vault);
      symlinkSync("../../home/real/v.passh", e.vault);
      writeFileSync(join(e.home, "real", ".v.passh.tmp-1"), "");
    });
    const r = await same(p);
    expect(r.stdout).toContain("is a symlink to ~/real/v.passh; saves write the target");
  });

  test("vault's folder is a symlink", async () => {
    const p = await pairWith((e) => {
      placeVault(join(e.home, "realdir", "vault.passh"), vault.bytes);
      rmSync(join(e.dataHome, "passh"), { recursive: true });
      symlinkSync(join(e.home, "realdir"), join(e.dataHome, "passh"));
    });
    const r = await same(p);
    expect(r.stdout).toContain("ok     vault folder  ~/realdir is writable");
  });

  test("dangling symlink", async () => {
    await same(await pairWith((e) => {
      rmSync(e.vault);
      symlinkSync("/nonexistent/x.passh", e.vault);
    }));
  });

  test("symlink loop", async () => {
    await same(await pairWith((e) => {
      rmSync(e.vault);
      symlinkSync("loop", join(e.dataHome, "passh", "loop2"));
      symlinkSync("loop2", join(e.dataHome, "passh", "loop"));
      symlinkSync("loop", e.vault);
    }));
  });

  test("vault path through a file (not a directory)", async () => {
    const p = await pairWith((e) => placeVault(join(e.home, "f"), vault.bytes));
    await same(p, ["--vault", "~/f/x.passh", "doctor"]);
  });

  test("state folder exists, mode 0700", async () => {
    await same(await pairWith((e) => mkdirSync(join(e.stateHome, "passh"), { mode: 0o700 })));
  });

  for (const mode of [0o755, 0o750, 0o701, 0o300]) {
    test(`state folder mode ${mode.toString(8)}`, async () => {
      await same(await pairWith((e) => {
        mkdirSync(join(e.stateHome, "passh"));
        chmodSync(join(e.stateHome, "passh"), mode);
      }));
    });
  }

  test.skipIf(isRoot)("state folder not writable (0500, 0600)", async () => {
    for (const mode of [0o500, 0o600]) {
      await same(await pairWith((e) => {
        mkdirSync(join(e.stateHome, "passh"));
        chmodSync(join(e.stateHome, "passh"), mode);
      }));
    }
  });

  test("state folder is a file, or a symlink", async () => {
    await same(await pairWith((e) => writeFileSync(join(e.stateHome, "passh"), "")));
    await same(await pairWith((e) => {
      mkdirSync(join(e.home, "elsewhere"));
      symlinkSync(join(e.home, "elsewhere"), join(e.stateHome, "passh"));
    }));
  });

  test("agent folder: 0700, 0755, a symlink", async () => {
    for (const make of [
      (d: string) => mkdirSync(d, { mode: 0o700 }),
      (d: string) => {
        mkdirSync(d);
        chmodSync(d, 0o755);
      },
      (d: string) => symlinkSync("/tmp", d),
    ]) {
      await same(await pairWith((e) => {
        mkdirSync(join(e.stateHome, "passh"), { mode: 0o700 });
        make(join(e.stateHome, "passh", "agent"));
      }));
    }
  });

  test("$HOME unset, relative, and $XDG_STATE_HOME unset", async () => {
    const p = await pairWith();
    await same(p, ["doctor"], { unset: ["HOME"] });
    await same(p, ["doctor"], { env: { HOME: "rel" } });
    await same(p, ["doctor"], { env: { HOME: "rel" }, unset: ["XDG_STATE_HOME"] });
    await same(p, ["--vault", "/nonexistent.passh", "doctor"], { unset: ["HOME", "PASSH_CONFIG", "XDG_CONFIG_HOME"] });
  });

  test("leftover edit folders (folders only)", async () => {
    const p = await pairWith((e) => {
      mkdirSync(join(e.runtimeDir, "passh-edit-b"));
      mkdirSync(join(e.runtimeDir, "passh-edit-a"));
      writeFileSync(join(e.runtimeDir, "passh-edit-file"), "");
      symlinkSync("/tmp", join(e.runtimeDir, "passh-edit-link"));
    });
    const r = await same(p);
    expect(r.stdout).toContain("<RUN>/passh-edit-a, <RUN>/passh-edit-b; delete them (rm -r)");
  });

  test("leftover edit folder under $HOME", async () => {
    const p = await pairWith((e) => mkdirSync(join(e.home, "run", "passh-edit-x"), { recursive: true }));
    const r = await same(p, ["doctor"], { env: (e) => ({ XDG_RUNTIME_DIR: join(e.home, "run") }) });
    expect(r.stdout).toContain("plain text: ~/run/passh-edit-x; delete them (rm -r)");
    await same(p, ["doctor"], { env: { XDG_RUNTIME_DIR: "" } });
  });

  test("clipboard notes need a terminal", async () => {
    await same(await pairWith(), ["doctor"], { env: { TMUX: "x", STY: "y", TERM_PROGRAM: "Apple_Terminal" } });
  });

  test("a doctor argument is a usage error", async () => {
    await same(await pairWith(), ["doctor", "x"]);
  });
});

describe("doctor with an agent", () => {
  test("running agent (each side's own, started by its own unlock)", async () => {
    const p = await pairWith();
    try {
      const u = await bothMore(p, ["unlock"], { pty: true, steps: [PASSPHRASE_STEP] });
      expect(visible(u.ours)).toEqual(visible(u.ref));
      expect(u.ref.code).toBe(0);
      const r = await same(p);
      expect(r.stdout).toContain("info   agent         running: the agent (pid N) exits in <T>");
      expect(r.stdout).toContain("ok     agent folder  <ENV>/st/passh/agent (0700, yours)");
    } finally {
      await bothMore(p, ["lock"]);
      killAgentsUnder(p.ref.dir);
      killAgentsUnder(p.ours.dir);
    }
  });
});

describe("doctor on a terminal: the clipboard test", () => {
  async function samePty(p: Pair, o: MoreRunOptions = {}) {
    const r = await bothMore(p, ["doctor"], { pty: true, ...o });
    expect(visible(r.ours)).toEqual(visible(r.ref));
    return r.ref;
  }

  test("clipboard.command that works (clear_after 1s), with the tmux, screen and Terminal.app notes", async () => {
    const p = await pairWith(undefined, '[clipboard]\nclear_after = "1s"\ncommand = ["true"]\n');
    const r = await samePty(p, { env: { TMUX: "1", STY: "2", TERM_PROGRAM: "Apple_Terminal" } });
    expect(r.tty).toContain('Testing the clipboard: copied "passh clipboard test" (command "true"). Paste it somewhere to check; it is cleared in 1s.');
    expect(r.stdout).toContain('ok     clipboard     sent a test string with command "true" and cleared it');
    expect(r.stdout).toContain("ok     terminal      /dev/tty: passphrase prompts work");
  });

  test("empty TMUX/STY are not notes", async () => {
    const p = await pairWith(undefined, '[clipboard]\nclear_after = "1s"\ncommand = ["true"]\n');
    await samePty(p, { env: { TMUX: "", STY: "", TERM_PROGRAM: "iTerm.app" } });
  });

  test("a copy that fails, a clear that fails, a missing program, no clipboard", async () => {
    for (const extra of [
      '[clipboard]\nclear_after = "1s"\ncommand = ["false"]\n',
      '[clipboard]\nclear_after = "1s"\ncommand = ["sh", "-c", "read x; test -n \\"$x\\" || exit 3"]\n',
      '[clipboard]\ncommand = ["passh-no-such-program"]\n',
      "[clipboard]\nosc52 = false\n",
    ]) {
      const r = await samePty(await pairWith(undefined, extra));
      expect(r.stdout).toMatch(/(error|warn) {2,}clipboard/);
    }
  });

  test("OSC 52 through the terminal (waits 5 s)", async () => {
    const r = await samePty(await pairWith());
    expect(r.tty).toContain("\x1b]52;c;cGFzc2ggY2xpcGJvYXJkIHRlc3Q=\x07\x1b]52;c;\x07");
    expect(r.stdout).toContain("ok     clipboard     sent a test string with OSC 52 through the terminal and cleared it");
  }, 30_000);
});

describe("doctor helpers", () => {
  test("formatSize", () => {
    expect(formatSize(0n)).toBe("0 bytes");
    expect(formatSize(1n)).toBe("1 byte");
    expect(formatSize(1023n)).toBe("1023 bytes");
    expect(formatSize(1024n)).toBe("1 KiB");
    expect(formatSize(1024n * 1024n - 1n)).toBe("1023 KiB");
    expect(formatSize(256n * 1024n * 1024n)).toBe("256 MiB");
    expect(formatSize(999420n * 1024n)).toBe("975 MiB");
    expect(formatSize(1024n ** 3n)).toBe("1.0 GiB");
    // ties to even, as Go's %.1f
    expect(formatSize((1024n ** 3n * 5n) / 4n)).toBe("1.2 GiB");
    expect(formatSize((1024n ** 3n * 7n) / 4n)).toBe("1.8 GiB");
    expect(formatSize(14137752n * 1024n)).toBe("13.5 GiB");
  });

  test("memAvailable and parseSwaps", () => {
    expect(memAvailable("MemTotal:  100 kB\nMemAvailable:    14137752 kB\n")).toBe(14137752n * 1024n);
    expect(memAvailable("MemTotal: 1 kB\n")).toBeUndefined();
    expect(parseSwaps("Filename\tType\tSize\tUsed\tPriority\n")).toEqual({ count: 0, bytes: 0n });
    expect(parseSwaps("Filename Type Size Used Priority\n/dev/dm-1  partition\t999420\t0\t-2\n/swapfile file 1024 0 -3\n")).toEqual({ count: 2, bytes: 1000444n * 1024n });
  });
});

// The single-run checks that don't compare (each side's own agent pid etc.).
test("ours alone: report layout and exit status", async () => {
  const p = await pairWith(undefined, "", null);
  const r = await runMore("ours", p.ours, ["doctor"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toBe("");
  const lines = r.stdout.trimEnd().split("\n");
  expect(lines.at(-1)).toMatch(/^\d+ errors?, \d+ warnings?\.$/);
  for (const l of lines.slice(0, -1)) expect(l).toMatch(/^(ok|info|skip|warn|error) {2,6}[a-z ]{12}  \S/);
});
