// The report of `passh import pass` on stdout (import-export.md §1.8). It is meant for people,
// so it is translated (i18n.md §3); every path, file name and detail is escaped (S4,
// single-line form).

import { renderError, T, TN } from "../i18n/index.ts";
import { comparePaths } from "../paths/index.ts";
import { escapeLine } from "../sanitize/index.ts";
import { SKIP_REASON_TEXT, SKIP_REASONS, type Skip } from "./skips.ts";

export interface ReportItem {
  path: string;
  replace: boolean;
}

export interface ReportInput {
  /** The store, absolute (not `~`-contracted). */
  store: string;
  dryRun: boolean;
  /** Imported (or, in a dry run, planned) entries. */
  items: readonly ReportItem[];
  skips: readonly Skip[];
}

/** One skip line: `  ‹store file› — ‹reason›[: ‹detail›]` (" — " is U+2014). */
export function skipLine(s: Skip): string {
  let line = "  " + escapeLine(s.file) + " — " + T(SKIP_REASON_TEXT[s.reason]);
  if (s.detail) line += ": " + escapeLine(renderError(s.detail));
  return line;
}

/**
 * The report (§1.8): in a dry run the store line, the list of entries (`  ‹path›`, a replace
 * with `  (replaces the entry in the vault)`) and `Would import …`; in a real run
 * `Imported … from ‹store›.`; then, if anything was skipped, the counts in reason order and
 * one line per skip. Items are sorted by entry path (segment by segment), skips by store file
 * name in byte order.
 */
export function formatReport(r: ReportInput): string {
  const lines: string[] = [];
  const items = [...r.items].sort((a, b) => comparePaths(a.path, b.path));
  const n = items.length;
  const m = items.filter((i) => i.replace).length;
  const replacing = m > 0 ? T(" (%d replacing entries already in the vault)", m) : "";
  const store = escapeLine(r.store);
  if (r.dryRun) {
    lines.push(T("Dry run: nothing was decrypted or saved. Store: %s", store));
    if (n > 0) {
      lines.push(TN(n, "Would import %d entry:", "Would import %d entries:", n));
      for (const it of items) lines.push("  " + (it.replace ? T("%s  (replaces the entry in the vault)", escapeLine(it.path)) : escapeLine(it.path)));
    }
    lines.push(TN(n, "Would import %d entry%s.", "Would import %d entries%s.", n, replacing));
  } else {
    lines.push(TN(n, "Imported %d entry%s from %s.", "Imported %d entries%s from %s.", n, replacing, store));
  }
  const k = r.skips.length;
  if (k > 0) {
    const counts = SKIP_REASONS.map((reason) => [reason, r.skips.filter((s) => s.reason === reason).length] as const)
      .filter(([, c]) => c > 0)
      .map(([reason, c]) => `${c} ${T(SKIP_REASON_TEXT[reason])}`)
      .join(", ");
    lines.push(r.dryRun ? T("Would skip %d: %s.", k, counts) : T("Skipped %d: %s.", k, counts));
    for (const s of [...r.skips].sort((a, b) => Buffer.compare(a.file, b.file))) lines.push(skipLine(s));
  }
  return lines.join("\n") + "\n";
}
