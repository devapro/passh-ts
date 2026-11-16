// The password sheet model (print.md §2): selection, grouping, order, header block and entry
// rows, as blocks of rows (§4.2) that the text sheet and the print page both draw.

import type { Entry } from "../model/types.ts";
import { E, T, TN, errorf, type Localizable } from "../i18n/index.ts";
import { escapeLine, escapeMultiline } from "../sanitize/index.ts";
import { baseName, comparePaths, hasAllTags, isInFolder, parentFolder } from "../paths/index.ts";
import { compareUTF8 } from "../util/unicode.ts";
import { fieldLabel, type FieldName } from "./fields.ts";
import { SPACE, proseRows, valueRows, wrappedRows, type Block, type Row } from "./rows.ts";

/** A laid-out sheet: what the text sheet paginates and the print page streams. */
export interface Sheet {
  /** The sheet's title in the language (`passh password sheet`). */
  title: string;
  /** The print date, `YYYY-MM-DD HH:MM` (local time, no zone). */
  date: string;
  blocks: Block[];
  /** Legend lines (none for the recovery sheet). */
  legend: string[];
  /** Number of entries on a password sheet (0 for the recovery sheet). */
  count: number;
}

/** `YYYY-MM-DD HH:MM` in local time, no zone (print.md §3.1). */
export function formatDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * The description of a selection (print.md §2.3): `folder <f>` and/or `tag <t>` (one tag) /
 * `tags <t1>, <t2>` (two or more, in the order given, repeats kept), joined by `; `, folder
 * first; values S4-escaped (single-line). Renders itself in the language.
 */
export class Scope implements Localizable {
  constructor(
    readonly folder: string,
    readonly tags: readonly string[],
  ) {}

  get empty(): boolean {
    return this.folder === "" && this.tags.length === 0;
  }

  private parts(tr: (f: string, ...a: unknown[]) => string): string {
    const out: string[] = [];
    if (this.folder !== "") out.push(tr("folder %s", escapeLine(this.folder)));
    if (this.tags.length === 1) out.push(tr("tag %s", escapeLine(this.tags[0]!)));
    else if (this.tags.length > 1) out.push(tr("tags %s", this.tags.map((t) => escapeLine(t)).join(", ")));
    return out.join("; ");
  }

  localize(): string {
    return this.parts(T);
  }

  toString(): string {
    return this.parts(E);
  }
}

export interface PasswordSheetInput {
  /** Every entry of the vault (any order). */
  entries: readonly Entry[];
  /** The `--folder` value, validated and NFC (print.md §1.1 step 4), or "" for none. */
  folder: string;
  /** The `--tag` values, normalized (NFC, trimmed), in the order given, repeats kept. */
  tags: readonly string[];
  /** The parsed `--fields` (fields.ts). */
  fields: readonly FieldName[];
  /** The print time. */
  printedAt: Date;
}

/** The legend lines of the password sheet (print.md §4.1, §8). */
export function legendLines(): string[] {
  return [T("Under 0 O 1 l I and spaces: D digit, U capital letter, L small letter, S space"), T("%s continues the line above; \\uXXXX is a character that can't be printed", "→")];
}

/**
 * Selects and orders the entries (print.md §2.2): inside `folder` at any depth with every tag.
 * Throws `no entries to print: …` when none is selected.
 */
export function selectEntries(entries: readonly Entry[], folder: string, tags: readonly string[]): Entry[] {
  const want = [...tags];
  const sel = entries.filter((e) => (folder === "" || isInFolder(e.path, folder)) && hasAllTags(e.tags, want));
  if (sel.length === 0) {
    const scope = new Scope(folder, tags);
    if (scope.empty) throw errorf("no entries to print: the vault has no entries");
    throw errorf("no entries to print: none matches %s", scope);
  }
  return sel;
}

/** Groups by the immediate folder (print.md §2.2): top level first, then by folder path; entries by name, bytewise. */
export function groupEntries(entries: readonly Entry[]): Array<{ folder: string; entries: Entry[] }> {
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const f = parentFolder(e.path);
    let g = groups.get(f);
    if (!g) groups.set(f, (g = []));
    g.push(e);
  }
  const folders = [...groups.keys()].sort((a, b) => (a === "" ? (b === "" ? 0 : -1) : b === "" ? 1 : comparePaths(a, b)));
  return folders.map((folder) => ({ folder, entries: groups.get(folder)!.sort((a, b) => compareUTF8(baseName(a.path), baseName(b.path))) }));
}

/** The notes as value lines (print.md §2.4): S4 multi-line, trailing LF/space/tab removed, split at LF, tabs expanded to 4. */
export function notesLines(notes: string): string[] {
  let s = escapeMultiline(notes);
  s = s.replace(/[\n \t]+$/, "");
  return s.split("\n").map(expandTabs);
}

function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  let out = "";
  let col = 0;
  for (const ch of line) {
    if (ch === "\t") {
      const n = 4 - (col % 4);
      out += " ".repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

/** The value rows of one entry for the chosen fields, in field order (print.md §2.4); empty values left out. */
function entryValueRows(e: Entry, fields: readonly FieldName[]): Row[] {
  const rows: Row[] = [];
  const single = (label: string, value: string) => {
    if (value === "") return;
    rows.push(...valueRows(label, [escapeLine(value)], "spaces"));
  };
  for (const f of fields) {
    if (f.kind === "custom") {
      for (const cf of e.fields) if (cf.key === f.key) single(escapeLine(cf.key), cf.value);
      continue;
    }
    switch (f.name) {
      case "password":
      case "username":
      case "url":
        single(f.name, e[f.name]);
        break;
      case "fields":
        for (const cf of e.fields) single(escapeLine(cf.key), cf.value);
        break;
      case "tags":
        if (e.tags.length > 0) rows.push(...valueRows("tags", [escapeLine(e.tags.join(", "))], "chars"));
        break;
      case "notes": {
        // SPEC-GAP (print.md §2.4 "Empty values are left out"): notes that are empty once the
        // trailing white space is removed (e.g. "  \t\n") are left out too, as the reference does.
        const lines = notesLines(e.notes);
        if (lines.length > 1 || lines[0] !== "") rows.push(...valueRows("notes", lines, "chars"));
        break;
      }
    }
  }
  return rows;
}

/**
 * Builds the password sheet (print.md §2): throws the errors of §1.1 step 11 (`no entries to
 * print: …`, `invalid field "pin": no selected entry has a field with this key`).
 */
export function buildPasswordSheet(input: PasswordSheetInput): Sheet {
  const selected = selectEntries(input.entries, input.folder, input.tags);
  for (const f of input.fields) {
    if (f.kind !== "custom") continue;
    if (!selected.some((e) => e.fields.some((cf) => cf.key === f.key))) throw errorf("invalid field %q: no selected entry has a field with this key", f.key);
  }
  const title = T("passh password sheet");
  const date = formatDate(input.printedAt);
  const scope = new Scope(input.folder, input.tags);
  let meta = T("printed %s", date) + " · " + TN(selected.length, "%d entry", "%d entries", selected.length);
  if (!scope.empty) meta += " · " + scope.localize();
  const header: Row[] = [
    ...proseRows("title", escapeLine(title)),
    ...proseRows("meta", escapeLine(meta)),
    ...proseRows("meta", escapeLine(T("fields: %s", input.fields.map(fieldLabel).join(", ")))),
  ];
  const blocks: Block[] = [{ rows: header, keep: false }];
  for (const g of groupEntries(selected)) {
    const heading = g.folder === "" ? T("(top level)") : g.folder;
    blocks.push({ rows: [SPACE, ...wrappedRows("folder", escapeLine(heading))], keep: true });
    for (const e of g.entries) {
      blocks.push({ rows: [SPACE, ...wrappedRows("entry", escapeLine(baseName(e.path))), ...entryValueRows(e, input.fields)], keep: false });
    }
  }
  return { title, date, blocks, legend: legendLines(), count: selected.length };
}
