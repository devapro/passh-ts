import { describe, expect, test } from "bun:test";
import { formatEntryText, parseEntryText, splitMetadata } from "./index.ts";
import { emptyContent, type EntryContent } from "../model/ops.ts";
import type { Field } from "../model/types.ts";

const F = (key: string, value: string): Field => ({ key, value, unknown: new Map() });
const C = (o: Partial<EntryContent>): EntryContent => ({ ...emptyContent(), ...o });

function errText(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  return "(no error)";
}

describe("writing (§5.1)", () => {
  test("§7.2 example", () => {
    const text = formatEntryText(
      C({
        password: "s3cr3t-P@ss",
        username: "arsenii",
        url: "https://github.com",
        tags: ["work", "2fa"],
        fields: [F("recovery-email", "me@example.com")],
        notes: "Free-form notes.\nRecovery codes, etc.",
      }),
    );
    expect(text).toBe("s3cr3t-P@ss\nusername: arsenii\nurl: https://github.com\ntags: work, 2fa\nrecovery-email: me@example.com\n---\nFree-form notes.\nRecovery codes, etc.\n");
  });
  test("empty values are left out; key: for an empty field", () => {
    expect(formatEntryText(C({}))).toBe("\n");
    expect(formatEntryText(C({ fields: [F("pin", "")] }))).toBe("\npin:\n");
    expect(formatEntryText(C({ notes: "line1\nline2\r\n" }))).toBe("\n---\nline1\nline2\r\n\n");
  });
});

describe("reading (§5.2)", () => {
  test("§7.2 example", () => {
    const c = parseEntryText("s3cr3t-P@ss\nusername: arsenii\nurl: https://github.com\ntags: work, 2fa\nrecovery-email: me@example.com\n---\nFree-form notes.\nRecovery codes, etc.\n");
    expect(c).toEqual({
      password: "s3cr3t-P@ss",
      username: "arsenii",
      url: "https://github.com",
      tags: ["work", "2fa"],
      fields: [F("recovery-email", "me@example.com")],
      notes: "Free-form notes.\nRecovery codes, etc.",
    });
  });
  test("line 1", () => {
    expect(parseEntryText("abc").password).toBe("abc");
    expect(parseEntryText("abc\r").password).toBe("abc");
    expect(parseEntryText("")).toEqual(C({}));
    expect(parseEntryText("--- : x\n").password).toBe("--- : x");
    expect(parseEntryText(" pw \r\n").password).toBe(" pw ");
  });
  test("CRLF after a CRLF line 1", () => {
    const c = parseEntryText("pw\r\nusername: u\r\n---\r\na\r\nb\r\n");
    expect(c).toEqual(C({ password: "pw", username: "u", notes: "a\nb" }));
  });
  test("other CRs stay in the notes; metadata loses one CR", () => {
    const c = parseEntryText("pw\nusername: u\r\nnote\r\nx");
    expect(c.username).toBe("u");
    expect(c.notes).toBe("note\r\nx");
    expect(errText(() => parseEntryText("pw\nusername: u\r\r\n"))).toBe("invalid entry: username must be a single line");
    expect(parseEntryText("pw\ntags: a, b\r\r\n").tags).toEqual(["a", "b"]);
  });
  test("separator", () => {
    expect(parseEntryText("pw\n---\n\n  \nx\n").notes).toBe("\n  \nx");
    expect(parseEntryText("pw\n---\r\nx").notes).toBe("x");
    expect(parseEntryText("pw\n--- \nx").notes).toBe("--- \nx");
    expect(parseEntryText("pw\n---").notes).toBe("");
  });
  test("not metadata", () => {
    for (const l of ["PIN:1234", "k:\tv", " username: u", "Security question: x", "https://example.com", ": x", "_k: v"]) {
      expect(parseEntryText("pw\n" + l).notes).toBe(l);
    }
    expect(splitMetadata("k:")).toEqual({ key: "k", value: "" });
    expect(splitMetadata("k:  v : w ")).toEqual({ key: "k", value: " v : w " });
  });
  test("blank lines at the start of unseparated notes are dropped; one final LF removed", () => {
    expect(parseEntryText("pw\nusername: u\n\n \t\nnote\n\n").notes).toBe("note\n");
    expect(parseEntryText("pw\n\n").notes).toBe("");
  });
  test("keys in any case", () => {
    const c = parseEntryText("pw\nUsername: a\nURL: b\nTAGS: x\ntags: y, x\nu\u017fername2: z\nPassword: p\n");
    expect(c).toEqual(C({ password: "pw", username: "a", url: "b", tags: ["x", "y"], fields: [F("u\u017fername2", "z"), F("Password", "p")] }));
    expect(parseEntryText("pw\nu\u017fername: k\n").username).toBe("k");
  });
  test("errors", () => {
    expect(errText(() => parseEntryText(new Uint8Array([0x61, 0xff])))).toBe("the text is not valid UTF-8");
    expect(errText(() => parseEntryText("a\ud800"))).toBe("the text is not valid UTF-8");
    expect(errText(() => parseEntryText("pw\nusername: a\nUSERNAME: b\n"))).toBe("line 3: username appears twice");
    expect(errText(() => parseEntryText("pw\nurl: a\nurl: b\n"))).toBe("line 3: url appears twice");
    expect(errText(() => parseEntryText("pw\ntags: a\tb\n"))).toBe('line 2: invalid tag "a\\tb": it contains a control character');
    expect(errText(() => parseEntryText("a\rb\n"))).toBe("invalid entry: password must be a single line");
  });
});

describe("import variant (§5.3, import-export.md §1.6)", () => {
  test("the spec's example", () => {
    const text = "pw\notpauth://totp/A?secret=X\nlogin: bob\nusername: other\nURL: https://a\nurl: https://b\ntags: a, , b, a\npin: 1234\nPIN:5678\nnote\n  OTPAUTH://totp/B?secret=Y\n\n";
    const c = parseEntryText(text, { importVariant: true });
    expect(c).toEqual({
      password: "pw",
      username: "bob",
      url: "https://a",
      tags: ["a", "b"],
      fields: [F("otp", "otpauth://totp/A?secret=X"), F("pin", "1234"), F("otp", "OTPAUTH://totp/B?secret=Y")],
      notes: "username: other\nurl: https://b\nPIN:5678\nnote",
    });
  });
  test("user/login aliases, second one becomes a field", () => {
    const c = parseEntryText("pw\nuser: a\nLogin: b\nusername: c\n", { importVariant: true });
    expect(c.username).toBe("a");
    expect(c.fields).toEqual([F("Login", "b")]);
    expect(c.notes).toBe("username: c");
  });
  test("bad tags move to the notes; line 1 may be otpauth", () => {
    const c = parseEntryText("otpauth://x\ntags: a\tb\nnote\n\n \n", { importVariant: true });
    expect(c.password).toBe("otpauth://x");
    expect(c.tags).toEqual([]);
    expect(c.notes).toBe("tags: a\tb\nnote");
  });
  test("empty plaintext; invalid UTF-8; lone CR", () => {
    expect(parseEntryText("", { importVariant: true })).toEqual(C({}));
    expect(errText(() => parseEntryText(new Uint8Array([0xff]), { importVariant: true }))).toBe("the text is not valid UTF-8");
    expect(errText(() => parseEntryText("a\rb\n", { importVariant: true }))).toBe("invalid entry: password must be a single line");
    expect(parseEntryText("\ufeffpw", { importVariant: true }).password).toBe("\ufeffpw");
  });
  test("separated notes keep leading blank lines, lose trailing ones", () => {
    const c = parseEntryText("pw\n---\n\nx\n\n", { importVariant: true });
    expect(c.notes).toBe("\nx");
  });
});

describe("property: reading what was written gives back the content", () => {
  const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]!;
  const chars = ["a", "Z", "0", " ", ":", "-", "é", "😀", "\t", "\u0000", "\u2028", "---", "username: ", "#", ","];
  const rstr = (n = 6) => Array.from({ length: Math.floor(Math.random() * n) }, () => pick(chars)).join("");
  const noteChars = [...chars, "\n", "\r", "\r\n", "\n\n", " \n"];
  const rnote = () => Array.from({ length: Math.floor(Math.random() * 10) }, () => pick(noteChars)).join("");
  test("random entries", () => {
    for (let round = 0; round < 2000; round++) {
      const c = C({
        password: rstr(),
        username: rstr(),
        url: rstr(),
        tags: [...new Set(Array.from({ length: Math.floor(Math.random() * 3) }, () => ("t" + rstr(3)).replace(/[,\u0000-\u001f]/g, "x").trim()))],
        fields: Array.from({ length: Math.floor(Math.random() * 3) }, () => F(pick(["pin", "password", "notes", "otp", "k.1", "ключ"]), rstr())),
        notes: rnote(),
      });
      const text = formatEntryText(c);
      expect(parseEntryText(text)).toEqual(c);
      expect(parseEntryText(new TextEncoder().encode(text))).toEqual(c);
    }
  });
});
