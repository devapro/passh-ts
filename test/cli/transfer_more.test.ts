// Side by side with the reference: `passh import pass` (cli.md §2.22, import-export.md §1) with a
// fake gpg (src/importpass/testdata/fake-gpg.sh, first in $PATH as gpg2 and gpg, inside the
// isolated env) and `passh export` (cli.md §2.23, import-export.md §2.1) in every format, with
// its checks and refusals. Each side has its own isolated env and a byte-identical vault.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, type IsolatedEnv } from "../helpers/env.ts";
import { bothMore, killAgentsUnder, makePair, PASS, PASSPHRASE_STEP, visible, type MoreRunOptions, type Pair, type Step } from "./side_more.ts";
import { buildVault, readVault, type BuiltVault } from "./vaults.ts";

setDefaultTimeout(120_000);

const FAKE_GPG = join(ROOT, "src/importpass/testdata/fake-gpg.sh");
let vault: BuiltVault;
const pairs: Pair[] = [];

beforeAll(async () => {
  vault = await buildVault([
    { path: "mail", password: "pw2", tags: ["home"] },
    { path: "work/github", password: "=1+2", username: "alice", url: "https://github.com", tags: ["dev", "work"], fields: [["pin", "1234"], ["otp", "otpauth://totp/x?secret=AB"]], notes: "n1\nn2" },
    { path: "work/gitlab", password: "@x", tags: ["work"] },
    { path: "workshop/x", password: "-y", fields: [["a", "b"]] },
    { path: "work", password: "top" },
  ]);
});

afterAll(() => {
  for (const p of pairs) {
    for (const e of [p.ref, p.ours]) {
      killAgentsUnder(e.dir);
      try {
        chmodSync(join(e.storeDir, "noread"), 0o700);
      } catch {}
    }
    p.cleanup();
  }
});

async function newPair(setup?: (e: IsolatedEnv) => void, extra = ""): Promise<Pair> {
  const p = await makePair("tra", vault.bytes, extra);
  pairs.push(p);
  for (const e of [p.ref, p.ours]) setup?.(e);
  return p;
}

async function same(p: Pair, args: string[], o: MoreRunOptions = {}) {
  const r = await bothMore(p, args, o);
  expect(visible(r.ours)).toEqual(visible(r.ref));
  return r;
}

// ---------------------------------------------------------------------------
// import pass

/** A fake-gpg "ciphertext" that decrypts to `plain`. */
function ok(plain: string): string {
  return "#!fake-gpg\nstatus DECRYPTION_OKAY\n--\n" + plain;
}

/** gpg2 and gpg in a bin folder first in $PATH (both names: passh looks for gpg2 first). */
function fakeGpgEnv(e: IsolatedEnv): Record<string, string> {
  const bin = join(e.dir, "bin");
  if (!existsSync(bin)) {
    mkdirSync(bin);
    symlinkSync(FAKE_GPG, join(bin, "gpg2"));
    symlinkSync(FAKE_GPG, join(bin, "gpg"));
  }
  return { PATH: `${bin}:${e.env.PATH}` };
}

function store(e: IsolatedEnv, files: Record<string, string | Uint8Array>) {
  for (const [name, content] of Object.entries(files)) {
    const f = join(e.storeDir, name);
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, content);
  }
}

const STORE: Record<string, string | Uint8Array> = {
  "work/example.gpg": ok("pw1\nuser: alice\nurl: https://example.com\ntags: a, b\nextra: field\n---\nnote line\n"),
  "email/user.gpg": ok("pw\nlogin: bob\n"),
  "mail.gpg": ok("replaced\n"),
  "broken.gpg": "not an openpgp message",
  "badpass.gpg": "#!fake-gpg\nstatus BAD_PASSPHRASE 1234\nexit 2\n",
  "nokey.gpg": "#!fake-gpg\nstatus NO_SECKEY ABCDEF0123456789\nexit 2\n",
  "latin1.gpg": new Uint8Array([...new TextEncoder().encode("#!fake-gpg\nstatus DECRYPTION_OKAY\n--\n"), 0x70, 0xe9, 0x0a]),
  "empty.gpg": ok(""),
  "-bad.gpg": ok("x\n"),
  ".gpg-id": "someone@example.com\n",
  ".git/config.gpg": ok("ignored\n"),
  "readme.txt": "not an entry",
  "esc\x1b[31m.gpg": ok("escaped name\n"),
};

function withStore(e: IsolatedEnv) {
  store(e, STORE);
  symlinkSync("/etc/hostname", join(e.storeDir, "etclink.gpg"));
  symlinkSync("nothing.gpg", join(e.storeDir, "dangling.gpg"));
  symlinkSync("work", join(e.storeDir, "workdir.gpg"));
  symlinkSync("email/user.gpg", join(e.storeDir, "alias.gpg"));
}

const pty = (env?: MoreRunOptions["env"], steps: Step[] = [PASSPHRASE_STEP]): MoreRunOptions => ({ pty: true, steps, env });

describe("import pass", () => {
  test("dry run, real run, then everything already in the vault", async () => {
    const p = await newPair(withStore);
    const d = await same(p, ["import", "pass", "--dry-run"], pty());
    expect(d.ref.code).toBe(0);
    expect(d.ref.stdout).toContain("Dry run: nothing was decrypted or saved. Store: <ENV>/store\n");
    const r = await same(p, ["import", "pass"], pty(fakeGpgEnv));
    expect(r.ref.code).toBe(0);
    expect(r.ref.stdout).toContain("Imported ");
    // Both vaults hold the same imported entries (ids and times differ).
    const paths = (e: IsolatedEnv) => readVault(e.vault, vault.identity).entries.map((x) => [x.path, x.password, x.username, x.url, x.tags, x.fields.map((f) => [f.key, f.value]), x.notes]);
    expect(paths(p.ours)).toEqual(paths(p.ref));
    await same(p, ["import", "pass"], pty(fakeGpgEnv));
    await same(p, ["import", "pass", "--overwrite", "--dry-run"], pty());
  });

  test("--overwrite replaces existing entries", async () => {
    const p = await newPair((e) => store(e, { "mail.gpg": ok("new\nuser: u\n"), "work/github.gpg": ok("gh\n"), "new.gpg": ok("n\n") }));
    const r = await same(p, ["import", "pass", "--overwrite"], pty(fakeGpgEnv));
    expect(r.ref.stdout).toContain("(2 replacing entries already in the vault)");
    const mail = (e: IsolatedEnv) => readVault(e.vault, vault.identity).entries.find((x) => x.path === "mail")!;
    expect(mail(p.ours).password).toBe("new");
    expect(mail(p.ours).id).toBe(vault.data.entries.find((x) => x.path === "mail")!.id);
  });

  test("a [dir] argument: relative, ~/, missing, a file; an empty store", async () => {
    const p = await newPair((e) => {
      store(e, { "work/x.gpg": ok("x\n") });
      mkdirSync(join(e.home, "emptystore"));
      writeFileSync(join(e.home, "afile"), "x");
    });
    const cwd = (e: IsolatedEnv) => e.dir;
    for (const dir of ["store", "~/emptystore", "~/nostore", "~/afile"]) await same(p, ["import", "pass", dir], { ...pty(fakeGpgEnv), cwd });
    await same(p, ["import", "pass", "a", "b"]);
  });

  test("$PASSWORD_STORE_DIR unset: ~/.password-store", async () => {
    const p = await newPair((e) => {
      mkdirSync(join(e.home, ".password-store"));
      writeFileSync(join(e.home, ".password-store", "p.gpg"), ok("p\n"));
    });
    await same(p, ["import", "pass", "--dry-run"], { ...pty(), unset: ["PASSWORD_STORE_DIR"] });
  });

  test("canceled at gpg's passphrase prompt: nothing saved", async () => {
    const p = await newPair((e) => store(e, { "a.gpg": ok("a\n"), "b.gpg": "#!fake-gpg\nstatus ERROR pkdecrypt_failed 99\nexit 2\n" }));
    const r = await same(p, ["import", "pass"], pty(fakeGpgEnv));
    expect(r.ref.stderr).toBe("passh: import canceled at the passphrase prompt\n");
  });

  test("gpg not found", async () => {
    const p = await newPair((e) => store(e, { "a.gpg": ok("a\n") }));
    const r = await same(p, ["import", "pass"], pty((e) => ({ PATH: join(e.dir, "nobin") })));
    expect(r.ref.code).toBe(1);
  });

  test("no terminal: vault is locked; no config; no vault", async () => {
    const p = await newPair((e) => store(e, { "a.gpg": ok("a\n") }));
    await same(p, ["import", "pass"]);
    await same(p, ["import", "pass", "--dry-run"]);
    await same(p, ["import"]);
    await same(p, ["import", "git"]);
    await same(p, ["--vault", "~/none.passh", "import", "pass"]);
  });

  test("progress on a terminal stderr", async () => {
    const p = await newPair((e) => store(e, { "a.gpg": ok("a\n"), "b.gpg": ok("b\n"), "c.gpg": "junk" }));
    const r = await same(p, ["import", "pass"], { ...pty(fakeGpgEnv), stderrOnTty: true });
    expect(r.ref.tty).toContain("\rDecrypting 3/3…\x1b[K\r\x1b[K");
  });
});

// ---------------------------------------------------------------------------
// export

const EXPORT_STEPS: Step[] = [["Type EXPORT PLAINTEXT to confirm: ", "EXPORT PLAINTEXT"], PASSPHRASE_STEP];
const EXPORTED_AT: Array<[RegExp, string]> = [
  [/"exported_at": ?"[^"]*"/g, '"exported_at":"<T>"'],
  [/-----BEGIN AGE ENCRYPTED FILE-----\n[\s\S]*-----END AGE ENCRYPTED FILE-----\n/g, "<AGE ARMOR>\n"],
];

describe("export", () => {
  for (const format of ["csv", "json", "bitwarden-json"]) {
    test(`${format} to stdout, all and filtered`, async () => {
      const p = await newPair();
      for (const extra of [[], ["--folder", "work"], ["--tag", "work"], ["--tag", "work,dev"], ["--tag", "nope"], ["--tag", ""]]) {
        const r = await same(p, ["export", "--format", format, ...extra], { pty: true, steps: EXPORT_STEPS, replace: EXPORTED_AT });
        expect(r.ref.code).toBe(0);
      }
    });
  }

  test("csv --spreadsheet-safe", async () => {
    const r = await same(await newPair(), ["export", "--format", "csv", "--spreadsheet-safe"], { pty: true, steps: EXPORT_STEPS });
    expect(r.ref.stdout).toContain("'=1+2");
  });

  test("-o: a new file 0600, the tmpfs warning; then refused", async () => {
    const p = await newPair();
    const r = await same(p, ["export", "--format", "json", "-o", "~/out.json"], { pty: true, steps: EXPORT_STEPS, replace: EXPORTED_AT });
    expect(r.ref.stderr).toContain("isn't on tmpfs");
    const norm = (e: IsolatedEnv) => readFileSync(join(e.home, "out.json"), "utf8").replace(EXPORTED_AT[0]![0], "");
    expect(norm(p.ours)).toBe(norm(p.ref));
    await same(p, ["export", "--format", "json", "-o", "~/out.json"], { pty: true, steps: EXPORT_STEPS });
    // On tmpfs ($XDG_RUNTIME_DIR of the isolated env is under /dev/shm): no warning.
    const t = await same(p, ["export", "--format", "csv", "--output=out.csv"], { pty: true, steps: EXPORT_STEPS, cwd: (e) => e.runtimeDir });
    expect(t.ref.code).toBe(0);
    expect(t.ref.stderr).toBe("passh: exported 5 entries (csv, plaintext) to <RUN>/out.csv\npassh: warning: CSV has no column for custom fields: 3 fields were left out (otp fields included); use --format json or bitwarden-json to keep them\n");
  });

  test("--age: encrypted to a recipient, no confirmation", async () => {
    const recipient = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";
    const p = await newPair();
    const r = await same(p, ["export", "--format", "json", "--age", recipient], { pty: true, steps: [PASSPHRASE_STEP], replace: EXPORTED_AT });
    expect(r.ref.stdout).toBe("<AGE ARMOR>\n");
    expect(r.ref.stderr).toContain("(json, encrypted with age) to stdout");
    for (const bad of ["age1nope", "AGE-SECRET-KEY-1XYZ", "ssh-ed25519 AAAA"]) await same(p, ["export", "--format", "json", "--age", bad]);
  });

  test("checks and refusals, in order", async () => {
    const p = await newPair((e) => writeFileSync(join(e.home, "exists"), "x"));
    const cases: string[][] = [
      ["export"],
      ["export", "--format", ""],
      ["export", "--format", "CSV"],
      ["export", "--format", "x", "--folder", "a//b"],
      ["export", "--format", "csv", "--folder", "a//b", "--tag", "x\x01"],
      ["export", "--format", "csv", "--tag", "x\x01"],
      ["export", "--format", "csv", "--tag", '"a,b"'],
      ["export", "--format", "csv", "--tag", 'a"b'],
      ["export", "--format", "csv", "--age", "age1x", "--confirm-plaintext"],
      ["export", "--format", "json", "--spreadsheet-safe"],
      ["export", "--format", "csv", "-o", "~/exists"],
      ["export", "--format", "csv"],
      ["export", "--format", "csv", "--confirm-plaintext"],
      ["export", "--format", "csv", "extra"],
    ];
    for (const c of cases) await same(p, c);
  });

  test("a terminal on stdout is refused (also with --age)", async () => {
    const p = await newPair();
    await same(p, ["export", "--format", "csv"], { pty: true, stdoutOnTty: true });
    await same(p, ["export", "--format", "csv", "--age", "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"], { pty: true, stdoutOnTty: true });
  });

  test("the typed phrase: wrong, empty (EOF), and asked even with --confirm-plaintext", async () => {
    const p = await newPair();
    await same(p, ["export", "--format", "csv"], { pty: true, steps: [["confirm: ", "export plaintext"]] });
    await same(p, ["export", "--format", "csv"], { pty: true, steps: [["confirm: ", "\x04", "raw"]] });
    await same(p, ["export", "--format", "csv", "--confirm-plaintext"], { pty: true, steps: EXPORT_STEPS });
  });

  test("config and vault are needed only at the key", async () => {
    const p = await newPair();
    for (const e of [p.ref, p.ours]) writeFileSync(e.configFile, "bogus = 1\n");
    await same(p, ["export", "--format", "csv"]);
    await same(p, ["export", "--format", "csv", "--confirm-plaintext"]);
    await same(p, ["--vault", "~/none.passh", "export", "--format", "csv", "--confirm-plaintext"]);
  });

  // KNOWN DIFFERENCE (audit #4, proposed fix): `--age ""` is an error here; the reference
  // takes it as no --age (a plaintext export).
  test('--age "" (audit #4, the proposed fix)', async () => {
    const p = await newPair();
    const r = await bothMore(p, ["export", "--format", "csv", "--age", "", "--confirm-plaintext"]);
    expect(r.ref.code).toBe(1);
    expect(r.ref.stderr).toContain("vault is locked");
    expect(r.ours.code).toBe(2);
    expect(r.ours.stderr).toContain("--age and --confirm-plaintext can't be used together");
  });
});

test("the passphrase helper", () => expect(PASS).toBeTruthy());
