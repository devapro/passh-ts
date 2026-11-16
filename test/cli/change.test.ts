// Side by side with the reference: the commands that change entries: `generate` (import-export.md
// §3.3), `mv` (cli.md §2.10), `rm` (§2.11), `tag` (§2.12) and `add` (§2.7). After each run, the
// vaults both sides saved are decrypted and compared (times and generated passwords blanked),
// and each side's vault is opened by the other implementation.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { VaultData } from "../../src/model/index.ts";
import { both, makePair, PASSPHRASE, runSide, type Answer, type Pair } from "./side.ts";
import { buildVault, readVault, type BuiltVault } from "./vaults.ts";

let vault: BuiltVault;
const pairs: Pair[] = [];

beforeAll(async () => {
  vault = await buildVault([
    { path: "github", tags: ["gh", "b"], password: "pw", username: "me", fields: [["k", "v"]], notes: "n" },
    { path: "work/a", tags: ["x"] },
    { path: "work/b/c" },
    { path: "m/b/x" },
    { path: "m/b/b/x" },
    { path: "my bank/x y", password: "p" },
    { path: "one/x" },
  ]);
});
afterAll(() => {
  for (const p of pairs) p.cleanup();
});

async function fresh(name: string): Promise<Pair> {
  const p = await makePair(name, vault.bytes);
  pairs.push(p);
  return p;
}

function blank(d: VaultData, passwords: boolean): VaultData {
  d.savedAt = 0;
  for (const e of d.entries) {
    e.updatedAt = 0;
    if (passwords) e.password = e.password.length > 0 ? `<${e.password.length}>` : "";
  }
  for (const t of d.deleted) t.deletedAt = 0;
  // new entries get random ids and times on each side
  for (const e of d.entries) {
    if (vault.data.entries.some((x) => x.id === e.id)) continue;
    e.id = "<new>";
    e.createdAt = 0;
  }
  return d;
}

/** Both sides saved the same data; each opens in the other implementation. */
async function sameVaults(p: Pair, passwords = false) {
  const r = blank(readVault(p.ref.vault, vault.identity), passwords);
  const o = blank(readVault(p.ours.vault, vault.identity), passwords);
  expect(o).toEqual(r);
}

/** Opens each side's vault with the other implementation (`ls`). */
async function crossOpen(p: Pair) {
  const a = await runSide("ours", p.ref, ["ls"], { pty: true });
  const b = await runSide("ref", p.ours, ["ls"], { pty: true });
  expect(a.code).toBe(0);
  expect(b.code).toBe(0);
  expect(b.stdout).toBe(a.stdout);
}

async function same(p: Pair, args: string[], o: Parameters<typeof both>[2] = { pty: true }) {
  const r = await both(p, args, o);
  expect(r.ours).toEqual(r.ref);
  return r.ref;
}

describe("generate", () => {
  test("new, existing, --force, --symbols, lengths, quoting", async () => {
    const p = await fresh("gen");
    for (const args of [
      ["generate", "new", "10", "--symbols"],
      ["generate", "github"],
      ["generate", "github", "-f", "007"],
      ["generate", "my bank/it's"],
      ["generate", "x", "+5"],
      ["generate", "work"],
      ["generate", "café/ü"],
      ["generate", "-fv"],
    ]) await same(p, args);
    await sameVaults(p, true);
    await crossOpen(p);
  }, 120_000);

  test("argument errors before the key", async () => {
    const p = await fresh("generr");
    for (const args of [["generate", "x", "0"], ["generate", "x", "4097"], ["generate", "x", "abc"], ["generate", "x", "1.5"], ["generate", "x", ""], ["generate", "a//", "0"], ["generate", "x", "-5"], ["generate", "x", "--", "-5"], ["generate"], ["generate", "a", "1", "2"]]) await same(p, args, {});
    await same(p, ["generate", "x"], {});
  }, 60_000);
});

describe("mv", () => {
  test("entries and folders", async () => {
    const p = await fresh("mv");
    for (const args of [
      ["mv", "work/a", "work/z"],
      ["mv", "work/z", "work/z"],
      ["mv", "work", "work/sub"],
      ["mv", "work", "work"],
      ["mv", "work", "work/"],
      ["mv", "one", "two"],
      ["mv", "m/b", "m"],
      ["mv", "nope", "x"],
      ["mv", "my bank", "bank"],
      ["mv", "github", "new"],
      ["mv", "github", "bank/"],
      ["mv", "work", "archive/"],
      ["mv", "m/b/x", "m/b/x/"],
      ["mv", "bank/github", "bank/x y"],
    ]) await same(p, args);
    await sameVaults(p);
    await crossOpen(p);
  }, 180_000);

  test("argument errors before the key", async () => {
    const p = await fresh("mverr");
    for (const args of [["mv", "work/", "x"], ["mv", "a", "/"], ["mv", "a", "a//"], ["mv", "a", "/b"], ["mv", "a", "-b"], ["mv", "a"], ["mv", "a", "b", "c"]]) await same(p, args, {});
  }, 60_000);
});

describe("rm", () => {
  test("answers: empty, unclear ×3, end of input, Ctrl-C, SIGTERM, yes; --force; folders; missing", async () => {
    const p = await fresh("rm");
    const q = "[y/N] ";
    for (const answers of [
      [PASSPHRASE, [q, ""]],
      [PASSPHRASE, [q, "n"]],
      [PASSPHRASE, [q, "maybe"], [q, "x"], [q, "z"]],
      [PASSPHRASE, [q, "\x04", "raw"]],
      [PASSPHRASE, [q, "\x03", "raw"]],
      [PASSPHRASE, async (pp) => { await pp.expect(q); await Bun.sleep(150); pp.kill("SIGTERM"); }],
      [PASSPHRASE, [q, "  YES "]],
    ] as Answer[][]) await same(p, ["rm", "github"], { pty: true, answers });
    await same(p, ["rm", "work"]);
    await same(p, ["rm", "nope"]);
    await same(p, ["rm", "-f", "work/a"]);
    await same(p, ["rm", "--force", "one/x"], {});
    await same(p, ["rm", "one/x"], {});
    await same(p, ["rm", "a//"], {});
    await sameVaults(p);
    await crossOpen(p);
  }, 180_000);
});

describe("tag", () => {
  test("add, remove, unchanged, errors", async () => {
    const p = await fresh("tag");
    for (const args of [
      ["tag", "work/b/c", "--add", "a,b", "--add", "a", "--remove", "x"],
      ["tag", "work/b/c", "--add", "a"],
      ["tag", "work/b/c", "--remove", "a,b"],
      ["tag", "work/b/c", "--remove", "a"],
      ["tag", "work/b/c", "--add", "x", "--remove", "x"],
      ["tag", "work/b/c", "--add", ","],
      ["tag", "work/b/c", "--add", " ok ", "--remove", ","],
      ["tag", "work", "--add", "q"],
      ["tag", "nope", "--add", "q"],
      ["tag", "nope", "--add", ","],
      ["tag", "work", "--add", ","],
      ["tag", "work/b/c", "--add", "a\x01"],
      ["tag", "work/b/c", "--add", "Ü̈x", "--add", "é"],
      ["tag", "github", "--remove", "gh", "--add", "gh"],
    ]) await same(p, args);
    for (const args of [["tag", "work/b/c", "--remove", ""], ["tag", "a//"], ["tag", "x"], ["tag", "a//", "--add", "x"], ["tag", "x", "--add", '"a']]) await same(p, args, {});
    await sameVaults(p);
    await crossOpen(p);
  }, 180_000);
});

describe("add", () => {
  const PW = "Password (empty to generate): ";
  const RP = "Repeat password: ";
  const prompts = (pw: string, user: string, url: string, tags: string, notes: string[]): Answer[] => [
    PASSPHRASE,
    [PW, pw],
    ...(pw === "" ? [] : ([[RP, pw]] as Answer[])),
    ["Username: ", user],
    ["URL: ", url],
    ["Tags (comma-separated): ", tags],
    ["(end with an empty line):", notes[0] ?? ""],
    ...notes.slice(1).map((n): Answer => [/\n/, n]),
  ];

  test("typed, generated, existing, --force identical and different", async () => {
    const p = await fresh("add");
    await same(p, ["add", "new/one"], { pty: true, answers: prompts("abc", "me", "https://x", "a, b,a", ["n1", ""]) });
    await same(p, ["add", "gen"], { pty: true, answers: prompts("", "", "", "", [""]) });
    await same(p, ["add", "github"]);
    await same(p, ["add", "-f", "github"], { pty: true, answers: prompts("pw", "me", "", "gh, b", ["n", ""]) });
    await same(p, ["add", "--force", "github"], { pty: true, answers: prompts("pw2", "me", "", "gh", [""]) });
    await same(p, ["add", "work"], { pty: true, answers: prompts("w", "", "", "", [""]) });
    await sameVaults(p, true);
    await crossOpen(p);
  }, 180_000);

  test("mismatches, invalid tags ×3 and then valid, end of input, Ctrl-C", async () => {
    const p = await fresh("adderr");
    await same(p, ["add", "bad"], { pty: true, answers: [PASSPHRASE, [PW, "a"], [RP, "b"], [PW, "a"], [RP, "b"], [PW, "a"], [RP, "b"]] });
    await same(p, ["add", "bad"], { pty: true, answers: [PASSPHRASE, [PW, "a"], [RP, "b"], [PW, "c"], [RP, "c"], ["Username: ", "\x04", "raw"], ["URL: ", "\x04", "raw"], ["(comma-separated): ", "\x04", "raw"], ["empty line):", "\x04", "raw"]] });
    const tq = "Tags (comma-separated): ";
    await same(p, ["add", "t3"], { pty: true, answers: [PASSPHRASE, [PW, "a"], [RP, "a"], ["Username: ", ""], ["URL: ", ""], [tq, "a\x01b"], [tq, "x,\x01"], [tq, "\x01"]] });
    await same(p, ["add", "t2"], { pty: true, answers: [PASSPHRASE, [PW, "a"], [RP, "a"], ["Username: ", ""], ["URL: ", ""], [tq, "a\x01b"], [tq, '"x,y"'], ["empty line):", "x"], [/x\r\n/, "\x04", "raw"]] });
    await same(p, ["add", "eof"], { pty: true, answers: [PASSPHRASE, [PW, "\x04", "raw"]] });
    await same(p, ["add", "cc"], { pty: true, answers: [PASSPHRASE, [PW, "\x03", "raw"]] });
    await same(p, ["add", "cc"], { pty: true, answers: [PASSPHRASE, [PW, "a"], [RP, "a"], ["Username: ", "\x03", "raw"]] });
    await same(p, ["add", "cc"], { pty: true, answers: [PASSPHRASE, [PW, "a"], [RP, "a"], ["Username: ", ""], ["URL: ", ""], [tq, ""], ["empty line):", "\x03", "raw"]] });
    await same(p, ["add", "x"], {});
    await same(p, ["add", "a//"], {});
    // bytes that aren't UTF-8: an invalid tag list is asked again; other values fail after the prompts
    const bad: Answer = async (q) => (q as unknown as { send(x: Uint8Array): void }).send(new Uint8Array([0x61, 0xff, 0x0d]));
    const at = (prompt: string): Answer => async (q, e) => {
      await q.expect(prompt);
      await (bad as (a: typeof q, b: typeof e) => Promise<void>)(q, e);
    };
    await same(p, ["add", "u8"], { pty: true, answers: [PASSPHRASE, [PW, "a"], [RP, "a"], at("Username: "), ["URL: ", ""], [tq, ""], ["empty line):", ""]] });
    await same(p, ["add", "u9"], { pty: true, answers: [PASSPHRASE, [PW, "a"], [RP, "a"], ["Username: ", ""], ["URL: ", ""], at(tq), [tq, "ok"], ["empty line):", ""]] });
    await same(p, ["add", "u10"], { pty: true, answers: [PASSPHRASE, [PW, "a"], [RP, "a"], ["Username: ", ""], ["URL: ", ""], [tq, ""], at("empty line):"), ["\n", ""]] });
    await sameVaults(p);
  }, 180_000);
});
