// Test helper run as a second process: takes a lock file or creates a temporary file,
// prints "ready", and holds it until stdin closes (or the given milliseconds pass).
//   bun run hold.ts lock <path> [ms]
//   bun run hold.ts temp <dir> <target> [ms]

import { acquireLock } from "../lock.ts";
import { createTempFile } from "../temp.ts";

const [mode, a, b, c] = process.argv.slice(2);
let ms = 30_000;
if (mode === "lock") {
  await acquireLock(a!);
  if (b) ms = Number(b);
  process.stdout.write("ready\n");
} else if (mode === "temp") {
  const t = createTempFile(a!, b!);
  if (c) ms = Number(c);
  process.stdout.write(t.path + "\n");
} else {
  process.exit(2);
}
const timer = setTimeout(() => process.exit(0), ms);
process.stdin.on("end", () => {
  clearTimeout(timer);
  process.exit(0);
});
process.stdin.resume();
