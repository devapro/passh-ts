// Interop of the config layer (src/config, src/fsx) with the reference implementation
// (reference/passh-go, run as a black box):
//
//   a. config files: valid ones, unknown keys, bad types, bad durations, several problems,
//      TOML 1.1 syntax, language errors: passh-go's stderr and exit status (via
//      `passh-go backups`, which needs no passphrase) against what loadConfig produces;
//   b. location rules: missing files with and without --vault, $PASSH_CONFIG vs --config,
//      $HOME unset, read errors;
//   c. the language chosen before parsing (i18n.md §2);
//   d. the config file `passh init` writes, byte for byte;
//   e. the agent folder and socket: the folder doctor names (and its fallback), the
//      socket `unlock` creates, and the folder-check messages of `lock`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isolatedEnv, REF_BIN, run, type IsolatedEnv } from "../helpers/env.ts";
import { initVault, PASS } from "../helpers/passh.ts";
import { spawnPty } from "../helpers/pty.ts";
import { escapeMultiline } from "../../src/sanitize/index.ts";
import { agentSocketPath, chooseLanguage, configFileText, loadConfig, realPath, tildePath, type LoadOptions } from "../../src/config/index.ts";

const envs: IsolatedEnv[] = [];
afterAll(() => envs.forEach((e) => e.cleanup()));
function env(name = "icfg"): IsolatedEnv {
  const e = isolatedEnv(name);
  envs.push(e);
  return e;
}

/** What our loader gives: the stderr line(s) of the error, or the config. */
function ours(opts: LoadOptions) {
  try {
    return { ok: true as const, config: loadConfig(opts) };
  } catch (e) {
    return { ok: false as const, stderr: `passh: ${escapeMultiline((e as Error).message)}\n` };
  }
}

/** Compares one setup: passh-go backups vs loadConfig. `form`: only the one-line form of a decoder error binds. */
async function compare(e: IsolatedEnv, args: string[], opts: LoadOptions, form = false, cwd?: string) {
  const ref = await run([REF_BIN, "backups", ...args], e.env as Record<string, string>, { cwd });
  const got = ours({ ...opts, env: e.env, cwd: cwd ?? process.cwd() });
  if (!got.ok) {
    expect(ref.code).toBe(1);
    if (form) {
      // storage.md §2.2 step 2: one problem line, `config <abs>: <decoder message>`.
      const prefix = got.stderr.slice(0, got.stderr.indexOf(": line ") + 2);
      expect(prefix.startsWith("passh: config ")).toBe(true);
      expect(ref.stderr.startsWith(prefix)).toBe(true);
      expect(ref.stderr.split("\n").length).toBe(2);
      expect(got.stderr.split("\n").length).toBe(2);
    } else {
      expect(got.stderr).toBe(ref.stderr);
    }
    return;
  }
  // A config that loads: passh-go goes on to `backups` (exit 0) and its notes show the
  // vault path and backup.keep.
  expect(ref.stderr).not.toContain("passh: config");
  expect(ref.code).toBe(0);
  const c = got.config;
  expect(ref.stderr).toContain(`(backup.keep = ${c.backup.keep})`);
  // `passh: note: <~path> can't be read (…)` (translated when the config says so)
  expect(ref.stderr).toContain(escapeMultiline(`: ${tildePath(c.vault, e.env)} `));
}

const V = 'vault = "~/v.passh"\n';

/** [name, config text, decoder error whose text isn't normative] */
const FILES: Array<[string, string, boolean?]> = [
  ["valid", V],
  ["every key", `vault = "/a//b/../c/./v.passh/"\nlanguage = "en"\n[session]\nidle_ttl = "1h30m"\nstop_agent = false\n[agent]\nidle_ttl = "90s"\nmax_ttl = "1.5h"\n[backup]\nkeep = 3\n[rollback]\nwarn = false\n[clipboard]\nclear_after = "500ms"\nosc52 = false\ncommand = ["wl-copy"]\n[print_web]\nenabled = true\nport = 9443\ninterfaces = ["tailscale0"]\nhostnames = ["pi.local"]\nallow_from = ["10.1.2.3/8", "FD00::1/8"]\nttl = "15m"\n`],
  ["init template", readFileSync(join(import.meta.dir, "../../spec/spec.md"), "utf8").split("```toml\n")[1]!.split("```\n")[0]!],
  ["unknown keys", V + "foo = 1\n[sesion]\nx=1\n[session]\nidel_ttl='5m'\n[agent]\nbad.dotted = 1\n"],
  ["unknown key order", V + "[session]\nfoo = 1\n[agent]\nbar = 1\n[session.baz]\nq=1\n[zzz]\n[aaa.b]\n"],
  ["unknown inline", V + 'session = {idle_ttl="5m", foo=1, sub={x=1}}\n'],
  ["unknown dotted", V + "session.foo.bar = 1\nsession.idle_ttl = '5m'\nagent.x = 2\n"],
  ["unknown int keys", V + "[session]\nb = 1\n2 = 1\na = 1\n"],
  ["unknown super table after", V + "[aaa.b]\nx=1\n[aaa]\ny=1\n"],
  ["unknown aot", V + "[[zzz]]\na=1\n[[zzz]]\nb=1\n"],
  ["unknown quoted", V + '"a b" = 1\n"q\\"x" = 1\n"" = 1\n"é" = 1\n"t\\tx" = 1\n\'lit\\x\' = 1\n"x\\u007fy" = 1\n"a.b" = 1\n[session]\n"idle_ttl" = "5m"\n"stop agent" = true\n'],
  ["unknown escapes", V + '"a\\bb" = 1\n"a\\nb" = 1\n"a\\fb" = 1\n"a\\rb" = 1\n"a\\eb" = 1\n"a\\u0001b" = 1\n"a\\u001fb" = 1\n"a\\u0080b" = 1\n"a\\u2028b" = 1\n"a\\U0001F600b" = 1\n"a\'b" = 1\n"a\\u0000b"=1\n'],
  ["unknown bare", V + "A-b_9 = 1\n1234 = 1\n-x = 1\n"],
  ["unknown + check", V + "[print_web]\nport = -1\nport2=1\n"],
  ["unknown + type", V + "foo = 1\n[session]\nidle_ttl = 5\n"],
  ["type int for string", V + "[session]\nidle_ttl = 5\n"],
  ["type string for slice", V + "[print_web]\ninterfaces = 'wg0'\n"],
  ["type mixed array", V + "[clipboard]\ncommand = ['a', 1]\n"],
  ["type float", V + "[backup]\nkeep = 1.5\n"],
  ["type bool", V + "[rollback]\nwarn = 'yes'\n"],
  ["type vault int", "vault = 5\n"],
  ["type vault array", 'vault = ["a"]\n'],
  ["type vault table", "vault = {a=1}\n"],
  ["type datetime", V + "[session]\nidle_ttl = 1979-05-27T07:32:00Z\n"],
  ["type local time", V + "[session]\nidle_ttl = 07:32\n"],
  ["type table int", V + "session = 5\n"],
  ["type table agent", V + "agent = 5\n"],
  ["type table backup", V + "backup = 5\n"],
  ["type table rollback", V + "rollback = 5\n"],
  ["type table clipboard", V + "clipboard = 5\n"],
  ["type table print_web", V + 'print_web = "x"\n'],
  ["type aot", V + "[[session]]\nidle_ttl='5m'\n"],
  ["type aot strings", V + "[[clipboard.command]]\nx=1\n"],
  ["durations", V + '[session]\nidle_ttl = "5"\n[agent]\nidle_ttl="-1s"\nmax_ttl="0"\n'],
  ["duration huge", V + '[session]\nidle_ttl = "2562048h"\n'],
  ["duration max", V + '[session]\nidle_ttl = "2562047h"\n'],
  ["duration space", V + '[session]\nidle_ttl = " 5m"\n'],
  ["duration day", V + '[session]\nidle_ttl = "1d"\n'],
  ["duration micro", V + '[session]\nidle_ttl = "5µs"\n[agent]\nidle_ttl="5μs"\nmax_ttl=".5s"\n[clipboard]\nclear_after="5.s"\n'],
  ["duration dot", V + '[session]\nidle_ttl = "."\n[agent]\nidle_ttl="+5m"\nmax_ttl="1h-5m"\n'],
  ["ttl range", V + '[print_web]\nttl = "30s"\n'],
  ["ttl bad", V + '[print_web]\nttl = "bad"\n'],
  ["ttl negative", V + '[print_web]\nttl = "-5m"\n'],
  ["ttl zero", V + '[print_web]\nttl = "0"\n'],
  ["ttl just over", V + '[print_web]\nttl = "15m0.000000001s"\n'],
  ["ttl edges", V + '[print_web]\nttl = "60s"\n'],
  ["several", 'vault = "rel/v"\nlanguage="de"\n[backup]\nkeep=-1\n[print_web]\nport=0\nttl="30s"\ninterfaces=["a b",""]\nallow_from=["10.0.0.1","fe80::1%eth0/64","10.1.2.3/8"]\n[clipboard]\ncommand=["  "]\n'],
  ["names", V + '[print_web]\ninterfaces = ["a\\u00a0b", "a\\u0085b", "c\\u200bd", "e\\u007f", "ok-é", "x\\u2028"]\nhostnames = ["", "h h", "fine.local"]\n'],
  ["cidrs", V + '[print_web]\nallow_from = ["10.0.0.0/8", "010.0.0.0/8", "10.0.0.0/08", "10.0.0.0/33", " 10.0.0.0/8", "::ffff:1.2.3.4/104", "fd00::/8", "FD00::/8", "fe80::/10", "1.2.3.4/32", "::/0", "0.0.0.0/0", "10.0.0.0/+8", "10.0.0/8", "fd00::/129", "fd00::%eth0/8", "1:2:3:4:5:6:1.2.3.4/128", "::1::/64", "12345::/16"]\n'],
  ["keep", V + "[backup]\nkeep = 1000001\n"],
  ["keep max", V + "[backup]\nkeep = 9223372036854775807\n"],
  ["keep min", V + "[backup]\nkeep = -9223372036854775808\n"],
  ["keep formats", V + "[backup]\nkeep = 0x10\n[print_web]\nport = 1_000\n"],
  ["keep -0", V + "[backup]\nkeep = -0\n"],
  ["command blank", V + '[clipboard]\ncommand = [" \\t"]\n'],
  ["command empty first", V + '[clipboard]\ncommand = ["", "x"]\n'],
  ["command nbsp", V + '[clipboard]\ncommand = ["\\u00a0"]\n'],
  ["command ok", V + '[clipboard]\ncommand = ["x", ""]\n'],
  ["vault required", 'language = "en"\n'],
  ["empty file", ""],
  ["vault empty", 'vault = ""\n'],
  ["vault ~", 'vault = "~"\n'],
  ["vault ~user", 'vault = "~bob/v"\n'],
  ["vault ./", 'vault = "./v"\n'],
  ["vault cleaned", 'vault = "~/x/../../v.passh"\n'],
  ["language EN", V + 'language = "EN"\n'],
  ["language space", V + 'language = " ru"\n'],
  ["language empty", V + 'language = ""\n'],
  ["language de + unknown", 'language = "de"\nfoo = 1\n'],
  ["toml 1.1", 'vault = "~/v\\e.passh"\nlanguage = "\\x65n"\nsession = {\n  idle_ttl = "1m",\n  stop_agent = false,\n}\n'],
  ["toml 1.1 inline", V + "print_web = { enabled = true,\n port = 9000, # comment\n }\n"],
  ["toml 1.1 escapes", V + '[clipboard]\ncommand = ["a\\eb", "\\xff"]\n'],
  ["toml 1.1 times", V + "x = 1979-05-27T07:32Z\ny = 07:32\n"],
  ["toml values", V + 'x = """\na\\\n  b"""\ny = \'\'\'\nc\'\'\'\nz = [1,2,]\nw = inf\nv = nan\nu = -0.0\nt = 1e10\ns = {}\n'],
  ["bom", "\ufeff" + V],
  ["ws in headers", V + '[session]\nidle_ttl = "5m"\n  [ agent . "x" ]\n'],
  ["dotted known keys", V + 'session.idle_ttl = "7m"\nprint_web.port = 9000\n'],
  ["crlf", V.replace("\n", "\r\n") + '[session]\r\nidle_ttl = "1m"\r\n'],
  ["dup key", 'vault = "~/v"\nvault = "~/w"\n', true],
  ["dup table", V + "[session]\n[session]\n", true],
  ["syntax table", V + "[session\n", true],
  ["syntax value", V + "x = \n", true],
  ["syntax escape", V + 'x = "\\q"\n', true],
  ["syntax hex", V + 'x = "\\x4"\n', true],
  ["syntax ctrl", V + 'x = "a\x01b"\n', true],
  ["syntax del", V + 'x = "a\x7fb"\n', true],
  ["syntax cr", V + "x = 1\rz = 2\n", true],
  ["syntax comment ctrl", V + "# a\x01b\n", true],
  ["syntax leading zero", V + "[backup]\nkeep = 05\n", true],
  ["syntax big int", V + "[backup]\nkeep = 99999999999999999999\n", true],
  ["syntax unicode key", V + "é = 1\n", true],
  ["syntax array extend", V + "x = [1]\n[[x]]\n", true],
];

describe("a. config files: passh-go vs loadConfig", () => {
  let e: IsolatedEnv;
  beforeAll(() => {
    e = env();
    mkdirSync(dirname(e.configFile), { recursive: true });
  });
  for (const [name, text, form] of FILES) {
    test(name, async () => {
      writeFileSync(e.configFile, text);
      await compare(e, [], {}, form);
    });
  }
  test("invalid UTF-8", async () => {
    writeFileSync(e.configFile, Buffer.concat([Buffer.from(V + 'x = "a'), Buffer.from([0xff]), Buffer.from('"\n')]));
    await compare(e, [], {}, true);
  });
  test("the language problem is English", async () => {
    writeFileSync(e.configFile, V + 'language = "ru"\nfoo = 1\n');
    await compare(e, [], {});
  });
});

describe("b. location", () => {
  test("missing files, --config, $PASSH_CONFIG, --vault", async () => {
    const e = env();
    const nope = join(e.dir, "nope.toml");
    await compare(e, [], {});
    await compare(e, ["--vault", "/x/v.passh"], { vaultFlag: "/x/v.passh" });
    await compare(e, ["--config", nope], { configFlag: nope });
    await compare(e, ["--config", nope, "--vault", "/x/v"], { configFlag: nope, vaultFlag: "/x/v" });
    await compare(e, ["--config", ""], { configFlag: "" });
    await compare(e, ["--vault", ""], { vaultFlag: "" });
    const noEnv = { ...e, env: { ...e.env, PASSH_CONFIG: "" } } as unknown as IsolatedEnv;
    await compare(noEnv, [], {});
    await compare(noEnv, ["--vault", "/x/v"], { vaultFlag: "/x/v" });
    symlinkSync(join(e.dir, "dangling"), join(e.dir, "dl.toml"));
    await compare(e, ["--config", join(e.dir, "dl.toml")], { configFlag: join(e.dir, "dl.toml") });
  });
  test("relative paths and ~", async () => {
    const e = env();
    mkdirSync(join(e.dir, "w"));
    writeFileSync(join(e.dir, "w", "rel.toml"), 'vault = "/x/y"\n');
    await compare(e, ["--config", "rel.toml"], { configFlag: "rel.toml" }, false, join(e.dir, "w"));
    const rel = { ...e, env: { ...e.env, PASSH_CONFIG: "./rel.toml" } } as unknown as IsolatedEnv;
    await compare(rel, [], {}, false, join(e.dir, "w"));
    await compare(e, ["--vault", "a/../b/./v"], { vaultFlag: "a/../b/./v" }, false, e.dir);
    await compare(e, ["--vault", "~"], { vaultFlag: "~" });
    await compare(e, ["--vault", "~x/v"], { vaultFlag: "~x/v" }, false, e.dir);
    writeFileSync(join(e.home, "c.toml"), 'vault = "~/v.passh"\n');
    await compare(e, ["--config", "~/c.toml"], { configFlag: "~/c.toml" });
    const slash = { ...e, env: { ...e.env, HOME: e.home + "/" } } as unknown as IsolatedEnv;
    await compare(slash, ["--config", "~/c.toml"], { configFlag: "~/c.toml" });
  });
  test("$HOME unset or not absolute", async () => {
    const e = env();
    const without = (over: Record<string, string | undefined>) => ({ ...e, env: { ...e.env, ...over } }) as unknown as IsolatedEnv;
    const noHome = without({ HOME: undefined });
    const bare = without({ HOME: undefined, XDG_CONFIG_HOME: undefined, PASSH_CONFIG: undefined });
    await compare(noHome, [], {});
    await compare(noHome, ["--vault", "/x/v"], { vaultFlag: "/x/v" });
    await compare(noHome, ["--vault", "~/v"], { vaultFlag: "~/v" });
    await compare(noHome, ["--config", "~/c.toml", "--vault", "/x/v"], { configFlag: "~/c.toml", vaultFlag: "/x/v" });
    await compare(without({ HOME: undefined, PASSH_CONFIG: "~/c.toml" }), [], {});
    await compare(without({ HOME: undefined, PASSH_CONFIG: "~/c.toml" }), ["--vault", "/x/v"], { vaultFlag: "/x/v" });
    await compare(bare, [], {});
    await compare(bare, ["--vault", "/x/v"], { vaultFlag: "/x/v" });
    await compare(without({ HOME: "rel/home", PASSH_CONFIG: undefined, XDG_CONFIG_HOME: undefined }), [], {});
    await compare(without({ HOME: "", PASSH_CONFIG: undefined, XDG_CONFIG_HOME: undefined }), [], {});
    await compare(without({ PASSH_CONFIG: undefined, XDG_CONFIG_HOME: "rel" }), [], {});
    writeFileSync(join(e.dir, "c.toml"), 'vault = "~/v.passh"\nlanguage = "de"\n');
    await compare(noHome, ["--config", join(e.dir, "c.toml")], { configFlag: join(e.dir, "c.toml") });
    await compare(without({ HOME: "rel" }), ["--config", join(e.dir, "c.toml")], { configFlag: join(e.dir, "c.toml") });
    writeFileSync(join(e.dir, "c2.toml"), 'vault = "~/v.passh"\n');
    await compare(without({ HOME: "/" }), ["--config", join(e.dir, "c2.toml")], { configFlag: join(e.dir, "c2.toml") });
  });
  test("read errors and limits", async () => {
    const e = env();
    mkdirSync(join(e.dir, "cdir"));
    await compare(e, ["--config", join(e.dir, "cdir")], { configFlag: join(e.dir, "cdir") });
    writeFileSync(join(e.dir, "c000.toml"), 'vault = "/x"\n');
    chmodSync(join(e.dir, "c000.toml"), 0);
    await compare(e, ["--config", join(e.dir, "c000.toml")], { configFlag: join(e.dir, "c000.toml") });
    mkdirSync(join(e.dir, "p000"));
    writeFileSync(join(e.dir, "p000", "c.toml"), 'vault = "/x"\n');
    chmodSync(join(e.dir, "p000"), 0);
    await compare(e, ["--config", join(e.dir, "p000", "c.toml"), "--vault", "/x"], { configFlag: join(e.dir, "p000", "c.toml"), vaultFlag: "/x" });
    const viaEnv = { ...e, env: { ...e.env, PASSH_CONFIG: join(e.dir, "p000", "c.toml") } } as unknown as IsolatedEnv;
    await compare(viaEnv, ["--vault", "/x"], { vaultFlag: "/x" });
    chmodSync(join(e.dir, "p000"), 0o700);
    const big = join(e.dir, "big.toml");
    writeFileSync(big, 'vault = "/x"\n' + "#".repeat(1024 * 1024));
    await compare(e, ["--config", big], { configFlag: big });
    writeFileSync(big, ('vault = "/x"\n' + "#".repeat(1024 * 1024)).slice(0, 1024 * 1024));
    await compare(e, ["--config", big], { configFlag: big });
  });
  test("the file's vault is checked even with --vault", async () => {
    const e = env();
    mkdirSync(dirname(e.configFile), { recursive: true });
    for (const t of ['vault = "rel"\n', 'vault = ""\n', 'language = "ru"\n']) {
      writeFileSync(e.configFile, t);
      await compare(e, ["--vault", "/x"], { vaultFlag: "/x" });
    }
    writeFileSync(e.configFile, 'vault = "~/v"\n');
    await compare({ ...e, env: { ...e.env, HOME: undefined } } as unknown as IsolatedEnv, ["--vault", "/x"], { vaultFlag: "/x" });
  });
});

describe("c. the language chosen before parsing", () => {
  const cases: Array<[string, string | undefined, string[]]> = [
    ["ru", 'vault = "/x"\nlanguage = "ru"\n', []],
    ["ru + --vault", 'vault = "/x"\nlanguage = "ru"\n', ["--vault", "/y"]],
    ["sr without vault + --vault", 'language = "sr"\n', ["--vault", "/y"]],
    ["sr without vault", 'language = "sr"\n', []],
    ["broken", 'vault = "/x"\nlanguage = "ru"\nfoo = 1\n', []],
    ["bad language", 'vault = "/x"\nlanguage = "Ru"\n', []],
    ["missing", undefined, []],
    ["missing + --vault", undefined, ["--vault", "/y"]],
    ["after --", 'vault = "/x"\nlanguage = "ru"\n', ["--config=/nonexistent"]],
  ];
  for (const [name, text, extra] of cases) {
    test(name, async () => {
      const e = env("ilang");
      if (text !== undefined) {
        mkdirSync(dirname(e.configFile), { recursive: true });
        writeFileSync(e.configFile, text);
      }
      const args = [...extra, "--bogus"];
      const ref = await run([REF_BIN, ...args], e.env);
      expect(ref.code).toBe(2);
      const refEnglish = ref.stderr.includes("unknown flag: --bogus");
      expect(chooseLanguage(args, e.env) === "en").toBe(refEnglish);
    });
  }
  test("--config named on the command line", async () => {
    const e = env("ilang");
    const p = join(e.dir, "other.toml");
    writeFileSync(p, 'vault = "/x"\nlanguage = "ru"\n');
    for (const args of [["--config", p, "--bogus"], [`--config=${p}`, "--bogus"], ["--configx", p], ["--config=" + join(e.dir, "none"), "--", "--config", p]]) {
      const ref = await run([REF_BIN, ...args], e.env);
      const refEnglish = !/неизвестн/.test(ref.stderr);
      expect(chooseLanguage(args, e.env) === "en").toBe(refEnglish);
    }
  });
});

describe("d. the config file passh init writes", () => {
  test("default vault under $HOME: the spec block itself", async () => {
    const e = env("iinit");
    const ev = { ...e, env: { ...e.env, XDG_DATA_HOME: "" } } as unknown as IsolatedEnv;
    await initVault([REF_BIN], ev);
    const vault = join(e.home, ".local/share/passh/vault.passh");
    expect(existsSync(vault)).toBe(true);
    expect(readFileSync(e.configFile, "utf8")).toBe(configFileText(vault, ev.env));
  }, 60_000);
  test("vault paths: outside $HOME, odd characters", async () => {
    for (const v of [(e: IsolatedEnv) => join(e.dir, "outside", "v.passh"), (e: IsolatedEnv) => join(e.home, 'a"b\\c\x01d\x7fé\x1b', "v.passh")]) {
      const e = env("iinit");
      const path = v(e);
      await initVault([REF_BIN], e, PASS, ["--vault", path]);
      const written = readFileSync(e.configFile, "utf8");
      expect(written).toBe(configFileText(path, e.env));
      // ... and our loader reads it back to the same vault
      expect(loadConfig({ env: e.env }).vault).toBe(path);
    }
  }, 60_000);
});

describe("e. agent folder and socket", () => {
  let e: IsolatedEnv;
  beforeAll(async () => {
    e = env("iag");
    await initVault([REF_BIN], e);
  }, 60_000);
  afterAll(async () => {
    await run([REF_BIN, "lock"], e.env);
  });

  const doctorAgentFolder = async (over: Record<string, string | undefined>) => {
    const r = await run([REF_BIN, "doctor"], { ...e.env, ...over } as Record<string, string>);
    const line = r.stdout.split("\n").find((l) => l.includes("agent folder"))!;
    return line;
  };
  test("the folder doctor names, and the fallback for long state paths", async () => {
    const real = realPath(e.vault);
    let line = await doctorAgentFolder({});
    expect(line).toContain(`${agentSocketPath(real, { env: e.env }).dir} doesn't exist yet`);
    const longState = join(e.dir, "s".repeat(70));
    mkdirSync(longState, { recursive: true });
    const env2 = { ...e.env, XDG_STATE_HOME: longState };
    const s = agentSocketPath(real, { env: env2 });
    expect(s.inState).toBe(false);
    expect(s.dir).toBe(join(e.tmpDir, `passh-${process.getuid!()}`));
    line = await doctorAgentFolder({ XDG_STATE_HOME: longState });
    expect(line).toContain(`${s.dir} doesn't exist yet`);
    const s3 = agentSocketPath(real, { env: { ...env2, TMPDIR: "/" + "t".repeat(90) } });
    expect(s3.dir).toBe(`/tmp/passh-${process.getuid!()}`);
    line = await doctorAgentFolder({ XDG_STATE_HOME: longState, TMPDIR: "/" + "t".repeat(90) });
    expect(line).toContain(`${s3.dir}`);
  });
  test("folder check messages of `lock`", async () => {
    const s = agentSocketPath(realPath(e.vault), { env: e.env });
    const check = async () => {
      const r = await run([REF_BIN, "lock"], e.env);
      const { checkPrivateDir } = await import("../../src/config/index.ts");
      let mine = "";
      try {
        checkPrivateDir(s.dir);
      } catch (err) {
        mine = `passh: agent: ${(err as Error).message}\n`;
      }
      expect(r.stderr).toBe(mine);
    };
    mkdirSync(s.dir, { recursive: true });
    for (const mode of [0o755, 0o2700, 0o1700]) {
      chmodSync(s.dir, mode);
      await check();
    }
    if (process.getuid!() !== 0) {
      chmodSync(s.dir, 0);
      await check();
    }
    chmodSync(s.dir, 0o700);
    rmSync(s.dir, { recursive: true });
    mkdirSync(join(e.dir, "realagent"), { mode: 0o700 });
    symlinkSync(join(e.dir, "realagent"), s.dir);
    await check();
    rmSync(s.dir);
    writeFileSync(s.dir, "");
    await check();
    rmSync(s.dir);
  });
  test("the socket unlock creates, also through a symlinked vault path", async () => {
    symlinkSync(dirname(e.vault), join(e.dir, "vlink"));
    const viaLink = join(e.dir, "vlink", "vault.passh");
    const s = agentSocketPath(realPath(viaLink), { env: e.env });
    const p = spawnPty([REF_BIN, "--vault", viaLink, "unlock"], e.env);
    await p.expect("Passphrase: ");
    p.line(PASS);
    const r = await p.wait(30_000);
    expect(r.code).toBe(0);
    try {
      expect(existsSync(s.path)).toBe(true);
    } finally {
      await run([REF_BIN, "lock"], e.env);
    }
    expect(existsSync(s.path)).toBe(false);
  }, 60_000);
});
