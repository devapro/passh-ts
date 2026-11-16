// `passh print --fields` (print.md §2.1).

import { UsageError } from "../errors.ts";
import { foldEquals, generalCategory, trimWhiteSpace } from "../util/unicode.ts";

/** The standard names, matched in any case and stored lower case. */
export const STANDARD_FIELDS = ["password", "username", "url", "tags", "notes", "fields"] as const;
export type StandardField = (typeof STANDARD_FIELDS)[number];

/** One name of `--fields`: a standard name, or the key of a custom field (case-sensitive). */
export type FieldName = { kind: "standard"; name: StandardField } | { kind: "custom"; key: string };

/** The default when `--fields` names nothing. */
export const DEFAULT_FIELDS = "password,username,url";

/**
 * Reports whether a string is a valid custom field key (vault-format.md §4.3): a letter or
 * decimal digit (L*, Nd), then letters, digits, marks (M*), `_`, `.`, `-`.
 */
export function isFieldKey(k: string): boolean {
  let first = true;
  for (const ch of k) {
    const cp = ch.codePointAt(0)!;
    const gc = generalCategory(cp);
    const letterOrDigit = gc[0] === "L" || gc === "Nd";
    if (first) {
      if (!letterOrDigit) return false;
      first = false;
      continue;
    }
    if (letterOrDigit || gc[0] === "M" || ch === "_" || ch === "." || ch === "-") continue;
    return false;
  }
  return !first;
}

/** The text of a field name as `fields: …` shows it. */
export function fieldLabel(f: FieldName): string {
  return f.kind === "standard" ? f.name : f.key;
}

/**
 * Parses `--fields` (print.md §2.1): split at `,`, blanks around names trimmed, empty names
 * skipped, duplicates kept once (first position wins), in the order given. No names at all
 * → `password,username,url`. An invalid name is a usage error (exit 2):
 * `invalid field "a b": use password, username, url, tags, notes, fields, or the key of a custom field`.
 */
export function parseFields(value: string | undefined): FieldName[] {
  const out: FieldName[] = [];
  const seen = new Set<string>();
  const add = (f: FieldName) => {
    const id = f.kind === "standard" ? "s:" + f.name : "c:" + f.key;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(f);
  };
  for (const raw of (value ?? "").split(",")) {
    const name = trimWhiteSpace(raw);
    if (name === "") continue;
    const std = STANDARD_FIELDS.find((s) => foldEquals(s, name));
    if (std) {
      add({ kind: "standard", name: std });
      continue;
    }
    if (!isFieldKey(name)) throw new UsageError("invalid field %q: use password, username, url, tags, notes, fields, or the key of a custom field", name);
    add({ kind: "custom", key: name });
  }
  if (out.length === 0) return parseFields(DEFAULT_FIELDS);
  return out;
}
