// A small JSON writer with the text rules of import-export.md §2.3: Go's encoding/json with
// HTML escaping off, indented with two spaces (json.MarshalIndent / Encoder.SetIndent), a
// final LF. Strings are escaped by the vault's own quoting (src/model quoteJSON), and the
// unknown members kept from the vault are re-indented from their compact text, so number
// text and string escapes stay as they were (§2.4).

import { indentCompact, quoteJSON } from "../model/json.ts";
import type { Unknowns } from "../model/types.ts";
import { compareUTF8 } from "../util/unicode.ts";

/** Compact JSON text copied from the vault (an unknown member's value), re-indented when written. */
export class RawJSON {
  constructor(readonly compact: string) {}
}

/** An object: members in the order given. */
export class JSONObject {
  readonly members: Array<[string, JSONValue]> = [];
  /** Appends a member. */
  set(key: string, value: JSONValue): this {
    this.members.push([key, value]);
    return this;
  }
  /** Appends the unknown members of a vault object, sorted by the UTF-8 bytes of their names (vault-format.md §4.6). */
  unknowns(u: Unknowns, skip?: (name: string) => boolean): this {
    for (const [name, raw] of [...u].sort((a, b) => compareUTF8(a[0], b[0]))) {
      if (skip?.(name)) continue;
      this.members.push([name, new RawJSON(raw)]);
    }
    return this;
  }
}

export type JSONValue = string | number | bigint | boolean | null | JSONValue[] | JSONObject | RawJSON;

function ind(depth: number): string {
  return "  ".repeat(depth);
}

/** The text of a value whose first line is at nesting level `depth`. */
function valueText(v: JSONValue, depth: number): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return quoteJSON(v);
    case "number":
    case "bigint":
      return String(v);
    case "boolean":
      return v ? "true" : "false";
  }
  if (v instanceof RawJSON) return indentCompact(v.compact, depth);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return "[\n" + v.map((x) => ind(depth + 1) + valueText(x, depth + 1)).join(",\n") + "\n" + ind(depth) + "]";
  }
  if (v.members.length === 0) return "{}";
  return "{\n" + v.members.map(([k, x]) => ind(depth + 1) + quoteJSON(k) + ": " + valueText(x, depth + 1)).join(",\n") + "\n" + ind(depth) + "}";
}

/** The value as indented JSON text with a final LF (§2.3). */
export function writeJSON(v: JSONValue): string {
  return valueText(v, 0) + "\n";
}
