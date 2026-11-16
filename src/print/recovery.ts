// The recovery key sheet (print.md §5, spec §5.4): head, key, forgotten passphrase and
// recovery without passh, as blocks of rows.

import { T } from "../i18n/index.ts";
import { escapeLine } from "../sanitize/index.ts";
import { encodeText, renderSvg } from "../qr/index.ts";
import { SPACE, bulletRows, proseRows, wrappedRows, type Block, type Row } from "./rows.ts";
import { formatDate, type Sheet } from "./sheet.ts";

const PREFIX = "AGE-SECRET-KEY-1";

/**
 * The manual recovery commands of spec §8, byte for byte (a test keeps them identical).
 * SPEC-GAP (print.md §5: "lines are at most 80 columns except the two `tr … | awk …`
 * commands"): the third command with its comment is 87 columns too (as the reference prints).
 */
export const RECOVERY_COMMANDS = [
  "tr -d '\\r' < vault.passh | awk '/BEGIN AGE ENCRYPTED FILE/{n++} n==1{print} n==1 && /END AGE ENCRYPTED FILE/{exit}' > key.age",
  "tr -d '\\r' < vault.passh | awk '/BEGIN AGE ENCRYPTED FILE/{n++} n==2{print} n==2 && /END AGE ENCRYPTED FILE/{exit}' > data.age",
  "age -d -o /dev/shm/key.txt key.age                            # asks for the passphrase",
  "age -d -i /dev/shm/key.txt -o /dev/shm/vault.json data.age",
  "rm /dev/shm/key.txt",
] as const;

/** The commands with the third line's comment in the language (print.md §5 item 4, §8). */
export function recoveryCommands(): string[] {
  const third = RECOVERY_COMMANDS[2];
  const hash = third.indexOf("# ");
  return [RECOVERY_COMMANDS[0], RECOVERY_COMMANDS[1], third.slice(0, hash) + T("# asks for the passphrase"), RECOVERY_COMMANDS[3], RECOVERY_COMMANDS[4]];
}

/**
 * The key lines (print.md §5): `AGE-SECRET-KEY-1` alone, then the 58 characters after it in
 * groups of 4 separated by one blank, 5 groups per line (the last group 2 characters).
 */
export function keyLines(key: string): string[] {
  const k = key.toUpperCase();
  if (!k.startsWith(PREFIX)) throw new Error("recovery sheet: not an age identity");
  const rest = k.slice(PREFIX.length);
  const groups: string[] = [];
  for (let i = 0; i < rest.length; i += 4) groups.push(rest.slice(i, i + 4));
  const lines = [PREFIX];
  for (let i = 0; i < groups.length; i += 5) lines.push(groups.slice(i, i + 5).join(" "));
  return lines;
}

export interface RecoverySheetInput {
  /** The vault key, `AGE-SECRET-KEY-1…` (74 characters). Never placed in one piece in text. */
  key: string;
  vaultId: string;
  printedAt: Date;
  /** The print page form: the QR row instead of the "QR code is on the web page" prose. */
  web: boolean;
}

/** Builds the recovery key sheet (print.md §5). */
export function buildRecoverySheet(input: RecoverySheetInput): Sheet {
  const title = T("passh paper recovery key");
  const date = formatDate(input.printedAt);
  const head: Row[] = [
    ...proseRows("title", title),
    ...proseRows("meta", "vault_id " + escapeLine(input.vaultId)),
    ...proseRows("meta", T("printed %s", date)),
    SPACE,
    ...proseRows("warning", T("Whoever has this sheet and a copy of the vault can read everything in the vault.")),
    ...proseRows("text", T("Keep it offline, like cash. If it may have been seen, copied or lost, run `passh rekey` and print a new sheet: the old key then no longer opens new versions of the vault (copies made before still open with it).")),
  ];
  const keyRows: Row[] = [
    SPACE,
    ...wrappedRows("heading", T("Vault key")),
    ...keyLines(input.key).map((t): Row => ({ kind: "key", text: t })),
    SPACE,
    ...proseRows("text", T("After AGE-SECRET-KEY-1 the key never has the letters B, I or O or the digit 1: 0 is always the digit zero.")),
  ];
  if (input.web) {
    const qr = encodeText(input.key.toUpperCase(), "M");
    keyRows.push({ kind: "qr", text: "", qr: renderSvg(qr, T("QR code of the vault key")) });
  } else {
    keyRows.push(...proseRows("text", T("The key's QR code is on the web page (`passh recovery-key print --web`).")));
  }
  const forgotten: Row[] = [
    SPACE,
    ...wrappedRows("heading", T("Forgotten passphrase")),
    ...proseRows("text", T("Run `passh recover` and type the key above. Spaces, line breaks and letter case are ignored, and the key's checksum catches typos. passh then asks for a new passphrase.")),
  ];
  const without: Row[] = [
    SPACE,
    ...wrappedRows("heading", T("Without passh")),
    ...proseRows("text", T("On any machine with age (https://age-encryption.org) v1.0 or later, where vault.passh is a copy of the vault file:")),
    SPACE,
    ...recoveryCommands().map((t): Row => ({ kind: "code", text: t })),
    SPACE,
    ...bulletRows(T("With this key instead of the passphrase: write it to /dev/shm/key.txt as one line, without spaces, in capital letters as printed (AGE-SECRET-KEY-1 and then the groups), instead of running the first and third commands. The other commands stay the same.")),
    SPACE,
    ...bulletRows(T("vault.json is plaintext. Keep it on tmpfs (/dev/shm on Linux) and delete it when done.")),
    SPACE,
    ...bulletRows(T("If a mail client or editor re-wrapped the lines, age may reject the blocks. passh still opens such a file, and `passh backup` writes it back in canonical form.")),
  ];
  const blocks: Block[] = [head, keyRows, forgotten, without].map((rows) => ({ rows, keep: false }));
  return { title, date, blocks, legend: [], count: 0 };
}
