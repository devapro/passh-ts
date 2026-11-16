// Unit tests for the container (vault-format.md §2): the canonical form, every lenient
// variant of §2.2, every error row, the block checks of §2.3 and the recovery parse.

import { beforeAll, describe, expect, test } from "bun:test";
import {
  checkBlock,
  ContainerError,
  encodeContainer,
  errFileTooLarge,
  errNotRegularFile,
  errVerifyNotRegular,
  errVerifyTooLarge,
  MAX_VAULT_FILE_SIZE,
  parseContainer,
  parseContainerForRecovery,
  trimSpaceBytes,
} from "./index.ts";
import { armorText, b64RawEncode, b64StdEncode, type Stanza } from "../age/index.ts";
import { encodeHeader } from "../age/header.ts";
import { encryptData, generateVaultKey, wrapKeyBlock } from "../keys/index.ts";
import { errorText, hasCode, setLanguage } from "../i18n/index.ts";

const te = new TextEncoder();
const latin1 = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));
const BEGIN = "-----BEGIN AGE ENCRYPTED FILE-----";
const END = "-----END AGE ENCRYPTED FILE-----";

let keyBlock: Uint8Array;
let dataBlock: Uint8Array;
let canonical: string;

beforeAll(async () => {
  const id = generateVaultKey();
  keyBlock = await wrapKeyBlock(id, te.encode("pw"), 10);
  dataBlock = encryptData(te.encode('{"format":"passh-vault-data"}'.padEnd(300, " ")), id);
  canonical = "passh-vault 1\n" + armorText(keyBlock) + armorText(dataBlock);
});

function parse(s: string | Uint8Array) {
  return parseContainer(typeof s === "string" ? latin1(s) : s);
}

/** The error text of parsing s, or "OK". */
function errOf(s: string | Uint8Array): string {
  try {
    parse(s);
    return "OK";
  } catch (e) {
    expect(e).toBeInstanceOf(ContainerError);
    return errorText(e);
  }
}

function expectSameBlocks(s: string | Uint8Array, canon = false) {
  const c = parse(s);
  expect(c.keyBlock).toEqual(keyBlock);
  expect(c.dataBlock).toEqual(dataBlock);
  expect(c.canonical).toBe(canon);
  return c;
}

/** Base64 with non-zero pad bits: the character before `=` gets a low bit set. */
function nonZeroPad(b: string): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const i = b.indexOf("=") - 1;
  return b.slice(0, i) + A[A.indexOf(b[i]!) | 1] + b.slice(i + 1);
}

/** The base64 lines of the two blocks. */
function b64(block: Uint8Array): string {
  return b64StdEncode(block);
}

describe("canonical form (§2.1)", () => {
  test("encode → parse; canonical", () => {
    const enc = encodeContainer(keyBlock, dataBlock);
    expect(Buffer.from(enc).toString("latin1")).toBe(canonical);
    const c = expectSameBlocks(enc, true);
    expect(c.warnings).toEqual([]);
    expect(canonical.startsWith("passh-vault 1\n-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+I")).toBe(true);
    expect(canonical.endsWith("\n-----END AGE ENCRYPTED FILE-----\n")).toBe(true);
    for (const l of canonical.split("\n")) expect(l.length).toBeLessThanOrEqual(64);
  });

  test("encode refuses blocks that fail §2.3", () => {
    expect(() => encodeContainer(dataBlock, dataBlock)).toThrow("file is damaged (block 1): the key block isn't encrypted with a passphrase");
    expect(() => encodeContainer(keyBlock, keyBlock)).toThrow("file is damaged (block 2): the data block isn't encrypted to a vault key");
    expect(() => encodeContainer(keyBlock, dataBlock.subarray(0, 168 + 20))).toThrow("impossible size");
  });

  test("encode refuses a file over 64 MiB (§2.5)", () => {
    // A structurally valid data block of about 48 MiB: header + a payload of possible size.
    const st: Stanza[] = [{ type: "X25519", args: [b64RawEncode(new Uint8Array(32))], body: new Uint8Array(32) }];
    const header = encodeHeader(st, new Uint8Array(16));
    const make = (p: number) => {
      const chunks = Math.max(1, Math.ceil(p / 65536));
      const block = new Uint8Array(header.length + 16 + p + 16 * chunks);
      block.set(header);
      return block;
    };
    const big = make(49 * 1024 * 1024);
    let err: unknown;
    try {
      encodeContainer(keyBlock, big);
    } catch (e) {
      err = e;
    }
    expect(hasCode(err, "too-large")).toBe(true);
    expect(errorText(err)).toContain("larger than 64 MiB");
    expect(encodeContainer(keyBlock, make(47 * 1024 * 1024)).length).toBeLessThanOrEqual(MAX_VAULT_FILE_SIZE);
  });
});

describe("lenient parse: accepted variants (§2.2)", () => {
  test("line endings", () => {
    expectSameBlocks(canonical.replaceAll("\n", "\r\n"));
    expectSameBlocks(canonical.replaceAll("\n", "\r"));
    let i = 0;
    expectSameBlocks(canonical.replace(/\n/g, () => ["\n", "\r\n", "\r"][i++ % 3]!));
  });

  test("BOM, indentation, white space", () => {
    expectSameBlocks("\xef\xbb\xbf" + canonical);
    expectSameBlocks(canonical.split("\n").map((l) => (l ? "   \t" + l + " \t" : l)).join("\n"));
    // Unicode white space in UTF-8: NBSP, U+3000, U+2028, NEL, U+1680, U+205F
    const ws = ["\xc2\xa0", "\xe3\x80\x80", "\xe2\x80\xa8", "\xc2\x85", "\xe1\x9a\x80", "\xe2\x81\x9f", "\xe2\x80\x8a", "\x0b", "\x0c"];
    expectSameBlocks(canonical.split("\n").map((l, k) => (l ? ws[k % ws.length] + l + ws[(k + 3) % ws.length] : l)).join("\n"));
    // passh-vault with several spaces/tabs and leading zeros
    expectSameBlocks(canonical.replace("passh-vault 1", "passh-vault \t  001"));
  });

  test("blank lines anywhere", () => {
    expectSameBlocks("\n\n" + canonical.replaceAll("\n", "\n\n") + "\n\n \n");
  });

  test("re-wrapped base64 at any width, one long line, no final newline", () => {
    const wrap = (b: string, w: number) => b.match(new RegExp(`.{1,${w}}`, "g"))!.join("\n");
    for (const w of [1, 3, 4, 63, 65, 76, 100, 1000]) {
      const s = `passh-vault 1\n${BEGIN}\n${wrap(b64(keyBlock), w)}\n${END}\n${BEGIN}\n${wrap(b64(dataBlock), w)}\n${END}\n`;
      expectSameBlocks(s);
    }
    expectSameBlocks(canonical.slice(0, -1));
  });

  test("text around the vault: warnings", () => {
    let c = expectSameBlocks("Hello,\nhere is my vault:\n\n" + canonical + "\nRegards\n -- me\n");
    expect(c.warnings.map((w) => w.message)).toEqual([
      "ignored 2 lines of text before the passh-vault line",
      "ignored 2 lines of text after the last END line",
    ]);
    c = expectSameBlocks("x\n" + canonical + "y");
    expect(c.warnings.map((w) => w.message)).toEqual([
      "ignored 1 line of text before the passh-vault line",
      "ignored 1 line of text after the last END line",
    ]);
    // A second vault appended: ignored as text after the END line.
    c = expectSameBlocks(canonical + canonical);
    expect(c.warnings.map((w) => w.message)).toEqual([`ignored ${canonical.split("\n").length - 1} lines of text after the last END line`]);
    // The localized form uses the plural rules (English here).
    setLanguage("en");
    expect(c.warnings[0]!.localize()).toBe(c.warnings[0]!.message);
  });

  test("trimSpaceBytes", () => {
    expect(trimSpaceBytes("\xc2\xa0 a b\t\xe3\x80\x80")).toBe("a b");
    expect(trimSpaceBytes("\xc2")).toBe("\xc2");
    expect(trimSpaceBytes("a\xa0")).toBe("a\xa0"); // a lone continuation byte isn't space
    expect(trimSpaceBytes("\xe2\x80\x8b")).toBe("\xe2\x80\x8b"); // U+200B isn't White_Space
    expect(trimSpaceBytes("\xef\xbb\xbfa")).toBe("\xef\xbb\xbfa"); // nor is U+FEFF
    expect(trimSpaceBytes(" \xe2\x80\x80 ")).toBe("");
  });
});

describe("lenient parse: errors (§2.2)", () => {
  test("no magic line", () => {
    expect(errOf("")).toBe("file is truncated: the file is empty");
    expect(errOf(" \n\t\r\n")).toBe("file is truncated: the file is empty");
    expect(errOf("\xef\xbb\xbf")).toBe("file is truncated: the file is empty");
    for (const s of ["p", "passh-va", "passh-vault", "  passh-vault  \n", "passh-vault\t"]) {
      expect(errOf(s)).toBe("file is truncated: it ends in the passh-vault line");
    }
    for (const s of ["hello", "hello\npassh-va", "PASSH-VAULT 1\n", "passh-vault1\n", "passh-vault -1\n", "passh-vault 1 x\n", "passh-vaults"]) {
      expect([s, errOf(s)]).toEqual([s, "not a passh vault"]);
    }
  });

  test("container version", () => {
    expect(errOf("passh-vault 2\n")).toBe("made by a newer passh; upgrade passh (container version 2)");
    expect(errOf("passh-vault 002\n" + canonical)).toBe("made by a newer passh; upgrade passh (container version 2)");
    expect(errOf("passh-vault 99999999999999999999\n")).toBe("made by a newer passh; upgrade passh (container version 9223372036854775807)");
    expect(errOf("passh-vault 0\n" + canonical)).toBe("not a passh vault: unknown container version 0");
    expect(errOf("passh-vault 00\n")).toBe("not a passh vault: unknown container version 0");
    // the first magic line counts
    expect(errOf("passh-vault 2\n" + canonical)).toBe("made by a newer passh; upgrade passh (container version 2)");
  });

  test("blocks", () => {
    const k = b64(keyBlock);
    const d = b64(dataBlock);
    const kArm = armorText(keyBlock);
    const dArm = armorText(dataBlock);
    const cases: Array<[string, string]> = [
      ["passh-vault 1\n", "file is truncated: block 1 is missing"],
      ["passh-vault 1\n\n  \n", "file is truncated: block 1 is missing"],
      ["passh-vault 1\n-----BEGIN AGE", "file is truncated: block 1 is cut short"],
      ["passh-vault 1\n-----BEGIN AGE\n\n \n", "file is truncated: block 1 is cut short"],
      ["passh-vault 1\n-----BEGIN AGE\nx", "file is damaged (block 1): its BEGIN line is missing or damaged"],
      ["passh-vault 1\nhello\n" + kArm + dArm, "file is damaged (block 1): its BEGIN line is missing or damaged"],
      ["passh-vault 1\n" + BEGIN.toLowerCase() + "\n" + k + "\n" + END + "\n" + dArm, "file is damaged (block 1): its BEGIN line is missing or damaged"],
      ["passh-vault 1\n" + BEGIN + "X\n" + k + "\n" + END + "\n" + dArm, "file is damaged (block 1): its BEGIN line is missing or damaged"],
      ["passh-vault 1\n" + BEGIN + "\n" + k + "\n", "file is truncated: block 1 has no END line"],
      ["passh-vault 1\n" + BEGIN + "\n" + k + "\n-----END AGE", "file is truncated: block 1 has no END line"],
      ["passh-vault 1\n" + BEGIN + "\n" + k + "\n" + dArm, "file is damaged (block 1): its END line is missing or damaged"],
      ["passh-vault 1\n" + BEGIN + "\n" + k.slice(0, 10) + " " + k.slice(10) + "\n" + END + "\n" + dArm, "file is damaged (block 1): bad base64"],
      ["passh-vault 1\n" + BEGIN + "\n" + k.replace("=", "") + "\n" + END + "\n" + dArm, "file is damaged (block 1): bad base64"],
      ["passh-vault 1\n" + BEGIN + "\n" + k + "!\n" + END + "\n" + dArm, "file is damaged (block 1): bad base64"],
      ["passh-vault 1\n" + BEGIN + "\n" + nonZeroPad(k) + "\n" + END + "\n" + dArm, "file is damaged (block 1): bad base64"],
      ["passh-vault 1\n" + BEGIN + "\n" + END + "\n" + dArm, "file is damaged (block 1): the block is empty"],
      ["passh-vault 1\n" + BEGIN + "\n\n" + END + "\n" + dArm, "file is damaged (block 1): the block is empty"],
      ["passh-vault 1\n" + kArm, "file is truncated: block 2 is missing"],
      ["passh-vault 1\n" + kArm + "-----BEGIN", "file is truncated: block 2 is cut short"],
      ["passh-vault 1\n" + kArm + "text\n" + dArm, "file is damaged (block 2): its BEGIN line is missing or damaged"],
      ["passh-vault 1\n" + kArm + BEGIN + "\n" + d, "file is truncated: block 2 has no END line"],
      ["passh-vault 1\n" + kArm + BEGIN + "\n" + d + "\n" + kArm, "file is damaged (block 2): its END line is missing or damaged"],
      ["passh-vault 1\n" + kArm + BEGIN + "\n" + d + "x\n" + END, "file is damaged (block 2): bad base64"],
      ["passh-vault 1\n" + kArm + BEGIN + "\n" + END, "file is damaged (block 2): the block is empty"],
    ];
    for (const [s, want] of cases) expect([s.slice(0, 60), errOf(s)]).toEqual([s.slice(0, 60), want]);
  });

  test("errors carry kind, block and the warnings so far", () => {
    try {
      parse("intro\npassh-vault 1\n" + armorText(keyBlock));
      expect.unreachable();
    } catch (e) {
      const ce = e as ContainerError;
      expect(ce.kind).toBe("truncated");
      expect(ce.block).toBe(2);
      expect(hasCode(ce, "truncated")).toBe(true);
      expect(ce.warnings.map((w) => w.message)).toEqual(["ignored 1 line of text before the passh-vault line"]);
    }
    try {
      parse("passh-vault 1\n" + armorText(dataBlock) + armorText(dataBlock));
      expect.unreachable();
    } catch (e) {
      expect((e as ContainerError).kind).toBe("damaged");
      expect((e as ContainerError).block).toBe(1);
      expect(hasCode(e, "damaged")).toBe(true);
    }
    for (const [s, code] of [
      ["x", "not-vault"],
      ["passh-vault 0", "not-vault"],
      ["passh-vault 3", "newer-container"],
      ["", "truncated"],
    ] as const) {
      try {
        parse(s);
      } catch (e) {
        expect(hasCode(e, code)).toBe(true);
      }
    }
  });
});

describe("block checks (§2.3)", () => {
  const block = (stanzas: Stanza[], payload = 32) =>
    Uint8Array.from([...encodeHeader(stanzas, new Uint8Array(16)), ...new Uint8Array(payload)]);
  const b32 = b64RawEncode(new Uint8Array(32));
  const ck = (n: 1 | 2, b: Uint8Array) => {
    try {
      checkBlock(n, b);
      return "OK";
    } catch (e) {
      return errorText(e);
    }
  };
  const X = (args = [b32]): Stanza => ({ type: "X25519", args, body: new Uint8Array(32) });
  const S = (args = ["AAAAAAAAAAAAAAAAAAAAAA", "18"]): Stanza => ({ type: "scrypt", args, body: new Uint8Array(32) });

  test("block 1", () => {
    expect(ck(1, block([S()]))).toBe("OK");
    expect(ck(1, block([S(["!!", "abc"])]))).toBe("OK"); // arguments are checked only when opening
    const notScrypt = "file is damaged (block 1): the key block isn't encrypted with a passphrase";
    expect(ck(1, block([X()]))).toBe(notScrypt);
    expect(ck(1, block([S(), S()]))).toBe(notScrypt);
    expect(ck(1, block([S(["a"])]))).toBe(notScrypt);
    expect(ck(1, block([S(["a", "b", "c"])]))).toBe(notScrypt);
    expect(ck(1, block([{ ...S(), type: "Scrypt" }]))).toBe(notScrypt);
    expect(ck(1, block([S(), X()]))).toBe(notScrypt);
    expect(ck(1, latin1("not age"))).toBe("file is damaged (block 1): bad age header");
  });

  test("block 2", () => {
    expect(ck(2, block([X()]))).toBe("OK");
    expect(ck(2, block([X(), { type: "other", args: ["x"], body: new Uint8Array(5) }]))).toBe("OK");
    expect(ck(2, block([{ type: "Scrypt", args: [], body: new Uint8Array(0) }, X()]))).toBe("OK"); // types compare exactly
    expect(ck(2, block([X(["not-base64?!"])]))).toBe("OK"); // arguments aren't decoded here
    const notX = "file is damaged (block 2): the data block isn't encrypted to a vault key";
    expect(ck(2, block([X([b32, b32])]))).toBe(notX);
    expect(ck(2, block([X([])]))).toBe(notX);
    expect(ck(2, block([{ ...X(), type: "x25519" }]))).toBe(notX);
    expect(ck(2, block([X(), S()]))).toBe(notX);
    expect(ck(2, block([S()]))).toBe(notX);
  });

  test("payload sizes", () => {
    const imp = (n: 1 | 2) => `file is damaged (block ${n}): the encrypted data has an impossible size (cut short or extended)`;
    expect(ck(2, block([X()], 32))).toBe("OK");
    expect(ck(2, block([X()], 31))).toBe(imp(2));
    expect(ck(2, block([X()], 0))).toBe(imp(2));
    expect(ck(2, block([X()], 65568))).toBe("OK");
    expect(ck(2, block([X()], 65584))).toBe(imp(2));
    expect(ck(1, block([S()], 107))).toBe("OK");
    expect(ck(1, block([S()], 106 - 90))).toBe(imp(1));
  });

  test("in the container: header and size checks", () => {
    const dmg = Uint8Array.from(keyBlock);
    dmg[0] = 0x62;
    expect(errOf("passh-vault 1\n" + armorText(dmg) + armorText(dataBlock))).toBe("file is damaged (block 1): bad age header");
    expect(errOf("passh-vault 1\n" + armorText(keyBlock) + armorText(dataBlock.subarray(0, 168 + 20)))).toBe(
      "file is damaged (block 2): the encrypted data has an impossible size (cut short or extended)",
    );
    const longer = keyBlock.subarray(0, 150 + 20); // 1 byte longer would still be a possible size
    expect(errOf("passh-vault 1\n" + armorText(longer) + armorText(dataBlock))).toBe(
      "file is damaged (block 1): the encrypted data has an impossible size (cut short or extended)",
    );
  });
});

describe("recovery parse (§3.6 damaged key block)", () => {
  const dmgKey = () => {
    const d = Uint8Array.from(keyBlock);
    d[0] = 0x62;
    return armorText(d);
  };

  test("an intact file parses normally", () => {
    const r = parseContainerForRecovery(latin1(canonical));
    expect(r.keyBlockDamaged).toBe(false);
    expect(r.keyBlock).toEqual(keyBlock);
  });

  test("damaged block 1: the last block is the data block", () => {
    const variants = [
      "passh-vault 1\n" + dmgKey() + armorText(dataBlock),
      "passh-vault 1\n" + armorText(dataBlock), // the only block fails as a key block
      "passh-vault 1\n" + armorText(keyBlock).replace(END + "\n", "") + armorText(dataBlock), // END missing
      "passh-vault 1\n" + armorText(keyBlock).replace(BEGIN, BEGIN + "x") + armorText(dataBlock), // BEGIN damaged
      "passh-vault 1\nnoise\n" + armorText(keyBlock) + armorText(dataBlock),
      ("passh-vault 1\n" + dmgKey() + armorText(dataBlock)).replaceAll("\n", "\r\n").replace(/([A-Za-z0-9+/=]{30})/g, "$1\n"),
    ];
    for (const v of variants) {
      const r = parseContainerForRecovery(latin1(v));
      expect(r.keyBlockDamaged).toBe(true);
      expect(r.dataBlock).toEqual(dataBlock);
      expect(r.keyBlockError!.block).toBe(1);
      expect(r.keyBlockError!.kind).toBe("damaged");
    }
    const r = parseContainerForRecovery(latin1("pre\npassh-vault 1\n" + dmgKey() + armorText(dataBlock) + "post\n"));
    expect(r.warnings.map((w) => w.message)).toEqual([
      "ignored 1 line of text before the passh-vault line",
      "ignored 1 line of text after the last END line",
    ]);
  });

  test("the last block is returned unchecked; unusable armor gives the block-1 error", () => {
    const dmgData = Uint8Array.from(dataBlock);
    dmgData[0] = 0x62;
    const r = parseContainerForRecovery(latin1("passh-vault 1\n" + dmgKey() + armorText(dmgData)));
    expect(r.keyBlockDamaged).toBe(true);
    expect(r.dataBlock).toEqual(dmgData);
    const fails = [
      "passh-vault 1\n" + dmgKey() + armorText(dataBlock).replace(END + "\n", ""),
      "passh-vault 1\n" + dmgKey() + armorText(dataBlock).replace("\n", "\n!"),
      "passh-vault 1\n" + dmgKey() + BEGIN + "\n" + END + "\n",
    ];
    for (const v of fails) expect(() => parseContainerForRecovery(latin1(v))).toThrow("file is damaged (block 1): bad age header");
    // Truncation and other errors are never recovered.
    expect(() => parseContainerForRecovery(latin1("passh-vault 1\n" + armorText(keyBlock).replace(END + "\n", "")))).toThrow(
      "file is truncated: block 1 has no END line",
    );
    expect(() => parseContainerForRecovery(latin1("passh-vault 1\n" + armorText(keyBlock) + dmgKey()))).toThrow(
      "file is damaged (block 2): bad age header",
    );
  });
});

test("size and file-type errors (§2.5)", () => {
  expect(errorText(errFileTooLarge())).toBe("not a passh vault: the file is larger than 64 MiB");
  expect(errorText(errVerifyTooLarge("~/v.passh"))).toBe("~/v.passh is larger than 64 MiB: not a passh vault");
  expect(errorText(errNotRegularFile())).toBe("not a passh vault: not a regular file");
  expect(errorText(errVerifyNotRegular("~/v.passh"))).toBe("~/v.passh is not a regular file");
  expect(MAX_VAULT_FILE_SIZE).toBe(67108864);
  expect(hasCode(errFileTooLarge(), "too-large")).toBe(true);
  expect(hasCode(errNotRegularFile(), "not-regular")).toBe(true);
});
