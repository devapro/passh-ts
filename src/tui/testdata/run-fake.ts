// A driver for PTY tests: runs the TUI with the in-memory fake backend.
//
//   bun run src/tui/testdata/run-fake.ts [--clear-after ms] [--idle ms] [--agent] [--print] [--form]
//
// Clipboard values are written to /dev/tty as OSC 52, as passh does. --form runs the
// standalone entry form instead and prints the result as JSON on stdout.

import { openTty } from "../../tty/tty.ts";
import { exitCodeOf } from "../../errors.ts";
import { renderError } from "../../i18n/index.ts";
import { readFileSync } from "node:fs";
import { FakeBackend, type FakeEntry } from "../fake.ts";
import { runEntryForm, runTui } from "../index.ts";

const args = process.argv.slice(2);
const opt = (name: string, d: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : d;
};

const str = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Entries from a `passh export --format json` file (the interop tests use the reference's). */
function loadExport(file: string): { entries: FakeEntry[]; revision: bigint } {
  const j = JSON.parse(readFileSync(file, "utf8"));
  const secs = (t: string) => Math.floor(Date.parse(t) / 1000);
  const entries = (j.entries ?? []).map((e: Record<string, unknown>) => ({
    id: e.id as string,
    path: e.path as string,
    password: e.password as string,
    username: e.username as string,
    url: e.url as string,
    tags: (e.tags as string[]) ?? [],
    notes: e.notes as string,
    fields: ((e.fields as Array<{ key: string; value: string }>) ?? []).map((f) => ({ key: f.key, value: f.value })),
    updatedAt: secs(e.updated_at as string),
  }));
  return { entries, revision: BigInt(j.revision) };
}

const tty = openTty();
const osc52 = (v: string) => tty?.writeRaw("\x1b]52;c;" + Buffer.from(v, "utf8").toString("base64") + "\x07");

if (args.includes("--form")) {
  const r = await runEntryForm({
    title: "edit work/github",
    original: { password: "s3cr3t", username: "arsenii", url: "https://github.com", tags: ["work", "dev"], notes: "line one\nline two" },
    fieldKeys: ["recovery-email"],
  });
  process.stdout.write(JSON.stringify(r) + "\n");
  process.exit(0);
}

const dataFile = str("--data");
const loaded = dataFile ? loadExport(dataFile) : null;
const backend = new FakeBackend({
  passphrase: str("--passphrase") ?? "secret",
  agent: args.includes("--agent") ? "serves" : "none",
  realTimers: true,
  onClipboard: osc52,
  config: { clearAfterMs: opt("--clear-after", 3000), idleTtlMs: opt("--idle", 300_000), printWebEnabled: args.includes("--print") },
  entries: loaded?.entries ?? [
    { path: "work/github", password: "gh-pass-123", username: "arsenii", url: "https://github.com", tags: ["dev", "2fa"], notes: "codes" },
    { path: "work/jira", password: "jira-pass", tags: ["dev"] },
    { path: "bank/My Bank", password: "bank-pass", username: "me" },
    { path: "homelab/router", password: "router-pass" },
    { path: "github", password: "root-gh", tags: ["dev"] },
  ],
});
if (loaded) backend.disk.revision = loaded.revision;
const display = str("--vault-display");
if (display !== undefined) backend.vaultDisplay = display;

try {
  const code = await runTui(backend);
  process.stderr.write(`[fake] exit ${code} log=${backend.log.join(",")}\n`);
  process.exit(code);
} catch (e) {
  process.stderr.write("passh: " + renderError(e) + "\n");
  process.stderr.write(`[fake] log=${backend.log.join(",")}\n`);
  process.exit(exitCodeOf(e));
}
