// Test driver (not product code): runs runImportPass with the process streams (progress on a
// terminal stderr), so a PTY test can compare it with the reference. Saves are discarded.
//   bun import-driver.ts <data block plaintext file> <ImportOptions JSON>
import { readFileSync } from "node:fs";
import { processIO } from "../../cli/io.ts";
import { stderrRaw } from "../../cli/output.ts";
import { exitCodeOf } from "../../errors.ts";
import { renderError } from "../../i18n/index.ts";
import { parseVaultData } from "../../model/index.ts";
import { escapeMultiline } from "../../sanitize/index.ts";
import type { OpenedVault } from "../../vault/types.ts";
import { runImportPass } from "../importpass.ts";

const [dataFile, opts] = process.argv.slice(2);
const data = parseVaultData(new Uint8Array(readFileSync(dataFile!)));
try {
  await runImportPass({ ...JSON.parse(opts!), io: processIO, progress: stderrRaw, openVault: async () => ({ data, async save() {}, close() {} }) as unknown as OpenedVault });
  process.exit(0);
} catch (e) {
  process.stderr.write("passh: " + escapeMultiline(renderError(e)) + "\n");
  process.exit(exitCodeOf(e));
}
