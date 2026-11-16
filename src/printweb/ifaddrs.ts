// Network interfaces and their addresses (print.md §6.2 step 2), from getifaddrs(3) through
// bun:ffi. os.networkInterfaces() can't be used: it leaves out interfaces that are down,
// while print.md says the up/down state is not checked (an address on a down interface is
// bound like any other). Falls back to os.networkInterfaces() if the call isn't available.

import { dlopen, FFIType, read, CString, type Pointer } from "bun:ffi";
import { networkInterfaces } from "node:os";
import { parseAddr } from "../config/cidr.ts";

const IS_DARWIN = process.platform === "darwin";
const AF_INET = 2;
const AF_INET6 = IS_DARWIN ? 30 : 10;

/** One address of an interface: 4 or 16 bytes, its prefix length, and the IPv6 zone (scope id). */
export interface IfAddr {
  bytes: Uint8Array;
  prefix: number;
  /** IPv6 scope id (0 = none). */
  scope: number;
}

export interface Interface {
  name: string;
  /** Addresses in system order. */
  addrs: IfAddr[];
}

type Lib = { symbols: { getifaddrs(p: BigUint64Array): number; freeifaddrs(p: Pointer): void } };
let lib: Lib | null | undefined;

function load(): Lib | null {
  if (lib !== undefined) return lib;
  const names = IS_DARWIN ? ["/usr/lib/libSystem.B.dylib", "libc.dylib"] : ["libc.so.6"];
  for (const n of names) {
    try {
      lib = dlopen(n, {
        getifaddrs: { args: [FFIType.ptr], returns: FFIType.i32 },
        freeifaddrs: { args: [FFIType.ptr], returns: FFIType.void },
      }) as unknown as Lib;
      return lib;
    } catch {
      /* try the next name */
    }
  }
  lib = null;
  return lib;
}

function family(sa: Pointer): number {
  // Linux: sa_family is a u16 at 0. BSD/macOS: sa_len u8 at 0, sa_family u8 at 1.
  return IS_DARWIN ? read.u8(sa, 1) : read.u16(sa, 0);
}

function sockaddrBytes(sa: Pointer, fam: number): Uint8Array {
  const n = fam === AF_INET ? 4 : 16;
  const off = fam === AF_INET ? 4 : 8;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = read.u8(sa, off + i);
  return out;
}

function prefixOf(mask: Uint8Array): number {
  let n = 0;
  for (const b of mask) {
    for (let bit = 7; bit >= 0; bit--) {
      if ((b >> bit) & 1) n++;
      else return n;
    }
  }
  return n;
}

/** Every interface by name, with its IPv4 and IPv6 addresses (getifaddrs order). */
export function listInterfaces(): Map<string, Interface> {
  const l = load();
  if (!l) return fromNode();
  const box = new BigUint64Array(1);
  if (l.symbols.getifaddrs(box) !== 0) return fromNode();
  const head = Number(box[0]) as Pointer;
  const out = new Map<string, Interface>();
  try {
    for (let p = head; p; ) {
      const namePtr = read.ptr(p, 8) as Pointer;
      const name = namePtr ? new CString(namePtr).toString() : "";
      let itf = out.get(name);
      if (!itf) out.set(name, (itf = { name, addrs: [] }));
      const addr = read.ptr(p, 24) as Pointer;
      const mask = read.ptr(p, 32) as Pointer;
      if (addr) {
        const fam = family(addr);
        if (fam === AF_INET || fam === AF_INET6) {
          const bytes = sockaddrBytes(addr, fam);
          const prefix = mask ? prefixOf(sockaddrBytes(mask, fam)) : fam === AF_INET ? 32 : 128;
          const scope = fam === AF_INET6 ? read.u32(addr, 24) : 0;
          itf.addrs.push({ bytes, prefix, scope });
        }
      }
      p = read.ptr(p, 0) as Pointer;
    }
  } finally {
    l.symbols.freeifaddrs(head);
  }
  return out;
}

function fromNode(): Map<string, Interface> {
  const out = new Map<string, Interface>();
  for (const [name, list] of Object.entries(networkInterfaces())) {
    const itf: Interface = { name, addrs: [] };
    for (const a of list ?? []) {
      const [ip, pfx] = (a.cidr ?? `${a.address}/${a.family === "IPv4" ? 32 : 128}`).split("/");
      const parsed = parseAddr(ip!.replace(/%.*$/, ""));
      if (parsed) itf.addrs.push({ bytes: parsed.addr, prefix: Number(pfx), scope: a.family === "IPv6" ? (a.scopeid ?? 0) : 0 });
    }
    out.set(name, itf);
  }
  return out;
}
