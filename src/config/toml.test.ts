import { describe, expect, test } from "bun:test";
import { keyString, parseToml, TomlError, type TomlTable, type TomlValue } from "./toml.ts";

/** A plain JS view of a document for comparisons. */
function plain(v: TomlValue): unknown {
  switch (v.type) {
    case "table":
      return Object.fromEntries([...v.value].map(([k, x]) => [k, plain(x)]));
    case "array":
      return v.value.map(plain);
    case "datetime":
      return `dt:${v.kind}:${v.value}`;
    default:
      return v.value;
  }
}
const parse = (s: string) => plain(parseToml(s).root) as Record<string, unknown>;
function err(s: string | Uint8Array): string {
  try {
    parseToml(s);
  } catch (e) {
    expect(e).toBeInstanceOf(TomlError);
    return (e as Error).message;
  }
  throw new Error("no error");
}

describe("TOML 1.1 additions", () => {
  test("\\e and \\xHH escapes", () => {
    expect(parse('a = "\\x65n"').a).toBe("en");
    expect(parse('a = "\\e[0m"').a).toBe("\x1b[0m");
    expect(parse('a = "\\xff"').a).toBe("\u00ff");
    expect(parse('a = """\\x41\\e"""').a).toBe("A\x1b");
    expect(err('a = "\\x4"')).toContain("expected two hexadecimal digits after '\\x'");
  });
  test("newlines, comments and a trailing comma in inline tables", () => {
    expect(parse('s = {\n  a = 1, # one\n  b = { c = 2, },\n}\n').s).toEqual({ a: 1n, b: { c: 2n } });
    expect(parse("s = {}").s).toEqual({});
    expect(err("s = {,}")).toContain("expected a key");
    expect(err("s = { a = 1,, }")).toContain("expected a key");
  });
  test("times without seconds", () => {
    expect(parse("a = 07:32").a).toBe("dt:local-time:07:32");
    expect(parse("a = 1979-05-27T07:32Z").a).toBe("dt:offset-datetime:1979-05-27T07:32Z");
    expect(parse("a = 1979-05-27 07:32:00.5-07:00").a).toBe("dt:offset-datetime:1979-05-27 07:32:00.5-07:00");
    expect(parse("a = 1979-05-27").a).toBe("dt:local-date:1979-05-27");
    expect(parse("a = 1979-05-27t07:32:00").a).toBe("dt:local-datetime:1979-05-27t07:32:00");
    expect(err("a = 1979-02-30")).toContain("invalid datetime");
  });
});

describe("values", () => {
  test("strings", () => {
    const d = parse(`a = "q\\"\\\\\\b\\t\\n\\f\\r\\u00e9\\U0001F600"\nb = 'lit\\x'\nc = """\nl1\\\n   l2"""\nd = '''\nraw\\n'''\ne = """""x"""""\nf = ''''a'''`);
    expect(d.a).toBe('q"\\\b\t\n\f\ré😀');
    expect(d.b).toBe("lit\\x");
    expect(d.c).toBe("l1l2");
    expect(d.d).toBe("raw\\n");
    expect(d.e).toBe('""x""');
    expect(d.f).toBe("'a");
    expect(parse('a = "tab\there"').a).toBe("tab\there");
    expect(err('a = "\\q"')).toBe(`line 1 (last key "a"): invalid escape in string '\\q'`);
    expect(err('a = "x\ny"')).toContain("strings cannot contain newlines");
    expect(err('a = "\\uD800"')).toContain("not valid UTF-8");
  });
  test("integers", () => {
    const d = parse("a = 0x10\nb = 0o17\nc = 0b101\nd = +5\ne = -0\nf = 1_000\ng = 9223372036854775807\nh = -9223372036854775808");
    expect(d).toEqual({ a: 16n, b: 15n, c: 5n, d: 5n, e: 0n, f: 1000n, g: 9223372036854775807n, h: -9223372036854775808n });
    expect(err("a = 05")).toBe('line 1 (last key "a"): Invalid integer "05": cannot have leading zeroes');
    expect(err("a = 99999999999999999999")).toBe('line 1 (last key "a"): 99999999999999999999 is out of range for int64');
    expect(err("a = 1__0")).toContain("invalid value");
  });
  test("floats and booleans", () => {
    const d = parse("a = 1.5\nb = -1e3\nc = inf\nd = -inf\ne = nan\nf = true\ng = false\nh = 6.626e-34");
    expect(d.a).toBe(1.5);
    expect(d.b).toBe(-1000);
    expect(d.c).toBe(Infinity);
    expect(d.d).toBe(-Infinity);
    expect(Number.isNaN(d.e)).toBe(true);
    expect(d.f).toBe(true);
    expect(d.g).toBe(false);
    expect(err("a = .5")).toContain("invalid value");
    expect(err("a = 1.")).toContain("invalid value");
  });
  test("arrays", () => {
    expect(parse('a = [\n  "x", # c\n  1,\n]\n').a).toEqual(["x", 1n]);
    expect(parse("a = []").a).toEqual([]);
    expect(err("a = [1 2]")).toContain("expected a comma");
  });
});

describe("structure", () => {
  test("keys in file order, with lines", () => {
    const doc = parseToml('vault = "v"\n[session]\nfoo = 1\n[agent]\nbar = 1\n[session.baz]\nq = 1\n[[zzz]]\n[[zzz]]\nx.y = { a = 1, b.c = 2 }\n"2" = 1\n');
    expect(doc.keys.map((k) => `${k.line}:${keyString(k.path)}`)).toEqual([
      "1:vault",
      "2:session",
      "3:session.foo",
      "4:agent",
      "5:agent.bar",
      "6:session.baz",
      "7:session.baz.q",
      "8:zzz",
      "9:zzz",
      "10:zzz.x.y",
      "10:zzz.x.y.a",
      "10:zzz.x.y.b.c",
      "11:zzz.2",
    ]);
  });
  test("BOM, CRLF", () => {
    expect(parse('\ufeffa = 1\r\nb = "x"\r\n')).toEqual({ a: 1n, b: "x" });
  });
  test("table rules", () => {
    expect(err("[a]\n[a]")).toBe("line 2: Key 'a' has already been defined.");
    expect(err("a = 1\na = 2")).toBe(`line 2 (last key "a"): Key 'a' has already been defined.`);
    expect(err("a = [1]\n[[a]]")).toBe("line 2: Key 'a' was already created and cannot be used as an array.");
    expect(parse("[a.b]\nx = 1\n[a]\ny = 2")).toEqual({ a: { b: { x: 1n }, y: 2n } });
    expect(err("[a]\nb.c = 1\n[a.b]")).toContain("has already been defined");
    expect(parse("[a]\nb.c = 1\n[a.b.d]\ne = 1")).toEqual({ a: { b: { c: 1n, d: { e: 1n } } } });
    expect(err("a = {b = 1}\n[a.c]")).toContain("has already been defined");
    expect(err("[a.b.c]\nz = 9\n[a]\nb.c.t = 1")).toContain("has already been defined");
    expect(parse("[[t]]\nx = 1\n[t.s]\ny = 2\n[[t]]\nx = 3")).toEqual({ t: [{ x: 1n, s: { y: 2n } }, { x: 3n }] });
    expect(parse("a.b = 1\na.c = 2")).toEqual({ a: { b: 1n, c: 2n } });
    expect(err("a.b = 1\na.b.c = 2")).toContain("has already been defined");
  });
  test("lines and table kinds", () => {
    const doc = parseToml("\n[session]\n\nidle_ttl = 5\n");
    const s = doc.root.value.get("session") as TomlTable;
    expect(s.line).toBe(2);
    expect(s.value.get("idle_ttl")!.line).toBe(4);
  });
});

describe("errors", () => {
  test("control characters", () => {
    expect(err("# a\x01b\n")).toBe("line 1: TOML files cannot contain control characters: '0x01'");
    expect(err("# a\x7fb\n")).toBe("line 1: TOML files cannot contain control characters: '0x7f'");
    expect(err('x = "a\x01b"')).toBe(`line 1 (last key "x"): TOML files cannot contain control characters: '0x01'`);
    expect(err("x = 1\rz = 2\n")).toContain("TOML files cannot contain control characters: '0x0d'");
  });
  test("invalid UTF-8", () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('v = "a"\nx = "a'), 0xff, 0x22, 0x0a]);
    expect(err(bytes)).toBe("line 2: invalid UTF-8 byte: 0xff");
  });
  test("syntax", () => {
    expect(err("[session\n")).toContain("expected '.' or ']' to end table name");
    expect(err("x = \n")).toBe(`line 1 (last key "x"): expected value but found '\\n' instead`);
    expect(err("é = 1")).toContain("expected a key");
    expect(err("x = 1 2")).toContain("expected a top-level item to end with a newline, comment, or EOF");
    expect(err('x = """a')).toContain("unexpected EOF");
  });
});

describe("keyString (BurntSushi's Key.String)", () => {
  test("bare and quoted parts", () => {
    expect(keyString(["session", "idle_ttl"])).toBe("session.idle_ttl");
    expect(keyString(["a b"])).toBe('"a b"');
    expect(keyString(['q"x'])).toBe('"q\\"x"');
    expect(keyString([""])).toBe('""');
    expect(keyString(["é"])).toBe('"é"');
    expect(keyString(["t\tx", "a.b"])).toBe('"t\\tx"."a.b"');
    expect(keyString(["lit\\x"])).toBe('"lit\\\\x"');
    expect(keyString(["x\x7fy", "a\x1bb", "a\x00b", "a\bb\nc\fd\re"])).toBe('"x\\u007fy"."a\\u001bb"."a\\u0000b"."a\\bb\\nc\\fd\\re"');
    expect(keyString(["A-b_9", "1234", "-x"])).toBe("A-b_9.1234.-x");
  });
});
