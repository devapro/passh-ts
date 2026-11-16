// Protocol v1 (agent-session.md §A2.5): the server's decoding table and check order
// (expected answers observed on the reference agent), framing, the exact key response,
// the client's parsing of every answer, and `<times>`.

import { describe, expect, test } from "bun:test";
import { X25519Identity } from "../age/index.ts";
import { decodeMembers, goJsonString, JsonSyntaxError } from "./json.ts";
import { decodeRequest, encodeKeyResponse, encodeRefusal, encodeStatus, frameLine, isKeyText, keyFromAnswer, parseAnswer, parseKeyText } from "./protocol.ts";
import { elapsedMs, formatAgentTimes } from "./times.ts";

const enc = new TextEncoder();
const D = "54fabfdbfccea0ea512601f2683ad3b67fd4c0e0f4574d960245c7452597550a";

/** The answer the agent gives for a request line: a refusal's error text, or the op. */
function answer(line: string | Uint8Array): string {
  const r = decodeRequest(typeof line === "string" ? enc.encode(line) : line);
  if (r.refused) return `${r.code}: ${r.error}`;
  return r.op === "key" ? `key ${r.keyBlock}` : r.op;
}

describe("server decoding (§A2.5 table, check order)", () => {
  const table: Array<[string, string]> = [
    ['{"v":1,"op":"status"}', "status"],
    ['{"v":1,"op":"stop"}', "stop"],
    [`{"v":1,"op":"key","key_block":"${D}"}`, `key ${D}`],
    [`{"v":1,"op":"key","key_block":"${D}"}\r`, `key ${D}`],
    // check 3: not JSON, not an object, trailing text, wrong member types
    ["nonsense", "bad_request: malformed request"],
    ["", "bad_request: malformed request"],
    ["[]", "bad_request: malformed request"],
    ['"x"', "bad_request: malformed request"],
    ["5", "bad_request: malformed request"],
    ['{"v":1} x', "bad_request: malformed request"],
    ['{"v":1}{}', "bad_request: malformed request"],
    ['{"v":"1"}', "bad_request: malformed request"],
    ['{"v":1.0}', "bad_request: malformed request"],
    ['{"v":1e0}', "bad_request: malformed request"],
    ['{"v":true}', "bad_request: malformed request"],
    ['{"v":1,"op":5}', "bad_request: malformed request"],
    [`{"v":1,"op":"key","key_block":5}`, "bad_request: malformed request"],
    ['{"v":99999999999999999999}', "bad_request: malformed request"],
    ['{"v":9223372036854775808}', "bad_request: malformed request"],
    ['{"v":01}', "bad_request: malformed request"],
    ['{"v":1,"op":"status",}', "bad_request: malformed request"],
    ['{"v":1,"op":"stat\tus"}', "bad_request: malformed request"],
    ['{"v":1,"op":"status","x":tru}', "bad_request: malformed request"],
    ['{"v":1,"op":"\\x"}', "bad_request: malformed request"],
    // a type error anywhere fails, even when a later member is right
    ['{"v":"1","v":1,"op":"status"}', "bad_request: malformed request"],
    // check 4: v = 1 (absent counts as 0)
    ["null", "version: the agent speaks protocol version 1, not 0"],
    ["{}", "version: the agent speaks protocol version 1, not 0"],
    ['{"v":null}', "version: the agent speaks protocol version 1, not 0"],
    ['{"op":"status"}', "version: the agent speaks protocol version 1, not 0"],
    ['{"v":-0}', "version: the agent speaks protocol version 1, not 0"],
    ['{"v":2,"op":"status"}', "version: the agent speaks protocol version 1, not 2"],
    ['{"v":-1}', "version: the agent speaks protocol version 1, not -1"],
    ['{"v":9223372036854775807}', "version: the agent speaks protocol version 1, not 9223372036854775807"],
    // repeated members keep the last value; names match case-insensitively
    ['{"v":1,"op":"status","v":2}', "version: the agent speaks protocol version 1, not 2"],
    ['{"v":1,"V":2,"op":"status"}', "version: the agent speaks protocol version 1, not 2"],
    ['{"v":2,"V":1,"op":"status"}', "status"],
    ['{"V":1,"OP":"status"}', "status"],
    ['{"v":1,"\\u006fp":"status"}', "status"],
    [`{"v":1,"op":"key","KEY_BLOCK":"${D}"}`, `key ${D}`],
    [`{"v":1,"op":"key","\\u212aey_block":"${D}"}`, `key ${D}`],
    [`{"v":1,"op":"key","key_block":"${D}","key_block":null}`, `key ${D}`],
    ['{"v":1,"op":"status","x":[1,{"a":null}]}', "status"],
    [' {"v":1,"op":"status"} ', "status"],
    // check 5: op
    ['{"v":1,"op":null}', 'bad_request: unknown request ""'],
    ['{"v":1,"op":""}', 'bad_request: unknown request ""'],
    ['{"v":1}', 'bad_request: unknown request ""'],
    ['{"v":1,"op":"Status"}', 'bad_request: unknown request "Status"'],
    ['{"v":1,"op":"\\u017Ftatus"}', 'bad_request: unknown request "ſtatus"'],
    ['{"v":1,"op":"st\\u00e9\\u0007"}', 'bad_request: unknown request "sté\\a"'],
    [`{"v":1,"op":"${"x".repeat(40)}"}`, `bad_request: unknown request "${"x".repeat(32)}"`],
    [`{"v":1,"op":"${"é".repeat(40)}"}`, `bad_request: unknown request "${"é".repeat(32)}"`],
    ['{"v":1,"op":"<a>&\\u2028"}', 'bad_request: unknown request "<a>&\\u2028"'],
    ['{"v":1,"op":"a\\ud800b"}', 'bad_request: unknown request "a�b"'],
    ['{"v":1,"op":"\\"\\\\"}', 'bad_request: unknown request "\\"\\\\"'],
    // checks 6 and 7: key_block present, 64 lower-case hex
    ['{"v":1,"op":"key"}', "bad_request: a key request must name the vault's key block (key_block)"],
    ['{"v":1,"op":"key","key_block":null}', "bad_request: a key request must name the vault's key block (key_block)"],
    ['{"v":1,"op":"key","key_block":""}', "bad_request: a key request must name the vault's key block (key_block)"],
    ['{"v":1,"op":"key","key_block":"ABC"}', "bad_request: key_block is not a hex SHA-256"],
    [`{"v":1,"op":"key","key_block":"${D.toUpperCase()}"}`, "bad_request: key_block is not a hex SHA-256"],
    [`{"v":1,"op":"key","key_block":"${D}0"}`, "bad_request: key_block is not a hex SHA-256"],
    // the order: version before op, op before key_block
    ['{"v":2,"op":"nope"}', "version: the agent speaks protocol version 1, not 2"],
    ['{"v":1,"op":"nope","key_block":"x"}', 'bad_request: unknown request "nope"'],
  ];
  for (const [req, want] of table) test(JSON.stringify(req), () => expect(answer(req)).toBe(want));

  test("invalid UTF-8 in a string becomes U+FFFD, one per byte", () => {
    const line = new Uint8Array([...enc.encode('{"v":1,"op":"st'), 0xff, 0xe2, 0x82, ...enc.encode('us"}')]);
    expect(answer(line)).toBe('bad_request: unknown request "st���us"');
  });
  test("a raw control character in a string is a syntax error", () => {
    expect(answer('{"v":1,"op":"a\u0001"}')).toBe("bad_request: malformed request");
  });
});

describe("json", () => {
  test("syntax errors", () => {
    for (const s of ["{", "[1,]", '{"a"}', '{"a":}', "-", "1.", "1e", "01", "tru", "nul", '"\\u12"', '"abc']) {
      expect(() => decodeMembers(enc.encode(s), {})).toThrow(JsonSyntaxError);
    }
  });
  test("surrogate pairs and escapes", () => {
    const d = decodeMembers(enc.encode('{"op":"\\ud83d\\ude00\\/\\b\\f\\n\\r\\t"}'), { op: "string" });
    expect(d.values.get("op")).toBe("😀/\b\f\n\r\t");
  });
  test("raw members keep their bytes", () => {
    const d = decodeMembers(enc.encode('{"key": "abc" , "x":1}'), { key: "raw" });
    expect(new TextDecoder().decode(d.values.get("key") as Uint8Array)).toBe('"abc"');
  });
  test("goJsonString escapes like Go's json.Marshal", () => {
    expect(goJsonString('a"b\\c\n\r\t\b\f\u0001<>&  é')).toBe('"a\\"b\\\\c\\n\\r\\t\\b\\f\\u0001\\u003c\\u003e\\u0026\\u2028\\u2029é"');
    expect(goJsonString("\ud800")).toBe('"\\ufffd"');
  });
});

describe("framing (§A2.5)", () => {
  test("a line ends at the first LF; bytes after it are ignored", () => {
    const f = frameLine(enc.encode('{"v":1}\nGARBAGE'));
    expect(f.kind).toBe("line");
    if (f.kind === "line") expect(new TextDecoder().decode(f.line)).toBe('{"v":1}');
  });
  test("CRLF: the CR is JSON white space", () => {
    const f = frameLine(enc.encode('{"v":1,"op":"status"}\r\n'));
    expect(f.kind === "line" && answer(f.line)).toBe("status");
  });
  test("no LF yet: more", () => expect(frameLine(enc.encode('{"v":1}')).kind).toBe("more"));
  test("4096 bytes including the LF are fine; 4096 without an LF are too large", () => {
    const ok = enc.encode("x".repeat(4095) + "\n");
    expect(frameLine(ok).kind).toBe("line");
    expect(frameLine(enc.encode("x".repeat(4096))).kind).toBe("too_large");
    expect(frameLine(enc.encode("x".repeat(4096) + "\n")).kind).toBe("too_large");
    expect(frameLine(enc.encode("x".repeat(4095))).kind).toBe("more");
  });
});

describe("responses", () => {
  const key = "AGE-SECRET-KEY-1H73CLMYM040VPHQ0JRRVF2RH4LK7UPR03HNQNVQQHJZMTLQJ6HQSN7H9NF";
  test("the key response, exactly", () => {
    expect(new TextDecoder().decode(encodeKeyResponse(enc.encode(key)))).toBe(`{"v":1,"ok":true,"key":"${key}"}\n`);
  });
  test("status and refusals in the reference's byte form", () => {
    expect(new TextDecoder().decode(encodeStatus({ pid: 24892, vault: "/home/a/v.passh", idleLeftMs: 899821, maxLeftMs: 7199821 }))).toBe(
      '{"v":1,"ok":true,"pid":24892,"vault":"/home/a/v.passh","idle_left_ms":899821,"max_left_ms":7199821}\n',
    );
    expect(new TextDecoder().decode(encodeRefusal({ code: "bad_request", error: 'unknown request "<a>&\\u2028"' }))).toBe(
      '{"v":1,"ok":false,"code":"bad_request","error":"unknown request \\"\\u003ca\\u003e\\u0026\\\\u2028\\""}\n',
    );
  });
});

describe("key text (§A2.5)", () => {
  const id = X25519Identity.generate();
  const key = id.format();
  test("rule", () => {
    expect(isKeyText(enc.encode(key))).toBe(true);
    expect(isKeyText(enc.encode("AGE-SECRET-KEY-1"))).toBe(false);
    expect(isKeyText(enc.encode(key.toLowerCase()))).toBe(false);
    expect(isKeyText(enc.encode("AGE-SECRET-KEY-1" + "Q".repeat(112)))).toBe(true);
    expect(isKeyText(enc.encode("AGE-SECRET-KEY-1" + "Q".repeat(113)))).toBe(false);
    expect(isKeyText(enc.encode(key + " "))).toBe(false);
  });
  test("parse", () => {
    expect(parseKeyText(enc.encode("AGE-SECRET-KEY-1" + "Q".repeat(112)))).toBe("not a valid vault key");
    expect(parseKeyText(enc.encode(key.slice(0, -1) + (key.endsWith("Q") ? "P" : "Q")))).toBe("not a valid vault key");
    const p = parseKeyText(enc.encode(key));
    expect(p instanceof X25519Identity && p.equals(id)).toBe(true);
  });
});

/** The client's reading of an answer line: an error text, or a summary. */
function client(line: string, wantKey = false): string {
  try {
    const p = parseAnswer(enc.encode(line));
    if (p.kind !== "ok") return p.kind;
    if (wantKey) {
      keyFromAnswer(p.answer);
      return "key";
    }
    return `pid ${p.answer.pid} vault ${p.answer.vault} ${p.answer.idleLeftMs}/${p.answer.maxLeftMs}`;
  } catch (e) {
    return (e as Error).message;
  }
}

describe("client parsing (§A2.5), texts observed on the reference client", () => {
  const key = X25519Identity.generate().format();
  const K = (k: string) => `{"v":1,"ok":true,"key":${k}}`;
  const table: Array<[string, string, boolean?]> = [
    ['{"v":1,"ok":true,"pid":77,"vault":"/x","idle_left_ms":1000,"max_left_ms":5000}', "pid 77 vault /x 1000/5000"],
    ['{"v":1,"ok":true}', "pid 0 vault  0/0"],
    ['{"V":1,"OK":true,"PID":9}', "pid 9 vault  0/0"],
    ['{"v":1,"ok":true,"pid":99999999999}', "pid 99999999999 vault  0/0"],
    ['{"v":2,"ok":true}', "agent: the running agent speaks protocol version 2, this passh 1; kill it and run `passh unlock` again"],
    ['{"v":2,"ok":"x"}', "agent: the running agent speaks protocol version 2, this passh 1; kill it and run `passh unlock` again"],
    ['{"ok":true,"pid":5}', "agent: the running agent speaks protocol version 0, this passh 1; kill it and run `passh unlock` again"],
    ["null", "agent: the running agent speaks protocol version 0, this passh 1; kill it and run `passh unlock` again"],
    ['{"ok":false,"code":"key_block_changed"}', "agent: the running agent speaks protocol version 0, this passh 1; kill it and run `passh unlock` again"],
    ['{"v":"1","ok":true}', "agent: malformed answer"],
    ['{"v":1.5,"ok":true}', "agent: malformed answer"],
    ["hello", "agent: malformed answer"],
    ["", "agent: malformed answer"],
    ["[1]", "agent: malformed answer"],
    ['{"v":1,"ok":true,"pid":9} x', "agent: malformed answer"],
    ['{"v":1,"ok":"true"}', "agent: malformed answer"],
    ['{"v":1,"ok":true,"pid":"5"}', "agent: malformed answer"],
    ['{"v":1,"ok":false,"error":5}', "agent: malformed answer"],
    ['{"v":1,"ok":false,"code":"expired","error":"the agent has expired"}', "expired"],
    ['{"v":1,"ok":false,"code":"key_block_changed","error":"x"}', "key_block_changed"],
    ['{"v":1,"ok":false,"code":"version","error":"the agent speaks protocol version 1, not 0"}', "agent: the agent speaks protocol version 1, not 0"],
    ['{"v":1,"ok":false,"code":"weird","error":"some error"}', "agent: the agent refused the request: some error"],
    ['{"v":1,"ok":false,"error":"some error"}', "agent: the agent refused the request: some error"],
    ['{"v":1,"ok":false}', "agent: the agent refused the request: "],
    ['{"v":1}', "agent: the agent refused the request: "],
    ['{"v":1,"ok":true,"pid":9}\r', "pid 9 vault  0/0"],
    [K(`"${key}"`), "key", true],
    [`{"v":1,"ok":true,"key": "${key}" }`, "key", true],
    ['{"v":1,"ok":true}', "agent: the agent's answer holds no vault key", true],
    [K("5"), "agent: the agent's answer holds no vault key", true],
    [K("null"), "agent: the agent's answer holds no vault key", true],
    [K("{}"), "agent: the agent's answer holds no vault key", true],
    [K(`"${key.toLowerCase()}"`), "agent: the agent's answer holds no valid vault key: not a vault key", true],
    [K('""'), "agent: the agent's answer holds no valid vault key: not a vault key", true],
    [K('"AGE-SECRET-KEY-1"'), "agent: the agent's answer holds no valid vault key: not a vault key", true],
    [K(`"AGE-SECRET-KEY-1${"Q".repeat(120)}"`), "agent: the agent's answer holds no valid vault key: not a vault key", true],
    [K(`"${key.slice(0, 20)}\\u0041${key.slice(21)}"`), "agent: the agent's answer holds no valid vault key: not a vault key", true],
    [K(`"${key.slice(0, -1)}${key.endsWith("Q") ? "P" : "Q"}"`), "agent: the agent's answer holds no valid vault key: not a valid vault key", true],
  ];
  for (const [line, want, k] of table) test(JSON.stringify(line), () => expect(client(line, k)).toBe(want));
});

describe("<times> (§A2.3)", () => {
  test("one or two durations", () => {
    expect(formatAgentTimes(5, 100000, 100000)).toBe("the agent (pid 5) exits in 1m40s");
    expect(formatAgentTimes(5, 100001, 100000)).toBe("the agent (pid 5) exits in 1m40s");
    expect(formatAgentTimes(5, 99999, 100000)).toBe("the agent (pid 5) exits in 1m40s if unused, in 1m40s at the latest");
    expect(formatAgentTimes(5n, 499n, 3600499n)).toBe("the agent (pid 5) exits in 0s if unused, in 1h at the latest");
    expect(formatAgentTimes(5, 500, 3659500)).toBe("the agent (pid 5) exits in 1s if unused, in 1h1m at the latest");
    expect(formatAgentTimes(427589, 59990, 7199990)).toBe("the agent (pid 427589) exits in 1m if unused, in 2h at the latest");
    expect(formatAgentTimes(1, 899821, 7199821)).toBe("the agent (pid 1) exits in 15m if unused, in 2h at the latest");
    expect(formatAgentTimes(1, 14 * 60000 + 59400, 7195000)).toBe("the agent (pid 1) exits in 14m59s if unused, in 1h59m at the latest");
    expect(formatAgentTimes(0, 0, 0)).toBe("the agent (pid 0) exits in 0s");
    expect(formatAgentTimes(1, -5, 0)).toBe("the agent (pid 1) exits in 0s if unused, in 0s at the latest");
  });
  test("elapsed is the larger of the monotonic and wall-clock differences", () => {
    expect(elapsedMs({ mono: 0, wall: 1000 }, { mono: 10, wall: 61000 })).toBe(60000); // slept: wall counts
    expect(elapsedMs({ mono: 0, wall: 1000 }, { mono: 5000, wall: 0 })).toBe(5000); // clock set back: monotonic counts
  });
});
