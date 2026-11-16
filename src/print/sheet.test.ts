// The password sheet (print.md §2), the text sheet and its pagination (§4), the recovery
// key sheet (§5).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Entry } from "../model/types.ts";
import { formatRecoveryKey, X25519Identity } from "../keys/index.ts";
import { buildPasswordSheet, groupEntries, notesLines, selectEntries } from "./sheet.ts";
import { parseFields } from "./fields.ts";
import { bodyHeight, pageHeader, paginate, renderText } from "./text.ts";
import { SPACE, type Block, type Row } from "./rows.ts";
import { buildRecoverySheet, keyLines, RECOVERY_COMMANDS } from "./recovery.ts";

const SPEC_DIR = join(import.meta.dir, "../../spec");

function entry(path: string, o: Partial<Entry> = {}): Entry {
  return { id: path, path, password: "", username: "", url: "", tags: [], fields: [], notes: "", createdAt: 0, updatedAt: 0, unknown: new Map(), ...o };
}
const field = (key: string, value: string) => ({ key, value, unknown: new Map() });

const EXAMPLE: Entry[] = [
  entry("work/dev/aws", { password: "zero​width", username: "root" }),
  entry("bank/main", { password: "Xk0Olp1I", username: "alice", url: "https://bank.example", tags: ["money", "2fa"], notes: "PIN in the safe\n\tcard 2\n" }),
  entry("email", { password: "Pa55 w0rd!", username: "me@example.com" }),
  entry("work/github", { password: "aB3$".repeat(20) + "lI0O", username: "alice", url: "https://github.com", fields: [field("recovery-email", "me+gh@example.com"), field("pin", "0101")] }),
];

/** The annotated example of print.md §4.3, as a whole page: annotations removed, padding restored. */
function specExample(): string {
  const md = readFileSync(join(SPEC_DIR, "docs/spec/print.md"), "utf8");
  const at = md.indexOf("### 4.3 Annotated example");
  const start = md.indexOf("```\n", at) + 4;
  const end = md.indexOf("```", start);
  const lines = md
    .slice(start, end)
    .replace(/\n$/, "")
    .split("\n")
    .map((l) => l.replace(/\s+\[\d+\]( empty| space row)?$/, "").replace(/^\s+$/, ""));
  const cut = lines.indexOf("⏎");
  const body = lines.slice(3, cut);
  while (body.length < 53) body.push("");
  return [...lines.slice(0, 3), ...body, ...lines.slice(cut + 1)].join("\n") + "\n";
}

describe("password sheet (§2)", () => {
  test("the annotated example of §4.3, byte for byte", () => {
    const sheet = buildPasswordSheet({ entries: EXAMPLE, folder: "", tags: [], fields: parseFields("password,username,url,tags,notes,fields"), printedAt: new Date(2026, 10, 15, 14, 3) });
    expect(renderText(sheet)).toBe(specExample());
  });

  test("selection is segment-aware; tags all match", () => {
    const es = [entry("work"), entry("work/x", { tags: ["a", "b"] }), entry("work/a/y", { tags: ["a"] }), entry("workshop/x", { tags: ["a"] })];
    expect(selectEntries(es, "work", []).map((e) => e.path)).toEqual(["work/x", "work/a/y"]);
    expect(selectEntries(es, "", ["a", "b"]).map((e) => e.path)).toEqual(["work/x"]);
    expect(() => selectEntries(es, "work", ["c"])).toThrow("no entries to print: none matches folder work; tag c");
    expect(() => selectEntries(es, "", ["c", "d", "c"])).toThrow("no entries to print: none matches tags c, d, c");
    expect(() => selectEntries([], "", [])).toThrow("no entries to print: the vault has no entries");
    expect(() => selectEntries(es, "nope x", [])).toThrow("no entries to print: none matches folder nope x");
  });

  test("groups: top level first, then by folder segment by segment; names bytewise", () => {
    const es = ["work-old/a", "work/dev/b", "z", "work/b", "work/a", "A", "work/Z"].map((p) => entry(p));
    expect(groupEntries(es).map((g) => [g.folder, g.entries.map((e) => e.path)])).toEqual([
      ["", ["A", "z"]],
      ["work", ["work/Z", "work/a", "work/b"]],
      ["work/dev", ["work/dev/b"]],
      ["work-old", ["work-old/a"]],
    ]);
  });

  test("an unknown custom key is an error after selection", () => {
    const es = [entry("a", { fields: [field("pin", "1")] }), entry("b/c")];
    const run = (fields: string, folder = "") => buildPasswordSheet({ entries: es, folder, tags: [], fields: parseFields(fields), printedAt: new Date() });
    expect(() => run("pin")).not.toThrow();
    expect(() => run("PIN")).toThrow('invalid field "PIN": no selected entry has a field with this key');
    expect(() => run("pin", "b")).toThrow('invalid field "pin": no selected entry has a field with this key');
  });

  test("notes: trailing white space removed, tabs to 4 columns, S4 multi-line", () => {
    expect(notesLines("a\tb\n\tc\r\nd\x1b  \n\t\n")).toEqual(["a   b", "    c\\r", "d\\x1b"]);
    expect(notesLines("  \t\n")).toEqual([""]);
  });

  test("the header block and scope", () => {
    const sheet = buildPasswordSheet({ entries: [entry("f/a", { tags: ["t1", "t2"], password: "x" })], folder: "f", tags: ["t1", "t2"], fields: parseFields("password"), printedAt: new Date(2026, 0, 2, 3, 4) });
    expect(sheet.blocks[0]!.rows.map((r) => [r.kind, r.text])).toEqual([
      ["title", "passh password sheet"],
      ["meta", "printed 2026-01-02 03:04 · 1 entry · folder f; tags t1, t2"],
      ["meta", "fields: password"],
    ]);
  });

  test("empty values are left out; an entry may show only its name", () => {
    const sheet = buildPasswordSheet({ entries: [entry("a", { fields: [field("k", "")], notes: " \n\t" })], folder: "", tags: [], fields: parseFields("password,fields,notes,tags"), printedAt: new Date() });
    expect(sheet.blocks[2]!.rows.map((r) => r.kind)).toEqual(["space", "entry"]);
  });
});

describe("pagination (§4.2)", () => {
  const row = (kind: Row["kind"], text: string = kind): Row => ({ kind, text });
  const entryBlock = (name: string, values: number): Block => ({ rows: [SPACE, row("entry", name), ...Array.from({ length: values }, (_, i) => ({ kind: "value" as const, text: "v" + i, prefix: "  password  ", marks: "" }))], keep: false });
  const folderBlock = (name: string): Block => ({ rows: [SPACE, row("folder", name)], keep: true });
  const header: Block = { rows: [row("title"), row("meta")], keep: false };
  const texts = (pages: Row[][]) => pages.map((p) => p.map((r) => r.text));

  test("a block that fits is never split; space rows never start a page", () => {
    const pages = paginate([header, folderBlock("f"), entryBlock("a", 40), entryBlock("b", 10)], 53);
    expect(pages.length).toBe(2);
    // The space row follows the (continued) heading: only an empty page drops it.
    expect(texts(pages)[1]!.slice(0, 3)).toEqual(["f (continued)", "", "b"]);
  });

  test("a folder heading moves with the start of its first entry", () => {
    const pages = paginate([header, entryBlock("x", 44), folderBlock("f"), entryBlock("a", 10)], 53);
    expect(texts(pages)[0]!.includes("f")).toBe(false);
    expect(texts(pages)[1]!.slice(0, 2)).toEqual(["f", ""]);
  });

  test("an entry split across pages repeats its name; the folder too", () => {
    const pages = paginate([header, folderBlock("f"), entryBlock("long", 80)], 53);
    expect(pages.length).toBe(2);
    expect(texts(pages)[1]!.slice(0, 2)).toEqual(["f (continued)", "long (continued)"]);
    for (const p of pages) expect(p.reduce((n, r) => n + (r.kind === "folder" ? 2 : 1), 0)).toBeLessThanOrEqual(53);
  });

  test("an empty sheet still has one page", () => {
    expect(paginate([], 53)).toEqual([[]]);
  });

  test("page frame: 60 lines a page, FF between pages, final LF", () => {
    const sheet = buildPasswordSheet({ entries: Array.from({ length: 30 }, (_, i) => entry(`f/e${i}`, { password: "p", username: "u", url: "x" })), folder: "", tags: [], fields: parseFields(undefined), printedAt: new Date(2026, 10, 15, 14, 3) });
    const text = renderText(sheet);
    const pages = text.split("\f");
    expect(pages.length).toBeGreaterThan(1);
    for (const [i, p] of pages.entries()) {
      expect(p.endsWith("\n")).toBe(true);
      expect(p.split("\n").length - 1).toBe(60);
      expect(p.split("\n")[0]).toEndWith(`page ${i + 1} of ${pages.length}`);
    }
    expect(bodyHeight(2)).toBe(53);
    expect(bodyHeight(0)).toBe(55);
  });

  test("header line: 80 columns, or one blank when too long", () => {
    expect(pageHeader("passh password sheet", "2026-11-15 14:03", 1, 1)).toBe("CONFIDENTIAL · passh password sheet               2026-11-15 14:03 · page 1 of 1");
    expect(pageHeader("t".repeat(60), "2026-11-15 14:03", 1, 1)).toBe("CONFIDENTIAL · " + "t".repeat(60) + " 2026-11-15 14:03 · page 1 of 1");
  });
});

describe("recovery key sheet (§5)", () => {
  const KEY = "AGE-SECRET-KEY-1QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7LQPZRY9X8GF2TVDW0S3JN54KHCE";

  test("key lines: 4-character groups, 5 per line", () => {
    expect(keyLines(KEY)).toEqual(["AGE-SECRET-KEY-1", "QPZR Y9X8 GF2T VDW0 S3JN", "54KH CE6M UA7L QPZR Y9X8", "GF2T VDW0 S3JN 54KH CE"]);
    const id = X25519Identity.generate();
    expect(keyLines(id.format()).join("\n")).toBe(formatRecoveryKey(id));
  });

  test("the commands are those of spec §8, byte for byte", () => {
    const md = readFileSync(join(SPEC_DIR, "spec.md"), "utf8");
    const at = md.indexOf("**Without passh**");
    const start = md.indexOf("```bash\n", at) + 8;
    const block = md.slice(start, md.indexOf("```", start)).replace(/\n$/, "").split("\n");
    expect([...RECOVERY_COMMANDS] as string[]).toEqual(block);
  });

  test("one page, 55 body lines, no legend; the key never in one piece", () => {
    const text = renderText(buildRecoverySheet({ key: KEY, vaultId: "7ccff325-5679-4e70-9e5a-a157e6bc1c51", printedAt: new Date(2026, 10, 16, 20, 43), web: false }));
    const lines = text.split("\n");
    expect(text.includes("\f")).toBe(false);
    expect(lines.length - 1).toBe(60);
    expect(lines[59]).toBe("-".repeat(80));
    expect(lines.slice(0, 6)).toEqual(["CONFIDENTIAL · passh paper recovery key           2026-11-16 20:43 · page 1 of 1", "=".repeat(80), "", "passh paper recovery key", "vault_id 7ccff325-5679-4e70-9e5a-a157e6bc1c51", "printed 2026-11-16 20:43"]);
    expect(text.includes(KEY)).toBe(false);
    expect(text.includes(KEY.slice(16, 40))).toBe(false);
    // SPEC-GAP (print.md §5 says only the two `tr … | awk …` commands exceed 80 columns): the
    // third command with its comment is 87 columns too, in the reference as here.
    expect(lines.filter((l) => l.length > 80).map((l) => l.slice(0, 6))).toEqual(["tr -d ", "tr -d ", "age -d"]);
  });

  test("the page form has the QR row instead of the prose about it", () => {
    const sheet = buildRecoverySheet({ key: KEY, vaultId: "x", printedAt: new Date(), web: true });
    const keyBlock = sheet.blocks[1]!.rows;
    expect(keyBlock.at(-1)!.kind).toBe("qr");
    expect(keyBlock.at(-1)!.qr).toStartWith('<svg viewBox="0 0 41 41" role="img" aria-label="QR code of the vault key"');
  });
});
