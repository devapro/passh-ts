// Side by side with the reference: `passh edit <path> [--editor]` (cli.md §2.8): the external
// editor with fake editors (agent-session.md §A6), the built-in form (tui.md §11.7; only the
// text after the form left the screen is compared, the screens differ by design), and the
// reload-and-apply-again offer when the vault changed on disk.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cloneVaultData, newId, type VaultData } from "../../src/model/index.ts";
import { isolatedEnv, type IsolatedEnv } from "../helpers/env.ts";
import type { PtyProcess } from "../helpers/pty.ts";
import { both, makePair, PASSPHRASE, type Answer, type Outcome, type Pair } from "./side.ts";
import { buildVault, readVault, rebuild, type BuiltVault } from "./vaults.ts";

let tools: IsolatedEnv;
let BIN: string;
let vault: BuiltVault;
const pairs: Pair[] = [];

beforeAll(async () => {
  tools = isolatedEnv("edtools");
  BIN = join(tools.dir, "bin");
  mkdirSync(BIN);
  const script = (name: string, body: string) => {
    writeFileSync(join(BIN, name), "#!/bin/sh\nfor f; do :; done\n" + body);
    chmodSync(join(BIN, name), 0o755);
  };
  script("ed-noop", "exit 0\n");
  script("ed-fail", "exit 3\n");
  // writes $NEWTEXT (printf format); with $SWAP, first copies it over $VAULT (a change elsewhere)
  script("ed-write", '[ -n "$SWAP" ] && cp "$SWAP" "$VAULT"\nprintf "$NEWTEXT" > "$f"\n');
  // first run writes $BAD, later runs $NEWTEXT (counter in $COUNT)
  script("ed-twice", 'n=$(cat "$COUNT" 2>/dev/null || echo 0); echo $((n+1)) > "$COUNT"\nif [ "$n" = 0 ]; then printf "$BAD" > "$f"; else printf "$NEWTEXT" > "$f"; fi\n');
  mkdirSync(join(BIN, "v"));
  symlinkSync(join(BIN, "ed-write"), join(BIN, "v", "vim"));
  vault = await buildVault([
    { path: "github", tags: ["gh", "b"], password: "pw", username: "me", fields: [["k", "v"], ["pin", "1"], ["pin", "2"]], notes: "n" },
    { path: "work/x", password: "wx" },
    { path: "other", password: "o" },
  ]);
});
afterAll(() => {
  tools?.cleanup();
  for (const p of pairs) p.cleanup();
});

async function fresh(name: string): Promise<Pair> {
  const p = await makePair(name, vault.bytes);
  pairs.push(p);
  return p;
}

/** The data each side saved, with times blanked (updated_at differs by the clock). */
function saved(p: Pair): [VaultData, VaultData] {
  const blank = (d: VaultData) => {
    d.savedAt = 0;
    for (const e of d.entries) e.updatedAt = 0;
    return d;
  };
  return [blank(readVault(p.ref.vault, vault.identity)), blank(readVault(p.ours.vault, vault.identity))];
}

const editorEnv = (editor: string, extra: Record<string, string> = {}) => ({ EDITOR: join(BIN, editor), ...extra });

/** Compares two outcomes; the terminal output only from the first difference-free point (no form screen). */
function expectSame(r: { ref: Outcome; ours: Outcome }) {
  expect(r.ours).toEqual(r.ref);
}

describe("edit --editor", () => {
  test("no change, a failing editor, nonexistent editors", async () => {
    const p = await fresh("ednoop");
    expectSame(await both(p, ["edit", "github", "--editor"], { pty: true, env: editorEnv("ed-noop") }));
    expectSame(await both(p, ["edit", "github", "--editor"], { pty: true, env: editorEnv("ed-fail") }));
    for (const ed of ["nonexistent-ed", "'abc", '""', "  "]) expectSame(await both(p, ["edit", "github", "--editor"], { pty: true, env: { EDITOR: ed, VISUAL: "nonexistent-visual" } }));
    expectSame(await both(p, ["edit", "nope", "--editor"], { pty: true, env: editorEnv("ed-noop") }));
    expectSame(await both(p, ["edit", "work", "--editor"], { pty: true, env: editorEnv("ed-noop") }));
    expectSame(await both(p, ["edit", "a//", "--editor"], { pty: true, env: editorEnv("ed-noop") }));
    expectSame(await both(p, ["edit", "github", "--editor"], { env: editorEnv("ed-noop") }));
  }, 120_000);

  test("saved: values, tags reordered, custom fields paired; the same text again is no change", async () => {
    const p = await fresh("edsave");
    const text = "pw2\\nusername: me2\\nurl: https://x\\ntags: b, gh\\npin: 2\\nk: v\\nnew: f\\n---\\nnotes\\nmore\\n";
    expectSame(await both(p, ["edit", "github", "--editor"], { pty: true, env: editorEnv("ed-write", { NEWTEXT: text }) }));
    const [r, o] = saved(p);
    expect(o).toEqual(r);
    expectSame(await both(p, ["edit", "github", "--editor"], { pty: true, env: editorEnv("ed-write", { NEWTEXT: text }) }));
    // same content, written differently: no final newline, CRLF after line 1
    expectSame(await both(p, ["edit", "github", "--editor"], { pty: true, env: editorEnv("ed-write", { NEWTEXT: "pw2\\r\\nusername: me2\\r\\nurl: https://x\\r\\ntags: b, gh\\r\\npin: 2\\r\\nk: v\\r\\nnew: f\\r\\n---\\r\\nnotes\\r\\nmore" }) }));
    // vim (a known editor): flags, no warning
    expectSame(await both(p, ["edit", "work/x", "--editor"], { pty: true, env: { EDITOR: join(BIN, "v", "vim"), NEWTEXT: "wx\\n" } }));
    const [r2, o2] = saved(p);
    expect(o2).toEqual(r2);
  }, 120_000);

  test("invalid text: no, end of input, yes then valid, Ctrl-C", async () => {
    const p = await fresh("edinv");
    const again = "[Y/n] ";
    const bad = "pw\\nusername: a\\nusername: b\\n";
    for (const answers of [
      [PASSPHRASE, [again, "n"]],
      [PASSPHRASE, [again, "\x04", "raw"]],
      [PASSPHRASE, [again, "x"], [again, "x"], [again, "x"]],
      [PASSPHRASE, [again, "\x03", "raw"]],
    ] as Answer[][]) {
      expectSame(await both(p, ["edit", "github", "--editor"], { pty: true, answers, env: editorEnv("ed-write", { NEWTEXT: bad }) }));
    }
    for (const side of ["ref", "ours"] as const) {
      const e = side === "ref" ? p.ref : p.ours;
      e.env.COUNT = join(e.dir, "count");
    }
    const r = await both(p, ["edit", "github", "--editor"], {
      pty: true,
      answers: [PASSPHRASE, [again, ""]],
      env: editorEnv("ed-twice", { BAD: "pw\\nx: \\x01\\n", NEWTEXT: "pw3\\n" }),
    });
    expectSame(r);
    expect(r.ref.stderr).toContain("Saved github.");
    const [a, b] = saved(p);
    expect(b).toEqual(a);
  }, 120_000);

  for (const [name, mutate] of [
    ["another entry added", (d: VaultData) => void d.entries.push({ ...d.entries[2]!, id: newId(), path: "c" })],
    ["entry moved", (d: VaultData) => void (d.entries[0]!.path = "z/github")],
    ["entry deleted", (d: VaultData) => void d.entries.splice(0, 1)],
    ["entry replaced", (d: VaultData) => void (d.entries[0]!.id = newId())],
    ["same change made elsewhere", (d: VaultData) => void ((d.entries[0]!.password = "pw2"), (d.entries[0]!.username = "u2"))],
  ] as const) {
    for (const ans of ["y", "n", ""]) {
      if (ans !== "y" && name !== "another entry added") continue;
      test(`vault changed while editing (${name}): answer ${JSON.stringify(ans)}`, async () => {
        const p = await fresh("edchg");
        const d = cloneVaultData(vault.data);
        d.revision = 6n;
        mutate(d);
        for (const e of [p.ref, p.ours]) {
          writeFileSync(join(e.dir, "swap"), rebuild(vault, d));
          e.env.SWAP = join(e.dir, "swap");
          e.env.VAULT = e.vault;
        }
        const r = await both(p, ["edit", "github", "--editor"], {
          pty: true,
          answers: [PASSPHRASE, ["[y/N] ", ans]],
          env: editorEnv("ed-write", { NEWTEXT: "pw2\\nusername: u2\\ntags: gh, b\\nk: v\\npin: 1\\npin: 2\\n---\\nn\\n" }),
        });
        expectSame(r);
        const [a, b] = saved(p);
        expect(b).toEqual(a);
      }, 120_000);
    }
  }
});

/** The terminal text after the form left the alternate screen, without escape sequences. */
function afterForm(s: string): string {
  const i = s.lastIndexOf("\x1b[?1049l");
  const tail = i < 0 ? s : s.slice(i + "\x1b[?1049l".length);
  return tail.replace(/\x1b\[[0-9;?<>=]*[a-zA-Z]/g, "").replace(/^\r/, "");
}

async function form(p: Pair, path: string, keys: (q: PtyProcess) => Promise<void>, extra: Answer[] = []) {
  const r = await both(p, ["edit", path], { pty: true, answers: [PASSPHRASE, async (q) => { await q.expect("ctrl+g generate"); await Bun.sleep(150); await keys(q); }, ...extra] });
  const strip = (o: Outcome) => ({ ...o, tty: afterForm(o.tty) });
  expect(strip(r.ours)).toEqual(strip(r.ref));
  return r;
}

describe("edit (built-in form)", () => {
  test("ctrl+s at once: No change; esc: cancelled", async () => {
    const p = await fresh("form1");
    await form(p, "github", async (q) => q.send("\x13"));
    await form(p, "github", async (q) => q.send("\x1b"));
  }, 120_000);

  test("a changed username is saved; ctrl+g generates a password", async () => {
    const p = await fresh("form2");
    await form(p, "github", async (q) => {
      q.send("\t");
      await Bun.sleep(100);
      q.send("X");
      await Bun.sleep(100);
      q.send("\x13");
    });
    const [a, b] = saved(p);
    expect(b).toEqual(a);
    const r = await form(p, "github", async (q) => {
      q.send("\x07");
      await Bun.sleep(100);
      q.send("\x13");
    });
    expect(r.ref.stderr).toBe("Saved github.\n");
  }, 120_000);

  test("SIGTERM, SIGINT in the form: cancelled; SIGHUP: death by the signal", async () => {
    const p = await fresh("form3");
    for (const sig of ["SIGTERM", "SIGINT"] as const) await form(p, "github", async (q) => q.kill(sig));
    const r = await both(p, ["edit", "github"], { pty: true, answers: [PASSPHRASE, async (q) => { await q.expect("ctrl+g generate"); await Bun.sleep(150); q.kill("SIGHUP"); }] });
    expect([r.ours.code, r.ours.stderr, r.ours.stdout]).toEqual([r.ref.code, r.ref.stderr, r.ref.stdout]);
    expect(r.ref.code).toBe(129);
  }, 60_000);

  test("errors before the form: not found, a folder, no terminal", async () => {
    const p = await fresh("form4");
    expectSame(await both(p, ["edit", "nope"], { pty: true }));
    expectSame(await both(p, ["edit", "work"], { pty: true }));
    expectSame(await both(p, ["edit", "github"]));
  }, 60_000);

  test("vault changed on disk while the form is open: reload and apply", async () => {
    const p = await fresh("form5");
    const d = cloneVaultData(vault.data);
    d.revision = 6n;
    d.entries[1]!.password = "changed elsewhere";
    const swap = rebuild(vault, d);
    const r = await both(p, ["edit", "github"], {
      pty: true,
      answers: [
        PASSPHRASE,
        async (q, e) => {
          await q.expect("ctrl+g generate");
          await Bun.sleep(150);
          q.send("\t");
          await Bun.sleep(100);
          q.send("Z");
          await Bun.sleep(100);
          // the change elsewhere, then save
          writeFileSync(e.vault, swap);
          q.send("\x13");
        },
        ["[y/N] ", "y"],
      ],
    });
    const strip = (o: Outcome) => ({ ...o, tty: afterForm(o.tty) });
    expect(strip(r.ours)).toEqual(strip(r.ref));
    const [a, b] = saved(p);
    expect(b).toEqual(a);
  }, 120_000);
});
