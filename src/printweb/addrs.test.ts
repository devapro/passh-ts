// Addresses and allowed clients of the print page (print.md §6.2).

import { describe, expect, test } from "bun:test";
import { parseAddr } from "../config/cidr.ts";
import { allowedRanges, noAddressError, pageUrl, peerAddress, peerAllowed, planAddresses } from "./addrs.ts";
import type { Interface } from "./ifaddrs.ts";

function itf(name: string, ...addrs: string[]): [string, Interface] {
  return [
    name,
    {
      name,
      addrs: addrs.map((a) => {
        const [ip, pfx] = a.split("/");
        const p = parseAddr(ip!)!;
        return { bytes: p.addr, prefix: Number(pfx), scope: a.startsWith("fe80") ? 2 : 0 };
      }),
    },
  ];
}

const SYSTEM = new Map<string, Interface>([
  itf("lo", "127.0.0.1/8", "::1/128"),
  itf("eth0", "fd12:3456::1/64", "192.168.1.10/24", "fe80::1/64", "8.8.8.8/24"),
  itf("wg0", "100.101.102.103/32", "fd7a:115c:a1e0::1/128"),
  itf("eth1", "192.168.1.10/24", "10.1.2.3/8", "224.0.0.5/32", "0.0.0.0/0", "239.1.1.1/32", "169.254.1.1/16"),
  itf("dummy0"),
  itf("v6map", "::ffff:172.16.5.4/120"),
]);

describe("planAddresses", () => {
  test("IPv4 before IPv6, skipped with reasons, duplicates dropped silently", () => {
    const plan = planAddresses(["eth0", "lo", "eth1", "eth0", "nope", "dummy0", "wg0", "v6map"], SYSTEM);
    expect(plan.bound.map((b) => `${b.iface} ${b.text}/${b.prefix}`)).toEqual([
      "eth0 192.168.1.10/24",
      "eth0 fd12:3456::1/64",
      "eth1 10.1.2.3/8",
      "wg0 100.101.102.103/32",
      "wg0 fd7a:115c:a1e0::1/128",
      "v6map 172.16.5.4/24",
    ]);
    expect(plan.skipped.map((e) => e.message)).toEqual([
      "eth0: 8.8.8.8 is a public address, refused",
      "eth0: fe80::1 is link-local, not used",
      "lo: 127.0.0.1 is a loopback address, not private",
      "lo: ::1 is a loopback address, not private",
      "eth1: 224.0.0.5 is link-local, not used",
      "eth1: 0.0.0.0 is the wildcard address, never used",
      "eth1: 239.1.1.1 is a multicast address, not used",
      "eth1: 169.254.1.1 is link-local, not used",
      "eth0: 8.8.8.8 is a public address, refused",
      "eth0: fe80::1 is link-local, not used",
    ]);
    expect(plan.problems.map((e) => e.message)).toEqual(["nope: no such network interface", "dummy0: no address"]);
  });

  test("nothing bound: problems first, then the skipped addresses", () => {
    const plan = planAddresses(["nope", "lo", "dummy0"], SYSTEM);
    expect(noAddressError(["nope", "lo", "dummy0"], plan).message).toBe(
      "the print page has no private address to listen on (print_web.interfaces): nope: no such network interface; dummy0: no address; lo: 127.0.0.1 is a loopback address, not private; lo: ::1 is a loopback address, not private",
    );
    expect(noAddressError([], planAddresses([], SYSTEM)).message).toBe('print_web.interfaces is empty: name the interfaces of your LAN or VPN, e.g. ["eth0", "wg0"]');
  });
});

describe("allowed clients", () => {
  const bound = planAddresses(["eth0", "wg0"], SYSTEM).bound;

  test("default: the bound subnets; a host prefix becomes its private range", () => {
    expect(allowedRanges(bound, []).map((c) => c.text)).toEqual(["192.168.1.0/24", "fd12:3456::/64", "100.64.0.0/10", "fc00::/7"]);
    expect(allowedRanges(planAddresses(["v6map", "eth1"], SYSTEM).bound, []).map((c) => c.text)).toEqual(["172.16.5.0/24", "192.168.1.0/24", "10.0.0.0/8"]);
  });

  test("allow_from replaces the defaults (masked), whatever it holds", () => {
    expect(allowedRanges(bound, ["10.1.2.3/8", "0.0.0.0/0"]).map((c) => c.text)).toEqual(["10.0.0.0/8", "0.0.0.0/0"]);
    expect(() => allowedRanges(bound, ["10.1.2.3"])).toThrow('print_web.allow_from: "10.1.2.3" is not a CIDR such as "192.168.1.0/24" or "fd00::/8"');
  });

  test("peers: unmapped, zone dropped, inside one range", () => {
    const r = allowedRanges(bound, []);
    expect(peerAllowed(peerAddress("::ffff:192.168.1.77"), r)).toBe(true);
    expect(peerAllowed(peerAddress("192.168.2.1"), r)).toBe(false);
    expect(peerAllowed(peerAddress("fd12:3456::9%eth0"), r)).toBe(true);
    expect(peerAllowed(peerAddress("100.100.1.1"), r)).toBe(true);
    expect(peerAllowed(peerAddress(undefined), r)).toBe(false);
  });

  test("URLs: one per bound address, IPv6 in brackets", () => {
    expect(bound.map((b) => pageUrl(b, 8443, "T"))).toEqual(["https://192.168.1.10:8443/p/T", "https://[fd12:3456::1]:8443/p/T", "https://100.101.102.103:8443/p/T", "https://[fd7a:115c:a1e0::1]:8443/p/T"]);
  });
});
