// Side by side with the reference: its TUI (reference/passh-go, run as a black box in a
// PTY on an isolated vault) and ours (src/tui over the fake backend, loaded with the same
// data through `passh export --format json`), driven with the same keys and compared as
// screens (a small VT model turns the output into a grid).
//
// tui.md: the modes (wide ≥ 80 columns, single pane under 80, "window too small" under
// 20 × 6), the keys and what they do, and the messages bind; the exact frame is informative.
// The screens below matched the reference cell for cell when this test was written, so
// they are compared whole (with the countdown normalized); where we differ on purpose the
// test compares only what binds.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { isolatedEnv, REF_BIN, ROOT, run, type IsolatedEnv } from "../helpers/env.ts";
import { initVault, PASS, withPassphrase } from "../helpers/passh.ts";
import { spawnPty, type PtyProcess } from "../helpers/pty.ts";
import { Screen } from "../../src/tui/testdata/vt.ts";

const DRIVER = join(ROOT, "src/tui/testdata/run-fake.ts");
let env: IsolatedEnv;
let dataFile: string;
const live: PtyProcess[] = [];

async function ref(args: string[], answers: Array<[string, string]> = []) {
  const r = await withPassphrase([REF_BIN], args, env, PASS, answers);
  if (r.code !== 0) throw new Error(`passh-go ${args.join(" ")} failed (${r.code}): ${r.tty}`);
  return r;
}

beforeAll(async () => {
  env = isolatedEnv("tuiint");
  await initVault([REF_BIN], env);
  await ref(["unlock"]);
  try {
    await ref(["add", "work/github"], [
      ["Password (empty to generate): ", ""],
      ["Username: ", "arsenii"],
      ["URL: ", "https://github.com"],
      ["Tags (comma-separated): ", "dev, 2fa"],
      // an escape sequence in the notes: both must show it escaped (S4)
      ["Notes (end with an empty line):", "Recovery codes in notes\r\x1b[31mred\x1b[0m line\r"],
    ]);
    for (const p of ["work/jira", "bank/My Bank", "homelab/router", "github", "work/sub/deep", "work-old/y", "Zeta", "evil/‮x"]) await ref(["generate", p]);
    await ref(["tag", "work/jira", "--add", "dev"]);
    await ref(["tag", "github", "--add", "dev,zz-gh"]);
    const r = await ref(["export", "--format", "json", "--confirm-plaintext"], [["Type EXPORT PLAINTEXT to confirm: ", "EXPORT PLAINTEXT"]]);
    dataFile = join(env.dir, "export.json");
    writeFileSync(dataFile, r.stdout, { mode: 0o600 });
    // Snapshots: a test may change the reference's vault (delete); each test starts again
    // from these (the rollback record too, so the reference doesn't see an older copy).
    copyFileSync(env.vault, join(env.dir, "vault.snap"));
    if (existsSync(revisions())) copyFileSync(revisions(), join(env.dir, "revisions.snap"));
  } finally {
    await run([REF_BIN, "lock"], env.env);
  }
}, 120_000);

function revisions(): string {
  return join(env.stateHome, "passh", "revisions.json");
}

function restore(): void {
  copyFileSync(join(env.dir, "vault.snap"), env.vault);
  if (existsSync(join(env.dir, "revisions.snap"))) copyFileSync(join(env.dir, "revisions.snap"), revisions());
}

afterAll(async () => {
  for (const p of live) p.kill("SIGKILL");
  if (env) {
    await run([REF_BIN, "lock"], env.env);
    env.cleanup();
  }
});

class Side {
  readonly scr: Screen;
  private len = 0;
  constructor(
    readonly p: PtyProcess,
    cols: number,
    rows: number,
  ) {
    this.scr = new Screen(cols, rows);
    live.push(p);
  }
  lines(): string[] {
    const o = this.p.output();
    this.scr.write(o.slice(this.len));
    this.len = o.length;
    return this.scr.lines().map((l) => l.replace(/locks in \d+:\d\d/, "locks in M:SS"));
  }
  async see(what: string, ms = 20_000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.lines().join("\n").includes(what)) return;
      await Bun.sleep(25);
    }
    throw new Error(`never showed ${JSON.stringify(what)}:\n${this.lines().join("\n")}`);
  }
}

/** Both TUIs, unlocked, at one size. `idle`: session.idle_ttl as a Go duration and in ms. */
async function both(cols: number, rows: number, idle?: [string, number]): Promise<[Side, Side]> {
  restore();
  const refArgs: string[] = [];
  const ourArgs: string[] = [];
  if (idle) {
    const cfg = join(env.dir, `idle-${idle[1]}.toml`);
    writeFileSync(cfg, `vault = ${JSON.stringify(env.vault)}\n[session]\nidle_ttl = "${idle[0]}"\n`);
    refArgs.push("--config", cfg);
    ourArgs.push("--idle", String(idle[1]));
  }
  const a = new Side(spawnPty([REF_BIN, ...refArgs], env.env, { cols, rows }), cols, rows);
  const b = new Side(
    spawnPty([process.execPath, "run", DRIVER, "--data", dataFile, "--passphrase", PASS, "--vault-display", env.vault, "--clear-after", "30000", ...ourArgs], env.env, { cols, rows }),
    cols,
    rows,
  );
  // Unlock both at the same moment, so that their status messages expire together.
  for (const s of [a, b]) await s.see("Passphrase", 30_000);
  await Bun.sleep(200);
  for (const s of [a, b]) s.p.send(PASS + "\r");
  for (const s of [a, b]) await s.see("unlocked · locks in", 30_000);
  return [a, b];
}

async function press(sides: Side[], keys: string): Promise<void> {
  for (const k of keys.split("\0")) {
    for (const s of sides) s.p.send(k);
    await Bun.sleep(120);
  }
  await Bun.sleep(250);
}

async function quit(sides: Side[]): Promise<void> {
  for (const s of sides) s.p.kill("SIGKILL");
  for (const s of sides) await s.p.wait(5000);
}

/** The lines that differ, for a readable failure. */
function diff(a: string[], b: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(`${i}: ref ${JSON.stringify(a[i])}\n${i}: ts  ${JSON.stringify(b[i])}`);
  return out;
}

describe("TUI side by side with the reference", () => {
  test("80 × 24: list, pane, detail, Tags view, search, prompts, confirm", async () => {
    const [a, b] = await both(80, 24);
    try {
      const steps: Array<[string, string]> = [
        ["", "after unlock"],
        ["j\0j\0j", "cursor on a folder"],
        ["\r", "folder opened"],
        ["j\0j", "an entry in the pane"],
        ["\r", "the detail"],
        ["\x1b", "back"],
        ["\t", "Tags view"],
        [" \0j\0 ", "two tags selected"],
        ["\x1b\0\t\0/", "search, empty query"],
        ["gh", "search gh"],
        ["\r", "search results kept"],
        ["\x1b\0j\0j\0j\0d", "delete question"],
        ["n", "not deleted"],
        ["m", "move prompt"],
        ["\x1b", "cancelled"],
        ["t", "tags prompt"],
        ["\x1b\0c", "copy"],
        ["k\0k\0k\0c", "copy on a folder"],
        ["?", "help"],
        ["j\0j\0j\0j\0j\0j\0j\0j\0j\0j", "help scrolled to the end"],
        ["x", "help closed by a key"],
        ["l\0j\0\r\0r", "the detail revealed"],
        ["e", "the form"],
        ["\x12", "the form: password shown"],
        ["\t\0\t\0xy", "the form: url typed"],
        ["\x1b", "the form: discard question"],
        ["\x1b", "the form: discarded"],
        ["\x1b\0a", "add prompt"],
        ["bad//path\r", "add prompt: invalid path"],
        ["\x15work/jira\r", "add prompt: path exists"],
        ["\x1b\0L", "locked"],
        ["\r", "Enter on an empty field after a lock"],
      ];
      for (const [keys, what] of steps) {
        if (keys) await press([a, b], keys);
        if (process.env.TUI_DUMP) console.log(`=== ${what}\n` + a.lines().map((l, i) => `${String(i).padStart(2)} ref |${l}\n${String(i).padStart(2)} ts  |${b.lines()[i]}`).join("\n"));
        // the reverse-video cells (the selected row, the cursor) are the same too
        for (let r = 0; r < 24; r++) expect({ what, r, rev: a.scr.styled(r, (c) => c.reverse) }).toEqual({ what, r, rev: b.scr.styled(r, (c) => c.reverse) });
        expect({ what, diff: diff(a.lines(), b.lines()) }).toEqual({ what, diff: [] });
      }
    } finally {
      await quit([a, b]);
    }
  }, 120_000);

  test("narrow 40 × 20 and 60 × 16: one pane", async () => {
    for (const [c, r] of [
      [40, 20],
      [60, 16],
    ] as const) {
      const [a, b] = await both(c, r);
      try {
        const steps: Array<[string, string]> = [
          ["", "after unlock"],
          ["j\0j\0j\0j\0\r", "a folder opened"],
          ["j\0\r", "the detail"],
          ["\x1b\0\t", "Tags view"],
        ];
        for (const [keys, what] of steps) {
          if (keys) await press([a, b], keys);
          const la = a.lines();
          const lb = b.lines();
          expect(la[0]!.startsWith("passh · ")).toBe(true);
          expect({ what, size: `${c}x${r}`, diff: diff(la, lb) }).toEqual({ what, size: `${c}x${r}`, diff: [] });
        }
      } finally {
        await quit([a, b]);
      }
    }
  }, 120_000);

  test("120 × 40", async () => {
    const [a, b] = await both(120, 40);
    try {
      for (const [keys, what] of [
        ["", "after unlock"],
        ["j\0j\0j\0\r\0j", "folder open, entry in the pane"],
        ["/\0hub", "search"],
      ] as const) {
        if (keys) await press([a, b], keys);
        expect({ what, diff: diff(a.lines(), b.lines()) }).toEqual({ what, diff: [] });
      }
    } finally {
      await quit([a, b]);
    }
  }, 120_000);

  test("the idle lock and its message", async () => {
    const [a, b] = await both(80, 24, ["3s", 3000]);
    try {
      await a.see("Locked after", 10_000);
      await b.see("Locked after", 10_000);
      await Bun.sleep(300);
      expect(diff(a.lines(), b.lines())).toEqual([]);
      expect(a.lines().join("\n")).toContain("Locked after 3s without input.");
    } finally {
      await quit([a, b]);
    }
  }, 60_000);

  test("narrow 40 × 20: search, detail revealed, prompts", async () => {
    const [a, b] = await both(40, 20);
    try {
      for (const [keys, what] of [
        ["/\0hub", "search typing"],
        ["\r", "results kept"],
        ["r", "detail revealed"],
        ["\x1b\0m", "move prompt"],
        ["\x1b\0d", "delete question"],
        ["y", "deleted"],
        ["?", "help"],
      ] as const) {
        await press([a, b], keys);
        expect({ what, diff: diff(a.lines(), b.lines()) }).toEqual({ what, diff: [] });
      }
    } finally {
      await quit([a, b]);
    }
  }, 120_000);

  test("window too small (under 20 × 6), and back", async () => {
    const [a, b] = await both(80, 24);
    try {
      for (const s of [a, b]) {
        s.p.resize(19, 10);
        s.scr.resize(19, 10);
      }
      await Bun.sleep(400);
      expect(a.lines()[0]).toBe("passh: window too s");
      expect(b.lines()[0]).toBe(a.lines()[0]!);
      for (const s of [a, b]) {
        s.p.resize(80, 5);
        s.scr.resize(80, 5);
      }
      await Bun.sleep(400);
      expect(a.lines()[0]).toBe("passh: window too small");
      expect(b.lines()[0]).toBe("passh: window too small");
      for (const s of [a, b]) {
        s.p.resize(80, 24);
        s.scr.resize(80, 24);
      }
      await Bun.sleep(400);
      expect(diff(a.lines(), b.lines())).toEqual([]);
    } finally {
      await quit([a, b]);
    }
  }, 120_000);
});
