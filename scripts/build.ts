// Builds single-file executables with `bun build --compile` for the release targets.
// Bun has no 32-bit ARM (linux/arm/v7) target, so spec §2 G1's fifth target is missing.
//
//   bun run scripts/build.ts            all targets → dist/passh-<os>-<arch>
//   bun run scripts/build.ts host       only the host → dist/passh

import { $ } from "bun";
import { mkdirSync } from "node:fs";

const version = process.env.PASSH_VERSION ?? "0.1.0-ts";
const targets: Array<[string, string]> = [
  ["bun-linux-x64", "passh-linux-amd64"],
  ["bun-linux-arm64", "passh-linux-arm64"],
  ["bun-darwin-x64", "passh-darwin-amd64"],
  ["bun-darwin-arm64", "passh-darwin-arm64"],
];

mkdirSync("dist", { recursive: true });
const hostOnly = process.argv[2] === "host";
const list: Array<[string | null, string]> = hostOnly ? [[null, "passh"]] : targets;
for (const [target, out] of list) {
  const args = ["build", "--compile", "--minify", "--sourcemap=none", `--define`, `PASSH_VERSION=${JSON.stringify(version)}`, "src/main.ts", "--outfile", `dist/${out}`];
  if (target) args.splice(2, 0, `--target=${target}`);
  const t0 = performance.now();
  const r = await $`bun ${args}`.nothrow().quiet();
  if (r.exitCode !== 0) {
    console.error(`FAIL ${target ?? "host"}: ${r.stderr.toString()}`);
    process.exitCode = 1;
    continue;
  }
  const size = Bun.file(`dist/${out}`).size;
  console.log(`${(target ?? "host").padEnd(18)} dist/${out}  ${(size / 1024 / 1024).toFixed(1)} MiB  ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
