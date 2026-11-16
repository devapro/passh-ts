// The print page's HTML (print.md §6.8): the reference's template, CSS and escaping, and the
// Content-Security-Policy with the style's hash. The page is produced as a sequence of
// pieces (the template's literal texts and its escaped values, in order) so that it can be
// streamed through a buffered writer as it is rendered.

import { createHash } from "node:crypto";
import { T, htmlLang } from "../i18n/index.ts";
import type { Row } from "../print/rows.ts";
import type { Sheet } from "../print/sheet.ts";

/** The only style of the page: the bytes between `<style>` and `</style>` (no CSS comment). */
export const CSS = `
@page { size: auto; margin: 12mm 15mm; }
html { background: #fff; color: #000; color-scheme: light; }
body { margin: 0; padding: 12px; font-family: ui-monospace, "DejaVu Sans Mono", "Liberation Mono", Menlo, Consolas, monospace; font-size: 10pt; line-height: 1.3; }
.tip { font-family: system-ui, sans-serif; background: #ffe; border: 1px solid #cc9; padding: 8px 12px; margin: 0 0 12px; }
.wrap { overflow-x: auto; }
table.sheet { border-collapse: collapse; width: 100%; }
table.sheet td { padding: 0; vertical-align: top; }
.hd { display: flex; justify-content: space-between; gap: 2ch; font-size: 8.5pt; border-bottom: 1.5px solid #000; padding-bottom: 2pt; margin-bottom: 8pt; }
.ft { font-size: 7pt; color: #333; border-top: 1px solid #000; padding-top: 2pt; margin-top: 8pt; }
.nb { break-inside: avoid; page-break-inside: avoid; }
.keep { break-after: avoid; page-break-after: avoid; }
.r { white-space: pre; min-height: 1.3em; }
.r.sp { min-height: 0; height: 0.6em; }
.title { font-size: 14pt; font-weight: bold; }
.meta { font-size: 9pt; color: #444; }
.folder, .heading { font-size: 11pt; font-weight: bold; border-bottom: 1px solid #777; margin-bottom: 3pt; }
.entry, .warning, .key { font-weight: bold; }
.key { font-size: 16pt; }
.code { font-size: 6.5pt; }
.lb { color: #666; }
.mk { white-space: pre; line-height: 1; margin-bottom: 2pt; }
.mk b { display: inline-block; width: 1.4286ch; font-size: 7pt; text-align: center; color: #444; }
.qr { margin: 4pt 0; }
.qr svg { width: 38mm; height: 38mm; display: block; }
@media print {
  body { padding: 0; }
  .tip { display: none; }
  .wrap { overflow: visible; }
}
`;

/** `sha256-<base64>` of a style text (print.md §6.8). */
export function styleHash(css: string = CSS): string {
  return "sha256-" + createHash("sha256").update(css, "utf8").digest("base64");
}

/** The Content-Security-Policy value of every response (print.md §6.8). */
export function contentSecurityPolicy(css: string = CSS): string {
  return `default-src 'none'; style-src '${styleHash(css)}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&#34;", "+": "&#43;", "\u0000": "�" };

/** The page's escaping of data (print.md §6.8): `& < > ' " +` as entities, NUL as U+FFFD. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>'"+\u0000]/g, (c) => HTML_ESCAPES[c]!);
}

/** The same escaping with `+` kept (the tip and the QR's aria-label). */
export function escapeHtmlKeepPlus(s: string): string {
  return s.replace(/[&<>'"\u0000]/g, (c) => HTML_ESCAPES[c]!);
}

const ROW_CLASS: Record<Row["kind"], string> = {
  title: "title",
  meta: "meta",
  folder: "folder",
  entry: "entry",
  value: "value",
  heading: "heading",
  text: "text",
  warning: "warning",
  key: "key",
  code: "code",
  space: "sp",
  qr: "qr",
};

/** Blocks of at most this many rows are kept whole (`nb`, print.md §7). */
export const WHOLE_BLOCK_ROWS = 16;

/** The tip at the top of the page (hidden in print). */
export function pageTip(): string {
  return T("Print with Ctrl+P (Cmd+P on a Mac), then close this tab. This page was served once and is gone from passh; the browser may still keep it in its session history.");
}

/** A marks line in the page's form: each code letter as `<b>X</b>`, blanks as spaces. */
export function marksHtml(marks: string): string {
  return marks.replace(/[DULS]/g, (c) => `<b>${c}</b>`);
}

/**
 * The page's pieces, in the order the reference's template writes them (literal texts and
 * escaped values). Joined, they are the page.
 */
export function* pagePieces(sheet: Sheet): Generator<string> {
  const conf = escapeHtml(T("CONFIDENTIAL"));
  const title = escapeHtml(sheet.title);
  yield '<!DOCTYPE html>\n<html lang="';
  yield escapeHtml(htmlLang());
  yield '">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="referrer" content="no-referrer">\n<meta name="robots" content="noindex, nofollow">\n<title>';
  yield conf;
  yield " · ";
  yield title;
  yield "</title>\n<style>" + CSS + '</style>\n</head>\n<body>\n<p class="tip">';
  yield escapeHtmlKeepPlus(pageTip());
  yield '</p>\n<div class="wrap">\n<table class="sheet">\n<thead><tr><td><div class="hd"><span><b>';
  yield conf;
  yield "</b> · ";
  yield title;
  yield "</span><span>";
  yield escapeHtml(T("printed %s", sheet.date));
  yield '</span></div></td></tr></thead>\n<tfoot><tr><td><div class="ft">';
  for (const l of sheet.legend) {
    yield "<div>";
    yield escapeHtml(l);
    yield "</div>";
  }
  yield '</div></td></tr></tfoot>\n<tbody><tr><td>\n';
  for (const b of sheet.blocks) {
    yield '<div class="blk';
    if (b.rows.length <= WHOLE_BLOCK_ROWS) yield " nb";
    if (b.keep) yield " keep";
    yield '">\n';
    for (const r of b.rows) {
      if (r.kind === "qr") {
        yield '<div class="qr">';
        yield r.qr ?? "";
        yield "</div>\n";
        continue;
      }
      yield '<div class="r ';
      yield ROW_CLASS[r.kind];
      yield '">';
      if (r.prefix) {
        yield '<span class="lb">';
        yield escapeHtml(r.prefix);
        yield "</span>";
      }
      yield escapeHtml(r.text);
      yield "</div>\n";
      if (r.marks) {
        yield '<div class="mk">';
        yield marksHtml(r.marks);
        yield "</div>\n";
      }
    }
    yield "</div>\n";
  }
  yield "</td></tr></tbody>\n</table>\n</div>\n</body>\n</html>\n";
}

/** The whole page as one string. */
export function renderPage(sheet: Sheet): string {
  let s = "";
  for (const p of pagePieces(sheet)) s += p;
  return s;
}
