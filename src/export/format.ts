// The export formats byte for byte (spec §7.1, §7.3, import-export.md §2.2–§2.6): selection
// and order, json, csv and bitwarden-json. Pure functions: data in, text out.

import { createHash } from "node:crypto";
import { formatTime } from "../model/time.ts";
import { isOtpauth, isSecretField } from "../model/ops.ts";
import type { Entry, Field, Time, VaultData } from "../model/types.ts";
import { baseName, comparePaths, foldersOf, hasAllTags, isInFolder, parentFolder } from "../paths/index.ts";
import { compareUTF8, foldEquals, utf8Encode } from "../util/unicode.ts";
import { JSONObject, writeJSON, type JSONValue } from "./json.ts";

/** The export formats (§2.1 `--format`, exact and case-sensitive). */
export type ExportFormat = "csv" | "json" | "bitwarden-json";

export const EXPORT_FORMATS: readonly ExportFormat[] = ["csv", "json", "bitwarden-json"];

/** Reports whether a `--format` value names a format. */
export function isExportFormat(s: string): s is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(s);
}

/** The entries an export writes, before formatting (§2.2). */
export interface Selection {
  /** A validated, NFC folder ("" or undefined: everything): entries strictly inside it, at any depth. */
  folder?: string;
  /** Normalized tags: entries having every one. */
  tags?: readonly string[];
}

/**
 * Selection and order (§2.2): the entries inside `folder` (not the entry at the folder's own
 * path) having every tag, sorted by path segment by segment, each segment by bytes.
 */
export function selectEntries(d: VaultData, sel: Selection = {}): Entry[] {
  const folder = sel.folder ?? "";
  const tags = sel.tags ?? [];
  return d.entries.filter((e) => isInFolder(e.path, folder) && hasAllTags(e.tags, tags)).sort((a, b) => comparePaths(a.path, b.path));
}

/** The number of custom fields (otp fields included) of the entries: what CSV leaves out (§2.1, §2.5). */
export function customFieldCount(entries: readonly Entry[]): number {
  let n = 0;
  for (const e of entries) n += e.fields.length;
  return n;
}

export interface FormatOptions {
  /** `exported_at` of the json format (§2.4): the export time, whole seconds. */
  exportedAt: Time;
  /** csv `--spreadsheet-safe` (§2.5). */
  spreadsheetSafe?: boolean;
  /**
   * Reproduce passh v0.6's known issues instead of the proposed fixes: audit #6 (json writes a
   * stored unknown top-level `exported_at` a second time) and #39 (bitwarden-json takes a first
   * `otp` field with an empty value as the TOTP).
   */
  quirks?: boolean;
}

/** The exact bytes a format writes for the selected entries (§2.4–§2.6). */
export function formatExport(format: ExportFormat, data: VaultData, entries: readonly Entry[], opts: FormatOptions): Uint8Array {
  switch (format) {
    case "json":
      return utf8Encode(formatJSONExport(data, entries, opts.exportedAt, opts));
    case "csv":
      return utf8Encode(formatCSVExport(entries, opts));
    case "bitwarden-json":
      return utf8Encode(formatBitwardenExport(data, entries, opts));
  }
}

// ---------------------------------------------------------------------------
// json (§2.4)

function fieldJSON(f: Field): JSONObject {
  return new JSONObject().set("key", f.key).set("value", f.value).unknowns(f.unknown);
}

function entryJSON(e: Entry): JSONObject {
  return new JSONObject()
    .set("id", e.id)
    .set("path", e.path)
    .set("password", e.password)
    .set("username", e.username)
    .set("url", e.url)
    .set("tags", [...e.tags])
    .set("fields", e.fields.map(fieldJSON))
    .set("notes", e.notes)
    .set("created_at", formatTime(e.createdAt))
    .set("updated_at", formatTime(e.updatedAt))
    .unknowns(e.unknown);
}

/**
 * The json format (§2.4): the data format of §4.2 with `exported_at` after `saved_at` and
 * without `deleted`; the header is the vault's own, `entries` holds the given entries in the
 * given order, and the data's unknown keys follow. A stored unknown top-level `exported_at`
 * is left out (the proposed fix of audit #6) unless `quirks`.
 */
// SPEC-GAP: §2.4 / audit #6: we implement the proposed fix (skip an unknown top-level key that
// collides with `exported_at`); with `quirks` the reference's duplicate key is reproduced.
export function formatJSONExport(data: VaultData, entries: readonly Entry[], exportedAt: Time, opts: { quirks?: boolean } = {}): string {
  const top = new JSONObject()
    .set("format", data.format)
    .set("version", data.version)
    .set("vault_id", data.vaultId)
    .set("revision", data.revision)
    .set("saved_at", formatTime(data.savedAt))
    .set("exported_at", formatTime(exportedAt))
    .set("entries", entries.map(entryJSON))
    .unknowns(data.unknown, opts.quirks ? undefined : (name) => name === "exported_at");
  return writeJSON(top);
}

// ---------------------------------------------------------------------------
// csv (§2.5)

export const CSV_HEADER = ["folder", "name", "username", "password", "url", "tags", "notes"] as const;

/** First bytes that `--spreadsheet-safe` defuses with a leading `'` (§2.5). */
const FORMULA_START = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * One CSV cell (§2.5): with `spreadsheetSafe`, a cell whose first byte is `= + - @`, TAB or
 * CR gets a leading `'` first. Then the cell is quoted when it contains `,`, `"`, CR or LF, or
 * starts or ends with a space or TAB; inside quotes `"` is doubled and nothing else changes
 * (line breaks stay as they are).
 */
export function csvCell(value: string, spreadsheetSafe = false): string {
  let v = value;
  if (spreadsheetSafe && v !== "" && FORMULA_START.has(v[0]!)) v = "'" + v;
  if (v === "") return "";
  const edge = (c: string) => c === " " || c === "\t";
  const quote = /[,"\r\n]/.test(v) || edge(v[0]!) || edge(v[v.length - 1]!);
  return quote ? '"' + v.replaceAll('"', '""') + '"' : v;
}

function csvRecord(cells: readonly string[], spreadsheetSafe: boolean): string {
  return cells.map((c) => csvCell(c, spreadsheetSafe)).join(",") + "\r\n";
}

/**
 * The csv format (§2.5): UTF-8 without a BOM, the header `folder,name,username,password,url,
 * tags,notes`, then one record per entry; every record ends in CRLF. Custom fields have no
 * column. The header is never changed by `spreadsheetSafe`.
 */
export function formatCSVExport(entries: readonly Entry[], opts: { spreadsheetSafe?: boolean } = {}): string {
  const safe = !!opts.spreadsheetSafe;
  let out = CSV_HEADER.join(",") + "\r\n";
  for (const e of entries) {
    out += csvRecord([parentFolder(e.path), baseName(e.path), e.username, e.password, e.url, e.tags.join(", "), e.notes], safe);
  }
  return out;
}

// ---------------------------------------------------------------------------
// bitwarden-json (§2.6)

/**
 * The deterministic ids of bitwarden-json (§2.6): the first 16 bytes of
 * SHA-256("passh bitwarden-json id" ‖ 0x00 ‖ part1 ‖ 0x00 ‖ part2 …) with the version nibble
 * 8 and the RFC 9562 variant, as lowercase 8-4-4-4-12 hex.
 */
export function bitwardenId(...parts: string[]): string {
  const h = createHash("sha256");
  h.update("passh bitwarden-json id");
  for (const p of parts) {
    h.update(new Uint8Array([0]));
    h.update(utf8Encode(p));
  }
  const b = new Uint8Array(h.digest()).subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const x = Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** `YYYY-MM-DDTHH:MM:SS.000Z` (UTC, always `.000`). */
function bitwardenDate(t: Time): string {
  return formatTime(t).slice(0, -1) + ".000Z";
}

/**
 * The field that becomes `login.totp` (§2.6): the first whose key is `otp` in any case,
 * whatever its value, else the first whose value starts with `otpauth://` (any case); -1 for
 * none. Without `quirks`, an `otp` field with an empty value doesn't count (the proposed fix
 * of audit #39).
 */
// SPEC-GAP: §2.6 / audit #39: we implement the proposed fix (an empty `otp` value is skipped
// when choosing the TOTP); with `quirks` the reference's choice is reproduced.
export function totpFieldIndex(fields: readonly Field[], quirks = false): number {
  const i = fields.findIndex((f) => foldEquals(f.key, "otp") && (quirks || f.value !== ""));
  if (i >= 0) return i;
  return fields.findIndex((f) => isOtpauth(f.value));
}

function bitwardenItem(e: Entry, folderIds: Map<string, string>, quirks: boolean): JSONObject {
  const totp = totpFieldIndex(e.fields, quirks);
  const fields: JSONValue[] = [];
  e.fields.forEach((f, i) => {
    if (i === totp) return;
    fields.push(new JSONObject().set("name", f.key).set("value", f.value).set("type", isSecretField(f.key, f.value) ? 1 : 0).set("linkedId", null));
  });
  if (e.tags.length > 0) fields.push(new JSONObject().set("name", "tags").set("value", e.tags.join(", ")).set("type", 0).set("linkedId", null));
  const folder = parentFolder(e.path);
  const item = new JSONObject()
    .set("passwordHistory", null)
    .set("revisionDate", bitwardenDate(e.updatedAt))
    .set("creationDate", bitwardenDate(e.createdAt))
    .set("deletedDate", null)
    .set("id", bitwardenId("item", e.id))
    .set("organizationId", null)
    .set("folderId", folder === "" ? null : folderIds.get(folder)!)
    .set("type", 1)
    .set("reprompt", 0)
    .set("name", baseName(e.path))
    .set("notes", e.notes === "" ? null : e.notes)
    .set("favorite", false);
  if (fields.length > 0) item.set("fields", fields);
  const login = new JSONObject().set("fido2Credentials", []);
  if (e.url !== "") login.set("uris", [new JSONObject().set("match", null).set("uri", e.url)]);
  login
    .set("username", e.username === "" ? null : e.username)
    .set("password", e.password === "" ? null : e.password)
    .set("totp", totp < 0 ? null : e.fields[totp]!.value);
  item.set("login", login).set("collectionIds", null);
  return item;
}

/**
 * The bitwarden-json format (§2.6): `encrypted` false, every folder of the entries with all
 * its ancestors sorted by bytes, and one login item per entry in the given order.
 */
export function formatBitwardenExport(data: VaultData, entries: readonly Entry[], opts: { quirks?: boolean } = {}): string {
  const names = new Set<string>();
  for (const e of entries) for (const f of foldersOf(e.path)) names.add(f);
  const sorted = [...names].sort(compareUTF8);
  const ids = new Map(sorted.map((f) => [f, bitwardenId("folder", data.vaultId, f)]));
  const top = new JSONObject()
    .set("encrypted", false)
    .set(
      "folders",
      sorted.map((f) => new JSONObject().set("id", ids.get(f)!).set("name", f)),
    )
    .set(
      "items",
      entries.map((e) => bitwardenItem(e, ids, !!opts.quirks)),
    );
  return writeJSON(top);
}
