// The pass-style entry text form (spec §4.3, vault-format.md §5): writing (§5.1), reading
// (§5.2) and the `import pass` variant (§5.3, import-export.md §1.6).

import { codedError, errorf, PasshError } from "../i18n/index.ts";
import { entryContentProblem, isValidFieldKey } from "../model/data.ts";
import { isOtpauth, type EntryContent } from "../model/ops.ts";
import type { Entry, Field } from "../model/types.ts";
import { dedupeTags, parseTagList } from "../paths/index.ts";
import { decodeUTF8Strict, foldEquals, hasLoneSurrogate, isBlank, trimWhiteSpace } from "../util/unicode.ts";

/** The content a text holds: an entry without path, id, times and unknown keys. */
export type TextContent = EntryContent;

/**
 * Writes an entry's text form (§5.1): the password, `username: `, `url: `, `tags: ` (only
 * when set), the custom fields in order (`key:` alone for an empty value), then `---` and
 * the notes (only when there are notes).
 */
export function formatEntryText(e: Pick<Entry, "password" | "username" | "url" | "tags" | "fields" | "notes">): string {
  let out = e.password + "\n";
  if (e.username !== "") out += "username: " + e.username + "\n";
  if (e.url !== "") out += "url: " + e.url + "\n";
  if (e.tags.length > 0) out += "tags: " + e.tags.join(", ") + "\n";
  for (const f of e.fields) out += f.value === "" ? f.key + ":\n" : f.key + ": " + f.value + "\n";
  if (e.notes !== "") out += "---\n" + e.notes + "\n";
  return out;
}

export interface ParseOptions {
  /** The `import pass` variant (§5.3). */
  importVariant?: boolean;
}

/** A metadata line `key:` or `key: value` (§5.2 step 3.2); undefined when the line isn't one. */
export function splitMetadata(line: string): { key: string; value: string } | undefined {
  const i = line.indexOf(":");
  if (i <= 0) return undefined;
  const key = line.slice(0, i);
  if (!isValidFieldKey(key)) return undefined;
  const rest = line.slice(i + 1);
  if (rest === "") return { key, value: "" };
  if (rest[0] !== " ") return undefined;
  return { key, value: rest.slice(1) };
}

function dropOneCR(s: string): string {
  return s.endsWith("\r") ? s.slice(0, -1) : s;
}

/** Drops white-space-only lines at the start of a text (lines up to and including their LF). */
function dropLeadingBlankLines(s: string): string {
  for (;;) {
    const nl = s.indexOf("\n");
    const first = nl < 0 ? s : s.slice(0, nl);
    if (!isBlank(first) || s === "") return s;
    if (nl < 0) return "";
    s = s.slice(nl + 1);
  }
}

function lineError(n: number, e: unknown): PasshError {
  return codedError("invalid-entry", "line %d: %w", n, e);
}

/**
 * Reads a text form (§5.2; with `importVariant`, §5.3). Throws `the text is not valid UTF-8`,
 * `line n: username appears twice`, `line n: url appears twice`, `line n: invalid tag …`, or a
 * content error of §4.3 (`invalid entry: password must be a single line`). The fields have no
 * unknown keys; pair them with the stored ones with pairFields (§4.5).
 */
export function parseEntryText(input: string | Uint8Array, opts: ParseOptions = {}): TextContent {
  // 1. valid UTF-8
  let text: string;
  if (typeof input === "string") {
    if (hasLoneSurrogate(input)) throw codedError("invalid-entry", "the text is not valid UTF-8");
    text = input;
  } else {
    const t = decodeUTF8Strict(input);
    if (t === undefined) throw codedError("invalid-entry", "the text is not valid UTF-8");
    text = t;
  }
  // 2. line 1 is the password, minus one trailing CR
  const nl = text.indexOf("\n");
  const first = nl < 0 ? text : text.slice(0, nl);
  const password = dropOneCR(first);
  let rest = nl < 0 ? "" : text.slice(nl + 1);
  if (nl >= 0 && first.endsWith("\r")) rest = rest.replaceAll("\r\n", "\n");
  const content: TextContent = { password, username: "", url: "", tags: [], fields: [], notes: "" };
  if (nl < 0) return finish(content);

  const imp = !!opts.importVariant;
  let haveUsername = false;
  let haveUrl = false;
  // SPEC-GAP: import-export.md §1.6 doesn't say whether a moved metadata line keeps the CR it
  // lost when tested as metadata; it is moved without it. §5.3 says "a second username line
  // among them becomes a custom field"; we follow §1.6's table (a second `username` line goes
  // to the notes, a second `user`/`login` becomes a field).
  const moved: string[] = []; // import: metadata lines that go to the notes
  const otpFromNotes: Field[] = [];
  let notes = "";
  let separated = false;
  let pos = 0;
  let n = 2;
  while (pos <= rest.length) {
    if (pos === rest.length) break; // nothing after the last LF
    const end = rest.indexOf("\n", pos);
    const rawLine = end < 0 ? rest.slice(pos) : rest.slice(pos, end);
    const next = end < 0 ? rest.length : end + 1;
    const line = dropOneCR(rawLine);
    // 3.1 the separator
    if (line === "---") {
      notes = rest.slice(next);
      separated = true;
      break;
    }
    // import: an otpauth:// line becomes an `otp` field
    if (imp && isOtpauth(trimWhiteSpace(line))) {
      content.fields.push({ key: "otp", value: trimWhiteSpace(line), unknown: new Map() });
      pos = next;
      n++;
      continue;
    }
    // 3.2 a metadata line?
    const meta = splitMetadata(line);
    if (!meta) {
      notes = rest.slice(pos);
      break;
    }
    const { key, value } = meta;
    const isUser = foldEquals(key, "username");
    const isAlias = imp && (foldEquals(key, "user") || foldEquals(key, "login"));
    if (isUser || isAlias) {
      if (!haveUsername) {
        content.username = value;
        haveUsername = true;
      } else if (!imp) {
        throw lineError(n, errorf("username appears twice"));
      } else if (isUser) {
        moved.push(line);
      } else {
        content.fields.push({ key, value, unknown: new Map() });
      }
    } else if (foldEquals(key, "url")) {
      if (!haveUrl) {
        content.url = value;
        haveUrl = true;
      } else if (!imp) {
        throw lineError(n, errorf("url appears twice"));
      } else {
        moved.push(line);
      }
    } else if (foldEquals(key, "tags")) {
      try {
        content.tags.push(...parseTagList(value));
      } catch (e) {
        if (!imp) throw lineError(n, e);
        moved.push(line);
      }
    } else {
      content.fields.push({ key, value, unknown: new Map() });
    }
    pos = next;
    n++;
  }

  if (!imp) {
    // 4. blank lines at the start of unseparated notes dropped; one final LF removed
    if (!separated) notes = dropLeadingBlankLines(notes);
    if (notes.endsWith("\n")) notes = notes.slice(0, -1);
    content.notes = notes;
    return finish(content);
  }

  // import-export.md §1.6 steps 4–5
  if (!separated) notes = dropLeadingBlankLines(notes);
  const noteLines: string[] = [];
  for (const l of notes === "" ? [] : notes.split("\n")) {
    const t = trimWhiteSpace(l);
    if (isOtpauth(t)) otpFromNotes.push({ key: "otp", value: t, unknown: new Map() });
    else noteLines.push(l);
  }
  const all = [...moved, ...noteLines];
  while (all.length > 0 && isBlank(all[all.length - 1]!)) all.pop();
  content.notes = all.join("\n");
  content.fields.push(...otpFromNotes);
  return finish(content);
}

/** Step 5: tags de-duplicated, then the content rules of §4.3. */
function finish(c: TextContent): TextContent {
  c.tags = dedupeTags(c.tags);
  const p = entryContentProblem(c);
  if (p) throw p;
  return c;
}
