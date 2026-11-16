# Appendix: command line

Normative appendix to [spec.md](../../spec.md) §6.1, and to the commands that §4.7–§4.10, §5.1, §5.4, §6.3 and §7 describe. Scope: every command of `passh`: synopsis, arguments, flags, prompts and their order, stdout formats, stderr messages, exit statuses, the behaviour without a terminal, and the `doctor` checks. spec.md gives the design; this appendix gives the exact formats and behaviour. Precedence: see [spec.md §1.1](../../spec.md#11-appendices-normative). Quoted texts are the English (`en`) catalogue; text for people is translated per §3.3 ([i18n.md](i18n.md)), data on stdout is not (exceptions in [1.3](#13-streams)).

Related appendices: [agent-session.md](agent-session.md) (agent, `/dev/tty` prompts §A4, clipboard §A5, external editor §A6), [storage.md](storage.md) (open, save, backups, rollback record), [vault-format.md](vault-format.md) (container, data, text form), [import-export.md](import-export.md) (`import pass`, `export`, `generate`), [print.md](print.md) (sheets, print page), [tui.md](tui.md) (TUI, built-in entry form).

Notation: `<path>` in a message is an entry path, escaped (S4). `<file>` is a file path: absolute, with a `$HOME/` prefix written as `~/`, escaped (S4). `<abs>` is a file path as passh got it (the config's `vault`, `--vault` or an argument, made absolute), **without** `~/`; it is used by every error and warning about opening or reading the vault file (§4.5 errors, lenient-parse warnings), by `config <abs>:`, by the agent folder errors and by `backup`'s destination errors. Errors of the operating system read `<op> <abs>: <reason>` (`stat /home/a/x.passh: no such file or directory`, `open …: permission denied`); not normative: `<reason>`'s wording. `<D>` is a duration written `2h`, `1h30m` (hours: seconds dropped), `15m`, `14m59s`, `45s` (rounding: [agent-session.md §A2.3](agent-session.md#a23-starting-passh-unlock---ttl-d)). Escaping, and which form each output uses: [agent-session.md §A9.1](agent-session.md#a91-s4-escaping-must).

## 1. Rules for every command

### 1.1 Parsing

The reference parser is spf13/cobra v1.10 with pflag v1.0.9 (informative); the rules it implements:

- **Position.** After the command name, flags and positional arguments mix in any order (`passh show a --raw` = `passh show --raw a`). The global flags `--config` and `--vault`, and `-h`, may also come before the name (`passh --vault f ls`, `passh -h ls`); a command's own flag before its name is unknown (`passh --raw show a` → `unknown flag: --raw`). `--` ends the flags: everything after it is positional (`passh show -- -x`, then the path rule rejects `-x`; `passh show -- a --raw` has 2 arguments). A lone `-` is positional.
- **Long flags:** `--name value` or `--name=value`; `--name=` gives the empty value. **Short flags** (only where a table lists one): `-o value`, `-ovalue`, `-o=value` (but `-o=` alone gives the value `=`). Bool shorthands combine: `-fh` = `-f -h`; every letter of a cluster is a shorthand (`generate x -f5` → `unknown shorthand flag: '5' in -5`).
- **Bool flags** take no separate value: `--raw`, or `--raw=<b>` with `<b>` one of `1 0 t f T F true false TRUE FALSE True False`; `--raw false` makes `false` a positional argument.
- **Repeated flags:** *string*, *bool* and *duration* flags keep the last value; *strings* flags add up.
- **Flag types:** *string*; *bool*; *strings*: each value is read as one CSV record (comma-separated; `"…"` quotes a field, `""` inside it is a quote; only the first line of the value counts, the rest is silently dropped, known issue #15 of [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)), so `--tag a,b` = `--tag a --tag b`, and an empty value adds nothing (`--tag ""` = no filter); *duration*: Go `time.ParseDuration` (`90s`, `30m`, `1h30m`; a number without a unit is invalid).
- **Help:** every command has `-h`/`--help` (help on stdout, exit 0). It wins over argument-count errors (`passh ls -h extra` prints help) but not over flag errors (`passh show -h --nope` → `unknown flag: --nope`, exit 2). Only the root has `-v`/`--version` (`passh -v ls` → `unknown shorthand flag: 'v' in -v`). There is no `completion` command, and an unknown command gets no suggestion ("did you mean").
- Argument counts are exact per command. Commands without arguments reject one as `unknown command "<arg>" for "passh <cmd>"`.
- `passh` with flags only (`passh --vault f`) opens the TUI, like `passh` alone.

Parse errors (exit 2; each followed by the usage hint of [1.3](#13-streams)): `unknown flag: --<name>`; `unknown shorthand flag: '<c>' in -<the cluster from c on>` (`-xyz` → `'x' in -xyz`); `flag needs an argument: --<name>` (`'<c>' in -<c>` for a shorthand); `invalid argument "<v>" for "<flag>" flag: <reason>`, with `<v>` Go-quoted and `<flag>` `--name` or `-o, --output` (e.g. `invalid argument "maybe" for "--raw" flag: strconv.ParseBool: parsing "maybe": invalid syntax`, `invalid argument "5" for "--ttl" flag: time: missing unit in duration "5"`, `invalid argument "a\"b" for "--tag" flag: parse error on line 1, column 2: bare " in non-quoted-field`; not normative: `<reason>`); `bad flag syntax: <arg>` (`---x`).

### 1.2 Global flags, config and vault

| Flag | Type | Meaning |
|---|---|---|
| `--config <file>` | string | Config file, instead of `$PASSH_CONFIG` and `$XDG_CONFIG_HOME/passh/config.toml` (default `~/.config/passh/config.toml`) |
| `--vault <file>` | string | Vault file for this command, instead of the config's `vault` |

Both work on every command, before or after its name. A path from a flag or `$PASSH_CONFIG` has `~` and `~/` expanded from `$HOME` and is made absolute against the working directory. (In the config file, `vault` must be absolute or start with `~/`.) An `XDG_*` variable counts only when it holds an absolute path; `$HOME` must be set and absolute.

| Config file | `--vault` | Result |
|---|---|---|
| exists and valid | – / given | used; `--vault` replaces `vault` |
| exists, invalid (TOML syntax, unknown key, bad value) | – / given | error, exit 1: `config <abs>: <problem>`, or `config <abs>:` followed by one indented problem per line |
| missing; location from `$PASSH_CONFIG` or the default | given | the §3.3 defaults, `vault` = `--vault` |
| missing; location from `--config` | given | error: a file named with `--config` must exist |
| missing | – | ``no config file at <absolute path>[ (from --config\|$PASSH_CONFIG)]: run `passh init` to create one, or create it with the line vault = "/path/to/vault.passh", or pass --vault <file>``, exit 1 |

The language (§3.3) is chosen before parsing: passh scans the arguments up to `--` for the last `--config` and `--vault` (both spellings) and resolves the config as above; any failure gives English. Help texts and parse errors are therefore already translated.

Every command that uses the vault file first checks it exists: ``no vault at <file>: run `passh init` to create one, or pass --vault <file>`` (exit 1). Exceptions: `init` (creates it), `verify <file>` (the OS error of [2.19](#219-verify)), `backups` (a note, then every backup on the machine, exit 0: [2.21](#221-backups)) and `doctor` (an `error` row). `lock` checks it too ([2.15](#215-lock)). Another `stat` error: `vault <file>: <OS error>`, exit 1.

### 1.3 Streams

- **stdout** carries only the data named for each command, written once the command has succeeded (exception: `verify` writes its structure lines before a failed check or a failing `--full`). Nothing else is ever written there. If writing it fails: a closed pipe ends passh by SIGPIPE (the default action; status 141 in a shell, e.g. `passh export … | true`); any other error (a full disk, `> /dev/full`) → `passh: write /dev/stdout: <reason>`, exit 1. A failed write to stderr is ignored. The data is the same in every language, except three reports meant for people: the `doctor` report (level and check names, messages), the `import pass` report, and the prose after `rollback` in `verify --full`.
- **stderr** carries one message per line or group of lines, escaped with S4 (multi-line form):

  | Kind | Form | Example |
  |---|---|---|
  | status, confirmation, hint | the text alone | `Saved work/github.` |
  | note | `passh: <text>`; the notes of `verify` and `backups` begin their text with `note: ` (`passh: note: …`), the others don't | `passh: no tags` |
  | warning | `passh: warning: <text>` | `passh: warning: --ttl was not applied: …` |
  | error (once, at exit) | `passh: <text>` | `passh: work/x: not found` |
  | usage error | the error, then `Run 'passh --help' or 'passh <command> --help' for usage.` | |

  If core dumps can't be turned off (S7), every command starts with `passh: warning: disabling core dumps: <OS error>` (e.g. `operation not permitted`).
- **/dev/tty** carries prompts and what belongs to them: explanations before a prompt (`Choose the new passphrase.`), retries (`Wrong passphrase. Try again.`), the rollback question, the editor warning, `doctor`'s clipboard test line, the print page dialog, and OSC 52 sequences. Never stdout or stderr.
- Every path or value from the vault or an imported store is escaped (S4) except by `show --raw` and by `show --field` when stdout is not a terminal; the form each output uses is listed in [agent-session.md §A9.1](agent-session.md#a91-s4-escaping-must).
- `--help` output and the version go to stdout, exit 0.

### 1.4 Exit statuses

| Status | When |
|---|---|
| 0 | Success. Also: `ls`/`ls --tag` with no match (`(no entries)`), `tags` with no tags, `backups` with none, `lock` with no agent, `unlock` with an agent already running, `edit` with no change, `copy` ended by a signal after the clear, `import pass` with skipped files, `doctor` with only warnings, `verify` with notes, `verify --full` of an older copy |
| 1 | Every error not listed below, with `passh: <message>` on stderr. Includes invalid paths, folders, tags and `--field` names; not found; vault locked; wrong passphrase; damaged file; declined or mistyped confirmations (`not deleted`, `not confirmed…`, rollback "no"); a refused terminal on stdout; `verify` FAILED; `doctor` with at least one `error` (no extra message); a print page that ended without serving; Ctrl-C typed at a raw-mode prompt (`interrupted`) |
| 2 | Usage errors, listed exhaustively below |
| 128 + n | Signal n (SIGHUP → 129, SIGINT → 130, SIGTERM → 143) while passh waits at a `/dev/tty` prompt (terminal restored first; message `… interrupted (<signal name>)`), or ending the TUI (locked first) |
| (signal) | A signal at any other moment ends passh with the default action, except: `copy` (clears, exit 0), the print page dialog (stops the server, exit 1), the external editor (exit 1, [agent-session.md §A6](agent-session.md#a6-external-editor-edit---editor-spec-56-s1)) |

Ctrl-C typed at a raw-mode prompt (passphrase, new passphrase, entry password, paper key) is a key, not a signal: `… interrupted`, exit 1. At a cooked prompt (username, URL, tags, notes, y/n, typed phrase, file name) the terminal turns it into SIGINT: exit 130.

The statuses after a signal, and 1 rather than 2 for invalid paths, folders, tags and fields, are an open question ([spec.md §14](../../spec.md#14-open-questions)).

**Usage errors (exit 2):**

- unknown command: `unknown command "<x>" for passh` (or `for "passh <cmd>"`); `recovery-key` or `import` without a subcommand (``say what to do, e.g. `passh recovery-key print` ``, ``say what to import from, e.g. `passh import pass` ``);
- flags ([1.1](#11-parsing)): `unknown flag: --x`, `unknown shorthand flag: 'x' in -x`, `flag needs an argument: --x`, `invalid argument "<v>" for "<flag>" flag: <reason>` (a bool or duration that doesn't parse, a *strings* value that isn't CSV), `bad flag syntax: <f>`;
- argument count: `accepts <n> arg(s), received <m>`, `accepts between <lo> and <hi> arg(s), received <m>`;
- `generate`: `len` not an integer 1–4096; `unlock`: `--ttl` ≤ 0; `tag`: neither `--add` nor `--remove`;
- `export`: `--format` missing or unknown, `--age` with `--confirm-plaintext`, `--spreadsheet-safe` without csv;
- `print`: invalid `--fields`, `--web` with `--confirm-plaintext`; `print` and `recovery-key print`: `--output` with `--web`, the removed hidden `--format` flag (`PDF output was removed; use --web to print from a browser (it can save as PDF), or omit --format for the text sheet`);
- `__agent` run by hand ([2.27](#227-__agent-hidden)).

### 1.5 The vault key

Commands that need it (§5.1): `ls`, `find`, `show`, `copy`, `add`, `generate`, `edit`, `mv`, `rm`, `tag`, `tags`, `recovery-key print`, `verify --full`, `import pass` (`--dry-run` too: it finds conflicts), `export`, `print`, the TUI. Arguments and flags are checked first, so a bad path or flag never asks for the passphrase.

Sources, in order ([agent-session.md §A2.8](agent-session.md#a28-where-the-key-comes-from-spec-51)): the vault's agent; else, with a terminal, `Passphrase: ` on `/dev/tty`, up to 3 tries, `Wrong passphrase. Try again.` before each retry, then `<abs>: wrong passphrase, or the key block is damaged` (an empty passphrase counts as a try; the message is that of the last try, so a last empty one ends with `passphrase is empty`, without a path); a key block that asks for a scrypt work factor above 2^18 ends at the first try, without retries: `<abs>: key block asks for scrypt work factor 2^<n>; passh uses 2^18: the file is damaged or not made by passh` and the second line below; else ``vault is locked: run `passh unlock` in a terminal (over SSH: `ssh -t host passh unlock`)``, exit 1. Only `unlock` starts an agent. `passwd`, `rekey` and `unlock` always ask for the passphrase; `recover` takes the paper key; `init` makes a new key.

After opening:

- Notes of the lenient parse (§4.5), once per command: `passh: warning: <abs>: ignored 1 line of text before the passh-vault line` (likewise `… after the last END line`).
- A damaged key block (`… file is damaged (block 1 …)`) gets a second line: ``The key block only protects the vault key with the passphrase: if the data block is intact, `passh recover` with the paper recovery key writes a new key block`` (for a refused scrypt work factor, plus `; or restore a backup (passh backups)`).
- Rollback (§4.10), except for `verify --full` and files in the backups folder: with a terminal, `warning: <text>` and `Continue with this copy? [y/N] ` on `/dev/tty`; no or empty → `stopped: this copy is older than one seen before on this machine; nothing was changed`, exit 1. Without a terminal, `passh: warning: <text>` and the command goes on.

A command that changes the vault saves once (§4.6). A file changed since it was opened gives `vault changed on disk after it was opened (another passh, a sync tool or a copy); nothing was saved: reload and repeat the change` (exit 1; only `edit` offers a reload, [2.8](#28-edit)); a busy save lock gives `vault is being saved by another passh process; nothing was saved: try again`; a vault inside the backups folder opens but refuses to save (`this is an automatic backup: copy it out first (e.g. over the vault file) and open the copy`).

### 1.6 Prompts

Mechanics (raw and cooked modes, editing keys, limits, signals): [agent-session.md §A4](agent-session.md#a4-terminal-io-devtty). The prompts the commands use:

| Prompt (on `/dev/tty`) | Mode | Command |
|---|---|---|
| `Passphrase: ` | raw | every command of [1.5](#15-the-vault-key), `unlock` |
| `Current passphrase: ` | raw | `passwd`, `rekey` |
| `New passphrase: `, `Repeat passphrase: ` | raw pair; empty refused; strength warning after the first | `init`, `passwd`, `rekey`, `recover` |
| `Password (empty to generate): `, `Repeat password: ` | raw pair; empty = generate, no repeat | `add` |
| `> ` per line, `*` per character | raw, masked | `recover` |
| `Username: `, `URL: `, `Tags (comma-separated): `, notes lines | cooked | `add` |
| `<question> [y/N] ` / `[Y/n] ` | cooked | `rm`, rollback, `init`, `edit` |
| `Type <PHRASE> to confirm: ` | cooked, one try | `recovery-key print` (`PRINT RECOVERY KEY`), `export`/`print` plaintext (`EXPORT PLAINTEXT`), `print --web` (`PRINT`), `recovery-key print --web` (`PRINT RECOVERY KEY`) |
| `Write the text sheet to [<default>]: ` | cooked | `init` |

Strength warning (§5.4), printed between the two prompts, never a refusal: `warning: weak passphrase: <reason>; use 6 or more random words` (or `warning: weak passphrase; use 6 or more random words`). zxcvbn score < 3 is weak; the first 100 characters are judged, with `passh`, `vault`, `$USER` and the host name as user inputs.

### 1.7 Without a terminal

"Terminal" means that `/dev/tty` opens and is a terminal; redirected stdin or stdout don't matter, except where the table says so.

| Command | Without a terminal |
|---|---|
| Commands of [1.5](#15-the-vault-key) | Work through a running agent; else `vault is locked: …`, exit 1 |
| `passh` (TUI) | ``the TUI needs a terminal: run passh in one (over SSH: `ssh -t host passh`); without a terminal, use the commands (passh --help) after `passh unlock` `` |
| `init`, `add`, `edit`, `recover`, `recovery-key print` | ``passh <cmd> needs a terminal (over SSH: use `ssh -t`)`` |
| `passwd`, `rekey` | ``passh passwd needs the current passphrase, typed on a terminal; the agent's key isn't enough to change the passphrase or the vault key (over SSH: `ssh -t host passh passwd`)``, also with an agent |
| `unlock` | An agent serving the current key block: reports it, exit 0; else ``passh unlock needs a terminal to ask for the passphrase (over SSH: `ssh -t host passh unlock`)`` |
| `rm` | Needs `--force`: `passh rm asks for confirmation on a terminal: run it in one, or add --force` |
| `copy` | Only with `clipboard.command` (OSC 52 needs the terminal); else the hint error of [2.6](#26-copy) |
| `export`, `print` (plaintext) | Need `--confirm-plaintext` ([import-export.md §2.1](import-export.md#21-flags-and-order-of-checks)); `print`: `printing needs confirmation: without a terminal, add --confirm-plaintext` |
| `print --web`, `recovery-key print --web` | ``the print page needs a terminal (over SSH: use `ssh -t`)`` |
| `doctor` | Runs; `terminal` is `info`, `clipboard` is `skip` |
| `ls`, `find`, `show`, `generate`, `mv`, `tag`, `tags`, `verify`, `backup`, `backups`, `lock`, `import pass`, `version` | No terminal needed (gpg may need one for its pinentry) |

Where stdout itself matters: `show --field` (escaping and final newline), and `export`, `print`, `recovery-key print` without `-o`, which refuse a terminal stdout. `import pass` shows progress only when stderr is a terminal.

### 1.8 Paths, folders, tags, fields

- `<path>`, `<src>`, `<dst>`: the §4.4 validator; failure `invalid path: <rule>`, exit 1 (e.g. `invalid path: it has an empty segment (//)`). `[folder]` and `--folder`: the same rules, `invalid folder: <rule>`; a trailing `/` is refused (`invalid folder: it ends with /`).
- A path can be an entry and a folder at once (`work` and `work/github`).
- Missing entry: `<path>: not found`; if the path is a folder: ``<path> is a folder, not an entry: list it with `passh ls <path>` ``.
- Tags (`--tag`, `--add`, `--remove`, the `add` prompt): trimmed, NFC, non-empty, no comma, no control character (Cc); else exit 1 with `invalid tag: a tag can't be empty`, `invalid tag "<t>": it contains a comma` (a CSV-quoted `--tag '"a,b"'`), `invalid tag "<t>": it contains a control character` or `invalid tag "<t>": not valid UTF-8` (`<t>` Go-quoted). Several `--tag` must all match. (A CSV syntax error in a *strings* value is a usage error instead, [1.1](#11-parsing).)
- Field names (`show --field`, `copy --field`), case-sensitive: `password`, `username`, `url`, `tags` (joined with `, `), `notes`, else the first custom field with exactly that key. Custom fields keyed `password` or `notes` are shadowed. Unknown: `<path> has no field "<f>"`, exit 1.

## 2. Commands

| Command | Arguments | Key | Terminal | stdout |
|---|---|---|---|---|
| `passh` | – | yes | yes | – (TUI on `/dev/tty`) |
| `init` | – | new | yes | – |
| `ls` | `[folder]` | yes | – | tree |
| `find` | `<query>` | yes | – | paths |
| `show` | `<path>` | yes | – | text form or one value |
| `copy` | `<path>` | yes | for OSC 52 | – |
| `add` | `<path>` | yes | yes | – |
| `generate` | `<path> [len]` | yes | – | – |
| `edit` | `<path>` | yes | yes | – |
| `mv` | `<src> <dst>` | yes | – | – |
| `rm` | `<path>` | yes | without `-f` | – |
| `tag` | `<path>` | yes | – | – |
| `tags` | – | yes | – | tag counts |
| `unlock` | – | passphrase | yes | – |
| `lock` | – | – | – | – |
| `passwd`, `rekey` | – | passphrase | yes | – |
| `recover` | – | paper key | yes | – |
| `recovery-key print` | – | yes | yes | sheet, if no `-o` |
| `verify` | `[file]` | with `--full` | – | report |
| `backup` | `<dest>` | – | – | report |
| `backups` | – | – | – | list |
| `import pass` | `[dir]` | yes | – | report |
| `export` | – | yes | for plaintext | data, if no `-o` |
| `print` | – | yes | for plaintext, `--web` | sheet, if no `-o` |
| `doctor` | – | – | – | report |
| `version`, `help` | –, `[command…]` | – | – | version, help |

### 2.1 `passh` (TUI)

No arguments (else `unknown command`). Checks, in order: config and vault file ([1.2](#12-global-flags-config-and-vault): `no config file at …`, `config <abs>: …`, ``no vault at <file>: run `passh init` to create one, or pass --vault <file>``), terminal ([1.7](#17-without-a-terminal)); then the TUI ([tui.md](tui.md)). Because the CLI checks these first, the TUI's own messages for a missing vault ([tui.md §1.1](tui.md#11-start)) don't appear when it is started as `passh`. Exit 0 on quit; 128 + n after a signal (locked first); 1 after "no" to the rollback question or another error.

### 2.2 `init`

`passh init [--vault file]`. No arguments.

1. Locate the config file ([1.2](#12-global-flags-config-and-vault)). If it exists it must be valid (else exit 1); its `vault` is the default target.
2. Target: `--vault`, else the config's `vault`, else `$XDG_DATA_HOME/passh/vault.passh` (`~/.local/share/passh/vault.passh`).
3. Anything at the target (even a dangling symlink): `<file> already exists; passh init doesn't overwrite a vault`, exit 1.
4. Terminal required.
5. On `/dev/tty`: `Creating the vault <file>.` and `Choose a passphrase: 6 or more random words are best.`, then the new-passphrase pair.
6. Create the vault (missing parent folders 0700; [storage.md](storage.md)). stderr: `Created the vault <file>.`
7. Config file:
   - none: write it at the located path (parent folder 0700, file 0600, both reduced by the umask, [storage.md §1.2](storage.md#12-every-path-passh-creates); never overwriting): the §3.3 example verbatim with its comments, `vault` set to the new vault as a TOML basic string, `~/…` under `$HOME`. stderr: `Wrote the config file <file>.` Failure: `the vault was created, but the config file wasn't: <error>`, exit 1.
   - exists and names another vault: stderr `The config file <file> exists and wasn't changed; it names the vault <file>.` and `Use --vault <file> with each command, or change vault in the config file.`
   - exists and names this vault: nothing.
8. `Print the recovery key now? [Y/n] `.
   - No, or no valid answer (end of input, 3 invalid answers): stderr, exit 0 (`<file>` in the second line is literally `<file>`, a placeholder):
     ```
     Print the paper recovery key now and keep the sheet offline:
       passh recovery-key print -o <file>   (or --web, with the key as a QR code)
     Without it, a forgotten passphrase means the data is lost.
     ```
   - Yes: `Write the text sheet to [<default>]: ` (empty answer = default: `/dev/shm/passh-recovery.txt` when `/dev/shm` is tmpfs, else `~/passh-recovery.txt`). The file must not exist (`<file> already exists; passh doesn't overwrite files`, asked again, 3 tries). Then `Type PRINT RECOVERY KEY to confirm: `. The sheet ([print.md](print.md)) is written as `-o` files are ([2.17](#217-recovery-key-print)). stderr: `Wrote the paper recovery key to <file>.`, `passh: print it, keep the sheet offline, then delete the file: rm <file>` (shell-quoted) and `For a version with the key as a QR code: passh recovery-key print --web`.
   - Any failure in this step: ``the vault was created, but the recovery sheet wasn't written: <error>; run `passh recovery-key print` later``, exit 1 (the vault and config stay); a signal: 128 + n.

### 2.3 `ls`

`passh ls [folder] [--tag t]…`

| Flag | Type | Meaning |
|---|---|---|
| `--tag` | strings | Only entries with every given tag |

Folder and tags are validated before unlocking. Output on stdout:

```
~/.local/share/passh/vault.passh
├── bank/
│   └── My Bank
├── work/
│   ├── a b'c
│   └── github
├── work
└── x/
    └── y
```

- Header line: the vault file (`<file>`); with a folder, `<folder>/`; with tags, the header is followed by two spaces and `(tag <t1>, <t2>)` (normalized tags in the order given): `work/  (tag 2fa)`.
- Then the matching entries as a tree, relative to the folder. Folders end with `/`. At each level, items are sorted by name in byte order (UTF-8 of the NFC name; `My Bank` before `homelab`); a folder sorts before an entry of the same name. Branches are `├── ` and, for the last item, `└── `; children are indented by `│   ` or, under a last item, four spaces.
- No match: the header, then `(no entries)`, exit 0.
- `ls <folder>` when no entry inside `<folder>` has all the given tags (or none lies inside), in this order: if `<folder>` is itself an entry with all the given tags, print just its path, escaped single-line, and a newline (no header, exit 0; also when `<folder>` is a folder too and only the entry has the tags); else, if any entry lies inside `<folder>`, the header and `(no entries)`, exit 0; else `<folder>: no such folder`, exit 1 (also for an entry without the tags: `ls work/github --tag x`).

### 2.4 `find`

`passh find <query>`. One line per matching entry on stdout: `<path>`, or `<path>  (tag <tag>)` when the entry matched best through a tag; path and tag escaped single-line.

Matching, with the score of [Fuzzy matching](#fuzzy-matching):

1. The query is used as given: not normalized to NFC, not trimmed (a space is a pattern character). An empty query matches nothing. Paths are stored in NFC, so a decomposed query (`cafe` + U+0301) doesn't match `café` (known issue, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)).
2. Every entry's path is scored as its stored string (not its escaped form): score *p*.
3. The distinct tags are scored once each, as a list in order of first appearance (entries in path order, segment by segment; each entry's tags in stored order). A tag with score *t* counts for every entry that has it as *t* − 1.
4. An entry's hit is its path match, if any. Its tags are then tried by score, highest first (equal scores in list order); a tag replaces the hit only if *t* − 1 is strictly greater. So a tag is named only when *t* ≥ *p* + 2 or the path doesn't match, and of an entry's tags with the best score the first **in the list** is named, which need not be the entry's own first tag (entry `a` tagged `gx2, gx1`, entry `b` tagged `gx1, gx2`: `find gx` prints `a  (tag gx2)` and `b  (tag gx2)`).
5. Sorted by the hit's score (*p*, or *t* − 1), highest first, then by path segment by segment in byte order (`work/x` < `work-old/y`); paths are unique, so the order is total.

No match: `no entry matches <query>`, the query Go-quoted (`no entry matches "a\"b"`), exit 1.

Example: entries `github` (tag `gh`), `work/github`, `work/gitlab` (tag `zz-gh`); `passh find gh` prints `github  (tag gh)` (path 6, tag 15 − 1 = 14), `work/gitlab  (tag zz-gh)` (no path match, tag 7 − 1 = 6), `work/github` (path −4).

The TUI search ([tui.md §5.4](tui.md#54-search)) uses the same score, but counts a tag at *t* (named when *t* ≥ *p* + 1, and ranking one point higher than here), breaks ties by plain byte order of the whole path, and lists every entry for an empty or blank query. Both say "a path match of equal quality wins"; the two rankings differ by accident (known issues, including #18, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)).

### 2.5 `show`

`passh show <path> [--field f] [--raw]`

| Flag | Type | Meaning |
|---|---|---|
| `--field` | string | One value ([1.8](#18-paths-folders-tags-fields)); `--field ""` asks for a custom field with an empty key |
| `--raw` | bool | Exact bytes, no escaping |

| Form | stdout |
|---|---|
| default | the text form (§4.3, [vault-format.md](vault-format.md)), escaped with S4 (multi-line) whether stdout is a terminal or not |
| `--raw` | the text form, exact bytes |
| `--field f`, stdout a terminal | the value escaped (multi-line), then `\n` |
| `--field f`, stdout not a terminal, or with `--raw` | the exact value, **no final newline** (`… --field password \| pbcopy`) |

The value of `--field` is the stored value byte for byte, nothing added or removed: `tags` is the tags joined with `, ` (`work, dev`, no final newline), `notes` is the stored notes with their line feeds (none is appended). An empty standard field prints an empty value (on a terminal: just `\n`). A path that is both an entry and a folder shows the entry.

### 2.6 `copy`

`passh copy <path> [--field f]`

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--field` | string | `password` | Field to copy ([1.8](#18-paths-folders-tags-fields)) |

Order: path; config; clipboard method, before unlocking (none: `no clipboard: <reason>; copy with: passh show <path> --field <field> | pbcopy`, exit 1, without asking for the passphrase); key; entry and field (`<path>: the <field> is empty; nothing was copied` for an empty value, exit 1). The vault is closed before the wait. Then on stderr `Copied the <field> of <path> (<method>); the clipboard clears in <D>, Ctrl-C clears it now.`, where `<method>` is `OSC 52 through the terminal` or `command "<argv joined by spaces>"`; after `clipboard.clear_after`, the clear and `Clipboard cleared.`, exit 0. SIGINT, SIGTERM or SIGHUP during the wait clear at once, `Clipboard cleared.`, exit 0. A failed clear: exit 1. The value is never printed. Details: [agent-session.md §A5](agent-session.md#a5-clipboard-spec-63-s6).

### 2.7 `add`

`passh add <path> [-f|--force]`

| Flag | Type | Meaning |
|---|---|---|
| `-f`, `--force` | bool | Replace an existing entry (its id, `created_at` and the entry's unknown JSON keys stay) |

Order: path; terminal; key; an existing path without `--force`: ``<path> already exists: use --force to replace it``, exit 1, before any prompt. Then on `/dev/tty`:

1. `Password (empty to generate): ` / `Repeat password: `. Mismatch: `Passwords don't match. Try again.`; after 3, `passwords don't match`, exit 1. Empty: a generated password (24 letters and digits, [import-export.md §3](import-export.md#3-password-generator-s3)).
2. `Username: `, `URL: ` (end of input = empty).
3. `Tags (comma-separated): `; an invalid list prints the error and asks again; after the third invalid list the command fails with that error (`invalid tag …`, [1.8](#18-paths-folders-tags-fields)), exit 1, nothing saved.
4. `Notes (end with an empty line):`, then lines until an empty line or end of input; joined with `\n`.

stderr: `Generated a 24-character password.` (only when generated), then `Saved <path>.`

With `--force`, the typed content replaces the old entry's content entirely: its custom fields (and their unknown JSON keys) are dropped, since the prompts can't enter any. Content identical to the old entry's: nothing is saved (no new revision, no backup), but `Saved <path>.` is printed, exit 0.

### 2.8 `edit`

`passh edit <path> [--editor]`

| Flag | Type | Meaning |
|---|---|---|
| `--editor` | bool | Edit the text form in `$EDITOR` instead of the built-in form |

Order: path; terminal; with `--editor`, the editor is looked up before unlocking (`$EDITOR`, `$VISUAL`, `vi`); without a tmpfs base, note `passh: <reason>; using the built-in form instead` and the form is used (S1); key; entry.

- Built-in form ([tui.md](tui.md)): ctrl+s saves, esc cancels, ctrl+r reveals the password, ctrl+g generates one.
- `--editor` ([agent-session.md §A6](agent-session.md#a6-external-editor-edit---editor-spec-56-s1)): for an editor passh can't make leak-safe, `warning: passh can't control backup, swap or history files of <name>: …` on `/dev/tty` first. Invalid text: `The entry isn't valid: <error>` and `Edit it again? [Y/n] `.

Results: unchanged → `No change.`, exit 0; cancelled form → `cancelled; nothing was saved`, exit 1; other failure (editor exit status, declined retry, signal) → `nothing was saved: <error>`, exit 1; saved → `Saved <path>.`

If the vault changed on disk since it was opened: `The vault changed on disk since it was opened; reload and apply your edit again? [y/N] `. Yes reloads and applies the edited values (password, username, url, tags, fields, notes) to the same entry, found by id under its current path, and saves again (3 save attempts in all). No → `not saved: the vault changed on disk since it was opened`; entry gone → `not saved: <path> was deleted or replaced in the vault on disk`; exit 1.

### 2.9 `generate`

`passh generate <path> [len] [--symbols] [-f|--force]`: checks, generator, and its exact stderr message in [import-export.md §3.3](import-export.md#33-passh-generate-path-len---symbols--f--force). No terminal needed; stdout stays empty; the password is never printed.

### 2.10 `mv`

`passh mv <src> <dst>`

- `<src>` goes through the path validator as it is: `work/` is refused (`invalid path: it ends with /`).
- A `<dst>` ending in `/` means "into that folder": exactly one trailing `/` is removed, then `/` + the last segment of `<src>` is appended, and the result is validated (`a//` → `a//x` → `invalid path: it has an empty segment (//)`; `/` → `/x` → `invalid path: it starts with /`). Without it, `<dst>` is the new full path, even when a folder of that name exists (`passh mv work/new bank` makes the entry `bank` beside the folder `bank/`).
- If `<src>` is an entry, it moves (id kept, `updated_at` = now). Taken destination: `<dst>: already exists`, exit 1 (also for `<dst>` = `<src>`). stderr: `Moved <src> to <dst>.`
- Else `<src>` is a folder: every entry under it moves to `<dst>` + the rest of its path, in one save, each with `updated_at` = now. With `<dst>/`, that is `<dst>/<last segment of src>/…` (`passh mv work archive/` moves `work/github` to `archive/work/github`). No entry: `<src>: not found`; `<dst>` equal to or inside `<src>`: `can't move the folder <src> into itself`; any destination taken: `<path>: already exists` and nothing moves; exit 1. stderr: `Moved the folder <src>/ to <dst>/ (<n> entries).` (`1 entry`). The entries move one by one in path order, and a destination counts as taken also when it is held by an entry of the same move that hasn't moved yet: with `m/b/x` and `m/b/b/x`, `passh mv m/b m` fails with `m/b/x: already exists` although the result would be valid (known issue, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)).
- An entry named exactly `<src>` wins over a folder of that name.

### 2.11 `rm`

`passh rm <path> [-f|--force]`

| Flag | Type | Meaning |
|---|---|---|
| `-f`, `--force` | bool | Don't ask (needed without a terminal) |

Order: path; terminal unless `--force`; key; entry ([1.8](#18-paths-folders-tags-fields); folders can't be removed); `Delete <path>? [y/N] `: no or empty → `not deleted`, exit 1. stderr: `Deleted <path>.` The entry gets a tombstone (§4.2).

### 2.12 `tag`

`passh tag <path> [--add t]… [--remove t]…`

| Flag | Type | Meaning |
|---|---|---|
| `--add` | strings | Tags to add, appended after the existing ones |
| `--remove` | strings | Tags to remove; an absent one is ignored |

Neither flag: `give --add and/or --remove`, exit 2. Removal is applied after addition (`--add x --remove x` leaves no `x`); duplicates are dropped, keeping the first. stderr, one of: `<path>: tags <t1>, <t2>`, `<path>: tags <t1>, <t2> (unchanged)`, `<path>: no tags`, `<path>: no tags (unchanged)`. Nothing is saved when unchanged.

### 2.13 `tags`

`passh tags`. stdout: one line per tag, sorted by tag in byte order: the tag (escaped single-line) left-aligned and padded with spaces to the longest tag, two spaces, the number of entries with it. Lengths are counted in Unicode code points of the escaped text: not bytes, not grapheme clusters, not display columns (a combining mark counts 1, a wide CJK character counts 1, U+200B, escaped `\u200b`, counts 6).

```
2fa   1
bank  1
work  12
```

No tags: nothing on stdout, `passh: no tags` on stderr, exit 0.

### 2.14 `unlock`

`passh unlock [--ttl d]`

| Flag | Type | Meaning |
|---|---|---|
| `--ttl` | duration | Maximum lifetime of a new agent, instead of `agent.max_ttl`; must be > 0 (else exit 2) |

Flow and messages: [agent-session.md §A2.3](agent-session.md#a23-starting-passh-unlock---ttl-d). User-visible results on stderr, all exit 0:

- new agent: `Unlocked <file>: <times>.` and ``Run `passh lock` to stop the agent now.``;
- agent already serving this key block (no terminal needed, its idle time restarts): `Already unlocked: <times>.`, plus with `--ttl` ``passh: warning: --ttl was not applied: the agent was already running; run `passh lock`, then `passh unlock --ttl …` ``;
- agent of an older key block: `passh: the running agent was unlocked with another key block (passwd elsewhere?); replacing it`, then the passphrase as for a new agent.

`<times>` = `the agent (pid <n>) exits in <D> if unused, in <D> at the latest`, or `the agent (pid <n>) exits in <D>` when the idle time left isn't shorter than the maximum left.

### 2.15 `lock`

`passh lock`. Config and vault file must exist (the socket is named by the vault's real path; [agent-session.md §A2.9](agent-session.md#a29-passh-lock-and-stale-agents)). stderr: `Locked: the agent (pid <n>) stopped.` or `No agent is running for <file>.`; both exit 0.

### 2.16 `passwd`, `rekey`

`passh passwd`, `passh rekey`. No arguments, no flags.

1. Terminal required, also with an agent running ([1.7](#17-without-a-terminal)).
2. Open with `Current passphrase: ` (never the agent; 3 tries; rollback question as usual).
3. On `/dev/tty`: `Choose the new passphrase.` (`passwd`) or `Choose the passphrase for the new vault key (it may be the same as before).` (`rekey`); the new-passphrase pair.
4. Save (§4.6, §5.4). stderr:
   - `passwd`: `Passphrase changed. The paper recovery key stays valid.` / `Copies and backups made before still open with the old passphrase.`
   - `rekey`: `The vault has a new key. The old passphrase and the old paper recovery key` / `no longer open new versions of it; copies made before still open with them.` / `Print a new paper recovery key now: passh recovery-key print`
5. The vault's agent, if running, is stopped ([agent-session.md §A2.9](agent-session.md#a29-passh-lock-and-stale-agents)): ``The agent was unlocked with the old key block and was stopped; run `passh unlock` again if you need it.`` (`rekey`: `The agent held the old key and was stopped; …`). A failed stop only warns.

### 2.17 `recovery-key print`

`passh recovery-key print [-o file] [--web]`. `passh recovery-key` alone is a usage error.

| Flag | Type | Meaning |
|---|---|---|
| `-o`, `--output` | string | New file (mode 0600) instead of stdout; not with `--web` |
| `--web` | bool | Show the sheet on the print page (§7.4) |

Text sheet, in order: flags; config; destination: `-o` must not exist (`<file> already exists; passh doesn't overwrite files`, also for a dangling symlink), without `-o` stdout must not be a terminal (`refusing to write the recovery key to a terminal: add -o file or redirect stdout`); terminal (``passh recovery-key print needs a terminal (over SSH: use `ssh -t`)``); `Type PRINT RECOVERY KEY to confirm: `; key ([1.5](#15-the-vault-key), the agent counts); the sheet ([print.md](print.md)) on stdout or into the file (`O_CREAT|O_EXCL`, 0600, fsynced; a failed write removes the partial file). stderr: with a file off tmpfs, `passh: warning: <file> isn't on tmpfs: the plaintext is on persistent disk. Delete it when you're done`; then `Wrote the paper recovery key to <file>.` (`… to stdout.`); with a file, `passh: print it, keep the sheet offline, then delete the file: rm <file>`.

`--web`: `print_web.enabled` (else `the print page is off: set enabled = true in the [print_web] table of the config file`, exit 1); terminal; `Type PRINT RECOVERY KEY to confirm: `; key; the print page dialog ([2.24](#224-print)).

### 2.18 `recover`

`passh recover [--vault file]`. No arguments.

1. Terminal; config and vault file.
2. On `/dev/tty`: `Type the recovery key from the paper sheet (AGE-SECRET-KEY-1…); it shows as *.` / `Spaces, line breaks and letter case don't matter. End with an empty line.`, then masked lines with the prompt `> `. Spaces, line breaks, hyphens and case are ignored; the bech32 checksum catches typos. An invalid key: `<error>. Type it again.`, 3 tries; empty input fails at once (exit 1).
3. Open the vault with that key (no agent, no passphrase). A key block too damaged to parse is accepted here. Rollback question as usual. Wrong key: `this recovery key doesn't open <file>: it belongs to another vault, or the vault was rekeyed after the sheet was printed`, exit 1. This is the only text `recover` prints for a key that doesn't open the data block; the generic `<path>: this key doesn't open this vault (rekeyed elsewhere? wrong recovery key?)` of [storage.md](storage.md) is never shown by the CLI.
4. `The recovery key opens the vault. Choose a new passphrase.`, the new-passphrase pair; a new key block is written (the vault key stays).
5. stderr: `New passphrase set for <file>. The paper recovery key stays valid.`; the agent is stopped as after `passwd`.

### 2.19 `verify`

`passh verify [file] [--full]`

| Flag | Type | Meaning |
|---|---|---|
| `--full` | bool | Also decrypt and check the data |

`[file]` needs no config file (a config file that exists, or one named by `--config`, must still be valid); without it, the config's vault. The file must be a regular file of at most 64 MiB (`<file> is not a regular file`, `<file> is larger than 64 MiB: not a passh vault`); a missing file gives the operating system's error. stdout:

```
~/backup/vault.passh: OK
  SHA-256   9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430635ab
  size      5863 bytes
```

- Line 1: `<file>: OK` or `<file>: FAILED`. SHA-256 (lower-case hex) and size are of the file's bytes as they are. Labels are padded to 10 columns after two spaces, as shown.
- Structure check: §4.5 without decrypting ([vault-format.md](vault-format.md)). FAILED: the three lines, then `passh: <file>: <problem>` (e.g. `file is truncated: block 2 has no END line`, `not a passh vault`), exit 1.
- stderr notes after an OK: `passh: note: <lenient warning>` for each (e.g. `passh: note: ignored 1 line of text before the passh-vault line`), and for a file not in canonical form ``passh: note: the file isn't in passh's canonical form (line endings or line wrapping changed in copying); it opens, and `passh backup` writes a canonical copy``.

`--full` then opens the file ([1.5](#15-the-vault-key); agents asked: the file's own, then the configured vault's, if it is another existing file; never the rollback question) and adds:

```
  vault_id  0f6c1d2e-9a4b-4c11-8f00-5d2a7e3b9c10
  revision  42
  saved_at  2026-11-15 12:00:00 UTC
  entries   37
  rollback  OK: the newest revision seen on this machine (r42)
```

`vault_id` is escaped single-line. `saved_at` is UTC, `YYYY-MM-DD HH:MM:SS UTC`; data without `saved_at` (or `null`) shows `0001-01-01 00:00:00 UTC`. The `rollback` value (translated) depends on the rollback record (§4.10, [storage.md](storage.md)); `rollback.warn` doesn't change it, and a file in the backups folder gets it like any other:

| Record | `rollback` value | stderr, record |
|---|---|---|
| no entry for this `vault_id` (or no file) | `this machine hasn't seen this vault before` | entry added |
| same revision | `OK: the newest revision seen on this machine (r<n>)` | – |
| lower revision | `OK: newer than seen before on this machine (r<seen>)` | raised to this revision |
| higher revision | `OLDER than seen before on this machine (seen r<seen> of <YYYY-MM-DD of the recorded saved_at>)` | `passh: warning: this copy is older …` (the §4.10 text), also with `rollback.warn = false` (known issue, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)); not changed; exit 0 |
| damaged (not JSON, or `version` < 1) | `this machine hasn't seen this vault before` | `passh: warning: the rollback record <abs> is damaged; a new one is started, so older copies aren't detected this time`; replaced by a record holding only this vault |
| `version` > 1 | `this machine hasn't seen this vault before` | `passh: warning: the rollback record can't be used, so older copies aren't detected: <abs> was written by a newer passh (version <n>)`; left alone |
| unreadable | `this machine hasn't seen this vault before` | `… can't be used, so older copies aren't detected: open <abs>: permission denied`; left alone |

Every case, stdout and exit status:

| Case | stdout | stderr | Exit |
|---|---|---|---|
| no `[file]` and the configured vault is missing | – | ``no vault at <file>: run `passh init` to create one, or pass --vault <file>`` | 1 |
| `[file]` missing | – | `stat <abs>: no such file or directory` | 1 |
| not a regular file (folder, FIFO, device; a symlink is followed) | – | `<file> is not a regular file` | 1 |
| larger than 64 MiB | – | `<file> is larger than 64 MiB: not a passh vault` | 1 |
| can't be read | – | the OS error, e.g. `open <abs>: permission denied` | 1 |
| structure check fails | `<file>: FAILED`, `SHA-256`, `size` | `<file>: <problem>` | 1 |
| structure OK, no `--full` | `<file>: OK`, `SHA-256`, `size` | the notes | 0 |
| `--full`, and opening fails (vault locked, wrong passphrase, damaged data, newer format…) | the same three lines, nothing more | the notes, then the open error (`vault is locked: …`, `<abs>: wrong passphrase, or the key block is damaged`, …) | 1 |
| `--full` opens | the three lines and the five above | the notes; each lenient warning once more as `passh: warning: <abs>: …` (known issue #13 of the audit); the rollback lines above | 0 |

### 2.20 `backup`

`passh backup <dest>`. No passphrase.

- The source is the configured vault (`--vault` replaces it); it must exist (`no vault at <file>: …`).
- `<dest>` is an existing folder (a symlink to a folder counts; the copy goes into the target, but messages show the path as given): the copy is `<dest>/<vault name without .passh>-<YYYYMMDD-HHMMSS UTC>.passh` (`vault-20261115-120000.passh`). `<dest>` ending in `/` but not a folder (also a dangling symlink): `<file>: no such folder`, exit 1. Otherwise `<dest>` is the file. Anything already there, a dangling symlink included: `<abs>: a file already exists there; passh doesn't overwrite files`, exit 1.
- Copy, check and canonical rewrite: [storage.md](storage.md) (§4.8). The read-back compares the copy with the bytes passh meant to write: the source's bytes when it is in canonical form, else its canonical re-encoding; so the read-back error `<abs> (SHA-256 <got>, expected <want>): the copy didn't read back as written; nothing was written under its name` has `<want>` = SHA-256 of those bytes, which differs from the source's SHA-256 for a non-canonical source. The lenient-parse warnings of the source (ignored lines) are not printed; the copy simply doesn't have those lines.
- stderr `Backed up <file> to <file>.`; stdout `<dest>: OK` and the `SHA-256` and `size` lines of [2.19](#219-verify) for the copy; stderr ``The copy is byte for byte the vault; `passh verify` shows the same SHA-256 for both.``, or for a vault not in canonical form `The vault isn't in canonical form, so the copy was written in canonical form;` / `its SHA-256 differs from the vault's, and the stock age tool reads its blocks (§8).`

### 2.21 `backups`

`passh backups`. Needs the config (or `--vault`), not the passphrase, and not the vault file. stdout, newest first by the backup counter (§4.7) within each vault; when every backup on the machine is listed, grouped by vault (the `vault_id` folder name, byte order), each group newest first ([storage.md](storage.md)):

```
2026-11-15 12:00:31  r42  ~/.local/state/passh/backups/0f6c…/00000042-20261115T120031Z-r42.passh
```

`<UTC time from the name, YYYY-MM-DD HH:MM:SS>  r<revision>  <file>`. Which backups are this vault's: [storage.md](storage.md). Notes on stderr: a missing or unreadable vault → `passh: note: <file> can't be read (<OS error>); listing every automatic backup on this machine` (e.g. `(stat <abs>: no such file or directory)`), exit 0; no backup recognized → `passh: note: no backup has this vault's current key block (it was changed by passwd or rekey and not saved since, or the file is damaged); listing every automatic backup on this machine`. None: stdout empty, stderr `No automatic backups yet. passh makes one before each save (backup.keep = <n>).`, exit 0.

### 2.22 `import pass`

`passh import pass [dir] [--overwrite] [--dry-run]`; flags are bool. Flow, report on stdout, progress on stderr: [import-export.md §1](import-export.md#1-import-from-pass-49). Exit 0 even with skipped files; a failed save: `nothing was imported: <error>`, exit 1.

### 2.23 `export`

`passh export --format <csv|json|bitwarden-json> [--tag t]… [--folder f] [-o|--output file] [--age recipient | --confirm-plaintext] [--spreadsheet-safe]`. Flag types: `--format`, `--folder`, `-o`, `--age` string; `--tag` strings; `--confirm-plaintext`, `--spreadsheet-safe` bool. Checks, prompt, exit statuses and stderr: [import-export.md §2.1](import-export.md#21-flags-and-order-of-checks).

### 2.24 `print`

`passh print [--tag t]… [--folder f] [--fields list] [-o|--output file] [--confirm-plaintext]` and `passh print --web [--tag t]… [--folder f] [--fields list]`.

| Flag | Type | Meaning |
|---|---|---|
| `--tag` | strings | All must match |
| `--folder` | string | One folder |
| `--fields` | string | Comma-separated; default `password,username,url`; also `tags`, `notes`, `fields` or a custom key. Invalid → exit 2 |
| `-o`, `--output` | string | New file (0600); not with `--web` |
| `--confirm-plaintext` | bool | Confirmation without a terminal; not with `--web` (exit 2) |
| `--web` | bool | The print page (§7.4) |

Text sheet, in order: flags, folder, tags, fields; config; destination (as [2.17](#217-recovery-key-print), with `refusing to write the sheet to a terminal: add -o file or redirect stdout`); confirmation as a plaintext export (with a terminal always `The sheet holds your passwords unencrypted.` and `Type EXPORT PLAINTEXT to confirm: `); key; sheet ([print.md](print.md)). stderr: the tmpfs warning for a file, then `passh: printed <n> entries (text sheet) to <file|stdout>; print it, then delete the file` (`1 entry`).

`--web`, in order: flags; `print_web.enabled`; terminal; `Type PRINT to confirm: `; key; then the dialog on `/dev/tty`: the URLs with QR codes, `certificate SHA-256  <fingerprint>`, `c copies the URL · Esc stops` and a countdown line; `c` copies the first URL to the clipboard (scheduled clear); Esc, `q` or Ctrl-C stop; SIGINT, SIGHUP and SIGTERM stop too. Served: stderr `Done: <result>.`, exit 0; any other end (stopped, expired, too many wrong tokens, partly sent, signal): `passh: <result>`, exit 1. Results and page: [print.md](print.md).

### 2.25 `doctor`

`passh doctor`. Read-only: it fixes nothing; only the clipboard test writes (to the clipboard). Runs every check, then prints the report on stdout:

```
ok     config        ~/.config/passh/config.toml
ok     vault         ~/.local/share/passh/vault.passh: structure OK, 5863 bytes
warn   swap          1 swap area is active (975 MiB): process memory, …
skip   clipboard     not tested without a terminal: run `passh doctor` in one (over SSH: ssh -t)
0 errors, 1 warning.
```

- Line: level, two spaces, check name, two spaces, message. The level column is as wide as the longest level name of the language (en: 5), the check column as wide as the longest check name present in this report (code points, not bytes). Messages are escaped (S4, multi-line form, each message as a whole).
- One line per finding. Rows come in the order of the table below (by #), and a check's findings in the order the table lists them; a check with several findings repeats its name on each line (e.g. `ok vault …` then `info vault …`).
- Levels: `ok`, `info`, `skip`, `warn`, `error`. Last line: `<n> errors, <m> warnings.` (`1 error`, `1 warning`).
- Exit 1 if at least one `error` (nothing else on stderr), else 0.
- Sizes: ≥ 1 GiB `%.1f GiB` (a `.` as decimal point), ≥ 1 MiB `<n> MiB`, ≥ 1 KiB `<n> KiB` (MiB and KiB rounded down), else `<n> bytes` (`1 byte`).
- Normative: the layout, the level and check names (translated per `language`, [i18n.md](i18n.md)), the row order, the summary line and the exit status. Not normative: the wording of the messages; the texts below are the reference's English.

| # | Check name(s) | Inspects | Findings (level: message) |
|---|---|---|---|
| 1 | `config` | config resolution ([1.2](#12-global-flags-config-and-vault)) | error: the resolution error (row 2 is then the `skip`, and `clipboard` too); ok: `<config file>`; info: `no config file at <file>; using --vault and the defaults`; plus info `--vault overrides the config's vault` when a config file and `--vault` are both used |
| 2 | `vault` | the vault path: lstat, symlink, read (regular, ≤ 64 MiB), structure as `verify` | skip: `no config, so no vault to check`; error: ``<file> doesn't exist: run `passh init`, or point the config's vault at your vault file``; info: `<file> is a symlink to <file>; saves write the target`; error: an unresolvable symlink (`<file> is a symlink that can't be resolved: <error>`) or a read error (`<file>: <error>`, where `<error>` is `<file> is not a regular file`, `<file> is larger than 64 MiB: not a passh vault` or an OS error, so the path may appear twice); ok: `<file>: structure OK, <n> bytes`; error: `<file>: <problem> (SHA-256 <hex>)`; info: each lenient warning; info: `not in canonical form (line endings or wrapping changed); it opens, and the next save rewrites it`. Rows 3–5 and `agent folder` appear only when the file was read (a structure error still counts as read) |
| 3 | `vault mode` | permission bits of the file (followed) | ok: `0600`; warn when group or others have any bit, info otherwise (e.g. 0400): `mode <0nnn>, not 0600: fix it with chmod 600 <file>` |
| 4 | `vault folder` | folder of the resolved path, `access(W_OK\|X_OK)` | ok: `<dir> is writable`; error: `<dir> isn't writable (<error>): saving needs a temporary file there` |
| 5 | `temp files` | `.<name>.tmp-*` beside the vault (§4.6) | ok: `none`; warn: `<n> files left by an interrupted save (<names>); the next save removes them` (`1 file`); warn: `can't list the vault's folder: <error>` |
| 6 | `state folder` | `$XDG_STATE_HOME/passh` (lstat) | info: `<dir> doesn't exist yet; the first save creates it`; error: `<dir> is not a folder (backups, locks and the agent's socket go there)`, `<dir> belongs to uid <n>, not to you`, `<dir> isn't writable: <error>`, another lstat error `<dir>: <error>`, or the error finding the folder (`$HOME` unset or relative); warn: `<dir> has mode <0nnn>: other users can look inside (the backups are encrypted); chmod 700 is better`; ok: `<dir>` |
| 7 | `agent folder`, `agent` | the agent's socket folder and a status request (which doesn't restart the idle time) | skip (`agent`, the only row when row 2 didn't read the file): `no vault to check the agent for`; `agent folder` info: ``<dir> doesn't exist yet; `passh unlock` creates it``, error: the folder check ([agent-session.md §A2.2](agent-session.md#a22-agent-folder-must)) or socket path error, ok: `<dir> (0700, yours)`; `agent` info: ``not running (`passh unlock` starts it)``, info: `running: <times>` ([2.14](#214-unlock)), error: any other failure |
| 8 | `memory` | Linux: `MemAvailable` in `/proc/meminfo`; macOS: `hw.memsize` (total); other: skip `not checked on this system` | ok: `<size> available (unlock needs 256 MiB)`; warn (< 256 MiB): `<size> available: unlock needs 256 MiB for scrypt and may fail or swap`; macOS: `in total` instead of `available`, plus `; available memory isn't checked on macOS`; skip: `can't read the available memory: <error>` (macOS: `can't read the memory size: <error>`) |
| 9 | `swap` | Linux: `/proc/swaps`; macOS: `vm.swapusage` | Linux ok: `no swap is active`; warn: `<n> swap area(s) is/are active (<total size>): process memory, decrypted secrets included, may be written to disk. passh doesn't change this; turn swap off or encrypt it if that matters to you`. macOS ok: `no swap is in use`; info: `swap is active (<used> used) and encrypted by macOS`; warn: `swap is active (<used> used) and not encrypted: process memory, decrypted secrets included, may be written to disk`. skip: `can't read /proc/swaps: <error>` (macOS: `can't read vm.swapusage: <error>`); other systems: skip `not checked on this system` |
| 10 | `core dumps` | `RLIMIT_CORE` of the process (S7) | ok: `disabled for passh and the agent`; warn: `not disabled: a crash could write secrets to a core file`; warn: `reading core dump limit: <error>` |
| 11 | `terminal` | `/dev/tty` | ok: `/dev/tty: passphrase prompts work`; info: ``none: prompts are impossible, so commands need the agent (`passh unlock` in a terminal)`` |
| 12 | `edit temp` | `passh-edit-*` folders left by `edit --editor` ([agent-session.md §A6](agent-session.md#a6-external-editor-edit---editor-spec-56-s1)) | ok: ``no files left by an interrupted `edit --editor` ``; warn: ``left by an interrupted `edit --editor`, possibly with an entry in plain text: <dirs>; delete them (rm -r)`` |
| 13 | `clipboard` | sends `passh clipboard test`, waits min(`clipboard.clear_after`, 5 s), clears | skip: `no config, so no clipboard settings to check`; skip: ``not tested without a terminal: run `passh doctor` in one (over SSH: ssh -t)``; info, one per variable, in this order: `$TMUX` set → ``inside tmux: OSC 52 needs `set -g set-clipboard on` in ~/.tmux.conf``, `$STY` set → `inside GNU screen: screen doesn't pass OSC 52 to the terminal; set clipboard.command or run passh outside screen`, `TERM_PROGRAM=Apple_Terminal` → `Terminal.app has no OSC 52: set clipboard.command = ["pbcopy"]`; warn: `no clipboard: <reason>; copy with: passh show <path> --field password \| pbcopy` (literally `<path>`); error: an unusable `clipboard.command` or a failed copy or clear; ok: `sent a test string with OSC 52 through the terminal and cleared it; if pasting gave "passh clipboard test", copying works` (with a command: `sent a test string with command "<cmd>" and cleared it; …`) |

Before the test, `/dev/tty` gets `Testing the clipboard: copied "passh clipboard test" (<method>). Paste it somewhere to check; it is cleared in <D>.`; the report itself is printed after all checks.

### 2.26 `version`, `--version`, `help`

- `passh version`, `passh --version`, `passh -v`: stdout `passh <version>\n`, exit 0. `<version>` is `dev` unless set at build time; release builds use GoReleaser's `{{ .Version }}` (the tag without its leading `v`, e.g. `passh 1.0.0`). `passh version <x>` is a usage error.
- `passh help [command…]` = `passh <command…> --help`, on stdout, exit 0. An unknown topic prints the root help (`passh help lss`, exit 0); words after a known command are ignored (`passh help ls extra` = `passh ls --help`).
- Not normative: the content and layout of help texts; scripts must not parse them. *Informative:* the reference uses cobra's default layout: `Long` (or `Short`), `Usage:`, `Available Commands:` (hidden ones left out), `Flags:`, `Global Flags:`, the closing `Use "passh [command] --help" …` line; flag lines as pflag prints them, with `(default …)` for non-zero defaults, translated ([i18n.md](i18n.md)).

### 2.27 `__agent` (hidden)

The agent process ([agent-session.md §A2.3](agent-session.md#a23-starting-passh-unlock---ttl-d)): not listed in help, its arguments not parsed by the command line, no config loaded, English. Run by hand (fd 3 isn't a pipe): stderr ``passh: __agent is started by `passh unlock`, not by hand``, exit 2.

### 2.28 Not in v1

`passh merge` (§4.11, v1.1) doesn't exist: `unknown command "merge" for passh`, exit 2.

## 3. Environment

| Variable | Use |
|---|---|
| `HOME` | `~` expansion and `~/` in messages; XDG fallbacks |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` | config file, default vault (`init`), state folder; ignored unless absolute |
| `XDG_RUNTIME_DIR`, `TMPDIR` | `edit --editor` base; agent socket fallback ([agent-session.md §A2.1](agent-session.md#a21-socket-location-must)) |
| `PASSH_CONFIG` | config file ([1.2](#12-global-flags-config-and-vault)) |
| `EDITOR`, `VISUAL` | `edit --editor` |
| `PASSWORD_STORE_DIR`, `GPG_TTY` | `import pass` |
| `USER` | passphrase strength check input |
| `TMUX`, `STY`, `TERM_PROGRAM` | `doctor` clipboard notes |

No variable carries a secret (S2).

## Fuzzy matching

The match and score of `passh find` ([2.4](#24-find)) and of the TUI search ([tui.md §5.4](tui.md#54-search)). *Informative:* the reference is sahilm/fuzzy v0.1.3 (`fuzzy.Find`); the rules below are its behaviour, and the vectors were computed with it.

A pattern P matches a string S when P's characters occur in S in order. Both are UTF-8. P is split into Unicode code points. S is read character by character; a byte that isn't valid UTF-8 is one character (U+FFFD) of one byte; S ends at its first U+0000 (paths and tags have none). **Positions are byte offsets** into S. Two characters match when they are equal or in the same Unicode simple case-folding orbit (`k`, `K` and U+212A KELVIN SIGN; `s`, `S` and U+017F): no normalization, no full case folding (`ß` doesn't match `ss`). Upper and lower case are the categories Lu and Ll.

```
if P is empty: no match
k = 0                       # current pattern character
total = 0; chosen = []      # byte offsets chosen so far
best = -1; at = -1          # best candidate for P[k]
run = 0                     # adjacency bonus so far; never reset
prev = none; prevAt = 0     # previous character of S and its offset
for each character c of S, at byte offset j; next = the character after c, or none at the end:
    if c matches P[k]:
        s = 0
        if j == 0:                                       s += 10
        if prev is Ll and c is Lu:                       s += 20    # camelCase
        if j > 0 and prev is one of  / - _ space . \ :   s += 20    # after a separator
        if chosen is not empty and prevAt == last(chosen):          # right after the last choice
            b = 2*run + 5; s += b; run += b
        if s > best: best = s; at = j                    # equal scores keep the earlier one
    if (k < len(P)-1 and next matches P[k+1]) or next is none:
        if at >= 0:                                      # choose P[k]'s position
            if chosen is empty: best += max(-5*at, -15)  # leading penalty, at most -15
            total += best; append at to chosen
            best = -1; at = -1; k += 1
    prev = c; prevAt = j
if len(chosen) < len(P): no match
score = total + len(chosen) - (length of S in bytes)     # -1 per byte not chosen
```

So each pattern character takes its best-scoring position among the candidates seen until the character after the current one matches the next pattern character; the last pattern character takes the best one in the rest of S. The adjacency bonus grows 5, 15, 45, 135, … over a run of adjacent choices, and it also grows when an adjacent candidate is seen but beaten (vector `abc`/`abx_bc`). Multi-byte characters count by bytes in both penalties, by character in the bonus tests. Ties between strings are ordered by the caller ([2.4](#24-find), tui.md §5.4).

| P | S | Score | Chosen offsets |
|---|---|---|---|
| `gh` | `github` | 6 | 0, 3 |
| `gh` | `work/github` | −4 | 5, 8 |
| `wg` | `work/github` | 21 | 0, 5 |
| `GIT` | `work/github` | 17 | 5, 6, 7 |
| `tk` | `The Black Knight` | 16 | 0, 10 |
| `abcd` | `abcd` | 75 | 0, 1, 2, 3 |
| `abcd` | `abXcd` | 29 | 0, 1, 3, 4 |
| `abc` | `abx_bc` | 42 (10 + 20 + 15 − 3: `b` at 1 is adjacent, +5, but `b` at 4 after `_` wins; `c` then gets 2·5 + 5) | 0, 4, 5 |
| `gh` | `myGitHub` | 24 | 2, 5 |
| `aa` | `banana` | −9 | 1, 3 |
| `b` | `éb` | −12 | 2 |
| `z` | `abcdz` | −19 | 4 |
| `k` | U+212A + `elvin` | 3 | 0 |
| `é` (U+00E9) | `café` (NFC) | −19 | 3 |
| `e` + U+0301 | `café` (NFC) | no match | |
| `ba` | `ab` | no match | |
| ` ` (one space) | `a b` | −7 | 1 |
