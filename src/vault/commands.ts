// Command cores that need no key or are storage-shaped (storage.md §5.4, §6; cli.md §2.19–
// §2.21): `passh verify [file] [--full]`, `passh backup <dest>`, `passh backups`. They write
// through a CommandIO and throw errors (exit 1); the CLI only wires them.

import { readSync, statSync, openSync, constants as C } from "node:fs";
import { join } from "node:path";
import { defaultConfig, expandPath, realPath, stateDir, tildePath, type Config, type Env } from "../config/index.ts";
import { cleanLeftovers, closeQuiet, createTempFile, fsyncDir, isErrno, lstatIfExists, osError, readRegularFile, renameNoReplace } from "../fsx/index.ts";
import { errorf, hasCode, T } from "../i18n/index.ts";
import { formatTime } from "../model/index.ts";
import { escapeLine } from "../sanitize/index.ts";
import { askYesNo, type Tty } from "../tty/index.ts";
import type { CommandIO } from "../util/io.ts";
import { encodeContainer, errVerifyNotRegular, errVerifyTooLarge, MAX_VAULT_FILE_SIZE, parseContainer } from "../vaultfile/index.ts";
import { backupLine, listAllBackups, matchingFolders, type BackupFile } from "./backups.ts";
import { errNoVault, errVaultStat, withOpenHint, withPath } from "./errors.ts";
import { openVault } from "./open.ts";
import { utcDate } from "./rollback.ts";
import type { KeySource, RollbackReport } from "./types.ts";
import { baseName, backupFileStamp, basename, dirname, isShapeError, readVaultBytes, sha256Hex } from "./util.ts";

// ---------------------------------------------------------------------------
// Shared

/**
 * The vault file must exist (storage.md §2.6, cli.md §1.2): ENOENT → ``no vault at <~path>: run
 * `passh init` to create one, or pass --vault <file>`` (code "no-vault"); another `stat` error →
 * `vault <~path>: <OS error>`.
 */
export function checkVaultExists(path: string, env: Env = process.env): void {
  try {
    statSync(path);
  } catch (e) {
    if (isErrno(e, "ENOENT")) throw errNoVault(tildePath(path, env));
    throw errVaultStat(tildePath(path, env), osError("stat", path, e));
  }
}

/**
 * The rollback question on /dev/tty (storage.md §7.4, cli.md §1.5): `warning: <text>`, then
 * `Continue with this copy? [y/N] `; true for yes. Prompt errors (EOF, interrupted, three
 * unclear answers) are thrown. Undefined without a terminal (then openVault warns and goes on).
 */
export function ttyConfirmOlder(tty: Tty | null | undefined): ((text: string) => Promise<boolean>) | undefined {
  if (!tty) return undefined;
  return async (text: string) => {
    tty.say(T("warning: ") + text);
    return askYesNo(tty, T("Continue with this copy?"), false);
  };
}

/** The three structure lines of `verify` and `backup` (cli.md §2.19). */
function structureLines(tilde: string, ok: boolean, hash: string, size: number): string {
  return `${escapeLine(tilde)}: ${ok ? "OK" : "FAILED"}\n  SHA-256   ${hash}\n  size      ${size} bytes\n`;
}

/** `YYYY-MM-DD HH:MM:SS UTC`. */
function savedAtDisplay(t: number): string {
  const s = formatTime(t);
  return `${s.slice(0, 10)} ${s.slice(11, 19)} UTC`;
}

/** The `rollback` value of `verify --full` (cli.md §2.19, translated). */
export function rollbackReportText(r: RollbackReport): string {
  switch (r.kind) {
    case "unseen":
      return T("this machine hasn't seen this vault before");
    case "same":
      return T("OK: the newest revision seen on this machine (r%d)", r.seen);
    case "newer":
      return T("OK: newer than seen before on this machine (r%d)", r.seen);
    case "older":
      return T("OLDER than seen before on this machine (seen r%d of %s)", r.seen, utcDate(r.seenSavedAt));
  }
}

// ---------------------------------------------------------------------------
// verify (storage.md §6.2, cli.md §2.19)

export interface VerifyOptions {
  /** The `[file]` argument as typed (expanded here as in storage.md §2.1); undefined: the config's vault. */
  file?: string;
  /** The loaded config; undefined when there is none (a `[file]` needs none): the defaults. */
  config?: Config;
  full: boolean;
  io: CommandIO;
  /**
   * `--full`: the agent key source of a vault file (src/agent's factory): asked for the file
   * itself, then for the config's vault if that is another existing file (agent-session.md
   * §A2.8). The source must use the agent of `vaultPath`, whatever file is being opened.
   */
  agentSource?: (vaultPath: string) => KeySource;
  /** `--full`: the passphrase source (passphraseKeySource(openTty())), tried after the agents. */
  passphrase?: KeySource;
  /** `--full`: replaces the sources above entirely (tests). */
  sources?: KeySource[];
  env?: Env;
}

/**
 * `passh verify [file] [--full]` (storage.md §6.2): stdout `<~path>: OK|FAILED`, `  SHA-256
 * …`, `  size      <n> bytes`; notes on stderr after an OK (`passh: note: <ignored text>`, the
 * canonical-form note); FAILED throws `<~path>: <problem>`. A file that can't be read prints
 * nothing on stdout and throws (`<~path> is not a regular file`, `<~path> is larger than 64 MiB:
 * not a passh vault`, the OS error, or `no vault at …` without `[file]`). `--full` opens the file
 * (rollback report-only) and adds `vault_id`, `revision`, `saved_at`, `entries`, `rollback`; an
 * older copy also warns (audit #35: current behaviour kept, also with rollback.warn = false).
 * Open errors are thrown with the CLI's hint line (withOpenHint).
 */
export async function runVerify(o: VerifyOptions): Promise<void> {
  const env = o.env ?? process.env;
  const config = o.config ?? defaultConfig();
  let target: string;
  if (o.file !== undefined) {
    target = expandPath(o.file, { env });
  } else {
    target = config.vault;
    checkVaultExists(target, env);
  }
  const tilde = tildePath(target, env);
  let bytes: Uint8Array;
  try {
    bytes = readRegularFile(target, MAX_VAULT_FILE_SIZE);
  } catch (e) {
    if (hasCode(e, "not-regular")) throw errVerifyNotRegular(tilde);
    if (hasCode(e, "too-large")) throw errVerifyTooLarge(tilde);
    throw e;
  }
  const hash = sha256Hex(bytes);
  let container;
  try {
    container = parseContainer(bytes);
  } catch (e) {
    o.io.stdout(structureLines(tilde, false, hash, bytes.length));
    throw withPath(tilde, e);
  }
  o.io.stdout(structureLines(tilde, true, hash, bytes.length));
  for (const w of container.warnings) o.io.note(T("note: %s", w));
  if (!container.canonical) {
    o.io.note(T("note: the file isn't in passh's canonical form (line endings or line wrapping changed in copying); it opens, and `passh backup` writes a canonical copy"));
  }
  if (!o.full) return;
  // Audit #13: current behaviour kept: the open warns about ignored text again (`passh:
  // warning: <abs>: …`), as the reference does. §14 open question 1: option (a) kept: this
  // open raises the record like any other.
  const sources = o.sources ?? verifySources(o, config, target, env);
  let v;
  try {
    v = await openVault(target, { config, sources, rollback: "report", io: o.io, env });
  } catch (e) {
    throw withOpenHint(e);
  }
  try {
    const d = v.data;
    const r = v.rollback ?? { kind: "unseen" };
    o.io.stdout(
      `  vault_id  ${escapeLine(d.vaultId)}\n` +
        `  revision  ${d.revision}\n` +
        `  saved_at  ${savedAtDisplay(d.savedAt)}\n` +
        `  entries   ${d.entries.length}\n` +
        `  rollback  ${rollbackReportText(r)}\n`,
    );
    if (r.kind === "older") {
      o.io.warnOnce(
        T(
          "this copy is older than one seen before on this machine (r%d of %s; seen r%d of %s). If you didn't restore it on purpose, the file may have been replaced.",
          d.revision,
          utcDate(d.savedAt),
          r.seen,
          utcDate(r.seenSavedAt),
        ),
      );
    }
  } finally {
    v.close();
  }
}

/** The agent of the file, then of the config's vault if that is another existing file, then the passphrase. */
function verifySources(o: VerifyOptions, config: Config, target: string, env: Env): KeySource[] {
  const out: KeySource[] = [];
  if (o.agentSource) {
    out.push(o.agentSource(target));
    if (config.vault !== "" && isOtherExistingFile(config.vault, target, env)) out.push(o.agentSource(config.vault));
  }
  if (o.passphrase) out.push(o.passphrase);
  return out;
}

function isOtherExistingFile(a: string, b: string, env: Env): boolean {
  try {
    if (!statSync(a).isFile()) return false;
    return realPath(a, { env }) !== realPath(b, { env });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// backup (storage.md §6.1, cli.md §2.20)

export interface BackupOptions {
  /** The vault: the config's (or `--vault`), absolute. The CLI checks it exists first. */
  source: string;
  /** `<dest>` as typed. */
  dest: string;
  io: CommandIO;
  env?: Env;
}

/** Reads at most `limit` bytes of a file (the read-back of `passh backup`: size + 1). */
function readAtMost(path: string, limit: number): Uint8Array {
  let fd: number;
  try {
    fd = openSync(path, C.O_RDONLY);
  } catch (e) {
    throw osError("open", path, e);
  }
  try {
    const buf = new Uint8Array(limit);
    let off = 0;
    while (off < limit) {
      let n: number;
      try {
        n = readSync(fd, buf, off, limit - off, null);
      } catch (e) {
        if (isErrno(e, "EINTR", "EAGAIN")) continue;
        throw osError("read", path, e);
      }
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeQuiet(fd);
  }
}

/**
 * `passh backup <dest>` (storage.md §6.1): the destination (a folder → `<name>-<YYYYMMDD-
 * HHMMSS>.passh` inside it; `…/` that isn't a folder → `<~path>: no such folder`); read and
 * check the source without a key (`<path> doesn't pass the structure check, so it isn't copied:
 * …`), a non-canonical source re-encoded; never overwrite (`<dest>: a file already exists there;
 * passh doesn't overwrite files`); temporary file next to it, read back, rename-no-replace,
 * folder fsync. Stdout `<~dest>: OK`, SHA-256 and size of the copy; stderr `Backed up <~src> to
 * <~dest>.` and the canonical-form lines.
 */
export async function runBackup(o: BackupOptions): Promise<void> {
  const env = o.env ?? process.env;
  const src = o.source;
  // 1
  const expanded = expandPath(o.dest, { env });
  let isDir = false;
  try {
    isDir = statSync(expanded).isDirectory();
  } catch {
    isDir = false;
  }
  let target: string;
  if (isDir) target = join(expanded, `${baseName(src)}-${backupFileStamp()}.passh`);
  else if (o.dest.endsWith("/")) throw errorf("%s: no such folder", tildePath(expanded, env));
  else target = expanded;
  // 2
  let bytes: Uint8Array;
  try {
    bytes = readVaultBytes(src);
  } catch (e) {
    if (isShapeError(e)) throw withPath(src, e);
    throw e;
  }
  let content: Uint8Array;
  let canonical: boolean;
  try {
    const c = parseContainer(bytes);
    canonical = c.canonical;
    content = c.canonical ? bytes : encodeContainer(c.keyBlock, c.dataBlock);
  } catch (e) {
    throw errorf("%s doesn't pass the structure check, so it isn't copied: %w", src, e);
  }
  const want = sha256Hex(content);
  // 3
  const exists = () => errorf("%s: a file already exists there; passh doesn't overwrite files", target);
  if (lstatIfExists(target)) throw exists();
  // 4
  const dir = dirname(target);
  const name = basename(target);
  try {
    cleanLeftovers(dir, name);
  } catch {
    /* best effort */
  }
  const t = createTempFile(dir, name);
  t.write(content);
  let back: Uint8Array;
  try {
    back = readAtMost(t.path, content.length + 1);
  } catch (e) {
    t.remove();
    throw e;
  }
  const got = sha256Hex(back);
  if (got !== want) {
    t.remove();
    throw errorf("%s (SHA-256 %s, expected %s): the copy didn't read back as written; nothing was written under its name", target, got, want);
  }
  // 5
  try {
    renameNoReplace(t.path, target);
  } catch (e) {
    t.remove();
    if (isErrno(e, "EEXIST")) throw exists();
    throw e;
  }
  t.close();
  try {
    fsyncDir(dir);
  } catch (e) {
    throw errorf("%s is written, but its folder couldn't be synced: %w", target, e);
  }
  const destTilde = tildePath(target, env);
  o.io.status(T("Backed up %s to %s.", tildePath(src, env), destTilde));
  o.io.stdout(structureLines(destTilde, true, got, back.length));
  if (canonical) {
    o.io.status(T("The copy is byte for byte the vault; `passh verify` shows the same SHA-256 for both."));
  } else {
    o.io.status(T("The vault isn't in canonical form, so the copy was written in canonical form;"));
    o.io.status(T("its SHA-256 differs from the vault's, and the stock age tool reads its blocks (§8)."));
  }
}

// ---------------------------------------------------------------------------
// backups (storage.md §5.4, cli.md §2.21)

export interface BackupsOptions {
  config: Config;
  /** The vault (the config's, or `--vault`), absolute; it may be missing. */
  vaultPath: string;
  io: CommandIO;
  env?: Env;
}

/**
 * `passh backups` (storage.md §5.4): the backups whose folder matches the vault's key block,
 * newest first, as `YYYY-MM-DD HH:MM:SS  r<rev>  <~path>`; with no match, the note `note: no
 * backup has this vault's current key block (…); listing every automatic backup on this machine`
 * and every backup grouped by folder; a vault that can't be read: `note: <~path> can't be read
 * (<error>); listing every automatic backup on this machine`; none at all: `No automatic backups
 * yet. passh makes one before each save (backup.keep = <n>).` on stderr. Never fails for the vault.
 */
export async function runBackups(o: BackupsOptions): Promise<void> {
  const env = o.env ?? process.env;
  const state = stateDir(env);
  const tilde = tildePath(o.vaultPath, env);
  let keyBlock: Uint8Array | undefined;
  let readError: unknown;
  try {
    const bytes = readVaultBytes(o.vaultPath);
    try {
      keyBlock = parseContainer(bytes).keyBlock;
    } catch {
      keyBlock = undefined;
    }
  } catch (e) {
    readError = e;
  }
  const folders = listAllBackups(state);
  let list: BackupFile[];
  if (readError !== undefined) {
    o.io.note(T("note: %s can't be read (%v); listing every automatic backup on this machine", tilde, readError));
    list = folders.flatMap((f) => f.backups);
  } else {
    const matched = keyBlock ? matchingFolders(folders, keyBlock) : [];
    if (matched.length > 0) list = matched.flatMap((f) => f.backups);
    else {
      if (folders.length > 0) {
        o.io.note(
          T("note: no backup has this vault's current key block (it was changed by passwd or rekey and not saved since, or the file is damaged); listing every automatic backup on this machine"),
        );
      }
      list = folders.flatMap((f) => f.backups);
    }
  }
  if (list.length === 0) {
    o.io.status(T("No automatic backups yet. passh makes one before each save (backup.keep = %d).", o.config.backup.keep));
    return;
  }
  o.io.stdout(list.map((b) => backupLine(b, escapeLine(tildePath(b.path, env))) + "\n").join(""));
}
