// End-to-end interop: the compiled passh-ts binary (dist/passh; `bun run build:host`) and the
// reference binary side by side on the same vault files, in isolated environments.
// Each test prints a line "E2E <check>: pass" that REPORT.md's interop table is built from.

import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, REF_BIN, TS_BIN, ROOT, run, writeConfig, type IsolatedEnv } from "../helpers/env.ts";
import { initVault, withPassphrase, PASS } from "../helpers/passh.ts";
import { spawnPty } from "../helpers/pty.ts";

const TS = existsSync(TS_BIN) ? [TS_BIN] : [process.execPath, "run", join(ROOT, "src/main.ts")];
const GO = [REF_BIN];
const AGE = join(ROOT, "tmp/age/age");
const envs: IsolatedEnv[] = [];
function env(name: string): IsolatedEnv {
  const e = isolatedEnv(name);
  envs.push(e);
  return e;
}
afterAll(async () => {
  for (const e of envs) {
    for (const bin of [GO, TS]) await run([...bin, "lock"], e.env).catch(() => {});
    e.cleanup();
  }
});

/** A copy of `src`'s vault file into a fresh env with a config naming it. */
async function cloneEnv(src: IsolatedEnv, name: string): Promise<IsolatedEnv> {
  const e = env(name);
  mkdirSync(join(e.dataHome, "passh"), { recursive: true, mode: 0o700 });
  copyFileSync(src.vault, e.vault);
  await writeConfig(e);
  return e;
}

const pw = (bin: string[], e: IsolatedEnv, args: string[], answers: Array<[string | RegExp, string]> = []) => withPassphrase(bin, args, e, PASS, answers);

describe("e2e: compiled passh-ts vs passh-go", () => {
  test("a vault made by passh-go is read and changed by passh-ts, and back", async () => {
    const e = env("e2ego");
    await initVault(GO, e);
    expect((await pw(GO, e, ["generate", "work/github", "20"])).code).toBe(0);
    const goShow = await pw(GO, e, ["show", "work/github"]);
    const tsShow = await pw(TS, e, ["show", "work/github"]);
    expect(tsShow.stdout).toBe(goShow.stdout);
    expect((await pw(TS, e, ["generate", "bank/main", "--symbols"])).code).toBe(0);
    expect((await pw(TS, e, ["tag", "work/github", "--add", "dev,2fa"])).code).toBe(0);
    const goLs = await pw(GO, e, ["ls"]);
    const tsLs = await pw(TS, e, ["ls"]);
    expect(tsLs.stdout).toBe(goLs.stdout);
    expect(goLs.stdout).toContain("bank/");
    const [gv, tv] = [await pw(GO, e, ["verify", "--full"]), await pw(TS, e, ["verify", "--full"])];
    expect(gv.code).toBe(0);
    expect(tv.stdout).toBe(gv.stdout);
    console.log("E2E go-vault-opens-in-ts + ts-changes-open-in-go: pass");
  }, 120_000);

  test("a vault made by passh-ts is read and changed by passh-go", async () => {
    const e = env("e2ets");
    await initVault(TS, e);
    expect((await pw(TS, e, ["generate", "a/b", "12"])).code).toBe(0);
    expect((await pw(GO, e, ["mv", "a/b", "c/d"])).code).toBe(0);
    expect((await pw(GO, e, ["generate", "z"])).code).toBe(0);
    expect((await pw(TS, e, ["rm", "--force", "z"])).code).toBe(0);
    const [g, t] = [await pw(GO, e, ["show", "c/d", "--field", "password"]), await pw(TS, e, ["show", "c/d", "--field", "password"])];
    expect(g.stdout.length).toBe(12);
    expect(t.stdout).toBe(g.stdout);
    const [gb, tb] = [await run([...GO, "backups"], e.env), await run([...TS, "backups"], e.env)];
    expect(tb).toEqual(gb);
    expect(gb.stdout.trim().split("\n").length).toBe(4); // one per save
    const [gv, tv] = [await run([...GO, "verify"], e.env), await run([...TS, "verify"], e.env)];
    expect(tv).toEqual(gv);
    console.log("E2E ts-vault-opens-in-go, alternating saves, shared backups listing, verify: pass");
  }, 120_000);

  test("passh-ts client with the passh-go agent, and passh-go client with the passh-ts agent", async () => {
    const e = env("e2eag");
    await initVault(GO, e);
    expect((await pw(GO, e, ["generate", "x"])).code).toBe(0);
    // Go agent, TS client (no terminal)
    expect((await pw(GO, e, ["unlock"])).code).toBe(0);
    const tsLs = await run([...TS, "ls"], e.env);
    expect(tsLs.code).toBe(0);
    expect(tsLs.stdout).toContain("x");
    const tsLock = await run([...TS, "lock"], e.env);
    expect(tsLock.code).toBe(0);
    expect(tsLock.stderr).toMatch(/^Locked: the agent \(pid \d+\) stopped\.\n$/);
    expect((await run([...TS, "ls"], e.env)).stderr).toContain("vault is locked");
    // TS agent, Go client
    const u = await pw(TS, e, ["unlock"]);
    expect(u.code).toBe(0);
    const goShow = await run([...GO, "show", "x", "--field", "password"], e.env);
    expect(goShow.code).toBe(0);
    expect(goShow.stdout.length).toBe(24);
    const goUnlock = await run([...GO, "unlock"], e.env);
    expect(goUnlock.code).toBe(0);
    expect(goUnlock.stderr).toMatch(/^Already unlocked: the agent \(pid \d+\) exits in /);
    const goLock = await run([...GO, "lock"], e.env);
    expect(goLock.stderr).toMatch(/^Locked: the agent \(pid \d+\) stopped\.\n$/);
    expect((await run([...GO, "ls"], e.env)).stderr).toContain("vault is locked");
    console.log("E2E agent: ts client <-> go agent and go client <-> ts agent: pass");
  }, 120_000);

  test("exports are byte-identical (json, csv, bitwarden-json)", async () => {
    const e = env("e2eex");
    await initVault(GO, e);
    const add = (path: string, password: string, user: string, url: string, tags: string, notes: string[]) =>
      pw(GO, e, ["add", path], [
        ["Password (empty to generate): ", password],
        ["Repeat password: ", password],
        ["Username: ", user],
        ["URL: ", url],
        ["Tags (comma-separated): ", tags],
        [/Notes \(end with an empty line\):\s*/, notes.join("\r") + "\r"],
      ]);
    expect((await add("work/github", "=s3cr3t,\"x\"", "arsenii", "https://github.com", "work, dev", ["line 1", "line, 2"])).code).toBe(0);
    expect((await add("Банк/счёт", "пароль 1", "иван", "", "деньги", [])).code).toBe(0);
    expect((await pw(GO, e, ["generate", "deep/a/b/c"])).code).toBe(0);
    expect((await pw(GO, e, ["unlock"])).code).toBe(0); // both export through the same agent
    for (const format of ["json", "csv", "bitwarden-json"]) {
      const go = await run([...GO, "export", "--format", format, "--confirm-plaintext"], e.env);
      const ts = await run([...TS, "export", "--format", format, "--confirm-plaintext"], e.env);
      expect(go.code).toBe(0);
      const norm = (s: string) => s.replace(/"exported_at": "[^"]+"/, '"exported_at": "T"');
      expect(norm(ts.stdout)).toBe(norm(go.stdout));
      expect(ts.stderr).toBe(go.stderr);
    }
    for (const bin of [GO, TS]) {
      const r = await run([...bin, "export", "--format", "csv", "--spreadsheet-safe", "--confirm-plaintext", "--tag", "work"], e.env);
      writeFileSync(join(e.dir, `ss-${bin === GO ? "go" : "ts"}.csv`), r.stdout);
    }
    expect(readFileSync(join(e.dir, "ss-ts.csv"), "utf8")).toBe(readFileSync(join(e.dir, "ss-go.csv"), "utf8"));
    console.log("E2E exports json/csv/bitwarden-json/--spreadsheet-safe byte-identical: pass");

    // text sheet
    const gp = await run([...GO, "print", "--confirm-plaintext"], e.env);
    const tp = await run([...TS, "print", "--confirm-plaintext"], e.env);
    const dateless = (s: string) => s.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, "DATE");
    expect(gp.code).toBe(0);
    expect(dateless(tp.stdout)).toBe(dateless(gp.stdout));
    console.log("E2E print text sheet byte-identical (date aside): pass");
    await run([...GO, "lock"], e.env);
  }, 180_000);

  test("recovery-key print sheets are identical; recover with the paper key works across", async () => {
    const e = env("e2erk");
    await initVault(TS, e);
    const sheets: string[] = [];
    for (const [bin, name] of [[GO, "go"], [TS, "ts"]] as const) {
      const out = join(e.dir, `rk-${name}.txt`);
      const r = await pw(bin, e, ["recovery-key", "print", "-o", out], [["Type PRINT RECOVERY KEY to confirm: ", "PRINT RECOVERY KEY"]]);
      expect(r.code).toBe(0);
      sheets.push(readFileSync(out, "utf8").replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, "DATE"));
    }
    expect(sheets[1]).toBe(sheets[0]);
    const key = sheets[0]!.match(/AGE-SECRET-KEY-1\n((?:[A-Z0-9 ]+\n){2}[A-Z0-9 ]+)/);
    expect(key).not.toBeNull();
    // passh-go recover with the sheet produced from our vault, then passh-ts opens it with the new passphrase
    const typed = "AGE-SECRET-KEY-1\r" + key![1]!.split("\n").join("\r") + "\r\r";
    const p = spawnPty([...GO, "recover"], e.env);
    await p.expect("> ");
    p.send(typed);
    await p.expect("New passphrase: ");
    p.line("another passphrase words here");
    await p.expect("Repeat passphrase: ");
    p.line("another passphrase words here");
    const rr = await p.wait();
    expect(rr.code).toBe(0);
    const ls = await withPassphrase(TS, ["ls"], e, "another passphrase words here");
    expect(ls.code).toBe(0);
    console.log("E2E recovery-key sheet identical; go recover of ts vault; ts opens with the new passphrase: pass");
  }, 120_000);

  test.skipIf(!existsSync(AGE))("stock age opens a passh-ts vault with the spec §8 commands", async () => {
    const e = env("e2eage");
    await initVault(TS, e);
    expect((await pw(TS, e, ["generate", "k"])).code).toBe(0);
    const shm = join(e.runtimeDir, "rec");
    mkdirSync(shm, { recursive: true, mode: 0o700 });
    const sh = (cmd: string) => Bun.spawnSync(["/bin/bash", "-c", cmd], { env: e.env, cwd: e.dir });
    sh(`tr -d '\\r' < ${e.vault} | awk '/BEGIN AGE ENCRYPTED FILE/{n++} n==1{print} n==1 && /END AGE ENCRYPTED FILE/{exit}' > key.age`);
    sh(`tr -d '\\r' < ${e.vault} | awk '/BEGIN AGE ENCRYPTED FILE/{n++} n==2{print} n==2 && /END AGE ENCRYPTED FILE/{exit}' > data.age`);
    const p = spawnPty([AGE, "-d", "-o", join(shm, "key.txt"), join(e.dir, "key.age")], e.env);
    await p.expect(/passphrase/i);
    p.line(PASS);
    expect((await p.wait()).code).toBe(0);
    const d = sh(`${AGE} -d -i ${shm}/key.txt -o ${shm}/vault.json data.age`);
    expect(d.exitCode).toBe(0);
    const json = JSON.parse(readFileSync(join(shm, "vault.json"), "utf8"));
    expect(json.format).toBe("passh-vault-data");
    expect(json.entries[0].path).toBe("k");
    console.log("E2E stock age 1.3.2 recovers the JSON of a passh-ts vault (§8): pass");
  }, 120_000);

  test("unlock cost (scrypt 2^18): passh-ts vs passh-go", async () => {
    const e = env("e2etm");
    await initVault(GO, e);
    const times: Record<string, number> = {};
    for (const [bin, name] of [[GO, "go"], [TS, "ts"]] as const) {
      const t0 = performance.now();
      const r = await pw(bin, e, ["ls"]);
      times[name] = performance.now() - t0;
      expect(r.code).toBe(0);
    }
    console.log(`E2E timing: ls with passphrase (scrypt) go ${times.go!.toFixed(0)} ms, ts ${times.ts!.toFixed(0)} ms`);
  }, 120_000);
});
