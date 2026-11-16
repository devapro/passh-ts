// The real TUI backend on real vaults in isolated environments: unlock (passphrase, agent,
// the failure kinds of tui.md §4.4), the changes saved through the real storage, changes
// on disk made by another process, reload (passwd and rekey elsewhere, rollback), the
// clipboard and the print page errors. The reference binary plays "another passh".

import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { X25519Identity } from "../age/index.ts";
import { loadConfig, type Config } from "../config/index.ts";
import { renderError } from "../i18n/index.ts";
import { addEntry, type VaultData } from "../model/index.ts";
import type { SaveResult, UnlockResult, VaultSession } from "../tui/backend.ts";
import { captureIO } from "../util/io.ts";
import { createVault } from "../vault/create.ts";
import { isolatedEnv, REF_BIN, ROOT, run, TS_SRC_CMD, writeConfig, type IsolatedEnv } from "../../test/helpers/env.ts";
import { spawnPty } from "../../test/helpers/pty.ts";
import { Screen } from "../tui/testdata/vt.ts";
import { PASS, withPassphrase } from "../../test/helpers/passh.ts";
import { createTuiBackend, type RealTuiBackend } from "./tuibackend.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const envs: IsolatedEnv[] = [];
afterAll(async () => {
  for (const e of envs) {
    await run([REF_BIN, "lock"], e.env);
    e.cleanup();
  }
});

interface Setup {
  e: IsolatedEnv;
  cfg: Config;
  backend: RealTuiBackend;
}

/** A vault with three entries, made by our storage; the config may add lines. */
async function setup(extra = ""): Promise<Setup> {
  const e = isolatedEnv("tuib");
  envs.push(e);
  await writeConfig(e, extra);
  const cfg = loadConfig({ env: e.env });
  const v = await createVault(cfg.vault, { config: cfg, io: captureIO(), identity: X25519Identity.generate(), passphrase: enc(PASS), env: e.env });
  let d: VaultData = v.data;
  d = addEntry(d, "work/github", { password: "gh-pass", username: "arsenii", url: "https://github.com", tags: ["dev"], fields: [], notes: "codes" }).data;
  d = addEntry(d, "work/jira", { password: "jira-pass", username: "", url: "", tags: ["dev"], fields: [], notes: "" }).data;
  d = addEntry(d, "github", { password: "root-pass", username: "", url: "", tags: [], fields: [], notes: "" }).data;
  await v.save(d);
  v.close();
  return { e, cfg, backend: createTuiBackend(cfg, { tty: null, env: e.env }) };
}

const sig = () => new AbortController().signal;

async function unlock(s: Setup, pass = PASS): Promise<UnlockResult> {
  return s.backend.unlockWithPassphrase(enc(pass), sig());
}

async function session(s: Setup): Promise<VaultSession> {
  const r = await unlock(s);
  if (r.kind !== "unlocked") throw new Error("not unlocked: " + r.kind);
  return r.session;
}

const idOf = (ses: VaultSession, path: string) => ses.data().entries.find((e) => e.path === path)!.id;

/** The vault as the reference binary reads it. */
async function refShow(e: IsolatedEnv, path: string): Promise<string> {
  const r = await withPassphrase([REF_BIN], ["show", path], e);
  return r.code === 0 ? r.stdout : `exit ${r.code}: ${r.tty}`;
}

describe("unlocking (tui.md §4.2, §4.4)", () => {
  test("a wrong passphrase, then the right one; the data and no warnings", async () => {
    const s = await setup();
    expect((await unlock(s, "nope")).kind).toBe("wrong-passphrase");
    const r = await unlock(s);
    expect(r.kind).toBe("unlocked");
    if (r.kind !== "unlocked") return;
    expect(r.rollback).toBeUndefined();
    expect(r.warnings).toEqual([]);
    expect(r.session.data().entries.map((x) => x.path).sort()).toEqual(["github", "work/github", "work/jira"]);
    expect(r.session.data().revision).toBe(2n);
    r.session.close();
  }, 30_000);

  test("no agent: no-agent; the agent: unlocked, status, stop", async () => {
    const s = await setup();
    expect((await s.backend.unlockWithAgent(sig())).kind).toBe("no-agent");
    expect(await s.backend.agentRunning(sig())).toBe(false);
    expect(await s.backend.stopAgent(sig())).toBe(false);
    const u = await withPassphrase([REF_BIN], ["unlock"], s.e);
    expect(u.code).toBe(0);
    try {
      const r = await s.backend.unlockWithAgent(sig());
      expect(r.kind).toBe("unlocked");
      if (r.kind === "unlocked") r.session.close();
      expect(await s.backend.agentRunning(sig())).toBe(true);
      expect(await s.backend.stopAgent(sig())).toBe(true);
      expect(await s.backend.agentRunning(sig())).toBe(false);
      expect((await s.backend.unlockWithAgent(sig())).kind).toBe("no-agent");
    } finally {
      await run([REF_BIN, "lock"], s.e.env);
    }
  }, 60_000);

  test("the agent unlocked for another key block (passwd elsewhere)", async () => {
    const s = await setup();
    expect((await withPassphrase([REF_BIN], ["unlock"], s.e)).code).toBe(0);
    try {
      // A copy elsewhere gets a new passphrase; its bytes then replace the vault.
      const other = join(s.e.dir, "other", "v.passh");
      mkdirSync(join(s.e.dir, "other"), { recursive: true });
      copyFileSync(s.cfg.vault, other);
      const p = await withPassphrase([REF_BIN], ["--vault", other, "passwd"], s.e, PASS, [
        ["Current passphrase: ", PASS],
        ["New passphrase: ", "another long passphrase 1"],
        ["Repeat passphrase: ", "another long passphrase 1"],
      ]);
      expect(p.code).toBe(0);
      copyFileSync(other, s.cfg.vault);
      expect((await s.backend.unlockWithAgent(sig())).kind).toBe("agent-other-key-block");
    } finally {
      await run([REF_BIN, "lock"], s.e.env);
    }
  }, 60_000);

  test("a damaged data block: the damaged state with the backup list", async () => {
    const s = await setup();
    const text = readFileSync(s.cfg.vault, "utf8").split("\n");
    // a payload line of the data block: the full line before its END line
    const ends = text.map((l, i) => (l.startsWith("-----END") ? i : -1)).filter((i) => i >= 0);
    const at = ends[1]! - 2;
    const line = text[at]!;
    text[at] = (line[0] === "A" ? "B" : "A") + line.slice(1);
    writeFileSync(s.cfg.vault, text.join("\n"));
    const r = await unlock(s);
    expect(r.kind).toBe("damaged");
    if (r.kind === "damaged") expect(renderError(r.error)).toContain("data is damaged; restore a backup");
    else if (r.kind === "error") throw r.error;
  }, 30_000);

  test("a key block asking for more scrypt work than 2^18: work-factor, refused before scrypt", async () => {
    const s = await setup();
    const text = readFileSync(s.cfg.vault, "utf8").split("\n");
    const b = text.findIndex((l) => l.startsWith("-----BEGIN"));
    const e = text.findIndex((l) => l.startsWith("-----END"));
    const bin = Buffer.from(text.slice(b + 1, e).join(""), "base64").toString("latin1");
    const changed = bin.replace(/^(-> scrypt \S+) 18$/m, "$1 20");
    expect(changed).not.toBe(bin);
    const b64 = Buffer.from(changed, "latin1").toString("base64").match(/.{1,64}/g)!;
    writeFileSync(s.cfg.vault, [...text.slice(0, b + 1), ...b64, ...text.slice(e)].join("\n"));
    const t0 = Date.now();
    const r = await unlock(s);
    expect(r.kind).toBe("work-factor");
    expect(Date.now() - t0).toBeLessThan(500);
  }, 30_000);

  test("a file that isn't a vault: the error as is", async () => {
    const s = await setup();
    writeFileSync(s.cfg.vault, "hello\n");
    const r = await unlock(s);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(renderError(r.error)).toContain("not a passh vault");
  }, 30_000);
});

describe("changes are saves of the real storage (tui.md §7)", () => {
  test("add, edit, move, tags, delete; unchanged edits save nothing", async () => {
    const s = await setup();
    const ses = await session(s);
    const ok = (r: SaveResult) => {
      if (r.kind !== "saved") throw new Error(r.kind === "failed" ? renderError(r.error) : r.kind);
      return r;
    };
    const a = ok(await ses.add("work/new", { password: "np", username: "bob", url: "", tags: ["x"], notes: "n" }, null, sig()));
    expect(a.data.revision).toBe(3n);
    const id = a.id;
    expect(a.data.entries.find((x) => x.id === id)!.path).toBe("work/new");
    const same = await ses.edit(id, { password: "np", username: "bob", url: "", tags: ["x"], notes: "n" }, sig());
    expect(same.kind).toBe("unchanged");
    ok(await ses.edit(id, { password: "np2", username: "bob", url: "https://u", tags: ["x"], notes: "n" }, sig()));
    ok(await ses.move(id, "misc/new", sig()));
    expect((await ses.tag(id, ["x"], [], sig())).kind).toBe("unchanged");
    ok(await ses.tag(id, ["y"], ["x"], sig()));
    ok(await ses.remove(idOf(ses, "github"), sig()));
    const failed = await ses.add("work/jira", { password: "", username: "", url: "", tags: [], notes: "" }, null, sig());
    expect(failed.kind === "failed" && renderError(failed.error)).toBe("work/jira: already exists");
    expect(ses.data().revision).toBe(7n);
    ses.close();
    // the reference reads what we wrote
    expect(await refShow(s.e, "misc/new")).toBe("np2\nusername: bob\nurl: https://u\ntags: y\n---\nn\n");
    expect(await refShow(s.e, "github")).toContain("exit 1");
  }, 60_000);

  test("a recreated add keeps the custom fields and unknown keys it is given", async () => {
    const s = await setup();
    const ses = await session(s);
    const r = await ses.add("re/made", { password: "p", username: "", url: "", tags: [], notes: "" }, { fields: [{ key: "pin", value: "1234", unknown: new Map() }], unknown: new Map([["x-extra", '"kept"']]) }, sig());
    expect(r.kind).toBe("saved");
    if (r.kind !== "saved") return;
    const e = r.data.entries.find((x) => x.id === r.id)!;
    expect(e.fields.map((f) => [f.key, f.value])).toEqual([["pin", "1234"]]);
    expect(e.unknown.get("x-extra")).toBe('"kept"');
    ses.close();
  }, 30_000);

  test("an aborted save is cancelled; nothing is written", async () => {
    const s = await setup();
    const ses = await session(s);
    const ctl = new AbortController();
    ctl.abort();
    expect((await ses.add("x", { password: "", username: "", url: "", tags: [], notes: "" }, null, ctl.signal)).kind).toBe("cancelled");
    expect(ses.data().revision).toBe(2n);
    ses.close();
  }, 30_000);
});

describe("changed on disk and reload (tui.md §8)", () => {
  test("another process saves: changed; a save is refused; reload brings its data", async () => {
    const s = await setup();
    const ses = await session(s);
    expect(await ses.checkChanged(sig())).toBe(false);
    expect((await withPassphrase([REF_BIN], ["generate", "from/ref"], s.e)).code).toBe(0);
    expect(await ses.checkChanged(sig())).toBe(true);
    expect((await ses.edit(idOf(ses, "github"), { password: "x", username: "", url: "", tags: [], notes: "" }, sig())).kind).toBe("changed");
    const r = await ses.reload(sig());
    expect(r.kind).toBe("reloaded");
    if (r.kind !== "reloaded") return;
    expect(r.data.entries.some((x) => x.path === "from/ref")).toBe(true);
    expect(await ses.checkChanged(sig())).toBe(false);
    expect((await ses.edit(idOf(ses, "github"), { password: "x", username: "", url: "", tags: [], notes: "" }, sig())).kind).toBe("saved");
    ses.close();
  }, 60_000);

  test("passwd elsewhere: the current key reloads it", async () => {
    const s = await setup();
    const ses = await session(s);
    const p = await withPassphrase([REF_BIN], ["passwd"], s.e, PASS, [
      ["Current passphrase: ", PASS],
      ["New passphrase: ", "another long passphrase 2"],
      ["Repeat passphrase: ", "another long passphrase 2"],
    ]);
    expect(p.code).toBe(0);
    const r = await ses.reload(sig());
    expect(r.kind).toBe("reloaded");
    ses.close();
  }, 60_000);

  test("rekey elsewhere: rekeyed", async () => {
    const s = await setup();
    const ses = await session(s);
    const p = await withPassphrase([REF_BIN], ["rekey"], s.e, PASS, [
      ["Current passphrase: ", PASS],
      ["New passphrase: ", PASS],
      ["Repeat passphrase: ", PASS],
    ]);
    expect(p.code).toBe(0);
    expect((await ses.reload(sig())).kind).toBe("rekeyed");
    ses.close();
  }, 60_000);

  test("an older copy: the rollback question at unlock and at reload", async () => {
    const s = await setup();
    const old = readFileSync(s.cfg.vault);
    // revision 3 is seen on this machine
    let ses = await session(s);
    expect((await ses.remove(idOf(ses, "github"), sig())).kind).toBe("saved");
    ses.close();
    writeFileSync(s.cfg.vault, old);
    // unlock: "no" closes it; the record stays, so the question comes again
    let r = await unlock(s);
    expect(r.kind === "unlocked" && r.rollback?.warning).toMatch(/^this copy is older than one seen before on this machine \(r2 of \d{4}-\d\d-\d\d; seen r3 of /);
    if (r.kind !== "unlocked" || !r.rollback) return;
    expect(r.rollback.declined.message).toBe("stopped: this copy is older than one seen before on this machine; nothing was changed");
    r.session.close();
    r = await unlock(s);
    if (r.kind !== "unlocked" || !r.rollback) throw new Error("no question");
    expect(await r.rollback.accept()).toEqual([]);
    expect(r.session.data().revision).toBe(2n);
    // reload of an older copy: the question; "no" keeps the open data
    ses = r.session;
    expect((await ses.remove(idOf(ses, "work/jira"), sig())).kind).toBe("saved");
    writeFileSync(s.cfg.vault, old);
    const q = await ses.reload(sig());
    expect(q.kind).toBe("rollback");
    if (q.kind !== "rollback") return;
    const no = await q.answer(false, sig());
    expect(no.kind === "failed" && renderError(no.error)).toBe("stopped: this copy is older than one seen before on this machine; nothing was changed");
    expect(ses.data().revision).toBe(3n);
    const q2 = await ses.reload(sig());
    if (q2.kind !== "rollback") throw new Error(q2.kind);
    const yes = await q2.answer(true, sig());
    expect(yes.kind === "reloaded" && yes.data.revision).toBe(2n);
    ses.close();
  }, 60_000);
});

describe("clipboard and print page", () => {
  test("clipboard.command: copy, then clear now", async () => {
    const s = await setup();
    const out = join(s.e.dir, "clip.txt");
    const cfgText = `[clipboard]\ncommand = ["tee", ${JSON.stringify(out)}]\nclear_after = "1m"\n`;
    await writeConfig(s.e, cfgText);
    const b = createTuiBackend(loadConfig({ env: s.e.env }), { tty: null, env: s.e.env });
    expect(b.config.clearAfterMs).toBe(60_000);
    const r = await b.copy("secret value", "password", "work/github", sig());
    expect(r.kind).toBe("copied");
    expect(readFileSync(out, "utf8")).toBe("secret value");
    expect(b.pendingClear()).not.toBeNull();
    expect(await b.clearNow(sig())).toBe(true);
    expect(readFileSync(out, "utf8")).toBe("");
    expect(b.pendingClear()).toBeNull();
    if (r.kind === "copied") expect(await r.cleared).toBe("superseded");
  }, 30_000);

  test("no clipboard: the error names passh show … | pbcopy", async () => {
    const s = await setup();
    const r = await s.backend.copy("v", "password", "work/my entry", sig());
    expect(r.kind).toBe("no-clipboard");
    if (r.kind === "no-clipboard")
      expect(renderError(r.error)).toBe("no clipboard: OSC 52 needs a terminal and there is none, and clipboard.command is empty; copy with: passh show 'work/my entry' --field password | pbcopy");
  }, 30_000);

  test("the print page: config values, and a failure to start is thrown", async () => {
    const s = await setup('[print_web]\nenabled = true\ninterfaces = ["lo"]\n');
    const b = createTuiBackend(loadConfig({ env: s.e.env }), { tty: null, env: s.e.env });
    expect(b.config.printWebEnabled).toBe(true);
    const ses = await session({ ...s, backend: b });
    let err: unknown;
    try {
      await b.startPrintPage({ scope: { kind: "all" }, fields: ["password"], data: ses.data() }, sig());
    } catch (e) {
      err = e;
    }
    expect(renderError(err)).toContain("the print page has no private address to listen on (print_web.interfaces)");
    ses.close();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// `passh` with no arguments, in a PTY (cli.md §2.1)


/**
 * The command that runs our TUI: `bun run src/main.ts` once the root command is registered
 * in src/cli/runs.ts, else the driver that calls runTuiCommand the same way.
 */
function tuiCmd(): string[] {
  const runs = readFileSync(join(ROOT, "src/cli/runs.ts"), "utf8");
  if (runs.includes("runTuiCommand")) return TS_SRC_CMD;
  return [process.execPath, "run", join(ROOT, "src/tui/testdata/run-real.ts")];
}

describe("passh (the TUI command)", () => {
  test("without a terminal: the message, exit 1; config and vault are checked first", async () => {
    const s = await setup();
    const r = await run(tuiCmd(), s.e.env);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("passh: the TUI needs a terminal: run passh in one (over SSH: `ssh -t host passh`); without a terminal, use the commands (passh --help) after `passh unlock`\n");
    const e2 = isolatedEnv("tuic");
    envs.push(e2);
    const r2 = await run(tuiCmd(), e2.env);
    expect(r2.code).toBe(1);
    expect(r2.stderr).toStartWith("passh: no config file at ");
    await writeConfig(e2);
    const r3 = await run(tuiCmd(), e2.env);
    expect(r3.code).toBe(1);
    expect(r3.stderr).toStartWith("passh: no vault at ");
  }, 60_000);

  test("unlock, add an entry with the form, quit: exit 0, and the reference reads it", async () => {
    const s = await setup();
    const p = spawnPty(tuiCmd(), s.e.env, { cols: 80, rows: 24 });
    try {
      await p.expect("Passphrase", 20_000);
      await Bun.sleep(200);
      p.send(PASS + "\r");
      await p.expect("Unlocked: 3 entries, revision 2.", 20_000);
      p.send("a");
      await p.expect("New entry's path: ");
      p.send("\x15made/in-tui\r");
      await p.expect("add made/in-tui");
      await Bun.sleep(100);
      p.send("tui-pass\tcarol\x13");
      await p.expect("Added made/in-tui.", 20_000);
      p.send("q");
      const r = await p.wait(20_000);
      expect(r.code).toBe(0);
    } finally {
      p.kill("SIGKILL");
    }
    expect(await refShow(s.e, "made/in-tui")).toBe("tui-pass\nusername: carol\n");
  }, 60_000);

  test("SIGTERM: locked, then exit 143 with the message", async () => {
    const s = await setup();
    const p = spawnPty(tuiCmd(), s.e.env, { cols: 80, rows: 24 });
    try {
      await p.expect("Passphrase", 20_000);
      await Bun.sleep(200);
      p.send(PASS + "\r");
      await p.expect("Unlocked", 20_000);
      p.kill("SIGTERM");
      const r = await p.wait(20_000);
      expect(r.code).toBe(143);
      expect(r.output).toContain("passh: locked and stopped: received terminated");
    } finally {
      p.kill("SIGKILL");
    }
  }, 60_000);

  test("an older copy: the question on the lock screen; no → exit 1 with the stopped error", async () => {
    const s = await setup();
    const old = readFileSync(s.cfg.vault);
    const ses = await session(s);
    expect((await ses.remove(idOf(ses, "github"), sig())).kind).toBe("saved");
    ses.close();
    writeFileSync(s.cfg.vault, old);
    const p = spawnPty(tuiCmd(), s.e.env, { cols: 100, rows: 24 });
    const scr = new Screen(100, 24);
    try {
      await p.expect("Passphrase", 20_000);
      await Bun.sleep(200);
      p.send(PASS + "\r");
      await p.expect("Continue with this copy? y/N", 20_000);
      scr.write(p.output());
      expect(scr.text()).toContain("Warning: this copy is older than one seen before on this machine (r2 of");
      p.send("n");
      const r = await p.wait(20_000);
      expect(r.code).toBe(1);
      expect(r.output).toContain("passh: stopped: this copy is older than one seen before on this machine; nothing was changed");
    } finally {
      p.kill("SIGKILL");
    }
  }, 60_000);
});
