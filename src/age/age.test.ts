// Unit tests for the age implementation: strict base64, Bech32, the header rules of
// vault-format.md §2.3, STREAM, the recipient types, armor and the --age recipient table.

import { describe, expect, test } from "bun:test";
import {
  AgeDecryptError,
  armor,
  armorText,
  b64RawDecodeStrict,
  b64RawEncode,
  b64StdDecodeStrict,
  bech32Decode,
  bech32Encode,
  dearmor,
  decrypt,
  decryptWithPassphrase,
  encrypt,
  encryptArmored,
  encryptWithPassphrase,
  HybridIdentity,
  HybridRecipient,
  isPossiblePayloadLength,
  parseExportRecipient,
  parseHeader,
  X25519Identity,
  X25519Recipient,
  type Stanza,
} from "./index.ts";
import { encodeHeader, encodeHeaderWithoutMac } from "./header.ts";
import { x25519Base } from "./primitives.ts";
import { errorText } from "../i18n/index.ts";

const te = new TextEncoder();
const td = new TextDecoder();
const latin1 = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));

// c2sp.org/age test vectors.
const X25519_IDENTITY = "AGE-SECRET-KEY-1GFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPQ4EGAEX";
const X25519_RECIPIENT = "age1zvkyg2lqzraa2lnjvqej32nkuu0ues2s82hzrye869xeexvn73equnujwj";
const PQ_IDENTITY = "AGE-SECRET-KEY-PQ-1XX76JRALNLXDMEW0CRK45QMCCH4X06SE84UN3VPM33W6HWDX0H3SK3ZQFR";
const PQ_RECIPIENT = [
  "age1pq1x34nzsvr0rxjsgdn8zgyhfe8j7ceq5r9rdelkjuh3y235jzxshfg87pzf5zrqtzdxz95paef6caq5aapdmwjjqpjf",
  "dyxnzr2zampc3uxy0dg4z2n2gm9su72p0pc3u0jvev55l694v78snxg3yzvcl7yda0eyytqj6a0ec477lnhcy5hzpz4zq3px",
  "anve4cn62gqj3pjy5lqj9c6kyj4v2z8alktn8zh99970x79gjkv7522hv9kfz35zsnxhsx8wwtmu9cy3ftzjgwcp4sshn3ll",
  "nylnpdsyz5jm72vefv4x5vfwytrefxg4wq3mv42wcrvkj742479zrxzpvp2p3e9fed9f0739vcu80r7ma28qfhnvlv4gfzel",
  "9q654dj3zmuvvz893azhxdvs9fxd0r7jzchzcfcs5mkyyjxhw0n2z6dvp9yn9qfdp29h0azxqyjw6v7fhyuzj7zel0uq6j9r",
  "d7wgrpz7mf5dnj43jwsgvrc8qcnhy7tu6dkdujuxzkp9xj43xe8h92ktre2a3u3s8mm5mrp9nr9pwkgtz4mdlq9hgn4fps4k",
  "57ff6wddn2fy23t47sm20r8km8sd2pcyyafnet8f0dajsrlyjeah4n3mssr6aseevuuskdvq5lzguyvpgwpta742c6698vgu",
  "tzqgny8usfg0w2he7kq5vyxjd0f9hqg8xk26y9e4th0gezq92q4cpp5p2y9hf5f2cje5l0c3sa3a2qxmm38pxxvhxh99yzmf",
  "z0zk7r2s64nnwjhkfgfr3gf8xnmppcgmaykvh5sh6g7vk9790rf8ws0axmr2t7z8aae5fq2029uvcn2ghgt4fu4wgwdc0k0c",
  "z52qkvwmuzj8p8k5jgf3xzk5zmrkavjekjrpeq408xz3zxazwkc6tyfmhayrkfpjhwtz5mp8j8guqe43k2q6m2kte03vrw27",
  "y3wmqyu5etmt9dnkwcnnpmu9gz9dekfhdevf42ucshphnrk38ra6hx8w5f8q5ru0xdhrjxmwqf6cused7zc5xvq43r0zscjg",
  "lpwlptpwydhqw64xz7ptjdyeyzpq2zkxtmzg29gzjpvzva4d3l0cenn9xs297wf4y4ukwrunf57xj6pm7nvrkwvtrt8hwcmg",
  "v8x7ajw7258ugf9wvkmk4052ekg87tw5vnx8nq2swyzv77v8yqlwsenvamr0zssknwts8rrhfuwj7ykysnq9jxy0uv3kuyt2",
  "2djszjdtvpz6d0s0kwh8ryynddzud92emeyvvyqktd0jtj7rvvg5gch25v8smlvny3kvn5gagyz475ze2y6q466xqmz2n3hs",
  "77lddeqyta2nch5k2u5yacuk9ywnwfdzvyejnucz724hj77hrrmakm7pr3kxsrxq22ejexlud9fy2kdqmkg5yncz7jm5wv2q",
  "jk5w5kvcpqsry2yqffh2la52dxfjkjq5rzhjzeyn6dupn0qwtyv7s4lwg3xdarsdlwe2y3tujy480y7z39q259fzx6jhd2j0",
  "f5hagqpcpees7hzc2yrk5cy788uk3s7qvp5cpepx24gvws3m2g433exgwppnkjscec8qu4y9z9r7vccexjcjaen42245lmgm",
  "xmuavg9alej92322gvvyy2t6267v09ch64y0m53jff0vjj96s0ypk60hr3jw4myd6m5hpn3xjstx7tl2szhpr5qe8jj08ydj",
  "c4wy2rch2fhuy3pdfjax5awe9j99ly5hkntzz9fe5zatgjvzdd0kgtxs25njnajyf6ssekp7gelxquusn4pt25czh3scj68k",
  "q79wdn5tgm6yvm9nzavrg043x3msnygf8dweknw5jmqd0uvny6ttsn09508k0c55zfnegrm9efhxpfqdkmhh6gjtqmwze9py",
  "yzk3tlhl53k2ykx3qheyty7saeq0d3fzv49zc0k",
].join("");

function kind(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    if (e instanceof AgeDecryptError) return e.kind;
    throw e;
  }
  return "ok";
}

async function kindAsync(f: () => Promise<unknown>): Promise<string> {
  try {
    await f();
  } catch (e) {
    if (e instanceof AgeDecryptError) return e.kind;
    throw e;
  }
  return "ok";
}

describe("base64", () => {
  test("raw: canonical only", () => {
    expect(b64RawDecodeStrict("")).toEqual(new Uint8Array(0));
    expect(b64RawDecodeStrict("AA")).toEqual(new Uint8Array([0]));
    expect(b64RawDecodeStrict("AB")).toBeNull(); // non-zero unused bits
    expect(b64RawDecodeStrict("AAA")).toEqual(new Uint8Array([0, 0]));
    expect(b64RawDecodeStrict("AAB")).toBeNull();
    expect(b64RawDecodeStrict("A")).toBeNull(); // length 1 mod 4
    expect(b64RawDecodeStrict("AA==")).toBeNull(); // padding
    expect(b64RawDecodeStrict("AA A")).toBeNull();
    expect(b64RawDecodeStrict("AA\r")).toBeNull();
    expect(b64RawDecodeStrict("AA-_")).toBeNull(); // URL alphabet
    for (const n of [0, 1, 2, 3, 31, 32, 48]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
      expect(b64RawDecodeStrict(b64RawEncode(b))).toEqual(b);
    }
  });

  test("padded: strict", () => {
    expect(b64StdDecodeStrict("QQ==")).toEqual(te.encode("A"));
    expect(b64StdDecodeStrict("QR==")).toBeNull(); // non-zero pad bits
    expect(b64StdDecodeStrict("QUI=")).toEqual(te.encode("AB"));
    expect(b64StdDecodeStrict("QUJ=")).toBeNull();
    expect(b64StdDecodeStrict("QQ")).toBeNull(); // padding required
    expect(b64StdDecodeStrict("QQ=")).toBeNull();
    expect(b64StdDecodeStrict("Q===")).toBeNull();
    expect(b64StdDecodeStrict("====")).toBeNull();
    expect(b64StdDecodeStrict("QQ==QQ==")).toBeNull();
    expect(b64StdDecodeStrict("QU JD")).toBeNull();
    expect(b64StdDecodeStrict("QUJD")).toEqual(te.encode("ABC"));
  });
});

describe("bech32", () => {
  test("spec vectors: X25519 identity → recipient", () => {
    const id = X25519Identity.parse(X25519_IDENTITY);
    expect(id.format()).toBe(X25519_IDENTITY);
    expect(bech32Encode("age", x25519Base(id.secretBytes()))).toBe(X25519_RECIPIENT);
    expect(X25519Recipient.parse(X25519_RECIPIENT).toString()).toBe(X25519_RECIPIENT);
    expect(td.decode(id.encode())).toBe(X25519_IDENTITY);
  });

  test("spec vectors: hybrid identity → recipient", () => {
    const id = HybridIdentity.parse(PQ_IDENTITY);
    expect(id.toString()).toBe(PQ_IDENTITY);
    expect(id.recipient().toString()).toBe(PQ_RECIPIENT);
    expect(HybridRecipient.parse(PQ_RECIPIENT).toString()).toBe(PQ_RECIPIENT);
  });

  test("age's error texts", () => {
    const err = (s: string) => {
      try {
        bech32Decode(s);
        return "ok";
      } catch (e) {
        return errorText(e);
      }
    };
    expect(err("age1abc")).toBe("separator '1' at invalid position: pos=3, len=7");
    expect(err("age1Zvkyg2lqzraa2lnjvqej32nkuu0ues2s82hzrye869xeexvn73equnujwj")).toBe("mixed case");
    expect(err(X25519_RECIPIENT.slice(0, -1) + "x")).toBe("invalid checksum");
    expect(err(X25519_RECIPIENT + " x")).toBe("invalid character data part: s[58]=32");
    expect(err("aé1qqqqqqqq")).toBe("invalid character human-readable part: s[1]=233");
    expect(err(X25519_RECIPIENT.toUpperCase())).toBe("ok");
    // 3 data characters leave 7 bits: more than 4 padding bits.
    expect(err(bech32Encode("age", new Uint8Array(1)).slice(0, 5) + "q" + "qqqqqq")).not.toBe("ok");
  });

  test("padding rules", () => {
    // Non-zero padding: change the last data character of a 1-byte payload and fix the checksum.
    const words = [0, 1]; // 10 bits: 8 data + 2 padding bits = 01 → non-zero
    const enc = (ws: number[]) => {
      // build a string with a valid checksum over arbitrary 5-bit words
      const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
      const hrp = "age";
      const exp = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
      const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
      const pm = (v: number[]) => {
        let chk = 1;
        for (const x of v) {
          const top = chk >>> 25;
          chk = (((chk & 0x1ffffff) << 5) ^ x) >>> 0;
          for (let j = 0; j < 5; j++) if ((top >>> j) & 1) chk = (chk ^ GEN[j]!) >>> 0;
        }
        return chk;
      };
      const mod = pm([...exp, ...ws, 0, 0, 0, 0, 0, 0]) ^ 1;
      const cs = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
      return hrp + "1" + [...ws, ...cs].map((w) => CHARSET[w]).join("");
    };
    expect(() => bech32Decode(enc(words))).toThrow("non-zero padding");
    expect(() => bech32Decode(enc([0, 0, 0]))).toThrow("illegal zero padding");
    expect(bech32Decode(enc([0, 0])).data).toEqual(new Uint8Array([0]));
  });
});

// A valid header with one X25519 stanza, for mutation.
function sampleFile(): Uint8Array {
  const id = X25519Identity.generate();
  return encrypt(te.encode("hello"), [id.stanzaRecipient()]);
}

function headerText(stanzaLines: string[], mac = "--- " + "A".repeat(43)): string {
  return "age-encryption.org/v1\n" + stanzaLines.join("\n") + "\n" + mac + "\n";
}

const BODY43 = "A".repeat(43);

function headerOk(s: string): boolean {
  try {
    parseHeader(latin1(s));
    return true;
  } catch (e) {
    expect((e as Error).name).toBe("AgeHeaderError");
    return false;
  }
}

describe("header rules (vault-format §2.3)", () => {
  test("a valid header parses; payload starts after the MAC line", () => {
    const f = sampleFile();
    const h = parseHeader(f);
    expect(h.stanzas.length).toBe(1);
    expect(h.stanzas[0]!.type).toBe("X25519");
    expect(h.stanzas[0]!.args.length).toBe(1);
    expect(h.stanzas[0]!.body.length).toBe(32);
    expect(h.payloadOffset).toBe(168);
    expect(f.length - h.payloadOffset).toBe(16 + 5 + 16);
    expect(headerOk(headerText(["-> X25519 abc", BODY43]))).toBe(true);
  });

  test("rule 1: version line, LF endings, no CR", () => {
    expect(headerOk(headerText(["-> X25519 abc", BODY43]).replace("v1", "v2"))).toBe(false);
    expect(headerOk(headerText(["-> X25519 abc", BODY43]).replace("v1\n", "v1\r\n"))).toBe(false);
    expect(headerOk("age-encryption.org/v1")).toBe(false);
    expect(headerOk(headerText(["-> X25519 abc\r", BODY43]))).toBe(false);
    expect(headerOk(headerText(["-> X25519 abc", BODY43 + "\r"]))).toBe(false);
    expect(headerOk(headerText(["-> X25519 abc", BODY43], "--- " + "A".repeat(43) + "\r"))).toBe(false);
    expect(headerOk(" age-encryption.org/v1\n-> a\n\n--- " + "A".repeat(43) + "\n")).toBe(false);
  });

  test("rule 2: stanza lines", () => {
    expect(headerOk(headerText(["-> a", ""]))).toBe(true); // a type and no arguments, empty body
    expect(headerOk(headerText(["->", ""]))).toBe(false); // no type
    expect(headerOk(headerText(["-> ", ""]))).toBe(false); // empty type
    expect(headerOk(headerText(["->  X25519 a", ""]))).toBe(false); // double space
    expect(headerOk(headerText(["-> X25519 a ", ""]))).toBe(false); // trailing space
    expect(headerOk(headerText(["-> X25519\ta", ""]))).toBe(false); // TAB
    expect(headerOk(headerText(["-> X25519 \x80", ""]))).toBe(false); // non-ASCII
    expect(headerOk(headerText(["-> X25519 \x7f", ""]))).toBe(false); // DEL
    expect(headerOk(headerText(["->X25519 a", ""]))).toBe(false);
    expect(headerOk(headerText(["- > a", ""]))).toBe(false);
    expect(headerOk(headerText(["-> " + ["t", ...Array(128).fill("a")].join(" "), ""]))).toBe(true);
    expect(headerOk(headerText(["-> " + ["t", ...Array(129).fill("a")].join(" "), ""]))).toBe(false);
    expect(headerOk(headerText([]).replace("\n\n", "\n"))).toBe(false); // no stanza
  });

  test("rule 2: at most 1024 stanzas", () => {
    const st = (n: number) => Array.from({ length: n }, () => ["-> a", ""]).flat();
    expect(headerOk(headerText(st(1024)))).toBe(true);
    expect(headerOk(headerText(st(1025)))).toBe(false);
  });

  test("rule 3: stanza bodies", () => {
    const full = "A".repeat(64);
    expect(headerOk(headerText(["-> a", full, full, ""]))).toBe(true);
    expect(headerOk(headerText(["-> a", full, "AA"]))).toBe(true);
    expect(headerOk(headerText(["-> a", full]))).toBe(false); // no short final line: the MAC line is read as body
    expect(headerOk(headerText(["-> a", "A".repeat(65)]))).toBe(false); // more than 48 bytes
    expect(headerOk(headerText(["-> a", "A".repeat(68)]))).toBe(false);
    expect(headerOk(headerText(["-> a", "AB"]))).toBe(false); // non-canonical
    expect(headerOk(headerText(["-> a", "AA=="]))).toBe(false); // padding
    expect(headerOk(headerText(["-> a", "A A"]))).toBe(false);
    expect(headerOk("age-encryption.org/v1\n-> a\n" + full + "\n")).toBe(false); // EOF in the body
  });

  test("rule 4: the MAC line", () => {
    const st = ["-> a", ""];
    expect(headerOk(headerText(st, "--- " + "A".repeat(43)))).toBe(true);
    expect(headerOk(headerText(st, "---"))).toBe(false);
    expect(headerOk(headerText(st, "--- "))).toBe(false);
    expect(headerOk(headerText(st, "--- " + "A".repeat(42)))).toBe(false);
    expect(headerOk(headerText(st, "--- " + "A".repeat(44)))).toBe(false);
    expect(headerOk(headerText(st, "--- " + "A".repeat(42) + "B"))).toBe(false); // non-canonical
    expect(headerOk(headerText(st, "---  " + "A".repeat(43)))).toBe(false);
    expect(headerOk(headerText(st, "--- " + "A".repeat(43) + " x"))).toBe(false);
    expect(headerOk(headerText(st, "---- " + "A".repeat(43)))).toBe(false);
    expect(headerOk(headerText(st, "-- " + "A".repeat(43)))).toBe(false); // starts a stanza: malformed
    expect(headerOk("age-encryption.org/v1\n--- " + "A".repeat(43) + "\n")).toBe(false); // no stanza
    expect(headerOk(headerText(st, "--- " + "A".repeat(43)).slice(0, -1))).toBe(false); // no LF
  });

  test("rule 5: header at most 2 MiB", () => {
    const line = "A".repeat(64);
    // version (22) + "-> a\n" (5) + k body lines (65 each) + "\n" (1) + MAC line (48)
    const fixed = 22 + 5 + 1 + 48;
    const k = Math.floor((2 * 1024 * 1024 - fixed) / 65);
    const ok = headerText(["-> a", ...Array(k).fill(line), ""]);
    expect(ok.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(headerOk(ok)).toBe(true);
    // pad to exactly 2 MiB with a longer final body line? use extra full lines instead
    const tooBig = headerText(["-> a", ...Array(k + 1).fill(line), ""]);
    expect(tooBig.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(headerOk(tooBig)).toBe(false);
  });

  test("encodeHeader wraps bodies at 64 columns with a short final line", () => {
    const st: Stanza[] = [
      { type: "a", args: [], body: new Uint8Array(48) },
      { type: "b", args: ["x", "y"], body: new Uint8Array(0) },
      { type: "c", args: [], body: new Uint8Array(32) },
    ];
    const text = Buffer.from(encodeHeaderWithoutMac(st)).toString("latin1");
    expect(text).toBe("age-encryption.org/v1\n-> a\n" + "A".repeat(64) + "\n\n-> b x y\n\n-> c\n" + "A".repeat(43) + "\n---");
    const h = parseHeader(encodeHeader(st, new Uint8Array(16)));
    expect(h.stanzas.map((s) => [s.type, s.args, s.body.length])).toEqual([
      ["a", [], 48],
      ["b", ["x", "y"], 0],
      ["c", [], 32],
    ]);
  });
});

describe("payload (STREAM)", () => {
  test("possible sizes (vault-format §2.3)", () => {
    expect(isPossiblePayloadLength(32)).toBe(true);
    expect(isPossiblePayloadLength(31)).toBe(false);
    expect(isPossiblePayloadLength(33)).toBe(true);
    expect(isPossiblePayloadLength(65568)).toBe(true);
    expect(isPossiblePayloadLength(65584)).toBe(false);
    expect(isPossiblePayloadLength(65585)).toBe(true);
    expect(isPossiblePayloadLength(0)).toBe(false);
    expect(isPossiblePayloadLength(16)).toBe(false);
    for (const p of [0, 1, 100, 65535, 65536, 65537, 131072, 131073, 200000]) {
      const l = 16 + p + 16 * Math.max(1, Math.ceil(p / 65536));
      expect(isPossiblePayloadLength(l)).toBe(true);
    }
    // Brute force against the formula for small and chunk-boundary lengths.
    const possible = new Set<number>();
    for (let p = 0; p <= 200000; p++) possible.add(16 + p + 16 * Math.max(1, Math.ceil(p / 65536)));
    for (let l = 0; l <= 200000; l++) expect(isPossiblePayloadLength(l)).toBe(possible.has(l));
  });

  test("round trips and sizes at chunk boundaries", () => {
    const id = X25519Identity.generate();
    for (const p of [0, 1, 65535, 65536, 65537, 131072, 200000]) {
      const pt = Uint8Array.from({ length: p }, (_, i) => i & 0xff);
      const f = encrypt(pt, [id.stanzaRecipient()]);
      expect(f.length).toBe(168 + 16 + p + 16 * Math.max(1, Math.ceil(p / 65536)));
      expect(decrypt(f, id)).toEqual(pt);
    }
  });

  test("tampering is detected", () => {
    const id = X25519Identity.generate();
    const pt = new Uint8Array(70000).fill(7);
    const f = encrypt(pt, [id.stanzaRecipient()]);
    for (const i of [168, 168 + 15, 168 + 16, 168 + 65552 + 3, f.length - 1]) {
      const g = Uint8Array.from(f);
      g[i]! ^= 1;
      expect(kind(() => decrypt(g, id))).toBe("payload");
    }
    expect(kind(() => decrypt(f.subarray(0, f.length - 1), id))).toBe("payload");
    expect(kind(() => decrypt(f.subarray(0, 168 + 16 + 65552), id))).toBe("payload"); // first chunk alone isn't final
    const longer = new Uint8Array(f.length + 1);
    longer.set(f);
    expect(kind(() => decrypt(longer, id))).toBe("payload");
    // The header MAC covers the stanzas.
    const g = Uint8Array.from(f);
    g[100]! ^= 1; // inside the stanza body's base64 → still base64? flip a bit in a letter
    expect(["mac", "header", "no-match", "stanza"]).toContain(kind(() => decrypt(g, id)));
  });

  test("maxPlaintext stops early", () => {
    const id = X25519Identity.generate();
    const f = encrypt(new Uint8Array(5000), [id.stanzaRecipient()]);
    expect(kind(() => decrypt(f, id, { maxPlaintext: 4096 }))).toBe("too-long");
    expect(decrypt(f, id, { maxPlaintext: 5000 }).length).toBe(5000);
  });
});

describe("recipients and identities", () => {
  test("X25519: no match with another key; malformed stanzas", () => {
    const a = X25519Identity.generate();
    const b = X25519Identity.generate();
    const f = encrypt(te.encode("x"), [a.stanzaRecipient()]);
    expect(kind(() => decrypt(f, b))).toBe("no-match");
    // Two recipients: either opens.
    const g = encrypt(te.encode("y"), [a.stanzaRecipient(), b.stanzaRecipient()]);
    expect(td.decode(decrypt(g, a))).toBe("y");
    expect(td.decode(decrypt(g, b))).toBe("y");
    // A malformed X25519 stanza is an error, not "no match".
    const bad = (s: Stanza) => {
      const fileKey = new Uint8Array(16);
      return Uint8Array.from([...encodeHeader([s], fileKey), ...new Uint8Array(32)]);
    };
    expect(kind(() => decrypt(bad({ type: "X25519", args: [], body: new Uint8Array(32) }), a))).toBe("stanza");
    expect(kind(() => decrypt(bad({ type: "X25519", args: ["AAAA"], body: new Uint8Array(32) }), a))).toBe("stanza");
    expect(kind(() => decrypt(bad({ type: "X25519", args: [b64RawEncode(new Uint8Array(32).fill(9))], body: new Uint8Array(31) }), a))).toBe("stanza");
    // An all-zero shared secret (low-order point 0) aborts.
    expect(kind(() => decrypt(bad({ type: "X25519", args: [b64RawEncode(new Uint8Array(32))], body: new Uint8Array(32) }), a))).toBe("stanza");
    // Unknown stanza types are ignored.
    expect(kind(() => decrypt(bad({ type: "other", args: [], body: new Uint8Array(32) }), a))).toBe("no-match");
  });

  test("identity parsing", () => {
    expect(() => X25519Identity.parse(X25519_IDENTITY.toLowerCase())).toThrow("unknown type");
    expect(() => X25519Identity.parse(X25519_IDENTITY.slice(0, -1) + "Q")).toThrow("invalid checksum");
    expect(() => X25519Identity.parse(PQ_IDENTITY)).toThrow("malformed secret key");
    const id = X25519Identity.generate();
    const s = id.format();
    expect(s).toMatch(/^AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}$/);
    expect(X25519Identity.parse(s).equals(id)).toBe(true);
    id.wipe();
    expect(() => id.format()).toThrow();
  });

  test("scrypt: round trip, wrong passphrase, rules", async () => {
    const pw = te.encode("pass phrase");
    const f = await encryptWithPassphrase(te.encode("secret"), pw, 10);
    expect(td.decode(await decryptWithPassphrase(f, pw, { maxLogN: 18 }))).toBe("secret");
    expect(await kindAsync(() => decryptWithPassphrase(f, te.encode("other"), { maxLogN: 18 }))).toBe("no-match");
    expect(await kindAsync(() => decryptWithPassphrase(f, pw, { maxLogN: 9 }))).toBe("stanza");
    const h = parseHeader(f);
    const withArgs = (args: string[], body = h.stanzas[0]!.body) =>
      Uint8Array.from([...encodeHeader([{ type: "scrypt", args, body }], new Uint8Array(16)), ...f.subarray(h.payloadOffset)]);
    const salt = h.stanzas[0]!.args[0]!;
    for (const wf of ["018", "+10", "0", "-5", "abc", "1e1", ""]) {
      if (wf === "") continue;
      expect(await kindAsync(() => decryptWithPassphrase(withArgs([salt, wf]), pw, { maxLogN: 18 }))).toBe("stanza");
    }
    expect(await kindAsync(() => decryptWithPassphrase(withArgs([salt.slice(0, 20), "10"]), pw, { maxLogN: 18 }))).toBe("stanza");
    expect(await kindAsync(() => decryptWithPassphrase(withArgs([salt]), pw, { maxLogN: 18 }))).toBe("stanza");
    expect(await kindAsync(() => decryptWithPassphrase(withArgs([salt, "10"], new Uint8Array(31)), pw, { maxLogN: 18 }))).toBe("stanza");
    // An scrypt stanza must be alone.
    const mixed = Uint8Array.from([
      ...encodeHeader([h.stanzas[0]!, { type: "X25519", args: ["a"], body: new Uint8Array(32) }], new Uint8Array(16)),
      ...f.subarray(h.payloadOffset),
    ]);
    expect(await kindAsync(() => decryptWithPassphrase(mixed, pw, { maxLogN: 18 }))).toBe("scrypt-mixed");
    expect(kind(() => decrypt(mixed, X25519Identity.generate()))).toBe("scrypt-mixed");
  });

  test("hybrid post-quantum: round trip", () => {
    const id = HybridIdentity.generate();
    const f = encrypt(te.encode("pq"), [id.recipient()]);
    const h = parseHeader(f);
    expect(h.stanzas[0]!.type).toBe("mlkem768x25519");
    expect(h.stanzas[0]!.args.length).toBe(1);
    expect(b64RawDecodeStrict(h.stanzas[0]!.args[0]!)!.length).toBe(1120);
    expect(h.stanzas[0]!.body.length).toBe(32);
    expect(td.decode(decrypt(f, id))).toBe("pq");
    expect(kind(() => decrypt(f, HybridIdentity.generate()))).toBe("no-match");
    expect(kind(() => decrypt(f, X25519Identity.generate()))).toBe("no-match");
  });
});

describe("armor", () => {
  test("canonical form: 64-column lines", () => {
    for (const n of [1, 47, 48, 49, 257, 1000]) {
      const b = Uint8Array.from({ length: n }, (_, i) => i);
      const t = armorText(b);
      const lines = t.split("\n");
      expect(lines[0]).toBe("-----BEGIN AGE ENCRYPTED FILE-----");
      expect(lines.at(-2)).toBe("-----END AGE ENCRYPTED FILE-----");
      expect(lines.at(-1)).toBe("");
      const body = lines.slice(1, -2);
      for (const l of body.slice(0, -1)) expect(l.length).toBe(64);
      expect(body.at(-1)!.length).toBeGreaterThan(0);
      expect(body.at(-1)!.length).toBeLessThanOrEqual(64);
      expect(dearmor(t)).toEqual(b);
      expect(dearmor(t.replaceAll("\n", "\r\n"))).toEqual(b);
      expect(dearmor(armor(b))).toEqual(b);
    }
  });

  test("strict reading", () => {
    const t = armorText(new Uint8Array(100));
    expect(dearmor(t.replace("\n", "\n\n"))).toBeNull();
    expect(dearmor(t.replace("AAAA", "AAA\nA"))).toBeNull();
    expect(dearmor("  \n" + t + "\n\n")).not.toBeNull();
    expect(dearmor(t.replace("FILE-----\n", "FILE----- \n"))).toBeNull();
  });
});

describe("--age recipients (import-export §2.7)", () => {
  const msg = (v: string) => {
    try {
      parseExportRecipient(v);
      return "ok";
    } catch (e) {
      return errorText(e);
    }
  };

  test("the table", () => {
    expect(msg(X25519_RECIPIENT)).toBe("ok");
    expect(msg("  " + X25519_RECIPIENT + "\n")).toBe("ok");
    expect(msg(PQ_RECIPIENT)).toBe("ok");
    expect(msg("  AGE-SECRET-KEY-1xyz")).toBe("--age: this is an age secret key; give its public recipient (age1…), as printed by age-keygen -y");
    expect(msg("age-secret-key-1")).toBe("--age: this is an age secret key; give its public recipient (age1…), as printed by age-keygen -y");
    expect(msg("   ")).toBe("--age: the recipient is empty; give an age public key (age1…)");
    expect(msg("")).toBe("--age: the recipient is empty; give an age public key (age1…)");
    expect(msg("ssh-ed25519 AAAA")).toBe("--age: not an age recipient; give an age public key (age1…)");
    expect(msg(X25519_RECIPIENT.toUpperCase())).toBe("--age: not an age recipient; give an age public key (age1…)");
    expect(msg("Age1x")).toBe("--age: not an age recipient; give an age public key (age1…)");
  });

  test("age's errors, as the reference prints them", () => {
    expect(msg("age1abc")).toBe(`--age: invalid age recipient "age1abc": malformed recipient "age1abc": separator '1' at invalid position: pos=3, len=7`);
    expect(msg("age1pq1abc")).toBe(`--age: invalid age recipient "age1pq1abc": malformed recipient "age1pq1abc": separator '1' at invalid position: pos=6, len=10`);
    const badSum = X25519_RECIPIENT.slice(0, -1) + "x";
    expect(msg(badSum)).toBe(`--age: invalid age recipient "${badSum}": malformed recipient "${badSum}": invalid checksum`);
    expect(msg(X25519_RECIPIENT + "\x01")).toBe(
      `--age: invalid age recipient "${X25519_RECIPIENT}\\x01": malformed recipient "${X25519_RECIPIENT}\\x01": invalid character data part: s[58]=1`,
    );
    expect(msg("age1yubikey1qwerty")).toContain("invalid checksum");
    const otherType = bech32Encode("age1tag", new Uint8Array(33));
    expect(msg(otherType)).toBe(`--age: invalid age recipient "${otherType}": malformed recipient "${otherType}": invalid type "age1tag"`);
    for (const n of [31, 33]) {
      const r = bech32Encode("age", new Uint8Array(n));
      expect(msg(r)).toBe(`--age: invalid age recipient "${r}": malformed recipient "${r}": invalid X25519 public key`);
    }
    for (const pk of [new Uint8Array(100), new Uint8Array(1216).fill(255)]) {
      const r = bech32Encode("age1pq", pk);
      expect(msg(r)).toBe(`--age: invalid age recipient "${r}": malformed recipient "${r}": invalid MLKEM768-X25519 public key`);
    }
    const yk = bech32Encode("age1yubikey", new Uint8Array(33));
    expect(msg(yk)).toBe(`--age: invalid age recipient "${yk}": malformed recipient "${yk}": invalid type "age1yubikey"`);
  });

  test("encryptArmored", () => {
    const id = X25519Identity.generate();
    const out = encryptArmored(te.encode("export"), X25519Recipient.parse(bech32Encode("age", x25519Base(id.secretBytes()))));
    const text = Buffer.from(out).toString("latin1");
    expect(text.startsWith("-----BEGIN AGE ENCRYPTED FILE-----\n")).toBe(true);
    expect(text.endsWith("-----END AGE ENCRYPTED FILE-----\n")).toBe(true);
    expect(td.decode(decrypt(dearmor(out)!, id))).toBe("export");
  });
});
