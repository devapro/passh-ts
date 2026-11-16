import { describe, expect, test } from "bun:test";
import { LineInput, MASK, TextArea, pasteMultiLine, pasteOneLine } from "./input.ts";
import { charKey, key } from "./keys.ts";
import { lineText } from "./text.ts";

function typed(inp: LineInput, s: string) {
  for (const c of s) inp.handleKey(charKey(c));
}

describe("one-line input: editing keys (tui.md §11.4)", () => {
  test("movement and deletion", () => {
    const i = new LineInput("hello world");
    expect(i.pos).toBe(11);
    i.handleKey(key("ctrl+a"));
    expect(i.pos).toBe(0);
    i.handleKey(key("ctrl+f"));
    i.handleKey(key("right"));
    expect(i.pos).toBe(2);
    i.handleKey(key("ctrl+e"));
    i.handleKey(key("alt+b"));
    expect(i.pos).toBe(6);
    i.handleKey(key("ctrl+left"));
    expect(i.pos).toBe(0);
    i.handleKey(key("alt+f"));
    expect(i.pos).toBe(5);
    i.handleKey(key("ctrl+right"));
    expect(i.pos).toBe(11);
    i.handleKey(key("backspace"));
    i.handleKey(key("ctrl+h"));
    expect(i.value).toBe("hello wor");
    i.handleKey(key("home"));
    i.handleKey(key("delete"));
    i.handleKey(key("ctrl+d"));
    expect(i.value).toBe("llo wor");
  });
  test("word and line deletion", () => {
    const i = new LineInput("one two  three");
    i.handleKey(key("ctrl+w"));
    expect(i.value).toBe("one two  ");
    i.handleKey(key("alt+backspace"));
    expect(i.value).toBe("one ");
    i.handleKey(key("ctrl+backspace"));
    expect(i.value).toBe("");
    i.set("alpha beta gamma");
    i.handleKey(key("home"));
    i.handleKey(key("alt+d"));
    expect(i.value).toBe(" beta gamma");
    i.handleKey(key("ctrl+delete"));
    expect(i.value).toBe(" gamma");
    i.handleKey(key("alt+delete"));
    expect(i.value).toBe("");
    i.set("abc def");
    i.pos = 3;
    i.handleKey(key("ctrl+k"));
    expect(i.value).toBe("abc");
    i.pos = 1;
    i.handleKey(key("ctrl+u"));
    expect(i.value).toBe("bc");
    expect(i.pos).toBe(0);
  });
  test("insertion at the cursor; L, q, ? are text", () => {
    const i = new LineInput("ac");
    i.pos = 1;
    typed(i, "bLq?");
    expect(i.value).toBe("abLq?c");
  });
  test("masked editing: append only, Backspace removes the last, Ctrl-U/W clear", () => {
    const i = new LineInput("", true);
    typed(i, "secret");
    i.handleKey(key("left"));
    i.handleKey(key("home"));
    typed(i, "X");
    expect(i.value).toBe("secretX");
    i.handleKey(key("delete"));
    i.handleKey(key("ctrl+k"));
    expect(i.value).toBe("secretX");
    i.handleKey(key("backspace"));
    expect(i.value).toBe("secret");
    i.handleKey(key("ctrl+w"));
    expect(i.value).toBe("");
    typed(i, "ab");
    i.handleKey(key("ctrl+u"));
    expect(i.value).toBe("");
    typed(i, "ab");
    i.handleKey(key("alt+backspace"));
    expect(i.value).toBe("");
  });
  test("masked view shows the fixed mask, never the length", () => {
    const a = new LineInput("x", true);
    const b = new LineInput("a much longer secret value", true);
    expect(lineText(a.view(40, false, { showMasked: true }))).toBe(MASK);
    expect(lineText(b.view(40, false, { showMasked: true }))).toBe(MASK);
    expect(lineText(new LineInput("", true).view(40, false, { showMasked: true }))).toBe("");
  });
  test("control characters show as escapes, one unit each", () => {
    const i = new LineInput("a\tb\x1bc");
    expect(lineText(i.view(40, false))).toBe("a\\tb\\x1bc");
    i.pos = 1;
    const v = i.view(40, true);
    const cur = v.find((s) => s.s & 4)!;
    expect(cur.t).toBe("\\t");
  });
  test("focused view scrolls to keep the cursor visible; unfocused ends in …", () => {
    const i = new LineInput("abcdefghijklmnopqrstuvwxyz");
    expect(lineText(i.view(10, false))).toBe("abcdefghi…");
    const v = lineText(i.view(10, true));
    expect(v.endsWith("z ")).toBe(true);
    expect(v.length).toBe(10);
    i.pos = 0;
    expect(lineText(i.view(10, true)).startsWith("abc")).toBe(true);
  });
});

describe("pastes", () => {
  const b = (s: string) => new TextEncoder().encode(s);
  test("one line: a trailing line break is dropped", () => {
    expect(pasteOneLine(b("abc\r\n"))).toEqual({ ok: true, text: "abc" });
    expect(pasteOneLine(b("abc\n"))).toEqual({ ok: true, text: "abc" });
    expect(pasteOneLine(b("abc\r"))).toEqual({ ok: true, text: "abc" });
    expect(pasteOneLine(b("a\tb"))).toEqual({ ok: true, text: "a\tb" });
  });
  test("one line: a line break inside is refused, as is invalid UTF-8", () => {
    expect(pasteOneLine(b("a\nb"))).toEqual({ ok: false, reason: "lines" });
    expect(pasteOneLine(b("ab\n\n"))).toEqual({ ok: false, reason: "lines" });
    expect(pasteOneLine(new Uint8Array([0x61, 0xff]))).toEqual({ ok: false, reason: "utf8" });
  });
  test("notes: CRLF and CR become LF", () => {
    expect(pasteMultiLine(b("a\r\nb\rc\nd"))).toEqual({ ok: true, text: "a\nb\nc\nd" });
  });
});

describe("notes text area", () => {
  test("new lines and joining", () => {
    const t = new TextArea("ab");
    t.handleKey(key("enter"), 20, 5);
    t.handleKey(charKey("c"), 20, 5);
    expect(t.value).toBe("ab\nc");
    t.handleKey(key("ctrl+a"), 20, 5);
    t.handleKey(key("backspace"), 20, 5);
    expect(t.value).toBe("abc");
    t.handleKey(key("ctrl+j"), 20, 5);
    expect(t.value).toBe("ab\nc");
    t.handleKey(key("up"), 20, 5);
    t.handleKey(key("end"), 20, 5);
    t.handleKey(key("delete"), 20, 5);
    expect(t.value).toBe("abc");
    t.set("x\ny");
    t.row = 0;
    t.col = 1;
    t.handleKey(key("ctrl+k"), 20, 5);
    expect(t.value).toBe("xy");
    t.set("x\ny");
    t.row = 0;
    t.col = 1;
    t.handleKey(key("alt+d"), 20, 5);
    expect(t.value).toBe("xy");
  });
  test("↑ on the first row is not handled (the form moves to the previous field); ↓ on the last stays", () => {
    const t = new TextArea("one\ntwo");
    t.row = 0;
    t.col = 1;
    expect(t.handleKey(key("up"), 20, 5)).toBe("ignored");
    t.row = 1;
    expect(t.handleKey(key("down"), 20, 5)).toBe("moved");
    expect(t.row).toBe(1);
  });
  test("soft wrap at spaces and movement by visual row keeping the column", () => {
    const t = new TextArea("aaaa bbbb cccc");
    const rows = t.layout(8);
    expect(rows.length).toBe(3);
    t.row = 0;
    t.col = 1;
    t.handleKey(key("down"), 8, 5);
    expect(t.col).toBe(6);
    t.handleKey(key("down"), 8, 5);
    expect(t.col).toBe(11);
    t.handleKey(key("pgup"), 8, 3);
    expect(t.col).toBe(1);
  });
  test("view scrolls to keep the cursor visible", () => {
    const t = new TextArea("1\n2\n3\n4\n5\n6");
    const v = t.view(10, 3, true).map(lineText);
    expect(v[2]!.startsWith("6")).toBe(true);
  });
  test("a paste with line breaks inserts lines", () => {
    const t = new TextArea("ab");
    t.col = 1;
    t.insert("1\n2");
    expect(t.value).toBe("a1\n2b");
    expect(t.row).toBe(1);
    expect(t.col).toBe(1);
  });
});
