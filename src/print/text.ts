// The text sheet (print.md §4): pagination of blocks into pages of exactly 60 lines, with
// the page frame (header, rule, body, footer, legend), UTF-8 and LF, pages separated by FF.

import { T } from "../i18n/index.ts";
import { COLUMNS, textWidth } from "./cells.ts";
import { rowHeight, rowLines, type Block, type Row } from "./rows.ts";
import type { Sheet } from "./sheet.ts";

/** Lines per page, header and footer included (print.md §3.1). */
export const PAGE_LINES = 60;

/** The body height B of a sheet with L legend lines: 60 − 3 − (2 + L) (print.md §4.1). */
export function bodyHeight(legendLines: number): number {
  return PAGE_LINES - 3 - (2 + legendLines);
}

function blockHeight(rows: readonly Row[]): number {
  let h = 0;
  for (const r of rows) h += rowHeight(r);
  return h;
}

/** A `(continued)` copy: same kind, no marks, not wrapped again (the pseudo-code of §4.2). */
function continued(r: Row): Row {
  return { kind: r.kind, text: T("%s (continued)", r.text) };
}

/** Paginates blocks (print.md §4.2, the algorithm verbatim) into pages of rows. */
export function paginate(blocks: readonly Block[], capacity: number): Row[][] {
  const pages: Row[][] = [];
  let cur: Row[] = [];
  let used = 0;
  let folder: Row | undefined;
  const place = (r: Row) => {
    if (r.kind === "space" && cur.length === 0) return;
    cur.push(r);
    used += rowHeight(r);
  };
  const newPage = (kind: Row["kind"]) => {
    pages.push(cur);
    cur = [];
    used = 0;
    if (folder && kind !== "folder") place(continued(folder));
  };
  blocks.forEach((b, i) => {
    let need = blockHeight(b.rows);
    const next = blocks[i + 1];
    if (b.keep && next) {
      const hn = blockHeight(next.rows);
      need += hn <= capacity ? hn : blockHeight(next.rows.slice(0, 4));
    }
    if (cur.length > 0 && used + need > capacity && need <= capacity) {
      const first = b.rows.find((r) => r.kind !== "space") ?? b.rows[0];
      newPage(first ? first.kind : "space");
    }
    let head: Row | undefined;
    b.rows.forEach((r, j) => {
      const h = rowHeight(r);
      if (r.kind === "space" && cur.length > 0 && used + h > capacity) return;
      if (cur.length > 0 && used + h > capacity) {
        newPage(r.kind);
        if (head && j > 0) place(continued(head));
      }
      if (!head && (r.kind === "entry" || r.kind === "heading")) head = r;
      if (r.kind === "folder") folder = r;
      place(r);
    });
  });
  if (cur.length > 0 || pages.length === 0) pages.push(cur);
  return pages;
}

/** The first line of a page (print.md §4.1): `CONFIDENTIAL · <title>` … `<date> · page N of M`. */
export function pageHeader(title: string, date: string, page: number, pages: number): string {
  const left = T("CONFIDENTIAL") + " · " + title;
  const right = date + " · " + T("page %d of %d", page, pages);
  const gap = Math.max(1, COLUMNS - textWidth(left) - textWidth(right));
  return left + " ".repeat(gap) + right;
}

/** Renders a sheet as the text sheet (print.md §4): the bytes of the file, ending with LF. */
export function renderText(sheet: Sheet): string {
  const capacity = bodyHeight(sheet.legend.length);
  const pages = paginate(sheet.blocks, capacity);
  const out: string[] = [];
  pages.forEach((rows, i) => {
    const lines: string[] = [pageHeader(sheet.title, sheet.date, i + 1, pages.length), "=".repeat(COLUMNS), ""];
    const body: string[] = [];
    for (const r of rows) body.push(...rowLines(r));
    while (body.length < capacity) body.push("");
    lines.push(...body, "", "-".repeat(COLUMNS), ...sheet.legend);
    out.push((i > 0 ? "\f" : "") + lines.join("\n") + "\n");
  });
  return out.join("");
}
