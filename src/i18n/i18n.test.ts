import { describe, expect, test, afterEach } from "bun:test";
import { sprintf } from "./sprintf.ts";
import { goQuote } from "./quote.ts";
import { T, TN, TC, errorf, codedError, hasCode, renderError, setLanguage, registerCatalog, pluralCategory, parseYesNo, yesNoHint, PasshError } from "./index.ts";

afterEach(() => setLanguage("en"));

describe("sprintf (Go fmt subset)", () => {
  test("verbs", () => {
    expect(sprintf("%s: %d entries", ["work", 3])).toBe("work: 3 entries");
    expect(sprintf("%q", ['a"b'])).toBe('"a\\"b"');
    expect(sprintf("%[2]s %[1]s", ["a", "b"])).toBe("b a");
    expect(sprintf("%-6s|", ["ab"])).toBe("ab    |");
    expect(sprintf("%5d|%05d", [42, 42])).toBe("   42|00042");
    expect(sprintf("%x", [255])).toBe("ff");
    expect(sprintf("%v and %w", [new Error("x"), new Error("y")])).toBe("x and y");
    expect(sprintf("100%%", [])).toBe("100%");
    expect(sprintf("%d", [12345678901234567890n])).toBe("12345678901234567890");
    expect(sprintf("%s %s", ["a"])).toBe("a %!s(MISSING)");
  });
});

describe("goQuote (strconv.Quote)", () => {
  test("vectors", () => {
    expect(goQuote("sté\u0007")).toBe('"sté\\a"');
    expect(goQuote("a\tb\n")).toBe('"a\\tb\\n"');
    expect(goQuote(" ")).toBe('"\\u00a0"');
    expect(goQuote("​")).toBe('"\\u200b"');
    expect(goQuote("😀")).toBe('"😀"');
    expect(goQuote("\x1b")).toBe('"\\x1b"');
    expect(goQuote("\x7f")).toBe('"\\x7f"');
    expect(goQuote(new Uint8Array([0x61, 0xff, 0x62]))).toBe('"a\\xffb"');
    expect(goQuote("\u{e0041}")).toBe('"\\U000e0041"');
    expect(goQuote("back\\slash")).toBe('"back\\\\slash"');
  });
});

describe("catalogues and plurals", () => {
  test("lookup, fallback, context, literal text without args", () => {
    registerCatalog("ru", () => ({ "Saved %s.": "Сохранено: %s.", "ctx\u0004Edit": "Правка", "100% done": "100% готово" }));
    setLanguage("ru");
    expect(T("Saved %s.", "a")).toBe("Сохранено: a.");
    expect(T("Unknown %s", "x")).toBe("Unknown x");
    expect(TC("ctx", "Edit")).toBe("Правка");
    expect(TC("other", "Edit")).toBe("Edit");
    expect(T("100% done")).toBe("100% готово");
  });
  test("plural categories (i18n.md §4 table)", () => {
    const ns = [0, 1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111];
    const want: string[] = ["many", "one", "few", "few", "many", "many", "many", "many", "one", "few", "many", "one", "many"];
    expect(ns.map((n): string => pluralCategory(n, "ru"))).toEqual(want);
    expect(ns.map((n): string => pluralCategory(n, "sr"))).toEqual(want);
    expect(pluralCategory(1, "en")).toBe("one");
    expect(pluralCategory(-1, "en")).toBe("one");
    expect(pluralCategory(0, "en")).toBe("other");
  });
  test("TN", () => {
    expect(TN(1, "%d entry", "%d entries", 1)).toBe("1 entry");
    expect(TN(5, "%d entry", "%d entries", 5)).toBe("5 entries");
    registerCatalog("ru", () => ({ "%d entries": { one: "%d запись", few: "%d записи", many: "%d записей" } }));
    setLanguage("ru");
    expect([1, 2, 5].map((n) => TN(n, "%d entry", "%d entries", n))).toEqual(["1 запись", "2 записи", "5 записей"]);
  });
});

describe("errors", () => {
  test("errorf wraps with %w; codes match through the chain", () => {
    const inner = codedError("changed", "vault changed on disk");
    const outer = errorf("saving: %w", inner);
    expect(outer.message).toBe("saving: vault changed on disk");
    expect(hasCode(outer, "changed")).toBe(true);
    expect(hasCode(outer, "other")).toBe(false);
    expect(outer).toBeInstanceOf(PasshError);
  });
  test("rendering in a language (i18n.md §6)", () => {
    registerCatalog("ru", () => ({
      "%s: wrong passphrase, or the key block is damaged": "%s: неверная парольная фраза или повреждён блок ключа",
      "malformed request": "неверный запрос",
      "agent: %w": "агент: %v",
    }));
    setLanguage("ru");
    expect(renderError(errorf("%s: wrong passphrase, or the key block is damaged", "/v"))).toBe("/v: неверная парольная фраза или повреждён блок ключа");
    expect(renderError(new Error("malformed request"))).toBe("неверный запрос");
    const plain = new Error("open /x: permission denied");
    expect(renderError(plain)).toBe("open /x: permission denied");
    const wrapped = new Error("context: malformed request", { cause: new Error("malformed request") });
    expect(renderError(wrapped)).toBe("context: неверный запрос");
    expect(renderError(errorf("agent: %w", new Error("malformed request")))).toBe("агент: неверный запрос");
  });
});

describe("yes/no (i18n.md §5)", () => {
  test("hints and answers per language", () => {
    expect(yesNoHint(false)).toBe(" [y/N] ");
    expect(yesNoHint(true)).toBe(" [Y/n] ");
    expect(parseYesNo(" YES ")).toBe(true);
    expect(parseYesNo("да")).toBeUndefined();
    setLanguage("ru");
    expect(yesNoHint(false)).toBe(" [д/Н] ");
    expect(parseYesNo("Да")).toBe(true);
    expect(parseYesNo("нет")).toBe(false);
    expect(parseYesNo("da")).toBeUndefined();
    setLanguage("sr");
    expect(yesNoHint(true)).toBe(" [D/n] ");
    expect(parseYesNo("da")).toBe(true);
    expect(parseYesNo("ne")).toBe(false);
    expect(parseYesNo("n")).toBe(false);
  });
});
