// `passh export` (spec §7.1, cli.md §2.23, import-export.md §2.1, §2.7): the order of
// checks, the plaintext confirmation, `--age`, writing to stdout or a new file, and the
// lines on stderr afterwards.

import { constants as C, lstatSync, openSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { encryptArmored, parseExportRecipient, type Recipient } from "../age/index.ts";
import { expandPath, tildePath, type Env } from "../config/paths.ts";
import { closeFd, closeQuiet, fsyncDir, fsyncFd, isTmpfs, osError, toErrno, writeAll } from "../fsx/index.ts";
import { errorf, T, TN } from "../i18n/index.ts";
import { nowTime } from "../model/time.ts";
import type { Time } from "../model/types.ts";
import { normalizeTag, parseFolder } from "../paths/index.ts";
import { escapeLine } from "../sanitize/index.ts";
import { confirmPhrase, openTty } from "../tty/index.ts";
import type { CommandIO } from "../util/io.ts";
import type { OpenedVault } from "../vault/types.ts";
import { UsageError } from "../errors.ts";
import { customFieldCount, formatExport, isExportFormat, selectEntries, type ExportFormat } from "./format.ts";

/** The typed phrase of a plaintext export (never translated). */
export const EXPORT_PHRASE = "EXPORT PLAINTEXT";

/** What the plaintext confirmation needs from /dev/tty (§2.1 check 8). */
export interface ExportTerminal {
  /** Writes a message line on /dev/tty (escaped). */
  say(text: string): void;
  /** `Type <phrase> to confirm: `; throws `not confirmed: …` (code "not-confirmed"). */
  confirmPhrase(phrase: string): Promise<void>;
  close(): void;
}

/** The real /dev/tty, or null when there is none ("no terminal", agent-session.md §A4). */
export function openExportTerminal(): ExportTerminal | null {
  const tty = openTty();
  if (!tty) return null;
  return {
    say: (text) => tty.say(text),
    confirmPhrase: (phrase) => confirmPhrase(tty, phrase),
    close: () => tty.close(),
  };
}

export interface ExportOptions {
  /** `--format`; undefined or "" is "no --format". */
  format?: string;
  /** `--tag` values as the CLI's *strings* flag parsed them (each a tag; "" fails). */
  tags?: readonly string[];
  /** `--folder`; undefined or "" is no folder filter. */
  folder?: string;
  /** `-o`/`--output`; undefined or "" is stdout. */
  output?: string;
  /**
   * `--age`; undefined when the flag wasn't given. A given empty value is an error (the
   * proposed fix of audit #4) unless `quirks`, where it means plaintext as in passh v0.6.
   * (A CLI may also pass undefined for "" to get v0.6's behaviour.)
   */
  age?: string;
  confirmPlaintext?: boolean;
  spreadsheetSafe?: boolean;
  io: CommandIO;
  /** Unlocks the vault (§5.1), called after every other check (§2.1 check 9). Closed by runExport. */
  openVault: () => Promise<OpenedVault>;
  /** Opens /dev/tty for the confirmation (default openExportTerminal); null = no terminal. */
  terminal?: () => ExportTerminal | null;
  /** Environment for `~` in `-o` and the `~/` form of messages (default process.env). */
  env?: Env;
  /** Current folder for a relative `-o` (default: the process's). */
  cwd?: string;
  /** The export time (default now). */
  now?: () => Time;
  /** Reproduce passh v0.6's known issues #4, #6 and #39 instead of the proposed fixes. */
  quirks?: boolean;
}

export interface ExportResult {
  format: ExportFormat;
  /** The number of entries written. */
  count: number;
  /** Absolute path of the file written, or undefined for stdout. */
  file?: string;
  encrypted: boolean;
}

/**
 * Runs `passh export` (§2.1): checks in the spec's order (each failure ends the command:
 * UsageError for exit 2, other errors exit 1), unlocks the vault, builds the data in memory,
 * encrypts it with `--age`, writes it in one write, then prints the tmpfs warning, the
 * `exported …` note and the CSV warning on stderr.
 */
export async function runExport(o: ExportOptions): Promise<ExportResult> {
  const env = o.env ?? process.env;
  const io = o.io;
  // 1, 2. --format
  // SPEC-GAP: §2.1: `--format ""` is "no --format" and `--folder ""` no folder filter, as on
  // the reference; a folder that holds nothing exports 0 entries (no `no such folder`).
  const format = o.format ?? "";
  if (format === "") throw new UsageError("--format is required: csv, json or bitwarden-json");
  if (!isExportFormat(format)) throw new UsageError("unknown export format %q (use csv, json or bitwarden-json)", format);
  // 3. --folder, then --tag
  const folder = o.folder === undefined || o.folder === "" ? "" : parseFolder(o.folder);
  const tags = (o.tags ?? []).map((t) => normalizeTag(t));
  // 4. --age with --confirm-plaintext
  // SPEC-GAP: audit #4: by default a given empty --age is an error (the proposed fix:
  // `--age: the recipient is empty …`); with `quirks` it means plaintext, as in passh v0.6.
  const ageGiven = o.age !== undefined && !(o.quirks && o.age === "");
  if (ageGiven && o.confirmPlaintext) throw new UsageError("--age and --confirm-plaintext can't be used together");
  // 5. --spreadsheet-safe
  if (o.spreadsheetSafe && format !== "csv") throw new UsageError("--spreadsheet-safe applies only to --format csv");
  // 6. the recipient
  let recipient: Recipient | undefined;
  if (ageGiven) recipient = parseExportRecipient(o.age!);
  // 7. the destination
  let file: string | undefined;
  if (o.output !== undefined && o.output !== "") {
    file = expandPath(o.output, { env, cwd: o.cwd });
    if (exists(file)) throw errorf("%s already exists; passh doesn't overwrite files", displayFile(file, env));
  } else if (io.stdoutIsTerminal()) {
    throw errorf("refusing to write export data to a terminal: add -o file or redirect stdout");
  }
  // 8. the plaintext confirmation
  if (!recipient) {
    const term = (o.terminal ?? openExportTerminal)();
    if (!term) {
      if (!o.confirmPlaintext) throw errorf("a plaintext export needs confirmation: without a terminal, add --confirm-plaintext (or encrypt it with --age <recipient>)");
    } else {
      try {
        term.say(T("This writes your passwords unencrypted."));
        await term.confirmPhrase(EXPORT_PHRASE);
      } finally {
        term.close();
      }
    }
  }
  // 9. the vault key
  const vault = await o.openVault();
  let bytes: Uint8Array;
  let count: number;
  let fields: number;
  try {
    // 10. build in memory, encrypt, write
    const entries = selectEntries(vault.data, { folder, tags });
    count = entries.length;
    fields = customFieldCount(entries);
    const exportedAt = (o.now ?? nowTime)();
    bytes = formatExport(format, vault.data, entries, { exportedAt, spreadsheetSafe: o.spreadsheetSafe, quirks: o.quirks });
  } finally {
    vault.close();
  }
  if (recipient) bytes = encryptArmored(bytes, recipient);
  if (file !== undefined) writeExportFile(file, bytes, env);
  else io.stdout(bytes);

  // stderr, in this order
  const dest = file !== undefined ? displayFile(file, env) : "stdout";
  if (file !== undefined && !recipient && !onTmpfs(dirname(file))) {
    io.warn(T("%s isn't on tmpfs: the plaintext is on persistent disk. Delete it when you're done", dest));
  }
  if (recipient) io.note(TN(count, "exported %d entry (%s, encrypted with age) to %s", "exported %d entries (%s, encrypted with age) to %s", count, format, dest));
  else io.note(TN(count, "exported %d entry (%s, plaintext) to %s", "exported %d entries (%s, plaintext) to %s", count, format, dest));
  if (format === "csv" && fields > 0) {
    io.warn(
      TN(
        fields,
        "CSV has no column for custom fields: %d field was left out (otp fields included); use --format json or bitwarden-json to keep them",
        "CSV has no column for custom fields: %d fields were left out (otp fields included); use --format json or bitwarden-json to keep them",
        fields,
      ),
    );
  }
  return { format, count, file, encrypted: !!recipient };
}

/** Lstat: a dangling symlink exists too (§2.1 check 7). */
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    // SPEC-GAP: §2.1 check 7 names only "exists"; any other lstat error (EACCES, ENOTDIR) lets
    // the command go on, and creating the file reports it (`open <abs>: …`).
    return false;
  }
}

/** A file path in messages: `~/`-contracted and escaped (cli.md notation `<file>`). */
function displayFile(abs: string, env: Env): string {
  return escapeLine(tildePath(abs, env));
}

// SPEC-GAP: §2.1: a folder whose file system can't be checked (statfs fails) counts as
// persistent: the warning is printed.
/** tmpfs or ramfs (§2.1); a folder that can't be checked counts as persistent. */
function onTmpfs(dir: string): boolean {
  try {
    return isTmpfs(dir);
  } catch {
    return false;
  }
}

/**
 * Creates `-o` with O_CREAT|O_EXCL (never through a symlink, never overwriting) and mode
 * 0600, writes the data in one write, fsyncs it, then fsyncs the folder on a best-effort
 * basis (§2.1). A failed write removes the partial file: `…; the partial file was removed`,
 * or `…; the partial file <p> could not be removed (<err>): delete it`.
 */
export function writeExportFile(path: string, data: Uint8Array, env: Env = process.env): void {
  let fd: number;
  try {
    fd = openSync(path, C.O_WRONLY | C.O_CREAT | C.O_EXCL, 0o600);
  } catch (e) {
    throw osError("open", path, e);
  }
  try {
    writeAll(fd, data, path);
    fsyncFd(fd, path);
  } catch (e) {
    closeQuiet(fd);
    throw partialFileError(e, path, env);
  }
  try {
    closeFd(fd, path);
  } catch (e) {
    throw partialFileError(e, path, env);
  }
  try {
    fsyncDir(dirname(path));
  } catch {
    /* best effort */
  }
}

// SPEC-GAP: §2.1 check 10: `…` is the write error (`write <abs>: …`, `sync <abs>: …`) and
// ‹p› is written in the `~/` form like ‹dest›; not observable on the reference.
function partialFileError(err: unknown, path: string, env: Env): Error {
  try {
    unlinkSync(path);
  } catch (re) {
    return errorf("%w; the partial file %s could not be removed (%v): delete it", err, displayFile(path, env), toErrno(re));
  }
  return errorf("%w; the partial file was removed", err);
}
