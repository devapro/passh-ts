// Interop of printing (src/print, src/printweb, src/qr) with the reference implementation
// (reference/passh-go, run as a black box).
//
//   a. text sheets: passh-go `print -o … --confirm-plaintext` (all fields, defaults, custom
//      keys, --folder, --tag, several pages) equals our renderText of the same entries;
//   b. errors of the sheet model (no match, unknown custom key) have passh-go's texts;
//   c. the frame in ru and sr: password sheets byte for byte, the recovery sheet's frame;
//   d. the recovery key text sheet byte for byte;
//   e. the print page, if this machine has a private address: the dialog (notice, skipped
//      addresses, QR codes of the URLs, fingerprint lines), the responses (404, 421, 405,
//      200 with the page, chunk by chunk) of passh-go and of our server for the same sheet,
//      for the password sheet and the recovery sheet (QR as SVG).
//
// The vault's data block is written with our crypto (src/keys) so that the fixtures can
// hold anything the data format allows; an agent (`passh unlock`) serves passh-go.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import * as tls from "node:tls";
import { join } from "node:path";
import { isolatedEnv, REF_BIN, run, type IsolatedEnv } from "../helpers/env.ts";
import { initVault, PASS, withPassphrase } from "../helpers/passh.ts";
import { spawnPty } from "../helpers/pty.ts";
import { decryptData, encryptData, unwrapKeyBlock, type X25519Identity } from "../../src/keys/index.ts";
import { encodeContainer, parseContainer } from "../../src/vaultfile/index.ts";
import { parseVaultData } from "../../src/model/index.ts";
import type { Entry } from "../../src/model/types.ts";
import { registerCatalog, setLanguage } from "../../src/i18n/index.ts";
import { buildPasswordSheet, buildRecoverySheet, parseFields, renderText, PRINT_CATALOG_RU, PRINT_CATALOG_SR, type Sheet } from "../../src/print/index.ts";
import { encodeText, renderTerminal } from "../../src/qr/index.ts";
import { dialogLines, listInterfaces, noAddressError, planAddresses, startPrintPage, type PrintPage } from "../../src/printweb/index.ts";
import { formatAddr } from "../../src/config/cidr.ts";

setDefaultTimeout(120_000);

const te = new TextEncoder();
const td = new TextDecoder();

let e: IsolatedEnv;
let identity: X25519Identity;
let keyBlock: Uint8Array;
let vaultId = "";
let revision = 1000n;

// ---------------------------------------------------------------------------
// Fixtures

interface Spec {
  path: string;
  password?: string;
  username?: string;
  url?: string;
  tags?: string[];
  fields?: Array<[string, string]>;
  notes?: string;
}

function many(): Spec[] {
  const out: Spec[] = [];
  for (let i = 1; i <= 40; i++) out.push({ path: `many/e${String(i).padStart(2, "0")}`, password: `pw0l${i}`, username: "user", notes: "line1\nline2\nline3", tags: i % 3 === 0 ? ["three"] : [] });
  return out;
}

const SPECS: Spec[] = [
  { path: "email", password: "Pa55 w0rd!", username: "me@example.com" },
  { path: "bank/main", password: "Xk0Olp1I", username: "alice", url: "https://bank.example", tags: ["money", "2fa"], notes: "PIN in the safe\n\tcard 2" },
  {
    path: "work/github",
    password: "aB3$".repeat(20) + "lI0O",
    username: "alice",
    url: "https://github.com",
    fields: [
      ["recovery-email", "me+gh@example.com"],
      ["pin", "0101"],
    ],
  },
  { path: "work/dev/aws", password: "zero\u200bwidth", username: "root" },
  { path: "work-old/x", password: "old" },
  { path: "workshop/y", password: "shop" },
  {
    path: "日本/東京/口座",
    password: "密码パスワード0O",
    username: "ユーザー名l1",
    url: "https://例え.jp/パス",
    tags: ["日本", "l0l"],
    notes: "全角のメモ。行が長い場合は折り返されます。全角のメモ。行が長い場合は折り返されます。全角の",
  },
  { path: "emoji/🔑 keys", password: "🔑 key 🗝️ 0", username: "user 👍🏽 l", notes: "notes with emoji 🎉 and ZWJ 👨\u200d👩\u200d👧 family" },
  { path: "combining/marks", password: "cafe\u0301 0\u0301 \u0301x", username: "\u0301start", url: "e\u0308\u0301", notes: " \u0301 space-mark in notes 1\u0301" },
  { path: "ambiguous", password: "0O1lI 0O1lI", username: "lIlI1O0", tags: ["mail", "l0l"] },
  { path: "spaces", password: "pw  ", username: " lead", notes: "   \nline after blank\n\n\t\n" },
  { path: "whitespace-notes", password: "x", notes: "  \t \n \n" },
  { path: "empty-first-notes-line", password: "y", notes: "\nsecond line" },
  { path: "control", password: "a\tb\x1b[31m", username: "\x7fdel\x00", url: "https://x.example/?q=a b", notes: "cr\rhere\x07bell" },
  { path: "nbsp", password: "a\u00a0b\u2007c\ue000d\u0378e", username: "x\u200by", url: "\u202eevil", notes: "nb\u00a0sp" },
  {
    path: "long-key",
    password: "z",
    fields: [
      ["k".repeat(100), "v1"],
      ["emptyval", ""],
      ["PIN", "1234"],
      ["pin", "0000"],
      ["Notes", "custom notes field"],
      ["password", "custom pw"],
      ["ключ", "значение 0"],
    ],
    notes: "real notes",
  },
  { path: "f" + "o".repeat(90) + "/name", password: "deep" },
  { path: "top-" + "n".repeat(100), password: "long name" },
  { path: "lots/of/notes", password: "split", notes: Array.from({ length: 70 }, (_, i) => `note line ${i + 1} l0`).join("\n") },
  { path: "boundary", password: "x".repeat(67) + "漢" + "y", url: "u".repeat(68) + "1" },
  { path: "nbsp\u00a0folder/entry", password: "in nbsp folder", tags: ["a", "b"] },
  { path: "cyr", password: "кириллица O0", tags: ["тег", "Tag", "a", "b"] },
  { path: "a/b/c/d/deep", password: "nested", tags: ["a"] },
  ...many(),
];

function toEntries(specs: readonly Spec[]): Entry[] {
  return specs.map((s, i) => ({
    id: `id-${i}`,
    path: s.path,
    password: s.password ?? "",
    username: s.username ?? "",
    url: s.url ?? "",
    tags: s.tags ?? [],
    fields: (s.fields ?? []).map(([key, value]) => ({ key, value, unknown: new Map() })),
    notes: s.notes ?? "",
    createdAt: 0,
    updatedAt: 0,
    unknown: new Map(),
  }));
}

const ENTRIES = toEntries(SPECS);

function writeVault(specs: readonly Spec[]): void {
  revision += 10n;
  const data = {
    format: "passh-vault-data",
    version: 1,
    vault_id: vaultId,
    revision: Number(revision),
    saved_at: "2026-11-16T10:00:00Z",
    entries: specs.map((s, i) => ({
      id: `id-${i}`,
      path: s.path,
      password: s.password ?? "",
      username: s.username ?? "",
      url: s.url ?? "",
      tags: s.tags ?? [],
      fields: (s.fields ?? []).map(([key, value]) => ({ key, value })),
      notes: s.notes ?? "",
      created_at: "2026-11-16T10:00:00Z",
      updated_at: "2026-11-16T10:00:00Z",
    })),
    deleted: [],
  };
  writeFileSync(e.vault, encodeContainer(keyBlock, encryptData(te.encode(JSON.stringify(data)), identity)), { mode: 0o600 });
}

const ref = (...args: string[]) => run([REF_BIN, ...args], e.env);

let configBase = "";
function setConfig(extra: string): void {
  writeFileSync(e.configFile, configBase + "\n" + extra + "\n");
}

beforeAll(async () => {
  e = isolatedEnv("print");
  await initVault([REF_BIN], e);
  configBase = `vault = ${JSON.stringify(e.vault)}\n`;
  writeFileSync(e.configFile, configBase);
  const c = parseContainer(new Uint8Array(readFileSync(e.vault)));
  keyBlock = c.keyBlock;
  identity = await unwrapKeyBlock(keyBlock, te.encode(PASS));
  vaultId = parseVaultData(decryptData(c.dataBlock, identity, "agent")).vaultId;
  writeVault(SPECS);
  const u = await withPassphrase([REF_BIN], ["unlock"], e);
  if (u.code !== 0) throw new Error("unlock failed: " + u.tty);
});

afterAll(async () => {
  setLanguage("en");
  if (!e) return;
  await run([REF_BIN, "lock"], e.env);
  e.cleanup();
});

/** The print date of a sheet's first line, as a local Date. */
function sheetDate(text: string): Date {
  const m = /(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)/.exec(text);
  if (!m) throw new Error("no date in: " + text.slice(0, 200));
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

let outN = 0;
async function refSheet(args: string[]): Promise<{ code: number; text: string; stderr: string }> {
  const out = join(e.dir, `sheet-${outN++}.txt`);
  const r = await ref("print", "-o", out, "--confirm-plaintext", ...args);
  let text = "";
  try {
    text = readFileSync(out, "utf8");
    rmSync(out);
  } catch {}
  return { code: r.code, text, stderr: r.stderr };
}

function ours(text: string, opts: { fields?: string; folder?: string; tags?: string[] }): string {
  const sheet = buildPasswordSheet({ entries: ENTRIES, folder: opts.folder ?? "", tags: opts.tags ?? [], fields: parseFields(opts.fields), printedAt: sheetDate(text) });
  return renderText(sheet);
}

/** Line-by-line comparison first (readable failures), then the bytes. */
function sameText(got: string, want: string): void {
  if (got !== want && process.env.PRINT_DEBUG) {
    writeFileSync(join(process.env.PRINT_DEBUG, "got.txt"), got);
    writeFileSync(join(process.env.PRINT_DEBUG, "want.txt"), want);
  }
  const g = got.split("\n");
  const w = want.split("\n");
  for (let i = 0; i < Math.max(g.length, w.length); i++) {
    if (g[i] !== w[i]) {
      expect({ line: i + 1, got: g[i] }).toEqual({ line: i + 1, got: w[i] });
    }
  }
  expect(got).toBe(want);
}

// ---------------------------------------------------------------------------

const CASES: Array<{ name: string; args: string[]; fields?: string; folder?: string; tags?: string[] }> = [
  { name: "every field", args: ["--fields", "password,username,url,tags,notes,fields"], fields: "password,username,url,tags,notes,fields" },
  { name: "default fields", args: [] },
  { name: "custom keys and case", args: ["--fields", " fields , PIN,Notes,pin,  ,PASSWORD,ключ"], fields: " fields , PIN,Notes,pin,  ,PASSWORD,ключ" },
  { name: "--folder with several pages", args: ["--folder", "many", "--fields", "notes,password,username,tags"], fields: "notes,password,username,tags", folder: "many" },
  { name: "--folder work (segment-aware)", args: ["--folder", "work", "--fields", "password,url"], fields: "password,url", folder: "work" },
  { name: "one --tag", args: ["--tag", "l0l", "--fields", "tags,password"], fields: "tags,password", tags: ["l0l"] },
  { name: "two --tag, repeats kept", args: ["--tag", "a,b", "--tag", "a"], tags: ["a", "b", "a"] },
  { name: "--folder and --tag", args: ["--folder", "nbsp\u00a0folder", "--tag", "a"], folder: "nbsp\u00a0folder", tags: ["a"] },
  { name: "a long note split across pages", args: ["--folder", "lots", "--fields", "notes"], fields: "notes", folder: "lots" },
  { name: "a word longer than a meta line", args: ["--folder", "f" + "o".repeat(90)], folder: "f" + "o".repeat(90) },
  { name: "--tag with a long scope", args: ["--tag", "a", "--tag", "b", "--tag", "a", "--tag", "b", "--tag", "a", "--tag", "b", "--tag", "a", "--tag", "b", "--tag", "a", "--tag", "b", "--tag", "a", "--tag", "b", "--tag", "a", "--tag", "b", "--tag", "a", "--tag", "b", "--tag", "a", "--tag", "b", "--tag", "a", "--tag", "b"], tags: Array.from({ length: 20 }, (_, i) => (i % 2 ? "b" : "a")) },
];

describe("a. text sheets", () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const r = await refSheet(c.args);
      expect(r.stderr).toContain("passh: printed ");
      expect(r.code).toBe(0);
      sameText(ours(r.text, c), r.text);
    });
  }

  test("stdout without -o", async () => {
    const r = await ref("print", "--confirm-plaintext", "--folder", "bank");
    expect(r.code).toBe(0);
    sameText(ours(r.stdout, { folder: "bank" }), r.stdout);
    expect(r.stderr).toBe("passh: printed 1 entry (text sheet) to stdout; print it, then delete the file\n");
  });
});

describe("b. errors of the sheet model", () => {
  const cases: Array<{ args: string[]; folder?: string; tags?: string[]; fields?: string }> = [
    { args: ["--tag", "nope"], tags: ["nope"] },
    { args: ["--tag", "nope", "--tag", "a"], tags: ["nope", "a"] },
    { args: ["--folder", "nothing/here", "--tag", "x\u00a0y"], folder: "nothing/here", tags: ["x\u00a0y"] },
    { args: ["--fields", "password,nokey"], fields: "password,nokey" },
    { args: ["--folder", "bank", "--fields", "pin"], folder: "bank", fields: "pin" },
  ];
  for (const c of cases) {
    test(c.args.join(" "), async () => {
      const r = await refSheet(c.args);
      expect(r.code).toBe(1);
      let msg = "";
      try {
        buildPasswordSheet({ entries: ENTRIES, folder: c.folder ?? "", tags: c.tags ?? [], fields: parseFields(c.fields), printedAt: new Date() });
      } catch (err) {
        msg = (err as Error).message;
      }
      expect("passh: " + msg + "\n").toBe(r.stderr);
    });
  }

  test("an empty vault", async () => {
    writeVault([]);
    try {
      const r = await refSheet([]);
      expect(r.code).toBe(1);
      expect(() => buildPasswordSheet({ entries: [], folder: "", tags: [], fields: parseFields(undefined), printedAt: new Date() })).toThrow(r.stderr.replace(/^passh: /, "").trim());
    } finally {
      writeVault(SPECS);
    }
  });
});

// ---------------------------------------------------------------------------

async function refRecoverySheet(): Promise<string> {
  const out = join(e.dir, `rk-${outN++}.txt`);
  const p = spawnPty([REF_BIN, "recovery-key", "print", "-o", out], e.env);
  await p.expect(/PRINT RECOVERY KEY[^\n]*: $/);
  p.line("PRINT RECOVERY KEY");
  const r = await p.wait();
  if (r.code !== 0) throw new Error("recovery-key print failed: " + r.output);
  const text = readFileSync(out, "utf8");
  rmSync(out);
  return text;
}

function ourRecovery(text: string, web = false): Sheet {
  return buildRecoverySheet({ key: identity.format(), vaultId, printedAt: sheetDate(text), web });
}

describe("c. languages", () => {
  for (const [lang, cat] of [
    ["ru", PRINT_CATALOG_RU],
    ["sr", PRINT_CATALOG_SR],
  ] as const) {
    test(`${lang}: password sheets byte for byte`, async () => {
      setConfig(`language = "${lang}"`);
      registerCatalog(lang, () => cat);
      try {
        for (const c of [CASES[0]!, CASES[3]!, CASES[6]!, CASES[8]!]) {
          const r = await refSheet(c.args);
          expect(r.code).toBe(0);
          setLanguage(lang);
          const mine = ours(r.text, c);
          setLanguage("en");
          sameText(mine, r.text);
        }
      } finally {
        setLanguage("en");
        setConfig("");
      }
    });

    test(`${lang}: the recovery sheet's frame`, async () => {
      setConfig(`language = "${lang}"`);
      registerCatalog(lang, () => cat);
      try {
        const want = await refRecoverySheet();
        setLanguage(lang);
        const got = renderText(ourRecovery(want));
        setLanguage("en");
        // Frame lines (print.md §8): the header line, the title, vault_id, printed, the key
        // heading and the key, the commands (with the translated comment), the footer.
        const pick = (t: string) => {
          const lines = t.split("\n");
          const keyAt = lines.findIndex((l) => l === "AGE-SECRET-KEY-1");
          const cmdAt = lines.findIndex((l) => l.startsWith("tr -d"));
          return [lines.slice(0, 7), lines.slice(keyAt - 2, keyAt + 4), lines.slice(cmdAt, cmdAt + 5), lines.slice(-3)];
        };
        expect(pick(got)).toEqual(pick(want));
        expect(got.split("\n").length).toBe(want.split("\n").length);
      } finally {
        setLanguage("en");
        setConfig("");
      }
    });
  }
});

describe("d. recovery key text sheet", () => {
  test("byte for byte", async () => {
    const want = await refRecoverySheet();
    sameText(renderText(ourRecovery(want)), want);
  });
});

// ---------------------------------------------------------------------------
// e. The print page

/** A private IPv4 address on this machine to serve on, preferring an interface the LAN can't reach (bridges). */
function pickInterface(): { iface: string; addr: string } | undefined {
  const sys = listInterfaces();
  const candidates: Array<{ iface: string; addr: string; score: number }> = [];
  for (const [name] of sys) {
    const plan = planAddresses([name], sys);
    const v4 = plan.bound.find((b) => b.ip.length === 4);
    if (!v4) continue;
    const score = /^(br-|docker|virbr|veth)/.test(name) ? 0 : /^(wg|tailscale|tun)/.test(name) ? 1 : 2;
    candidates.push({ iface: name, addr: v4.text, score });
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0];
}

/** The source address the kernel uses to connect to addr (Bun can't bind a client's local address). */
async function peerFor(addr: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((c) => {
      resolve(formatAddr(new Uint8Array((c.remoteAddress ?? "").replace(/^::ffff:/, "").split(".").map(Number))));
      c.destroy();
      srv.close();
    });
    srv.on("error", reject);
    srv.listen(0, addr, () => {
      const c = net.connect((srv.address() as net.AddressInfo).port, addr);
      c.on("error", () => {});
    });
  });
}

interface RawResponse {
  head: string;
  /** Header lines without Date. */
  headers: string[];
  body: Buffer;
  /** Chunk sizes of a chunked body. */
  chunks: number[];
}

function rawRequest(host: string, port: number, req: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const c = tls.connect({ host, port, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"], servername: undefined }, () => c.write(req));
    const parts: Buffer[] = [];
    c.on("data", (d: Buffer) => parts.push(d));
    const finish = () => {
      const all = Buffer.concat(parts);
      const sep = all.indexOf("\r\n\r\n");
      if (sep < 0) return reject(new Error("no response: " + all.toString()));
      const head = all.subarray(0, sep).toString("latin1");
      let body = all.subarray(sep + 4);
      const chunks: number[] = [];
      if (/Transfer-Encoding: chunked/.test(head)) {
        const out: Buffer[] = [];
        let p = 0;
        for (;;) {
          const eol = body.indexOf("\r\n", p);
          if (eol < 0) break;
          const n = parseInt(body.subarray(p, eol).toString("latin1"), 16);
          chunks.push(n);
          if (n === 0) break;
          out.push(body.subarray(eol + 2, eol + 2 + n));
          p = eol + 2 + n + 2;
        }
        body = Buffer.concat(out);
      }
      resolve({ head, headers: head.split("\r\n").filter((l) => !l.startsWith("Date: ")), body, chunks });
    };
    c.on("close", finish);
    c.on("error", () => {});
    setTimeout(() => c.destroy(), 3000);
  });
}

/** Requests compared between the two servers: 404, 421, 405 (HEAD), then the page. */
async function exchange(addr: string, port: number, token: string): Promise<RawResponse[]> {
  const host = `${addr}:${port}`;
  const out: RawResponse[] = [];
  out.push(await rawRequest(addr, port, `GET /favicon.ico HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
  out.push(await rawRequest(addr, port, `GET /p/${token} HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`));
  out.push(await rawRequest(addr, port, `HEAD /p/${token} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
  // Not normative (the HTTP library's answers before the table), compared anyway.
  out.push(await rawRequest(addr, port, `GET /p/${token} HTTP/1.0\r\n\r\n`));
  out.push(await rawRequest(addr, port, `GET /p/%zz HTTP/1.1\r\nHost: ${host}\r\n\r\n`));
  out.push(await rawRequest(addr, port, `GET /p/${token} HTTP/1.1\r\n\r\n`));
  out.push(await rawRequest(addr, port, `OPTIONS * HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
  out.push(await rawRequest(addr, port, `GET /p/%${token.charCodeAt(0).toString(16)}${token.slice(1)} HTTP/1.1\r\nHost: PI.local.:${port}\r\n\r\n`));
  return out;
}

const iface = pickInterface();
const describeWeb = iface ? describe : describe.skip;

describeWeb("e. print page", () => {
  let peer = "";
  let myState = "";
  beforeAll(async () => {
    peer = await peerFor(iface!.addr);
    myState = mkdtempSync(join(e.dir, "mystate-"));
  });

  async function refPage(args: string[], phrase: string): Promise<{ tty: string; urls: string[]; responses: RawResponse[]; port: number; code: number }> {
    const port = 20000 + Math.floor(Math.random() * 20000);
    setConfig(`[print_web]\nenabled = true\nport = ${port}\ninterfaces = ["lo", ${JSON.stringify(iface!.iface)}, "no-such-if0"]\nallow_from = ["${peer}/32"]\nhostnames = ["pi.local"]\nttl = "2m"`);
    const p = spawnPty([REF_BIN, ...args], e.env, { cols: 120 });
    await p.expect(/Type .* to confirm: /);
    p.line(phrase);
    await p.expect("stops after one load or in ");
    const tty = p.output();
    const urls = [...tty.matchAll(/https:\/\/\S+\/p\/[A-Za-z0-9_-]{22}/g)].map((m) => m[0]);
    const token = urls[0]!.slice(-22);
    const responses = await exchange(iface!.addr, port, token);
    const r = await p.wait(15_000);
    setConfig("");
    return { tty: p.output().replace(/\r\n/g, "\n"), urls, responses, port, code: r.code };
  }

  async function ourPage(sheet: Sheet): Promise<{ page: PrintPage; responses: RawResponse[] }> {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const page = await startPrintPage({
      sheet,
      stateDir: myState,
      settings: { enabled: true, port, interfaces: ["lo", iface!.iface, "no-such-if0"], allowFrom: [`${peer}/32`], hostnames: ["pi.local"], ttl: 120_000_000_000n },
    });
    const responses = await exchange(iface!.addr, port, page.urls[0]!.slice(-22));
    await page.done;
    return { page, responses };
  }

  function compareResponses(got: RawResponse[], want: RawResponse[]): void {
    expect(got.length).toBe(want.length);
    for (let i = 0; i < want.length; i++) {
      if (process.env.PRINT_DEBUG && JSON.stringify(got[i]!.headers) !== JSON.stringify(want[i]!.headers)) console.log(i, got[i]!.head, "\n---\n", want[i]!.head, "\n", want[i]!.body.toString());
      expect(got[i]!.headers).toEqual(want[i]!.headers);
      expect(got[i]!.body.toString("utf8")).toBe(want[i]!.body.toString("utf8"));
      expect(got[i]!.chunks).toEqual(want[i]!.chunks);
    }
  }

  function checkDialog(tty: string, urls: string[], page: PrintPage): void {
    // The QR code of each URL as passh-go drew it, and our encoder's.
    for (const url of urls) {
      const at = tty.indexOf(url);
      const before = tty.slice(0, at).split("\n");
      const qr = renderTerminal(encodeText(url, "L"));
      const n = qr.split("\n").length;
      expect(before.slice(-n - 1, -1).join("\n")).toBe(qr);
    }
    // The text lines around them (the notice depends on the state folder: compare the rest).
    const lines = tty.split("\n");
    const skipped = lines.filter((l) => l.startsWith("not used: "));
    expect(skipped).toEqual(page.skipped.map((s) => "not used: " + s.message));
    expect(lines).toContain("Compare it with the fingerprint your browser shows before you accept the certificate.");
    expect(lines).toContain("c copies the URL · Esc stops");
    expect(lines.some((l) => /^certificate SHA-256  ([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(l))).toBe(true);
    expect(tty).toContain("\r\x1b[Kstops after one load or in 2:00");
    // The whole block, in order: our dialogLines with passh-go's URLs and fingerprint.
    const start = tty.indexOf("PRINT\n") >= 0 ? tty.indexOf("\n", tty.indexOf("to confirm: ")) + 1 : 0;
    const block = tty.slice(start, tty.indexOf("\r\x1b[Kstops after"));
    const notice = /^made a new certificate[^\n]*\n/.exec(block)?.[0];
    const fp = /certificate SHA-256  (\S+)/.exec(block)![1]!;
    const fake = { ...page, urls, fingerprint: fp, certNotice: undefined, terminalQr: (i: number) => renderTerminal(encodeText(urls[i]!, "L")) };
    expect(block).toBe((notice ?? "") + dialogLines(fake).join("\n") + "\n");
    expect(tty).toContain(`Done: the page was served to ${peer}; if that wasn't you, start the print page again.`);
  }

  test("password sheet: dialog, responses and page", async () => {
    const want = await refPage(["print", "--web", "--fields", "password,username,url,tags,notes,fields"], "PRINT");
    expect(want.code).toBe(0);
    const html = want.responses.at(-1)!.body.toString("utf8");
    const printed = /<span>printed (\d{4}-\d\d-\d\d \d\d:\d\d)<\/span>/.exec(html)![1]!;
    const sheet = buildPasswordSheet({ entries: ENTRIES, folder: "", tags: [], fields: parseFields("password,username,url,tags,notes,fields"), printedAt: sheetDate(printed) });
    const got = await ourPage(sheet);
    expect(got.page.urls.length).toBe(want.urls.length);
    checkDialog(want.tty, want.urls, got.page);
    compareResponses(got.responses, want.responses);
    expect((await got.page.done).message.message).toBe(`the page was served to ${peer}; if that wasn't you, start the print page again`);
  });

  test("recovery sheet: page with the key's QR code", async () => {
    const want = await refPage(["recovery-key", "print", "--web"], "PRINT RECOVERY KEY");
    expect(want.code).toBe(0);
    const html = want.responses.at(-1)!.body.toString("utf8");
    const printed = /<span>printed (\d{4}-\d\d-\d\d \d\d:\d\d)<\/span>/.exec(html)![1]!;
    expect(html).toContain('<div class="qr"><svg viewBox="0 0 41 41"');
    const got = await ourPage(buildRecoverySheet({ key: identity.format(), vaultId, printedAt: sheetDate(printed), web: true }));
    compareResponses(got.responses, want.responses);
  });

  async function refEnd(interfaces: string[], act: (p: ReturnType<typeof spawnPty>, port: number, token: string) => Promise<void>): Promise<{ code: number; tty: string }> {
    const port = 20000 + Math.floor(Math.random() * 20000);
    setConfig(`[print_web]\nenabled = true\nport = ${port}\ninterfaces = ${JSON.stringify(interfaces)}\nallow_from = ["${peer}/32"]\nttl = "2m"`);
    const p = spawnPty([REF_BIN, "print", "--web"], e.env, { cols: 120 });
    await p.expect(/Type .* to confirm: /);
    p.line("PRINT");
    const tty = await p.expect(/stops after one load or in |passh: [^\n]*\n/);
    if (tty.includes("stops after")) {
      const token = /\/p\/([A-Za-z0-9_-]{22})/.exec(p.output())![1]!;
      await act(p, port, token);
    }
    const r = await p.wait(15_000);
    setConfig("");
    return { code: r.code, tty: r.output.replace(/\r\n/g, "\n") };
  }

  test("Esc stops the page: the same result", async () => {
    const r = await refEnd([iface!.iface], async (p) => p.send("\x1b"));
    expect(r.code).toBe(1);
    const sheet = buildPasswordSheet({ entries: ENTRIES, folder: "", tags: [], fields: parseFields(undefined), printedAt: new Date() });
    const port = 20000 + Math.floor(Math.random() * 20000);
    const page = await startPrintPage({ sheet, stateDir: myState, settings: { enabled: true, port, interfaces: [iface!.iface], allowFrom: [], hostnames: [], ttl: 120_000_000_000n } });
    page.stop();
    const mine = await page.done;
    expect(r.tty).toContain("\r\x1b[Kpassh: " + mine.message.message + "\n");
  });

  test("5 wrong tokens stop the page: the same result", async () => {
    const r = await refEnd([iface!.iface], async (_p, port) => {
      for (let i = 0; i < 5; i++) await rawRequest(iface!.addr, port, `GET /p/wrong${i} HTTP/1.1\r\nHost: ${iface!.addr}:${port}\r\nConnection: close\r\n\r\n`).catch(() => {});
    });
    expect(r.code).toBe(1);
    const sheet = buildPasswordSheet({ entries: ENTRIES, folder: "", tags: [], fields: parseFields(undefined), printedAt: new Date() });
    const port = 20000 + Math.floor(Math.random() * 20000);
    const page = await startPrintPage({ sheet, stateDir: myState, settings: { enabled: true, port, interfaces: [iface!.iface], allowFrom: [`${peer}/32`], hostnames: [], ttl: 120_000_000_000n } });
    for (let i = 0; i < 5; i++) await rawRequest(iface!.addr, port, `GET /p/wrong${i} HTTP/1.1\r\nHost: ${iface!.addr}:${port}\r\nConnection: close\r\n\r\n`).catch(() => {});
    const mine = await page.done;
    expect(mine.outcome).toBe("too-many-wrong-tokens");
    expect(r.tty).toContain("passh: " + mine.message.message + "\n");
  });

  test("no private address: the same error", async () => {
    const ifs = ["no-such-if0", "lo", "no-such-if1"];
    const r = await refEnd(ifs, async () => {});
    expect(r.code).toBe(1);
    expect(r.tty).toContain("passh: " + noAddressError(ifs, planAddresses(ifs)).message + "\n");
  });

  test("the certificate is reused (same fingerprint, no notice)", async () => {
    const first = await refPage(["print", "--web", "--folder", "bank"], "PRINT");
    expect(first.tty).not.toContain("made a new certificate");
    const sheet = buildPasswordSheet({ entries: ENTRIES, folder: "bank", tags: [], fields: parseFields(undefined), printedAt: new Date() });
    const a = await ourPage(sheet);
    const b = await ourPage(sheet);
    expect(a.page.certNotice).toBeUndefined();
    expect(b.page.fingerprint).toBe(a.page.fingerprint);
  });
});
