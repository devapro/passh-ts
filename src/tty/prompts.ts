// The prompts of cli.md §1.6 on /dev/tty (agent-session.md §A4, i18n.md §5).
//
// Raw prompts (passphrase, pairs, masked lines): raw mode first, then the prompt, then
// the read, so type-ahead is never echoed; line breaks are written as `\r\n`; on return
// the saved state is restored and, if the cursor is still after a prompt, a line break
// is written. Ctrl-C typed there is a key (`interrupted`, exit 1).
//
// Cooked prompts (plain lines, yes/no, typed phrases): the terminal's line editing and
// echo; Ctrl-C there is SIGINT (exit 130).
//
// Signals (SIGINT, SIGTERM, SIGHUP) are caught while any prompt waits: a raw prompt
// discards unread input (TCIFLUSH) while echo is still off, restores the state, ends the
// prompt line; then the prompt fails with SignalError (`interrupted (<signal name>)`,
// exit 128 + n). A signal that arrives just after the answer was complete still counts.
// The reference writes no line break after a cooked prompt that a signal ends.
//
// Texts given by the caller (prompts, questions) are shown as given (already translated,
// values escaped single-line); the fixed texts of this file are translated here.

import { codedError, errorf, T, yesNoHint, parseYesNo, findError, type PasshError } from "../i18n/index.ts";
import { SignalError } from "../errors.ts";
import { makeRaw, tcflushInput, tcsetattr } from "../ffi/termios.ts";
import { eofError, inputTooLong, newEditState, passphraseTooLong, readEditedLine, type EditState } from "./lineedit.ts";
import { SignalInterrupt, SignalWatch } from "./signals.ts";
import { FdByteSource, type ByteSource } from "./source.ts";
import type { Tty } from "./tty.ts";

/** Passphrase limit (§A1). */
export const PASSPHRASE_MAX = 4096;
/** Line limit (§A1): plain lines; masked input as a whole (joined with line breaks) stays below it. */
export const LINE_MAX = 65536;
/** Passphrase attempts, pair attempts and yes/no tries (§A1). */
export const ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Errors

/** `not confirmed` (yes/no after 3 answers not understood). Code "not-confirmed". */
export function notConfirmedError(): PasshError {
  return codedError("not-confirmed", "not confirmed");
}

/**
 * Wraps a prompt error with context (`reading the passphrase: %w`), keeping a SignalError
 * a SignalError (exit 128 + n) and the codes of the others.
 */
export function wrapPromptError(e: unknown, format: string): Error {
  const sig = findError(e, (x): x is SignalError => x instanceof SignalError);
  if (sig) return new SignalError(sig.signal, format, e);
  if (e instanceof Error && "code" in e && typeof (e as PasshError).code === "string") {
    return codedError((e as PasshError).code!, format, e);
  }
  return errorf(format, e);
}

// ---------------------------------------------------------------------------
// Raw and cooked prompt scopes

/** The I/O of a raw prompt: writes and the line editor. */
export interface RawIO {
  readonly tty: Tty;
  readonly src: ByteSource;
  /** Writes a prompt (escaped text, no line break). */
  prompt(text: string): void;
  /** Writes a message line (escaped). */
  say(text: string): void;
  /** Ends the prompt line if the cursor is after a prompt. */
  endLine(): void;
}

/**
 * Runs body in raw mode with signals caught (the scope of every raw prompt). `source`
 * replaces the terminal as the byte source (tests).
 */
export async function withRawPrompt<R>(tty: Tty, body: (io: RawIO) => Promise<R>, source?: ByteSource): Promise<R> {
  const watch = new SignalWatch().start();
  let saved;
  try {
    saved = tty.getAttr();
    tty.setAttr(makeRaw(saved));
  } catch (e) {
    watch.stop();
    throw e;
  }
  tty.raw = true;
  const src = source ?? new FdByteSource(tty.fd, watch);
  const io: RawIO = {
    tty,
    src,
    prompt: (t) => tty.print(t),
    say: (t) => tty.say(t),
    endLine: () => tty.endLine(),
  };
  let failed: unknown = undefined;
  let ok = false;
  let result: R;
  try {
    result = await body(io);
    ok = true;
  } catch (e) {
    failed = e;
  }
  // A signal that arrived just after the answer was complete still counts: let its
  // handler run before looking.
  await tick();
  // Discard what was typed ahead while echo is still off (never after a normal answer).
  if (!ok || watch.received) tcflushInput(tty.fd);
  // Best effort: a terminal that hung up can't be restored, and the signal must still win.
  tcsetattr(tty.fd, saved);
  tty.raw = false;
  try {
    tty.endLine();
  } catch {
    /* the terminal is gone */
  }
  watch.stop();
  if (watch.received) throw new SignalError(watch.received);
  if (!ok) {
    if (failed instanceof SignalInterrupt) throw new SignalError(failed.signal);
    throw failed;
  }
  return result!;
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Runs body with signals caught (the scope of every cooked prompt). */
export async function withCookedPrompt<R>(tty: Tty, body: (src: ByteSource) => Promise<R>, source?: ByteSource): Promise<R> {
  const watch = new SignalWatch().start();
  const src = source ?? new FdByteSource(tty.fd, watch);
  try {
    const r = await body(src);
    await tick();
    if (watch.received) throw new SignalInterrupt(watch.received);
    return r;
  } catch (e) {
    if (e instanceof SignalInterrupt) throw new SignalError(e.signal);
    if (watch.received) throw new SignalError(watch.received);
    throw e;
  } finally {
    watch.stop();
  }
}

// ---------------------------------------------------------------------------
// Raw prompts

export interface SecretOptions {
  /** Default 4096 bytes. */
  limit?: number;
  /** Test hook: the byte source instead of the terminal. */
  source?: ByteSource;
}

async function readOneSecret(io: RawIO, prompt: string, limit: number): Promise<Uint8Array> {
  io.prompt(prompt);
  const r = await readEditedLine(io.src, newEditState(), { limit, tooLong: passphraseTooLong });
  if (r.kind === "eof") throw eofError();
  io.endLine();
  return r.bytes;
}

/**
 * A secret line with no echo (`Passphrase: `). Errors are bare: `interrupted` (Ctrl-C,
 * code "interrupted"), `EOF` (Ctrl-D on an empty line, code "eof"), `passphrase longer
 * than 4096 bytes`, or a SignalError; readPassphrase adds the context.
 */
export function readSecret(tty: Tty, prompt: string, opts: SecretOptions = {}): Promise<Uint8Array> {
  return withRawPrompt(tty, (io) => readOneSecret(io, prompt, opts.limit ?? PASSPHRASE_MAX), opts.source);
}

/**
 * One try at `Passphrase: ` (or `Current passphrase: `): readSecret with errors as
 * `reading the passphrase: <error>` (cli.md §1.5; e.g. `reading the passphrase: EOF`,
 * `reading the passphrase: interrupted (terminated)` with exit 143). The 3 tries and
 * `Wrong passphrase. Try again.` are the caller's (it knows whether the passphrase fits).
 */
export async function readPassphrase(tty: Tty, prompt = T("Passphrase: "), opts: SecretOptions = {}): Promise<Uint8Array> {
  try {
    return await readSecret(tty, prompt, opts);
  } catch (e) {
    throw wrapPromptError(e, "reading the passphrase: %w");
  }
}

/** The texts and rules of a pair prompt (English; translated when shown). */
export interface PairTexts {
  first: string;
  second: string;
  /** Said for an empty first answer when empty isn't allowed. */
  empty: string;
  mismatch: string;
  /** The error after the last mismatch. */
  failure: string;
  /** An empty first answer is returned at once (no repetition). */
  allowEmpty: boolean;
}

/** `New passphrase: ` / `Repeat passphrase: ` (init, passwd, rekey, recover). */
export const PASSPHRASE_PAIR: PairTexts = {
  first: "New passphrase: ",
  second: "Repeat passphrase: ",
  empty: "The passphrase must not be empty.",
  mismatch: "Passphrases don't match. Try again.",
  failure: "passphrases don't match",
  allowEmpty: false,
};

/** `Password (empty to generate): ` / `Repeat password: ` (add). Empty = generate. */
export const PASSWORD_PAIR: PairTexts = {
  first: "Password (empty to generate): ",
  second: "Repeat password: ",
  empty: "The password must not be empty.",
  mismatch: "Passwords don't match. Try again.",
  failure: "passwords don't match",
  allowEmpty: true,
};

export interface PairOptions extends SecretOptions {
  texts?: PairTexts;
  /**
   * Called with the first answer (non-empty); a returned text is said before the
   * repetition (the strength warning: `warning: weak passphrase: …`, already translated).
   */
  check?: (secret: Uint8Array) => string | undefined | Promise<string | undefined>;
  /** Default 3. */
  attempts?: number;
}

/** Constant-time comparison of two byte strings (the lengths may leak). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * A new secret typed twice, both prompts in one raw-mode stay (agent-session.md §A4
 * "Pairs"). An empty first answer says the "empty" text and counts as an attempt (or is
 * returned when allowed); a mismatch says the mismatch text; after `attempts` the
 * failure error (code "mismatch"). Bare errors as readSecret (`EOF`, `interrupted`, …).
 */
export function readSecretPair(tty: Tty, opts: PairOptions = {}): Promise<Uint8Array> {
  const t = opts.texts ?? PASSPHRASE_PAIR;
  const limit = opts.limit ?? PASSPHRASE_MAX;
  const attempts = opts.attempts ?? ATTEMPTS;
  return withRawPrompt(
    tty,
    async (io) => {
      for (let i = 0; i < attempts; i++) {
        const a = await readOneSecret(io, T(t.first), limit);
        if (a.length === 0) {
          if (t.allowEmpty) return a;
          io.say(T(t.empty));
          continue;
        }
        if (opts.check) {
          const msg = await opts.check(a);
          if (msg) io.say(msg);
        }
        const b = await readOneSecret(io, T(t.second), limit);
        const same = constantTimeEqual(a, b);
        b.fill(0);
        if (same) return a;
        a.fill(0);
        io.say(T(t.mismatch));
      }
      throw codedError("mismatch", t.failure);
    },
    opts.source,
  );
}

export interface MaskedOptions {
  /** Default `> `. */
  prompt?: string;
  /** Default 65535: the lines joined with line breaks, plus one, stay within 64 KiB. */
  limit?: number;
  source?: ByteSource;
}

/**
 * Masked lines (the paper key, agent-session.md §A4): prompt per line, `*` per character;
 * blank lines before the first character are ignored; the first blank line after it, or
 * Ctrl-D on an empty line, ends the input. Returns the lines joined with `\n` (empty if
 * nothing was typed). Over the limit: `input longer than <n> bytes`, where n is what was
 * left of 65535 bytes for this line (each finished line counts its length + 1).
 */
export function readMaskedLines(tty: Tty, opts: MaskedOptions = {}): Promise<Uint8Array> {
  const prompt = opts.prompt ?? "> ";
  const total = opts.limit ?? LINE_MAX - 1;
  const promptLine = prompt.slice(prompt.lastIndexOf("\n") + 1);
  return withRawPrompt(
    tty,
    async (io) => {
      const st: EditState = newEditState();
      const lines: Uint8Array[] = [];
      let used = 0;
      for (;;) {
        io.prompt(prompt);
        const r = await readEditedLine(io.src, st, {
          limit: Math.max(0, total - used),
          tooLong: inputTooLong,
          mask: { promptLine, echo: (s) => tty.writeRaw(s) },
        });
        io.endLine();
        if (r.kind === "eof") break;
        if (r.bytes.length === 0) {
          if (lines.length === 0) continue;
          break;
        }
        lines.push(r.bytes);
        used += r.bytes.length + 1;
      }
      const out = new Uint8Array(Math.max(0, used - 1));
      let off = 0;
      for (const [i, l] of lines.entries()) {
        if (i > 0) out[off++] = 0x0a;
        out.set(l, off);
        off += l.length;
        l.fill(0);
      }
      return out;
    },
    opts.source,
  );
}

// ---------------------------------------------------------------------------
// Cooked prompts

async function readCookedLine(src: ByteSource, limit: number): Promise<Uint8Array | null> {
  const buf: number[] = [];
  for (;;) {
    const b = await src.readByte();
    if (b === null) {
      // Ctrl-D: end of input on an empty line; after text, the text is the line.
      if (buf.length === 0) return null;
      break;
    }
    if (b === 0x0a) break;
    if (buf.length >= limit) throw inputTooLong(limit);
    buf.push(b);
  }
  if (buf.length > 0 && buf[buf.length - 1] === 0x0d) buf.pop();
  return Uint8Array.from(buf);
}

export interface LineOptions {
  /** Default 65536 bytes. */
  limit?: number;
  source?: ByteSource;
}

/**
 * A plain line (cooked mode, echo on; agent-session.md §A4): the prompt, then the bytes
 * up to `\n`, a trailing `\r` dropped; null on end of input (Ctrl-D on an empty line).
 * Over 64 KiB: `input longer than 65536 bytes`.
 */
export function readLineBytes(tty: Tty, prompt: string, opts: LineOptions = {}): Promise<Uint8Array | null> {
  return withCookedPrompt(
    tty,
    async (src) => {
      tty.print(prompt);
      return readCookedLine(src, opts.limit ?? LINE_MAX);
    },
    opts.source,
  );
}

/** readLineBytes decoded as UTF-8 (invalid bytes become U+FFFD); null on end of input. */
export async function readLine(tty: Tty, prompt: string, opts: LineOptions = {}): Promise<string | null> {
  const b = await readLineBytes(tty, prompt, opts);
  return b === null ? null : new TextDecoder().decode(b);
}

/**
 * A yes/no question (i18n.md §5): `<question> [y/N] ` (` [Y/n] ` when the default is
 * yes). Empty → the default; not understood → `Please answer y or n.` and again; after
 * 3 → `not confirmed` (code "not-confirmed"). End of input → `EOF` (code "eof"; callers
 * that treat it as "no" check hasCode(e, "eof")).
 */
export async function askYesNo(tty: Tty, question: string, defaultYes: boolean, opts: LineOptions & { tries?: number } = {}): Promise<boolean> {
  const tries = opts.tries ?? ATTEMPTS;
  for (let i = 0; i < tries; i++) {
    const line = await readLine(tty, question + yesNoHint(defaultYes), opts);
    if (line === null) throw eofError();
    if (goTrimSpace(line) === "") return defaultYes;
    const v = parseYesNo(line);
    if (v !== undefined) return v;
    tty.say(T("Please answer y or n."));
  }
  throw notConfirmedError();
}

/**
 * A typed phrase (`Type PRINT RECOVERY KEY to confirm: `): the answer, trimmed, must be
 * the phrase exactly. Else `not confirmed: you didn't type <PHRASE>`, or `not confirmed:
 * no answer` on end of input (code "not-confirmed"). One try.
 */
export async function confirmPhrase(tty: Tty, phrase: string, opts: LineOptions = {}): Promise<void> {
  const line = await readLine(tty, T("Type %s to confirm: ", phrase), opts);
  if (line === null) throw codedError("not-confirmed", "not confirmed: no answer");
  if (goTrimSpace(line) !== phrase) throw codedError("not-confirmed", "not confirmed: you didn't type %s", phrase);
}

const GO_SPACE_CLASS = "[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const GO_SPACE = new RegExp(`^${GO_SPACE_CLASS}+|${GO_SPACE_CLASS}+$`, "g");

/** Go's strings.TrimSpace (Unicode white space; unlike String.trim, U+0085 yes and U+FEFF no). */
export function goTrimSpace(s: string): string {
  return s.replace(GO_SPACE, "");
}

