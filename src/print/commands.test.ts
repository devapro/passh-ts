// `passh print` and `passh recovery-key print` (print.md §1, cli.md §2.17, §2.24): the order
// of checks, confirmation and unlock, and the output rules, with fake dependencies.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, type IsolatedEnv } from "../../test/helpers/env.ts";
import { defaultConfig, type Config } from "../config/config.ts";
import { errorf } from "../i18n/index.ts";
import { exitCodeOf } from "../errors.ts";
import type { Entry } from "../model/types.ts";
import { runPrint, runRecoveryKeyPrint, type PrintDeps, type PrintFlags, type PrintTty } from "./commands.ts";
import { onTmpfs, shellQuote, writeNewOutput } from "./output.ts";

let env: IsolatedEnv;
beforeAll(() => {
  env = isolatedEnv("printcmd");
});
afterAll(() => env.cleanup());

const KEY = "AGE-SECRET-KEY-1QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7LQPZRY9X8GF2TVDW0S3JN54KHCE";

function entry(path: string, o: Partial<Entry> = {}): Entry {
  return { id: path, path, password: "pw", username: "", url: "", tags: [], fields: [], notes: "", createdAt: 0, updatedAt: 0, unknown: new Map(), ...o };
}

interface Harness {
  deps: PrintDeps;
  log: string[];
  stdout: Uint8Array[];
}

function harness(o: { tty?: boolean; stdoutTerminal?: boolean; confirm?: (p: string) => Promise<void>; config?: () => Config } = {}): Harness {
  const log: string[] = [];
  const stdout: Uint8Array[] = [];
  const tty: PrintTty = {
    say: (t) => log.push("tty: " + t),
    confirm: async (p) => {
      log.push("confirm: " + p);
      if (o.confirm) await o.confirm(p);
    },
    print: () => {},
    writeRaw: () => {},
    enterRawMode: () => {},
    restoreMode: () => {},
    reader: () => ({ read: async () => null, close: () => {} }),
  };
  const deps: PrintDeps = {
    loadConfig: o.config ?? (() => (log.push("config"), defaultConfig())),
    tty: () => (o.tty ? tty : null),
    stdout: { isTerminal: o.stdoutTerminal ?? false, write: (d) => void stdout.push(d) },
    status: (t) => log.push("status: " + t),
    note: (t) => log.push("note: " + t),
    warn: (t) => log.push("warn: " + t),
    clipboard: () => ({ copy: async () => "none", settle: async () => {} }),
    env: env.env,
    cwd: env.home,
    now: () => new Date(2026, 10, 15, 14, 3),
  };
  return { deps, log, stdout };
}

const flags = (f: Partial<PrintFlags> = {}): PrintFlags => ({ web: false, confirmPlaintext: false, tags: [], ...f });

async function fails(p: Promise<unknown>): Promise<{ message: string; code: number }> {
  try {
    await p;
  } catch (e) {
    return { message: (e as Error).message, code: exitCodeOf(e) };
  }
  throw new Error("did not fail");
}

describe("print: order of checks (print.md §1.1)", () => {
  const open = async () => [entry("a/b")];

  test("1–3: usage errors first", async () => {
    const h = harness();
    expect(await fails(runPrint(flags({ format: "pdf", web: true, output: "x", folder: "../x" }), h.deps, open))).toEqual({
      message: "PDF output was removed; use --web to print from a browser (it can save as PDF), or omit --format for the text sheet",
      code: 2,
    });
    expect(await fails(runPrint(flags({ web: true, output: "x" }), h.deps, open))).toEqual({ message: "--output can't be used with --web", code: 2 });
    expect(await fails(runPrint(flags({ web: true, confirmPlaintext: true }), h.deps, open))).toEqual({ message: "--confirm-plaintext can't be used with --web: the print page needs a terminal", code: 2 });
    expect(h.log).toEqual([]);
  });

  test("4–6: folder, then tags, then fields; then the config", async () => {
    const h = harness();
    expect(await fails(runPrint(flags({ folder: "../x", tags: [" "], fields: "a b" }), h.deps, open))).toEqual({ message: 'invalid folder: it has a "." or ".." segment', code: 1 });
    expect(await fails(runPrint(flags({ tags: [" "], fields: "a b" }), h.deps, open))).toEqual({ message: "invalid tag: a tag can't be empty", code: 1 });
    expect(await fails(runPrint(flags({ fields: "a b" }), h.deps, open))).toEqual({ message: 'invalid field "a b": use password, username, url, tags, notes, fields, or the key of a custom field', code: 2 });
    expect(h.log).toEqual([]);
    const bad = harness({ config: () => { throw errorf("config /x: bad"); } });
    expect(await fails(runPrint(flags(), bad.deps, open))).toEqual({ message: "config /x: bad", code: 1 });
  });

  test("8: the destination is checked before the confirmation and the unlock", async () => {
    let opened = false;
    const op = async () => ((opened = true), [entry("a")]);
    writeFileSync(join(env.home, "exists.txt"), "x");
    symlinkSync("/nonexistent-target", join(env.home, "dangling"));
    const h = harness({ tty: true });
    expect(await fails(runPrint(flags({ output: "~/exists.txt" }), h.deps, op))).toEqual({ message: "~/exists.txt already exists; passh doesn't overwrite files", code: 1 });
    expect(await fails(runPrint(flags({ output: "dangling" }), h.deps, op))).toEqual({ message: "~/dangling already exists; passh doesn't overwrite files", code: 1 });
    const t = harness({ tty: true, stdoutTerminal: true });
    expect(await fails(runPrint(flags(), t.deps, op))).toEqual({ message: "refusing to write the sheet to a terminal: add -o file or redirect stdout", code: 1 });
    expect(opened).toBe(false);
    expect(h.log.filter((l) => l.startsWith("confirm"))).toEqual([]);
  });

  test("9: with a terminal the phrase is asked even with --confirm-plaintext; without one the flag is required", async () => {
    let opened = false;
    const op = async () => ((opened = true), [entry("a")]);
    const refuse = harness({ tty: true, confirm: async () => { throw errorf("not confirmed: you didn't type EXPORT PLAINTEXT"); } });
    expect(await fails(runPrint(flags({ confirmPlaintext: true }), refuse.deps, op))).toEqual({ message: "not confirmed: you didn't type EXPORT PLAINTEXT", code: 1 });
    expect(refuse.log).toEqual(["config", "tty: The sheet holds your passwords unencrypted.", "confirm: EXPORT PLAINTEXT"]);
    expect(opened).toBe(false);
    const none = harness();
    expect(await fails(runPrint(flags(), none.deps, op))).toEqual({ message: "printing needs confirmation: without a terminal, add --confirm-plaintext", code: 1 });
    expect(opened).toBe(false);
  });

  test("11: nothing to print is found after the unlock", async () => {
    const h = harness();
    expect(await fails(runPrint(flags({ confirmPlaintext: true, folder: "zzz" }), h.deps, open))).toEqual({ message: "no entries to print: none matches folder zzz", code: 1 });
  });

  test("12–13: stdout, and a file (0600) with the tmpfs warning", async () => {
    const h = harness();
    await runPrint(flags({ confirmPlaintext: true }), h.deps, open);
    expect(new TextDecoder().decode(h.stdout[0]!)).toStartWith("CONFIDENTIAL · passh password sheet");
    expect(h.log.at(-1)).toBe("note: printed 1 entry (text sheet) to stdout; print it, then delete the file");

    const f = harness({ tty: true });
    await runPrint(flags({ output: "~/sheet.txt" }), f.deps, async () => [entry("a"), entry("b")]);
    const path = join(env.home, "sheet.txt");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toStartWith("CONFIDENTIAL");
    const onShm = onTmpfs(env.home);
    expect(f.log.slice(-2)).toEqual([...(onShm ? [] : ["warn: ~/sheet.txt isn't on tmpfs: the plaintext is on persistent disk. Delete it when you're done"]), "note: printed 2 entries (text sheet) to ~/sheet.txt; print it, then delete the file"].slice(-2));
  });
});

describe("recovery-key print (cli.md §2.17)", () => {
  const open = async () => ({ key: KEY, vaultId: "v-id" });

  test("order: flags, config, destination, terminal, phrase, key", async () => {
    let opened = false;
    const op = async () => ((opened = true), { key: KEY, vaultId: "v" });
    const h = harness();
    expect(await fails(runRecoveryKeyPrint({ web: true, output: "x" }, h.deps, op))).toEqual({ message: "--output can't be used with --web", code: 2 });
    expect(await fails(runRecoveryKeyPrint({ web: false }, harness({ stdoutTerminal: true, tty: true }).deps, op))).toEqual({ message: "refusing to write the recovery key to a terminal: add -o file or redirect stdout", code: 1 });
    expect(await fails(runRecoveryKeyPrint({ web: false, output: "new.txt" }, h.deps, op))).toEqual({ message: "passh recovery-key print needs a terminal (over SSH: use `ssh -t`)", code: 1 });
    expect(await fails(runRecoveryKeyPrint({ web: true }, h.deps, op))).toEqual({ message: "the print page is off: set enabled = true in the [print_web] table of the config file", code: 1 });
    const on = harness({ config: () => ({ ...defaultConfig(), printWeb: { ...defaultConfig().printWeb, enabled: true } }) });
    expect(await fails(runRecoveryKeyPrint({ web: true }, on.deps, op))).toEqual({ message: "the print page needs a terminal (over SSH: use `ssh -t`)", code: 1 });
    expect(opened).toBe(false);
  });

  test("a file: messages and the rm hint with the absolute path, shell-quoted", async () => {
    const h = harness({ tty: true });
    await runRecoveryKeyPrint({ web: false, output: "~/my sheet's.txt" }, h.deps, open);
    const abs = join(env.home, "my sheet's.txt");
    expect(readFileSync(abs, "utf8")).toContain("AGE-SECRET-KEY-1\nQPZR Y9X8 GF2T VDW0 S3JN\n");
    expect(h.log.filter((l) => !l.startsWith("warn"))).toEqual([
      "config",
      "confirm: PRINT RECOVERY KEY",
      "status: Wrote the paper recovery key to ~/my sheet's.txt.",
      "note: print it, keep the sheet offline, then delete the file: rm " + shellQuote(abs),
    ]);
    expect(shellQuote(abs)).toBe("'" + abs.replace("'", "'\\''") + "'");
  });

  test("stdout", async () => {
    const h = harness({ tty: true });
    await runRecoveryKeyPrint({ web: false }, h.deps, open);
    expect(new TextDecoder().decode(h.stdout[0]!)).toContain("vault_id v-id");
    expect(h.log.at(-1)).toBe("status: Wrote the paper recovery key to stdout.");
  });
});

describe("output files (print.md §1.5)", () => {
  test("shell quoting", () => {
    expect(shellQuote("/tmp/a-b_c.d+e@f:g,h=i")).toBe("/tmp/a-b_c.d+e@f:g,h=i");
    expect(shellQuote("/tmp/a b")).toBe("'/tmp/a b'");
    expect(shellQuote("~/x")).toBe("'~/x'");
  });

  test("O_EXCL: never replaces a file", () => {
    const p = join(env.home, "once.txt");
    writeNewOutput(p, new TextEncoder().encode("1"), env.env);
    expect(() => writeNewOutput(p, new TextEncoder().encode("2"), env.env)).toThrow("~/once.txt already exists; passh doesn't overwrite files");
    expect(readFileSync(p, "utf8")).toBe("1");
  });

  test("a failed write removes the partial file", () => {
    if (!existsSync("/dev/full")) return;
    // /dev/full can't be created with O_EXCL; use a folder that doesn't exist instead.
    expect(() => writeNewOutput(join(env.home, "no/such/dir/x.txt"), new TextEncoder().encode("x"), env.env)).toThrow(/^open .*: no such file or directory$/);
  });

  test("tmpfs detection", () => {
    if (existsSync("/dev/shm")) expect(onTmpfs("/dev/shm")).toBe(true);
    expect(onTmpfs(env.home)).toBe(env.home.startsWith("/dev/shm"));
  });
});
