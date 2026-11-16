// Fault injection (spec §13.2 safety test 9, storage.md §4.5): a save killed (SIGKILL) before and
// after each fsync and the rename leaves a vault that opens at the old or the new revision, a
// backup complete or absent, and leftovers that the next save removes.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../test/helpers/env.ts";
import { addEntry, emptyContent } from "../model/index.ts";
import { parseContainer } from "../vaultfile/index.ts";
import type { FaultPoint } from "./hooks.ts";
import { fixture, type Fixture } from "./testdata/helpers.ts";

const DRIVER = join(import.meta.dir, "testdata", "crash-driver.ts");
const POINTS: FaultPoint[] = [
  "locked",
  "temp-written",
  "temp-synced",
  "read-back",
  "backup-written",
  "backup-synced",
  "backup-renamed",
  "backup-dir-synced",
  "before-replace",
  "after-replace",
  "old-removed",
  "dir-synced",
  "record-written",
  "record-synced",
  "record-renamed",
];

let f: Fixture;
beforeAll(async () => {
  f = await fixture("fault");
});
afterAll(() => f.cleanup());

function listing(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function leftovers(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.includes(".tmp-"));
  } catch {
    return [];
  }
}

test("a save killed at every fault point leaves the old or the new revision", async () => {
  const key = f.identity.format();
  const vaultDir = join(f.e.dataHome, "passh");
  for (const point of POINTS) {
    const before = await f.open({ rollback: "report" });
    const rev = before.data.revision;
    const vaultId = before.data.vaultId;
    before.close();
    const r = await run([process.execPath, "run", DRIVER, f.vault, point], f.env, { stdin: key });
    expect([point, r.stdout.trim()]).toEqual([point, `REACHED ${point}`]);
    // the vault opens, complete, at the old or the new revision
    const v = await f.open({ rollback: "report" });
    expect([point, [rev, rev + 1n].includes(v.data.revision)]).toEqual([point, true]);
    const expectNew = ["after-replace", "old-removed", "dir-synced", "record-written", "record-synced", "record-renamed"].includes(point);
    expect([point, v.data.revision]).toEqual([point, expectNew ? rev + 1n : rev]);
    // every backup on disk is complete (it parses)
    const bdir = join(f.state, "backups", vaultId);
    for (const n of listing(bdir).filter((x) => !x.startsWith("."))) parseContainer(new Uint8Array(readFileSync(join(bdir, n))));
    // the next save removes the leftovers
    await v.save(addEntry(v.data, `after/${point}`, { ...emptyContent(), password: "p" }).data);
    v.close();
    expect([point, leftovers(vaultDir), leftovers(bdir), leftovers(f.state)]).toEqual([point, [], [], []]);
  }
}, 120_000);
