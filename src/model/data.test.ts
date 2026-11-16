import { describe, expect, test } from "bun:test";
import { hasCode } from "../i18n/index.ts";
import { parseJSON } from "./json.ts";
import {
  newId,
  newVaultData,
  parseVaultData,
  serializeVaultData,
  serializeVaultDataText,
  validateVaultData,
  vaultDataEqual,
  type Entry,
  type VaultData,
} from "./index.ts";
import { formatTime, parseTime, parseTimeResult, ZERO_TIME } from "./time.ts";

const enc = (s: string) => new TextEncoder().encode(s);

// vault-format.md §7.2, byte for byte.
const EXAMPLE = `{
  "format": "passh-vault-data",
  "version": 1,
  "vault_id": "0f6c1d2e-0000-4000-8000-000000000001",
  "revision": 42,
  "saved_at": "2026-11-15T12:00:00Z",
  "entries": [
    {
      "id": "8d1e7a90-0000-4000-8000-000000000002",
      "path": "work/github",
      "password": "s3cr3t-P@ss",
      "username": "arsenii",
      "url": "https://github.com",
      "tags": [
        "work",
        "2fa"
      ],
      "fields": [
        {
          "key": "recovery-email",
          "value": "me@example.com"
        }
      ],
      "notes": "Free-form notes.\\nRecovery codes, etc.",
      "created_at": "2026-11-01T09:00:00Z",
      "updated_at": "2026-11-15T12:00:00Z"
    }
  ],
  "deleted": [
    {
      "id": "3b9f0000-0000-4000-8000-000000000003",
      "deleted_at": "2026-11-10T18:30:00Z"
    }
  ]
}
`;

function errText(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  return "(no error)";
}

/** The detail after `invalid vault data: ` (or the whole message). */
function detail(json: string | Uint8Array): string {
  const m = errText(() => parseVaultData(typeof json === "string" ? enc(json) : json));
  return m.replace(/^invalid vault data: /, "");
}

const H = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ format: "passh-vault-data", version: 1, vault_id: "v", revision: 1, saved_at: "2026-01-01T00:00:00Z", entries: [], deleted: [], ...o });
const E = (o: Record<string, unknown> = {}) => ({ id: "i1", path: "p", ...o });

describe("§7.2 example", () => {
  test("reads and writes back byte for byte", () => {
    const d = parseVaultData(enc(EXAMPLE));
    expect(d.revision).toBe(42n);
    expect(d.entries[0]!.tags).toEqual(["work", "2fa"]);
    expect(d.entries[0]!.notes).toBe("Free-form notes.\nRecovery codes, etc.");
    expect(d.savedAt).toBe(Date.UTC(2026, 10, 15, 12) / 1000);
    expect(serializeVaultDataText(d)).toBe(EXAMPLE);
  });
  test("new data", () => {
    const d = newVaultData(1_700_000_000);
    expect(d.revision).toBe(1n);
    expect(d.vaultId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const text = serializeVaultDataText(d);
    expect(text).toBe(
      `{\n  "format": "passh-vault-data",\n  "version": 1,\n  "vault_id": "${d.vaultId}",\n  "revision": 1,\n  "saved_at": "2023-11-14T22:13:20Z",\n  "entries": [],\n  "deleted": []\n}\n`,
    );
    expect(enc(text).length).toBe(194); // vault-format.md §7.1: an empty vault's JSON is 194 bytes
    expect(newId()).not.toBe(newId());
  });
});

describe("§4.2 table and header checks", () => {
  const rows: Array<[string, string]> = [
    ["\ufeff" + H(), "invalid character '\\ufeff' looking for beginning of value"],
    ["\f" + H(), "invalid character '\\f' looking for beginning of value"],
    [H() + "\u00a0", "invalid character '\\u00a0' after top-level value"],
    [H() + " x", "invalid character 'x' after top-level value"],
    [H() + " \t\r\n", "(ok)"],
    ["", "unexpected end of JSON input"],
    ["  \n", "unexpected end of JSON input"],
    [H().slice(0, 20), "unexpected end of JSON input"],
    ["[]", "json: cannot unmarshal array into Go value of type map[string]jsontext.Value"],
    ['"x"', "json: cannot unmarshal string into Go value of type map[string]jsontext.Value"],
    ["1", "json: cannot unmarshal number into Go value of type map[string]jsontext.Value"],
    ["true", "json: cannot unmarshal bool into Go value of type map[string]jsontext.Value"],
    ["null", "expected an object, got null"],
    [H({ format: "x" }), 'format is not "passh-vault-data"'],
    [H({ format: null }), 'format is not "passh-vault-data"'],
    [JSON.stringify({ version: 1, vault_id: "v", revision: 1 }), 'format is not "passh-vault-data"'],
    [H().replace('"version":1', '"version":1E0'), "missing or bad version"],
    [H().replace('"version":1', '"version":1.0'), "missing or bad version"],
    [H({ version: "1" }), "missing or bad version"],
    [H().replace('"version":1', '"version":9223372036854775808'), "missing or bad version"],
    [JSON.stringify({ format: "passh-vault-data", vault_id: "v", revision: 1 }), "missing or bad version"],
    [H({ version: 0 }), "unsupported version 0"],
    [H().replace('"version":1', '"version":-0'), "unsupported version 0"],
    [H({ version: -1 }), "unsupported version -1"],
    [H({ version: null }), "unsupported version 0"],
    [H().replace('"version":1', '"version":-9223372036854775808'), "unsupported version -9223372036854775808"],
    [H().replace('"version":1', '"version":-9223372036854775809'), "missing or bad version"],
    [H({ version: 2 }), "made by a newer passh; upgrade passh (data version)"],
    [H().replace('"version":1', '"version":9223372036854775807'), "made by a newer passh; upgrade passh (data version)"],
    [JSON.stringify({ format: "passh-vault-data", version: 1, revision: 1 }), "missing or bad vault_id"],
    [H({ vault_id: 5 }), "missing or bad vault_id"],
    [H({ vault_id: null }), "missing vault_id"],
    [H({ vault_id: "" }), "missing vault_id"],
    [JSON.stringify({ format: "passh-vault-data", version: 1, vault_id: "v" }), "missing or bad revision"],
    [H().replace('"revision":1', '"revision":-0'), "missing or bad revision"],
    [H({ revision: -1 }), "missing or bad revision"],
    [H().replace('"revision":1', '"revision":1E0'), "missing or bad revision"],
    [H().replace('"revision":1', '"revision":1.0'), "missing or bad revision"],
    [H().replace('"revision":1', '"revision":18446744073709551616'), "missing or bad revision"],
    [H({ revision: "1" }), "missing or bad revision"],
    [H().replace('"revision":1', '"revision":18446744073709551615'), "(ok)"],
    [H().replace('"revision":1', '"revision":01'), "invalid character '1' after object key:value pair"],
    [H({ revision: null, vault_id: null }), "missing vault_id"],
    [JSON.stringify({ format: "passh-vault-data", version: 1, vault_id: null }), "missing or bad revision"],
    [JSON.stringify({ format: "passh-vault-data", version: 1, vault_id: 5 }), "missing or bad vault_id"],
    [H({ vault_id: "v\u0001" }).replace("\\u0001", "\u0001"), "invalid character '\\x01' in string"],
    [H({ x: "a\u001fb" }).replace("\\u001f", "\u001f"), "invalid character '\\x1f' in string"],
    [H({ x: "a\u007fb" }), "(ok)"],
    [H({ vault_id: "a\u0000b" }), "(ok)"],
  ];
  for (const [json, want] of rows) {
    test(want + " ← " + JSON.stringify(json.slice(0, 50)), () => {
      const got = errText(() => parseVaultData(enc(json)));
      if (want === "(ok)") expect(got).toBe("(no error)");
      else if (want.startsWith("made by a newer")) expect(got).toBe(want);
      else expect(got).toBe("invalid vault data: " + want);
    });
  }
  test("error codes", () => {
    let e: unknown;
    try {
      parseVaultData(enc(H({ version: 2 })));
    } catch (x) {
      e = x;
    }
    expect(hasCode(e, "newer-data")).toBe(true);
    try {
      parseVaultData(enc("[]"));
    } catch (x) {
      e = x;
    }
    expect(hasCode(e, "invalid-data")).toBe(true);
  });
  test("nesting limit: 10 000 levels, the top-level object counting as 1", () => {
    const ok = H().replace('"deleted":[]', '"deleted":[],"z":' + "[".repeat(9999) + "]".repeat(9999));
    expect(detail(ok)).toBe("(no error)");
    const deep = H().replace('"deleted":[]', '"deleted":[],"z":' + "[".repeat(10000) + "]".repeat(10000));
    expect(detail(deep)).toBe("exceeded max depth");
    expect(detail('{"format":"x","a":' + '{"a":'.repeat(10000))).toBe("exceeded max depth");
  });
});

describe("syntax errors (the reference library's texts)", () => {
  const B = '{"format":"passh-vault-data","version":1,"vault_id":"v","revision":1,';
  const rows: Array<[string, string]> = [
    [B + '"x":"\\q"}', "invalid escape sequence `\\q` in string"],
    [B + '"x":"\\u12g4"}', "invalid escape sequence `\\u12g4` in string"],
    [B + '"x":-a}', "invalid character 'a' in numeric literal"],
    [B + '"x":1.a}', "invalid character 'a' in numeric literal"],
    [B + '"x":1ea}', "invalid character 'a' in numeric literal"],
    [B + '"x":tru,"y":1}', "invalid character ',' in literal true (expecting 'e')"],
    [B + '"x":nul,"y":1}', "invalid character ',' in literal null (expecting 'l')"],
    [B + '"x":fx}', "invalid character 'x' in literal false (expecting 'a')"],
    [B + "5:1}", "invalid character '5' looking for beginning of object key string"],
    [B + '"x" 1}', "invalid character '1' after object key"],
    [B + '"x":1 "y":2}', "invalid character '\"' after object key:value pair"],
    [B + '"x":[1 2]}', "invalid character '2' after array element"],
    [B + '"x":[1,]}', "invalid character ']' looking for beginning of value"],
    [B + '"x":1,}', "invalid character '}' looking for beginning of object key string"],
    [B + '"x":}', "invalid character '}' looking for beginning of value"],
    [B + "'x':1}", "invalid character '\\'' looking for beginning of object key string"],
    ["[tru]", "invalid character ']' in literal true (expecting 'e')"],
    ["[1,2", "unexpected end of JSON input"],
    ['{"format":"x","a":tru}', "invalid character '}' in literal true (expecting 'e')"],
    ['{"format":"passh-vault-data","a":"abc', "unexpected end of JSON input"],
    ["{}{}", "invalid character '{' after top-level value"],
  ];
  for (const [json, want] of rows) {
    test(want, () => expect(detail(json)).toBe(want));
  }
  test("invalid UTF-8 outside strings", () => {
    expect(detail(Uint8Array.from([0x7b, 0xff, 0x7d]))).toBe("invalid character '\\xff' looking for beginning of object key string");
  });
  test("tree spans", () => {
    const v = parseJSON(enc(' {"a" : [1, "x"], "b":{}} '));
    expect(v.kind).toBe("object");
    expect(v.start).toBe(1);
    expect(v.members!.map((m) => m.name)).toEqual(["a", "b"]);
    expect(v.members![0]!.value.items!.map((i) => i.kind)).toEqual(["number", "string"]);
  });
});

describe("decoding errors of members", () => {
  const rows: Array<[string, string]> = [
    [H({ saved_at: 5 }), "saved_at: json: cannot unmarshal number into Go value of type string"],
    [H({ saved_at: "bad" }), 'saved_at: bad time "bad"'],
    [H({ saved_at: "a\tb" }), 'saved_at: bad time "a\\tb"'],
    [H({ saved_at: "0000-01-01T00:30:00+01:00" }), 'saved_at: time "0000-01-01T00:30:00+01:00" is out of range'],
    [H({ entries: 5 }), "entries: json: cannot unmarshal number into Go value of type []model.Entry"],
    [H({ entries: null }), "(no error)"],
    [H({ entries: [null] }), "entries: expected an object, got null"],
    [H({ entries: [5] }), "entries: json: cannot unmarshal number into Go value of type map[string]jsontext.Value"],
    [H({ entries: [{}] }), "entry 1: missing id"],
    [H({ entries: [{ path: "p" }] }), "entry 1: missing id"],
    [H({ entries: [{ id: "i" }] }), "entry 1: missing path"],
    [H({ entries: [E({ path: null })] }), "entry 1: missing path"],
    [H({ entries: [E({ id: null })] }), "entry 1: missing id"],
    [H({ entries: [E({ id: 5 })] }), "entries: id: json: cannot unmarshal number into Go value of type string"],
    [H({ entries: [E({ path: "a//b" })] }), "entries: path: invalid path: it has an empty segment (//)"],
    [H({ entries: [E({ path: "" })] }), "entries: path: invalid path: it is empty"],
    [H({ entries: [E({ path: "p\u0000" })] }), "entries: path: invalid path: it contains a control character"],
    [H({ entries: [E({ path: 5 })] }), "entries: path: json: cannot unmarshal number into Go value of type paths.Path: JSON value must be string type"],
    [H({ entries: [E({ password: 5 })] }), "entries: password: json: cannot unmarshal number into Go value of type string"],
    [H({ entries: [E({ notes: true })] }), "entries: notes: json: cannot unmarshal bool into Go value of type string"],
    [H({ entries: [E({ tags: "x" })] }), "entries: tags: json: cannot unmarshal string into Go value of type []string"],
    [H({ entries: [E({ tags: [5] })] }), "entries: tags: json: cannot unmarshal number into .0 of type string"],
    [H({ entries: [E({ tags: ["a", 5] })] }), "entries: tags: json: cannot unmarshal number into .1 of type string"],
    [H({ entries: [E({ tags: [{}] })] }), "entries: tags: json: cannot unmarshal object into .0 of type string"],
    [H({ entries: [E({ fields: "x" })] }), "entries: fields: json: cannot unmarshal string into Go value of type []model.Field"],
    [H({ entries: [E({ fields: [5] })] }), "entries: fields: json: cannot unmarshal number into Go value of type map[string]jsontext.Value"],
    [H({ entries: [E({ fields: [null] })] }), "entries: fields: expected an object, got null"],
    [H({ entries: [E({ fields: [{ key: 5, value: "x" }] })] }), "entries: fields: key: json: cannot unmarshal number into Go value of type string"],
    [H({ entries: [E({ fields: [{ value: 5, key: 5 }] })] }), "entries: fields: key: json: cannot unmarshal number into Go value of type string"],
    [H({ entries: [E({ fields: [{ key: "k", value: 5 }] })] }), "entries: fields: value: json: cannot unmarshal number into Go value of type string"],
    [H({ entries: [E({ created_at: 5 })] }), "entries: created_at: json: cannot unmarshal number into Go value of type string"],
    [H({ entries: [E({ created_at: "x" })] }), 'entries: created_at: bad time "x"'],
    [H({ entries: [E({ updated_at: "y", created_at: "x" })] }), 'entries: created_at: bad time "x"'],
    [H({ deleted: 5 }), "deleted: json: cannot unmarshal number into Go value of type []model.Tombstone"],
    [H({ deleted: [5] }), "deleted: json: cannot unmarshal number into Go value of type map[string]jsontext.Value"],
    [H({ deleted: [null] }), "deleted: expected an object, got null"],
    [H({ deleted: [{ id: 5 }] }), "deleted: id: json: cannot unmarshal number into Go value of type string"],
    [H({ deleted: [{ deleted_at: "x", id: 5 }] }), "deleted: id: json: cannot unmarshal number into Go value of type string"],
    [H({ deleted: [{ id: "x", deleted_at: "y" }] }), 'deleted: deleted_at: bad time "y"'],
    [H({ deleted: [{ deleted_at: "2026-01-01T00:00:00Z" }] }), "tombstone 1: missing id"],
    // order of the members: fixed, whatever the input order
    [JSON.stringify({ format: "passh-vault-data", version: 1, vault_id: "v", revision: 1, entries: 5, saved_at: "x" }), 'saved_at: bad time "x"'],
    [JSON.stringify({ format: "passh-vault-data", version: 1, vault_id: "v", revision: 1, deleted: 5, entries: 5 }), "entries: json: cannot unmarshal number into Go value of type []model.Entry"],
    [H({ entries: [{ created_at: "x", id: "i", path: "a//b" }] }), "entries: path: invalid path: it has an empty segment (//)"],
    [H({ entries: [{ path: "a//b", id: 5 }] }), "entries: id: json: cannot unmarshal number into Go value of type string"],
    [H({ entries: [{ fields: 5, tags: 5, id: "x", path: "p" }] }), "entries: tags: json: cannot unmarshal number into Go value of type []string"],
    [H({ entries: [{ created_at: "x", notes: 5, id: "x", path: "p" }] }), "entries: notes: json: cannot unmarshal number into Go value of type string"],
    [H({ entries: [E({ password: "\n" }), E({ id: "b", path: "a//b" })] }), "entries: path: invalid path: it has an empty segment (//)"],
  ];
  for (const [json, want] of rows) test(want, () => expect(detail(json)).toBe(want));
});

describe("validation (§4.3, §4.4)", () => {
  const rows: Array<[unknown[], Record<string, unknown>, string]> = [
    [[E({ password: "a\rb" })], {}, "entry 1: invalid entry: password must be a single line"],
    [[E({ username: "a\nb" })], {}, "entry 1: invalid entry: username must be a single line"],
    [[E({ url: "\n", username: "\n" })], {}, "entry 1: invalid entry: username must be a single line"],
    [[E({ username: "\n", url: "\n", password: "\n" })], {}, "entry 1: invalid entry: password must be a single line"],
    [[E({ tags: ["a,b"] })], {}, 'entry 1: invalid tag "a,b": it contains a comma'],
    [[E({ tags: [null] })], {}, "entry 1: invalid tag: a tag can't be empty"],
    [[E({ tags: ["a\u0001"] })], {}, 'entry 1: invalid tag "a\\x01": it contains a control character'],
    [[E({ tags: ["a", "a,b"] })], {}, 'entry 1: invalid tag "a,b": it contains a comma'],
    [[E({ tags: ["a,b"], password: "\n" })], {}, "entry 1: invalid entry: password must be a single line"],
    [[E({ tags: ["a,b"], fields: [{ key: "URL", value: "" }] })], {}, 'entry 1: invalid tag "a,b": it contains a comma'],
    [[E({ fields: [{ key: "URL", value: "x" }] })], {}, 'entry 1: invalid entry: "URL" can\'t be a custom field key'],
    [[E({ fields: [{ key: "bad key", value: "x" }] })], {}, 'entry 1: invalid entry: field key "bad key" is not valid (letters, digits, then also _ . -)'],
    [[E({ fields: [{ value: "x" }] })], {}, 'entry 1: invalid entry: field key "" is not valid (letters, digits, then also _ . -)'],
    [[E({ fields: [{ key: "pin", value: "a\nb" }] })], {}, "entry 1: invalid entry: field pin must be a single line"],
    [[E({ fields: [{ key: "bad key", value: "\n" }] })], {}, 'entry 1: invalid entry: field key "bad key" is not valid (letters, digits, then also _ . -)'],
    [[E({ fields: [{ key: "ok", value: "\n" }, { key: "URL", value: "" }] })], {}, "entry 1: invalid entry: field ok must be a single line"],
    [[E({ fields: [{ key: "\u0661x\u0301_.-", value: "" }, { key: "_x", value: "" }] })], {}, 'entry 1: invalid entry: field key "_x" is not valid (letters, digits, then also _ . -)'],
    [[E({ fields: [{ key: "Notes", value: "" }, { key: "PASSWORD", value: "" }, { key: "Tag\u017f", value: "" }] })], {}, 'entry 1: invalid entry: "Tagſ" can\'t be a custom field key'],
    [[E({ fields: [{ key: "u\u017fername", value: "" }] })], {}, 'entry 1: invalid entry: "uſername" can\'t be a custom field key'],
    [[E(), E({ path: "q" })], {}, 'entry 2: duplicate id "i1"'],
    [[E(), E({ id: "i2" })], {}, 'entry 2: duplicate path "p"'],
    [[E({ path: "caf\u00e9" }), E({ id: "i2", path: "cafe\u0301" })], {}, 'entry 2: duplicate path "café"'],
    [[E(), E()], {}, 'entry 2: duplicate id "i1"'],
    [[E(), E({ path: "q", password: "\n" })], {}, "entry 2: invalid entry: password must be a single line"],
    [[E({ id: "", password: "\n" })], {}, "entry 1: invalid entry: password must be a single line"],
    [[E({ id: "" }), E({ id: "i2", path: "q", password: "\n" })], {}, "entry 2: invalid entry: password must be a single line"],
    [[E({ password: "\n" })], { vault_id: "" }, "entry 1: invalid entry: password must be a single line"],
    [[E({ password: "\n" })], { deleted: [{}] }, "entry 1: invalid entry: password must be a single line"],
    [[E({ id: "" })], { vault_id: "" }, "missing vault_id"],
    [[E({ id: "" })], { deleted: [{}] }, "entry 1: missing id"],
    [[E({ password: "pw\u0000" })], {}, "(no error)"],
  ];
  for (const [entries, extra, want] of rows) test(want, () => expect(detail(H({ entries, ...extra }))).toBe(want));

  test("validateVaultData before a write", () => {
    const d = parseVaultData(enc(EXAMPLE));
    validateVaultData(d);
    d.entries[0]!.password = "a\nb";
    expect(errText(() => validateVaultData(d))).toBe("invalid vault data: entry 1: invalid entry: password must be a single line");
    d.entries[0]!.password = "\ud800";
    expect(errText(() => validateVaultData(d))).toBe("invalid vault data: entry 1: invalid entry: password is not valid UTF-8");
    d.entries[0]!.password = "";
    d.entries[0]!.path = "a//b";
    expect(errText(() => validateVaultData(d))).toBe("invalid vault data: entry 1: invalid path: it has an empty segment (//)");
  });
});

describe("reading rules", () => {
  test("duplicate keys: last wins; null → zero values", () => {
    const d = parseVaultData(enc('{"format":"x","format":"passh-vault-data","version":1,"vault_id":"a","vault_id":"b","revision":null,"saved_at":null,"entries":[{"id":"i","path":"p","password":"1","password":"2","x":1,"x":2}],"deleted":null}'));
    expect(d.vaultId).toBe("b");
    expect(d.revision).toBe(0n);
    expect(d.savedAt).toBe(ZERO_TIME);
    expect(d.entries[0]!.password).toBe("2");
    expect([...d.entries[0]!.unknown]).toEqual([["x", "2"]]);
    expect(d.deleted).toEqual([]);
  });
  test("escaped key names", () => {
    const d = parseVaultData(enc('{"form\\u0061t":"passh-vault-data","version":1,"vault_id":"v","revision":1,"Password":"x"}'));
    expect([...d.unknown]).toEqual([["Password", '"x"']]);
  });
  test("invalid UTF-8 and lone surrogates → U+FFFD (one per byte)", () => {
    const head = enc('{"format":"passh-vault-data","version":1,"vault_id":"v","revision":1,"entries":[{"id":"b","path":"p","username":"');
    const mid = Uint8Array.from([0x41, 0xe2, 0x82, 0x42, 0xed, 0xa0, 0x80, 0x43, 0xff, 0xf0, 0x9f, 0x98, 0x44, 0xc0, 0xaf]);
    const tail = enc('","url":"\\ud800\\u0041\\udc00\\ud800\\ud83d\\ude00\\ud83d"}],"y":"');
    const bytes = new Uint8Array([...head, ...mid, ...tail, 0xff, ...enc('"}')]);
    const d = parseVaultData(bytes);
    expect(d.entries[0]!.username).toBe("A\ufffd\ufffdB\ufffd\ufffd\ufffdC\ufffd\ufffd\ufffd\ufffdD\ufffd\ufffd");
    expect(d.entries[0]!.url).toBe("\ufffdA\ufffd\ufffd😀\ufffd");
    // unknown values: invalid bytes replaced too (the proposed fix of audit #31)
    expect(d.unknown.get("y")).toBe('"\ufffd"');
  });
  test("paths to NFC, tags normalized and de-duplicated", () => {
    const d = parseVaultData(enc(H({ entries: [E({ path: "cafe\u0301/x", tags: [" b ", "a", "b", "e\u0301", "\u00e9", "x\u3000"] })] })));
    expect(d.entries[0]!.path).toBe("café/x");
    expect(d.entries[0]!.tags).toEqual(["b", "a", "é", "x"]);
  });
  test("times", () => {
    const d = parseVaultData(enc(H({ saved_at: "\u0032026-01-01T00:30:00.999+01:00" })));
    expect(formatTime(d.savedAt)).toBe("2025-12-31T23:30:00Z");
  });
});

describe("unknown keys and serialization (§4.5, §4.6)", () => {
  // Reproduces what reference/passh-go wrote for this input after a change (tmp exploration).
  const input =
    '{ "zeta": {"b" : [1E0, -0, 1.50, "\\/", "\\ud800", "\u2028", {}, [], {"d":1,"d":2}], "a":null},' +
    '"format":"passh-vault-data","version":1,"vault_id":"v\\u0000\\u2028<>&\u007f","revision":300,"saved_at":"2026-01-01T00:00:00Z",' +
    '"\\u0061":true, "B":1, "e\\u0301":2, "\u00e9":3, "\uffff":4, "\ud83d\ude00":5,' +
    '"entries":[{"id":"i1","path":"cafe\\u0301/x","password":"pw\\t\\b\\f\\u0001\\u001f \\"\\\\ \\u2029 <&>","username":"u","url":"","tags":["b"],' +
    '"fields":[{"key":"k","value":"v","zz":{ "x" : [ ] },"aa":"s"},{"key":"k","value":"v"}],"notes":"line1\\nline2\\r\\n","created_at":"2026-01-01T09:00:00Z","updated_at":null,"extra":[1,{"q":[]}]}],' +
    '"deleted":[{"id":"t1","deleted_at":"2026-01-01T00:00:00Z","why":"x"},{"id":"t2"}],"empty":{} , "emptyarr":[ ] }';
  const want = `{
  "format": "passh-vault-data",
  "version": 1,
  "vault_id": "v\\u0000\\u2028<>&\u007f",
  "revision": 300,
  "saved_at": "2026-01-01T00:00:00Z",
  "entries": [
    {
      "id": "i1",
      "path": "café/x",
      "password": "pw\\t\\b\\f\\u0001\\u001f \\"\\\\ \\u2029 <&>",
      "username": "u",
      "url": "",
      "tags": [
        "b"
      ],
      "fields": [
        {
          "key": "k",
          "value": "v",
          "aa": "s",
          "zz": {
            "x": []
          }
        },
        {
          "key": "k",
          "value": "v"
        }
      ],
      "notes": "line1\\nline2\\r\\n",
      "created_at": "2026-01-01T09:00:00Z",
      "updated_at": "0001-01-01T00:00:00Z",
      "extra": [
        1,
        {
          "q": []
        }
      ]
    }
  ],
  "deleted": [
    {
      "id": "t1",
      "deleted_at": "2026-01-01T00:00:00Z",
      "why": "x"
    },
    {
      "id": "t2",
      "deleted_at": "0001-01-01T00:00:00Z"
    }
  ],
  "B": 1,
  "a": true,
  "empty": {},
  "emptyarr": [],
  "e\u0301": 2,
  "zeta": {
    "b": [
      1E0,
      -0,
      1.50,
      "\\/",
      "\\ud800",
      "\u2028",
      {},
      [],
      {
        "d": 1,
        "d": 2
      }
    ],
    "a": null
  },
  "\u00e9": 3,
  "\uffff": 4,
  "😀": 5
}
`;
  test("written as the reference writes it", () => {
    const d = parseVaultData(enc(input));
    expect(serializeVaultDataText(d)).toBe(want);
    // and that output reads back to the same data
    expect(vaultDataEqual(parseVaultData(serializeVaultData(d)), d)).toBe(true);
    expect(serializeVaultDataText(parseVaultData(enc(want)))).toBe(want);
  });
  test("string escaping", () => {
    const d = newVaultData(0);
    d.vaultId = '"\\\n\r\t\b\f\u0000\u001f\u007f\u2028\u2029<>&é😀';
    expect(serializeVaultDataText(d)).toContain('"vault_id": "\\"\\\\\\n\\r\\t\\b\\f\\u0000\\u001f\u007f\\u2028\\u2029<>&é😀",');
  });
});

describe("times (§4.1 grammar)", () => {
  const accepted: Array<[string, string]> = [
    ["2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
    ["2026-01-01T00:00:00+01:00", "2025-12-31T23:00:00Z"],
    ["2026-01-01T00:00:00-00:00", "2026-01-01T00:00:00Z"],
    ["2026-01-01T00:00:00.999999999999Z", "2026-01-01T00:00:00Z"],
    ["2026-01-01T9:00:00Z", "2026-01-01T09:00:00Z"],
    ["2026-01-01T09:00:00,5Z", "2026-01-01T09:00:00Z"],
    ["2026-01-01T00:00:00+24:00", "2025-12-31T00:00:00Z"],
    ["2026-01-01T00:00:00+00:60", "2025-12-31T23:00:00Z"],
    ["2026-01-01T00:00:00+24:60", "2025-12-30T23:00:00Z"],
    ["0000-01-01T00:00:00Z", "0000-01-01T00:00:00Z"],
    ["9999-12-31T23:59:59Z", "9999-12-31T23:59:59Z"],
    ["2024-02-29T00:00:00Z", "2024-02-29T00:00:00Z"],
    ["2026-01-01T00:00:00.123456789+05:30", "2025-12-31T18:30:00Z"],
    ["2000-02-29T00:00:00Z", "2000-02-29T00:00:00Z"],
    ["2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00Z"],
    ["0001-01-01T00:00:00Z", "0001-01-01T00:00:00Z"],
    ["2026-01-01T23:59:59.9999999999999999999999999999-23:59", "2026-01-02T23:58:59Z"],
  ];
  for (const [s, w] of accepted) test(`accepts ${s}`, () => expect(formatTime(parseTime(s))).toBe(w));
  const outOfRange = ["0000-01-01T00:30:00+01:00", "9999-12-31T23:30:00-01:00"];
  for (const s of outOfRange) test(`out of range ${s}`, () => expect(parseTimeResult(s)).toBe("range"));
  const refused = [
    "2026-02-29T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T23:59:60Z", "2026-01-01T00:00:00+0100", "2026-01-01T00:00:00+01",
    "2026-01-01T00:00:00+25:00", "2026-01-01T00:00:00.Z", "2026-01-01t00:00:00Z", "2026-01-01T00:00:00z", "2026-01-01 00:00:00Z",
    " 2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z ", "2026-01-01T00:00:00", "2026-01-01T00:00:00+01:61", "2026-1-01T00:00:00Z",
    "02026-01-01T00:00:00Z", "", "2026-01-01T00:00Z", "2026-01-01T000:00:00Z", "2026-13-01T00:00:00Z", "2026-00-01T00:00:00Z",
    "2026-01-00T00:00:00Z", "2026-01-32T00:00:00Z", "2026-01-01T00:60:00Z", "1900-02-29T00:00:00Z", "2026-01-01T00:00:00+1:00",
    "2026-01-01T00:00:00+01:0", "2026-01-01T00:00:00.5.5Z", "2026-01-01T0:0:00Z", "2026-01-01T00:00:00\u221201:00",
    "\uff12026-01-01T00:00:00Z", "2026-01-01T00:00:00+2:00",
  ];
  for (const s of refused) test(`refuses ${JSON.stringify(s)}`, () => expect(parseTimeResult(s)).toBe("bad"));
  test("messages", () => {
    expect(errText(() => parseTime("x\ty"))).toBe('bad time "x\\ty"');
    expect(errText(() => parseTime("0000-01-01T00:30:00+01:00"))).toBe('time "0000-01-01T00:30:00+01:00" is out of range');
  });
  test("format", () => {
    expect(formatTime(ZERO_TIME)).toBe("0001-01-01T00:00:00Z");
    expect(formatTime(0)).toBe("1970-01-01T00:00:00Z");
    expect(formatTime(-1)).toBe("1969-12-31T23:59:59Z");
    expect(formatTime(1_700_000_000)).toBe("2023-11-14T22:13:20Z");
    for (let t = -62167219200; t < 253402300799; t += 86400 * 97 + 3607) expect(parseTime(formatTime(t))).toBe(t);
  });
});

describe("property: parse(serialize(x)) == x", () => {
  const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]!;
  const chars = ["a", "Z", "0", " ", "é", "e\u0301", "😀", "\u2028", "\u0000", "\u007f", '"', "\\", "/", "<", "\t", "漢", "\u200b"];
  const rstr = (n = 6) => Array.from({ length: Math.floor(Math.random() * n) }, () => pick(chars)).join("");
  const line = () => rstr().replace(/[\n\r]/g, "");
  const rawValues = ["1", "-0", "1E0", "1.50", '"x"', '"\\/"', "null", "true", "{}", "[]", '{"a":[1,{"b":null}],"a":2}', '["\\ud800","\u2028"]'];
  const unknowns = () => new Map(Array.from({ length: Math.floor(Math.random() * 3) }, () => [rstr(4) || "k", pick(rawValues)] as [string, string]));
  test("random data", () => {
    for (let round = 0; round < 200; round++) {
      const d: VaultData = newVaultData(Math.floor(Math.random() * 2e9));
      d.revision = BigInt(Math.floor(Math.random() * 1e6));
      d.unknown = unknowns();
      const n = Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) {
        const e: Entry = {
          id: newId(),
          path: "p" + i + "/" + (line() || "x").replace(/[\u0000-\u001f\u007f-\u009f/]/g, "_").replace(/^-/, "_").normalize("NFC"),
          password: line(),
          username: line(),
          url: line(),
          tags: [...new Set(Array.from({ length: Math.floor(Math.random() * 3) }, () => ("t" + rstr(3)).replace(/[\u0000-\u001f\u007f-\u009f,]/g, "_").normalize("NFC").trim()))],
          fields: Array.from({ length: Math.floor(Math.random() * 3) }, () => ({ key: "k" + Math.floor(Math.random() * 9), value: line(), unknown: unknowns() })),
          notes: rstr(10),
          createdAt: Math.floor(Math.random() * 2e9),
          updatedAt: ZERO_TIME,
          unknown: unknowns(),
        };
        d.entries.push(e);
      }
      d.deleted.push({ id: newId(), deletedAt: 5, unknown: unknowns() });
      const back = parseVaultData(serializeVaultData(d));
      expect(vaultDataEqual(back, d)).toBe(true);
      expect(serializeVaultDataText(back)).toBe(serializeVaultDataText(d));
    }
  });
});
