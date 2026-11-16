// Unit tests of the rollback record (storage.md §7): the format byte for byte, the lenient
// reading, updates, and the check at open (§7.4).

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorText, hasCode } from "../i18n/index.ts";
import { addEntry, emptyContent, timeFromParts, ZERO_TIME } from "../model/index.ts";
import { captureIO } from "../util/io.ts";
import { decodeRecord, encodeRecord, formatRecordTime, parseRecordTime, readRecord, updateRecord, type RecordEntry } from "./rollback.ts";
import { fixture, type Fixture } from "./testdata/helpers.ts";
import { openVault } from "./open.ts";
import { identityKeySource } from "./keysources.ts";

let f: Fixture | undefined;
afterEach(() => {
  f?.cleanup();
  f = undefined;
});

const te = new TextEncoder();
const t = (s: string) => parseRecordTime(s)!;

describe("format (storage.md §7.1)", () => {
  test("the spec's example, byte for byte", () => {
    const vaults = new Map<string, RecordEntry>([
      ["4067e724-036b-4e69-8cbc-54e0bf2a5df7", { revision: 42n, savedAt: t("2026-11-15T12:00:00Z"), seenAt: t("2026-11-15T12:00:05Z") }],
    ]);
    expect(encodeRecord(vaults)).toBe(
      '{\n  "version": 1,\n  "vaults": {\n    "4067e724-036b-4e69-8cbc-54e0bf2a5df7": {\n      "revision": 42,\n      "saved_at": "2026-11-15T12:00:00Z",\n      "seen_at": "2026-11-15T12:00:05Z"\n    }\n  }\n}\n',
    );
  });

  test("keys HTML-escaped and sorted by their UTF-8 bytes", () => {
    const e = (r: bigint): RecordEntry => ({ revision: r, savedAt: t("2026-11-15T12:00:00Z"), seenAt: { sec: ZERO_TIME, nsec: 0, offset: 0 } });
    const vaults = new Map<string, RecordEntry>([
      ['<a&>"', e(1n)],
      ["\u{1F600}", e(2n)],
      ["", e(3n)],
      ["a\\b\n\r\t\b\f\u0001\u007f  é", e(4n)],
      ["B", e(5n)],
    ]);
    const text = encodeRecord(vaults);
    const keys = [...text.matchAll(/^    (".*"): \{$/gm)].map((m) => m[1]);
    expect(keys).toEqual(['"\\u003ca\\u0026\\u003e\\""', '"B"', '"a\\\\b\\n\\r\\t\\b\\f\\u0001\u007f\\u2028\\u2029é"', '""', '"\u{1F600}"']);
    expect(text).toContain('"seen_at": "0001-01-01T00:00:00Z"');
    // read back: the decoded keys
    const r = decodeRecord(te.encode(text));
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect([...r.vaults.keys()].sort()).toEqual([...vaults.keys()].sort());
  });

  test("times are rewritten as read: fraction and offset kept", () => {
    expect(formatRecordTime(t("2026-11-15T12:00:00.250+02:00"))).toBe("2026-11-15T12:00:00.25+02:00");
    expect(formatRecordTime(t("2026-11-15T1:00:00,5-00:00"))).toBe("2026-11-15T01:00:00.5Z");
    expect(formatRecordTime(t("2026-11-15T12:00:00+01:60"))).toBe("2026-11-15T12:00:00+02:00");
    expect(formatRecordTime(t("2026-11-15T12:00:00.1234567891-05:30"))).toBe("2026-11-15T12:00:00.123456789-05:30");
    expect(formatRecordTime(t("2026-11-15T12:00:00.000Z"))).toBe("2026-11-15T12:00:00Z");
    expect(t("2026-11-15T00:30:00+02:00").sec).toBe(timeFromParts(2026, 11, 14, 22, 30, 0));
    for (const bad of ["2026-11-15 12:00:00Z", "2026-11-15T12:00:00", "2026-11-15T24:00:00Z", "2026-02-30T00:00:00Z", "2026-11-15T12:00:00+0100", "0000-01-01T00:30:00+01:00", "2026-11-15T12:00:00+24:00"]) {
      expect(parseRecordTime(bad)).toBeUndefined();
    }
  });
});

describe("reading (storage.md §7.2)", () => {
  const dec = (s: string) => decodeRecord(te.encode(s));

  test("leniency: case-insensitive names, last duplicate wins, vaults merge, null entry, extra members", () => {
    const r = dec(
      '{"VERSION": 1, "Vaults": {"zz": {"Revision": 7, "ſaved_at": "2026-11-15T12:00:00.250+02:00", "seen_at": null, "extra": [1]}, "y": {"revision": 1}, "y": {"revision": 2}}, "vaults": {"<a&>\\"": null, "a": {"revision": 3, "revision": 4}}, "other": 1}',
    );
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect([...r.vaults.keys()]).toEqual(["zz", "y", '<a&>"', "a"]);
    expect(r.vaults.get("zz")!.revision).toBe(7n);
    expect(formatRecordTime(r.vaults.get("zz")!.savedAt)).toBe("2026-11-15T12:00:00.25+02:00");
    expect(r.vaults.get("zz")!.seenAt.sec).toBe(ZERO_TIME);
    expect(r.vaults.get("y")!.revision).toBe(2n);
    expect(r.vaults.get('<a&>"')!.revision).toBe(0n);
    expect(r.vaults.get("a")!.revision).toBe(4n);
    expect(dec('{"version": 1, "vaults": null}')).toEqual({ kind: "ok", vaults: new Map() });
    expect(dec('{"version": 1}')).toEqual({ kind: "ok", vaults: new Map() });
    expect(dec('{"version": 1, "version": null}').kind).toBe("ok");
  });

  test("damaged", () => {
    for (const s of [
      "",
      "not json",
      '﻿{"version": 1}',
      '{"version": 1} x',
      "[]",
      "null",
      '"x"',
      "{}",
      '{"version": 0}',
      '{"version": null}',
      '{"version": 1.0}',
      '{"version": "1"}',
      '{"version": 1, "vaults": []}',
      '{"version": 1, "vaults": {"x": 5}}',
      '{"version": 1, "vaults": {"x": {"revision": "5"}}}',
      '{"version": 1, "vaults": {"x": {"revision": -1}}}',
      '{"version": 1, "vaults": {"x": {"revision": -0}}}',
      '{"version": 1, "vaults": {"x": {"revision": 1.5}}}',
      '{"version": 1, "vaults": {"x": {"revision": 1e2}}}',
      '{"version": 1, "vaults": {"x": {"revision": 18446744073709551616}}}',
      '{"version": 1, "vaults": {"x": {"saved_at": "yesterday"}}}',
      '{"version": 1, "vaults": {"x": {"saved_at": 5}}}',
      '{"version": 1, "vaults": {"x": {"saved_at": "2026-11-15T12:00:00+24:00"}}}',
      '{"version": 2, "vaults": {"x": {"revision": "5"}}}',
    ]) {
      expect([s, dec(s).kind]).toEqual([s, "damaged"]);
    }
  });

  test("newer", () => {
    expect(dec('{"version": 2}')).toEqual({ kind: "newer", version: 2n });
    expect(dec('{"version": 9223372036854775807, "anything": [1]}')).toEqual({ kind: "newer", version: 9223372036854775807n });
  });
});

describe("updating (storage.md §7.3)", () => {
  test("only to a higher revision unless forced; damaged replaced; newer never written", async () => {
    f = await fixture("record", { create: false });
    const path = join(f.state, "revisions.json");
    await updateRecord(f.state, { vaultId: "v", revision: 5n, savedAt: timeFromParts(2026, 11, 15, 12, 0, 0) });
    let r = readRecord(path);
    expect(r.kind === "ok" && r.vaults.get("v")!.revision).toBe(5n);
    await updateRecord(f.state, { vaultId: "v", revision: 3n, savedAt: 0 });
    r = readRecord(path);
    expect(r.kind === "ok" && r.vaults.get("v")!.revision).toBe(5n);
    await updateRecord(f.state, { vaultId: "v", revision: 3n, savedAt: 0, force: true });
    r = readRecord(path);
    expect(r.kind === "ok" && r.vaults.get("v")!.revision).toBe(3n);
    // other entries are rewritten as read
    writeFileSync(path, '{"version":1,"vaults":{"v":{"revision":3},"w":{"revision":9,"saved_at":"2026-11-15T12:00:00.250+02:00","seen_at":"2026-11-15T12:00:00Z","x":1}}}');
    await updateRecord(f.state, { vaultId: "v", revision: 4n, savedAt: timeFromParts(2026, 11, 15, 12, 0, 0) });
    const text = readFileSync(path, "utf8");
    expect(text).toContain('    "w": {\n      "revision": 9,\n      "saved_at": "2026-11-15T12:00:00.25+02:00",\n      "seen_at": "2026-11-15T12:00:00Z"\n    }\n');
    expect(readdirSync(f.state).filter((n) => n.startsWith(".revisions.json.tmp-"))).toEqual([]);
    // damaged → replaced (other vaults lost)
    writeFileSync(path, "garbage");
    await updateRecord(f.state, { vaultId: "v", revision: 1n, savedAt: 0 });
    r = readRecord(path);
    expect(r.kind === "ok" && [...r.vaults.keys()]).toEqual(["v"]);
    // newer → not written
    writeFileSync(path, '{"version": 2}');
    let err: unknown;
    try {
      await updateRecord(f.state, { vaultId: "v", revision: 9n, savedAt: 0 });
    } catch (e) {
      err = e;
    }
    expect(errorText(err)).toBe(`${path} was written by a newer passh (version 2)`);
    expect(readFileSync(path, "utf8")).toBe('{"version": 2}');
  });
});

describe("the check at open (storage.md §7.4)", () => {
  /** A vault at revision 3 and its revision-2 copy restored over it. */
  async function restored(name: string) {
    const fx = await fixture(name);
    const v = await fx.open();
    for (let i = 0; i < 2; i++) await v.save(addEntry(v.data, `e${i}`, { ...emptyContent(), password: "p" }).data);
    v.close();
    const dir = join(fx.state, "backups", v.data.vaultId);
    const backup = join(dir, readdirSync(dir).find((n) => n.endsWith("-r2.passh"))!);
    copyFileSync(backup, fx.vault);
    return { fx, backup };
  }

  const today = new Date().toISOString().slice(0, 10);
  const warning = (rec: number) =>
    `this copy is older than one seen before on this machine (r2 of ${today}; seen r${rec} of ${today}). If you didn't restore it on purpose, the file may have been replaced.`;

  test("no terminal: warning, the command goes on, record unchanged", async () => {
    const { fx } = await restored("rb1");
    f = fx;
    const io = captureIO();
    const v = await fx.open({ io });
    expect(io.err).toEqual([`passh: warning: ${warning(3)}`]);
    expect(v.rollback).toBeUndefined();
    v.close();
    const r = readRecord(join(fx.state, "revisions.json"));
    expect(r.kind === "ok" && [...r.vaults.values()][0]!.revision).toBe(3n);
  });

  test("a terminal: no → stopped; yes → the record takes the lower revision", async () => {
    const { fx } = await restored("rb2");
    f = fx;
    const texts: string[] = [];
    const e = await fx.open({ confirmOlder: async (s) => (texts.push(s), false) }).catch((x) => x);
    expect(errorText(e)).toBe("stopped: this copy is older than one seen before on this machine; nothing was changed");
    expect(hasCode(e, "rollback-declined")).toBe(true);
    expect(texts).toEqual([warning(3)]);
    const v = await fx.open({ confirmOlder: async () => true });
    v.close();
    const r = readRecord(join(fx.state, "revisions.json"));
    expect(r.kind === "ok" && [...r.vaults.values()][0]!.revision).toBe(2n);
    // no question any more
    const w = await fx.open({ confirmOlder: async () => { throw new Error("asked again"); } });
    w.close();
  });

  test("rollback.warn = false, files in the backups folder, report mode: no question", async () => {
    const { fx, backup } = await restored("rb3");
    f = fx;
    const ask = async (): Promise<boolean> => {
      throw new Error("asked");
    };
    fx.config.rollback.warn = false;
    const io = captureIO();
    (await fx.open({ confirmOlder: ask, io })).close();
    fx.config.rollback.warn = true;
    const b = await openVault(backup, { config: fx.config, io, rollback: "prompt", confirmOlder: ask, sources: [identityKeySource(fx.identity, "passphrase")], env: fx.env });
    expect(b.inBackups).toBe(true);
    b.close();
    const v = await fx.open({ confirmOlder: ask, io, rollback: "report" });
    expect(v.rollback).toEqual({ kind: "older", seen: 3n, seenSavedAt: v.rollback!.kind === "older" ? v.rollback!.seenSavedAt : 0 });
    v.close();
    expect(io.err).toEqual([]);
  });

  test("reports: unseen, same, newer; a newer record is never written", async () => {
    f = await fixture("rb4");
    const path = join(f.state, "revisions.json");
    writeFileSync(path, '{"version": 1}');
    let v = await f.open({ rollback: "report" });
    expect(v.rollback).toEqual({ kind: "unseen" });
    v.close();
    v = await f.open({ rollback: "report" });
    expect(v.rollback).toEqual({ kind: "same", seen: 1n });
    await v.save(addEntry(v.data, "x", { ...emptyContent(), password: "p" }).data);
    v.close();
    writeFileSync(path, readFileSync(path, "utf8").replace('"revision": 2', '"revision": 1'));
    v = await f.open({ rollback: "report" });
    expect(v.rollback).toEqual({ kind: "newer", seen: 1n });
    v.close();
    writeFileSync(path, '{"version": 3}');
    const io = captureIO();
    v = await f.open({ rollback: "report", io });
    expect(v.rollback).toEqual({ kind: "unseen" });
    expect(io.err).toEqual([`passh: warning: the rollback record can't be used, so older copies aren't detected: ${path} was written by a newer passh (version 3)`]);
    v.close();
    expect(readFileSync(path, "utf8")).toBe('{"version": 3}');
    writeFileSync(path, "x");
    const io2 = captureIO();
    v = await f.open({ io: io2 });
    expect(io2.err).toEqual([`passh: warning: the rollback record ${path} is damaged; a new one is started, so older copies aren't detected this time`]);
    v.close();
    expect(readRecord(path).kind).toBe("ok");
    chmodSync(path, 0);
    const io3 = captureIO();
    try {
      v = await f.open({ io: io3 });
      v.close();
    } finally {
      chmodSync(path, 0o600);
    }
    expect(io3.err).toEqual([`passh: warning: the rollback record can't be used, so older copies aren't detected: open ${path}: permission denied`]);
  });
});
