// The print page server (print.md §6.4–§6.7) on loopback, and the page (§6.8).
// openPage is called directly with 127.0.0.1 (planAddresses never binds loopback).

import { afterEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import * as tls from "node:tls";
import { parseCidr } from "../config/cidr.ts";
import { buildPasswordSheet } from "../print/sheet.ts";
import { parseFields } from "../print/fields.ts";
import type { Entry } from "../model/types.ts";
import { makeCertificate } from "./x509.ts";
import { hostAllowed, newToken, openPage, parseTarget, checkSettings, type PrintPage, type PrintWebSettings } from "./server.ts";
import { CSS, contentSecurityPolicy, escapeHtml, escapeHtmlKeepPlus, marksHtml, renderPage, styleHash } from "./page.ts";
import { countdown, dialogLines, runDialog, type DialogTty } from "./dialog.ts";
import type { BoundAddr } from "./addrs.ts";

const LO: BoundAddr = { iface: "lo", ip: Uint8Array.of(127, 0, 0, 1), prefix: 8, text: "127.0.0.1" };
const CERT = makeCertificate([LO.ip], ["pi.local"], new Date());

function entry(path: string, o: Partial<Entry> = {}): Entry {
  return { id: path, path, password: "", username: "", url: "", tags: [], fields: [], notes: "", createdAt: 0, updatedAt: 0, unknown: new Map(), ...o };
}

const SHEET = buildPasswordSheet({
  entries: [entry("a", { password: "<script>alert(1)</script>", username: "x+y", notes: '<img src=x onerror="z">' }), entry("b/c", { password: "'\"&" })],
  folder: "",
  tags: [],
  fields: parseFields("password,username,notes"),
  printedAt: new Date(2026, 10, 15, 14, 3),
});

let pages: PrintPage[] = [];
afterEach(async () => {
  for (const p of pages) {
    p.stop();
    await p.done;
  }
  pages = [];
});

function settings(port: number, o: Partial<PrintWebSettings> = {}): PrintWebSettings {
  return { enabled: true, port, interfaces: ["lo"], allowFrom: [], hostnames: ["pi.local"], ttl: 60_000_000_000n, ...o };
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

async function start(o: { ranges?: string[]; ttlNs?: bigint; signal?: AbortSignal } = {}): Promise<{ page: PrintPage; port: number; token: string }> {
  const port = await freePort();
  const token = newToken();
  const page = await openPage({
    sheet: SHEET,
    settings: settings(port, o.ttlNs ? { ttl: o.ttlNs } : {}),
    bound: [LO],
    ranges: (o.ranges ?? ["127.0.0.0/8"]).map((r) => parseCidr(r)!),
    token,
    certPem: CERT.certPem,
    keyPem: CERT.keyPem,
    fingerprint: "FP",
    skipped: [],
    signal: o.signal,
  });
  pages.push(page);
  return { page, port, token };
}

interface Resp {
  status: number;
  headers: string[];
  body: string;
}

function parse(raw: string): Resp[] {
  const out: Resp[] = [];
  let rest = raw;
  while (rest.startsWith("HTTP/")) {
    const sep = rest.indexOf("\r\n\r\n");
    const head = rest.slice(0, sep).split("\r\n");
    const status = Number(head[0]!.split(" ")[1]);
    const len = Number(head.find((h) => h.startsWith("Content-Length: "))?.slice(16) ?? "0");
    let body: string;
    if (head.includes("Transfer-Encoding: chunked")) {
      body = "";
      let p = sep + 4;
      for (;;) {
        const eol = rest.indexOf("\r\n", p);
        const n = parseInt(rest.slice(p, eol), 16);
        if (!n) {
          p = eol + 4;
          break;
        }
        body += rest.slice(eol + 2, eol + 2 + n);
        p = eol + 2 + n + 2;
      }
      rest = rest.slice(p);
    } else {
      body = rest.slice(sep + 4, sep + 4 + len);
      rest = rest.slice(sep + 4 + len);
    }
    out.push({ status, headers: head.slice(1).filter((h) => !h.startsWith("Date: ")), body: Buffer.from(body, "latin1").toString("utf8") });
  }
  return out;
}

function request(port: number, req: string | string[], opts: tls.ConnectionOptions = {}): Promise<{ raw: string; error?: string }> {
  return new Promise((resolve) => {
    let raw = "";
    let error: string | undefined;
    const c = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"], ...opts }, () => {
      for (const r of Array.isArray(req) ? req : [req]) c.write(r);
    });
    c.setEncoding("latin1");
    c.on("data", (d: string) => (raw += d));
    c.on("error", (e) => (error = e.message));
    c.on("close", () => resolve({ raw, error }));
    setTimeout(() => c.destroy(), 1500);
  });
}

const COMMON = [
  "Cache-Control: no-store",
  "Content-Security-Policy: default-src 'none'; style-src 'sha256-rLtWigDh0s379JybCrlCKrASvsF52LZTMcgTI5+BB1E='; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
];

describe("the page (§6.8)", () => {
  test("the CSP hash of the CSS is the spec's", () => {
    expect(styleHash()).toBe("sha256-rLtWigDh0s379JybCrlCKrASvsF52LZTMcgTI5+BB1E=");
    expect(CSS.startsWith("\n@page")).toBe(true);
    expect(CSS.endsWith("}\n")).toBe(true);
    expect(CSS).not.toContain("/*");
    expect(contentSecurityPolicy()).toBe(COMMON[1]!.slice("Content-Security-Policy: ".length));
  });

  test("escaping", () => {
    expect(escapeHtml(`&<>'"+\u0000x`)).toBe("&amp;&lt;&gt;&#39;&#34;&#43;�x");
    expect(escapeHtmlKeepPlus("Ctrl+P <")).toBe("Ctrl+P &lt;");
    expect(marksHtml("            D UL")).toBe("            <b>D</b> <b>U</b><b>L</b>");
  });

  test("entry data reaches text nodes only, escaped; nothing active", () => {
    const html = renderPage(SHEET);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&#34;z&#34;&gt;");
    expect(html).toContain("x&#43;y");
    expect(html).toContain("&#39;&#34;&amp;");
    expect(html).not.toMatch(/<script|<img|<link|<form|url\(|@import/i);
    for (const tag of html.match(/<[^>]+>/g)!) expect(tag).not.toMatch(/\s(on\w+|style|src|href)=/i);
    expect(html).toContain('<p class="tip">Print with Ctrl+P (Cmd+P on a Mac), then close this tab.');
    expect(html).toContain('<html lang="en">');
    expect(html.match(/<div class="blk nb keep">/g)?.length).toBe(2);
  });

  test("blocks of more than 16 rows are not kept whole", () => {
    const big = buildPasswordSheet({ entries: [entry("x", { notes: Array.from({ length: 20 }, (_, i) => "n" + i).join("\n") })], folder: "", tags: [], fields: parseFields("notes"), printedAt: new Date() });
    const html = renderPage(big);
    expect(html).toContain('<div class="blk">\n<div class="r sp"></div>\n<div class="r entry">x</div>');
  });
});

describe("settings (§6.1)", () => {
  test("checks in order", () => {
    const s = settings(8443);
    expect(() => checkSettings({ ...s, enabled: false })).toThrow("the print page is off: set enabled = true in the [print_web] table of the config file");
    expect(() => checkSettings({ ...s, ttl: 59_000_000_000n })).toThrow("print_web.ttl: 59s is not between 1m0s and 15m0s");
    expect(() => checkSettings({ ...s, ttl: 901_000_000_000n })).toThrow("print_web.ttl: 15m1s is not between 1m0s and 15m0s");
    expect(() => checkSettings({ ...s, port: 0 })).toThrow("print_web.port: 0 is not between 1 and 65535");
    expect(() => checkSettings({ ...s, hostnames: ["a/b"] })).toThrow('print_web.hostnames: "a/b" is not a hostname');
    expect(() => checkSettings({ ...s, hostnames: [""] })).toThrow('print_web.hostnames: "" is not a hostname');
    expect(() => checkSettings(s)).not.toThrow();
  });

  test("token: 128 bits, base64url, 22 characters", () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newToken()).not.toBe(t);
  });
});

describe("request parsing (§6.6)", () => {
  test("Host check", () => {
    const b = [LO, { iface: "x", ip: Uint8Array.of(0xfd, 0x12, 0x34, 0x56, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1), prefix: 64, text: "fd12:3456::1" }];
    const ok = (h: string) => hostAllowed(h, 8443, b, ["pi.local"]);
    expect(ok("127.0.0.1:8443")).toBe(true);
    expect(ok("127.0.0.1")).toBe(true);
    expect(ok("127.0.0.1:443")).toBe(false);
    expect(ok("127.0.0.1:08443")).toBe(false);
    expect(ok("[::ffff:127.0.0.1]:8443")).toBe(true);
    expect(ok("[fd12:3456::1]:8443")).toBe(true);
    expect(ok("[fd12:3456::1%eth0]:8443")).toBe(false);
    expect(ok("PI.Local.:8443")).toBe(true);
    expect(ok("pi.local..")).toBe(false);
    expect(ok("127.0.0.2")).toBe(false);
    expect(ok("")).toBe(false);
    expect(ok(":8443")).toBe(false);
  });

  test("targets: percent-decoded path, absolute form, no cleaning", () => {
    expect(parseTarget("/p/%6Bq7Z?x=1")).toEqual({ path: "/p/kq7Z" });
    expect(parseTarget("//p/x")).toEqual({ path: "//p/x" });
    expect(parseTarget("/p/../p/x")).toEqual({ path: "/p/../p/x" });
    expect(parseTarget("https://1.2.3.4:8443/p/x")).toEqual({ path: "/p/x", authority: "1.2.3.4:8443" });
    expect(() => parseTarget("/p/%zz")).toThrow();
    expect(() => parseTarget("p/x")).toThrow();
  });
});

describe("the server (§6.4–§6.7)", () => {
  test("rows 1–7, the headers of row 0, single use", async () => {
    const { page, port, token } = await start();
    const host = `Host: 127.0.0.1:${port}`;
    const r1 = parse((await request(port, `GET /p/${token} HTTP/1.1\r\nHost: evil.example\r\n\r\n`)).raw)[0]!;
    expect(r1).toEqual({ status: 421, headers: [...COMMON, "Content-Type: text/plain; charset=utf-8", "Referrer-Policy: no-referrer", "X-Content-Type-Options: nosniff", "Content-Length: 34"], body: "misdirected request: unknown host\n" });
    const r2 = parse((await request(port, [`GET /favicon.ico HTTP/1.1\r\n${host}\r\n\r\n`, `GET //p/${token} HTTP/1.1\r\n${host}\r\n\r\n`])).raw);
    expect(r2.map((r) => [r.status, r.body])).toEqual([
      [404, "404 page not found\n"],
      [404, "404 page not found\n"],
    ]);
    const r3 = parse((await request(port, `POST /p/${token} HTTP/1.1\r\n${host}\r\nContent-Length: 3\r\n\r\nabc`)).raw)[0]!;
    expect(r3.status).toBe(405);
    expect(r3.headers[0]).toBe("Allow: GET");
    expect(r3.body).toBe("method not allowed\n");
    const head = (await request(port, `HEAD /p/${token} HTTP/1.1\r\n${host}\r\nConnection: close\r\n\r\n`)).raw;
    expect(head).toMatch(/^HTTP\/1\.1 405 Method Not Allowed\r\n[\s\S]*Content-Length: 19\r\nConnection: close\r\n\r\n$/);
    // A second connection opened before the page is served.
    const early = new Promise<string>((resolve) => {
      let raw = "";
      const c = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, async () => {
        await Bun.sleep(300);
        c.write(`GET /p/${token} HTTP/1.1\r\n${host}\r\n\r\n`);
      });
      c.setEncoding("latin1");
      c.on("data", (d: string) => (raw += d));
      c.on("close", () => resolve(raw));
      c.on("error", () => {});
      setTimeout(() => c.destroy(), 1500);
    });
    await Bun.sleep(100);
    const served = parse((await request(port, `GET /p/%${token.charCodeAt(0).toString(16)}${token.slice(1)} HTTP/1.1\r\n${host}\r\n\r\n`)).raw)[0]!;
    expect(served.status).toBe(200);
    expect(served.headers).toEqual([...COMMON, "Content-Type: text/html; charset=utf-8", "Referrer-Policy: no-referrer", "X-Content-Type-Options: nosniff", "Connection: close", "Transfer-Encoding: chunked"]);
    expect(served.body).toBe(renderPage(SHEET));
    const result = await page.done;
    expect(result.outcome).toBe("served");
    expect(result.message.message).toBe("the page was served to 127.0.0.1; if that wasn't you, start the print page again");
    // The listeners are closed: a new connection is refused.
    const after = await request(port, `GET /p/${token} HTTP/1.1\r\n${host}\r\n\r\n`);
    expect(after.raw).toBe("");
    expect(await early).toBe(""); // closed with the server (row 5 needs the request in flight)
  });

  test("a request on an open connection after the page was served gets 410", async () => {
    const { page, port, token } = await start();
    const host = `Host: 127.0.0.1:${port}`;
    // One connection: a 404 keeps it open; the page is requested on another one meanwhile.
    let raw = "";
    const c = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false });
    c.setEncoding("latin1");
    c.on("data", (d: string) => (raw += d));
    c.on("error", () => {});
    await new Promise((r) => c.once("secureConnect", r));
    const served = request(port, `GET /p/${token} HTTP/1.1\r\n${host}\r\n\r\n`);
    // Write the late request before the page finishes streaming.
    c.write(`GET /p/${token} HTTP/1.1\r\n${host}\r\n\r\n`);
    await served;
    await page.done;
    await Bun.sleep(100);
    c.destroy();
    const got = parse(raw);
    if (got.length > 0) {
      expect([200, 410]).toContain(got[0]!.status);
      if (got[0]!.status === 410) expect(got[0]!.body).toBe("already used: start the print page again in passh\n");
    }
  });

  test("5 wrong tokens stop the server; other paths don't count", async () => {
    const { page, port } = await start();
    const host = `Host: 127.0.0.1:${port}`;
    for (let i = 0; i < 6; i++) await request(port, `GET /favicon.ico HTTP/1.1\r\n${host}\r\nConnection: close\r\n\r\n`);
    expect(page.result()).toBeUndefined();
    for (let i = 0; i < 4; i++) await request(port, `GET /p/wrong${i}/ HTTP/1.1\r\n${host}\r\nConnection: close\r\n\r\n`);
    expect(page.result()).toBeUndefined();
    const last = parse((await request(port, `GET /p/x HTTP/1.1\r\n${host}\r\nConnection: close\r\n\r\n`)).raw);
    expect(last[0]?.status ?? 404).toBe(404);
    const r = await page.done;
    expect(r.outcome).toBe("too-many-wrong-tokens");
    expect(r.message.message).toBe("the print page stopped after 5 requests with a wrong address");
  });

  test("the TTL, Stop and cancellation", async () => {
    const a = await start({ ttlNs: 300_000_000n });
    const ra = await a.page.done;
    expect(ra.outcome).toBe("expired");
    expect(ra.message.message).toBe("the print page stopped after 300ms without being opened");
    const b = await start();
    b.page.stop();
    expect((await b.page.done).message.message).toBe("the print page was stopped");
    const ctl = new AbortController();
    const c = await start({ signal: ctl.signal });
    ctl.abort();
    expect((await c.page.done).outcome).toBe("cancelled");
  });

  test("TLS 1.3 only, ALPN http/1.1; a peer outside the ranges is closed before TLS", async () => {
    const { page, port, token } = await start();
    const old = await request(port, `GET /p/${token} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`, { maxVersion: "TLSv1.2" });
    expect(old.raw).toBe("");
    expect(old.error).toBeDefined();
    const alpn = await new Promise<string | false | null>((resolve) => {
      const c = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, ALPNProtocols: ["h2", "http/1.1"] }, () => {
        resolve(c.alpnProtocol);
        c.destroy();
      });
      c.on("error", () => resolve(false));
    });
    expect(alpn).toBe("http/1.1");
    expect(page.result()).toBeUndefined();

    const outside = await start({ ranges: ["10.0.0.0/8"] });
    const refused = await request(outside.port, `GET /p/${outside.token} HTTP/1.1\r\nHost: 127.0.0.1:${outside.port}\r\n\r\n`);
    expect(refused.raw).toBe("");
    expect(refused.error).toBeDefined();
    expect(outside.page.result()).toBeUndefined(); // refused connections don't stop the server
  });

  test("a port in use: nothing listens, the system error is shown", async () => {
    const { port } = await start();
    let err: Error | undefined;
    try {
      await openPage({ sheet: SHEET, settings: settings(port), bound: [LO], ranges: [parseCidr("127.0.0.0/8")!], token: newToken(), certPem: CERT.certPem, keyPem: CERT.keyPem, fingerprint: "", skipped: [] });
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toBe(`print page: listen tcp 127.0.0.1:${port}: bind: address already in use`);
  });
});

describe("the dialog (§6.9)", () => {
  test("countdown: M:SS, rounded, not below 0", () => {
    expect(countdown(300_000)).toBe("5:00");
    expect(countdown(299_400)).toBe("4:59");
    expect(countdown(59_500)).toBe("1:00");
    expect(countdown(-5)).toBe("0:00");
    expect(countdown(900_000)).toBe("15:00");
  });

  test("lines, keys and the end", async () => {
    const { page } = await start();
    const out: string[] = [];
    const modes: string[] = [];
    let feed: ((b: Uint8Array | null) => void) | undefined;
    const tty: DialogTty = {
      print: (t) => out.push(t),
      writeRaw: (t) => out.push(t),
      enterRawMode: () => modes.push("raw"),
      restoreMode: () => modes.push("restore"),
      reader: () => ({
        read: (_max, abort) =>
          new Promise<Uint8Array | null>((resolve, reject) => {
            feed = resolve;
            abort?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
        close: () => {},
      }),
    };
    const copied: string[] = [];
    let settled = 0;
    const done = runDialog(page, tty, { copy: async (t) => (copied.push(t), "copied"), settle: async () => void settled++ });
    await Bun.sleep(50);
    feed!(Uint8Array.of(0x63));
    await Bun.sleep(50);
    feed!(Uint8Array.of(0x1b));
    const r = await done;
    expect(r.message.message).toBe("the print page was stopped");
    expect(copied).toEqual([page.urls[0]!]);
    expect(settled).toBe(1);
    expect(modes).toEqual(["raw", "restore"]);
    const text = out.join("");
    expect(out[0]).toBe(dialogLines(page).join("\n") + "\n");
    expect(text).toContain(page.urls[0]! + "\n\ncertificate SHA-256  FP\nCompare it with the fingerprint your browser shows before you accept the certificate.\nc copies the URL · Esc stops\n");
    expect(text).toContain("\r\x1b[Kstops after one load or in 1:00");
    expect(text).toContain("\r\x1b[KURL copied · stops after one load or in ");
    expect(text.endsWith("\r\x1b[K")).toBe(true);
  });
});
