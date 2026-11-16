// Interop of the data helpers (src/model, src/entrytext, src/paths, src/sanitize,
// src/fuzzy) with the reference implementation (reference/passh-go, run as a black box).
//
//   a. a data block passh-go wrote (init, generate, tag, add with tricky input) reads with
//      parseVaultData, and serializeVaultData gives back its plaintext byte for byte;
//   b. a data block we write (tricky paths, tags, values, unknown keys at all four levels)
//      opens in passh-go, and its stdout for `ls`, `ls <folder>`, `ls --tag`, `find`, `tags`,
//      `show`, `show --raw` and `show --field` equals what our helpers produce;
//   c. passh-go changes that data (`tag`, `mv`, `rm`, `generate --force`): the plaintext it
//      writes equals our operation's result serialized, unknown keys included;
//   d. data errors: the `invalid vault data: …` details of passh-go and parseVaultData agree.
//
// The vault key comes from the key block (src/keys); an agent (`passh unlock`) serves the
// reference so that each command doesn't run scrypt.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { isolatedEnv, REF_BIN, run, type IsolatedEnv } from "../helpers/env.ts";
import { initVault, PASS, withPassphrase } from "../helpers/passh.ts";
import { spawnPty } from "../helpers/pty.ts";
import { decryptData, encryptData, unwrapKeyBlock, type X25519Identity } from "../../src/keys/index.ts";
import { encodeContainer, parseContainer } from "../../src/vaultfile/index.ts";
import {
  addEntry,
  editTags,
  emptyContent,
  fieldValue,
  findEntry,
  moveEntry,
  parseVaultData,
  prepareSave,
  removeEntry,
  serializeVaultData,
  setPassword,
  type Field,
  type VaultData,
} from "../../src/model/index.ts";
import { formatEntryText, parseEntryText } from "../../src/entrytext/index.ts";
import { countTags, listEntries, renderTree } from "../../src/paths/index.ts";
import { escapeLine, escapeMultiline } from "../../src/sanitize/index.ts";
import { rankEntries } from "../../src/fuzzy/index.ts";
import { codePointLength } from "../../src/util/unicode.ts";
import { goQuote } from "../../src/i18n/quote.ts";

setDefaultTimeout(60_000);

const te = new TextEncoder();
const td = new TextDecoder();

let e: IsolatedEnv;
let identity: X25519Identity;
let keyBlock: Uint8Array;
let revision = 1000n;

beforeAll(async () => {
  e = isolatedEnv("data");
  await initVault([REF_BIN], e);
  const c = parseContainer(new Uint8Array(readFileSync(e.vault)));
  keyBlock = c.keyBlock;
  identity = await unwrapKeyBlock(keyBlock, te.encode(PASS));
  const u = await withPassphrase([REF_BIN], ["unlock"], e);
  if (u.code !== 0) throw new Error("unlock failed: " + u.tty);
});

afterAll(async () => {
  if (!e) return;
  await run([REF_BIN, "lock"], e.env);
  e.cleanup();
});

const ref = (...args: string[]) => run([REF_BIN, ...args], e.env);

/** The data block's plaintext of the vault file. */
function plaintext(): Uint8Array {
  const c = parseContainer(new Uint8Array(readFileSync(e.vault)));
  return decryptData(c.dataBlock, identity, "agent");
}

/** Writes data as the vault's data block (our serializer), at a revision above every earlier one. */
function writeData(d: VaultData): VaultData {
  revision += 10n;
  const data = { ...d, revision };
  writeFileSync(e.vault, encodeContainer(keyBlock, encryptData(serializeVaultData(data), identity)), { mode: 0o600 });
  return data;
}

function writeRaw(json: string): void {
  revision += 10n;
  writeFileSync(e.vault, encodeContainer(keyBlock, encryptData(te.encode(json), identity)), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// What the CLI prints, built from our helpers (cli.md §2.3–§2.5, §2.13)

function header(folder: string | undefined, tags: string[]): string {
  let h = folder ? escapeLine(folder) + "/" : escapeLine(e.vault);
  if (tags.length > 0) h += "  (tag " + tags.map(escapeLine).join(", ") + ")";
  return h;
}

function lsOut(d: VaultData, folder?: string, tags: string[] = []): string {
  const l = listEntries(d.entries, folder, tags);
  if (l.kind === "entry") return escapeLine(l.path) + "\n";
  if (l.kind === "empty") return header(folder, tags) + "\n(no entries)\n";
  return [header(folder, tags), ...renderTree(l.nodes, escapeLine)].join("\n") + "\n";
}

function findOut(d: VaultData, q: string): string {
  return rankEntries(q, d.entries, { mode: "find" })
    .map((h) => escapeLine(h.entry.path) + (h.tag !== undefined ? "  (tag " + escapeLine(h.tag) + ")" : "") + "\n")
    .join("");
}

function tagsOut(d: VaultData): string {
  const rows = countTags(d.entries).map((t) => ({ name: escapeLine(t.tag), count: t.count }));
  const w = Math.max(0, ...rows.map((r) => codePointLength(r.name)));
  return rows.map((r) => r.name + " ".repeat(w - codePointLength(r.name)) + "  " + r.count + "\n").join("");
}

// ---------------------------------------------------------------------------

describe("a. data written by passh-go", () => {
  test("a fresh vault's data reads and serializes back byte for byte", () => {
    const p = plaintext();
    const d = parseVaultData(p);
    expect(d.revision).toBe(1n);
    expect(d.entries).toEqual([]);
    expect(td.decode(serializeVaultData(d))).toBe(td.decode(p));
    revision = 1000n;
  });

  test("entries made by generate, tag and add", async () => {
    expect((await ref("generate", "work/github", "32", "--symbols")).code).toBe(0);
    expect((await ref("tag", "work/github", "--add", "work", "--add", " 2fa ,x", "--remove", "x")).code).toBe(0);
    // add, on a terminal (the agent has the key: no passphrase prompt)
    const p = spawnPty([REF_BIN, "add", "café/ünï ☕"], e.env);
    await p.expect("Password (empty to generate): ");
    p.line("p@ss wörd «»");
    await p.expect("Repeat password: ");
    p.line("p@ss wörd «»");
    await p.expect("Username: ");
    p.line("ārsenii");
    await p.expect("URL: ");
    p.line("https://example.com/ü?q=1");
    await p.expect("Tags (comma-separated): ");
    p.line("ключ, e\u0301, two words,ключ");
    await p.expect("Notes (end with an empty line):");
    p.line("line one");
    p.line("  indented: yes");
    p.line("");
    const r = await p.wait();
    expect(r.code).toBe(0);
    expect((await ref("generate", "work/a b'c")).code).toBe(0);
    expect((await ref("mv", "work/a b'c", "bank/My Bank")).code).toBe(0);
    expect((await ref("rm", "-f", "bank/My Bank")).code).toBe(0);

    const plain = plaintext();
    const d = parseVaultData(plain);
    expect(td.decode(serializeVaultData(d))).toBe(td.decode(plain));
    const cafe = findEntry(d, "café/ünï ☕")!;
    expect(cafe).toMatchObject({ password: "p@ss wörd «»", username: "ārsenii", url: "https://example.com/ü?q=1", tags: ["ключ", "é", "two words"], notes: "line one\n  indented: yes" });
    expect(findEntry(d, "work/github")!.tags).toEqual(["work", "2fa"]);
    expect(findEntry(d, "work/github")!.password.length).toBe(32);
    expect(d.deleted.length).toBe(1);
    // show --raw is our text form, byte for byte; show escapes it
    const raw = await ref("show", "--raw", "café/ünï ☕");
    expect(raw.stdout).toBe(formatEntryText(cafe));
    expect((await ref("show", "café/ünï ☕")).stdout).toBe(escapeMultiline(formatEntryText(cafe)));
    expect(parseEntryText(raw.stdoutBytes)).toMatchObject({ username: "ārsenii", tags: ["ключ", "é", "two words"] });
    expect((await ref("ls")).stdout).toBe(lsOut(d));
    expect((await ref("tags")).stdout).toBe(tagsOut(d));
  });
});

// ---------------------------------------------------------------------------

const F = (key: string, value: string, unknown: Array<[string, string]> = []): Field => ({ key, value, unknown: new Map(unknown) });

/** A vault full of tricky content, built with our operations. */
function trickyData(): VaultData {
  let d = parseVaultData(plaintext());
  d = { ...d, entries: [], deleted: [] };
  const add = (path: string, o: Partial<ReturnType<typeof emptyContent>> = {}) => {
    d = addEntry(d, path, { ...emptyContent(), password: "pw:" + path, ...o }, { now: 1_800_000_000 }).data;
  };
  add("work", { tags: ["2fa"] });
  add("work/github", { username: "arsenii", url: "https://github.com", tags: ["work", "2fa"], fields: [F("recovery-email", "me@example.com", [["note", '"kept"']])], notes: "Free-form notes.\n\tRecovery codes\r\nend\u0007" });
  add("work/a b'c");
  add("work-old/y", { tags: ["zz-gh"] });
  add("bank/My Bank", { tags: ["bank", "2fa"] });
  add("homelab");
  add("x/y");
  add("café/ünï", { tags: ["é", "ключ"] });
  add("emoji/🔑 key", { tags: ["ключ", "two words", "nb\u00a0sp"] });
  add("zw/a\u200bb", { tags: ["z\u200bw"] });
  add("rtl/\u202eevil", { username: "\u202eevil" });
  add("esc", { password: "\u001b[31mred\u0000", username: "a\tb", url: "x\u007fy\u0085z", notes: "line1\n\tline2\r\nend\u001b]52;c;eA==\u0007", fields: [F("otp", "otpauth://totp/x"), F("password", "shadowed"), F("notes", "shadowed too"), F("pin", ""), F("pin", "second")] });
  add("dup/tags", { tags: ["Work", "work"] });
  add("github", { tags: ["gh"] });
  add("work/gitlab", { tags: ["zz-gh"] });
  add("a", { tags: ["gx2", "gx1"] });
  add("b", { tags: ["gx1", "gx2"] });
  add("Kelvin \u212a", { tags: ["\u017fs"] });
  add("\u0661\u0662/\u0301mark");
  add("myGitHub");
  add("The Black Knight");
  add("a.b_c-d:e\\f");
  add("deep/er/est/leaf");
  add("deep/er/x");
  add("~2/...");
  // unknown keys at all four levels
  d.unknown.set("zeta", '{"b":[1E0,-0,1.50,"\\/","\\ud800","\u2028",{},[],{"d":1,"d":2}],"a":null}');
  d.unknown.set("B", "1");
  d.unknown.set("e\u0301", "2");
  d.unknown.set("😀", '"x"');
  d.entries[1]!.unknown.set("extra", '[1,{"q":[]}]');
  d.deleted.push({ id: "t1", deletedAt: 1_700_000_000, unknown: new Map([["why", '"x"']]) });
  return d;
}

describe("b. our data in passh-go: listings and show", () => {
  let d: VaultData;
  beforeAll(() => {
    d = writeData(trickyData());
  });

  test("passh-go opens it", async () => {
    const r = await ref("ls");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });

  const lsCases: Array<[string | undefined, string[]]> = [
    [undefined, []],
    ["work", []],
    ["deep", []],
    ["deep/er", []],
    ["emoji", []],
    ["zw", []],
    [undefined, ["2fa"]],
    [undefined, ["work", "2fa"]],
    [undefined, ["ключ"]],
    [undefined, ["nb\u00a0sp"]],
    [undefined, ["nosuchtag"]],
    ["work", ["2fa"]],
    ["work", ["nosuch"]],
    ["work/github", []],
    ["work/github", ["work"]],
  ];
  for (const [folder, tags] of lsCases) {
    test(`ls ${folder ?? ""} ${tags.map((t) => "--tag " + t).join(" ")}`, async () => {
      const args = ["ls", ...(folder ? [folder] : []), ...tags.flatMap((t) => ["--tag", t])];
      const r = await ref(...args);
      expect(r.stderr).toBe("");
      expect(r.stdout).toBe(lsOut(d, folder, tags));
    });
  }

  test("ls of a missing folder", async () => {
    const r = await ref("ls", "nosuch");
    expect(r.code).toBe(1);
    let msg = "";
    try {
      lsOut(d, "nosuch");
    } catch (x) {
      msg = (x as Error).message;
    }
    expect(r.stderr).toBe("passh: " + msg + "\n");
    const r2 = await ref("ls", "work/github", "--tag", "x");
    expect(r2.stderr).toBe("passh: work/github: no such folder\n");
  });

  const queries = ["gh", "gx", "work", "é", "ünï", " ", "k", "K", "ſ", "s", "zw", "ключ", "Ü", "a b", "tk", "GIT", "/", "١", "\u0301", "wor k", "deep/x", "~"];
  for (const q of queries) {
    test(`find ${JSON.stringify(q)}`, async () => {
      const r = await ref("find", q);
      const want = findOut(d, q);
      expect(r.stdout).toBe(want);
      if (want === "") {
        expect(r.code).toBe(1);
        expect(r.stderr).toBe("passh: no entry matches " + escapeMultiline(goQuote(q)) + "\n");
      } else expect(r.code).toBe(0);
    });
  }
  test("find with a decomposed query matches nothing (known issue)", async () => {
    const r = await ref("find", "e\u0301");
    expect(findOut(d, "e\u0301")).toBe("");
    expect(r.code).toBe(1);
  });

  test("tags", async () => {
    const r = await ref("tags");
    expect(r.stdout).toBe(tagsOut(d));
  });

  for (const path of ["esc", "work/github", "rtl/\u202eevil", "café/ünï", "work", "zw/a\u200bb"]) {
    test(`show ${JSON.stringify(path)}`, async () => {
      const entry = findEntry(d, path)!;
      const r = await ref("show", path);
      expect(r.stdout).toBe(escapeMultiline(formatEntryText(entry)));
      const raw = await ref("show", "--raw", path);
      expect(raw.stdoutBytes).toEqual(te.encode(formatEntryText(entry)));
      expect(parseEntryText(raw.stdoutBytes)).toEqual({ ...emptyContent(), password: entry.password, username: entry.username, url: entry.url, tags: entry.tags, fields: entry.fields.map((f) => F(f.key, f.value)), notes: entry.notes });
    });
  }

  for (const field of ["password", "username", "url", "tags", "notes", "otp", "pin", "nope", ""]) {
    test(`show esc --field ${JSON.stringify(field)} (pipe and terminal)`, async () => {
      const entry = findEntry(d, "esc")!;
      const want = fieldValue(entry, field);
      const r = await ref("show", "esc", "--field", field);
      if (want === undefined) {
        expect(r.code).toBe(1);
        expect(r.stderr).toBe(`passh: esc has no field ${escapeMultiline(goQuote(field))}\n`);
        return;
      }
      expect(r.stdoutBytes).toEqual(te.encode(want));
      // on a terminal: escaped (multi-line), then a newline
      const p = spawnPty([REF_BIN, "show", "esc", "--field", field], e.env);
      const out = await p.wait();
      expect(out.code).toBe(0);
      expect(out.output.replaceAll("\r\n", "\n")).toBe(escapeMultiline(want) + "\n");
    });
  }
});

// ---------------------------------------------------------------------------

describe("c. passh-go changes our data: the same bytes as our operations", () => {
  /** Runs a reference command that saves, then rebuilds the expected data with `op`. */
  async function compare(args: string[], op: (d: VaultData, now: number) => VaultData): Promise<void> {
    const before = writeData(trickyData());
    const r = await ref(...args);
    expect(r.code).toBe(0);
    const plain = plaintext();
    const after = parseVaultData(plain);
    const now = after.savedAt;
    const want = prepareSave(op(before, now), before.revision, now);
    expect(td.decode(serializeVaultData(want))).toBe(td.decode(plain));
  }

  test("tag --add --remove (unknown keys of the entry and its fields kept)", async () => {
    await compare(["tag", "work/github", "--add", "new", "--add", "2fa", "--remove", "work"], (d, now) => editTags(d, "work/github", ["new", "2fa"], ["work"], { now }).data);
  });
  test("mv", async () => {
    await compare(["mv", "work/github", "archive/"], (d, now) => moveEntry(d, "work/github", "archive/github", { now }).data);
  });
  test("rm (a tombstone appended; the entry's unknown keys go)", async () => {
    await compare(["rm", "-f", "work/github"], (d, now) => removeEntry(d, "work/github", { now }).data);
  });
  test("generate --force changes only the password", async () => {
    const before = writeData(trickyData());
    expect((await ref("generate", "work/github", "--force")).code).toBe(0);
    const plain = plaintext();
    const after = parseVaultData(plain);
    const pw = findEntry(after, "work/github")!.password;
    expect(pw).toMatch(/^[A-Za-z0-9]{24}$/);
    const want = prepareSave(setPassword(before, "work/github", pw, { now: after.savedAt }).data, before.revision, after.savedAt);
    expect(td.decode(serializeVaultData(want))).toBe(td.decode(plain));
  });
  test("tag with identical tags saves nothing", async () => {
    const before = writeData(trickyData());
    const r = await ref("tag", "work/github", "--add", "2fa");
    expect(r.stderr).toBe("work/github: tags work, 2fa (unchanged)\n");
    expect(editTags(before, "work/github", ["2fa"], []).changed).toBe(false);
    expect(parseVaultData(plaintext()).revision).toBe(before.revision);
  });
});

// ---------------------------------------------------------------------------

describe("d. data errors agree with passh-go", () => {
  const base = (o: Record<string, unknown>) => JSON.stringify({ format: "passh-vault-data", version: 1, vault_id: "v", revision: 1, entries: [], deleted: [], ...o });
  const E = (o: Record<string, unknown>) => ({ id: "i1", path: "p", ...o });
  const cases: Array<[string, string]> = [
    ["format", base({ format: "x" })],
    ["array", "[]"],
    ["null", "null"],
    ["version 0", base({ version: 0 })],
    ["version 1E0", base({}).replace('"version":1', '"version":1E0')],
    ["vault_id null", base({ vault_id: null })],
    ["revision -0", base({}).replace('"revision":1', '"revision":-0')],
    ["saved_at", base({ saved_at: "2026-02-29T00:00:00Z" })],
    ["entries [null]", base({ entries: [null] })],
    ["path", base({ entries: [E({ path: "a/../b" })] })],
    ["tags", base({ entries: [E({ tags: ["a", 5] })] })],
    ["tag comma", base({ entries: [E({ tags: [" a,b "] })] })],
    ["field key", base({ entries: [E({ fields: [{ key: "Tag\u017f", value: "" }] })] })],
    ["field value", base({ entries: [E({ fields: [{ key: "pin", value: "1\r" }] })] })],
    ["dup path", base({ entries: [E({ path: "caf\u00e9" }), E({ id: "i2", path: "cafe\u0301" })] })],
    ["tombstone", base({ deleted: [{ deleted_at: null }] })],
    ["syntax", base({}) + "x"],
    ["escape", base({}).replace('"vault_id":"v"', '"vault_id":"\\x"')],
  ];
  for (const [name, json] of cases) {
    test(name, async () => {
      writeRaw(json);
      const r = await ref("ls");
      expect(r.code).toBe(1);
      let ours = "";
      try {
        parseVaultData(te.encode(json));
      } catch (x) {
        ours = (x as Error).message;
      }
      const line = r.stderr.split("\n")[0]!;
      expect(line).toBe(`passh: ${escapeMultiline(e.vault)}: data is damaged; restore a backup (${escapeMultiline(ours)})`);
    });
  }
  test("newer data", async () => {
    writeRaw(base({ version: 2 }));
    const r = await ref("ls");
    expect(r.stderr).toBe(`passh: ${e.vault}: made by a newer passh; upgrade passh (data version)\n`);
  });
});
