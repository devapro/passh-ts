// Side by side with the reference: `passh print` and `passh recovery-key print` (cli.md §2.17,
// §2.24, print.md §1) to stdout and to -o files, their checks in order, the typed
// confirmations on a terminal (`EXPORT PLAINTEXT`, `PRINT RECOVERY KEY`, `PRINT`) and the
// refusals (a terminal stdout, a missing confirmation, the print page off or without a
// terminal). The sheets carry the print time: dates are normalized.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IsolatedEnv } from "../helpers/env.ts";
import { bothMore, killAgentsUnder, makePair, PASSPHRASE_STEP, visible, type MoreRunOptions, type Pair, type Step } from "./side_more.ts";
import { buildVault, type BuiltVault } from "./vaults.ts";

setDefaultTimeout(120_000);

let vault: BuiltVault;
let empty: BuiltVault;
const pairs: Pair[] = [];

beforeAll(async () => {
  vault = await buildVault([
    { path: "mail", password: "Il1O0", username: "me@example.com", tags: ["home"] },
    { path: "work/github", password: "pw1", username: "alice", url: "https://github.com", tags: ["dev", "work"], fields: [["pin", "1234"]], notes: "n1\nn2" },
    { path: "work/gitlab", password: "x\x1by", tags: ["work"] },
  ]);
  empty = await buildVault([]);
});

afterAll(() => {
  for (const p of pairs) {
    killAgentsUnder(p.ref.dir);
    killAgentsUnder(p.ours.dir);
    p.cleanup();
  }
});

async function newPair(setup?: (e: IsolatedEnv) => void, extra = "", bytes = vault.bytes): Promise<Pair> {
  const p = await makePair("prt", bytes, extra);
  pairs.push(p);
  for (const e of [p.ref, p.ours]) setup?.(e);
  return p;
}

/** Print times (`YYYY-MM-DD HH:MM`, also in the recovery sheet) and dates. */
const DATES: Array<[RegExp, string]> = [[/\d{4}-\d{2}-\d{2}( \d{2}:\d{2}( UTC)?)?/g, "<DATE>"]];

async function same(p: Pair, args: string[], o: MoreRunOptions = {}) {
  const r = await bothMore(p, args, { ...o, replace: [...DATES, ...(o.replace ?? [])] });
  expect(visible(r.ours)).toEqual(visible(r.ref));
  return r;
}

const PRINT_STEPS: Step[] = [["Type EXPORT PLAINTEXT to confirm: ", "EXPORT PLAINTEXT"], PASSPHRASE_STEP];
const RK_STEPS: Step[] = [["Type PRINT RECOVERY KEY to confirm: ", "PRINT RECOVERY KEY"], PASSPHRASE_STEP];

function fileText(e: IsolatedEnv, name: string): string {
  let t = readFileSync(join(e.home, name), "utf8");
  for (const [re, to] of DATES) t = t.replace(re, to);
  return t;
}

describe("print (text sheet)", () => {
  test("to stdout: all entries, a folder, tags, fields", async () => {
    const p = await newPair();
    for (const extra of [[], ["--folder", "work"], ["--tag", "work"], ["--tag", "dev,work"], ["--fields", "password,username,url,tags,notes,fields"], ["--fields", "pin"], ["--fields", "password", "--tag", "home"]]) {
      const r = await same(p, ["print", ...extra], { pty: true, steps: PRINT_STEPS });
      expect(r.ref.code).toBe(0);
    }
  });

  test("to a new file (-o), mode 0600, the tmpfs warning; then refused", async () => {
    const p = await newPair();
    const r = await same(p, ["print", "-o", "~/sheet.txt"], { pty: true, steps: PRINT_STEPS });
    expect(r.ref.stderr).toContain("isn't on tmpfs");
    expect(r.ref.stderr).toContain("passh: printed 3 entries (text sheet) to ~/sheet.txt; print it, then delete the file\n");
    expect(fileText(p.ours, "sheet.txt")).toBe(fileText(p.ref, "sheet.txt"));
    expect(statSync(join(p.ours.home, "sheet.txt")).mode & 0o777).toBe(0o600);
    await same(p, ["print", "-o", "~/sheet.txt"], { pty: true, steps: PRINT_STEPS });
  });

  test("nothing matches; no entries; an unknown custom field", async () => {
    const p = await newPair();
    await same(p, ["print", "--folder", "nope"], { pty: true, steps: PRINT_STEPS });
    await same(p, ["print", "--tag", "a", "--tag", "b", "--folder", "work"], { pty: true, steps: PRINT_STEPS });
    await same(p, ["print", "--fields", "nosuch"], { pty: true, steps: PRINT_STEPS });
    const q = await newPair(undefined, "", empty.bytes);
    await same(q, ["print"], { pty: true, steps: PRINT_STEPS });
  });

  test("checks in order, without a terminal", async () => {
    const p = await newPair((e) => writeFileSync(join(e.home, "exists"), "x"));
    const cases: string[][] = [
      ["print", "--format", "pdf"],
      ["print", "--web", "-o", "x"],
      ["print", "--web", "--confirm-plaintext"],
      ["print", "--folder", "a/../b"],
      ["print", "--tag", "x\x01"],
      ["print", "--fields", "a b"],
      ["print", "--fields", ""],
      ["print", "-o", "~/exists"],
      ["print"],
      ["print", "--confirm-plaintext"],
      ["print", "--web"],
      ["print", "extra"],
    ];
    for (const c of cases) await same(p, c);
  });

  test("a terminal on stdout; a wrong phrase; Ctrl-D at the phrase", async () => {
    const p = await newPair();
    await same(p, ["print"], { pty: true, stdoutOnTty: true });
    await same(p, ["print"], { pty: true, steps: [["confirm: ", "PRINT"]] });
    await same(p, ["print"], { pty: true, steps: [["confirm: ", "\x04", "raw"]] });
  });

  test("--web: the print page off; on, but no terminal; a wrong PRINT", async () => {
    const p = await newPair();
    await same(p, ["print", "--web"], { pty: true });
    const q = await newPair(undefined, "[print_web]\nenabled = true\n");
    await same(q, ["print", "--web"]);
    await same(q, ["print", "--web"], { pty: true, steps: [["Type PRINT to confirm: ", "print"]] });
  });

  test("config errors come at step 7, the vault at the key", async () => {
    const p = await newPair();
    for (const e of [p.ref, p.ours]) writeFileSync(e.configFile, "bogus = 1\n");
    await same(p, ["print"]);
    await same(p, ["print", "--fields", "a b"]);
    await same(p, ["--vault", "~/none.passh", "print", "--confirm-plaintext"]);
  });
});

describe("recovery-key print", () => {
  test("to a new file, then refused; to stdout", async () => {
    const p = await newPair();
    const r = await same(p, ["recovery-key", "print", "-o", "~/rk.txt"], { pty: true, steps: RK_STEPS });
    expect(r.ref.code).toBe(0);
    expect(r.ref.stderr).toContain("Wrote the paper recovery key to ~/rk.txt.\n");
    expect(r.ref.stderr).toContain("passh: print it, keep the sheet offline, then delete the file: rm <ENV>/home/rk.txt\n");
    expect(fileText(p.ours, "rk.txt")).toBe(fileText(p.ref, "rk.txt"));
    expect(fileText(p.ref, "rk.txt")).toContain(vault.data.vaultId);
    await same(p, ["recovery-key", "print", "-o", "~/rk.txt"], { pty: true, steps: RK_STEPS });
    const s = await same(p, ["recovery-key", "print"], { pty: true, steps: RK_STEPS });
    expect(s.ref.stderr).toBe("Wrote the paper recovery key to stdout.\n");
  });

  test("a path that needs quoting in the rm hint", async () => {
    const p = await newPair();
    await same(p, ["recovery-key", "print", "-o", "~/my key's sheet.txt"], { pty: true, steps: RK_STEPS });
  });

  test("checks and refusals", async () => {
    const p = await newPair((e) => writeFileSync(join(e.home, "exists"), "x"));
    for (const c of [
      ["recovery-key"],
      ["recovery-key", "x"],
      ["recovery-key", "print", "--format", "pdf"],
      ["recovery-key", "print", "--web", "-o", "x"],
      ["recovery-key", "print", "-o", "~/exists"],
      ["recovery-key", "print"],
      ["recovery-key", "print", "-o", "~/new.txt"],
      ["recovery-key", "print", "--web"],
      ["recovery-key", "print", "extra"],
    ])
      await same(p, c);
    await same(p, ["recovery-key", "print"], { pty: true, stdoutOnTty: true });
    await same(p, ["recovery-key", "print", "-o", "~/new.txt"], { pty: true, steps: [["confirm: ", "print recovery key"]] });
    await same(p, ["recovery-key", "print", "-o", "~/new.txt"], { pty: true, steps: [["confirm: ", "\x04", "raw"]] });
    await same(p, ["recovery-key", "print", "--web"], { pty: true });
  });

  test("--web on, no terminal; a wrong phrase", async () => {
    const p = await newPair(undefined, "[print_web]\nenabled = true\n");
    await same(p, ["recovery-key", "print", "--web"]);
    await same(p, ["recovery-key", "print", "--web"], { pty: true, steps: [["Type PRINT RECOVERY KEY to confirm: ", "PRINT"]] });
  });

  test("the agent's key counts (the phrase still needs the terminal)", async () => {
    const p = await newPair();
    try {
      await same(p, ["unlock"], { pty: true, steps: [PASSPHRASE_STEP] });
      const r = await same(p, ["recovery-key", "print", "-o", "~/rk2.txt"], { pty: true, steps: [["Type PRINT RECOVERY KEY to confirm: ", "PRINT RECOVERY KEY"]] });
      expect(r.ref.code).toBe(0);
      expect(fileText(p.ours, "rk2.txt")).toBe(fileText(p.ref, "rk2.txt"));
      await same(p, ["print", "--confirm-plaintext"]);
    } finally {
      await same(p, ["lock"]);
    }
  });
});
