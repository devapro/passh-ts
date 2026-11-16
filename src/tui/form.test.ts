import { describe, expect, test } from "bun:test";
import { EntryForm, REVEAL_MS, formText } from "./form.ts";
import { charKey, key, type InputMsg } from "./keys.ts";
import { lineText } from "./text.ts";
import { MASK } from "./input.ts";

const original = { password: "s3cr3t", username: "arsenii", url: "https://github.com", tags: ["work", "dev"], notes: "line one\nline two" };

function form(extra: Partial<ConstructorParameters<typeof EntryForm>[0]> = {}) {
  return new EntryForm({ title: "edit work/github", original, fieldKeys: ["recovery-email"], ...extra });
}

const paste = (s: string): InputMsg => ({ type: "paste", bytes: new TextEncoder().encode(s) });

function typeIn(f: EntryForm, text: string) {
  for (const c of text) f.update(charKey(c), 0, false);
}

describe("fields and focus (§11.2)", () => {
  test("opens on the password, cursors at the end; Tab/Shift-Tab cycle", () => {
    const f = form();
    expect(f.focus).toBe("password");
    f.update(key("tab"), 0, false);
    expect(f.focus).toBe("username");
    expect(f.inputs.username.pos).toBe(7);
    f.update(key("shift+tab"), 0, false);
    f.update(key("shift+tab"), 0, false);
    expect(f.focus).toBe("notes");
    f.update(key("tab"), 0, false);
    expect(f.focus).toBe("password");
  });
  test("Enter, ↓, Ctrl-N go to the next field in single-line fields; ↑ to the previous", () => {
    const f = form();
    f.update(key("enter"), 0, false);
    f.update(key("down"), 0, false);
    f.update(key("ctrl+n"), 0, false);
    expect(f.focus).toBe("tags");
    f.update(key("up"), 0, false);
    expect(f.focus).toBe("url");
  });
  test("in the notes Enter is a new line; ↑ on the first row goes to the previous field", () => {
    const f = form();
    f.focus = "notes";
    f.notes.row = 0;
    f.notes.col = 0;
    f.update(key("enter"), 0, false);
    expect(f.notes.value).toBe("\nline one\nline two");
    f.notes.row = 0;
    f.update(key("up"), 0, false);
    expect(f.focus as string).toBe("tags");
  });
  test("L, q and ? are text", () => {
    const f = form();
    f.focus = "username";
    typeIn(f, "Lq?");
    expect(f.inputs.username.value).toBe("arseniiLq?");
  });
});

describe("save rule and validation (§11.5)", () => {
  test("unchanged inputs keep the original values exactly", () => {
    const f = form();
    const r = f.update(key("ctrl+s"), 0, false);
    expect(r).toEqual({ kind: "save", values: original });
  });
  test("Alt-Enter saves too; Enter never does", () => {
    const f = form();
    expect(f.update(key("enter"), 0, false).kind).toBe("none");
    expect(f.update(key("alt+enter"), 0, false).kind).toBe("save");
  });
  test("changed tags are parsed and stored in the order typed", () => {
    const f = form();
    f.inputs.tags.set("dev, work, , new, dev");
    const r = f.update(key("ctrl+s"), 0, false);
    expect(r.kind === "save" && r.values.tags).toEqual(["dev", "work", "new"]);
  });
  test("an invalid tag: inline error under tags, focus moves there, nothing returned", () => {
    const f = form();
    f.inputs.tags.set("ok, bad\x01tag");
    const r = f.update(key("ctrl+s"), 0, false);
    expect(r.kind).toBe("none");
    expect(f.focus).toBe("tags");
    expect(f.errors.tags).toBe('invalid tag "bad\\x01tag": it contains a control character');
    const text = f.view(80, 24, 0).map(lineText).join("\n");
    expect(text).toContain('invalid tag "bad\\x01tag"');
  });
  test("an empty password is allowed", () => {
    const f = form();
    f.inputs.password.wipe();
    const r = f.update(key("ctrl+s"), 0, false);
    expect(r.kind === "save" && r.values.password).toBe("");
  });
});

describe("keys of §11.3", () => {
  test("Esc without changes cancels at once", () => {
    expect(form().update(key("esc"), 0, false)).toEqual({ kind: "cancel", question: "none" });
  });
  test("Esc with changes asks; Esc/Ctrl-C discards, any other key keeps editing", () => {
    const f = form();
    f.focus = "url";
    typeIn(f, "x");
    expect(f.update(key("esc"), 0, false).kind).toBe("none");
    expect(f.asking).toBe("changes");
    expect(f.view(80, 24, 0).map(lineText).join("\n")).toContain("Discard the changes? esc: discard · any other key: keep editing");
    expect(f.update(charKey("y"), 0, false).kind).toBe("none");
    expect(f.asking).toBe(null);
    expect(f.inputs.url.value).toBe("https://github.comx");
    f.update(key("ctrl+c"), 0, false);
    expect(f.update(key("ctrl+c"), 0, false)).toEqual({ kind: "cancel", question: "changes" });
  });
  test("a paste during the question is consumed", () => {
    const f = form();
    f.inputs.url.set("changed");
    f.update(key("esc"), 0, false);
    f.update(paste("zzz"), 0, false);
    expect(f.asking).toBe(null);
    expect(f.inputs.url.value).toBe("changed");
  });
  test("a recreated form without further change asks its own question", () => {
    const f = form({ recreated: true, initial: { ...formText(original), url: "mine" } });
    f.update(key("esc"), 0, false);
    expect(f.asking).toBe("unsaved");
    expect(f.view(80, 24, 0).map(lineText).join("\n")).toContain("Discard the changes that weren't saved?");
    expect(f.update(key("esc"), 0, false)).toEqual({ kind: "cancel", question: "unsaved" });
  });
  test("Ctrl-R reveals the password for 10 s; again hides it", () => {
    const f = form();
    const masked = () => f.view(80, 24, 1000).map(lineText).find((l) => l.includes("password"))!;
    expect(masked()).toContain(MASK);
    f.update(key("ctrl+r"), 1000, false);
    expect(f.message?.text).toBe("Password shown; it hides again in 10 s (ctrl+r hides it now).");
    expect(f.view(80, 24, 1000).map(lineText).find((l) => l.includes("password"))).toContain("s3cr3t");
    f.tick(1000 + REVEAL_MS);
    expect(f.revealed(1000 + REVEAL_MS)).toBe(false);
    expect(f.view(80, 24, 1000 + REVEAL_MS).map(lineText).find((l) => l.includes("password"))).toContain(MASK);
    f.update(key("ctrl+r"), 20_000, false);
    f.update(key("ctrl+r"), 20_001, false);
    expect(f.revealed(20_001)).toBe(false);
  });
  test("Ctrl-G generates 24 letters and digits", () => {
    const f = form();
    f.update(key("ctrl+g"), 0, false);
    expect(f.inputs.password.value).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(f.message?.text).toBe("Generated a new password (24 characters); ctrl+r shows it.");
    f.update(key("ctrl+r"), 0, false);
    f.update(key("ctrl+g"), 0, false);
    expect(f.message?.text).toBe("Generated a new password (24 characters); it is shown.");
    expect(f.view(80, 24, 0).map(lineText).find((l) => l.includes("password"))).toContain("changed");
  });
  test("the hidden password uses masked editing", () => {
    const f = form();
    f.update(key("left"), 0, false);
    f.update(charKey("X"), 0, false);
    expect(f.inputs.password.value).toBe("s3cr3tX");
    f.update(key("ctrl+w"), 0, false);
    expect(f.inputs.password.value).toBe("");
  });
});

describe("line breaks and pastes (§11.4)", () => {
  test("typed line breaks in single-line fields are dropped", () => {
    const f = form();
    f.focus = "url";
    f.update(key("ctrl+j"), 0, false);
    expect(f.inputs.url.value).toBe(original.url);
  });
  test("a paste with a line break inside a single-line field is refused inline", () => {
    const f = form();
    f.focus = "username";
    f.update(paste("a\nb"), 0, false);
    expect(f.inputs.username.value).toBe("arsenii");
    expect(f.errors.username).toBe("paste refused: username is a single line and the text has line breaks");
    f.update(paste("x\r\n"), 0, false);
    expect(f.inputs.username.value).toBe("arseniix");
    expect(f.errors.username).toBeUndefined();
  });
  test("a paste into the notes turns CRLF and CR into LF", () => {
    const f = form();
    f.focus = "notes";
    f.update(paste("\r\na\rb"), 0, false);
    expect(f.notes.value).toBe("line one\nline two\na\nb");
  });
  test("control characters are kept and shown escaped", () => {
    const f = form();
    f.focus = "username";
    f.update(paste("\tz"), 0, false);
    expect(f.inputs.username.value).toBe("arsenii\tz");
    expect(f.view(80, 24, 0).map(lineText).join("\n")).toContain("arsenii\\tz");
  });
});

describe("layout (§11.1, informative)", () => {
  test("80 × 24", () => {
    const lines = form().view(80, 24, 0).map((l) => lineText(l).trimEnd());
    expect(lines.length).toBe(24);
    expect(lines[0]).toBe("edit work/github");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe(`› password  ${MASK}`);
    expect(lines[3]).toBe("  username  arsenii");
    expect(lines[4]).toBe("       url  https://github.com");
    expect(lines[5]).toBe("      tags  work, dev");
    expect(lines[6]).toBe("     notes  │ line one");
    expect(lines[7]).toBe("            │ line two");
    expect(lines).toContain("    fields  recovery-email (kept as they are; edit them with --editor)");
    expect(lines[23]).toBe("ctrl+s save · esc cancel · tab next · ctrl+r show password · ctrl+g generate");
  });
  test("small areas drop the blank lines; notes keep at least one line", () => {
    const lines = form().view(40, 10, 0).map((l) => lineText(l).trimEnd());
    expect(lines.length).toBe(10);
    expect(lines[1]).toContain("password");
    expect(lines.some((l) => l.includes("notes"))).toBe(true);
  });
});
