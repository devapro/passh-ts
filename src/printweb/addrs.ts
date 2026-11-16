// The print page's addresses and allowed clients (print.md §6.2).
//
// allow_from: a non-empty list REPLACES the default ranges (the subnets of the bound
// addresses); any CIDR the config accepted is used as given (masked), public ranges and
// 0.0.0.0/0 included. This is the current behaviour of print.md §6.2; spec §14 question 4
// (replace or intersect, refuse /0 and public ranges) is the owner's to decide.

import { T, errorf, type Localizable, type PasshError } from "../i18n/index.ts";
import { cidrContains, formatAddr, parseAddr, parseCidr, type Cidr } from "../config/cidr.ts";
import { listInterfaces, type Interface } from "./ifaddrs.ts";

/** An address the server listens on. */
export interface BoundAddr {
  iface: string;
  /** 4 or 16 bytes (IPv4-mapped forms unmapped). */
  ip: Uint8Array;
  /** The interface prefix length. */
  prefix: number;
  /** Go's text form (`192.168.1.10`, `fd12:3456::1`). */
  text: string;
}

/** The result of §6.2: what is bound, and what was skipped and why. */
export interface AddressPlan {
  bound: BoundAddr[];
  /** `<name>: no such network interface` / `<name>: no address` (shown only if nothing is bound). */
  problems: PasshError[];
  /** `<name>: <addr> is …` (shown as `not used: …`). */
  skipped: PasshError[];
}

const PRIVATE_RANGES: Cidr[] = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7"].map((s) => parseCidr(s)!);

/** IPv4-mapped IPv6 (`::ffff:a.b.c.d`) as IPv4; other addresses unchanged. */
export function unmap(ip: Uint8Array): Uint8Array {
  if (ip.length === 16 && ip.subarray(0, 10).every((b) => b === 0) && ip[10] === 0xff && ip[11] === 0xff) return ip.slice(12);
  return ip;
}

/** Reports whether an address is in one of the private ranges (RFC 1918, 100.64.0.0/10, fc00::/7). */
export function isPrivate(ip: Uint8Array): boolean {
  return PRIVATE_RANGES.some((c) => cidrContains(c, ip));
}

function isLinkLocal(ip: Uint8Array): boolean {
  if (ip.length === 4) return (ip[0] === 169 && ip[1] === 254) || (ip[0] === 224 && ip[1] === 0 && ip[2] === 0);
  return (ip[0] === 0xfe && (ip[1]! & 0xc0) === 0x80) || (ip[0] === 0xff && (ip[1]! & 0x0f) === 0x02);
}

function isUnspecified(ip: Uint8Array): boolean {
  return ip.every((b) => b === 0);
}

function isLoopback(ip: Uint8Array): boolean {
  if (ip.length === 4) return ip[0] === 127;
  return ip.subarray(0, 15).every((b) => b === 0) && ip[15] === 1;
}

function isMulticast(ip: Uint8Array): boolean {
  return ip.length === 4 ? (ip[0]! & 0xf0) === 0xe0 : ip[0] === 0xff;
}

/**
 * Why an address is not used (print.md §6.2 step 3), or undefined for a private address.
 * SPEC-GAP (§6.2 "An address with a zone is refused"): interface addresses carry no zone
 * except link-local IPv6 ones, which are refused as link-local first; nothing else to do.
 */
function refusal(name: string, ip: Uint8Array): PasshError | undefined {
  const a = formatAddr(ip);
  if (isLinkLocal(ip)) return errorf("%s: %s is link-local, not used", name, a);
  if (isUnspecified(ip)) return errorf("%s: %s is the wildcard address, never used", name, a);
  if (isLoopback(ip)) return errorf("%s: %s is a loopback address, not private", name, a);
  if (isMulticast(ip)) return errorf("%s: %s is a multicast address, not used", name, a);
  if (!isPrivate(ip)) return errorf("%s: %s is a public address, refused", name, a);
  return undefined;
}

/**
 * Resolves `print_web.interfaces` (print.md §6.2): per interface in order, its addresses
 * (IPv4 before IPv6, otherwise in system order); link-local and non-private ones skipped
 * with a reason, an address already taken dropped silently, the rest bound.
 */
export function planAddresses(interfaces: readonly string[], system: Map<string, Interface> = listInterfaces()): AddressPlan {
  const plan: AddressPlan = { bound: [], problems: [], skipped: [] };
  const taken = new Set<string>();
  for (const name of interfaces) {
    const itf = system.get(name);
    if (!itf) {
      plan.problems.push(errorf("%s: no such network interface", name));
      continue;
    }
    // IPv4-mapped forms unmapped (their prefix counted from the IPv4 part).
    const addrs = itf.addrs.map((a) => {
      const bytes = unmap(a.bytes);
      return { ...a, bytes, prefix: bytes.length < a.bytes.length ? Math.max(0, a.prefix - 96) : a.prefix };
    });
    if (addrs.length === 0) {
      plan.problems.push(errorf("%s: no address", name));
      continue;
    }
    const ordered = [...addrs.filter((a) => a.bytes.length === 4), ...addrs.filter((a) => a.bytes.length === 16)];
    for (const a of ordered) {
      const why = refusal(name, a.bytes);
      if (why) {
        plan.skipped.push(why);
        continue;
      }
      const text = formatAddr(a.bytes);
      // Taken already (same address on two interfaces, or a name listed twice): dropped
      // silently; a name listed twice reports its skipped addresses twice, like the reference.
      if (taken.has(text)) continue;
      taken.add(text);
      plan.bound.push({ iface: name, ip: a.bytes, prefix: a.prefix, text });
    }
  }
  return plan;
}

/** A list of errors joined by `; `, rendered in the language. */
class Joined implements Localizable {
  constructor(readonly items: readonly PasshError[]) {}
  localize(): string {
    return this.items.map((e) => e.localize()).join("; ");
  }
  toString(): string {
    return this.items.map((e) => e.message).join("; ");
  }
}

/** The error when nothing can be bound (print.md §6.2). */
export function noAddressError(interfaces: readonly string[], plan: AddressPlan): PasshError {
  if (interfaces.length === 0) return errorf('print_web.interfaces is empty: name the interfaces of your LAN or VPN, e.g. ["eth0", "wg0"]');
  return errorf("the print page has no private address to listen on (print_web.interfaces): %s", new Joined([...plan.problems, ...plan.skipped]));
}

function mask(ip: Uint8Array, bits: number): Cidr {
  const c = parseCidr(`${formatAddr(ip)}/${bits}`);
  if (!c) throw new Error("print page: bad prefix");
  return c;
}

/**
 * The allowed client ranges (print.md §6.2): `allow_from` (masked) when it isn't empty;
 * otherwise each bound address's interface prefix masked to its network, a host prefix
 * (/32, /128) replaced by the private range that holds it; duplicates removed.
 */
export function allowedRanges(bound: readonly BoundAddr[], allowFrom: readonly string[]): Cidr[] {
  const out: Cidr[] = [];
  const seen = new Set<string>();
  const add = (c: Cidr) => {
    if (seen.has(c.text)) return;
    seen.add(c.text);
    out.push(c);
  };
  if (allowFrom.length > 0) {
    for (const s of allowFrom) {
      const c = parseCidr(s);
      if (!c) throw errorf('print_web.allow_from: %q is not a CIDR such as "192.168.1.0/24" or "fd00::/8"', s);
      add(c);
    }
    return out;
  }
  for (const b of bound) {
    const host = b.prefix === b.ip.length * 8;
    if (host) {
      const range = PRIVATE_RANGES.find((r) => cidrContains(r, b.ip));
      if (range) add(range);
      continue;
    }
    add(mask(b.ip, b.prefix));
  }
  return out;
}

/** Parses a peer address as Node reports it (`::ffff:1.2.3.4`, `fe80::1%eth0`): unmapped, zone dropped. */
export function peerAddress(remote: string | undefined): Uint8Array | undefined {
  if (!remote) return undefined;
  const a = parseAddr(remote.replace(/%.*$/, ""));
  return a ? unmap(a.addr) : undefined;
}

/** Reports whether a peer is inside one of the allowed ranges. */
export function peerAllowed(peer: Uint8Array | undefined, ranges: readonly Cidr[]): boolean {
  if (!peer) return false;
  return ranges.some((r) => cidrContains(r, peer));
}

/** `https://<addr>:<port>/p/<token>`, IPv6 in brackets (print.md §6.5). */
export function pageUrl(b: BoundAddr, port: number, token: string): string {
  const host = b.ip.length === 16 ? `[${b.text}]` : b.text;
  return `https://${host}:${port}/p/${token}`;
}

/** `not used: <reason>` lines for the dialog. */
export function skippedLines(plan: AddressPlan): string[] {
  return plan.skipped.map((e) => T("not used: %s", e));
}

