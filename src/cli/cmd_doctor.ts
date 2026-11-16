// `passh doctor` (cli.md §2.25, spec §6.1, §13.1 item 1): read-only checks of the config, the
// vault file, the state and agent folders, the agent, memory, swap, core dumps, the terminal,
// leftovers of `edit --editor` and the clipboard. It fixes nothing; only the clipboard test
// writes (to the clipboard). The report goes to stdout after every check; exit 1 when a check
// found an `error` (no other message).

import { accessSync, constants as C, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { totalmem } from "node:os";
import { basename, dirname } from "node:path";
import { agentDoctorInfo } from "../agent/index.ts";
import { chooseClipboard, NoClipboardError, type ClipboardMethod } from "../clipboard/index.ts";
import { realPath, stateDir, tildePath, type Config, type Env } from "../config/index.ts";
import { leftoverEditFolders } from "../editor/index.ts";
import { SilentExit } from "../errors.ts";
import { getuid, IS_DARWIN, IS_LINUX } from "../ffi/libc.ts";
import { isErrno, osError, readRegularFile, toErrno } from "../fsx/index.ts";
import { coreDumpLimits } from "../harden/index.ts";
import { hasCode, renderError, T, TC, TN } from "../i18n/index.ts";
import { escapeMultiline } from "../sanitize/index.ts";
import { openTty, type Tty } from "../tty/index.ts";
import { codePointLength, compareUTF8 } from "../util/unicode.ts";
import { formatShortDuration, SEC } from "../util/duration.ts";
import { sha256Hex } from "../vault/util.ts";
import { errVerifyNotRegular, errVerifyTooLarge, MAX_VAULT_FILE_SIZE, parseContainer } from "../vaultfile/index.ts";
import type { RunContext } from "./command.ts";
import { commandConfig, commandIO } from "./open.ts";

export type DoctorLevel = "ok" | "info" | "skip" | "warn" | "error";

/** The levels in the order of the level column's width computation (cli.md §2.25). */
export const DOCTOR_LEVELS: readonly DoctorLevel[] = ["ok", "info", "skip", "warn", "error"];

/** One line of the report: a check's finding. `message` is translated, not escaped. */
export interface Finding {
  level: DoctorLevel;
  /** The check name in English (`config`, `vault mode`, …); translated when printed. */
  check: string;
  message: string;
}

/** What the checks read from the outside world; tests may replace parts of it. */
export interface DoctorEnv {
  env: Env;
  /** /dev/tty, or null for "no terminal" (opened by runDoctor and closed afterwards). */
  tty: Tty | null;
  /** The real uid. */
  uid: number;
  /** Sleeps the clipboard test's wait. */
  sleep: (ms: number) => Promise<void>;
}

/** The unlock's scrypt memory (spec §5.4: 2^18 needs 256 MiB). */
export const UNLOCK_MEMORY = 256n * 1024n * 1024n;

/** The clipboard test string (cli.md §2.25 row 13). */
export const CLIPBOARD_TEST = "passh clipboard test";

/** The longest wait of the clipboard test (min(clipboard.clear_after, 5 s)). */
const CLIPBOARD_WAIT_MAX = 5n * SEC;

const KiB = 1024n;
const MiB = 1024n * KiB;
const GiB = 1024n * MiB;

/**
 * Sizes as doctor writes them (cli.md §2.25), the same in every language: ≥ 1 GiB `%.1f GiB`
 * (Go's rounding: to nearest, ties to even, on the exact value), ≥ 1 MiB `<n> MiB`, ≥ 1 KiB
 * `<n> KiB` (rounded down), else `<n> bytes` (`1 byte`).
 */
export function formatSize(bytes: bigint): string {
  if (bytes >= GiB) {
    let q = (bytes * 10n) / GiB;
    const r2 = ((bytes * 10n) % GiB) * 2n;
    if (r2 > GiB || (r2 === GiB && q % 2n === 1n)) q += 1n;
    return `${q / 10n}.${q % 10n} GiB`;
  }
  if (bytes >= MiB) return `${bytes / MiB} MiB`;
  if (bytes >= KiB) return `${bytes / KiB} KiB`;
  return bytes === 1n ? "1 byte" : `${bytes} bytes`;
}

/** Permission bits as `0nnn` (Go's `%04o` of the mode's permission bits). */
function modeText(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

/** access(2) for writing and searching a folder; the OS error, or undefined. */
function writableError(dir: string): Error | undefined {
  try {
    accessSync(dir, C.W_OK | C.X_OK);
    return undefined;
  } catch (e) {
    return toErrno(e);
  }
}

// ---------------------------------------------------------------------------
// Rows 1–5: config and vault file

interface VaultState {
  /** The file was read (rows 3–5 and `agent folder` follow; a structure error still counts). */
  read: boolean;
  /** The resolved path (symlinks followed). */
  real?: string;
}

/** Row 1 (`config`): the resolution of cli.md §1.2. Returns the config, or undefined on error. */
function checkConfig(ctx: RunContext, add: (f: Finding) => void, env: Env): Config | undefined {
  let cfg: Config;
  try {
    cfg = commandConfig(ctx);
  } catch (e) {
    add({ level: "error", check: "config", message: renderError(e) });
    return undefined;
  }
  if (cfg.file !== undefined) {
    add({ level: "ok", check: "config", message: tildePath(cfg.file, env) });
    if (cfg.vaultFromFlag) add({ level: "info", check: "config", message: T("--vault overrides the config's vault") });
  } else {
    // SPEC-GAP: cli.md §2.25 row 1: when the config's location can't be computed ($HOME unset)
    // and --vault is given, `<file>` is empty, as on the reference ("no config file at ; …").
    const where = cfg.location ? tildePath(cfg.location.path, env) : "";
    add({ level: "info", check: "config", message: T("no config file at %s; using --vault and the defaults", where) });
  }
  return cfg;
}

/** Rows 2–5 (`vault`, `vault mode`, `vault folder`, `temp files`). */
function checkVault(cfg: Config | undefined, add: (f: Finding) => void, env: Env): VaultState {
  const vault = (level: DoctorLevel, message: string) => add({ level, check: "vault", message });
  if (!cfg) {
    vault("skip", T("no config, so no vault to check"));
    return { read: false };
  }
  const file = cfg.vault;
  const shown = tildePath(file, env);
  // lstat: missing, another error, or a symlink to resolve.
  let isLink: boolean;
  try {
    isLink = lstatSync(file).isSymbolicLink();
  } catch (e) {
    if (isErrno(e, "ENOENT")) vault("error", T("%s doesn't exist: run `passh init`, or point the config's vault at your vault file", shown));
    else vault("error", T("%s: %v", shown, osError("lstat", file, e)));
    return { read: false };
  }
  // The real path: saves write the target, and its folder holds the temporary files.
  let real: string;
  try {
    real = realPath(file, { env });
  } catch (e) {
    if (isLink) vault("error", T("%s is a symlink that can't be resolved: %v", shown, e));
    // SPEC-GAP: a path that isn't a symlink itself but can't be resolved (a folder replaced
    // meanwhile) is reported like a read error.
    else vault("error", T("%s: %v", shown, e));
    return { read: false };
  }
  if (isLink) vault("info", T("%s is a symlink to %s; saves write the target", shown, tildePath(real, env)));
  // Read: a regular file of at most 64 MiB (symlinks followed), as `verify`.
  let bytes: Uint8Array;
  try {
    bytes = readRegularFile(file, MAX_VAULT_FILE_SIZE);
  } catch (e) {
    let err: unknown = e;
    if (hasCode(e, "not-regular")) err = errVerifyNotRegular(shown);
    else if (hasCode(e, "too-large")) err = errVerifyTooLarge(shown);
    vault("error", T("%s: %v", shown, err));
    return { read: false };
  }
  // Structure, as `verify` (no key).
  try {
    const c = parseContainer(bytes);
    vault("ok", T("%s: structure OK, %d bytes", shown, bytes.length));
    for (const w of c.warnings) vault("info", w.localize());
    if (!c.canonical) vault("info", T("not in canonical form (line endings or wrapping changed); it opens, and the next save rewrites it"));
  } catch (e) {
    vault("error", T("%s: %v (SHA-256 %s)", shown, e, sha256Hex(bytes)));
  }
  // 3. vault mode: the file's permission bits (followed).
  try {
    const perm = statSync(file).mode & 0o777;
    if (perm === 0o600) add({ level: "ok", check: "vault mode", message: "0600" });
    else add({ level: perm & 0o077 ? "warn" : "info", check: "vault mode", message: T("mode %s, not 0600: fix it with chmod 600 %s", modeText(perm), shown) });
  } catch {
    // SPEC-GAP: the file vanished between the read and this stat: no `vault mode` row.
  }
  // 4. vault folder: the resolved path's folder must take a temporary file.
  const dir = dirname(real);
  const shownDir = tildePath(dir, env);
  const werr = writableError(dir);
  if (werr) add({ level: "error", check: "vault folder", message: T("%s isn't writable (%v): saving needs a temporary file there", shownDir, werr) });
  else add({ level: "ok", check: "vault folder", message: T("%s is writable", shownDir) });
  // 5. temp files: `.<name>.tmp-*` regular files left by an interrupted save (storage.md §1.4).
  add(tempFiles(dir, basename(real)));
  return { read: true, real };
}

/** Row 5: the leftover temporary files of the vault, by name in byte order. */
function tempFiles(dir: string, name: string): Finding {
  const prefix = `.${name}.tmp-`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    // The reference names the folder with a trailing slash (`open /home/a/v/: permission denied`).
    const shown = dir.endsWith("/") ? dir : dir + "/";
    return { level: "warn", check: "temp files", message: T("can't list the vault's folder: %v", osError("open", shown, e)) };
  }
  const left: string[] = [];
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    try {
      if (lstatSync(dir + "/" + n).isFile()) left.push(n);
    } catch {
      /* vanished */
    }
  }
  if (left.length === 0) return { level: "ok", check: "temp files", message: T("none") };
  left.sort(compareUTF8);
  return {
    level: "warn",
    check: "temp files",
    message: TN(left.length, "%d file left by an interrupted save (%s); the next save removes them", "%d files left by an interrupted save (%s); the next save removes them", left.length, left.join(", ")),
  };
}

// ---------------------------------------------------------------------------
// Rows 6–7: state folder, agent

/** Row 6 (`state folder`): `$XDG_STATE_HOME/passh` (lstat), never created. */
function checkStateFolder(env: Env, uid: number): Finding {
  const f = (level: DoctorLevel, message: string): Finding => ({ level, check: "state folder", message });
  let dir: string;
  try {
    dir = stateDir(env);
  } catch (e) {
    return f("error", renderError(e));
  }
  const shown = tildePath(dir, env);
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    if (isErrno(e, "ENOENT")) return f("info", T("%s doesn't exist yet; the first save creates it", shown));
    return f("error", T("%s: %v", shown, osError("lstat", dir, e)));
  }
  if (!st.isDirectory()) return f("error", T("%s is not a folder (backups, locks and the agent's socket go there)", shown));
  if (st.uid !== uid) return f("error", T("%s belongs to uid %d, not to you", shown, st.uid));
  const werr = writableError(dir);
  if (werr) return f("error", T("%s isn't writable: %v", shown, werr));
  if (st.mode & 0o077) return f("warn", T("%s has mode %s: other users can look inside (the backups are encrypted); chmod 700 is better", shown, modeText(st.mode)));
  return f("ok", shown);
}

/** Row 7 (`agent folder`, `agent`): read-only; a status request doesn't restart the idle time. */
async function checkAgent(vault: VaultState, env: Env, uid: number): Promise<Finding[]> {
  if (!vault.read || vault.real === undefined) return [{ level: "skip", check: "agent", message: T("no vault to check the agent for") }];
  const info = await agentDoctorInfo(vault.real, { env, uid });
  const out: Finding[] = [{ level: info.folder.level, check: "agent folder", message: info.folder.message }];
  if (info.agent) out.push({ level: info.agent.level, check: "agent", message: info.agent.message });
  return out;
}

// ---------------------------------------------------------------------------
// Rows 8–10: memory, swap, core dumps

/** `MemAvailable` of /proc/meminfo in bytes. */
export function memAvailable(meminfo: string): bigint | undefined {
  const m = /^MemAvailable:\s+(\d+)\s*kB\s*$/m.exec(meminfo);
  return m ? BigInt(m[1]!) * 1024n : undefined;
}

/** Row 8 (`memory`): enough for unlock's scrypt (256 MiB)? Linux: MemAvailable; macOS: total. */
function checkMemory(): Finding {
  const f = (level: DoctorLevel, message: string): Finding => ({ level, check: "memory", message });
  if (IS_LINUX) {
    let avail: bigint | undefined;
    try {
      avail = memAvailable(readFileSync("/proc/meminfo", "utf8"));
    } catch (e) {
      return f("skip", T("can't read the available memory: %v", osError("open", "/proc/meminfo", e)));
    }
    // SPEC-GAP: cli.md §2.25 row 8 gives no text for a /proc/meminfo without MemAvailable.
    if (avail === undefined) return f("skip", T("can't read the available memory: %v", T("no MemAvailable line in /proc/meminfo")));
    if (avail < UNLOCK_MEMORY) return f("warn", T("%s available: unlock needs 256 MiB for scrypt and may fail or swap", formatSize(avail)));
    return f("ok", T("%s available (unlock needs 256 MiB)", formatSize(avail)));
  }
  if (IS_DARWIN) {
    let total: bigint;
    try {
      total = BigInt(totalmem()); // hw.memsize
    } catch (e) {
      return f("skip", T("can't read the memory size: %v", e));
    }
    if (total < UNLOCK_MEMORY) return f("warn", T("%s in total: unlock needs 256 MiB for scrypt and may fail or swap; available memory isn't checked on macOS", formatSize(total)));
    return f("ok", T("%s in total (unlock needs 256 MiB); available memory isn't checked on macOS", formatSize(total)));
  }
  return f("skip", T("not checked on this system"));
}

/** The active swap areas of /proc/swaps: their number and total size in bytes. */
export function parseSwaps(text: string): { count: number; bytes: bigint } {
  let count = 0;
  let bytes = 0n;
  const lines = text.split("\n").slice(1);
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || fields[0] === "") continue;
    count++;
    // SPEC-GAP: a size that isn't a number counts the area with size 0.
    if (/^\d+$/.test(fields[2]!)) bytes += BigInt(fields[2]!) * 1024n;
  }
  return { count, bytes };
}

/** Row 9 (`swap`): Linux /proc/swaps; macOS vm.swapusage. */
function checkSwap(): Finding {
  const f = (level: DoctorLevel, message: string): Finding => ({ level, check: "swap", message });
  if (IS_LINUX) {
    let text: string;
    try {
      text = readFileSync("/proc/swaps", "utf8");
    } catch (e) {
      return f("skip", T("can't read /proc/swaps: %v", osError("open", "/proc/swaps", e)));
    }
    const { count, bytes } = parseSwaps(text);
    if (count === 0) return f("ok", T("no swap is active"));
    return f(
      "warn",
      TN(
        count,
        "%d swap area is active (%s): process memory, decrypted secrets included, may be written to disk. passh doesn't change this; turn swap off or encrypt it if that matters to you",
        "%d swap areas are active (%s): process memory, decrypted secrets included, may be written to disk. passh doesn't change this; turn swap off or encrypt it if that matters to you",
        count,
        formatSize(bytes),
      ),
    );
  }
  if (IS_DARWIN) {
    const u = darwinSwapUsage();
    if (u instanceof Error) return f("skip", T("can't read vm.swapusage: %v", u));
    // SPEC-GAP: "in use" is read as used > 0 (a swap file may exist with nothing in it).
    if (u.used === 0n) return f("ok", T("no swap is in use"));
    if (u.encrypted) return f("info", T("swap is active (%s used) and encrypted by macOS", formatSize(u.used)));
    return f("warn", T("swap is active (%s used) and not encrypted: process memory, decrypted secrets included, may be written to disk", formatSize(u.used)));
  }
  return f("skip", T("not checked on this system"));
}

/**
 * macOS `vm.swapusage` (struct xsw_usage: u64 total, avail, used; u32 pagesize; boolean_t
 * encrypted) through sysctlbyname(3). Written from the headers; untested here (Linux).
 */
function darwinSwapUsage(): { used: bigint; encrypted: boolean } | Error {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const lib = ffi.dlopen("/usr/lib/libSystem.B.dylib", {
      sysctlbyname: { args: [ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.u64], returns: ffi.FFIType.i32 },
      __error: { args: [], returns: ffi.FFIType.ptr },
    });
    try {
      const name = Buffer.from("vm.swapusage\0", "latin1");
      const buf = new Uint8Array(32);
      const len = new BigUint64Array([32n]);
      const r = lib.symbols.sysctlbyname(ffi.ptr(name), ffi.ptr(buf), ffi.ptr(len), null, 0n);
      if (r !== 0) {
        const p = lib.symbols.__error();
        const n = p ? ffi.read.i32(p, 0) : 0;
        return toErrno(n);
      }
      const dv = new DataView(buf.buffer);
      return { used: dv.getBigUint64(16, true), encrypted: dv.getInt32(28, true) !== 0 };
    } finally {
      lib.close();
    }
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/** Row 10 (`core dumps`): RLIMIT_CORE of this process (S7; the agent sets it again itself). */
function checkCoreDumps(): Finding {
  const f = (level: DoctorLevel, message: string): Finding => ({ level, check: "core dumps", message });
  const lim = coreDumpLimits();
  if (lim instanceof Error) return f("warn", T("reading core dump limit: %v", lim));
  // SPEC-GAP: cli.md §2.25 row 10 doesn't say which limit counts: the soft limit decides
  // whether a crash writes a core file.
  if (lim.soft === 0n) return f("ok", T("disabled for passh and the agent"));
  return f("warn", T("not disabled: a crash could write secrets to a core file"));
}

// ---------------------------------------------------------------------------
// Rows 11–13: terminal, edit temp, clipboard

function checkTerminal(tty: Tty | null): Finding {
  if (tty) return { level: "ok", check: "terminal", message: T("/dev/tty: passphrase prompts work") };
  return { level: "info", check: "terminal", message: T("none: prompts are impossible, so commands need the agent (`passh unlock` in a terminal)") };
}

/** Row 12 (`edit temp`): the user's `passh-edit-*` folders in both bases (agent-session.md §A6). */
function checkEditTemp(env: Env): Finding {
  const dirs = leftoverEditFolders(env);
  if (dirs.length === 0) return { level: "ok", check: "edit temp", message: T("no files left by an interrupted `edit --editor`") };
  return {
    level: "warn",
    check: "edit temp",
    message: T("left by an interrupted `edit --editor`, possibly with an entry in plain text: %s; delete them (rm -r)", dirs.map((d) => tildePath(d, env)).join(", ")),
  };
}

/**
 * Row 13 (`clipboard`): with a config and a terminal, the notes for tmux, GNU screen and
 * Terminal.app, then the method (agent-session.md §A5); `Testing the clipboard: …` on
 * /dev/tty, the test string copied, a wait of min(clipboard.clear_after, 5 s), the clear.
 *
 * Audit #16 (without a terminal `clipboard.command` isn't tested either): current behaviour
 * kept, as cli.md §2.25 row 13 states it.
 */
async function checkClipboard(cfg: Config | undefined, d: DoctorEnv): Promise<Finding[]> {
  const out: Finding[] = [];
  const f = (level: DoctorLevel, message: string) => out.push({ level, check: "clipboard", message });
  if (!cfg) {
    f("skip", T("no config, so no clipboard settings to check"));
    return out;
  }
  const tty = d.tty;
  if (!tty) {
    f("skip", T("not tested without a terminal: run `passh doctor` in one (over SSH: ssh -t)"));
    return out;
  }
  if (d.env.TMUX) f("info", T("inside tmux: OSC 52 needs `set -g set-clipboard on` in ~/.tmux.conf"));
  if (d.env.STY) f("info", T("inside GNU screen: screen doesn't pass OSC 52 to the terminal; set clipboard.command or run passh outside screen"));
  if (d.env.TERM_PROGRAM === "Apple_Terminal") f("info", T('Terminal.app has no OSC 52: set clipboard.command = ["pbcopy"]'));
  let method: ClipboardMethod;
  try {
    method = chooseClipboard(cfg.clipboard, tty);
  } catch (e) {
    if (e instanceof NoClipboardError) f("warn", T("no clipboard: %v; copy with: passh show <path> --field password | pbcopy", e.reason));
    else f("error", renderError(e));
    return out;
  }
  const waitNs = cfg.clipboard.clearAfter < CLIPBOARD_WAIT_MAX ? cfg.clipboard.clearAfter : CLIPBOARD_WAIT_MAX;
  const waitMs = Number(waitNs / 1_000_000n);
  tty.say(T('Testing the clipboard: copied "passh clipboard test" (%s). Paste it somewhere to check; it is cleared in %s.', method, formatShortDuration(waitMs)));
  try {
    await method.set(new TextEncoder().encode(CLIPBOARD_TEST));
  } catch (e) {
    f("error", renderError(e));
    return out;
  }
  await d.sleep(waitMs);
  try {
    await method.set(new Uint8Array(0));
  } catch (e) {
    f("error", T("clearing the clipboard failed: %v", e));
    return out;
  }
  f("ok", T('sent a test string with %s and cleared it; if pasting gave "passh clipboard test", copying works', method));
  return out;
}

// ---------------------------------------------------------------------------
// The report

/**
 * The report (cli.md §2.25): level, two spaces, check name, two spaces, message; the level
 * column as wide as the longest level name of the language, the check column as wide as the
 * longest check name present (code points); each message escaped as a whole (S4 multi-line);
 * then `<n> errors, <m> warnings.`.
 */
export function formatReport(findings: readonly Finding[]): string {
  const levelName = (l: DoctorLevel) => TC("doctor", l);
  const checkName = (c: string) => TC("doctor", c);
  const levelWidth = Math.max(...DOCTOR_LEVELS.map((l) => codePointLength(levelName(l))));
  const checkWidth = Math.max(0, ...findings.map((x) => codePointLength(checkName(x.check))));
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - codePointLength(s)));
  let out = "";
  for (const x of findings) out += pad(levelName(x.level), levelWidth) + "  " + pad(checkName(x.check), checkWidth) + "  " + escapeMultiline(x.message) + "\n";
  const errors = findings.filter((x) => x.level === "error").length;
  const warnings = findings.filter((x) => x.level === "warn").length;
  out += T("%s, %s.", TN(errors, "%d error", "%d errors", errors), TN(warnings, "%d warning", "%d warnings", warnings)) + "\n";
  return out;
}

/** Runs every check in the order of cli.md §2.25 and returns the findings. */
export async function doctorFindings(ctx: RunContext, d: DoctorEnv): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  const cfg = checkConfig(ctx, add, d.env);
  const vault = checkVault(cfg, add, d.env);
  add(checkStateFolder(d.env, d.uid));
  for (const f of await checkAgent(vault, d.env, d.uid)) add(f);
  add(checkMemory());
  add(checkSwap());
  add(checkCoreDumps());
  add(checkTerminal(d.tty));
  add(checkEditTemp(d.env));
  for (const f of await checkClipboard(cfg, d)) add(f);
  return findings;
}

/** `passh doctor`: the report on stdout; exit 1 (no message) when a check found an error. */
export async function runDoctor(ctx: RunContext): Promise<void> {
  const tty = openTty();
  let findings: Finding[];
  try {
    findings = await doctorFindings(ctx, { env: process.env, tty, uid: getuid(), sleep: (ms) => Bun.sleep(ms) });
  } finally {
    tty?.close();
  }
  commandIO.stdout(formatReport(findings));
  if (findings.some((f) => f.level === "error")) throw new SilentExit(1);
}
