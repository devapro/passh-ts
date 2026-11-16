// Side by side with the reference: the read-only entry commands `ls`, `find`, `show`, `tags`
// (cli.md §2.3–§2.5, §2.13) and the rules every key-needing command shares (cli.md §1.2, §1.5,
// §1.7, §1.8): order of checks, config and vault errors, the passphrase prompt, lenient-parse
// warnings, the damaged-key-block hint, the rollback question.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { cloneVaultData } from "../../src/model/index.ts";
import { both, makePair, PASSPHRASE, type Answer, type Pair } from "./side.ts";
import { buildVault, placeVault, rebuild, type BuiltVault } from "./vaults.ts";
import { PASS } from "../helpers/passh.ts";

const ENTRIES = [
  { path: "github", tags: ["gh", "b"], password: "p\x1b[31m", username: "u\tx", notes: "line1\nline2\x07" },
  { path: "work/github", password: "pw1", username: "me", tags: ["work", "dev"], fields: [["recovery-email", "me@x"], ["pin", "1234"], ["pin", "5678"], ["password", "shadow"]] as Array<[string, string]> },
  { path: "work/gitlab", tags: ["zz-gh", "a​b"] },
  { path: "work", password: "x" },
  { path: "bank/My Bank", tags: ["2fa"] },
  { path: "x/y" },
  { path: "work/a b'c" },
  { path: "a", tags: ["gx2", "gx1"] },
  { path: "b", tags: ["gx1", "gx2"] },
  { path: "my bank/x", url: "https://e.x/?a=1&b=2", notes: "" },
  { path: "work-old/y" },
  { path: "café", tags: ["Ünï"] },
];

let vault: BuiltVault;
let pair: Pair;
beforeAll(async () => {
  vault = await buildVault(ENTRIES);
  pair = await makePair("read", vault.bytes);
});
afterAll(() => pair?.cleanup());

const tty = { pty: true };

async function same(args: string[], o: Parameters<typeof both>[2] = {}) {
  const r = await both(pair, args, o);
  expect(r.ours).toEqual(r.ref);
  return r.ref;
}

describe("ls", () => {
  const cases: string[][] = [
    ["ls"],
    ["ls", "work"],
    ["ls", "--tag", "work"],
    ["ls", "--tag", "work,dev"],
    ["ls", "--tag", "work", "--tag", "dev"],
    ["ls", "--tag", " a "],
    ["ls", "--tag", ""],
    ["ls", "--tag", "a", "--tag", "a"],
    ["ls", "work", "--tag", "nope"],
    ["ls", "work/github", "--tag", "x"],
    ["ls", "work/github"],
    ["ls", "work", "--tag", "work"],
    ["ls", "work/github", "--tag", "dev"],
    ["ls", "nope"],
    ["ls", "my bank"],
    ["ls", "gith"],
    ["ls", "bank", "--tag", "2fa"],
    ["ls", "--tag", "Ün̈ı"],
    ["ls", "--tag", "work\nzzz"],
    ["ls", "--tag", "work,\"dev\""],
  ];
  for (const args of cases) test(args.join(" "), () => same(args, tty), 30_000);

  test("argument errors come before the key", async () => {
    for (const args of [["ls", "work/"], ["ls", "a//", "--tag", ","], ["ls", "--tag", ","], ["ls", "--tag", '"a,b"'], ["ls", "--tag", "a\x01"], ["ls", ""], ["ls", "-x"], ["ls", "a", "b"]]) {
      const r = await same(args);
      expect(r.code).not.toBe(0);
    }
  }, 30_000);

  test("without a terminal or agent: vault is locked", () => same(["ls"]), 30_000);
});

describe("find", () => {
  for (const q of ["gh", "gx", "git", "wg", "GIT", "zzzz", 'a"b', "", " ", "café", "café", "work/"]) {
    test(JSON.stringify(q), () => same(["find", q], tty), 30_000);
  }
});

describe("show", () => {
  const cases: string[][] = [
    ["show", "github"],
    ["show", "github", "--raw"],
    ["show", "--raw", "github"],
    ["show", "github", "--field", "username"],
    ["show", "github", "--field", "notes"],
    ["show", "github", "--field", "tags"],
    ["show", "github", "--field", "password"],
    ["show", "github", "--field", "url"],
    ["show", "work/github", "--field", "pin"],
    ["show", "work/github", "--field", "password"],
    ["show", "work/github", "--field", ""],
    ["show", "work/github", "--field", "Pin"],
    ["show", "work/github"],
    ["show", "work"],
    ["show", "my bank"],
    ["show", "nope"],
    ["show", "my bank/x"],
    ["show", "café"],
  ];
  for (const args of cases) test(args.join(" "), () => same(args, tty), 30_000);

  test("--field on a terminal: escaped, with a final newline", async () => {
    for (const f of ["username", "notes", "url", "tags"]) await same(["show", "github", "--field", f], { pty: true, stdoutOnTty: true });
    await same(["show", "github", "--field", "username", "--raw"], { pty: true, stdoutOnTty: true });
    await same(["show", "github"], { pty: true, stdoutOnTty: true });
  }, 60_000);

  test("path errors before the key", async () => {
    for (const args of [["show", "a//"], ["show", "/a"], ["show", "-- -x"], ["show", "--", "-x"], ["show", "a/./b"], ["show", "a\tb"], ["show", ""]]) await same(args);
  }, 30_000);
});

describe("stdout errors (cli.md §1.3)", () => {
  test("a full disk: write /dev/stdout: …, exit 1", async () => {
    for (const args of [["ls"], ["show", "github"], ["tags"], ["find", "gh"]]) await same(args, { pty: true, stdoutTo: "/dev/full" });
  }, 60_000);
});

describe("tags", () => {
  test("padding by code points of the escaped text", () => same(["tags"], tty), 30_000);
  test("no tags", async () => {
    const v = await buildVault([{ path: "a" }]);
    const p = await makePair("notags", v.bytes);
    try {
      const r = await both(p, ["tags"], tty);
      expect(r.ours).toEqual(r.ref);
      expect(r.ref.stderr).toBe("passh: no tags\n");
    } finally {
      p.cleanup();
    }
  }, 30_000);
});

describe("config, vault file and the key (cli.md §1.2, §1.5)", () => {
  test("no config file, a missing vault, a stat error", async () => {
    const p = await makePair("cfg", vault.bytes);
    try {
      for (const [args, env] of [
        [["ls"], { PASSH_CONFIG: "/nonexistent/c.toml" }],
        [["show", "x"], { PASSH_CONFIG: "" , XDG_CONFIG_HOME: "/nonexistent" }],
        [["show", "x", "--vault", "/nonexistent/v.passh"], {}],
        [["show", "x", "--vault", "~/v.passh"], {}],
        [["show", "x", "--config", "/nonexistent/c.toml"], {}],
        [["tags", "--vault", "rel/v.passh"], {}],
      ] as Array<[string[], Record<string, string>]>) {
        const r = await both(p, args, { env });
        expect(r.ours).toEqual(r.ref);
      }
      for (const e of [p.ref, p.ours]) writeFileSync(e.configFile, 'vault = "/x"\nnope = 1\n[session]\nidle_ttl = "0s"\n');
      const r = await both(p, ["ls"]);
      expect(r.ours).toEqual(r.ref);
      for (const e of [p.ref, p.ours]) chmodSync(e.dataHome + "/passh", 0o000);
      for (const e of [p.ref, p.ours]) writeFileSync(e.configFile, `vault = ${JSON.stringify(e.vault)}\n`);
      const r2 = await both(p, ["ls"]);
      for (const e of [p.ref, p.ours]) chmodSync(e.dataHome + "/passh", 0o700);
      expect(r2.ours).toEqual(r2.ref);
    } finally {
      p.cleanup();
    }
  }, 60_000);

  test("wrong passphrase three times; an empty last try", async () => {
    await same(["ls"], { pty: true, answers: [["Passphrase: ", "x"], ["Passphrase: ", "y"], ["Passphrase: ", "z"]] });
    await same(["ls"], { pty: true, answers: [["Passphrase: ", "x"], ["Passphrase: ", "y"], ["Passphrase: ", ""]] });
    await same(["ls"], { pty: true, answers: [["Passphrase: ", "x"], ["Passphrase: ", PASS]] });
    await same(["ls"], { pty: true, answers: [["Passphrase: ", "\x04", "raw"]] });
    await same(["ls"], { pty: true, answers: [["Passphrase: ", "\x03", "raw"]] });
  }, 60_000);

  test("lenient parse: warnings once per command, also before an error", async () => {
    const p = await makePair("lenient");
    try {
      const text = "hello\n" + new TextDecoder().decode(vault.bytes) + "bye\nbye\n";
      for (const e of [p.ref, p.ours]) placeVault(e.vault, new TextEncoder().encode(text));
      for (const [args, o] of [
        [["show", "github"], tty],
        [["show", "github"], { pty: true, answers: [["Passphrase: ", "a"], ["Passphrase: ", "b"], ["Passphrase: ", "c"]] }],
        [["show", "github"], {}],
        [["show", "a//"], {}],
      ] as Array<[string[], Parameters<typeof both>[2]]>) {
        const r = await both(p, args, o);
        expect(r.ours).toEqual(r.ref);
      }
    } finally {
      p.cleanup();
    }
  }, 60_000);

  test("damaged key block: the hint line; damaged data block: no hint", async () => {
    const p = await makePair("damaged");
    try {
      const lines = new TextDecoder().decode(vault.bytes).split("\n");
      const bad1 = [...lines];
      bad1[2] = "@" + bad1[2]!.slice(1);
      for (const e of [p.ref, p.ours]) placeVault(e.vault, new TextEncoder().encode(bad1.join("\n")));
      for (const o of [tty, {}]) {
        const r = await both(p, ["show", "github"], o);
        expect(r.ours).toEqual(r.ref);
        expect(r.ref.stderr).toContain("`passh recover`");
      }
      const bad2 = [...lines];
      bad2[9] = "AAAA" + bad2[9]!.slice(4);
      for (const e of [p.ref, p.ours]) placeVault(e.vault, new TextEncoder().encode(bad2.join("\n")));
      const r = await both(p, ["show", "github"], tty);
      expect(r.ours).toEqual(r.ref);
    } finally {
      p.cleanup();
    }
  }, 60_000);

  test("data block not to this key: data is damaged with the backups note", async () => {
    const other = await buildVault([{ path: "z" }]);
    const p = await makePair("notkey");
    try {
      // vault's key block with another vault's data block
      const a = new TextDecoder().decode(vault.bytes).split("-----END AGE ENCRYPTED FILE-----");
      const b = new TextDecoder().decode(other.bytes).split("-----END AGE ENCRYPTED FILE-----");
      const mixed = a[0] + "-----END AGE ENCRYPTED FILE-----" + b[1] + "-----END AGE ENCRYPTED FILE-----" + b[2];
      for (const e of [p.ref, p.ours]) placeVault(e.vault, new TextEncoder().encode(mixed));
      const r = await both(p, ["ls"], tty);
      expect(r.ours).toEqual(r.ref);
      expect(r.ref.code).toBe(1);
    } finally {
      p.cleanup();
    }
  }, 60_000);

  test("rollback question: no, empty, unclear ×3, end of input, yes; without a terminal", async () => {
    const p = await makePair("rollbk", vault.bytes);
    try {
      expect((await both(p, ["ls"], tty)).ref.code).toBe(0);
      const old = cloneVaultData(vault.data);
      old.revision = 3n;
      old.savedAt = 1_700_000_000;
      for (const e of [p.ref, p.ours]) placeVault(e.vault, rebuild(vault, old));
      const q = "[y/N] ";
      for (const answers of [
        [PASSPHRASE, [q, "n"]],
        [PASSPHRASE, [q, ""]],
        [PASSPHRASE, [q, "x"], [q, "x"], [q, "x"]],
        [PASSPHRASE, [q, "\x04", "raw"]],
        [PASSPHRASE, [q, "\x03", "raw"]],
      ] as Answer[][]) {
        const r = await both(p, ["show", "a", "--field", "tags"], { pty: true, answers });
        expect(r.ours).toEqual(r.ref);
      }
      const nt = await both(p, ["ls"]);
      expect(nt.ours).toEqual(nt.ref);
      const y = await both(p, ["show", "a", "--field", "tags"], { pty: true, answers: [PASSPHRASE, [q, "y"]] });
      expect(y.ours).toEqual(y.ref);
      const after = await both(p, ["show", "a", "--field", "tags"], tty);
      expect(after.ours).toEqual(after.ref);
      // the record each side wrote
      const rec = (s: string) => JSON.parse(s).vaults[vault.data.vaultId].revision;
      expect(rec(readFileSync(p.ours.stateHome + "/passh/revisions.json", "utf8"))).toBe(rec(readFileSync(p.ref.stateHome + "/passh/revisions.json", "utf8")));
    } finally {
      p.cleanup();
    }
  }, 120_000);
});
