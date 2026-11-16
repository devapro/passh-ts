// CIDR prefixes for print_web.allow_from (storage.md §2.3): parsed like Go's
// netip.ParsePrefix (IPv4 without leading zeros, IPv6 with an optional embedded IPv4, no
// zone, bits without a sign or leading zeros) and masked (`10.1.2.3/8` = `10.0.0.0/8`).

export interface Cidr {
  /** 4 for an IPv4 prefix; 6 for IPv6 (an IPv4-mapped address such as ::ffff:1.2.3.4 stays IPv6). */
  family: 4 | 6;
  /** The masked address: 4 or 16 bytes. */
  addr: Uint8Array;
  /** The prefix length. */
  bits: number;
  /** The canonical masked prefix as Go writes it: "10.0.0.0/8", "fd00::/8", "::ffff:1.2.3.0/120". */
  text: string;
}

/** Parses an IPv4 address in dotted decimal (4 fields, 0–255, no leading zeros). */
export function parseIPv4(s: string): Uint8Array | undefined {
  const parts = s.split(".");
  if (parts.length !== 4) return undefined;
  const out = new Uint8Array(4);
  for (let k = 0; k < 4; k++) {
    const p = parts[k]!;
    if (!/^[0-9]{1,3}$/.test(p)) return undefined;
    if (p.length > 1 && p[0] === "0") return undefined;
    const v = Number(p);
    if (v > 255) return undefined;
    out[k] = v;
  }
  return out;
}

/** Parses an IPv6 address (RFC 4291 text forms, embedded IPv4 allowed); returns its zone too. */
export function parseIPv6(input: string): { addr: Uint8Array; zone: string } | undefined {
  let s = input;
  let zone = "";
  const pct = s.indexOf("%");
  if (pct >= 0) {
    zone = s.slice(pct + 1);
    s = s.slice(0, pct);
    if (zone === "") return undefined;
  }
  const ip = new Uint8Array(16);
  let ellipsis = -1;
  let i = 0;
  if (s.startsWith("::")) {
    ellipsis = 0;
    s = s.slice(2);
    if (s === "") return { addr: ip, zone };
  }
  while (i < 16) {
    let off = 0;
    let acc = 0;
    while (off < s.length) {
      const c = s[off]!;
      const v = /[0-9]/.test(c) ? c.charCodeAt(0) - 48 : /[a-f]/.test(c) ? c.charCodeAt(0) - 87 : /[A-F]/.test(c) ? c.charCodeAt(0) - 55 : -1;
      if (v < 0) break;
      off++;
      if (off > 4) return undefined;
      acc = acc * 16 + v;
    }
    if (off === 0) return undefined;
    if (off < s.length && s[off] === ".") {
      if (ellipsis < 0 && i !== 12) return undefined;
      if (i + 4 > 16) return undefined;
      const v4 = parseIPv4(s);
      if (!v4) return undefined;
      ip.set(v4, i);
      i += 4;
      s = "";
      break;
    }
    ip[i] = acc >> 8;
    ip[i + 1] = acc & 0xff;
    i += 2;
    s = s.slice(off);
    if (s === "") break;
    if (s[0] !== ":" || s.length === 1) return undefined;
    s = s.slice(1);
    if (s[0] === ":") {
      if (ellipsis >= 0) return undefined;
      ellipsis = i;
      s = s.slice(1);
      if (s === "") break;
    }
  }
  if (s !== "") return undefined;
  if (i < 16) {
    if (ellipsis < 0) return undefined;
    const n = 16 - i;
    for (let j = i - 1; j >= ellipsis; j--) ip[j + n] = ip[j]!;
    for (let j = ellipsis + n - 1; j >= ellipsis; j--) ip[j] = 0;
  } else if (ellipsis >= 0) {
    return undefined;
  }
  return { addr: ip, zone };
}

/** Go's netip.Addr.String for an IPv4 or IPv6 address (RFC 5952; IPv4-mapped as ::ffff:a.b.c.d). */
export function formatAddr(addr: Uint8Array): string {
  if (addr.length === 4) return Array.from(addr).join(".");
  const is4in6 = addr.subarray(0, 10).every((b) => b === 0) && addr[10] === 0xff && addr[11] === 0xff;
  if (is4in6) return "::ffff:" + Array.from(addr.subarray(12)).join(".");
  const groups: number[] = [];
  for (let k = 0; k < 8; k++) groups.push((addr[2 * k]! << 8) | addr[2 * k + 1]!);
  let zs = 255;
  let ze = 255;
  for (let k = 0; k < 8; k++) {
    let j = k;
    while (j < 8 && groups[j] === 0) j++;
    const l = j - k;
    if (l >= 2 && l > ze - zs) {
      zs = k;
      ze = j;
    }
  }
  let out = "";
  for (let k = 0; k < 8; k++) {
    if (k === zs) {
      out += "::";
      k = ze - 1;
      continue;
    }
    if (k > 0 && !out.endsWith(":")) out += ":";
    out += groups[k]!.toString(16);
  }
  return out;
}

/** Parses an address like Go's netip.ParseAddr (the first '.' or ':' decides the family). */
export function parseAddr(s: string): { addr: Uint8Array; family: 4 | 6; zone: string } | undefined {
  for (const c of s) {
    if (c === ".") {
      const a = parseIPv4(s);
      return a ? { addr: a, family: 4, zone: "" } : undefined;
    }
    if (c === ":") {
      const a = parseIPv6(s);
      return a ? { addr: a.addr, family: 6, zone: a.zone } : undefined;
    }
    if (c === "%") return undefined;
  }
  return undefined;
}

/**
 * Parses a CIDR prefix like Go's netip.ParsePrefix and masks it. A bare address, a zone,
 * bits with a sign or a leading zero, or bits out of range give undefined.
 */
export function parseCidr(s: string): Cidr | undefined {
  const slash = s.lastIndexOf("/");
  if (slash < 0) return undefined;
  const a = parseAddr(s.slice(0, slash));
  if (!a) return undefined;
  if (a.family === 6 && a.zone !== "") return undefined;
  const bitsStr = s.slice(slash + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(bitsStr) || bitsStr.length > 3) return undefined;
  const bits = Number(bitsStr);
  const max = a.family === 4 ? 32 : 128;
  if (bits > max) return undefined;
  const addr = new Uint8Array(a.addr);
  for (let b = bits; b < max; b++) addr[b >> 3] &= ~(0x80 >> (b & 7));
  return { family: a.family, addr, bits, text: `${formatAddr(addr)}/${bits}` };
}

/** Reports whether the prefix contains the address (4 or 16 bytes, of the prefix's length). */
export function cidrContains(c: Cidr, ip: Uint8Array): boolean {
  if (ip.length !== c.addr.length) return false;
  for (let b = 0; b < c.bits; b++) {
    const m = 0x80 >> (b & 7);
    if ((ip[b >> 3]! & m) !== (c.addr[b >> 3]! & m)) return false;
  }
  return true;
}
