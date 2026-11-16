// `passh import pass [dir] [--overwrite] [--dry-run]` (spec §4.9, cli.md §2.22,
// import-export.md §1): unlock, find and walk the store, plan, decrypt each planned file with
// gpg, parse it, apply everything in one save, and print the report on stdout.

import { closeSync, readSync } from "node:fs";
import { expandPath, homeDir, joinPath, type Env } from "../config/paths.ts";
import { parseEntryText, type TextContent } from "../entrytext/index.ts";
import { errnoCode, toErrno } from "../fsx/oserror.ts";
import { codedError, errorf, T } from "../i18n/index.ts";
import { addEntry } from "../model/ops.ts";
import { nowTime } from "../model/time.ts";
import type { Time, VaultData } from "../model/types.ts";
import { gpgTtyEnv } from "../tty/gpgtty.ts";
import type { CommandIO } from "../util/io.ts";
import type { OpenedVault } from "../vault/types.ts";
import { comparePaths } from "../paths/index.ts";
import { CIPHERTEXT_LIMIT, findGpg, PLAINTEXT_LIMIT, runGpg } from "./gpg.ts";
import { formatReport, type ReportItem } from "./report.ts";
import { fstatFd, PathEscapesError, StoreRoot } from "./root.ts";
import type { Skip } from "./skips.ts";
import { planImport, walkStore, type PlanItem } from "./walk.ts";

/**
 * The store folder (§1.2): the `dir` argument, else `$PASSWORD_STORE_DIR` if not empty, else
 * `$HOME/.password-store`. `~` and `~/` expand from $HOME (`~user` doesn't); relative paths
 * are made absolute against the current folder. An empty `dir` counts as none (as on the
 * reference). Errors: `$HOME is not set`, `$HOME ("‹v›") is not an absolute path`.
 */
// SPEC-GAP: §1.2: an empty `dir` argument counts as none (the reference then uses
// $PASSWORD_STORE_DIR), rather than the current folder.
export function locateStore(dir: string | undefined, env: Env = process.env, cwd?: string): string {
  if (dir !== undefined && dir !== "") return expandPath(dir, { env, cwd });
  const fromEnv = env.PASSWORD_STORE_DIR;
  if (fromEnv !== undefined && fromEnv !== "") return expandPath(fromEnv, { env, cwd });
  return joinPath(homeDir(env), ".password-store");
}

export interface ImportOptions {
  /** The `[dir]` argument. */
  dir?: string;
  overwrite?: boolean;
  dryRun?: boolean;
  io: CommandIO;
  /** Unlocks the vault (§5.1); called first, also for `--dry-run`. Closed by runImportPass. */
  openVault: () => Promise<OpenedVault>;
  /** The environment: store location, gpg lookup, GPG_TTY (default process.env). */
  env?: Env;
  /** Current folder for a relative store (default: the process's). */
  cwd?: string;
  /**
   * Raw writes to stderr for the progress line (`\r` and `ESC[K` must not be escaped). Used
   * only when io.stderrIsTerminal(); without it no progress is shown.
   */
  progress?: (raw: string) => void;
  /** The save time (default now). */
  now?: () => Time;
  /**
   * Reproduce passh v0.6's known issues instead of the proposed fixes: audit #7 (an
   * `--overwrite` import that changes nothing still saves a new revision) and #8 (a plaintext
   * over 4 MiB is a `decryption failed`, not `too large`).
   */
  quirks?: boolean;
}

export interface ImportResult {
  /** The store, absolute. */
  store: string;
  /** Imported (dry run: planned) entries. */
  items: ReportItem[];
  skips: Skip[];
  /** A save happened. */
  saved: boolean;
  /** The report printed on stdout. */
  report: string;
}

/** A store file decrypted and parsed. */
interface Decrypted {
  item: PlanItem;
  content: TextContent;
}

/** Reads the ciphertext of a planned file through the root (§1.5 "stdin"), or the reason to skip it. */
function readCiphertext(root: StoreRoot, item: PlanItem): Uint8Array | Skip {
  const skip = (reason: Skip["reason"], detail?: Error): Skip => ({ file: item.file, reason, detail });
  let fd: number;
  try {
    fd = root.openFile(item.file);
  } catch (e) {
    if (e instanceof PathEscapesError) return skip("unreadable", e);
    return skip("unreadable", toErrno(e));
  }
  try {
    const st = fstatFd(fd);
    if (!st.isFile()) return skip("not-regular");
    if (st.size > CIPHERTEXT_LIMIT) return skip("too-large", errorf("larger than 1 MiB"));
    const max = CIPHERTEXT_LIMIT + 1;
    const buf = new Uint8Array(max);
    let n = 0;
    for (;;) {
      let k: number;
      try {
        k = readSync(fd, buf, n, max - n, null);
      } catch (e) {
        if (errnoCode(e) === "EINTR" || errnoCode(e) === "EAGAIN") continue;
        return skip("unreadable", toErrno(e));
      }
      if (k === 0) break;
      n += k;
      if (n >= max) break;
    }
    if (n > CIPHERTEXT_LIMIT) return skip("too-large", errorf("larger than 1 MiB"));
    return buf.subarray(0, n);
  } catch (e) {
    return skip("unreadable", toErrno(e));
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignored */
    }
  }
}

/**
 * Runs `passh import pass` (§1.1): unlock, locate and open the store, walk and plan; without
 * `--dry-run`, decrypt the planned files with gpg in walk order (progress on stderr when it is
 * a terminal), parse them, and apply every entry in one save; then print the report on stdout.
 * Errors (exit 1): the store errors, `gpg not found: …`, `gpg: ‹error›`, `import canceled at
 * the passphrase prompt`, `nothing was imported: ‹save error›`.
 */
export async function runImportPass(o: ImportOptions): Promise<ImportResult> {
  const env = o.env ?? process.env;
  const io = o.io;
  // 2. unlock (a dry run needs the vault too, to find conflicts)
  const vault = await o.openVault();
  let root: StoreRoot | undefined;
  try {
    // 3. find and open the store
    const store = locateStore(o.dir, env, o.cwd);
    root = StoreRoot.open(store);
    // 4. walk and plan
    const walk = walkStore(root);
    const plan = planImport(walk.files, vault.data, !!o.overwrite);
    const skips: Skip[] = [...walk.skips, ...plan.skips];

    if (o.dryRun) {
      const items = plan.items.map((i) => ({ path: i.path, replace: i.replace }));
      const report = formatReport({ store, dryRun: true, items, skips });
      io.stdout(report);
      return { store, items, skips, saved: false, report };
    }

    // 5. decrypt and parse, in walk order
    const decrypted: Decrypted[] = [];
    if (plan.items.length > 0) {
      const gpg = findGpg(env);
      const extraEnv: Record<string, string> = { ...(o.env ? definedOnly(o.env) : {}), ...gpgTtyEnv(env) };
      const total = plan.items.length;
      const progress = o.progress && io.stderrIsTerminal() ? o.progress : undefined;
      for (let k = 0; k < total; k++) {
        const item = plan.items[k]!;
        if (progress) {
          progress("\r" + T("Decrypting %d/%d…", k + 1, total) + "\x1b[K");
          if (k === total - 1) progress("\r\x1b[K");
        }
        const ct = readCiphertext(root, item);
        if (!(ct instanceof Uint8Array)) {
          skips.push(ct);
          continue;
        }
        const run = await runGpg(gpg, ct, extraEnv);
        if (run.verdict.kind === "canceled") {
          run.plaintext.fill(0);
          throw codedError("canceled", "import canceled at the passphrase prompt");
        }
        if (run.overflow) {
          run.plaintext.fill(0);
          // SPEC-GAP: audit #8: a plaintext over 4 MiB is reported as `too large` (the proposed
          // fix); with `quirks` as `decryption failed`, as passh v0.6 does. Same detail.
          const detail = errorf("the decrypted entry is larger than %d MiB", PLAINTEXT_LIMIT / (1024 * 1024));
          skips.push({ file: item.file, reason: o.quirks ? "decrypt" : "too-large", detail });
          continue;
        }
        if (run.verdict.kind === "failed") {
          run.plaintext.fill(0);
          skips.push({ file: item.file, reason: "decrypt", detail: run.verdict.detail });
          continue;
        }
        let content: TextContent;
        try {
          content = parseEntryText(run.plaintext, { importVariant: true });
        } catch (e) {
          skips.push({ file: item.file, reason: "not-text", detail: e instanceof Error ? e : errorf("%v", e) });
          continue;
        } finally {
          run.plaintext.fill(0);
        }
        decrypted.push({ item, content });
      }
    }

    // 6. one save (§1.7)
    let saved = false;
    if (decrypted.length > 0) {
      const now = (o.now ?? nowTime)();
      let data: VaultData = vault.data;
      let changed = false;
      try {
        for (const d of [...decrypted].sort((a, b) => comparePaths(a.item.path, b.item.path))) {
          const r = addEntry(data, d.item.path, d.content, { overwrite: d.item.replace, now });
          data = r.data;
          changed ||= r.changed;
        }
        // SPEC-GAP: audit #7: an `--overwrite` import that changes nothing doesn't save (the
        // proposed fix); with `quirks` it saves a new revision, as passh v0.6 does.
        if (changed || o.quirks) {
          await vault.save(data);
          saved = true;
        }
      } catch (e) {
        throw errorf("nothing was imported: %w", e);
      }
    }

    // 7. the report
    const items = decrypted.map((d) => ({ path: d.item.path, replace: d.item.replace }));
    const report = formatReport({ store, dryRun: false, items, skips });
    io.stdout(report);
    return { store, items, skips, saved, report };
  } finally {
    root?.close();
    vault.close();
  }
}

function definedOnly(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}
