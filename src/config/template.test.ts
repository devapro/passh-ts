import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, statSync, symlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, type IsolatedEnv } from "../../test/helpers/env.ts";
import { parseConfig } from "./config.ts";
import { CONFIG_TEMPLATE, configFileText, configVaultValue, tomlBasicString, writeConfigFile } from "./template.ts";

const ROOT = join(import.meta.dir, "../..");

describe("the config file init writes (storage.md §2.4)", () => {
  test("the template is spec §3.3's toml block byte for byte", () => {
    const spec = readFileSync(join(ROOT, "spec/spec.md"), "utf8");
    const start = spec.indexOf("### 3.3 Config file");
    const block = spec.slice(spec.indexOf("```toml\n", start) + "```toml\n".length);
    expect(CONFIG_TEMPLATE).toBe(block.slice(0, block.indexOf("```\n")));
  });
  test("it passes the config checks with every default spelled out", () => {
    const c = parseConfig(CONFIG_TEMPLATE, "/c", { env: { HOME: "/home/a" } });
    expect(c.vault).toBe("/home/a/.local/share/passh/vault.passh");
    expect(c.language).toBe("en");
  });
  test("the vault value", () => {
    const env = { HOME: "/home/a" };
    expect(configVaultValue("/home/a/.local/share/passh/vault.passh", env)).toBe('"~/.local/share/passh/vault.passh"');
    expect(configVaultValue("/srv/v.passh", env)).toBe('"/srv/v.passh"');
    expect(configVaultValue("/home/a", env)).toBe('"/home/a"');
    expect(configVaultValue("/v.passh", { HOME: "/" })).toBe('"/v.passh"');
    expect(configVaultValue("/home/a/v", {})).toBe('"/home/a/v"');
    expect(configVaultValue('/home/a/a"b\\c\x01d\x7fé/v.passh', env)).toBe('"~/a\\"b\\\\c\\u0001d\\u007Fé/v.passh"');
    expect(tomlBasicString("\x1f\x00")).toBe('"\\u001F\\u0000"');
    expect(() => configVaultValue("/x/\ud800", env)).toThrow("is not valid UTF-8, which TOML can't hold");
  });
  test("configFileText replaces only the vault line and round-trips", () => {
    const env = { HOME: "/home/a" };
    const v = '/home/a/we"ird\\\x1b/v.passh';
    const t = configFileText(v, env);
    expect(t.split("\n")[0]).toBe('vault    = "~/we\\"ird\\\\\\u001B/v.passh"');
    expect(t.split("\n").slice(1).join("\n")).toBe(CONFIG_TEMPLATE.split("\n").slice(1).join("\n"));
    expect(parseConfig(t, "/c", { env }).vault).toBe(v);
  });
});

describe("writeConfigFile", () => {
  const envs: IsolatedEnv[] = [];
  afterAll(() => envs.forEach((e) => e.cleanup()));
  test("folders 0700 and file 0600, both reduced by the umask; never overwrites", () => {
    const e = isolatedEnv("tpl");
    envs.push(e);
    const p = join(e.dir, "new", "passh", "config.toml");
    const old = process.umask(0o027);
    try {
      writeConfigFile(p, "x\n");
    } finally {
      process.umask(old);
    }
    expect(readFileSync(p, "utf8")).toBe("x\n");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(join(e.dir, "new")).mode & 0o777).toBe(0o700);
    expect(() => writeConfigFile(p, "y\n")).toThrow(`open ${p}: file exists`);
    expect(readFileSync(p, "utf8")).toBe("x\n");
    mkdirSync(join(e.dir, "d"));
    symlinkSync(join(e.dir, "d", "target"), join(e.dir, "d", "config.toml"));
    expect(() => writeConfigFile(join(e.dir, "d", "config.toml"), "z")).toThrow("file exists");
    expect(existsSync(join(e.dir, "d", "target"))).toBe(false);
  });
});
