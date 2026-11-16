import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isolatedEnv, type IsolatedEnv } from "../../test/helpers/env.ts";
import { chooseLanguage, scanGlobalFlags } from "./language.ts";

describe("scanGlobalFlags", () => {
  test("both spellings, the last wins, up to --", () => {
    expect(scanGlobalFlags(["--config", "a", "ls", "--config=b"])).toEqual({ config: "b" });
    expect(scanGlobalFlags(["--vault=x", "--vault", "y"])).toEqual({ vault: "y" });
    expect(scanGlobalFlags(["ls", "--", "--config", "z"])).toEqual({});
    expect(scanGlobalFlags(["--configx", "a", "--vault-x", "b"])).toEqual({});
    expect(scanGlobalFlags(["--config"])).toEqual({});
    expect(scanGlobalFlags(["--config="])).toEqual({ config: "" });
  });
});

describe("chooseLanguage (i18n.md §2)", () => {
  const envs: IsolatedEnv[] = [];
  afterAll(() => envs.forEach((e) => e.cleanup()));
  function setup(text?: string): IsolatedEnv {
    const e = isolatedEnv("lang");
    envs.push(e);
    if (text !== undefined) {
      mkdirSync(dirname(e.configFile), { recursive: true });
      writeFileSync(e.configFile, text);
    }
    return e;
  }
  test("the config's language", () => {
    const e = setup('vault = "/x"\nlanguage = "ru"\n');
    expect(chooseLanguage(["ls"], e.env)).toBe("ru");
    expect(chooseLanguage(["ls", "--vault", "/y"], e.env)).toBe("ru");
    expect(chooseLanguage([], e.env)).toBe("ru");
    expect(chooseLanguage(["__agent", "--vault=/x"], e.env)).toBe("en");
    expect(chooseLanguage(["ls", "--config", join(e.dir, "missing.toml")], e.env)).toBe("en");
  });
  test("an absent language key is English", () => {
    const e = setup('vault = "/x"\n');
    expect(chooseLanguage(["ls"], e.env)).toBe("en");
  });
  test("any failure gives English", () => {
    for (const text of ['vault = "/x"\nlanguage = "sr"\nfoo = 1\n', 'language = "ru"\n', 'vault = "/x"\nlanguage = "RU"\n', "vault = [\n", 'vault = "rel"\nlanguage = "ru"\n']) {
      const e = setup(text);
      expect(chooseLanguage(["ls"], e.env)).toBe("en");
    }
    const e = setup();
    expect(chooseLanguage(["ls"], e.env)).toBe("en");
    expect(chooseLanguage(["ls", "--vault", "/v"], e.env)).toBe("en");
  });
  test("a missing vault is fine with --vault", () => {
    const e = setup('language = "sr"\n');
    expect(chooseLanguage(["ls"], e.env)).toBe("en");
    expect(chooseLanguage(["--vault", "/v", "ls"], e.env)).toBe("sr");
  });
  test("--config from the arguments", () => {
    const e = setup();
    const p = join(e.dir, "other.toml");
    writeFileSync(p, 'vault = "/x"\nlanguage = "sr"\n');
    expect(chooseLanguage(["--config", p, "ls"], e.env)).toBe("sr");
    expect(chooseLanguage([`--config=${p}`], e.env)).toBe("sr");
    expect(chooseLanguage(["ls", "--", "--config", p], e.env)).toBe("en");
  });
});
