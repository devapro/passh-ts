// The one-shot print page server (print.md §6.1, §6.4–§6.7).
//
// TCP is accepted with node:net (paused), the peer address is checked against the allowed
// ranges and the connection closed before any TLS byte if it is outside them; otherwise it
// is wrapped in a node:tls TLSSocket (server side, TLS 1.3 only, ALPN http/1.1). HTTP/1.1
// is parsed here (a few requests per connection at most), so the responses carry exactly
// the headers of §6.6, in the reference's order, and the page is streamed in chunks.

import * as net from "node:net";
import * as tls from "node:tls";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { T, errorf, type PasshError } from "../i18n/index.ts";
import { formatGoDuration, MIN } from "../util/duration.ts";
import { encodeText, renderTerminal } from "../qr/index.ts";
import { errnoText } from "../fsx/oserror.ts";
import { formatAddr, parseAddr, type Cidr } from "../config/cidr.ts";
import { foldEquals } from "../util/unicode.ts";
import type { Sheet } from "../print/sheet.ts";
import { allowedRanges, noAddressError, pageUrl, peerAddress, peerAllowed, planAddresses, unmap, type BoundAddr } from "./addrs.ts";
import { certificateNotice, loadOrCreateCertificate } from "./cert.ts";
import type { Interface } from "./ifaddrs.ts";
import { contentSecurityPolicy, pagePieces } from "./page.ts";

/** The `[print_web]` settings (spec §3.3, storage.md §2.3). */
export interface PrintWebSettings {
  enabled: boolean;
  port: number;
  interfaces: readonly string[];
  /** CIDR prefixes as configured; non-empty replaces the default ranges. */
  allowFrom: readonly string[];
  hostnames: readonly string[];
  /** Go duration in nanoseconds (1m–15m). */
  ttl: bigint;
}

export const DEFAULT_PRINT_WEB: PrintWebSettings = { enabled: false, port: 8443, interfaces: ["wg0", "eth0"], allowFrom: [], hostnames: [], ttl: 5n * MIN };

/** Wrong tokens that stop the server (print.md §7). */
export const MAX_WRONG_TOKENS = 5;
/** How long a served page may take to be written (print.md §6.7). */
export const SERVE_WAIT_MS = 30_000;

export type Outcome = "served" | "failed" | "cancelled" | "expired" | "too-many-wrong-tokens";

/** How the server ended (print.md §6.7). */
export interface PrintPageResult {
  outcome: Outcome;
  /** The client the page went to (served, failed, cancelled while sending). */
  client?: string;
  /** The result text, rendered in the language when shown (`%s` / `%v` / `.localize()`). */
  message: PasshError;
}

export interface PrintPage {
  /** One URL per bound address, in bind order (print.md §6.5). */
  urls: string[];
  bound: BoundAddr[];
  /** SHA-256 of the certificate, `4F:A1:…` (print.md §6.3). */
  fingerprint: string;
  /** The notice when a certificate was made, else undefined. */
  certNotice?: PasshError;
  /** Addresses not used, `<name>: <addr> is …` (shown as `not used: …`). */
  skipped: PasshError[];
  /** When the server stops by itself (ms since the epoch). */
  expires: number;
  ttl: bigint;
  /** Stops the server (Esc, `Stop`); idempotent. */
  stop(): void;
  /** Settles with the result once the server has stopped. */
  done: Promise<PrintPageResult>;
  /** The result, once stopped. */
  result(): PrintPageResult | undefined;
  /** The QR code of URL i for a terminal (level L, print.md §6.9). */
  terminalQr(i: number): string;
}

export interface StartOptions {
  sheet: Sheet;
  settings: PrintWebSettings;
  /** `<state>` (`$XDG_STATE_HOME/passh`); the certificate goes to `<state>/print-web/`. */
  stateDir: string;
  /** Cancellation (TUI lock or exit, signals in the CLI dialog). */
  signal?: AbortSignal;
  /** The clock (ms since the epoch). */
  now?: () => number;
  /** The system's interfaces (tests). */
  interfaces?: Map<string, Interface>;
}

const ONE_MIN = MIN;
const FIFTEEN_MIN = 15n * MIN;
const MAX_HEADER = 16 * 1024;

const STATUS_TEXT: Record<number, string> = { 200: "OK", 400: "Bad Request", 404: "Not Found", 405: "Method Not Allowed", 410: "Gone", 421: "Misdirected Request", 431: "Request Header Fields Too Large" };

/** Checks the settings (print.md §6.1 steps 1–4) before anything listens. */
export function checkSettings(s: PrintWebSettings): void {
  if (!s.enabled) throw errorf("the print page is off: set enabled = true in the [print_web] table of the config file");
  if (s.ttl < ONE_MIN || s.ttl > FIFTEEN_MIN) throw errorf("print_web.ttl: %s is not between 1m0s and 15m0s", formatGoDuration(s.ttl));
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) throw errorf("print_web.port: %d is not between 1 and 65535", s.port);
  for (const h of s.hostnames) if (h === "" || /[ \t\r\n/[\]]/.test(h)) throw errorf("print_web.hostnames: %q is not a hostname", h);
}

/** A new token: 16 bytes from the CSPRNG, base64url without padding (print.md §6.5). */
export function newToken(): string {
  return randomBytes(16).toString("base64url");
}

function listenError(addr: BoundAddr, port: number, e: unknown): PasshError {
  const code = (e as { code?: string })?.code;
  const host = addr.ip.length === 16 ? `[${addr.text}]` : addr.text;
  const reason = code && /^E[A-Z]+$/.test(code) ? errnoText(code) : e instanceof Error ? e.message : String(e);
  return errorf("print page: %s", new Error(`listen tcp ${host}:${port}: bind: ${reason}`));
}

/**
 * Starts the print page (print.md §6.1): checks the settings, resolves the addresses,
 * loads or makes the certificate, makes the token, listens on every address (a failure
 * closes the others) and starts the countdown. Throws with nothing listening on failure.
 */
export async function startPrintPage(opts: StartOptions): Promise<PrintPage> {
  const now = opts.now ?? Date.now;
  const s = opts.settings;
  checkSettings(s);
  const plan = planAddresses(s.interfaces, opts.interfaces);
  if (plan.bound.length === 0) throw noAddressError(s.interfaces, plan);
  const ranges = allowedRanges(plan.bound, s.allowFrom);
  const cert = loadOrCreateCertificate(opts.stateDir, plan.bound.map((b) => b.ip), s.hostnames, new Date(now()));
  return openPage({
    sheet: opts.sheet,
    settings: s,
    bound: plan.bound,
    ranges,
    token: newToken(),
    certPem: cert.certPem,
    keyPem: cert.keyPem,
    fingerprint: cert.fingerprint,
    certNotice: cert.madeBecause ? certificateNotice(cert.madeBecause) : undefined,
    skipped: plan.skipped,
    signal: opts.signal,
    now,
  });
}

/** Everything §6.1 steps 1–7 produce; openPage listens and starts the countdown (steps 8–9). */
export interface PreparedPage {
  sheet: Sheet;
  settings: PrintWebSettings;
  bound: BoundAddr[];
  ranges: Cidr[];
  token: string;
  certPem: string;
  keyPem: string;
  fingerprint: string;
  certNotice?: PasshError;
  skipped: PasshError[];
  signal?: AbortSignal;
  now?: () => number;
}

/**
 * Listens on every bound address (a failure closes the others: `print page: listen tcp …`)
 * and starts the countdown (print.md §6.1 steps 8–9). startPrintPage calls it after
 * resolving the addresses; tests call it directly to serve on loopback.
 */
export async function openPage(p: PreparedPage): Promise<PrintPage> {
  const now = p.now ?? Date.now;
  const server = new PageServer(p.sheet, p.settings, p.bound, p.ranges, p.token, p.certPem, p.keyPem, now);
  await server.listen();
  const ttlMs = Number(p.settings.ttl / 1_000_000n);
  server.start(now() + ttlMs, p.signal);
  const urls = p.bound.map((b) => pageUrl(b, p.settings.port, p.token));
  return {
    urls,
    bound: p.bound,
    fingerprint: p.fingerprint,
    certNotice: p.certNotice,
    skipped: p.skipped,
    expires: server.expires,
    ttl: p.settings.ttl,
    stop: () => server.finish("cancelled"),
    done: server.done,
    result: () => server.result,
    terminalQr: (i: number) => renderTerminal(encodeText(urls[i]!, "L")),
  };
}

// ---------------------------------------------------------------------------

interface Request {
  method: string;
  target: string;
  proto: string;
  headers: Array<[string, string]>;
  /** Bytes the head took in the buffer. */
  headLength: number;
  bodyLength: number;
  chunked: boolean;
}

/**
 * A request the HTTP layer refuses before the table of §6.6 (not normative; Go's answers):
 * `status` 400 or 431; `detail` is shown after the status text for Go's status errors
 * (`400 Bad Request: missing required Host header`), else nothing.
 */
class BadRequest extends Error {
  constructor(
    message: string,
    readonly detail = "",
    readonly status = 400,
  ) {
    super(message);
  }
}

/** The Host check (print.md §6.6 row 1). */
export function hostAllowed(host: string, port: number, bound: readonly BoundAddr[], hostnames: readonly string[]): boolean {
  if (host === "") return false;
  let h = host;
  let p: string | undefined;
  if (h.startsWith("[")) {
    const close = h.indexOf("]");
    if (close < 0) return false;
    const rest = h.slice(close + 1);
    h = h.slice(1, close);
    if (rest !== "") {
      if (!rest.startsWith(":")) return false;
      p = rest.slice(1);
    }
  } else {
    const colons = h.split(":").length - 1;
    if (colons === 1) {
      const i = h.indexOf(":");
      p = h.slice(i + 1);
      h = h.slice(0, i);
    }
  }
  if (p !== undefined && p !== String(port)) return false;
  if (h === "") return false;
  const lit = parseAddr(h);
  if (lit) {
    if (lit.zone !== "") return false;
    const ip = unmap(lit.addr);
    return bound.some((b) => b.ip.length === ip.length && b.ip.every((x, i) => x === ip[i]));
  }
  const name = h.endsWith(".") ? h.slice(0, -1) : h;
  // SPEC-GAP (print.md §6.6 "compared case-insensitively"): Unicode simple folding, like Go's EqualFold.
  return hostnames.some((n) => foldEquals(n, name));
}

/** Percent-decodes a path like Go's url.PathUnescape; throws on a bad escape. */
function unescapePath(s: string): string {
  if (!s.includes("%")) return s;
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "%") {
      const hx = s.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hx)) throw new BadRequest("invalid URL escape");
      bytes.push(parseInt(hx, 16));
      i += 2;
    } else bytes.push(...enc.encode(c));
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** The path and authority of a request target (origin or absolute form), like Go's ParseRequestURI. */
export function parseTarget(target: string): { path: string; authority?: string } {
  if (target === "*") return { path: "*" };
  const q = target.indexOf("?");
  let rest = q >= 0 ? target.slice(0, q) : target;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(rest);
  if (scheme) {
    rest = rest.slice(scheme[0].length);
    let authority: string | undefined;
    if (rest.startsWith("//")) {
      const slash = rest.indexOf("/", 2);
      authority = slash < 0 ? rest.slice(2) : rest.slice(2, slash);
      rest = slash < 0 ? "" : rest.slice(slash);
      const at = authority.lastIndexOf("@");
      if (at >= 0) authority = authority.slice(at + 1);
    }
    return { path: unescapePath(rest), authority };
  }
  if (!rest.startsWith("/")) throw new BadRequest("invalid URI for request");
  return { path: unescapePath(rest) };
}

/** Parses one request head from the buffer, or undefined if incomplete. */
function parseHead(buf: Buffer): Request | undefined {
  let end = buf.indexOf("\r\n\r\n");
  let sep = 4;
  const lf = buf.indexOf("\n\n");
  if (lf >= 0 && (end < 0 || lf < end)) {
    end = lf;
    sep = 2;
  }
  if (end < 0) {
    if (buf.length > MAX_HEADER) throw new BadRequest("header too large", "", 431);
    return undefined;
  }
  if (end > MAX_HEADER) throw new BadRequest("header too large", "", 431);
  const lines = buf.subarray(0, end).toString("latin1").split(/\r?\n/);
  const m = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+) (\S+) (HTTP\/\d\.\d)$/.exec(lines[0] ?? "");
  if (!m) throw new BadRequest("malformed request line");
  const headers: Array<[string, string]> = [];
  for (const l of lines.slice(1)) {
    const c = l.indexOf(":");
    if (c <= 0) throw new BadRequest("malformed header");
    headers.push([l.slice(0, c).trim().toLowerCase(), l.slice(c + 1).trim()]);
  }
  const te = headers.find(([k]) => k === "transfer-encoding")?.[1].toLowerCase();
  const cl = headers.find(([k]) => k === "content-length")?.[1];
  let bodyLength = 0;
  if (cl !== undefined && te === undefined) {
    if (!/^[0-9]+$/.test(cl)) throw new BadRequest("bad content length");
    bodyLength = Number(cl);
  }
  return { method: m[1]!, target: m[2]!, proto: m[3]!, headers, headLength: end + sep, bodyLength, chunked: te === "chunked" };
}

/** Skips a chunked body; returns the bytes it took, or undefined if incomplete. */
function chunkedLength(buf: Buffer, start: number): number | undefined {
  let p = start;
  for (;;) {
    const eol = buf.indexOf("\r\n", p);
    if (eol < 0) return undefined;
    const size = parseInt(buf.subarray(p, eol).toString("latin1").split(";")[0]!.trim(), 16);
    if (Number.isNaN(size)) throw new BadRequest("bad chunk");
    p = eol + 2;
    if (size === 0) {
      // trailers until an empty line
      for (;;) {
        const e2 = buf.indexOf("\r\n", p);
        if (e2 < 0) return undefined;
        const empty = e2 === p;
        p = e2 + 2;
        if (empty) return p - start;
      }
    }
    if (buf.length < p + size + 2) return undefined;
    p += size + 2;
  }
}

/** A Go-like bufio.Writer of 2048 bytes in front of the chunked encoding (the reference's chunk sizes). */
class ChunkedWriter {
  private buf = Buffer.alloc(2048);
  private n = 0;
  constructor(private readonly emit: (chunk: Buffer) => void) {}

  private chunk(p: Buffer): void {
    if (p.length === 0) return;
    this.emit(Buffer.concat([Buffer.from(p.length.toString(16) + "\r\n", "latin1"), p, Buffer.from("\r\n", "latin1")]));
  }

  write(s: string): void {
    let p = Buffer.from(s, "utf8");
    while (p.length > this.buf.length - this.n) {
      if (this.n === 0) {
        this.chunk(p);
        return;
      }
      const k = this.buf.length - this.n;
      p.copy(this.buf, this.n, 0, k);
      this.n += k;
      this.flush();
      p = p.subarray(k);
    }
    p.copy(this.buf, this.n);
    this.n += p.length;
  }

  flush(): void {
    if (this.n === 0) return;
    this.chunk(Buffer.from(this.buf.subarray(0, this.n)));
    this.n = 0;
  }
}

class PageServer {
  readonly done: Promise<PrintPageResult>;
  result: PrintPageResult | undefined;
  expires = 0;
  private resolve!: (r: PrintPageResult) => void;
  private listeners: net.Server[] = [];
  private conns = new Set<net.Socket>();
  private ctx: tls.SecureContext;
  private wrong = 0;
  private consumed = false;
  private serving: { client: string; sock: tls.TLSSocket } | undefined;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private abort: (() => void) | undefined;
  private signal: AbortSignal | undefined;

  constructor(
    private readonly sheet: Sheet,
    private readonly s: PrintWebSettings,
    private readonly bound: BoundAddr[],
    private readonly ranges: Cidr[],
    private readonly token: string,
    certPem: string,
    keyPem: string,
    private readonly now: () => number,
  ) {
    this.done = new Promise((r) => (this.resolve = r));
    this.ctx = tls.createSecureContext({ key: keyPem, cert: certPem, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" });
  }

  async listen(): Promise<void> {
    for (const b of this.bound) {
      const srv = net.createServer({ pauseOnConnect: true }, (sock) => this.accept(sock));
      try {
        await new Promise<void>((resolve, reject) => {
          srv.once("error", reject);
          srv.listen({ port: this.s.port, host: b.text, exclusive: true }, () => {
            srv.off("error", reject);
            resolve();
          });
        });
      } catch (e) {
        for (const l of this.listeners) l.close();
        srv.close();
        this.listeners = [];
        throw listenError(b, this.s.port, e);
      }
      srv.on("error", () => {});
      this.listeners.push(srv);
    }
  }

  start(expires: number, signal?: AbortSignal): void {
    this.expires = expires;
    this.timers.push(setTimeout(() => this.finish("expired"), Math.max(0, expires - this.now())));
    if (signal) {
      this.signal = signal;
      if (signal.aborted) this.finish("cancelled");
      else {
        this.abort = () => this.finish("cancelled");
        signal.addEventListener("abort", this.abort, { once: true });
      }
    }
  }

  private closeListeners(): void {
    for (const l of this.listeners) l.close();
    this.listeners = [];
  }

  /** Ends the server with an outcome (the first one wins). */
  finish(outcome: Outcome, err?: Error): void {
    if (this.result) return;
    const client = this.serving?.client;
    let r: PrintPageResult;
    switch (outcome) {
      case "served":
        r = { outcome, client, message: errorf("the page was served to %s; if that wasn't you, start the print page again", client) };
        break;
      case "failed":
        r = { outcome, client, message: errorf("the page was only partly sent to %s (%v); start the print page again", client, err ?? new Error("unknown error")) };
        break;
      case "too-many-wrong-tokens":
        r = { outcome, message: errorf("the print page stopped after 5 requests with a wrong address") };
        break;
      case "expired":
      case "cancelled":
        if (client) r = { outcome: "cancelled", client, message: errorf("the print page was stopped while it was sent to %s", client) };
        else if (outcome === "expired") r = { outcome, message: errorf("the print page stopped after %s without being opened", formatGoDuration(this.s.ttl)) };
        else r = { outcome, message: errorf("the print page was stopped") };
        break;
    }
    this.result = r;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.signal && this.abort) this.signal.removeEventListener("abort", this.abort);
    this.closeListeners();
    for (const c of this.conns) c.destroy();
    this.conns.clear();
    this.resolve(r);
  }

  private accept(raw: net.Socket): void {
    // Closed before any TLS byte when the peer is outside the allowed ranges (print.md §6.2).
    if (this.result || !peerAllowed(peerAddress(raw.remoteAddress), this.ranges)) {
      raw.destroy();
      return;
    }
    raw.on("error", () => {});
    this.conns.add(raw);
    raw.on("close", () => this.conns.delete(raw));
    const sock = new tls.TLSSocket(raw, { isServer: true, secureContext: this.ctx, ALPNProtocols: ["http/1.1"] } as tls.TLSSocketOptions);
    sock.on("error", () => sock.destroy());
    sock.setTimeout(20_000, () => {
      if (this.serving?.sock !== sock) sock.destroy();
    });
    const client = formatAddr(peerAddress(raw.remoteAddress)!);
    let buf: Buffer = Buffer.alloc(0);
    let busy = false;
    const pump = () => {
      while (!busy && !sock.destroyed) {
        let req: Request | undefined;
        try {
          req = parseHead(buf);
        } catch (e) {
          this.badRequest(sock, e);
          return;
        }
        if (!req) return;
        let bodyLen = req.bodyLength;
        if (req.chunked) {
          let n: number | undefined;
          try {
            n = chunkedLength(buf, req.headLength);
          } catch (e) {
            this.badRequest(sock, e);
            return;
          }
          if (n === undefined) return;
          bodyLen = n;
        } else if (buf.length < req.headLength + bodyLen) return;
        buf = buf.subarray(req.headLength + bodyLen);
        busy = true;
        this.handle(sock, req, client, () => {
          busy = false;
          pump();
        });
      }
    };
    sock.on("data", (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      pump();
    });
    raw.resume();
  }

  private badRequest(sock: tls.TLSSocket, e?: unknown): void {
    const b = e instanceof BadRequest ? e : new BadRequest("bad request");
    const text = `${b.status} ${STATUS_TEXT[b.status]}${b.detail ? ": " + b.detail : ""}`;
    sock.end(`HTTP/1.1 ${text}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${text}`);
  }

  /** Headers of every response (print.md §6.6 row 0) plus the given ones, sorted by name like Go. */
  private headerLines(extra: Array<[string, string]>): string {
    const h: Array<[string, string]> = [
      ["Cache-Control", "no-store"],
      ["Content-Security-Policy", contentSecurityPolicy()],
      ["Referrer-Policy", "no-referrer"],
      ["X-Content-Type-Options", "nosniff"],
      ...extra,
    ];
    h.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return h.map(([k, v]) => `${k}: ${v}\r\n`).join("");
  }

  private simple(sock: tls.TLSSocket, req: Request, code: number, body: string, extra: Array<[string, string]>, done: () => void): void {
    const is11 = req.proto === "HTTP/1.1";
    const asked = /(^|,)\s*close\s*(,|$)/i.test(req.headers.find(([k]) => k === "connection")?.[1] ?? "");
    // HTTP/1.0 closes after the reply without saying so; HTTP/1.1 says it when asked to close.
    const close = !is11 || asked;
    const b = Buffer.from(body, "utf8");
    let head = `${is11 ? "HTTP/1.1" : "HTTP/1.0"} ${code} ${STATUS_TEXT[code]}\r\n`;
    head += this.headerLines([["Content-Type", "text/plain; charset=utf-8"], ...extra]);
    head += `Date: ${new Date(this.now()).toUTCString()}\r\nContent-Length: ${b.length}\r\n`;
    if (is11 && asked) head += "Connection: close\r\n";
    head += "\r\n";
    const data = req.method === "HEAD" ? Buffer.from(head, "latin1") : Buffer.concat([Buffer.from(head, "latin1"), b]);
    if (close) {
      sock.end(data);
      return;
    }
    sock.write(data);
    done();
  }

  private handle(sock: tls.TLSSocket, req: Request, client: string, done: () => void): void {
    if (this.result) {
      sock.destroy();
      return;
    }
    let target: { path: string; authority?: string };
    try {
      target = parseTarget(req.target);
    } catch {
      this.badRequest(sock);
      return;
    }
    const hosts = req.headers.filter(([k]) => k === "host").map(([, v]) => v);
    if (req.proto === "HTTP/1.1" && hosts.length === 0) {
      this.badRequest(sock, new BadRequest("no host", "missing required Host header"));
      return;
    }
    if (hosts.length > 1) {
      this.badRequest(sock, new BadRequest("hosts", "too many Host headers"));
      return;
    }
    if (hosts.length === 1 && /[\x00-\x20\x7f"<>\\^`{|}]/.test(hosts[0]!)) {
      this.badRequest(sock, new BadRequest("host", "malformed Host header"));
      return;
    }
    if (req.method === "OPTIONS" && req.target === "*") {
      this.simplePlain(sock, req, done);
      return;
    }
    const host = target.authority ?? hosts[0] ?? "";
    // 1. Host
    if (!hostAllowed(host, this.s.port, this.bound, this.s.hostnames)) {
      this.simple(sock, req, 421, T("misdirected request: unknown host") + "\n", [], done);
      return;
    }
    // 2. not under /p/
    if (!target.path.startsWith("/p/")) {
      this.simple(sock, req, 404, "404 page not found\n", [], done);
      return;
    }
    // 3. wrong token (constant-time comparison)
    const got = Buffer.from(target.path.slice(3), "utf8");
    const want = Buffer.from(this.token, "utf8");
    const ok = got.length === want.length && timingSafeEqual(got, want);
    if (!ok) {
      this.wrong++;
      this.simple(sock, req, 404, "404 page not found\n", [], done);
      if (this.wrong >= MAX_WRONG_TOKENS && !this.consumed) this.finish("too-many-wrong-tokens");
      return;
    }
    // 4. method
    if (req.method !== "GET") {
      this.simple(sock, req, 405, T("method not allowed") + "\n", [["Allow", "GET"]], done);
      return;
    }
    // 5. consumed
    if (this.consumed) {
      this.simple(sock, req, 410, T("already used: start the print page again in passh") + "\n", [], done);
      return;
    }
    // 6. too many wrong tokens
    if (this.wrong >= MAX_WRONG_TOKENS) {
      this.simple(sock, req, 410, T("stopped after too many wrong addresses: start the print page again in passh") + "\n", [], done);
      return;
    }
    // 7. the page
    this.servePage(sock, req, client);
  }

  /** `OPTIONS *`: Go's library answers 200 with an empty body (informative). */
  private simplePlain(sock: tls.TLSSocket, req: Request, done: () => void): void {
    const asked = /(^|,)\s*close\s*(,|$)/i.test(req.headers.find(([k]) => k === "connection")?.[1] ?? "");
    const is11 = req.proto === "HTTP/1.1";
    const head = `${is11 ? "HTTP/1.1" : "HTTP/1.0"} 200 OK\r\nContent-Length: 0\r\nDate: ${new Date(this.now()).toUTCString()}\r\n${is11 && asked ? "Connection: close\r\n" : ""}\r\n`;
    if (!is11 || asked) {
      sock.end(head);
      return;
    }
    sock.write(head);
    done();
  }

  private servePage(sock: tls.TLSSocket, req: Request, client: string): void {
    this.consumed = true;
    this.serving = { client, sock };
    // The listeners close at once; connections already open stay (print.md §6.7).
    this.closeListeners();
    // SPEC-GAP (print.md §6.7): the 30 s wait for the page is cut short by Expires, Stop or
    // cancellation; those end as "Cancelled (with client)" (the expiry timer below, finish()),
    // and running out of the 30 s itself as "Failed" with `i/o timeout`.
    const wait = Math.min(SERVE_WAIT_MS, Math.max(0, this.expires - this.now()));
    this.timers.push(setTimeout(() => this.finish("failed", new Error("i/o timeout")), wait));
    const is11 = req.proto === "HTTP/1.1";
    let head = `${is11 ? "HTTP/1.1" : "HTTP/1.0"} 200 OK\r\n`;
    head += this.headerLines([["Content-Type", "text/html; charset=utf-8"]]);
    head += `Date: ${new Date(this.now()).toUTCString()}\r\nConnection: close\r\n`;
    if (is11) head += "Transfer-Encoding: chunked\r\n";
    head += "\r\n";
    let failed: Error | undefined;
    const onError = (e: Error) => {
      failed ??= e;
      this.finish("failed", e);
    };
    sock.on("error", onError);
    sock.on("close", () => {
      if (!this.result) onError(failed ?? new Error("connection closed by the client"));
    });
    const write = (b: Buffer | string) => {
      if (!sock.destroyed) sock.write(b);
    };
    write(Buffer.from(head, "latin1"));
    try {
      if (is11) {
        const w = new ChunkedWriter((c) => write(c));
        for (const piece of pagePieces(this.sheet)) w.write(piece);
        w.flush();
        sock.end("0\r\n\r\n", () => {
          if (!failed) this.finish("served");
        });
      } else {
        let page = "";
        for (const piece of pagePieces(this.sheet)) page += piece;
        sock.end(Buffer.from(page, "utf8"), () => {
          if (!failed) this.finish("served");
        });
      }
    } catch (e) {
      onError(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
