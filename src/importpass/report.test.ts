// The report's exact format (import-export.md §1.8) and the root's resolution rules (§1.3).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv } from "../../test/helpers/env.ts";
import { errorf } from "../i18n/index.ts";
import { Errno } from "../fsx/oserror.ts";
import { formatReport } from "./report.ts";
import { PathEscapesError, StoreRoot } from "./root.ts";
import type { Skip } from "./skips.ts";

const b = (s: string) => Buffer.from(s);

describe("report (§1.8)", () => {
  test("the spec's example of a real run", () => {
    const skips: Skip[] = [
      { file: b("latin1.gpg"), reason: "not-text", detail: errorf("the text is not valid UTF-8") },
      { file: b("etclink"), reason: "outside", detail: errorf("not followed") },
      { file: b("broken.gpg"), reason: "decrypt", detail: errorf("not an OpenPGP message (damaged file?)") },
    ];
    const items = Array.from({ length: 12 }, (_, i) => ({ path: `e${i}`, replace: false }));
    expect(formatReport({ store: "/home/me/.password-store", dryRun: false, items, skips })).toBe(
      [
        "Imported 12 entries from /home/me/.password-store.",
        "Skipped 3: 1 symlink leads outside the store, 1 decryption failed, 1 not a text entry.",
        "  broken.gpg — decryption failed: not an OpenPGP message (damaged file?)",
        "  etclink — symlink leads outside the store: not followed",
        "  latin1.gpg — not a text entry: the text is not valid UTF-8",
        "",
      ].join("\n"),
    );
  });

  test("singular, zero, replaces, path order, escaping", () => {
    expect(formatReport({ store: "/s", dryRun: true, items: [], skips: [] })).toBe("Dry run: nothing was decrypted or saved. Store: /s\nWould import 0 entries.\n");
    expect(formatReport({ store: "/s", dryRun: false, items: [], skips: [] })).toBe("Imported 0 entries from /s.\n");
    expect(formatReport({ store: "/s\n", dryRun: false, items: [{ path: "a", replace: true }], skips: [] })).toBe(
      "Imported 1 entry (1 replacing entries already in the vault) from /s\\n.\n",
    );
    expect(
      formatReport({
        store: "/s",
        dryRun: true,
        items: [
          { path: "work-old/y", replace: false },
          { path: "work/x", replace: true },
          { path: "work", replace: false },
          { path: "x‮", replace: false },
        ],
        skips: [
          { file: Buffer.from([0x62, 0xff, 0x0a]), reason: "unreadable", detail: new Errno("EACCES") },
          { file: b("a"), reason: "broken" },
          { file: b("B"), reason: "unreadable", detail: new PathEscapesError() },
        ],
      }),
    ).toBe(
      [
        "Dry run: nothing was decrypted or saved. Store: /s",
        "Would import 4 entries:",
        "  work",
        "  work/x  (replaces the entry in the vault)",
        "  work-old/y",
        "  x\\u202e",
        "Would import 4 entries (1 replacing entries already in the vault).",
        "Would skip 3: 1 broken symlink, 2 unreadable.",
        "  B — unreadable: path escapes from parent",
        "  a — broken symlink",
        "  b\\xff\\n — unreadable: permission denied",
        "",
      ].join("\n"),
    );
  });
});

describe("resolution inside the store (§1.3, Go's os.Root)", () => {
  const e = isolatedEnv("root");
  afterAll(() => e.cleanup());
  const s = join(e.dir, "s");
  mkdirSync(join(s, "d/e"), { recursive: true });
  writeFileSync(join(s, "f"), "x");
  writeFileSync(join(s, "d/e/g"), "x");
  symlinkSync("d", join(s, "ld"));
  symlinkSync("ld/e/../../f", join(s, "lf"));
  symlinkSync("d/e/.", join(s, "ldot"));
  symlinkSync("../s/f", join(s, "lback"));
  symlinkSync(join(s, "f"), join(s, "labs"));
  const root = StoreRoot.open(s);
  afterAll(() => root.close());
  const parts = (p: string) => root.resolve(b(p)).parts.map(String).join("/");
  const err = (p: string) => {
    try {
      root.resolve(b(p));
      return "ok";
    } catch (x) {
      return x instanceof PathEscapesError ? "escapes" : (x as Errno).code;
    }
  };

  test("links inside are followed; `..` and `.` resolve lexically after each link", () => {
    expect(parts("lf")).toBe("f");
    expect(parts("ld/e/g")).toBe("d/e/g");
    expect(parts("ldot/g")).toBe("d/e/g");
    expect(parts("ldot")).toBe("d/e");
    expect(parts("d//e/./g")).toBe("d/e/g");
    expect(parts(".")).toBe("");
    expect(parts("d/..")).toBe("");
  });

  test("leaving the store, absolute targets, errors", () => {
    expect(err("lback")).toBe("escapes");
    expect(err("labs")).toBe("escapes");
    expect(err("..")).toBe("escapes");
    expect(err("d/../../s/f")).toBe("escapes");
    expect(err("f/x")).toBe("ENOTDIR");
    expect(err("f/")).toBe("ENOTDIR");
    expect(err("nothing")).toBe("ENOENT");
    expect(err("nothing/x")).toBe("ENOENT");
  });

  test("lstat semantics without following the last link", () => {
    expect(root.resolve(b("ld"), false).stats.isSymbolicLink()).toBe(true);
    expect(root.resolve(b("ld/"), false).stats.isDirectory()).toBe(true);
  });
});
