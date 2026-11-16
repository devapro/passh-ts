// The export formats against the examples and test vectors of import-export.md §2.

import { describe, expect, test } from "bun:test";
import { addEntry, emptyContent, newVaultData, parseVaultData, timeFromParts, type Entry, type Field, type VaultData } from "../model/index.ts";
import { utf8Encode } from "../util/unicode.ts";
import { bitwardenId, csvCell, customFieldCount, formatBitwardenExport, formatCSVExport, formatExport, formatJSONExport, selectEntries, totpFieldIndex } from "./format.ts";

const T0 = timeFromParts(2026, 11, 16, 18, 21, 42);

const field = (key: string, value: string): Field => ({ key, value, unknown: new Map() });

/** The two entries of the appendix's examples (§2.4–§2.6). */
function exampleData(): VaultData {
  let d: VaultData = { ...newVaultData(T0), vaultId: "364c1458-fbc9-46a7-9a1f-3d275180e828", revision: 2n };
  d = addEntry(d, "work/github", {
    ...emptyContent(),
    password: "s3cr3t-P@ss",
    username: "arsenii",
    url: "https://github.com",
    tags: ["work", "dev", "2fa"],
    fields: [field("recovery-email", "me@example.com"), field("otp", "otpauth://totp/GitHub:arsenii?secret=JBSWY3DPEHPK3PXP")],
    notes: 'Recovery codes in the safe.\nSecond line, "quoted".',
  }, { now: T0, id: "56d9d9ab-982f-41d3-9424-9e15b976fb93" }).data;
  d = addEntry(d, "router", { ...emptyContent(), password: "=admin" }, { now: T0, id: "7ecc4de1-e4b2-4672-9bb9-2b764e680774" }).data;
  return d;
}

const JSON_EXAMPLE = `{
  "format": "passh-vault-data",
  "version": 1,
  "vault_id": "364c1458-fbc9-46a7-9a1f-3d275180e828",
  "revision": 2,
  "saved_at": "2026-11-16T18:21:42Z",
  "exported_at": "2026-11-16T18:21:42Z",
  "entries": [
    {
      "id": "7ecc4de1-e4b2-4672-9bb9-2b764e680774",
      "path": "router",
      "password": "=admin",
      "username": "",
      "url": "",
      "tags": [],
      "fields": [],
      "notes": "",
      "created_at": "2026-11-16T18:21:42Z",
      "updated_at": "2026-11-16T18:21:42Z"
    },
    {
      "id": "56d9d9ab-982f-41d3-9424-9e15b976fb93",
      "path": "work/github",
      "password": "s3cr3t-P@ss",
      "username": "arsenii",
      "url": "https://github.com",
      "tags": [
        "work",
        "dev",
        "2fa"
      ],
      "fields": [
        {
          "key": "recovery-email",
          "value": "me@example.com"
        },
        {
          "key": "otp",
          "value": "otpauth://totp/GitHub:arsenii?secret=JBSWY3DPEHPK3PXP"
        }
      ],
      "notes": "Recovery codes in the safe.\\nSecond line, \\"quoted\\".",
      "created_at": "2026-11-16T18:21:42Z",
      "updated_at": "2026-11-16T18:21:42Z"
    }
  ]
}
`;

const BW_EXAMPLE = `{
  "encrypted": false,
  "folders": [
    {
      "id": "07843e65-6a7c-8b82-8397-6aa43dbcb6ff",
      "name": "work"
    }
  ],
  "items": [
    {
      "passwordHistory": null,
      "revisionDate": "2026-11-16T18:21:42.000Z",
      "creationDate": "2026-11-16T18:21:42.000Z",
      "deletedDate": null,
      "id": "5879b159-7a3b-8709-a577-3a8f726ba26a",
      "organizationId": null,
      "folderId": null,
      "type": 1,
      "reprompt": 0,
      "name": "router",
      "notes": null,
      "favorite": false,
      "login": {
        "fido2Credentials": [],
        "username": null,
        "password": "=admin",
        "totp": null
      },
      "collectionIds": null
    },
    {
      "passwordHistory": null,
      "revisionDate": "2026-11-16T18:21:42.000Z",
      "creationDate": "2026-11-16T18:21:42.000Z",
      "deletedDate": null,
      "id": "87c1129d-bd48-85fb-a157-7e78ebbb7a0d",
      "organizationId": null,
      "folderId": "07843e65-6a7c-8b82-8397-6aa43dbcb6ff",
      "type": 1,
      "reprompt": 0,
      "name": "github",
      "notes": "Recovery codes in the safe.\\nSecond line, \\"quoted\\".",
      "favorite": false,
      "fields": [
        {
          "name": "recovery-email",
          "value": "me@example.com",
          "type": 0,
          "linkedId": null
        },
        {
          "name": "tags",
          "value": "work, dev, 2fa",
          "type": 0,
          "linkedId": null
        }
      ],
      "login": {
        "fido2Credentials": [],
        "uris": [
          {
            "match": null,
            "uri": "https://github.com"
          }
        ],
        "username": "arsenii",
        "password": "s3cr3t-P@ss",
        "totp": "otpauth://totp/GitHub:arsenii?secret=JBSWY3DPEHPK3PXP"
      },
      "collectionIds": null
    }
  ]
}
`;

describe("the appendix's examples", () => {
  const d = exampleData();
  const sel = selectEntries(d);

  test("selection is sorted by path", () => {
    expect(sel.map((e) => e.path)).toEqual(["router", "work/github"]);
  });

  test("json (§2.4)", () => {
    expect(formatJSONExport(d, sel, T0)).toBe(JSON_EXAMPLE);
  });

  test("the json export reads back as vault data (§2.4 last line)", () => {
    const back = parseVaultData(utf8Encode(formatJSONExport(d, sel, T0)));
    expect(back.entries.map((e) => e.path)).toEqual(["router", "work/github"]);
    expect(back.unknown.get("exported_at")).toBe('"2026-11-16T18:21:42Z"');
  });

  test("csv (§2.5)", () => {
    expect(formatCSVExport(sel)).toBe(
      'folder,name,username,password,url,tags,notes\r\n,router,,=admin,,,\r\nwork,github,arsenii,s3cr3t-P@ss,https://github.com,"work, dev, 2fa","Recovery codes in the safe.\nSecond line, ""quoted""."\r\n',
    );
    expect(formatCSVExport(sel, { spreadsheetSafe: true }).split("\r\n")[1]).toBe(",router,,'=admin,,,");
  });

  test("bitwarden-json (§2.6)", () => {
    expect(formatBitwardenExport(d, sel)).toBe(BW_EXAMPLE);
  });

  test("an empty selection", () => {
    expect(formatBitwardenExport(d, [])).toBe('{\n  "encrypted": false,\n  "folders": [],\n  "items": []\n}\n');
    expect(formatCSVExport([])).toBe("folder,name,username,password,url,tags,notes\r\n");
    expect(formatJSONExport(d, [], T0)).toContain('"entries": []\n}\n');
  });

  test("formatExport gives the bytes", () => {
    expect(new TextDecoder().decode(formatExport("json", d, sel, { exportedAt: T0 }))).toBe(JSON_EXAMPLE);
  });
});

describe("bitwarden ids (§2.6 test vectors)", () => {
  test("vectors", () => {
    expect(bitwardenId("item", "56d9d9ab-982f-41d3-9424-9e15b976fb93")).toBe("87c1129d-bd48-85fb-a157-7e78ebbb7a0d");
    expect(bitwardenId("folder", "364c1458-fbc9-46a7-9a1f-3d275180e828", "work")).toBe("07843e65-6a7c-8b82-8397-6aa43dbcb6ff");
    expect(bitwardenId("item", "8d1e7a90-0000-4000-8000-000000000001")).toBe("6cea433d-74fd-8314-a7e1-35702e643c3b");
    expect(bitwardenId("item", "7ecc4de1-e4b2-4672-9bb9-2b764e680774")).toBe("5879b159-7a3b-8709-a577-3a8f726ba26a");
  });
});

describe("selection (§2.2)", () => {
  let d = newVaultData(T0);
  for (const p of ["work", "work/x", "work/a/b", "workshop/x", "work-old/y", "b"]) {
    d = addEntry(d, p, { ...emptyContent(), tags: p.includes("a") ? ["t", "u"] : ["t"] }, { now: T0 }).data;
  }
  test("a folder holds entries strictly inside it", () => {
    expect(selectEntries(d, { folder: "work" }).map((e) => e.path)).toEqual(["work/a/b", "work/x"]);
  });
  test("tags must all match", () => {
    expect(selectEntries(d, { tags: ["t", "u"] }).map((e) => e.path)).toEqual(["work/a/b"]);
    expect(selectEntries(d, { tags: ["t"] }).map((e) => e.path)).toEqual(["b", "work", "work/a/b", "work/x", "work-old/y", "workshop/x"]);
  });
});

describe("csv cells (§2.5)", () => {
  test("quoting", () => {
    expect(csvCell("")).toBe("");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("a\rb")).toBe('"a\rb"');
    expect(csvCell(" a")).toBe('" a"');
    expect(csvCell("a ")).toBe('"a "');
    expect(csvCell("\ta")).toBe('"\ta"');
    expect(csvCell("a\t")).toBe('"a\t"');
    // Not quoted: other spaces, `\.`, control characters.
    expect(csvCell(" x")).toBe(" x");
    expect(csvCell(" x")).toBe(" x");
    expect(csvCell("\\.")).toBe("\\.");
    expect(csvCell("\vx")).toBe("\vx");
    expect(csvCell("a b")).toBe("a b");
  });
  test("--spreadsheet-safe", () => {
    for (const c of ["=", "+", "-", "@"]) expect(csvCell(c + "1", true)).toBe("'" + c + "1");
    expect(csvCell("\tTAB", true)).toBe("'\tTAB");
    expect(csvCell("\rCR", true)).toBe("\"'\rCR\"");
    expect(csvCell("@p,q", true)).toBe("\"'@p,q\"");
    expect(csvCell(" =x", true)).toBe('" =x"');
    expect(csvCell("'=x", true)).toBe("'=x");
    expect(csvCell("", true)).toBe("");
  });
  test("the header is never prefixed; folder and name are", () => {
    let d = newVaultData(T0);
    d = addEntry(d, "=f/@n", { ...emptyContent(), password: "-p" }, { now: T0 }).data;
    expect(formatCSVExport(d.entries, { spreadsheetSafe: true })).toBe("folder,name,username,password,url,tags,notes\r\n'=f,'@n,,'-p,,,\r\n");
  });
  test("line breaks in notes stay as they are", () => {
    let d = newVaultData(T0);
    d = addEntry(d, "n", { ...emptyContent(), notes: "line1\r\nline2\rline3\n" }, { now: T0 }).data;
    expect(formatCSVExport(d.entries)).toBe('folder,name,username,password,url,tags,notes\r\n,n,,,,,"line1\r\nline2\rline3\n"\r\n');
  });
});

describe("bitwarden-json details (§2.6)", () => {
  function one(fields: Field[], extra: Partial<ReturnType<typeof emptyContent>> = {}): Entry {
    let d = newVaultData(T0);
    d = addEntry(d, "a/b/c/leaf", { ...emptyContent(), fields, ...extra }, { now: T0, id: "e1" }).data;
    return d.entries[0]!;
  }

  test("ancestors are listed and sorted by bytes", () => {
    let d = newVaultData(T0);
    for (const p of ["work/dev/x", "work-old/y", "a/b/c/leaf", "work/z"]) d = addEntry(d, p, emptyContent(), { now: T0 }).data;
    const out = JSON.parse(formatBitwardenExport(d, selectEntries(d)));
    expect(out.folders.map((f: { name: string }) => f.name)).toEqual(["a", "a/b", "a/b/c", "work", "work-old", "work/dev"]);
    const leaf = out.items.find((i: { name: string }) => i.name === "leaf");
    expect(leaf.folderId).toBe(bitwardenId("folder", d.vaultId, "a/b/c"));
  });

  test("totp: the first otp field in any case, else the first otpauth:// value", () => {
    expect(totpFieldIndex([field("x", "otpauth://a"), field("OTP", "b")])).toBe(1);
    expect(totpFieldIndex([field("x", "y"), field("u", "OTPAUTH://totp/B")])).toBe(1);
    expect(totpFieldIndex([field("x", "y")])).toBe(-1);
    // audit #39: an empty otp value — the fix skips it; quirks reproduce v0.6
    expect(totpFieldIndex([field("otp", ""), field("x", "otpauth://a")])).toBe(1);
    expect(totpFieldIndex([field("otp", ""), field("x", "otpauth://a")], true)).toBe(0);
    expect(totpFieldIndex([field("Otp", ""), field("x", "y")])).toBe(-1);
  });

  test("hidden fields, empty values, the tags field", () => {
    const e = one([field("OTP", ""), field("x", "otpauth://totp/B"), field("Password", "pw2"), field("pin", ""), field("pAsSwOrD", "")], { tags: ["t1", "t 2"] });
    const d = { ...newVaultData(T0), entries: [e] };
    const quirk = JSON.parse(formatBitwardenExport(d, [e], { quirks: true })).items[0];
    expect(quirk.login.totp).toBe("");
    expect(quirk.fields).toEqual([
      { name: "x", value: "otpauth://totp/B", type: 1, linkedId: null },
      { name: "Password", value: "pw2", type: 1, linkedId: null },
      { name: "pin", value: "", type: 0, linkedId: null },
      { name: "pAsSwOrD", value: "", type: 1, linkedId: null },
      { name: "tags", value: "t1, t 2", type: 0, linkedId: null },
    ]);
    const fixed = JSON.parse(formatBitwardenExport(d, [e])).items[0];
    expect(fixed.login.totp).toBe("otpauth://totp/B");
    expect(fixed.fields[0]).toEqual({ name: "OTP", value: "", type: 1, linkedId: null });
  });

  test("no fields: the key is left out; no url: no uris", () => {
    const e = one([]);
    const text = formatBitwardenExport({ ...newVaultData(T0), entries: [e] }, [e]);
    expect(text).not.toContain('"fields"');
    expect(text).not.toContain('"uris"');
    expect(text).toContain('"notes": null');
  });

  test("§2.3 string escapes and literal characters", () => {
    const e = one([], { password: "  <>&/\x7f\u0085\x01\b\f\t", notes: "a\r\nb" });
    const text = formatBitwardenExport({ ...newVaultData(T0), entries: [e] }, [e]);
    expect(text).toContain('"password": "\\u2028\\u2029<>&/\x7f\u0085\\u0001\\b\\f\\t"');
    expect(text).toContain('"notes": "a\\r\\nb"');
  });
});

describe("json details (§2.4)", () => {
  test("unknown keys at every level, re-indented, sorted; deleted left out", () => {
    const raw = `{"format":"passh-vault-data","version":1,"vault_id":"v","revision":5,"saved_at":"2026-01-01T00:00:00Z",
      "zz":{"b":[1E0,-0,{}],"a":"\\u00e9\\/"},"aa":[],
      "entries":[{"id":"i","path":"p","created_at":null,"x-e":true,"fields":[{"key":"k","value":"v","x-f":null}]}],
      "deleted":[{"id":"gone","deleted_at":"2026-01-01T00:00:00Z"}]}`;
    const d = parseVaultData(utf8Encode(raw));
    const out = formatJSONExport(d, selectEntries(d), T0);
    expect(out).toBe(`{
  "format": "passh-vault-data",
  "version": 1,
  "vault_id": "v",
  "revision": 5,
  "saved_at": "2026-01-01T00:00:00Z",
  "exported_at": "2026-11-16T18:21:42Z",
  "entries": [
    {
      "id": "i",
      "path": "p",
      "password": "",
      "username": "",
      "url": "",
      "tags": [],
      "fields": [
        {
          "key": "k",
          "value": "v",
          "x-f": null
        }
      ],
      "notes": "",
      "created_at": "0001-01-01T00:00:00Z",
      "updated_at": "0001-01-01T00:00:00Z",
      "x-e": true
    }
  ],
  "aa": [],
  "zz": {
    "b": [
      1E0,
      -0,
      {}
    ],
    "a": "\\u00e9\\/"
  }
}
`);
  });

  test("a stored unknown exported_at (audit #6)", () => {
    const raw = `{"format":"passh-vault-data","version":1,"vault_id":"v","revision":5,"exported_at":"old","entries":[]}`;
    const d = parseVaultData(utf8Encode(raw));
    const fixed = formatJSONExport(d, [], T0);
    expect(fixed.match(/"exported_at"/g)!.length).toBe(1);
    const quirk = formatJSONExport(d, [], T0, { quirks: true });
    expect(quirk).toContain('"exported_at": "2026-11-16T18:21:42Z",\n  "entries": [],\n  "exported_at": "old"\n}\n');
  });
});

test("customFieldCount counts every custom field, otp included", () => {
  let d = newVaultData(T0);
  d = addEntry(d, "a", { ...emptyContent(), fields: [field("otp", "x"), field("k", "")] }, { now: T0 }).data;
  d = addEntry(d, "b", { ...emptyContent(), fields: [field("k", "v")] }, { now: T0 }).data;
  expect(customFieldCount(d.entries)).toBe(3);
});
