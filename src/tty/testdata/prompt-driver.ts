// PTY test driver: runs one prompt of src/tty on /dev/tty and prints the outcome like the
// CLI would: `RESULT <json>` on stdout, or `passh: <error>` on stderr with the exit status
// of cli.md §1.4. Usage: bun run prompt-driver.ts <mode> [args…]

import { exitCodeOf } from "../../errors.ts";
import { renderError, hasCode } from "../../i18n/index.ts";
import { echoOn, canonicalOn, tcgetattr } from "../../ffi/termios.ts";
import { escapeMultiline } from "../../sanitize/index.ts";
import {
  openTty,
  readSecret,
  readPassphrase,
  readSecretPair,
  readMaskedLines,
  readLine,
  askYesNo,
  confirmPhrase,
  PASSWORD_PAIR,
  gpgTtyEnv,
  terminalDevice,
} from "../index.ts";

const [mode, ...args] = process.argv.slice(2);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function state(fd: number): string {
  const t = tcgetattr(fd);
  if (typeof t === "number") return "err";
  return `echo=${echoOn(t)} icanon=${canonicalOn(t)}`;
}

async function main(): Promise<unknown> {
  if (mode === "notty") return { tty: openTty() === null, dev: terminalDevice() };
  const tty = openTty();
  if (!tty) throw new Error("no terminal");
  const before = state(tty.fd);
  let r: unknown;
  switch (mode) {
    case "secret":
      r = dec(await readSecret(tty, "Secret: "));
      break;
    case "passphrase":
      r = dec(await readPassphrase(tty));
      break;
    case "passphrase2": {
      const a = dec(await readPassphrase(tty));
      tty.say("Wrong passphrase. Try again.");
      const b = dec(await readPassphrase(tty));
      r = [a, b];
      break;
    }
    case "pair":
      r = dec(
        await readSecretPair(tty, {
          check: (s) => (s.length < 5 ? "warning: weak passphrase; use 6 or more random words" : undefined),
        }),
      );
      break;
    case "pairpw":
      r = dec(await readSecretPair(tty, { texts: PASSWORD_PAIR }));
      break;
    case "masked":
      tty.say("Type the key; it shows as *.");
      r = dec(await readMaskedLines(tty));
      break;
    case "line":
      r = await readLine(tty, "Username: ");
      break;
    case "lines": {
      const out: Array<string | null> = [];
      for (let i = 0; i < Number(args[0] ?? 2); i++) out.push(await readLine(tty, `L${i}: `));
      r = out;
      break;
    }
    case "yesno":
      try {
        r = await askYesNo(tty, args[0] ?? "Delete a/b?", args[1] === "yes");
      } catch (e) {
        if (args[2] === "eofno" && hasCode(e, "eof")) r = "eof";
        else throw e;
      }
      break;
    case "phrase":
      await confirmPhrase(tty, args[0] ?? "PRINT RECOVERY KEY");
      r = "confirmed";
      break;
    case "gpgtty":
      r = { dev: terminalDevice(), env: gpgTtyEnv({}), keep: gpgTtyEnv({ GPG_TTY: "/x" }) };
      break;
    case "say":
      tty.say("a\x1b[31mb\tc\nd\re");
      r = "said";
      break;
    case "winsize":
      r = tty.windowSize();
      break;
    case "raw-read": {
      tty.enterRawMode();
      const rd = tty.reader();
      const got = await rd.read();
      tty.restoreMode();
      r = got ? Array.from(got) : null;
      break;
    }
    default:
      throw new Error("unknown mode " + mode);
  }
  const after = state(tty.fd);
  tty.close();
  return { r, restored: before === after, after };
}

try {
  const r = await main();
  process.stdout.write("RESULT " + JSON.stringify(r) + "\n");
  process.exit(0);
} catch (e) {
  process.stderr.write("passh: " + escapeMultiline(renderError(e)) + "\n");
  process.exit(exitCodeOf(e));
}
