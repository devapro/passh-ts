// Rows and blocks of a sheet (print.md §3, §4.1–§4.2): what both the text sheet and the
// print page draw.

import { CONTINUATION, VALUE_PREFIX, VALUE_WIDTH, cellText, cellWidth, cellsOf, chunkCells, hardWrap, marksOf, proseWrap, type MarkMode } from "./cells.ts";

/**
 * Row kinds; the page's class names (print.md §6.8): title `title`, meta `meta`, folder
 * `folder`, entry `entry`, value `value`, heading `heading`, text `text`, warning
 * `warning`, key `key`, code `code`, space `sp`, and the QR row.
 */
export type RowKind = "title" | "meta" | "folder" | "entry" | "value" | "heading" | "text" | "warning" | "key" | "code" | "space" | "qr";

export interface Row {
  kind: RowKind;
  /** The laid-out text (cells joined); for a value row the value chunk. */
  text: string;
  /** Value rows: the prefix (`  password  `, `          → `, 12 blanks, or `  <label>`). */
  prefix?: string;
  /** Value rows: the marks line without trailing blanks, prefix included; "" when none. */
  marks?: string;
  /** QR rows: the inline SVG (trusted markup). */
  qr?: string;
}

export interface Block {
  rows: Row[];
  /** Keep with the next block (folder headings). */
  keep: boolean;
}

export const SPACE: Row = { kind: "space", text: "" };

/** A row's lines on the text sheet (print.md §4.1); its height is their number. */
export function rowLines(r: Row): string[] {
  switch (r.kind) {
    case "folder":
      return [r.text, "=".repeat(cellWidth(cellsOf(r.text)))];
    case "heading":
      return [r.text, "-".repeat(cellWidth(cellsOf(r.text)))];
    case "value": {
      const prefix = r.prefix ?? "";
      const line = r.text === "" ? prefix.trimEnd() : prefix + r.text;
      return r.marks ? [line, r.marks] : [line];
    }
    case "space":
      return [""];
    case "qr":
      return [];
    default:
      return [r.text];
  }
}

export function rowHeight(r: Row): number {
  return rowLines(r).length;
}

/** Rows of one kind for text hard-wrapped at 80 columns by cells (names and headings). */
export function wrappedRows(kind: RowKind, text: string): Row[] {
  return hardWrap(text).map((t) => ({ kind, text: t }));
}

/** Rows of one kind for prose wrapped at 80 columns (print.md §3.4). */
export function proseRows(kind: RowKind, text: string): Row[] {
  return proseWrap(text).map((t) => ({ kind, text: t }));
}

/** Rows of a bullet (print.md §3.4): wrapped at 78, `• ` on the first line, two blanks after. */
export function bulletRows(text: string): Row[] {
  return proseWrap(text, 78).map((t, i) => ({ kind: "text" as const, text: (i === 0 ? "• " : "  ") + t }));
}

const CONT_PREFIX = " ".repeat(10) + CONTINUATION + " ";
const BLANK_PREFIX = " ".repeat(VALUE_PREFIX);

/**
 * The rows of one labelled value (print.md §2.4, §3.4): `lines` are the value's lines (one,
 * or several for notes), already escaped by S4; `label` likewise. Chunk 1 of line 1 has
 * `"  " + label` padded to 12 columns; chunk 1 of later lines 12 blanks; every later chunk
 * `"          → "`. A label wider than 9 columns gets rows of its own (hard-wrapped at 78)
 * and every value line then starts with 12 blanks. Marks follow each chunk.
 */
export function valueRows(label: string, lines: readonly string[], mode: MarkMode): Row[] {
  const rows: Row[] = [];
  const labelCells = cellsOf(label);
  const labelWidth = cellWidth(labelCells);
  let firstPrefix: string;
  if (labelWidth > 9) {
    for (const chunk of chunkCells(labelCells, 78)) rows.push({ kind: "value", text: "", prefix: "  " + cellText(chunk), marks: "" });
    firstPrefix = BLANK_PREFIX;
  } else {
    firstPrefix = "  " + cellText(labelCells) + " ".repeat(10 - labelWidth);
  }
  lines.forEach((line, li) => {
    const chunks = chunkCells(cellsOf(line, mode), VALUE_WIDTH);
    chunks.forEach((chunk, ci) => {
      const prefix = ci > 0 ? CONT_PREFIX : li === 0 ? firstPrefix : BLANK_PREFIX;
      const m = marksOf(chunk);
      rows.push({ kind: "value", text: cellText(chunk), prefix, marks: m ? BLANK_PREFIX + m : "" });
    });
  });
  return rows;
}
