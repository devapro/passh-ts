// Side by side with the reference: `passh copy <path> [--field f]` (cli.md §2.6,
// agent-session.md §A5): a fake clipboard.command (its stdin logged) and OSC 52 on the PTY;
// the order of checks (the clipboard method before the key), signals during the wait.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, writeConfig, type IsolatedEnv } from "../helpers/env.ts";
import { makePair, PASSPHRASE, runSide, type Answer, type Pair, type RunOptions } from "./side.ts";
import { buildVault, type BuiltVault } from "./vaults.ts";

let tools: IsolatedEnv;
let BIN: string;
let vault: BuiltVault;
let pair: Pair;

beforeAll(async () => {
  tools = isolatedEnv("cptools");
  BIN = join(tools.dir, "bin");
  mkdirSync(BIN);
  // logs each call's arguments and stdin to $CLIPLOG; exits $CLIPEXIT (default 0)
  writeFileSync(join(BIN, "fakeclip"), '#!/bin/sh\n{ printf "ARGS:%s|" "$*"; cat; printf "\\n"; } >> "$CLIPLOG"\nexit ${CLIPEXIT:-0}\n');
  chmodSync(join(BIN, "fakeclip"), 0o755);
  vault = await buildVault([
    { path: "github", password: "s3cr3t-P@ss", username: "me", tags: ["a", "b"], notes: "n1\nn2", fields: [["pin", "1234"]] },
    { path: "empty/x" },
    { path: "my bank/acc", password: "p w" },
  ]);
  pair = await makePair("copy", vault.bytes);
});
afterAll(() => {
  tools?.cleanup();
  pair?.cleanup();
});

const logOf = (e: IsolatedEnv) => join(e.dir, "clip.log");
function readLog(e: IsolatedEnv): string {
  const f = logOf(e);
  const s = existsSync(f) ? readFileSync(f, "utf8") : "";
  rmSync(f, { force: true });
  return s;
}

async function withConfig(extra: string) {
  for (const e of [pair.ref, pair.ours]) await writeConfig(e, extra);
}

async function same(args: string[], o: RunOptions = {}) {
  const env = { PATH: `${BIN}:${pair.ref.env.PATH}`, ...(o.env ?? {}) };
  const ref = await runSide("ref", pair.ref, args, { ...o, env: { ...env, CLIPLOG: logOf(pair.ref) } });
  const refLog = readLog(pair.ref);
  const ours = await runSide("ours", pair.ours, args, { ...o, env: { ...env, CLIPLOG: logOf(pair.ours) } });
  const oursLog = readLog(pair.ours);
  expect(ours).toEqual(ref);
  return { ref, refLog, oursLog };
}

describe("copy with clipboard.command", () => {
  test("password, other fields, the clear; a failing command; a missing program", async () => {
    await withConfig('[clipboard]\nclear_after = "1s"\ncommand = ["fakeclip", "-x", "a b"]\n');
    for (const args of [["copy", "github"], ["copy", "github", "--field", "notes"], ["copy", "github", "--field", "tags"], ["copy", "github", "--field", "pin"], ["copy", "my bank/acc"]]) {
      const r = await same(args, { pty: true });
      expect(r.ref.code).toBe(0);
    }
    // without a terminal: the command works through... nothing (no agent): vault is locked, after the method
    await same(["copy", "github"]);
    await same(["copy", "github"], { pty: true, env: { CLIPEXIT: "4" } });
    await withConfig('[clipboard]\nclear_after = "1s"\ncommand = ["nonexistent-clip"]\n');
    await same(["copy", "github"], { pty: true });
  }, 120_000);

  test("the logs: value on stdin, then the empty clear", async () => {
    await withConfig('[clipboard]\nclear_after = "1s"\ncommand = ["fakeclip"]\n');
    const r = await same(["copy", "github", "--field", "username"], { pty: true });
    expect(r.oursLog).toBe(r.refLog);
    expect(r.refLog).toBe("ARGS:|me\nARGS:|\n");
  }, 60_000);

  test("errors after the key: empty value, no such field, folder, not found", async () => {
    await withConfig('[clipboard]\nclear_after = "1s"\ncommand = ["fakeclip"]\n');
    for (const args of [["copy", "empty/x"], ["copy", "github", "--field", "url"], ["copy", "github", "--field", "nope"], ["copy", "github", "--field", ""], ["copy", "empty"], ["copy", "nope"]]) await same(args, { pty: true });
  }, 120_000);

  test("SIGINT, SIGTERM, SIGHUP during the wait clear at once, exit 0", async () => {
    await withConfig('[clipboard]\nclear_after = "30s"\ncommand = ["fakeclip"]\n');
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const kill: Answer = async (p, e) => {
        // the copy has happened once the fake command logged it
        for (let i = 0; i < 200 && !(existsSync(logOf(e)) && readFileSync(logOf(e), "utf8").length > 0); i++) await Bun.sleep(50);
        await Bun.sleep(200);
        p.kill(sig);
      };
      const r = await same(["copy", "github"], { pty: true, answers: [PASSPHRASE, kill] });
      expect(r.ref.code).toBe(0);
      expect(r.oursLog).toBe(r.refLog);
    }
  }, 120_000);
});

describe("copy with OSC 52", () => {
  test("the sequence on the terminal, the clear; Ctrl-C clears now", async () => {
    await withConfig('[clipboard]\nclear_after = "1s"\n');
    await same(["copy", "github"], { pty: true });
    await withConfig('[clipboard]\nclear_after = "1h30m"\n');
    // the status line goes to stderr (a file here); the terminal shows the OSC 52 sequence
    const ctrlC: Answer = async (p) => {
      await p.expect("\x07");
      await Bun.sleep(300);
      p.send("\x03");
    };
    await same(["copy", "github", "--field", "pin"], { pty: true, answers: [PASSPHRASE, ctrlC] });
  }, 60_000);

  test("no clipboard: before the passphrase, with the hint (quoted path, field)", async () => {
    await withConfig("");
    for (const args of [["copy", "github"], ["copy", "my bank/acc", "--field", "user name"], ["copy", "github", "--field", ""], ["copy", "a//"]]) await same(args);
    await withConfig("[clipboard]\nosc52 = false\n");
    await same(["copy", "github"], { pty: true, answers: [] });
    await same(["copy", "github"]);
    for (const e of [pair.ref, pair.ours]) rmSync(e.vault + ".x", { force: true });
    await same(["copy", "github", "--vault", "/nonexistent/v.passh"]);
  }, 60_000);
});
