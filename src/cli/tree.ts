// The command tree (spec §6.1, cli.md §2): use lines, help texts, flags, argument counts.
// The run functions live in src/cli/cmd_*.ts and are attached by src/cli/index.ts.

import { Command, type CommandSpec, type FlagDef } from "./command.ts";

const ROOT_LONG = `passh keeps passwords in one age-encrypted vault file.

Run \`passh init\` to create a vault, then \`passh\` alone for the TUI. Commands that
read or change entries ask for the passphrase on the terminal, or use the agent
started by \`passh unlock\`.`;

const TAG_FLAG: FlagDef = { name: "tag", type: "strings", usage: "only entries with this tag (repeat for several: all must match)" };
const FOLDER_FLAG: FlagDef = { name: "folder", type: "string", usage: "only entries in this folder" };
const OUTPUT_FLAG: FlagDef = { name: "output", short: "o", type: "string", usage: "write to this new file (mode 0600) instead of stdout" };
const WEB_FLAG: FlagDef = { name: "web", type: "bool", usage: "show the sheet on the one-shot print page (§7.4), with a QR code; a browser can print it or save it as PDF" };

export const SPECS: Record<string, CommandSpec> = {
  root: {
    use: "passh",
    short: "",
    long: ROOT_LONG,
    args: "any",
    flags: [
      { name: "config", type: "string", persistent: true, usage: "config file (default $PASSH_CONFIG, then ~/.config/passh/config.toml)" },
      { name: "vault", type: "string", persistent: true, usage: "vault file, overriding the config's vault (no config file needed)" },
    ],
  },
  add: {
    use: "add <path>",
    short: "Add an entry interactively: password (or generate), username, url, tags, notes",
    args: { min: 1, max: 1 },
    flags: [{ name: "force", short: "f", type: "bool", usage: "replace an existing entry" }],
  },
  backup: {
    use: "backup <dest>",
    short: "Make a checked copy of the vault in a file or folder",
    long: `Copy the vault to a file, or into a folder as <name>-<UTC time>.passh, with
mode 0600. The copy is flushed to disk, read back and compared by SHA-256.
An existing file is never overwritten. A vault that isn't in canonical form
(e.g. after an email or a paste) is written in canonical form. No passphrase
is needed.`,
    args: { min: 1, max: 1 },
  },
  backups: {
    use: "backups",
    short: "List the automatic backups of the vault",
    long: `List the automatic backups passh made before each save (§4.7), newest first,
with time and revision. To restore one, copy it over the vault file and run
\`passh verify --full\`. No passphrase is needed.`,
    args: "none",
  },
  copy: {
    use: "copy <path> [--field f]",
    short: "Copy a field (default: the password) to the clipboard, cleared after a while",
    long: `Copy the password, or another field, to the clipboard: through the terminal
(OSC 52, which works over SSH) or with clipboard.command. passh waits and clears
the clipboard after clipboard.clear_after; Ctrl-C clears it at once. The value
is never printed.`,
    args: { min: 1, max: 1 },
    flags: [{ name: "field", type: "string", def: "password", usage: "field to copy: password, username, url, tags, notes or a custom field" }],
  },
  doctor: {
    use: "doctor",
    short: "Check the config, the vault file, the state and agent folders, memory and swap",
    long: `Read-only checks of everything passh depends on: the config file, the vault
file (structure, mode 0600, writable folder, leftover temporary files), the
state and agent folders, the agent, free memory for unlock (scrypt needs
256 MiB), swap, core dumps and the terminal. It reports, never fixes. The exit
status is 1 if a check found an error; warnings are advice.`,
    args: "none",
  },
  edit: {
    use: "edit <path> [--editor]",
    short: "Edit an entry in the built-in form, or in $EDITOR",
    long: `Edit an entry in the built-in form: password, username, url, tags and notes
(ctrl+s saves, esc cancels, ctrl+r reveals the password, ctrl+g generates one).

--editor opens the entry's text form in $EDITOR instead, in a temporary file on
tmpfs that is wiped afterwards. vim, neovim and nano get flags that keep them
from writing swap, backup or history files. Where there is no tmpfs (macOS),
the built-in form is used.`,
    args: { min: 1, max: 1 },
    flags: [{ name: "editor", type: "bool", usage: "edit the text form in $EDITOR (temporary file on tmpfs)" }],
  },
  export: {
    use: "export --format <csv|json|bitwarden-json>",
    short: "Export entries for other tools (plaintext unless --age)",
    long: `Export entries as csv, json (the vault's data format) or bitwarden-json.

Export data is never written to a terminal: use -o file or redirect stdout.
A plaintext export needs confirmation: with a terminal you type EXPORT PLAINTEXT;
without one (e.g. over ssh without -t) add --confirm-plaintext. --age <recipient>
encrypts the export to an age public key instead. -o creates a new file with
mode 0600 and never overwrites one.

For a backup, don't export: copy the vault file (passh backup).`,
    args: "none",
    flags: [
      { name: "age", type: "string", usage: "encrypt to this age public key (age1…)" },
      { name: "confirm-plaintext", type: "bool", usage: "confirm a plaintext export when there is no terminal" },
      FOLDER_FLAG,
      { name: "format", type: "string", usage: "csv, json or bitwarden-json" },
      OUTPUT_FLAG,
      { name: "spreadsheet-safe", type: "bool", usage: "CSV: prefix ' to cells starting with = + - @ (changes values; not for password managers)" },
      TAG_FLAG,
    ],
  },
  find: {
    use: "find <query>",
    short: "Fuzzy search on paths and tags",
    args: { min: 1, max: 1 },
  },
  generate: {
    use: "generate <path> [len]",
    short: "Generate and store a password",
    long: `Generate a random password (default 24 letters and digits) and store it.

A new path makes a new entry. For an existing entry, --force replaces its
password and keeps its other values (username, url, tags, fields, notes).
The password is not printed; show it with \`passh show <path> --field password\`.`,
    args: { min: 1, max: 2 },
    flags: [
      { name: "force", short: "f", type: "bool", usage: "replace the password of an existing entry" },
      { name: "symbols", type: "bool", usage: "also use punctuation characters" },
    ],
  },
  help: {
    use: "help [command]",
    short: "Help about any command",
    long: `Help provides help for any command in the application.
Simply type passh help [path to command] for full details.`,
    args: "any",
  },
  import: {
    use: "import",
    short: "Import entries from another password manager",
    noSubcommand: "say what to import from, e.g. `passh import pass`",
  },
  "import pass": {
    use: "pass [dir]",
    short: "One-way import from a pass store (needs gpg)",
    long: `Import a pass store (password-store.org) into the vault, in one save. The store
is only read. dir defaults to $PASSWORD_STORE_DIR, then ~/.password-store.
Each entry is decrypted with gpg, as pass does. Paths already in the vault are
skipped unless --overwrite is given. --dry-run lists what would be imported
and the conflicts without decrypting anything.`,
    args: { min: 0, max: 1 },
    flags: [
      { name: "dry-run", type: "bool", usage: "list what would be imported and the conflicts; decrypt nothing" },
      { name: "overwrite", type: "bool", usage: "replace entries whose path is already in the vault" },
    ],
  },
  init: {
    use: "init [--vault file]",
    short: "Create a new vault, and the config file if it doesn't exist",
    args: "none",
  },
  lock: {
    use: "lock",
    short: "Stop the agent",
    args: "none",
  },
  ls: {
    use: "ls [folder]",
    short: "Print the tree of entries, optionally filtered by tag",
    args: { min: 0, max: 1 },
    flags: [TAG_FLAG],
  },
  mv: {
    use: "mv <src> <dst>",
    short: "Move or rename an entry or a folder",
    long: `Move or rename an entry. A destination ending in / moves the entry into that
folder, keeping its name. If <src> is a folder, every entry in it moves, in
one save; nothing moves if any destination is taken.`,
    args: { min: 2, max: 2 },
  },
  passwd: {
    use: "passwd",
    short: "Change the passphrase (the paper recovery key stays valid)",
    long: `Change the passphrase: only the key block is rewritten, and the paper recovery
key stays valid. It asks for the current passphrase on the terminal, also while
the agent runs: the agent's key isn't enough to change it. A running agent is
stopped afterwards.`,
    args: "none",
  },
  print: {
    use: "print [--tag t] [--folder f] [--fields password,username,url] [-o file] [--confirm-plaintext] [--web]",
    short: "Print a password sheet (text), or show it on the print page (--web)",
    long: `Lay out the chosen entries as a text password sheet, grouped by folder, with
the chosen fields (default password,username,url; also tags, notes, fields, or
a custom field's key). Ambiguous characters are marked.

The sheet is plaintext: it is never written to a terminal, and it needs
confirmation as a plaintext export does (type EXPORT PLAINTEXT, or
--confirm-plaintext without a terminal). Use -o file (mode 0600) or redirect
stdout; print it, then delete the file.

--web shows it on the one-shot print page instead (print_web.enabled; needs a
terminal and typing PRINT); the browser prints it, or saves it as PDF.`,
    args: "none",
    flags: [
      { name: "confirm-plaintext", type: "bool", usage: "confirm a plaintext sheet when there is no terminal" },
      { name: "fields", type: "string", usage: "fields to print, comma-separated (default password,username,url)" },
      FOLDER_FLAG,
      OUTPUT_FLAG,
      TAG_FLAG,
      WEB_FLAG,
      { name: "format", type: "string", usage: "removed", hidden: true },
    ],
  },
  recover: {
    use: "recover [--vault file]",
    short: "Open the vault with the paper recovery key and set a new passphrase",
    args: "none",
  },
  "recovery-key": {
    use: "recovery-key",
    short: "The paper recovery key",
    noSubcommand: "say what to do, e.g. `passh recovery-key print`",
  },
  "recovery-key print": {
    use: "print [-o file] [--web]",
    short: "Print the paper recovery key (needs a terminal and typing PRINT RECOVERY KEY)",
    long: `Print the paper recovery key as a text sheet: the vault key in groups of four
characters, the vault_id, the print date, a warning and the manual recovery
steps. Whoever has the sheet and a copy of the vault can read everything: keep
it offline, and print a new one after \`passh rekey\`.

It needs a terminal and typing PRINT RECOVERY KEY. The sheet is never written
to a terminal: use -o file (mode 0600) or redirect stdout, print it, then delete
the file. --web shows it on the one-shot print page instead, with the key as a
QR code; the browser prints it, or saves it as PDF.`,
    args: "none",
    flags: [OUTPUT_FLAG, WEB_FLAG, { name: "format", type: "string", usage: "removed", hidden: true }],
  },
  rekey: {
    use: "rekey",
    short: "Make a new vault key (the old passphrase and paper key stop working on new versions)",
    long: `Make a new vault key and re-encrypt the data to it, with a passphrase (the same or
a new one). The old passphrase and paper recovery key don't open new versions of
the file. It asks for the current passphrase on the terminal, also while the
agent runs: the agent's key isn't enough to replace the vault key. A running
agent is stopped afterwards.`,
    args: "none",
  },
  rm: {
    use: "rm <path>",
    short: "Delete an entry (asks for confirmation)",
    args: { min: 1, max: 1 },
    flags: [{ name: "force", short: "f", type: "bool", usage: "don't ask for confirmation" }],
  },
  show: {
    use: "show <path>",
    short: "Print an entry (text form) or one field",
    long: `Print an entry in its text form: the password on line 1, then username, url,
tags and other fields, then the notes after ---.

Control characters and escape sequences in the entry are shown escaped, so an
entry can't drive your terminal. --raw prints the exact bytes instead.
--field prints one value (password, username, url, tags, notes or a custom
field). When stdout is not a terminal (a pipe or a file), --field prints the
exact value without a final newline, e.g.
  passh show work/github --field password | pbcopy`,
    args: { min: 1, max: 1 },
    flags: [
      { name: "field", type: "string", usage: "print only this field: password, username, url, tags, notes or a custom field" },
      { name: "raw", type: "bool", usage: "print exact bytes, without escaping control characters" },
    ],
  },
  tag: {
    use: "tag <path> --add a --remove b",
    short: "Add and remove tags of an entry",
    args: { min: 1, max: 1 },
    flags: [
      { name: "add", type: "strings", usage: "tag to add (repeat, or separate with commas)" },
      { name: "remove", type: "strings", usage: "tag to remove (repeat, or separate with commas)" },
    ],
  },
  tags: {
    use: "tags",
    short: "List tags with their entry counts",
    args: "none",
  },
  unlock: {
    use: "unlock [--ttl d]",
    short: "Start the agent: no passphrase prompts for a while, also without a terminal",
    long: `Ask for the passphrase and start the agent, which keeps the vault key in memory
so later commands, including ones without a terminal (ssh host passh show …),
don't ask for it. The agent exits after agent.idle_ttl without use, after
agent.max_ttl (or --ttl) in any case, and on \`passh lock\`.

With an agent already running for the vault, unlock restarts its idle time and
says how long it has left. --ttl only applies to a new agent: passh says when it
wasn't applied (run \`passh lock\` first).`,
    args: "none",
    flags: [{ name: "ttl", type: "duration", usage: "stop a new agent after this long in any case (overrides agent.max_ttl), e.g. 30m" }],
  },
  verify: {
    use: "verify [file] [--full]",
    short: "Check the vault or a copy of it",
    long: `Check a vault file without the passphrase: the passh-vault line, both blocks
complete, base64 and age headers valid. It prints the file's SHA-256 and size;
a byte-exact copy has the same SHA-256 as the original.

--full also decrypts the file (through the agent, or by asking for the
passphrase) and prints its vault_id, revision, saved_at and entry count, and
how it compares with the newest revision seen on this machine.`,
    args: { min: 0, max: 1 },
    flags: [{ name: "full", type: "bool", usage: "also decrypt the file and check its data" }],
  },
  version: {
    use: "version",
    short: "Print passh's version",
    args: "none",
  },
};

/** Builds the command tree; `runs` maps "name" or "parent child" to run functions. */
export function buildTree(runs: Partial<Record<string, CommandSpec["run"]>>): Command {
  const mk = (key: string) => new Command({ ...SPECS[key]!, run: runs[key] ?? SPECS[key]!.run });
  const root = mk("root");
  const order = ["add", "backup", "backups", "copy", "doctor", "edit", "export", "find", "generate", "help", "import", "init", "lock", "ls", "mv", "passwd", "print", "recover", "recovery-key", "rekey", "rm", "show", "tag", "tags", "unlock", "verify", "version"];
  for (const k of order) {
    const c = k === "help" ? new Command({ ...SPECS.help!, run: () => {} }) : mk(k);
    root.add(c);
    if (k === "import") c.add(mk("import pass"));
    if (k === "recovery-key") c.add(mk("recovery-key print"));
  }
  return root;
}
