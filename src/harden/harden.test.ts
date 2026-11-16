import { expect, test } from "bun:test";
import { join } from "node:path";

// Run in a child process: setrlimit can't be undone (the hard limit only goes down).
test("disableCoreDumps sets RLIMIT_CORE soft and hard to 0, inherited by children", async () => {
  const script = `
    import { disableCoreDumps, coreDumpLimits } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
    const err = disableCoreDumps();
    const l = coreDumpLimits();
    const child = Bun.spawnSync(["sh", "-c", "ulimit -c; ulimit -H -c"]);
    console.log(JSON.stringify({ err: err ? err.message : null, soft: String(l.soft), hard: String(l.hard), child: child.stdout.toString() }));
  `;
  const p = Bun.spawnSync([process.execPath, "-e", script]);
  const r = JSON.parse(p.stdout.toString());
  expect(r).toEqual({ err: null, soft: "0", hard: "0", child: "0\n0\n" });
});

test("a failure is returned as the bare OS error", async () => {
  // Raising the hard limit again isn't allowed for a normal user: EPERM.
  const script = `
    import { disableCoreDumps } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
    import { setrlimit, RLIMIT_CORE } from ${JSON.stringify(join(import.meta.dir, "../ffi/libc.ts"))};
    import { errnoError } from ${JSON.stringify(join(import.meta.dir, "../fsx/oserror.ts"))};
    disableCoreDumps();
    const r = setrlimit(RLIMIT_CORE, 1n, 1n);
    console.log(r === 0 ? "ok" : errnoError(r).message);
  `;
  const p = Bun.spawnSync([process.execPath, "-e", script]);
  const out = p.stdout.toString().trim();
  if (process.getuid?.() === 0) expect(out).toBe("ok");
  else expect(out).toBe("operation not permitted");
});
