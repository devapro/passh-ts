// Terminal I/O on /dev/tty (agent-session.md §A4, cli.md §1.6–§1.7).
//
//   const tty = openTty();                       // null: "no terminal"
//   const pass = await readPassphrase(tty);      // `Passphrase: `, raw, no echo
//   const ok = await askYesNo(tty, "Delete x?", false);
//   tty.say("Wrong passphrase. Try again.");     // escaped (S4), `\r\n` in raw mode

export { Tty, openTty } from "./tty.ts";
export {
  readSecret,
  readPassphrase,
  readSecretPair,
  readMaskedLines,
  readLine,
  readLineBytes,
  askYesNo,
  confirmPhrase,
  withRawPrompt,
  withCookedPrompt,
  wrapPromptError,
  notConfirmedError,
  constantTimeEqual,
  goTrimSpace,
  PASSPHRASE_PAIR,
  PASSWORD_PAIR,
  PASSPHRASE_MAX,
  LINE_MAX,
  ATTEMPTS,
} from "./prompts.ts";
export type { RawIO, SecretOptions, PairOptions, PairTexts, MaskedOptions, LineOptions } from "./prompts.ts";
export { interruptedError, eofError, passphraseTooLong, inputTooLong, readEditedLine, newEditState } from "./lineedit.ts";
export type { EditState, EditOptions, EditResult } from "./lineedit.ts";
export { SignalWatch, SignalInterrupt, PROMPT_SIGNALS } from "./signals.ts";
export { FdByteSource, ArrayByteSource, TtyReader, waitReadable } from "./source.ts";
export type { ByteSource } from "./source.ts";
export { terminalDevice, gpgTtyEnv } from "./gpgtty.ts";
export type { WindowSize, Termios } from "../ffi/termios.ts";
