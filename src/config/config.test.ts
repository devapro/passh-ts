import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hasCode } from "../i18n/index.ts";
import { HOUR, MIN, MS, SEC } from "../util/duration.ts";
import { isolatedEnv, type IsolatedEnv } from "../../test/helpers/env.ts";
import { ConfigError, defaultConfig, loadConfig, locateConfig, parseConfig, unknownKeys } from "./config.ts";
import { parseToml } from "./toml.ts";

const HOME = "/home/u";
const P = "/c/config.toml";
const V = 'vault = "~/v.passh"\n';

function problems(text: string, opts: { vault?: string; env?: Record<string, string | undefined> } = {}): string {
  try {
    parseConfig(text, P, { env: opts.env ?? { HOME }, vault: opts.vault });
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    expect(hasCode(e, "config")).toBe(true);
    return (e as Error).message;
  }
  return "OK";
}
const one = (p: string) => `config ${P}: ${p}`;
const many = (...ps: string[]) => `config ${P}:` + ps.map((p) => "\n  " + p).join("");
const DUR = (k: string, v: string) => `${k}: "${v}" is not a duration such as "30s", "5m" or "2h"`;

describe("parseConfig: values", () => {
  test("defaults", () => {
    const c = parseConfig(V, P, { env: { HOME } });
    const d = defaultConfig();
    expect(c.vault).toBe("/home/u/v.passh");
    expect(c.file).toBe(P);
    expect(c.vaultFromFlag).toBe(false);
    expect({ ...c, vault: "", file: undefined } as unknown).toEqual(d as unknown);
    expect(d.session).toEqual({ idleTTL: 5n * MIN, stopAgent: true });
    expect(d.agent).toEqual({ idleTTL: 15n * MIN, maxTTL: 2n * HOUR });
    expect(d.backup.keep).toBe(10);
    expect(d.rollback.warn).toBe(true);
    expect(d.clipboard).toEqual({ clearAfter: 30n * SEC, osc52: true, command: [] });
    expect(d.printWeb).toEqual({ enabled: false, port: 8443, interfaces: ["wg0", "eth0"], hostnames: [], allowFrom: [], ttl: 5n * MIN });
  });
  test("every key set", () => {
    const c = parseConfig(
      `vault = "/a//b/../c/./v.passh/"
language = "ru"
[session]
idle_ttl = "1h30m"
stop_agent = false
[agent]
idle_ttl = "90s"
max_ttl = "1.5h"
[backup]
keep = 0
[rollback]
warn = false
[clipboard]
clear_after = "500ms"
osc52 = false
command = ["wl-copy", "--type", ""]
[print_web]
enabled = true
port = 9443
interfaces = ["tailscale0"]
hostnames = ["pi.local"]
allow_from = ["10.1.2.3/8", "FD00::1/8", "::ffff:1.2.3.4/104", "0.0.0.0/0"]
ttl = "15m"
`,
      P,
      { env: { HOME } },
    );
    expect(c.vault).toBe("/a/c/v.passh");
    expect(c.language).toBe("ru");
    expect(c.session).toEqual({ idleTTL: 90n * MIN, stopAgent: false });
    expect(c.agent).toEqual({ idleTTL: 90n * SEC, maxTTL: 90n * MIN });
    expect(c.backup.keep).toBe(0);
    expect(c.rollback.warn).toBe(false);
    expect(c.clipboard).toEqual({ clearAfter: 500n * MS, osc52: false, command: ["wl-copy", "--type", ""] });
    expect(c.printWeb.enabled).toBe(true);
    expect(c.printWeb.port).toBe(9443);
    expect(c.printWeb.interfaces).toEqual(["tailscale0"]);
    expect(c.printWeb.hostnames).toEqual(["pi.local"]);
    expect(c.printWeb.allowFrom.map((x) => x.text)).toEqual(["10.0.0.0/8", "fd00::/8", "::ffff:1.0.0.0/104", "0.0.0.0/0"]);
    expect(c.printWeb.ttl).toBe(15n * MIN);
  });
  test("--vault replaces vault, which is then optional", () => {
    const c = parseConfig('language = "en"\n', P, { env: { HOME }, vault: "/x/v" });
    expect(c.vault).toBe("/x/v");
    expect(c.vaultFromFlag).toBe(true);
    // The file's vault is still checked.
    expect(problems('vault = "rel"\n', { vault: "/x" })).toBe(one('vault: "rel" must be an absolute path or start with ~/'));
    expect(problems('vault = ""\n', { vault: "/x" })).toBe(one("vault is empty"));
  });
  test("TOML 1.1 syntax", () => {
    const c = parseConfig('vault = "~/v\\e.passh"\nlanguage = "\\x65n"\nsession = {\n  idle_ttl = "1m",\n  stop_agent = false,\n}\n', P, { env: { HOME } });
    expect(c.vault).toBe("/home/u/v\x1b.passh");
    expect(c.language).toBe("en");
    expect(c.session).toEqual({ idleTTL: MIN, stopAgent: false });
  });
});

describe("parseConfig: problems", () => {
  test("vault", () => {
    expect(problems("")).toBe(one('vault is required, e.g. vault = "~/.local/share/passh/vault.passh"'));
    expect(problems("# hi\n")).toBe(one('vault is required, e.g. vault = "~/.local/share/passh/vault.passh"'));
    expect(problems('vault = ""')).toBe(one("vault is empty"));
    for (const v of ["~", "~bob/v", "./v", "rel/v", "x"]) expect(problems(`vault = "${v}"`)).toBe(one(`vault: "${v}" must be an absolute path or start with ~/`));
    expect(problems(V, { env: {} })).toBe(one("vault: $HOME is not set"));
    expect(problems(V, { env: { HOME: "rel" } })).toBe(one('vault: $HOME ("rel") is not an absolute path'));
    expect(parseConfig(V, P, { env: { HOME: "/" } }).vault).toBe("/v.passh");
    expect(parseConfig('vault = "~/x/../../v.passh"', P, { env: { HOME: "/h/u" } }).vault).toBe("/h/v.passh");
  });
  test("language (case-sensitive)", () => {
    for (const l of ["EN", "Ru", " ru", "sr-Latn", "de", ""]) expect(problems(V + `language = "${l}"`)).toBe(one(`language: "${l}" is not one of "en", "ru" or "sr"`));
    for (const l of ["en", "ru", "sr"]) expect(parseConfig(V + `language = "${l}"`, P, { env: { HOME } }).language).toBe(l as "en");
  });
  test("durations", () => {
    expect(problems(V + '[session]\nidle_ttl = "5"\n[agent]\nidle_ttl="-1s"\nmax_ttl="0"\n')).toBe(
      many(DUR("session.idle_ttl", "5"), 'agent.idle_ttl: "-1s" must be more than zero', 'agent.max_ttl: "0" must be more than zero'),
    );
    for (const bad of ["2562048h", " 5m", "1d", "5.", ".", "1h-5m", "5 m", "", "+", "1e3s"]) {
      expect(problems(V + `[clipboard]\nclear_after = "${bad}"`)).toBe(one(DUR("clipboard.clear_after", bad)));
    }
    const ok: Array<[string, bigint]> = [
      ["2562047h", 2562047n * HOUR],
      ["5µs", 5000n],
      ["5μs", 5000n],
      ["5us", 5000n],
      ["7ns", 7n],
      [".5s", 500n * MS],
      ["5.s", 5n * SEC],
      ["+5m", 5n * MIN],
      ["1h30m", 90n * MIN],
      ["1.5h", 90n * MIN],
    ];
    for (const [s, d] of ok) expect(parseConfig(V + `[agent]\nmax_ttl = "${s}"`, P, { env: { HOME } }).agent.maxTTL).toBe(d);
  });
  test("print_web.ttl between 1m and 15m", () => {
    expect(problems(V + '[print_web]\nttl = "30s"')).toBe(one('print_web.ttl: "30s" is not between 1m and 15m'));
    expect(problems(V + '[print_web]\nttl = "15m0.000000001s"')).toBe(one('print_web.ttl: "15m0.000000001s" is not between 1m and 15m'));
    expect(problems(V + '[print_web]\nttl = "bad"')).toBe(one(DUR("print_web.ttl", "bad")));
    expect(problems(V + '[print_web]\nttl = "-5m"')).toBe(one('print_web.ttl: "-5m" must be more than zero'));
    expect(problems(V + '[print_web]\nttl = "0"')).toBe(one('print_web.ttl: "0" must be more than zero'));
    expect(parseConfig(V + '[print_web]\nttl = "1m"', P, { env: { HOME } }).printWeb.ttl).toBe(MIN);
    expect(parseConfig(V + '[print_web]\nttl = "60s"', P, { env: { HOME } }).printWeb.ttl).toBe(MIN);
  });
  test("backup.keep", () => {
    expect(problems(V + "[backup]\nkeep = -1")).toBe(one("backup.keep: -1 must be 0 or more"));
    expect(problems(V + "[backup]\nkeep = 1000001")).toBe(one("backup.keep: 1000001 is more than 1000000"));
    expect(problems(V + "[backup]\nkeep = 9223372036854775807")).toBe(one("backup.keep: 9223372036854775807 is more than 1000000"));
    expect(problems(V + "[backup]\nkeep = -9223372036854775808")).toBe(one("backup.keep: -9223372036854775808 must be 0 or more"));
    expect(parseConfig(V + "[backup]\nkeep = 1000000", P, { env: { HOME } }).backup.keep).toBe(1_000_000);
    expect(parseConfig(V + "[backup]\nkeep = 0x10", P, { env: { HOME } }).backup.keep).toBe(16);
    expect(parseConfig(V + "[backup]\nkeep = -0", P, { env: { HOME } }).backup.keep).toBe(0);
  });
  test("clipboard.command", () => {
    const msg = one("clipboard.command: the program name (first element) is empty");
    for (const c of ['[" \\t"]', '["", "x"]', '["\\u00a0"]', '["\\u0085"]', '["\\u3000"]']) expect(problems(V + `[clipboard]\ncommand = ${c}`)).toBe(msg);
    expect(parseConfig(V + '[clipboard]\ncommand = ["x", ""]', P, { env: { HOME } }).clipboard.command).toEqual(["x", ""]);
    expect(parseConfig(V + '[clipboard]\ncommand = ["\\ufeff"]', P, { env: { HOME } }).clipboard.command).toEqual(["\ufeff"]);
  });
  test("print_web.port", () => {
    for (const p of ["0", "-1", "65536", "70000"]) expect(problems(V + `[print_web]\nport = ${p}`)).toBe(one(`print_web.port: ${p} is not between 1 and 65535`));
    expect(parseConfig(V + "[print_web]\nport = 1", P, { env: { HOME } }).printWeb.port).toBe(1);
    expect(parseConfig(V + "[print_web]\nport = 65535", P, { env: { HOME } }).printWeb.port).toBe(65535);
  });
  test("print_web.interfaces and hostnames", () => {
    expect(problems(V + '[print_web]\ninterfaces = ["a\\u00a0b", "a\\u0085b", "c\\u200bd", "e\\u007f", "ok-é", "x\\u2028", "t\\tx", "\\u0090"]\nhostnames = ["", "h h", "fine.local"]\n')).toBe(
      many(
        'print_web.interfaces: "a\\u00a0b" is not a valid name',
        'print_web.interfaces: "a\\u0085b" is not a valid name',
        'print_web.interfaces: "e\\x7f" is not a valid name',
        'print_web.interfaces: "x\\u2028" is not a valid name',
        'print_web.interfaces: "t\\tx" is not a valid name',
        'print_web.interfaces: "\\u0090" is not a valid name',
        'print_web.hostnames: "" is not a valid name',
        'print_web.hostnames: "h h" is not a valid name',
      ),
    );
  });
  test("print_web.allow_from", () => {
    const bad = ["010.0.0.0/8", "10.0.0.0/08", "10.0.0.0/33", " 10.0.0.0/8", "10.0.0.0/+8", "10.0.0/8", "fd00::/129", "fd00::%eth0/8", "10.0.0.1", "fe80::1%eth0/64", "fd00::", "10.0.0.0/", "/8", "1.2.3.4/-0", "::1::/64", "1:2:3:4:5:6:7:8:9/64", "1:2:3:4:5:6:7::8/64", "::ffff:1.2.3/104", "12345::/16"];
    const good = ["10.0.0.0/8", "::ffff:1.2.3.4/104", "fd00::/8", "FD00::/8", "fe80::/10", "1.2.3.4/32", "::/0", "0.0.0.0/0", "1:2:3:4:5:6:1.2.3.4/128", "::1.2.3.4/128", "2001:db8::/32"];
    const text = V + `[print_web]\nallow_from = [${[...bad, ...good].map((s) => JSON.stringify(s)).join(", ")}]\n`;
    expect(problems(text)).toBe(many(...bad.map((b) => `print_web.allow_from: ${JSON.stringify(b)} is not a CIDR such as "192.168.1.0/24" or "fd00::/8"`)));
    const c = parseConfig(V + `[print_web]\nallow_from = [${good.map((s) => JSON.stringify(s)).join(", ")}]\n`, P, { env: { HOME } });
    expect(c.printWeb.allowFrom.map((x) => x.text)).toEqual(["10.0.0.0/8", "::ffff:1.0.0.0/104", "fd00::/8", "fd00::/8", "fe80::/10", "1.2.3.4/32", "::/0", "0.0.0.0/0", "1:2:3:4:5:6:102:304/128", "::102:304/128", "2001:db8::/32"]);
  });
  test("several problems, in table order", () => {
    expect(problems('vault = "rel/v"\nlanguage="de"\n[backup]\nkeep=-1\n[print_web]\nport=0\nttl="30s"\ninterfaces=["a b",""]\nallow_from=["10.0.0.1","fe80::1%eth0/64","10.1.2.3/8"]\n[clipboard]\ncommand=["  "]\n')).toBe(
      many(
        'vault: "rel/v" must be an absolute path or start with ~/',
        'language: "de" is not one of "en", "ru" or "sr"',
        "backup.keep: -1 must be 0 or more",
        "clipboard.command: the program name (first element) is empty",
        "print_web.port: 0 is not between 1 and 65535",
        'print_web.interfaces: "a b" is not a valid name',
        'print_web.interfaces: "" is not a valid name',
        'print_web.allow_from: "10.0.0.1" is not a CIDR such as "192.168.1.0/24" or "fd00::/8"',
        'print_web.allow_from: "fe80::1%eth0/64" is not a CIDR such as "192.168.1.0/24" or "fd00::/8"',
        'print_web.ttl: "30s" is not between 1m and 15m',
      ),
    );
    expect(problems('vault = "~/v.passh"\nlanguage="de"\n', { env: {} })).toBe(many("vault: $HOME is not set", 'language: "de" is not one of "en", "ru" or "sr"'));
  });
  test("unknown keys in file order, then the checks", () => {
    expect(problems(V + "foo = 1\n[sesion]\nx=1\n[session]\nidel_ttl='5m'\n[agent]\nbad.dotted = 1\n")).toBe(
      many('unknown key "foo"', 'unknown key "sesion"', 'unknown key "session.idel_ttl"', 'unknown key "agent.bad.dotted"'),
    );
    expect(problems(V + "[session]\nfoo = 1\n[agent]\nbar = 1\n[session.baz]\nq=1\n[zzz]\n[aaa.b]\n")).toBe(
      many('unknown key "session.foo"', 'unknown key "agent.bar"', 'unknown key "session.baz"', 'unknown key "zzz"', 'unknown key "aaa.b"'),
    );
    expect(problems(V + 'session = {idle_ttl="5m", foo=1, sub={x=1}}\n')).toBe(many('unknown key "session.foo"', 'unknown key "session.sub"'));
    expect(problems(V + "session.foo.bar = 1\nsession.idle_ttl = '5m'\nagent.x = 2\n")).toBe(many('unknown key "session.foo.bar"', 'unknown key "agent.x"'));
    expect(problems(V + "[session]\nb = 1\n2 = 1\na = 1\n")).toBe(many('unknown key "session.b"', 'unknown key "session.2"', 'unknown key "session.a"'));
    expect(problems(V + "[aaa.b]\nx=1\n[aaa]\ny=1\n")).toBe(many('unknown key "aaa.b"', 'unknown key "aaa"'));
    expect(problems(V + "[[zzz]]\na=1\n[[zzz]]\nb=1\n")).toBe(many('unknown key "zzz"', 'unknown key "zzz"'));
    expect(problems(V + "[session]\nfoo.bar = 1\n")).toBe(one('unknown key "session.foo.bar"'));
    expect(problems(V + "x = {}\n")).toBe(one('unknown key "x"'));
    expect(problems(V + '"a b" = 1\n"q\\"x" = 1\n"" = 1\n"é" = 1\n"t\\tx" = 1\n\'lit\\x\' = 1\n"x\\u007fy" = 1\n"a.b" = 1\n[session]\n"idle_ttl" = "5m"\n"stop agent" = true\n')).toBe(
      many(
        'unknown key "\\"a b\\""',
        'unknown key "\\"q\\\\\\"x\\""',
        'unknown key "\\"\\""',
        'unknown key "\\"é\\""',
        'unknown key "\\"t\\\\tx\\""',
        'unknown key "\\"lit\\\\\\\\x\\""',
        'unknown key "\\"x\\\\u007fy\\""',
        'unknown key "\\"a.b\\""',
        'unknown key "session.\\"stop agent\\""',
      ),
    );
    expect(problems(V + '"a\\u0080b" = 1\n"a\\u2028b" = 1\n"a\\U0001F600b" = 1\n')).toBe(
      many('unknown key "\\"a\\u0080b\\""', 'unknown key "\\"a\\u2028b\\""', 'unknown key "\\"a😀b\\""'),
    );
    expect(problems(V + "[print_web]\nport = -1\nport2=1\n")).toBe(many('unknown key "print_web.port2"', "print_web.port: -1 is not between 1 and 65535"));
    expect(problems("language = 'de'\nfoo = 1\n")).toBe(
      many('unknown key "foo"', 'vault is required, e.g. vault = "~/.local/share/passh/vault.passh"', 'language: "de" is not one of "en", "ru" or "sr"'),
    );
  });
  test("unknownKeys: a key under an unknown key listed before is hidden", () => {
    const doc = parseToml("[a.b]\nx = 1\n[a]\ny = 1\n[a.b.c]\n");
    expect(unknownKeys(doc).map((k) => k.join("."))).toEqual(["a.b", "a"]);
  });
  test("decoder errors stop at one problem", () => {
    const T = (line: number, key: string, got: string, dest: string) => one(`line ${line} (last key "${key}"): incompatible types: TOML value has type ${got}; destination has type ${dest}`);
    expect(problems(V + "[session]\nidle_ttl = 5\n")).toBe(T(3, "session.idle_ttl", "int64", "string"));
    expect(problems(V + "foo = 1\n[session]\nidle_ttl = 5\n")).toBe(T(4, "session.idle_ttl", "int64", "string"));
    expect(problems(V + "[session]\nidle_ttl = 5\n[backup]\nkeep = 'x'\n")).toBe(T(3, "session.idle_ttl", "int64", "string"));
    expect(problems(V + "[print_web]\ninterfaces = 'wg0'\n")).toBe(T(3, "print_web.interfaces", "string", "slice"));
    expect(problems(V + "[clipboard]\ncommand = ['a', 1]\n")).toBe(T(3, "clipboard.command", "int64", "string"));
    expect(problems(V + "[backup]\nkeep = 1.5\n")).toBe(T(3, "backup.keep", "float64", "integer"));
    expect(problems(V + "[rollback]\nwarn = 'yes'\n")).toBe(T(3, "rollback.warn", "string", "boolean"));
    expect(problems("vault = 5\n")).toBe(T(1, "vault", "int64", "string"));
    expect(problems('vault = ["a"]\n')).toBe(T(1, "vault", "[]any", "string"));
    expect(problems("vault = {a=1}\n")).toBe(T(1, "vault", "map[string]any", "string"));
    expect(problems("vault = true\n")).toBe(T(1, "vault", "bool", "string"));
    expect(problems(V + "[session]\nidle_ttl = 1979-05-27\n")).toBe(T(3, "session.idle_ttl", "time.Time", "string"));
    expect(problems(V + "[clipboard]\ncommand = {a=1}\n")).toBe(T(3, "clipboard.command", "map[string]any", "slice"));
    expect(problems(V + "[[clipboard.command]]\nx=1\n")).toBe(T(2, "clipboard.command", "map[string]any", "string"));
    expect(problems(V + "session = 5\n")).toBe(
      one(`line 2 (last key "session"): type mismatch for struct { IdleTTL *string "toml:\\"idle_ttl\\""; StopAgent *bool "toml:\\"stop_agent\\"" }: expected table but found int64`),
    );
    expect(problems(V + "[[session]]\nidle_ttl='5m'\n")).toContain("expected table but found []map[string]any");
    expect(problems(V + "backup = 5\n")).toBe(one(`line 2 (last key "backup"): type mismatch for struct { Keep *int64 "toml:\\"keep\\"" }: expected table but found int64`));
    expect(problems(V + "[backup]\nkeep = 05\n")).toBe(one(`line 3 (last key "backup.keep"): Invalid integer "05": cannot have leading zeroes`));
    expect(problems(V + "[session]\n[session]\n")).toBe(one("line 3: Key 'session' has already been defined."));
    expect(problems('vault = "~/v"\nvault = "~/w"\n')).toBe(one(`line 2 (last key "vault"): Key 'vault' has already been defined.`));
  });
});

describe("loadConfig: location (storage.md §2.1)", () => {
  const envs: IsolatedEnv[] = [];
  afterAll(() => envs.forEach((e) => e.cleanup()));
  function env(): IsolatedEnv {
    const e = isolatedEnv("cfg");
    envs.push(e);
    return e;
  }
  function write(p: string, text: string) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  const msg = (e: unknown) => (e as Error).message;
  const fails = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e;
    }
    throw new Error("no error");
  };
  const RUN = 'run `passh init` to create one, or create it with the line vault = "/path/to/vault.passh", or pass --vault <file>';

  test("first match wins: --config, $PASSH_CONFIG, default", () => {
    const e = env();
    const envFile = join(e.dir, "env.toml");
    const en = { ...e.env, PASSH_CONFIG: envFile };
    write(envFile, 'vault = "/from/env"\n');
    write(join(e.dir, "flag.toml"), 'vault = "/from/flag"\n');
    write(join(e.configHome, "passh", "config.toml"), 'vault = "/from/default"\n');
    expect(loadConfig({ env: en }).vault).toBe("/from/env");
    expect(loadConfig({ env: en, configFlag: join(e.dir, "flag.toml") }).vault).toBe("/from/flag");
    expect(loadConfig({ env: en, configFlag: join(e.dir, "flag.toml") }).location).toEqual({ path: join(e.dir, "flag.toml"), source: "flag" });
    const noEnv = { ...e.env, PASSH_CONFIG: "" };
    expect(loadConfig({ env: noEnv }).vault).toBe("/from/default");
    expect(loadConfig({ env: noEnv }).location).toEqual({ path: join(e.configHome, "passh", "config.toml"), source: "default" });
    // An empty --config counts as not given.
    expect(loadConfig({ env: en, configFlag: "" }).location?.source).toBe("env");
  });
  test("relative and ~ paths are expanded", () => {
    const e = env();
    write(join(e.dir, "w", "rel.toml"), 'vault = "/x/y"\n');
    expect(loadConfig({ env: e.env, configFlag: "rel.toml", cwd: join(e.dir, "w") }).file).toBe(join(e.dir, "w", "rel.toml"));
    expect(loadConfig({ env: { ...e.env, PASSH_CONFIG: "./w/../w/rel.toml" }, cwd: e.dir }).file).toBe(join(e.dir, "w", "rel.toml"));
    write(join(e.home, "c.toml"), 'vault = "/z"\n');
    expect(loadConfig({ env: e.env, configFlag: "~/c.toml" }).vault).toBe("/z");
    expect(loadConfig({ env: e.env, vaultFlag: "a/../b/./v", cwd: e.dir }).vault).toBe(join(e.dir, "b", "v"));
    expect(loadConfig({ env: e.env, vaultFlag: "~x/v", cwd: e.dir }).vault).toBe(join(e.dir, "~x", "v"));
    expect(loadConfig({ env: e.env, vaultFlag: "~" }).vault).toBe(e.home);
  });
  test("missing files", () => {
    const e = env();
    expect(msg(fails(() => loadConfig({ env: e.env })))).toBe(`no config file at ${e.configFile} (from $PASSH_CONFIG): ${RUN}`);
    expect(hasCode(fails(() => loadConfig({ env: e.env })), "no-config")).toBe(true);
    const c = loadConfig({ env: e.env, vaultFlag: "/x/v.passh" });
    expect(c.vault).toBe("/x/v.passh");
    expect(c.file).toBeUndefined();
    expect(c.language).toBe("en");
    const nope = join(e.dir, "nope.toml");
    expect(msg(fails(() => loadConfig({ env: e.env, configFlag: nope })))).toBe(`no config file at ${nope} (from --config): ${RUN}`);
    expect(msg(fails(() => loadConfig({ env: e.env, configFlag: nope, vaultFlag: "/x" })))).toBe(`no config file at ${nope} (from --config): ${RUN}`);
    const noEnv = { ...e.env, PASSH_CONFIG: undefined };
    expect(msg(fails(() => loadConfig({ env: noEnv })))).toBe(`no config file at ${join(e.configHome, "passh", "config.toml")}: ${RUN}`);
    expect(loadConfig({ env: noEnv, vaultFlag: "/x/v" }).vault).toBe("/x/v");
    // A dangling symlink is a missing file.
    symlinkSync(join(e.dir, "dangling"), join(e.dir, "dl.toml"));
    expect(msg(fails(() => loadConfig({ env: e.env, configFlag: join(e.dir, "dl.toml") })))).toContain("no config file at");
    // init: a missing file gives the defaults.
    const ci = loadConfig({ env: e.env, configFlag: nope, allowMissing: true });
    expect(ci.vault).toBe("");
    expect(ci.location).toEqual({ path: nope, source: "flag" });
  });
  test("$HOME unset or relative", () => {
    const e = env();
    const noHome = { ...e.env, HOME: undefined };
    write(e.configFile, 'vault = "/v"\n');
    expect(loadConfig({ env: noHome }).vault).toBe("/v"); // XDG and PASSH_CONFIG don't need $HOME
    const bare = { ...noHome, PASSH_CONFIG: undefined, XDG_CONFIG_HOME: undefined };
    expect(msg(fails(() => loadConfig({ env: bare })))).toBe("$HOME is not set");
    expect(loadConfig({ env: bare, vaultFlag: "/x/v" }).vault).toBe("/x/v");
    expect(msg(fails(() => loadConfig({ env: bare, vaultFlag: "~/v" })))).toBe("--vault: $HOME is not set");
    expect(msg(fails(() => loadConfig({ env: bare, configFlag: "~/c.toml", vaultFlag: "/x/v" })))).toBe("--config: $HOME is not set");
    expect(msg(fails(() => loadConfig({ env: { ...bare, PASSH_CONFIG: "~/c.toml" } })))).toBe("$PASSH_CONFIG: $HOME is not set");
    expect(loadConfig({ env: { ...bare, PASSH_CONFIG: "~/c.toml" }, vaultFlag: "/x/v" }).vault).toBe("/x/v");
    expect(msg(fails(() => loadConfig({ env: { ...bare, HOME: "rel/home" } })))).toBe('$HOME ("rel/home") is not an absolute path');
    expect(msg(fails(() => loadConfig({ env: { ...bare, HOME: "" } })))).toBe("$HOME is not set");
    // An XDG variable that isn't absolute is ignored.
    const xdgRel = { ...e.env, PASSH_CONFIG: undefined, XDG_CONFIG_HOME: "rel" };
    expect(locateConfig({ env: xdgRel }).path).toBe(join(e.home, ".config", "passh", "config.toml"));
  });
  test("read errors and limits", () => {
    const e = env();
    mkdirSync(join(e.dir, "cdir"));
    expect(msg(fails(() => loadConfig({ env: e.env, configFlag: join(e.dir, "cdir") })))).toBe(`config: read ${join(e.dir, "cdir")}: is a directory`);
    if (process.getuid?.() !== 0) {
      write(join(e.dir, "c000.toml"), 'vault = "/x"\n');
      chmodSync(join(e.dir, "c000.toml"), 0);
      expect(msg(fails(() => loadConfig({ env: e.env, configFlag: join(e.dir, "c000.toml") })))).toBe(`config: open ${join(e.dir, "c000.toml")}: permission denied`);
      write(join(e.dir, "p000", "c.toml"), 'vault = "/x"\n');
      chmodSync(join(e.dir, "p000"), 0);
      // Not ENOENT: an error even with --vault.
      expect(msg(fails(() => loadConfig({ env: { ...e.env, PASSH_CONFIG: join(e.dir, "p000", "c.toml") }, vaultFlag: "/x" })))).toBe(`config: open ${join(e.dir, "p000", "c.toml")}: permission denied`);
      chmodSync(join(e.dir, "p000"), 0o700);
    }
    const big = join(e.dir, "big.toml");
    write(big, ('vault = "/x"\n' + "#".repeat(1024 * 1024)).slice(0, 1024 * 1024));
    expect(loadConfig({ env: e.env, configFlag: big }).vault).toBe("/x");
    write(big, 'vault = "/x"\n' + "#".repeat(1024 * 1024));
    expect(msg(fails(() => loadConfig({ env: e.env, configFlag: big })))).toBe(`config ${big}: the file is larger than 1 MiB`);
    // An invalid file is an error even with --vault.
    write(e.configFile, "foo = 1\n");
    expect(msg(fails(() => loadConfig({ env: e.env, vaultFlag: "/x" })))).toBe(`config ${e.configFile}: unknown key "foo"`);
  });
});

describe("loadConfig for init (allowMissing)", () => {
  test("an existing file still needs vault without --vault", () => {
    const e = isolatedEnv("cfgi");
    try {
      mkdirSync(dirname(e.configFile), { recursive: true });
      writeFileSync(e.configFile, 'language = "en"\n');
      expect(() => loadConfig({ env: e.env, allowMissing: true })).toThrow("vault is required");
      expect(loadConfig({ env: e.env, allowMissing: true, vaultFlag: "/v" }).vault).toBe("/v");
      const bare = { ...e.env, HOME: undefined, PASSH_CONFIG: undefined, XDG_CONFIG_HOME: undefined };
      const c = loadConfig({ env: bare, allowMissing: true });
      expect(c.location).toBeUndefined();
      expect(c.vault).toBe("");
    } finally {
      e.cleanup();
    }
  });
});
