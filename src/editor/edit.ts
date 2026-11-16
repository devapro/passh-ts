// Editing an entry's text form in an external editor (agent-session.md §A6, spec §5.6, S1).
//
//   folder  <base>/passh-edit-<random>, mode 0700 (set explicitly), re-checked on tmpfs
//   file    entry.txt, O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600 (set explicitly)
//   run     stdin, stdout, stderr /dev/tty; environment inherited; terminal state saved
//           before and restored after
//   signals SIGINT, SIGTERM, SIGHUP caught from before the folder exists until it is gone;
//           one kills the editor (SIGKILL) → `editing interrupted by <signal>; nothing was
//           changed`. If the editor fails, wait 200 ms for a signal that may have caused it.
//   result  non-zero exit → `the editor failed (<path>: exit status n); nothing was
//           changed`; > 16 MiB → `the edited file is larger than 16 MiB`; identical text →
//           unchanged; invalid → `The entry isn't valid: <error>` + `Edit it again? [Y/n]`
//           (yes reopens the editor on the user's text; no, or a failed prompt, ends with
//           the validation error)
//   cleanup whatever happens: every regular file in the folder (the edit, any swap or
//           backup file) overwritten with zeros, fsync, then the folder removed; failure →
//           `removing the temporary folder <dir>: …; remove it yourself, it holds the
//           entry in plain text`

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { codedError, errorf, hasCode, joinErrors, T } from "../i18n/index.ts";
import { SignalError } from "../errors.ts";
import { osError } from "../fsx/oserror.ts";
import { exitError, goSignalText, runProcess, type ChildHandle } from "../exec/index.ts";
import { SignalWatch } from "../tty/signals.ts";
import { askYesNo } from "../tty/prompts.ts";
import type { Tty } from "../tty/tty.ts";
import { editorArgv, type EditorChoice } from "./choose.ts";
import { EDIT_DIR_PREFIX, onMemoryFs } from "./tmpfs.ts";

/** Edited file max size (§A1). */
export const EDIT_MAX = 16 * 1024 * 1024;
/** The wait for a signal after a failed editor (§A6). */
const SIGNAL_GRACE_MS = 200;

/** What validate makes of the edited text. */
export type Validation<V> =
  /** Valid. `unchanged`: the entry equals the old one (the CLI says `No change.`). */
  | { ok: true; value: V; unchanged?: boolean }
  | { ok: false; error: unknown };

export type EditOutcome<V> = { kind: "unchanged" } | { kind: "changed"; value: V; text: Uint8Array };

export interface EditOptions<V> {
  tty: Tty;
  editor: EditorChoice;
  /** The base folder (findTmpBase). */
  base: string;
  /** The entry's text form (§4.3). */
  text: Uint8Array;
  /** Parses and checks the edited text (vault-format.md §5.2). */
  validate: (text: Uint8Array) => Validation<V>;
}

function makeFolder(base: string): string {
  for (let i = 0; i < 100; i++) {
    const dir = join(base, EDIT_DIR_PREFIX + randomBytes(4).readUInt32LE(0).toString());
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if ((e as { code?: string }).code === "EEXIST") continue;
      throw errorf("creating the temporary folder: %w", osError("mkdir", dir, e));
    }
    try {
      chmodSync(dir, 0o700);
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw errorf("creating the temporary folder: %w", osError("chmod", dir, e));
    }
    if (!onMemoryFs(dir)) {
      rmSync(dir, { recursive: true, force: true });
      throw errorf("the temporary folder %s is not on tmpfs", dir);
    }
    return dir;
  }
  throw errorf("creating the temporary folder in %s: too many attempts", base);
}

function writeNew(file: string, data: Uint8Array): void {
  let fd: number;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (e) {
    throw osError("open", file, e);
  }
  try {
    fchmodSync(fd, 0o600);
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off, data.length - off);
  } catch (e) {
    throw osError("write", file, e);
  } finally {
    closeSync(fd);
  }
}

function tooLarge(): Error {
  return codedError("too-large", "the edited file is larger than 16 MiB");
}

function readEdited(file: string): Uint8Array {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    throw osError("open", file, e);
  }
  try {
    const size = fstatSync(fd).size;
    if (size > EDIT_MAX) throw tooLarge();
    const buf = new Uint8Array(Math.min(size, EDIT_MAX) + 1);
    let n = 0;
    for (;;) {
      if (n === buf.length) throw tooLarge();
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
    }
    const out = buf.slice(0, n);
    buf.fill(0);
    return out;
  } catch (e) {
    if (hasCode(e, "too-large")) throw e;
    throw osError("read", file, e);
  } finally {
    closeSync(fd);
  }
}

function zeroFiles(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) {
      zeroFiles(p);
      continue;
    }
    if (!st.isFile()) continue;
    const fd = openSync(p, constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      const size = fstatSync(fd).size;
      const zeros = new Uint8Array(Math.min(size, 1 << 20));
      let off = 0;
      while (off < size) off += writeSync(fd, zeros, 0, Math.min(zeros.length, size - off), off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

/** A node:fs error as Go writes it (`open <path>: no such file or directory`). */
function goOsError(e: unknown): unknown {
  const x = e as { syscall?: string; path?: string; code?: string };
  if (x && typeof x.code === "string" && typeof x.path === "string") {
    const op = x.syscall === "scandir" ? "open" : x.syscall === "rmdir" || x.syscall === "rm" ? "unlinkat" : (x.syscall ?? "open");
    return osError(op, x.path, e);
  }
  return e;
}

/** Overwrites the folder's files with zeros, fsyncs, removes it. Throws the §A6 cleanup error. */
export function removeEditFolder(dir: string): void {
  try {
    zeroFiles(dir);
    rmSync(dir, { recursive: true });
  } catch (e) {
    throw errorf("removing the temporary folder %s: %w; remove it yourself, it holds the entry in plain text", dir, goOsError(e));
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function interrupted(signal: string): Error {
  return codedError("edit-interrupted", "editing interrupted by %s; nothing was changed", goSignalText(signal));
}

async function runEditorOnce(tty: Tty, editor: EditorChoice, file: string, watch: SignalWatch): Promise<void> {
  if (watch.received) throw interrupted(watch.received);
  const saved = tty.getAttr();
  let child: ChildHandle | null = null;
  const off = watch.onSignal(() => child?.kill("SIGKILL"));
  let r;
  try {
    r = await runProcess({
      argv: editorArgv(editor, file),
      path: editor.path,
      display: editor.path,
      stdin: "tty",
      stdout: "tty",
      stderr: "tty",
      onStart: (c) => {
        child = c;
        if (watch.received) c.kill("SIGKILL");
      },
    });
  } finally {
    off();
    try {
      tty.setAttr(saved);
    } catch {
      /* the terminal is gone */
    }
    tty.markLineStart();
  }
  if (watch.received) throw interrupted(watch.received);
  const err = exitError(editor.path, r);
  if (err) {
    await Bun.sleep(SIGNAL_GRACE_MS);
    if (watch.received) throw interrupted(watch.received);
    throw errorf("the editor failed (%w); nothing was changed", err);
  }
}

/**
 * Edits `text` in the external editor and returns the outcome (§A6). Errors: the editor's
 * failure, `editing interrupted by <signal>; nothing was changed` (code
 * "edit-interrupted", exit 1), the validation error after "no", a SignalError from the
 * "Edit it again?" prompt, I/O errors; and the cleanup error, joined to any other.
 */
export async function editExternally<V>(o: EditOptions<V>): Promise<EditOutcome<V>> {
  const watch = new SignalWatch().start();
  let dir: string | null = null;
  let result: EditOutcome<V> | undefined;
  let failure: unknown = undefined;
  let failed = false;
  try {
    dir = makeFolder(o.base);
    const file = join(dir, "entry.txt");
    writeNew(file, o.text);
    if (o.editor.kind === "other") {
      o.tty.say(
        T(
          "warning: passh can't control backup, swap or history files of %s: they may keep a copy of the entry on disk. Graphical editors must also wait until the file is closed (e.g. code --wait).",
          o.editor.name,
        ),
      );
    }
    for (;;) {
      await runEditorOnce(o.tty, o.editor, file, watch);
      const edited = readEdited(file);
      if (equalBytes(edited, o.text)) {
        result = { kind: "unchanged" };
        break;
      }
      const v = o.validate(edited);
      if (v.ok) {
        result = v.unchanged ? { kind: "unchanged" } : { kind: "changed", value: v.value, text: edited };
        break;
      }
      edited.fill(0);
      o.tty.say(T("The entry isn't valid: %s", v.error));
      let again = false;
      try {
        again = await askYesNo(o.tty, T("Edit it again?"), true);
      } catch (e) {
        if (e instanceof SignalError) throw e;
        again = false; // a failed prompt (end of input, 3 answers not understood) drops the edit
      }
      if (!again) throw v.error;
    }
  } catch (e) {
    failed = true;
    failure = e;
  } finally {
    watch.stop();
  }
  if (dir !== null) {
    try {
      removeEditFolder(dir);
    } catch (e) {
      if (!failed) throw e;
      // SPEC-GAP: §A6 doesn't say how a cleanup failure combines with another error; both are reported.
      throw joinErrors([failure, e]);
    }
  }
  if (failed) throw failure;
  return result!;
}

/** Reports whether an error is the editor's interruption by a signal. */
export function isEditInterrupted(e: unknown): boolean {
  return hasCode(e, "edit-interrupted");
}
