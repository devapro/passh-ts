// `passh import pass [dir] [--overwrite] [--dry-run]` (cli.md §2.22, import-export.md §1) and
// `passh export …` (cli.md §2.23, import-export.md §2.1): the CLI wiring of src/importpass's
// and src/export's command cores.

import { runImportPass } from "../importpass/index.ts";
import { runExport } from "../export/index.ts";
import type { OpenedVault } from "../vault/index.ts";
import type { RunContext } from "./command.ts";
import { stderrRaw } from "./output.ts";
import { commandIO, commandTerminal, configAndVault, openForCommand } from "./open.ts";

/**
 * `import pass`: the config and the vault file first, then src/importpass's flow (unlock, also
 * for `--dry-run`; store, walk, gpg, one save, report on stdout; progress on stderr when it
 * is a terminal, written raw so `\r` and `ESC[K` reach it).
 *
 * Audits #7 (an `--overwrite` import that changes nothing) and #8 (a plaintext over 4 MiB):
 * src/importpass's defaults, the proposed fixes (no save; `too large`).
 */
export async function runImportPassCmd(ctx: RunContext): Promise<void> {
  const cfg = configAndVault(ctx);
  await runImportPass({
    dir: ctx.args[0],
    overwrite: ctx.flags.bool("overwrite"),
    dryRun: ctx.flags.bool("dry-run"),
    io: commandIO,
    openVault: () => openForCommand(cfg, commandTerminal()),
    progress: stderrRaw,
  });
}

/**
 * `export`: every check of import-export.md §2.1 in its order, in src/export; the config and
 * the vault file are loaded only at step 9 (the vault key), as on the reference (`passh export
 * --format csv` without a config file reports the missing confirmation first).
 *
 * Audit #4 (`--age ""`): the proposed fix, an empty `--age` given on the command line is an
 * error (`--age: the recipient is empty …`), and with `--confirm-plaintext` a usage error;
 * the reference treats it as plaintext.
 */
export async function runExportCmd(ctx: RunContext): Promise<void> {
  const f = ctx.flags;
  await runExport({
    format: f.string("format"),
    tags: f.strings("tag"),
    folder: f.string("folder"),
    output: f.string("output"),
    age: f.changed("age") ? f.string("age") : undefined,
    confirmPlaintext: f.bool("confirm-plaintext"),
    spreadsheetSafe: f.bool("spreadsheet-safe"),
    io: commandIO,
    openVault: (): Promise<OpenedVault> => {
      const cfg = configAndVault(ctx);
      return openForCommand(cfg, commandTerminal());
    },
  });
}
