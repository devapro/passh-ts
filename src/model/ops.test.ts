import { describe, expect, test } from "bun:test";
import { hasCode } from "../i18n/index.ts";
import {
  addEntry,
  cloneVaultData,
  editEntry,
  editTags,
  emptyContent,
  entryPaths,
  fieldValue,
  findEntry,
  isSecretField,
  moveEntry,
  moveFolder,
  newVaultData,
  nextRevision,
  pairFields,
  prepareSave,
  removeEntry,
  setPassword,
  vaultDataEqual,
  MAX_REVISION,
  type Field,
  type VaultData,
} from "./index.ts";

const T0 = 1_000;
const T1 = 2_000;

function errOf(f: () => unknown): Error {
  try {
    f();
  } catch (e) {
    return e as Error;
  }
  throw new Error("no error");
}

function vault(...paths: string[]): VaultData {
  let d = newVaultData(T0);
  for (const p of paths) d = addEntry(d, p, { ...emptyContent(), password: "pw-" + p }, { now: T0 }).data;
  return d;
}

const F = (key: string, value: string, unknown: Array<[string, string]> = []): Field => ({ key, value, unknown: new Map(unknown) });

describe("add", () => {
  test("new entry appended, times now, input untouched", () => {
    const d = vault("a");
    const before = cloneVaultData(d);
    const r = addEntry(d, "b", { ...emptyContent(), tags: [" x ", "x", "y"] }, { now: T1 });
    expect(r.changed).toBe(true);
    expect(r.data.entries.map((e) => e.path)).toEqual(["a", "b"]);
    expect(r.entry!.createdAt).toBe(T1);
    expect(r.entry!.updatedAt).toBe(T1);
    expect(r.entry!.tags).toEqual(["x", "y"]);
    expect(r.entry!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(vaultDataEqual(d, before)).toBe(true);
  });
  test("taken path", () => {
    const e = errOf(() => addEntry(vault("a"), "a", emptyContent()));
    expect(e.message).toBe("a: already exists");
    expect(hasCode(e, "exists")).toBe(true);
  });
  test("overwrite keeps id, created_at, position, entry unknowns; fields replaced", () => {
    let d = vault("a", "b");
    d.entries[0]!.unknown.set("x", "1");
    d.entries[0]!.fields = [F("k", "v", [["u", "2"]])];
    const old = d.entries[0]!;
    const r = addEntry(d, "a", { ...emptyContent(), password: "new" }, { now: T1, overwrite: true });
    expect(r.changed).toBe(true);
    const e = r.data.entries[0]!;
    expect([e.id, e.createdAt, e.updatedAt, e.password, e.fields.length, e.unknown.get("x")]).toEqual([old.id, T0, T1, "new", 0, "1"]);
    // identical content: nothing changes
    d = r.data;
    const again = addEntry(d, "a", { ...emptyContent(), password: "new" }, { now: T1 + 5, overwrite: true });
    expect(again.changed).toBe(false);
    expect(again.data.entries[0]!.updatedAt).toBe(T1);
  });
  test("content rules", () => {
    expect(errOf(() => addEntry(vault(), "a", { ...emptyContent(), password: "a\nb" })).message).toBe("invalid entry: password must be a single line");
    expect(errOf(() => addEntry(vault(), "a", { ...emptyContent(), tags: ["a,b"] })).message).toBe('invalid tag "a,b": it contains a comma');
    expect(errOf(() => addEntry(vault(), "a", { ...emptyContent(), fields: [F("url", "x")] })).message).toBe('invalid entry: "url" can\'t be a custom field key');
  });
});

describe("edit", () => {
  test("by id, keeps unknowns and created_at, moves with a new path", () => {
    const d = vault("a", "b");
    d.entries[0]!.unknown.set("x", "1");
    const id = d.entries[0]!.id;
    const r = editEntry(d, id, { path: "c", username: "u" }, { now: T1 });
    expect(r.changed).toBe(true);
    expect(r.data.entries[0]!).toMatchObject({ id, path: "c", username: "u", createdAt: T0, updatedAt: T1 });
    expect(r.data.entries[0]!.unknown.get("x")).toBe("1");
    expect(errOf(() => editEntry(d, id, { path: "b" })).message).toBe("b: already exists");
    const same = editEntry(d, id, { password: "pw-a" }, { now: T1 });
    expect(same.changed).toBe(false);
    expect(hasCode(errOf(() => editEntry(d, "nope", {})), "not-found")).toBe(true);
  });
  test("setPassword (generate --force) changes only the password", () => {
    const d = vault("a");
    d.entries[0]!.username = "u";
    const r = setPassword(d, "a", "P", { now: T1 });
    expect(r.data.entries[0]!).toMatchObject({ password: "P", username: "u", updatedAt: T1 });
    expect(errOf(() => setPassword(d, "zz", "P")).message).toBe("zz: not found");
  });
});

describe("move and remove", () => {
  test("moveEntry", () => {
    const d = vault("a", "b");
    const r = moveEntry(d, "a", "x/a", { now: T1 });
    expect(r.data.entries.map((e) => e.path)).toEqual(["x/a", "b"]);
    expect(r.data.entries[0]!.updatedAt).toBe(T1);
    expect(r.data.entries[0]!.id).toBe(d.entries[0]!.id);
    expect(errOf(() => moveEntry(d, "a", "a")).message).toBe("a: already exists");
    expect(errOf(() => moveEntry(d, "a", "b")).message).toBe("b: already exists");
    expect(errOf(() => moveEntry(d, "zz", "q")).message).toBe("zz: not found");
  });
  test("moveFolder", () => {
    const d = vault("work/github", "work/a/b", "work", "workshop/x");
    const r = moveFolder(d, "work", "archive/work", { now: T1 });
    expect(r.moved).toBe(2);
    expect(entryPaths(r.data)).toEqual(["archive/work/a/b", "archive/work/github", "work", "workshop/x"]);
    expect(errOf(() => moveFolder(d, "nope", "x")).message).toBe("nope: not found");
    expect(errOf(() => moveFolder(d, "work", "work/x")).message).toBe("can't move the folder work into itself");
    expect(errOf(() => moveFolder(d, "work", "work")).message).toBe("can't move the folder work into itself");
    expect(errOf(() => moveFolder(vault("a/x", "b/x"), "a", "b")).message).toBe("b/x: already exists");
    // known issue (audit #36): a destination held by an entry of the same move that hasn't moved yet
    expect(errOf(() => moveFolder(vault("m/b/x", "m/b/b/x"), "m/b", "m")).message).toBe("m/b/x: already exists");
  });
  test("removeEntry appends a tombstone", () => {
    const d = vault("a", "b", "c");
    d.entries[1]!.unknown.set("x", "1");
    const r = removeEntry(d, "b", { now: T1 });
    expect(r.data.entries.map((e) => e.path)).toEqual(["a", "c"]);
    expect(r.data.deleted).toEqual([{ id: d.entries[1]!.id, deletedAt: T1, unknown: new Map() }]);
    expect(errOf(() => removeEntry(d, "zz")).message).toBe("zz: not found");
  });
});

describe("tags", () => {
  test("add, then remove, normalized; unchanged detection", () => {
    const d = vault("a");
    let r = editTags(d, "a", ["x", " y ", "x"], [], { now: T1 });
    expect(r.tags).toEqual(["x", "y"]);
    expect(r.changed).toBe(true);
    r = editTags(r.data, "a", ["x"], ["x"], { now: T1 });
    expect(r.tags).toEqual(["y"]);
    const same = editTags(r.data, "a", ["y"], ["absent"], { now: T1 + 9 });
    expect(same.changed).toBe(false);
    expect(errOf(() => editTags(d, "a", [","], [])).message).toBe('invalid tag ",": it contains a comma');
  });
});

describe("fields", () => {
  test("lookup", () => {
    const d = vault("a");
    const e = d.entries[0]!;
    e.tags = ["work", "dev"];
    e.fields = [F("password", "shadowed"), F("pin", "1"), F("pin", "2"), F("", "empty-key")];
    expect(fieldValue(e, "password")).toBe("pw-a");
    expect(fieldValue(e, "tags")).toBe("work, dev");
    expect(fieldValue(e, "pin")).toBe("1");
    expect(fieldValue(e, "PIN")).toBeUndefined();
    expect(fieldValue(e, "")).toBe("empty-key");
    expect(fieldValue(e, "notes")).toBe("");
  });
  test("masked like a password", () => {
    expect(isSecretField("Password", "x")).toBe(true);
    expect(isSecretField("OTP", "x")).toBe(true);
    expect(isSecretField("note", "OTPAUTH://totp/x")).toBe(true);
    expect(isSecretField("note", "otpauth:/x")).toBe(false);
    expect(isSecretField("pin", "1234")).toBe(false);
  });
  test("pairFields (edit --editor)", () => {
    const stored = [F("a", "1", [["u", "1"]]), F("b", "2", [["u", "2"]]), F("a", "1", [["u", "3"]])];
    const out = pairFields(stored, [
      { key: "b", value: "2" },
      { key: "a", value: "1" },
      { key: "a", value: "1" },
      { key: "a", value: "1" },
      { key: "b", value: "changed" },
    ]);
    expect(out.map((f) => f.unknown.get("u"))).toEqual(["2", "1", "3", undefined, undefined]);
  });
});

describe("saves", () => {
  test("nextRevision and prepareSave", () => {
    expect(nextRevision(5n)).toBe(6n);
    expect(nextRevision(5n, 9n)).toBe(10n);
    expect(hasCode(errOf(() => nextRevision(MAX_REVISION)), "revision-max")).toBe(true);
    const d = vault("a");
    const s = prepareSave(d, d.revision, T1);
    expect([s.revision, s.savedAt, d.revision]).toEqual([2n, T1, 1n]);
    expect(findEntry(s, "a")).toBeDefined();
  });
});
