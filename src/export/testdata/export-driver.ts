// Test driver (not product code): runs runExport with the real /dev/tty and process streams,
// so a PTY test can compare the confirmation prompt with the reference's.
//   bun export-driver.ts <data block plaintext file> <exported_at seconds> <ExportOptions JSON>
import { readFileSync } from "node:fs";
import { processIO } from "../../cli/io.ts";
import { exitCodeOf } from "../../errors.ts";
import { renderError } from "../../i18n/index.ts";
import { parseVaultData } from "../../model/index.ts";
import { escapeMultiline } from "../../sanitize/index.ts";
import type { OpenedVault } from "../../vault/types.ts";
import { runExport } from "../export.ts";

const [dataFile, at, opts] = process.argv.slice(2);
const data = parseVaultData(new Uint8Array(readFileSync(dataFile!)));
try {
  await runExport({ ...JSON.parse(opts!), io: processIO, now: () => Number(at), openVault: async () => ({ data, close() {} }) as unknown as OpenedVault });
  process.exit(0);
} catch (e) {
  process.stderr.write("passh: " + escapeMultiline(renderError(e)) + "\n");
  process.exit(exitCodeOf(e));
}
