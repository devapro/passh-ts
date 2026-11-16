// Unit tests of automatic backups (storage.md §5): folder and file names, recognition,
// order, seq, rotation.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { h32 } from "../config/index.ts";
import { addEntry, emptyContent } from "../model/index.ts";
import { captureIO } from "../util/io.ts";
import { backupDirName, backupName, listAllBackups, listFolder, parseBackupName, stampDisplay, validStamp } from "./backups.ts";
import { fixture, type Fixture } from "./testdata/helpers.ts";

let f: Fixture | undefined;
afterEach(() => {
  f?.cleanup();
  f = undefined;
});

describe("names (storage.md §5.1)", () => {
  test("folder: the vault_id when it is a safe name, else id-<h32>", () => {
    expect(backupDirName("4067e724-036b-4e69-8cbc-54e0bf2a5df7")).toBe("4067e724-036b-4e69-8cbc-54e0bf2a5df7");
    expect(backupDirName("A_b-1")).toBe("A_b-1");
    expect(backupDirName("x".repeat(128))).toBe("x".repeat(128));
    expect(backupDirName("x".repeat(129))).toBe("id-" + h32("x".repeat(129)));
    expect(backupDirName("-x")).toBe("id-" + h32("-x"));
    expect(backupDirName("_x")).toBe("id-" + h32("_x"));
    expect(backupDirName("a b")).toBe("id-" + h32("a b"));
    expect(backupDirName("../x")).toBe("id-" + h32("../x"));
    expect(backupDirName("é")).toBe("id-" + h32("é"));
  });

  test("file name: seq padded to 8 digits, more when larger; revision unpadded", () => {
    expect(backupName(42n, "20261115T120031Z", 41n)).toBe("00000042-20261115T120031Z-r41.passh");
    expect(backupName(123456789n, "20261115T120031Z", 0n)).toBe("123456789-20261115T120031Z-r0.passh");
  });

  test("recognition", () => {
    expect(parseBackupName("00000042-20261115T120031Z-r41.passh")).toEqual({ seq: 42n, stamp: "20261115T120031Z", revision: 41n });
    expect(parseBackupName("1-20240229T235959Z-r18446744073709551615.passh")).toEqual({ seq: 1n, stamp: "20240229T235959Z", revision: 18446744073709551615n });
    expect(parseBackupName(`${2n ** 62n}-20261115T120031Z-r1.passh`)?.seq).toBe(2n ** 62n);
    for (const bad of [
      "00000000-20261115T120031Z-r1.passh", // seq 0
      `${2n ** 62n + 1n}-20261115T120031Z-r1.passh`,
      "1-20261115T120031Z-r18446744073709551616.passh",
      "123456789012345678901-20261115T120031Z-r1.passh",
      "1-20261315T120031Z-r1.passh", // month 13
      "1-20230229T120031Z-r1.passh", // not a leap year
      "1-20261115T240031Z-r1.passh",
      "1-20261115T126031Z-r1.passh",
      "1-20261115T120060Z-r1.passh",
      "1-20261115T120031Z-r1.passh.tmp",
      "20261115T120031Z-r41.passh", // development builds' seq-0 names: ignored
      "20261115T120031Z-r41-2.passh",
      "１-20261115T120031Z-r1.passh",
      "1-20261115t120031Z-r1.passh",
    ]) {
      expect(parseBackupName(bad)).toBeUndefined();
    }
    expect(validStamp("20000229T000000Z")).toBe(true);
    expect(validStamp("19000229T000000Z")).toBe(false);
    expect(stampDisplay("20261115T120031Z")).toBe("2026-11-15 12:00:31");
  });
});

describe("order and listing (storage.md §5.3)", () => {
  test("folders in byte order, each newest first; other files ignored", async () => {
    f = await fixture("order", { create: false });
    const root = join(f.state, "backups");
    const mk = (folder: string, names: string[]) => {
      mkdirSync(join(root, folder), { recursive: true });
      for (const n of names) writeFileSync(join(root, folder, n), "x");
    };
    mk("b", ["00000002-20200101T000000Z-r5.passh", "00000010-20100101T000000Z-r1.passh", "99999999-20261115T120031Z-r7.passh", "100000000-20000101T000000Z-r3.passh", "notes.txt", ".backup.tmp-1"]);
    mk("B", ["00000001-20261115T120031Z-r1.passh"]);
    mk("a", ["00000003-20261115T120031Z-r1.passh"]);
    mk("empty", []);
    symlinkSync(join(root, "b", "00000002-20200101T000000Z-r5.passh"), join(root, "a", "00000009-20261115T120031Z-r1.passh"));
    writeFileSync(join(root, "c-not-a-folder"), "x");
    const all = listAllBackups(f.state);
    expect(all.map((x) => x.name)).toEqual(["B", "a", "b"]);
    expect(all[2]!.backups.map((b) => b.seq)).toEqual([100000000n, 99999999n, 10n, 2n]);
    expect(all[1]!.backups.map((b) => b.name)).toEqual(["00000003-20261115T120031Z-r1.passh"]);
    expect(listFolder(join(root, "missing"), "missing")).toEqual([]);
  });
});

describe("writing and rotation (storage.md §5.2–§5.3)", () => {
  test("keep = 3: the newest three by seq stay, whatever their clock or revision", async () => {
    f = await fixture("rotate", { keep: 3 });
    let v = await f.open();
    const dir = join(f.state, "backups", v.data.vaultId);
    // a stray backup with a future clock and a high revision but a low seq goes first
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "00000001-29990101T000000Z-r999.passh"), "old");
    for (let i = 0; i < 5; i++) await v.save(addEntry(v.data, `e${i}`, { ...emptyContent(), password: "p" }).data);
    const names = readdirSync(dir).sort();
    expect(names.map((n) => n.slice(0, 8))).toEqual(["00000004", "00000005", "00000006"]);
    expect(names.map((n) => n.replace(/^\d+-\d{8}T\d{6}Z-/, ""))).toEqual(["r3.passh", "r4.passh", "r5.passh"]);
    // seq continues from the highest, even after the older ones are gone
    for (const n of names.slice(0, 2)) unlinkSync(join(dir, n));
    await v.save(addEntry(v.data, "x", { ...emptyContent(), password: "p" }).data);
    expect(readdirSync(dir).sort().map((n) => n.slice(0, 8))).toEqual(["00000006", "00000007"]);
    // every numbered backup gone: the counter restarts at 1
    for (const n of readdirSync(dir)) unlinkSync(join(dir, n));
    await v.save(addEntry(v.data, "y", { ...emptyContent(), password: "p" }).data);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(readdirSync(dir)[0]!.startsWith("00000001-")).toBe(true);
    // leftovers of `backup` are cleaned under the lock
    writeFileSync(join(dir, ".backup.tmp-77"), "x");
    await v.save(addEntry(v.data, "z", { ...emptyContent(), password: "p" }).data);
    expect(readdirSync(dir).filter((n) => n.startsWith("."))).toEqual([]);
    v.close();
    v = await f.open();
    expect(v.data.revision).toBe(9n);
    v.close();
  });

  test("a lower keep takes effect at the next save", async () => {
    f = await fixture("rotate", { keep: 5 });
    const v = await f.open();
    for (let i = 0; i < 4; i++) await v.save(addEntry(v.data, `e${i}`, { ...emptyContent(), password: "p" }).data);
    const dir = join(f.state, "backups", v.data.vaultId);
    expect(readdirSync(dir)).toHaveLength(4);
    f.config.backup.keep = 1;
    const io = captureIO();
    v.close();
    const w = await f.open({ io });
    await w.save(addEntry(w.data, "x", { ...emptyContent(), password: "p" }).data);
    expect(readdirSync(dir)).toEqual([readdirSync(dir).find((n) => n.startsWith("00000005-"))!]);
    expect(io.err).toEqual([]);
    w.close();
  });
});
