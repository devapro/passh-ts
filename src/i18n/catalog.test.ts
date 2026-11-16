// The ru and sr catalogues (i18n.md §3–§6; glossary: spec/docs/translations.md):
// every key of the code is translated, every translation keeps the key's format verbs,
// plurals have one/few/many, Serbian is Latin only, the glossary terms are used, and the
// CLI speaks the config's language end to end.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { extract, missingKeys, staleKeys, entryProblems, verbSignature, type Extraction } from "../../scripts/i18n-keys.ts";
import { isolatedEnv, run, TS_SRC_CMD } from "../../test/helpers/env.ts";
import { PRINT_CATALOG_RU } from "../print/catalog_ru.ts";
import { PRINT_CATALOG_SR } from "../print/catalog_sr.ts";
import "./catalogs.ts";
import { errorf, renderError, setLanguage, T, TN, type Catalog } from "./index.ts";
import { RU } from "./ru.ts";
import { RU_CLI } from "./ru_cli.ts";
import { RU_CORE } from "./ru_core.ts";
import { RU_TUI } from "./ru_tui.ts";
import { sprintf } from "./sprintf.ts";
import { SR } from "./sr.ts";
import { SR_CLI } from "./sr_cli.ts";
import { SR_CORE } from "./sr_core.ts";
import { SR_TUI } from "./sr_tui.ts";

afterEach(() => setLanguage("en"));

const LANGS = { ru: RU, sr: SR } as const;
const FRAGMENTS = {
  ru: { core: RU_CORE, cli: RU_CLI, tui: RU_TUI, print: PRINT_CATALOG_RU },
  sr: { core: SR_CORE, cli: SR_CLI, tui: SR_TUI, print: PRINT_CATALOG_SR },
} as const;

let extraction: Extraction | undefined;
function keys(): Extraction {
  extraction ??= extract();
  return extraction;
}

function str(c: Catalog, key: string): string {
  const v = c[key];
  if (typeof v !== "string") throw new Error(`no string translation for ${JSON.stringify(key)}`);
  return v;
}

describe("format verbs", () => {
  test("verbSignature reads Go's argument numbering", () => {
    expect(verbSignature("%d entries in %s")).toEqual(["0:d", "1:s"]);
    expect(verbSignature("%[2]s: записей — %[1]d")).toEqual(["0:d", "1:s"]);
    expect(verbSignature("100%% %-6s %q")).toEqual(["0:-6s", "1:q"]);
    expect(verbSignature("%w; the partial file %s could not be removed (%v)")).toEqual(["0:w", "1:s", "2:v"]);
    expect(verbSignature("%[2]s %s")).toEqual(["1:s", "2:s"]); // after %[2]s, %s reads the third
  });

  for (const [lang, cat] of Object.entries(LANGS) as ["ru" | "sr", Catalog][]) {
    test(`${lang}: every entry keeps the key's verbs and white space, no empty text`, () => {
      const problems: string[] = [];
      for (const [k, v] of Object.entries(cat)) for (const p of entryProblems(lang, k, v)) problems.push(`${JSON.stringify(k)}: ${p}`);
      expect(problems).toEqual([]);
    });
  }
});

describe("plurals", () => {
  for (const [lang, cat] of Object.entries(LANGS) as ["ru" | "sr", Catalog][]) {
    test(`${lang}: plural messages have one, few and many; others are strings`, () => {
      const wrong: string[] = [];
      for (const k of keys().keys.values()) {
        const v = cat[k.key];
        if (v === undefined) continue;
        if (k.kind === "plural" && (typeof v !== "object" || !v.one || !v.few || !v.many)) wrong.push(`plural without one/few/many: ${JSON.stringify(k.key)}`);
        if (k.kind !== "plural" && typeof v !== "string") wrong.push(`not a plural message: ${JSON.stringify(k.key)}`);
      }
      for (const [k, v] of Object.entries(cat)) if (typeof v === "object" && (!v.one || !v.few || !v.many)) wrong.push(`incomplete plural: ${JSON.stringify(k)}`);
      expect(wrong).toEqual([]);
    });
  }

  test("ru and sr forms by CLDR (i18n.md §4)", () => {
    const count = (n: number) => TN(n, "%d entry", "%d entries", n);
    setLanguage("ru");
    expect([1, 2, 5, 11, 21, 22, 25, 101, 111, 0].map(count)).toEqual(
      ["1 запись", "2 записи", "5 записей", "11 записей", "21 запись", "22 записи", "25 записей", "101 запись", "111 записей", "0 записей"],
    );
    setLanguage("sr");
    expect([1, 2, 5, 12, 21].map(count)).toEqual(["1 stavka", "2 stavke", "5 stavki", "12 stavki", "21 stavka"]);
    setLanguage("en");
    expect([1, 2].map(count)).toEqual(["1 entry", "2 entries"]);
  });
});

describe("script", () => {
  test("sr is Latin only (no Cyrillic)", () => {
    const cyr: string[] = [];
    for (const [k, v] of Object.entries(SR)) {
      const texts = typeof v === "string" ? [v] : Object.values(v);
      if (texts.some((t) => /\p{Script=Cyrillic}/u.test(t ?? ""))) cyr.push(k);
    }
    expect(cyr).toEqual([]);
  });

  test("ru translates prose into Cyrillic", () => {
    // A translation without any Cyrillic letter is left English by mistake, unless the key is
    // only names, units or code.
    const english: string[] = [];
    for (const [k, v] of Object.entries(RU)) {
      const texts = typeof v === "string" ? [v] : Object.values(v);
      const prose = k.replace(/`[^`]*`/g, "").replace(/%(\[\d+\])?[-+# 0]*\d*(\.\d*)?[a-zA-Z%]/g, "");
      if (!/\p{L}{3,}\s+\p{L}{3,}/u.test(prose)) continue;
      if (texts.some((t) => !/\p{Script=Cyrillic}/u.test(t ?? ""))) english.push(k);
    }
    expect(english).toEqual([]);
  });
});

describe("completeness", () => {
  for (const [lang, cat] of Object.entries(LANGS) as ["ru" | "sr", Catalog][]) {
    test(`${lang}: every message of the code is translated (bun run scripts/i18n-keys.ts --missing ${lang})`, () => {
      const missing = missingKeys(keys(), cat).map((k) => `${k.sites[0]}: ${JSON.stringify(k.key)}`);
      expect(missing).toEqual([]);
    });

    test(`${lang}: no entry without a call site (a key typo is a dead translation)`, () => {
      expect(staleKeys(keys(), cat)).toEqual([]);
    });

    test(`${lang}: a key in two area files has one translation; the sheet frame strings win`, () => {
      const frags = Object.entries(FRAGMENTS[lang]) as [string, Catalog][];
      const clashes: string[] = [];
      for (let i = 0; i < frags.length; i++) {
        for (let j = i + 1; j < frags.length; j++) {
          const [an, a] = frags[i]!;
          const [bn, b] = frags[j]!;
          for (const k of Object.keys(a)) if (k in b && JSON.stringify(a[k]) !== JSON.stringify(b[k])) clashes.push(`${an}/${bn}: ${JSON.stringify(k)}`);
        }
      }
      expect(clashes).toEqual([]);
      for (const [k, v] of Object.entries(FRAGMENTS[lang].print)) expect(cat[k]).toEqual(v);
    });
  }
});

// Spot-check of the glossary (translations.md#glossary, normative): where a key uses a term
// in prose, the translation uses the glossary's word. Code, flags, field and config names,
// paths and command lines are left out of the English first.
const GLOSSARY: { en: RegExp; ru: RegExp; sr: RegExp }[] = [
  { en: /\bpassphrases?\b/i, ru: /парольн\p{L}*\s+фраз/iu, sr: /pristupn\p{L}*\s+fraz/iu },
  { en: /\bvaults?\b/i, ru: /хранилищ/iu, sr: /trezor/iu },
  { en: /\bentr(y|ies)\b/i, ru: /запис/iu, sr: /stavk/iu },
  { en: /\bclipboard\b/i, ru: /буфер\p{L}*\s+обмена/iu, sr: /ostav/iu },
  { en: /\bbackups?\b/i, ru: /резервн|проверенн/iu, sr: /rezervn|proveren/iu },
  { en: /\brecovery key\b/i, ru: /ключ\p{L}*\s+восстановления/iu, sr: /ključ\p{L}*\s+za\s+oporavak/iu },
  { en: /\btags?\b/i, ru: /тег/iu, sr: /ozna[kc]/iu },
  { en: /\bfolders?\b/i, ru: /папк|каталог/iu, sr: /fascikl|direktorijum/iu },
  { en: /\bagent\b/i, ru: /агент/iu, sr: /agent/iu },
  { en: /\bchecksum\b/i, ru: /контрольн\p{L}*\s+сумм/iu, sr: /kontroln\p{L}*\s+zbir/iu },
  { en: /\bprint page\b/i, ru: /страниц\p{L}*\s+печати/iu, sr: /stranic\p{L}*\s+za\s+štampu/iu },
  { en: /\bplaintext\b/i, ru: /открыт/iu, sr: /otvoren/iu },
  { en: /\bfingerprint\b/i, ru: /отпечат/iu, sr: /otis/iu },
  { en: /\brevisions?\b/i, ru: /ревизи/iu, sr: /revizij/iu },
  { en: /\bconfig file\b/i, ru: /конфигурационн\p{L}*\s+файл/iu, sr: /konfiguracion\p{L}*\s+datotek/iu },
  { en: /\bdamaged\b/i, ru: /поврежд/iu, sr: /oštećen/iu },
  { en: /\bdecrypt/i, ru: /расшифр/iu, sr: /dešifr/iu },
  { en: /\bsymlinks?\b/i, ru: /символическ\p{L}*\s+ссылк/iu, sr: /simboličk\p{L}*\s+vez/iu },
  { en: /\btombstones?\b/i, ru: /отметк\p{L}*\s+об\s+удалении/iu, sr: /zapis\p{L}*\s+o\s+brisanju/iu },
];

/** Keys where the glossary word is a name (a JSON field, a config key; checked by hand). */
const GLOSSARY_EXCEPTIONS = new Set<string>([
  "missing or bad revision",
  "vault_id, revision or number of entries differ",
  "--vault overrides the config's vault",
  "Use --vault %s with each command, or change vault in the config file.",
]);

function prose(key: string): string {
  return key
    .replace(/`[^`]*`/g, " ")
    .replace(/\(passh [^)]*\)/g, " ")
    .replace(/\bpassh [a-z][a-z-]*( [a-z-]+)?/g, " ")
    .replace(/--?[a-z][a-z-]*/g, " ")
    .replace(/\$[A-Z_]+/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\S*[/._]\S*/g, " ")
    .replace(/\b(password|username|url|tags|notes)(,\s+(or\s+|and\s+)?(password|username|url|tags|notes|fields))+/g, " ");
}

describe("glossary", () => {
  for (const lang of ["ru", "sr"] as const) {
    test(`${lang}: glossary terms are used`, () => {
      const wrong: string[] = [];
      for (const [k, v] of Object.entries(LANGS[lang])) {
        if (GLOSSARY_EXCEPTIONS.has(k)) continue;
        const english = prose(k.includes("\u0004") ? k.slice(k.indexOf("\u0004") + 1) : k);
        const texts = typeof v === "string" ? [v] : Object.values(v).filter((t): t is string => typeof t === "string");
        for (const g of GLOSSARY) {
          if (!g.en.test(english)) continue;
          if (texts.some((t) => !g[lang].test(t))) wrong.push(`${g.en.source}: ${JSON.stringify(k)} → ${JSON.stringify(texts[0])}`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }

  test("fixed words: warning prefix, doctor's ok and warn, yes/no left to i18n", () => {
    expect(str(RU, "warning: ")).toBe("предупреждение: ");
    expect(str(SR, "warning: ")).toBe("upozorenje: ");
    if ("doctor\u0004ok" in RU) {
      expect(str(RU, "doctor\u0004ok")).toBe("ок");
      expect(str(RU, "doctor\u0004warn")).toBe("внимание");
      expect(str(SR, "doctor\u0004ok")).toBe("ok");
      expect(str(SR, "doctor\u0004warn")).toBe("upozorenje");
    }
  });

  test("typed phrases and command names stay as they are", () => {
    for (const cat of [RU, SR]) {
      for (const [k, v] of Object.entries(cat)) {
        const texts = typeof v === "string" ? [v] : Object.values(v);
        for (const phrase of ["PRINT RECOVERY KEY", "EXPORT PLAINTEXT"]) if (k.includes(phrase)) for (const t of texts) expect(t).toContain(phrase);
        for (const code of k.match(/`[^`]*`/g) ?? []) for (const t of texts) expect(t).toContain(code);
      }
    }
  });
});

describe("lookup and errors in the language", () => {
  test("T, renderError with wrapped errors (i18n.md §6)", () => {
    const inner = errorf("not confirmed");
    const outer = errorf("reading the passphrase: %w", inner);
    expect(renderError(outer)).toBe("reading the passphrase: not confirmed");
    for (const [lang, cat] of Object.entries(LANGS) as ["ru" | "sr", Catalog][]) {
      setLanguage(lang);
      expect(T("Usage:")).toBe(str(cat, "Usage:"));
      expect(renderError(outer)).toBe(sprintf(str(cat, "reading the passphrase: %w"), [str(cat, "not confirmed")]));
      expect(outer.message).toBe("reading the passphrase: not confirmed");
      // a plain error whose whole text is a key: the agent's refusals (§6 rule 2)
      expect(renderError(new Error("malformed request"))).toBe(str(cat, "malformed request"));
      // an OS error stays as it is (§6 rule 5)
      expect(renderError(new Error("open /x: permission denied"))).toBe("open /x: permission denied");
    }
  });
});

// ---------------------------------------------------------------------------
// End to end: the CLI in an isolated environment whose config says the language.

async function passh(language: string, args: string[]) {
  const e = isolatedEnv("i18n");
  try {
    mkdirSync(dirname(e.configFile), { recursive: true, mode: 0o700 });
    writeFileSync(e.configFile, `vault = "${e.vault}"\nlanguage = "${language}"\n`, { mode: 0o600 });
    return await run([...TS_SRC_CMD, ...args], e.env);
  } finally {
    e.cleanup();
  }
}

describe("CLI end to end (config language)", () => {
  test("ru: --help headings, flag texts and the closing line", async () => {
    const r = await passh("ru", ["--help"]);
    expect(r.code).toBe(0);
    for (const k of ["Usage:", "Available Commands:", "Flags:"]) expect(r.stdout).toContain(str(RU, k));
    expect(r.stdout).not.toContain("Usage:");
    expect(r.stdout).toContain(sprintf(str(RU, "help for %s"), ["passh"]));
    expect(r.stdout).toContain(sprintf(str(RU, 'Use "%s [command] --help" for more information about a command.'), ["passh"]));
    // names stay: commands, flags, placeholders
    expect(r.stdout).toContain("  passh [command]");
    expect(r.stdout).toContain("--vault string");
  });

  test("ru: an error, a usage error with its hint, a subcommand's help", async () => {
    const ls = await passh("ru", ["ls"]);
    expect(ls.code).toBe(1);
    expect(ls.stderr).toMatch(/^passh: .*\p{Script=Cyrillic}/u);
    expect(ls.stderr).toContain("`passh init`");
    const bad = await passh("ru", ["ls", "--bogus"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toBe(`passh: ${sprintf(str(RU, "unknown flag: --%s"), ["bogus"])}\n${str(RU, "Run 'passh --help' or 'passh <command> --help' for usage.")}\n`);
    const help = await passh("ru", ["help", "ls"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain(str(RU, "Global Flags:"));
    expect(help.stdout).toContain("passh ls");
  });

  test("sr: Latin headings and errors", async () => {
    const r = await passh("sr", ["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(str(SR, "Usage:"));
    expect(r.stdout).not.toMatch(/\p{Script=Cyrillic}/u);
    const bad = await passh("sr", ["show"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain(str(SR, "Run 'passh --help' or 'passh <command> --help' for usage."));
    expect(bad.stderr).not.toMatch(/\p{Script=Cyrillic}/u);
  });

  test("en and a refused language stay English (i18n.md §1, §2)", async () => {
    const en = await passh("en", ["--help"]);
    expect(en.stdout).toContain("Usage:");
    const de = await passh("de", ["ls"]);
    expect(de.code).toBe(1);
    expect(de.stderr).toContain(`language: "de" is not one of "en", "ru" or "sr"`);
  });

  test("data on stdout is the same in every language: --version", async () => {
    const ru = await passh("ru", ["--version"]);
    const en = await passh("en", ["--version"]);
    expect(ru.stdout).toBe(en.stdout);
    expect(ru.stdout).toMatch(/^passh \S+\n$/);
  });
});
