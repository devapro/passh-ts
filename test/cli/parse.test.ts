// Command-line parsing, help and usage errors, side by side with the reference
// (cli.md §1.1, §1.3, §1.4). Only argument lists that end before any vault access.

import { describe, expect, test, afterAll } from "bun:test";
import { isolatedEnv, REF_BIN, TS_SRC_CMD, run } from "../helpers/env.ts";

const env = isolatedEnv("parse");
afterAll(() => env.cleanup());

const CASES: string[][] = [
  ["--help"],
  ["-h"],
  ["help"],
  ["help", "ls"],
  ["help", "lss"],
  ["help", "ls", "extra"],
  ["help", "recovery-key", "print"],
  ["help", "import"],
  ["help", "import", "pass"],
  ["help", "--help"],
  ["ls", "-h"],
  ["ls", "-h", "extra"],
  ["show", "-h", "--nope"],
  ["-h", "ls"],
  ["--raw", "show", "a"],
  ["show", "--raw=maybe", "a"],
  ["show", "--raw=", "a"],
  ["unlock", "--ttl", "5"],
  ["unlock", "--ttl"],
  ["unlock", "--ttl", "5d"],
  ["ls", "--tag", 'a"b'],
  ["ls", "--tag", '"ab'],
  ["ls", "--tag", '"a"b'],
  ["generate", "x", "-f5"],
  ["-v"],
  ["--version"],
  ["version"],
  ["version", "x"],
  ["-v", "ls"],
  ["nope"],
  ["merge", "x"],
  ["completion"],
  ["ls", "a", "b"],
  ["tags", "x"],
  ["show"],
  ["show", "a", "b"],
  ["mv", "a"],
  ["generate"],
  ["generate", "a", "b", "c"],
  ["import"],
  ["import", "foo"],
  ["import", "--help"],
  ["recovery-key"],
  ["recovery-key", "foo"],
  ["recovery-key", "print", "-h"],
  ["export", "-o"],
  ["show", "---x"],
  ["--vault"],
  ["--config"],
  ["ls", "--vault"],
  ["tag", "x", "--add"],
  ["show", "-x"],
  ["show", "-xyz"],
  ["rm", "-fz", "a"],
  ["rm", "-fh", "a"],
  ["copy", "--help"],
  ["export", "--help"],
  ["print", "--help"],
  ["unlock", "--help"],
  ["verify", "--help"],
  ["mv", "--help"],
  ["passh"],
  ["help", "help"],
  ["ls", "--tag"],
  ["ls", "--tag=", "-h"],
  ["show", "-hx"],
  ["--vault=x", "--help"],
  ["--config", "x", "help", "ls"],
];

describe("parse errors and help match the reference", () => {
  for (const args of CASES) {
    test(JSON.stringify(args), async () => {
      const [ref, ours] = await Promise.all([run([REF_BIN, ...args], env.env), run([...TS_SRC_CMD, ...args], env.env)]);
      const norm = (s: string) => s.replace(/^passh (0\.1\.0-ref|dev|[0-9][^\n]*)$/m, "passh <version>");
      expect({ code: ours.code, stdout: norm(ours.stdout), stderr: ours.stderr }).toEqual({ code: ref.code, stdout: norm(ref.stdout), stderr: ref.stderr });
    });
  }
});
