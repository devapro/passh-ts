// `passh ls [folder] [--tag t]…` (cli.md §2.3), `passh find <query>` (§2.4) and
// `passh tags` (§2.13): the read-only listings on stdout.

import { tildePath } from "../config/index.ts";
import { errorf, T } from "../i18n/index.ts";
import { rankEntries } from "../fuzzy/index.ts";
import { countTags, listEntries, normalizeTag, parseFolder, renderTree } from "../paths/index.ts";
import { escapeLine } from "../sanitize/index.ts";
import { codePointLength } from "../util/unicode.ts";
import type { RunContext } from "./command.ts";
import { commandIO, withVault } from "./open.ts";

/**
 * `ls`: folder and tags are validated before unlocking (folder first); the header is the
 * vault file (`<file>`) or `<folder>/`, then `  (tag <t1>, <t2>)` with tags; then the tree,
 * or `(no entries)`; or just the folder's own path when it is a matching entry and holds
 * nothing that matches; else `<folder>: no such folder`.
 */
export async function runLs(ctx: RunContext): Promise<void> {
  const folder = ctx.args.length > 0 ? parseFolder(ctx.args[0]!) : undefined;
  const tags = ctx.flags.strings("tag").map((t) => normalizeTag(t));
  const out = await withVault(ctx, (v) => {
    const listing = listEntries(v.data.entries, folder, tags);
    if (listing.kind === "entry") return escapeLine(listing.path) + "\n";
    let header = folder !== undefined ? escapeLine(folder) + "/" : escapeLine(tildePath(v.path));
    if (tags.length > 0) header += "  (tag " + tags.map((t) => escapeLine(t)).join(", ") + ")";
    const lines = listing.kind === "tree" ? renderTree(listing.nodes, escapeLine) : ["(no entries)"];
    return [header, ...lines].join("\n") + "\n";
  });
  commandIO.stdout(out);
}

/**
 * `find <query>`: the query as given (not normalized, not trimmed; audit #37 kept), ranked by
 * cli.md §2.4; one line per entry, `<path>` or `<path>  (tag <tag>)`. No match:
 * `no entry matches <query>` (Go-quoted), exit 1.
 */
export async function runFind(ctx: RunContext): Promise<void> {
  const query = ctx.args[0]!;
  const out = await withVault(ctx, (v) => {
    const hits = rankEntries(query, v.data.entries, { mode: "find" });
    if (hits.length === 0) throw errorf("no entry matches %q", query);
    return hits.map((h) => escapeLine(h.entry.path) + (h.tag !== undefined ? "  (tag " + escapeLine(h.tag) + ")" : "") + "\n").join("");
  });
  commandIO.stdout(out);
}

/**
 * `tags`: one line per tag in byte order, the escaped tag padded with spaces to the longest
 * (code points of the escaped text), two spaces, the count. No tags: `passh: no tags`, exit 0.
 */
export async function runTags(ctx: RunContext): Promise<void> {
  const counts = await withVault(ctx, (v) => countTags(v.data.entries));
  if (counts.length === 0) {
    commandIO.note(T("no tags"));
    return;
  }
  const shown = counts.map((c) => ({ tag: escapeLine(c.tag), count: c.count }));
  const width = Math.max(...shown.map((c) => codePointLength(c.tag)));
  commandIO.stdout(shown.map((c) => c.tag + " ".repeat(width - codePointLength(c.tag)) + "  " + c.count + "\n").join(""));
}
