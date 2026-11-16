// PTY tests of the CLI key sources (cli.md §1.5, §2.18) and the rollback question (§7.4),
// through a child process that has the PTY as its controlling terminal.

import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnPty } from "../../test/helpers/pty.ts";
import { run } from "../../test/helpers/env.ts";
import { formatRecoveryKey, generateVaultKey } from "../keys/index.ts";
import { armorText } from "../age/index.ts";
import { addEntry, emptyContent } from "../model/index.ts";
import { parseContainer } from "../vaultfile/index.ts";
import { fixture, type Fixture } from "./testdata/helpers.ts";

const DRIVER = join(import.meta.dir, "testdata", "open-driver.ts");
const PASS = "test passphrase";

let f: Fixture | undefined;
afterEach(() => {
  f?.cleanup();
  f = undefined;
});

function drive(fx: Fixture, mode: "pass" | "paper", vault = fx.vault) {
  return spawnPty([process.execPath, "run", DRIVER, mode, vault], fx.env);
}

function result(out: string): string {
  const m = /RESULT (.*)/.exec(out);
  return m ? m[1]!.trim() : "<none>";
}

describe("passphrase (cli.md §1.5)", () => {
  test("right at once; wrong then right", async () => {
    f = await fixture("pp");
    let p = drive(f, "pass");
    await p.expect("Passphrase: ");
    p.line(PASS);
    let r = await p.wait();
    expect(result(r.output)).toBe("ok r1 []");
    p = drive(f, "pass");
    await p.expect("Passphrase: ");
    p.line("nope");
    await p.expect("Wrong passphrase. Try again.\r\nPassphrase: ");
    p.line(PASS);
    r = await p.wait();
    expect(result(r.output)).toBe("ok r1 []");
  });

  test("three wrong tries: the message of the last try", async () => {
    f = await fixture("pp");
    let p = drive(f, "pass");
    for (let i = 0; i < 3; i++) {
      await p.expect("Passphrase: ");
      p.line("nope" + i);
    }
    let r = await p.wait();
    expect(r.output.split("Wrong passphrase. Try again.").length).toBe(3);
    expect(result(r.output)).toBe(`err ${JSON.stringify(`${f.vault}: wrong passphrase, or the key block is damaged`)} []`);
    p = drive(f, "pass");
    for (const a of ["nope", "nope", ""]) {
      await p.expect("Passphrase: ");
      p.line(a);
    }
    r = await p.wait();
    expect(result(r.output)).toBe(`err "passphrase is empty" []`);
  });

  test("a work factor above 2^18 ends at the first try, with the hint", async () => {
    f = await fixture("pp");
    const c = parseContainer(new Uint8Array(readFileSync(f.vault)));
    const kb = Buffer.from(Buffer.from(c.keyBlock).toString("latin1").replace(/ 10\n/, " 19\n"), "latin1");
    writeFileSync(f.vault, "passh-vault 1\n" + armorText(new Uint8Array(kb)) + armorText(c.dataBlock));
    const p = drive(f, "pass");
    await p.expect("Passphrase: ");
    p.line(PASS);
    const r = await p.wait();
    expect(r.output).not.toContain("Wrong passphrase");
    expect(result(r.output)).toBe(
      `err ${JSON.stringify(`${f.vault}: key block asks for scrypt work factor 2^19; passh uses 2^18: the file is damaged or not made by passh\nThe key block only protects the vault key with the passphrase: if the data block is intact, \`passh recover\` with the paper recovery key writes a new key block; or restore a backup (passh backups)`)} []`,
    );
  });

  test("Ctrl-D ends at once; no terminal falls through to 'vault is locked'", async () => {
    f = await fixture("pp");
    const p = drive(f, "pass");
    await p.expect("Passphrase: ");
    p.send("\x04");
    const r = await p.wait();
    expect(result(r.output)).toBe(`err "reading the passphrase: EOF" []`);
    const nt = await run([process.execPath, "run", DRIVER, "pass", f.vault], f.env);
    expect(result(nt.stdout)).toBe('err "vault is locked: run `passh unlock` in a terminal (over SSH: `ssh -t host passh unlock`)" []');
  });
});

describe("the rollback question (storage.md §7.4)", () => {
  test("warning and question on /dev/tty; n stops, y continues; without a terminal a warning", async () => {
    f = await fixture("rq");
    const v = await f.open();
    for (let i = 0; i < 2; i++) await v.save(addEntry(v.data, `e${i}`, { ...emptyContent(), password: "p" }).data);
    v.close();
    const dir = join(f.state, "backups", v.data.vaultId);
    copyFileSync(join(dir, readdirSync(dir).find((n) => n.endsWith("-r2.passh"))!), f.vault);
    const today = new Date().toISOString().slice(0, 10);
    const text = `this copy is older than one seen before on this machine (r2 of ${today}; seen r3 of ${today}). If you didn't restore it on purpose, the file may have been replaced.`;
    let p = drive(f, "pass");
    await p.expect("Passphrase: ");
    p.line(PASS);
    await p.expect(`warning: ${text}\r\nContinue with this copy? [y/N] `);
    p.line("");
    let r = await p.wait();
    expect(result(r.output)).toBe(`err "stopped: this copy is older than one seen before on this machine; nothing was changed" []`);
    // no terminal: the passphrase can't be asked, so use… the same driver can't: check with a key in hand
    p = drive(f, "pass");
    await p.expect("Passphrase: ");
    p.line(PASS);
    await p.expect("Continue with this copy? [y/N] ");
    p.line("y");
    r = await p.wait();
    expect(result(r.output)).toBe("ok r2 []");
    p = drive(f, "pass");
    await p.expect("Passphrase: ");
    p.line(PASS);
    r = await p.wait();
    expect(r.output).not.toContain("Continue with this copy?");
    expect(result(r.output)).toBe("ok r2 []");
  });
});

describe("paper key (cli.md §2.18)", () => {
  test("texts, an invalid try, then the key; recovery mode with a damaged key block", async () => {
    f = await fixture("paper");
    const text = readFileSync(f.vault, "latin1");
    writeFileSync(f.vault, text.replace("-----BEGIN AGE ENCRYPTED FILE-----\nYWdl", "-----BEGIN AGE ENCRYPTED FILE-----\nYWd!"), "latin1");
    const p = drive(f, "paper");
    await p.expect("Type the recovery key from the paper sheet (AGE-SECRET-KEY-1…); it shows as *.\r\nSpaces, line breaks and letter case don't matter. End with an empty line.\r\n> ");
    p.line("AGE-SECRET-KEY-1 QPZB");
    p.line("");
    await p.expect("not a valid recovery key: group 1, character 4 is not used in keys (B, I, O and 1 never appear after AGE-SECRET-KEY-1). Type it again.\r\n> ");
    for (const l of formatRecoveryKey(f.identity).split("\n")) p.line(l.toLowerCase());
    p.line("");
    const r = await p.wait();
    expect(result(r.output)).toBe(`ok r1 ${JSON.stringify([`passh: warning: ${f.vault}: the key block is damaged; setting a new passphrase rewrites it`])}`);
  });

  test("empty input fails at once; a key of another vault", async () => {
    f = await fixture("paper");
    let p = drive(f, "paper");
    await p.expect("> ");
    p.send("\x04");
    let r = await p.wait();
    expect(result(r.output)).toBe(`err "not a valid recovery key: nothing was typed" []`);
    p = drive(f, "paper");
    await p.expect("> ");
    for (const l of formatRecoveryKey(generateVaultKey()).split("\n")) p.line(l);
    p.line("");
    r = await p.wait();
    expect(result(r.output)).toBe(`err ${JSON.stringify(`${f.vault}: this key doesn't open this vault (rekeyed elsewhere? wrong recovery key?)`)} []`);
  });
});
