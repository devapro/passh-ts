// Protocol v1 of the agent (agent-session.md §A2.5, MUST): framing, the server's decoding
// and check order, the exact key response, and the client's parsing of every answer.
// The agent's wire texts stay English; the client's errors are passh messages (errorf).

import { codedError, errorf } from "../i18n/index.ts";
import { goQuote } from "../i18n/quote.ts";
import { X25519Identity } from "../age/index.ts";
import { decodeMembers, goJsonString, JsonSyntaxError } from "./json.ts";

/** The protocol version this passh speaks. */
export const PROTOCOL_VERSION = 1;
/** A request or response line, at most, including the `\n` (§A1). */
export const MAX_LINE = 4096;
/** The key text, at most (§A1). */
export const KEY_TEXT_MAX = 128;

const KEY_PREFIX = "AGE-SECRET-KEY-1";

// ---------------------------------------------------------------------------
// Framing

export type Frame =
  /** A complete line: the bytes before the first `\n` (bytes after it are ignored). */
  | { kind: "line"; line: Uint8Array }
  /** 4096 bytes without `\n`. */
  | { kind: "too_large" }
  /** Not complete yet. */
  | { kind: "more" };

/**
 * Looks for the request line in what was received so far (§A2.5 framing): the first `\n`
 * within the first 4096 bytes ends it; 4096 bytes without one are `request too large`.
 */
export function frameLine(buf: Uint8Array): Frame {
  const limit = Math.min(buf.length, MAX_LINE);
  for (let i = 0; i < limit; i++) if (buf[i] === 0x0a) return { kind: "line", line: buf.subarray(0, i) };
  if (buf.length >= MAX_LINE) return { kind: "too_large" };
  return { kind: "more" };
}

// ---------------------------------------------------------------------------
// Server side

export type RefusalCode = "bad_request" | "version" | "key_block_changed" | "expired";

export interface Refusal {
  refused: true;
  code: RefusalCode;
  error: string;
}

export type Request = { refused?: false; op: "status" } | { refused?: false; op: "stop" } | { refused?: false; op: "key"; keyBlock: string };

/** Wire texts of the refusals (§A2.5 table). */
export const WIRE = {
  tooLarge: "request too large",
  malformed: "malformed request",
  version: (v: bigint) => `the agent speaks protocol version 1, not ${v}`,
  unknown: (op: string) => `unknown request ${goQuote([...op].slice(0, 32).join(""))}`,
  noKeyBlock: "a key request must name the vault's key block (key_block)",
  notHex: "key_block is not a hex SHA-256",
  keyBlockChanged: "the vault's key block isn't the one this agent was unlocked with",
  expired: "the agent has expired",
} as const;

export function refusal(code: RefusalCode, error: string): Refusal {
  return { refused: true, code, error };
}

/** 64 lower-case hex digits. */
export function isHexDigest(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

/**
 * Decodes a request line (the bytes before `\n`) and runs checks 3–7 of §A2.5 in order.
 * Checks 8 (the digest) and 9 (expiry) need the agent's state (server.ts).
 */
export function decodeRequest(line: Uint8Array): Request | Refusal {
  let d;
  try {
    d = decodeMembers(line, { v: "int", op: "string", key_block: "string" });
  } catch (e) {
    if (e instanceof JsonSyntaxError) return refusal("bad_request", WIRE.malformed);
    throw e;
  }
  if (d.typeError) return refusal("bad_request", WIRE.malformed);
  const v = (d.values.get("v") as bigint | undefined) ?? 0n;
  if (v !== 1n) return refusal("version", WIRE.version(v));
  const op = (d.values.get("op") as string | undefined) ?? "";
  if (op !== "key" && op !== "status" && op !== "stop") return refusal("bad_request", WIRE.unknown(op));
  if (op !== "key") return { op };
  const kb = (d.values.get("key_block") as string | undefined) ?? "";
  if (kb === "") return refusal("bad_request", WIRE.noKeyBlock);
  if (!isHexDigest(kb)) return refusal("bad_request", WIRE.notHex);
  return { op: "key", keyBlock: kb };
}

export interface StatusFields {
  pid: number | bigint;
  vault: string;
  idleLeftMs: number | bigint;
  maxLeftMs: number | bigint;
}

const enc = new TextEncoder();

/** `{"v":1,"ok":true,"pid":…,"vault":"…","idle_left_ms":…,"max_left_ms":…}\n` (Go's member order and escaping). */
export function encodeStatus(s: StatusFields): Uint8Array {
  return enc.encode(
    `{"v":1,"ok":true,"pid":${s.pid},"vault":${goJsonString(s.vault)},"idle_left_ms":${s.idleLeftMs},"max_left_ms":${s.maxLeftMs}}\n`,
  );
}

/** `{"v":1,"ok":false,"code":"…","error":"…"}\n`. */
export function encodeRefusal(r: { code: string; error: string }): Uint8Array {
  return enc.encode(`{"v":1,"ok":false,"code":${goJsonString(r.code)},"error":${goJsonString(r.error)}}\n`);
}

const KEY_HEAD = enc.encode('{"v":1,"ok":true,"key":"');
const KEY_TAIL = enc.encode('"}\n');

/**
 * The key response, exactly `{"v":1,"ok":true,"key":"` + key + `"}` + `\n` (§A2.5). Built
 * from the key's bytes into a buffer the caller wipes after writing it.
 */
export function encodeKeyResponse(key: Uint8Array): Uint8Array {
  const out = new Uint8Array(KEY_HEAD.length + key.length + KEY_TAIL.length);
  out.set(KEY_HEAD, 0);
  out.set(key, KEY_HEAD.length);
  out.set(KEY_TAIL, KEY_HEAD.length + key.length);
  return out;
}

/**
 * The key-text rule (§A2.5): `AGE-SECRET-KEY-1` followed by one or more of `[A-Z0-9]`, at
 * most 128 bytes in total. Works on bytes so nothing is decoded or copied.
 */
export function isKeyText(b: Uint8Array): boolean {
  if (b.length > KEY_TEXT_MAX || b.length <= KEY_PREFIX.length) return false;
  for (let i = 0; i < KEY_PREFIX.length; i++) if (b[i] !== KEY_PREFIX.charCodeAt(i)) return false;
  for (let i = KEY_PREFIX.length; i < b.length; i++) {
    const c = b[i]!;
    if (!((c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39))) return false;
  }
  return true;
}

/** Why a key text was refused: the agent's and the client's shared wording. */
export type KeyTextProblem = "not a vault key" | "not a valid vault key";

/**
 * Checks a key text and parses it: the key-text rule, then a bech32 X25519 identity.
 * Returns the identity, or the problem.
 */
export function parseKeyText(b: Uint8Array): X25519Identity | KeyTextProblem {
  if (!isKeyText(b)) return "not a vault key";
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  try {
    return X25519Identity.parse(s);
  } catch {
    return "not a valid vault key";
  }
}

// ---------------------------------------------------------------------------
// Client side

/** The members of an `ok:true` answer; missing ones read as 0 / "" (§A2.5). */
export interface Answer {
  pid: bigint;
  vault: string;
  idleLeftMs: bigint;
  maxLeftMs: bigint;
  /** The raw JSON bytes of `key` (json.RawMessage), when present. */
  key?: Uint8Array;
}

export type ParsedAnswer =
  | { kind: "ok"; answer: Answer }
  /** `expired`: the agent is as good as gone. */
  | { kind: "expired" }
  /** `key_block_changed`. */
  | { kind: "key_block_changed" };

/** The client's errors are `agent: …` (§A2.5 client parsing), code "agent". */
export function agentError(format: string, ...args: unknown[]) {
  return codedError("agent", "agent: " + format, ...args);
}

/**
 * Parses an answer line (the bytes before `\n`), §A2.5 "Client parsing": `v` first (an
 * integer; absent = 0), then the members. Throws the `agent: …` errors.
 */
export function parseAnswer(line: Uint8Array): ParsedAnswer {
  let first;
  try {
    first = decodeMembers(line, { v: "int" });
  } catch (e) {
    if (e instanceof JsonSyntaxError) throw agentError("malformed answer");
    throw e;
  }
  if (first.typeError) throw agentError("malformed answer");
  const v = (first.values.get("v") as bigint | undefined) ?? 0n;
  if (v !== 1n) throw agentError("the running agent speaks protocol version %d, this passh 1; kill it and run `passh unlock` again", v);
  const d = decodeMembers(line, {
    v: "int",
    ok: "bool",
    code: "string",
    error: "string",
    key: "raw",
    pid: "int",
    vault: "string",
    idle_left_ms: "int",
    max_left_ms: "int",
  });
  if (d.typeError) throw agentError("malformed answer");
  const ok = (d.values.get("ok") as boolean | undefined) ?? false;
  if (!ok) {
    const code = (d.values.get("code") as string | undefined) ?? "";
    const text = (d.values.get("error") as string | undefined) ?? "";
    if (code === "expired") return { kind: "expired" };
    if (code === "key_block_changed") return { kind: "key_block_changed" };
    if (code === "version") throw agentError("%s", text);
    throw agentError("the agent refused the request: %s", text);
  }
  const answer: Answer = {
    pid: (d.values.get("pid") as bigint | undefined) ?? 0n,
    vault: (d.values.get("vault") as string | undefined) ?? "",
    idleLeftMs: (d.values.get("idle_left_ms") as bigint | undefined) ?? 0n,
    maxLeftMs: (d.values.get("max_left_ms") as bigint | undefined) ?? 0n,
  };
  const key = d.values.get("key");
  if (key instanceof Uint8Array) answer.key = key;
  return { kind: "ok", answer };
}

/**
 * The vault key of a key answer (§A2.5): `key` must be a JSON string whose bytes between
 * the quotes, taken as they are, pass the key-text rule and parse as an X25519 identity.
 */
export function keyFromAnswer(a: Answer): X25519Identity {
  const raw = a.key;
  if (!raw || raw.length < 2 || raw[0] !== 0x22 || raw[raw.length - 1] !== 0x22) throw agentError("the agent's answer holds no vault key");
  const inner = raw.subarray(1, raw.length - 1);
  const r = parseKeyText(inner);
  raw.fill(0);
  if (typeof r === "string") throw agentError("the agent's answer holds no valid vault key: %s", errorf(r));
  return r;
}
