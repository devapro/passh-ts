# passh — Specification

> Working name: **passh** ("pass, but nicer").
> Status: Draft v0.6 · Owner: Arsenii · Date: 2026-11-16

---

## Changelog

| Version | Changes |
|---|---|
| v0.6 | **No GnuPG, no git, no pass compatibility** (owner decision). The store is now one self-contained text file, `vault.passh`, encrypted with age in two layers: a vault key protected by the passphrase, and the data encrypted to that key (ADR-6). Entry names and tags are encrypted too. **Added:** reliable saving (atomic write with a read-back check, change detection, automatic backups), `verify`, `backup`, `backups`, `passwd`, `rekey`, a paper recovery key with `recover`, a passh agent started by `unlock` in place of gpg-agent (ADR-8), and a one-way `import pass`. **Removed:** the pass layout and `.gpg-id`, the tag index and `reindex`, git and `sync`, the `archive` export and `--encrypt-to`, the `[git]` and `[gpg]` config sections. TOTP moves to v1.1. **Also:** an optional rollback warning (`[rollback]`, §4.10), the design of `passh merge` for v1.1 (§4.11), and the agent's socket in the state folder, not `$XDG_RUNTIME_DIR` (§5.3). Closes open questions 2–4 of v0.5. The v0.5 design is kept in `archive/`. **2026-11-16:** the text was aligned with the implementation after an audit, normative appendices with the exact formats and behaviour were added in `docs/spec/` (§1.1), and the questions the audit raised are in §14 |
| v0.5 | Plain CLI tool on a pass-compatible store (superseded by v0.6) |
| v0.4 | Print page, Docker deployment, config/remote admin commands (superseded by v0.5) |
| v0.3 | Second security review: restricted SSH model, signed history, bundled key (superseded by v0.5) |
| v0.2 | First security review |
| v0.1 | Initial draft |

---

## 1. Summary

passh is a single Go binary for managing passwords kept in **one encrypted file**. You install one file, run `passh init`, and run `passh` like any other command. It works wherever the file is: on your laptop, or on a server you reach with a normal `ssh`. It needs no other software: no GnuPG, no git.

The vault file:

- is one text file that you can copy anywhere, with any tool, and check after copying;
- opens with your passphrase alone, or with a paper recovery key if you forget the passphrase;
- encrypts everything, including entry names and tags;
- opens with the standard `age` tool if passh is ever gone.

passh offers:

- a TUI for browsing by folder (category) and tag;
- copying to the clipboard, also over SSH (OSC 52), with clearing after a timeout;
- locking after a period of inactivity, and an agent that keeps the vault unlocked for a limited time for scripts and SSH;
- a one-way import from a `pass` store;
- export (CSV / JSON / Bitwarden JSON) and printing (a text sheet, and a one-shot print page that opens in a browser on the LAN or VPN).

### 1.1 Appendices (normative)

This document gives the design and its intent. The appendices in [`docs/spec/`](docs/spec/) define the exact formats and behaviour of the reference implementation (passh v1): byte layouts, messages, prompts, the order of checks, exit statuses and edge cases. They are part of the specification, and a compatible re-implementation follows them.

Precedence:

- Where an appendix marks a known issue (⚠ or "known issue", with a link to [docs/reviews/2026-11-16-spec-audit.md](docs/reviews/2026-11-16-spec-audit.md)), a re-implementation may reproduce the current behaviour or the proposed fix. An open question of §14 is the owner's to decide; until then the current behaviour, which the appendices describe, applies.
- Any other disagreement between this document and an appendix is a documentation bug: report it (what, where, which sections), and the owner decides.
- Passages labelled "Informative" or "Not normative" don't bind: they describe choices of the reference implementation (layout numbers, libraries, §10) or say that any behaviour is acceptable.
- Byte-identical output is required only for `language = "en"`; what binds for `ru` and `sr` is in [i18n.md](docs/spec/i18n.md).

| Appendix | Covers |
|---|---|
| [vault-format.md](docs/spec/vault-format.md) | The vault file byte for byte: the container and its lenient parse, the key and data blocks, the data JSON and its validation, the entry text form, the path rules, the recovery key format (§4.1–§4.5, §5.4, §8) |
| [storage.md](docs/spec/storage.md) | Files and folders on disk, the config file, opening, saving step by step, automatic backups, `backup` and `verify`, the rollback record (§3.2, §3.3, §4.5–§4.8, §4.10) |
| [agent-session.md](docs/spec/agent-session.md) | The agent (socket, start, protocol, lifetime), where the vault key comes from, prompts on `/dev/tty`, the clipboard, the external editor, starting processes, hardening, how S1–S9 are met (§5.1, §5.3, §5.5, §5.6, §6.3) |
| [cli.md](docs/spec/cli.md) | Every command: arguments, flags, prompts and their order, stdout formats, stderr messages, exit statuses, the `doctor` checks (§6.1) |
| [import-export.md](docs/spec/import-export.md) | `import pass`, the export formats byte for byte, `--age`, the password generator (§4.9, §7.1, §7.3, S3) |
| [tui.md](docs/spec/tui.md) | The TUI and the built-in entry form: screens, keys, layout, locking, reload, print setup and dialog (§5.2, §5.6, §6.2) |
| [print.md](docs/spec/print.md) | The text sheet, the recovery key sheet and the print page: layout, pagination, server, certificate, requests, HTML and CSS (§5.4, §7.2, §7.4) |
| [i18n.md](docs/spec/i18n.md) | The `language` setting: how it is chosen, what is translated, plurals, yes/no answers, errors (§3.3) |

## 2. Goals and non-goals

### Goals

| # | Goal |
|---|------|
| G1 | One static Go binary for `linux/amd64`, `linux/arm64`, `linux/arm/v7`, `darwin/amd64` and `darwin/arm64` |
| G2 | Setup is: copy the binary, run `passh init`. No root, no other software, no changes to the system (§3.2) |
| G3 | A portable vault: one file that survives any way of copying, can be checked after copying, and opens on any machine with the passphrase or the paper recovery key, even without passh (§4.8, §8) |
| G4 | Works the same locally and over SSH |
| G5 | Browse and search by folder and by tag in a TUI |
| G6 | Export and printing for migration and paper backup, including printing from a browser without saving a file |
| G7 | A one-way migration from `pass` |

### Non-goals (v1)

- Browser extensions, mobile autofill, native mobile apps
- Multi-user sharing, roles, per-device rights
- Web UI or HTTP API. The only exception is the one-shot print page (§7.4)
- Server mode, system services, SSH configuration, containers
- Compatibility with `pass` beyond the one-way import
- Merging copies of the vault edited on different machines: planned for v1.1 (§4.11)
- TOTP (planned for v1.1); import from other password managers
- Protection against an attacker who controls your user account
- Windows

## 3. Installation and configuration

### 3.1 Install

Copy the `passh` binary into a folder on your `PATH`, e.g. `~/.local/bin`, and run `passh init` (§5.4).

passh has no runtime dependencies. `gpg` is needed only for a one-time `passh import pass` (§4.9).

### 3.2 System footprint

passh **doesn't change the system**. It writes only to these places:

| Path | What passh writes there |
|---|---|
| The vault file (`vault` in the config; `passh init` defaults to `$XDG_DATA_HOME/passh/vault.passh`, by default `~/.local/share/passh/vault.passh`) | The vault. During a save, a temporary file `.<name>.tmp-<random>` in the same folder (§4.6). Rarely, a conflict file `<base>.conflict-<stamp>[-N].passh` beside the vault: the other version, when another program replaced the vault during a save's final rename (§4.6) |
| The config file (§3.3) | Created by `passh init` only if it doesn't exist; never rewritten after that |
| `$XDG_STATE_HOME/passh/` (default `~/.local/state/passh/`) | Automatic backups (§4.7), lock files, the highest revision seen for each vault (§4.10), the agent's socket in `agent/` (§5.3), the print page certificate and key (§7.4) |
| `passh-<uid>/` in `$TMPDIR` or `/tmp`, only when the state folder's path is too long for a socket | The agent's socket (§5.3) |
| A temporary folder on tmpfs | Only for `edit --editor` (§5.6); deleted afterwards |

passh never:

- needs root;
- writes system files or other users' files;
- changes shell startup files or other programs' settings (gpg, git, ssh);
- installs services or cron jobs;
- touches firewall, swap or SSH settings;
- installs anything into OS or browser certificate stores.

**Background processes:** the only process that outlives a command is the agent, and only after an explicit `passh unlock`. It exits by itself after `agent.idle_ttl` without use or `agent.max_ttl` in total, or on `passh lock` (§5.3). The print page server runs inside the passh process.

**Uninstall:** delete the binary, the config file and `~/.local/state/passh/` (it holds the automatic backups; keep them if you like). The vault file stays where it is.

Every path, name and mode: [storage.md §1](docs/spec/storage.md#1-folders-and-files-32).

### 3.3 Config file

Location, first match wins:

1. `--config <file>`;
2. `$PASSH_CONFIG`;
3. `$XDG_CONFIG_HOME/passh/config.toml` (default `~/.config/passh/config.toml`).

Only `vault` is required; `passh init` writes it:

```toml
vault    = "~/.local/share/passh/vault.passh"
language = "en"         # en, ru or sr (Serbian, Latin script)

[session]
idle_ttl   = "5m"       # TUI locks after this much inactivity
stop_agent = true       # a TUI lock also stops the agent (§5.3)

[agent]                 # started only by `passh unlock` (§5.3)
idle_ttl = "15m"        # exits after this long without a request
max_ttl  = "2h"         # and after this long in any case

[backup]
keep = 10               # previous versions kept in ~/.local/state/passh/backups/ (0 = off)

[rollback]
warn = true             # warn when a vault is older than one seen before (§4.10)

[clipboard]
clear_after = "30s"
osc52       = true      # copy through the terminal (works over SSH)
command     = []        # optional local tool instead, e.g. ["pbcopy"] or ["wl-copy"]

[print_web]             # §7.4; off unless enabled
enabled    = false
port       = 8443
interfaces = ["wg0", "eth0"]
allow_from = []         # extra CIDR limit; default = subnets of the bound addresses
hostnames  = []         # optional names for the certificate, e.g. ["pi.local"]
ttl        = "5m"       # 1–15 min
```

- `--vault <file>` overrides `vault` for one command. With `--vault`, passh works without a config file.
- A missing config file makes passh print how to create one (`passh init`).
- Unknown keys are an error, so typos don't go unnoticed.
- `print_web.allow_from`, when not empty, **replaces** the default (the subnets of the bound addresses); it isn't an extra limit on top of it, whatever the comment above says (§7.4; open question in §14).
- `language` sets the language of everything passh writes for people: messages, prompts, errors, `--help`, the TUI, the text sheet, the recovery key sheet and the print page (CONFIDENTIAL included), and the reports for people on stdout: `doctor`, the `import pass` report and the prose of the `rollback` line of `verify --full`. The default is `en`; `ru` is Russian, `sr` is Serbian in Latin script; any other value is an error. What scripts or passh itself read is the same in every language: data on stdout (`ls`, `find`, `tags`, `show`, `export`, …), command, flag, field and config key names, and the phrases typed to confirm (`PRINT RECOVERY KEY`, `EXPORT PLAINTEXT`, `PRINT`). Error text from the operating system or a library may stay in English. Without a config file that loads (`--vault` only, before `passh init`, or a config file that exists but has an error), passh uses English. Byte-identical output is required only in English: for `ru` and `sr` the specification fixes what is translated and what isn't, the plural rules, the yes/no answers, the glossary terms and the fixed strings the appendices list (e.g. the sheet frame), not the wording of other messages.

Exact parsing, defaults and messages: [storage.md §2](docs/spec/storage.md#2-config-file-33); languages: [i18n.md](docs/spec/i18n.md).

## 4. Storage

### 4.1 Vault file

The vault is one text file (ASCII in practice), mode 0600. Default location (`passh init`): `$XDG_DATA_HOME/passh/vault.passh`, by default `~/.local/share/passh/vault.passh`. Byte-level format: [vault-format.md](docs/spec/vault-format.md).

```
passh-vault 1
-----BEGIN AGE ENCRYPTED FILE-----
(key block: the vault key, encrypted with the passphrase)
-----END AGE ENCRYPTED FILE-----
-----BEGIN AGE ENCRYPTED FILE-----
(data block: all entries as JSON, encrypted to the vault key)
-----END AGE ENCRYPTED FILE-----
```

- **Line 1** is the magic string and the container version.
- **Key block:** an age file encrypted with the passphrase (age's scrypt recipient with work factor 2^18, which is age's default; there is no lighter setting, even for small devices; a key block that asks for a higher factor is refused before scrypt runs, so a tampered file can't exhaust a small device's memory). Its plaintext is the **vault key**: a random age X25519 identity (`AGE-SECRET-KEY-1…`) on one line, that is, a valid age identity file.
- **Data block:** an age file encrypted to the vault key. Its plaintext is the JSON of §4.2.
- Both blocks use age's ASCII armor (base64, 64 columns), so the file is plain text and the standard `age` tool reads each block (§8).
- **The vault key's public half (the `age1…` recipient) is never written anywhere** (S9). age doesn't authenticate who encrypted a file: anyone who knows the recipient could build a data block that decrypts. Because the recipient stays secret, only a holder of the vault key can produce a valid data block.
- Only the file's name and size are visible from outside.

### 4.2 Data format

The plaintext of the data block:

```json
{
  "format": "passh-vault-data",
  "version": 1,
  "vault_id": "0f6c1d2e-…",
  "revision": 42,
  "saved_at": "2026-11-15T12:00:00Z",
  "entries": [
    {
      "id": "8d1e7a90-…",
      "path": "work/github",
      "password": "s3cr3t-P@ss",
      "username": "arsenii",
      "url": "https://github.com",
      "tags": ["work", "dev", "2fa"],
      "fields": [ { "key": "recovery-email", "value": "me@example.com" } ],
      "notes": "Free-form notes. Recovery codes, etc.",
      "created_at": "2026-11-01T09:00:00Z",
      "updated_at": "2026-11-15T12:00:00Z"
    }
  ],
  "deleted": [
    { "id": "3b9f…", "deleted_at": "2026-11-10T18:30:00Z" }
  ]
}
```

- `vault_id` is random, set by `init` and never changed, not even by `rekey`. `revision` grows by 1 on every save.
- Each entry has a random `id` that stays the same across edits and moves, plus `created_at` and `updated_at`.
- `fields` holds the other `key: value` pairs as an ordered list; keys may repeat. `otp` is reserved for TOTP (v1.1); its values and `otpauth://` values are masked like passwords.
- `deleted` keeps a tombstone (only `id` and time, no data) for each removed entry, so `passh merge` can tell "deleted here" from "added there" (§4.11).
- Unknown keys, at any level, are kept on save, so an older passh doesn't drop what a newer one wrote. A `version` higher than passh knows is refused with "made by a newer passh".
- The data is checked on every open and before every save. `password`, `username`, `url` and field values are single lines; tags are normalized to NFC, trimmed and de-duplicated (§4.4); no custom field is named `username`, `url` or `tags` (in any case). Data that breaks a rule is invalid ("data is damaged", §4.5). A later passh that relaxes a rule (multi-line values, fewer reserved keys, new value types) MUST raise the data `version`, so that this version refuses such data as newer instead of reporting it as damaged.
- Opening and reading never rewrite the file. Only changes save it (§4.6).

Schema, validation, serialization and how each operation changes the data: [vault-format.md §4](docs/spec/vault-format.md#4-data-42).

### 4.3 Entry text form

`show`, `show --raw`, `edit --editor` and `import pass` use the familiar pass-style text form:

```
s3cr3t-P@ss
username: arsenii
url: https://github.com
tags: work, dev, 2fa
recovery-email: me@example.com
---
Free-form notes. Recovery codes, etc.
```

- Line 1 is the password, followed by `key: value` metadata, then free-form notes.
- Metadata ends at a `---` line or at the first line that doesn't match `key: value`. Everything after that is notes.
- `username`, `url` and `tags` map to their JSON fields; other keys go to `fields`, in order.

Exact grammar for writing and reading: [vault-format.md §5](docs/spec/vault-format.md#5-entry-text-form-43).

### 4.4 Paths, folders and tags

- An entry's `path` is `folder/…/name`. **Folders = categories**, as in pass. A folder exists while it holds entries.
- Every path from the user or from an import goes through one validator:
  - segments are separated by `/`, none is empty, and there is no leading or trailing `/`;
  - no `.` or `..` segments, and no segment starts with `-`;
  - no control characters; Unicode is normalized to NFC; at most 1024 bytes.
- Paths are unique and case-sensitive.
- Tags are stored in the entries. After unlock the whole vault is in memory, so listing by tag needs no index.
- Tags are normalized to NFC and trimmed, non-empty, with no commas or control characters; an entry's duplicate tags are dropped, the first kept.

Validator rules and messages, folder semantics and sort order: [vault-format.md §6](docs/spec/vault-format.md#6-paths-and-folders-44).

### 4.5 Opening

passh is lenient about the outside of the file and strict about its content. A copy that passed through email, a text editor or another OS still opens; a damaged copy never opens partly.

**Lenient.** Before parsing, passh:

- accepts LF, CRLF and CR line endings and a UTF-8 BOM, and trims whitespace around lines;
- re-joins each block's base64 whatever the line length, because mail clients and editors re-wrap lines;
- ignores text before the `passh-vault` line and after the last `END` line, with a warning.

**Strict.** passh refuses the file and says why:

| Problem | Message |
|---|---|
| No `passh-vault` line | not a passh vault |
| Container or data `version` higher than known | made by a newer passh; upgrade passh |
| The file ends early: it is empty, ends inside the `passh-vault` line, or ends before a block or its `END` line | file is truncated |
| Bad base64 or age header, a missing or damaged `BEGIN` line, or an `END` line missing before the next `BEGIN` line | file is damaged (block 1 or 2) |
| The key block doesn't decrypt | wrong passphrase, or the key block is damaged |
| The data block doesn't decrypt or isn't valid JSON | data is damaged; restore a backup (lists them, §4.7) |

age authenticates every byte of each block and detects truncation, so damage is always reported and passh never shows partial data.

Through the agent (§5.3), a key block that differs from the one unlocked can't be told apart from a `passwd` made elsewhere, so passh asks for the passphrase, or without a terminal reports that the vault is locked. With the agent's key, a data block that doesn't decrypt is reported as damaged data.

passh always writes the canonical form: LF endings, 64-column lines, nothing around the blocks.

The parse step by step, every message, and the checks made without a key: [vault-format.md §2](docs/spec/vault-format.md#2-container-41-45).

### 4.6 Saving

Every change (add, edit, move, delete, tags, `passwd`, `rekey`, `recover`, import) is saved at once as one new revision:

1. Take an exclusive lock (`flock`) in `~/.local/state/passh/locks/`, keyed by the vault's real path, so two passh processes on the machine don't save at the same time. Remove temporary files left by earlier interrupted saves.
2. Read the vault file again and compare its SHA-256 with the one recorded when it was opened. If they differ, another process, a sync tool or a manual copy has changed it. passh then doesn't save; it reports this and keeps your input (the TUI form keeps its values), so you can reload and repeat the change.
3. Serialize the data with `revision` + 1 and encrypt the data block to the vault key. The key block is copied byte for byte, except for `passwd`, `rekey` and `recover`.
4. Write a temporary file `.<name>.tmp-<random>` in the vault's folder, mode 0600, and `fsync` it.
5. Read the temporary file back, parse it, decrypt the data block and compare it with what was written. On any mismatch, delete the temporary file and fail; the vault stays unchanged.
6. Copy the current vault file into the automatic backups (§4.7).
7. `rename` the temporary file over the vault, which is atomic within one filesystem, then `fsync` the folder.

- A save interrupted at any point (crash, power loss, `kill -9`) leaves either the old file or the new one, each complete.
- If the vault path is a symlink, passh writes to its target and keeps the link.
- If another program replaces the vault between step 6 and the `rename`, passh notices it where the file system has an atomic exchange (the `rename` of step 7 is then an exchange): it puts that version back and reports the change as in step 2. If it can't put it back, it keeps that version beside the vault as `<base>.conflict-<stamp>[-N].passh` and names the file.

Locks, every step with its messages, the exchange and the fallbacks for file systems without it: [storage.md §4](docs/spec/storage.md#4-saving-46).

### 4.7 Automatic backups

- Before each save, passh copies the current vault file to `~/.local/state/passh/backups/<vault_id>/<seq>-<UTC time>-r<revision>.passh` and keeps the `backup.keep` most recently made files (default 10; 0 turns this off). `<seq>` is a counter: the highest number in the folder + 1, stored nowhere else, written with at least 8 digits (more once it is larger). It alone decides the order, so a wrong clock or a restored older revision never makes passh delete the newest backups.
- Each backup is a complete vault. It opens with `passh --vault <file>` and the passphrase or paper key that was valid when it was made. A save to a file in the backups folder is refused: copy it out first.
- `passh backups` lists them with time and revision. To go back to one, copy it over the vault file and run `passh verify --full`.
- These backups undo mistakes on this machine. They don't protect against losing the disk, so keep a copy elsewhere (§4.8, §8).

Folder and file names, writing, rotation and the `backups` listing: [storage.md §5](docs/spec/storage.md#5-automatic-backups-47).

### 4.8 Copying and verifying

The vault is built to be copied:

- **Self-contained:** the file plus the passphrase (or the paper key) is all you need. There are no key files, no references to other files, and nothing tied to the machine, OS or CPU.
- **Any channel:** `cp`, `scp`, `rsync`, a USB stick (FAT32 and exFAT are fine), a cloud folder, an email attachment, or text pasted into a note (§4.5).
- **Checked:** damage and truncation are always detected (§4.5).

Commands:

- `passh backup <dest>` copies the vault to a file or folder (default name `<name>-<UTC time>.passh`), `fsync`s it, reads it back and compares it with the bytes it meant to write. It writes a temporary file next to the destination and renames it into place only after the check, so an interrupted copy never leaves a partial file under the final name; an existing file is never overwritten. Those bytes are the vault file's, so the copy has the vault's SHA-256; a vault not in canonical form (§4.5) is copied as its canonical re-encoding instead, whose SHA-256 differs from the vault's (passh says so). It needs no passphrase.
- `passh verify [file]` checks a copy without the passphrase: the `passh-vault` line, both blocks complete, base64 and age headers valid. It prints the file's SHA-256 and size; a byte-exact copy has the same SHA-256 as the original.
- `passh verify --full [file]` also decrypts the copy (through the agent, or by asking for the passphrase) and checks the data. It prints `vault_id`, `revision`, `saved_at` and the entry count.

Outputs and messages of `backup` and `verify`: [storage.md §6](docs/spec/storage.md#6-copying-and-verifying-48).

### 4.9 Import from pass

```
passh import pass [dir] [--overwrite] [--dry-run]
```

- `dir` defaults to `$PASSWORD_STORE_DIR`, then `~/.password-store`. The pass store is only read, never changed.
- passh walks the `*.gpg` files through `os.Root`, so symlinks can't lead outside the store. It skips `.git`, `.gpg-id` and other dot-files and dot-folders.
- Each file is decrypted with `gpg --decrypt`, using your gpg-agent and pinentry as `pass` does (with `GPG_TTY` set). gpg is needed only for this command. Plaintext comes through a pipe and stays in memory.
- Each entry is parsed as text (§4.3). `username:`, `user:` and `login:` become `username`; `otpauth://` lines go to an `otp` field; other keys go to `fields`.
- The path is the file path without `.gpg`. Paths that fail the validator (§4.4) are skipped and reported.
- Paths already in the vault are skipped and listed, unless `--overwrite` is given.
- `--dry-run` lists what would be imported and the conflicts, without decrypting anything.
- The whole import is one save (§4.6). At the end passh prints how many entries were imported and how many were skipped, and why.

Walk, gpg, parsing and the report: [import-export.md §1](docs/spec/import-export.md#1-import-from-pass-49).

### 4.10 Rollback warning

Someone with write access to a copy (a cloud folder, a USB stick) can't forge a vault, but can put back an older valid one. passh warns about that. The warning is on by default; `rollback.warn = false` turns it off.

- For each `vault_id`, passh records the highest `revision` it has opened or saved on this machine, in `~/.local/state/passh/revisions.json`. The file holds only ids, revision numbers and times.
- When a vault opens with a lower `revision` than recorded, passh warns: "this copy is older than one seen before on this machine (r40 of 2026-11-10; seen r42 of 2026-11-15). If you didn't restore it on purpose, the file may have been replaced."
  - With a terminal, passh asks whether to continue. Yes: the lower revision becomes the new record, so the warning doesn't repeat. No: the command exits without changes. In the TUI, No at unlock exits; No at a reload (`R`) refuses the reload: the old data stays, and saving stays blocked.
  - Without a terminal, the warning goes to stderr and the command continues; the record stays unchanged.
- Restoring a backup on purpose (§4.7) triggers the warning once; answer yes.
- No prompt for files in the automatic backups folder, for `verify --full` (it only reports the comparison) or for the other file of `merge`.
- The check works only on a machine that has seen a newer revision. A machine that opens the vault for the first time can't detect a rollback.

The record's format and when it is updated: [storage.md §7](docs/spec/storage.md#7-rollback-record-410). Whether `verify --full` should update it is open (§14).

### 4.11 Merge (v1.1)

```
passh merge <file> [--dry-run]
```

Combines another copy of the same vault into this one: after editing on two machines, or a sync tool's conflict copy (e.g. `vault.sync-conflict-….passh`).

- The other file must have the same `vault_id`; copies of different vaults are refused.
- passh first tries this vault's key on the other file's data block, so a copy with the same vault key needs no extra passphrase. If the other copy was rekeyed, passh asks for its passphrase or paper key. The result always keeps this vault's key block.
- Entries are matched by `id`:

  | Case | Result |
  |---|---|
  | In one copy only, no tombstone in the other | Kept |
  | Identical in both | Kept |
  | Different in both | The later `updated_at` wins; reported as a conflict |
  | An entry in one copy, a tombstone in the other | The later of `updated_at` and `deleted_at` wins, so the entry is kept or deleted; reported |
  | Two different `id`s with the same `path` | Both kept; the one from the other file gets `~2` (or `~3`, …) appended to its name; reported |

- Tombstones from both copies are kept.
- The result is one save (§4.6) with `revision` = the higher of the two + 1. The other file isn't changed; to bring it up to date, copy the merged vault over it.
- `--dry-run` prints the report without saving: entries added, updated and deleted, conflicts and renames, by path. Values are never printed.
- Conflicts are decided by the clocks of two machines, so a wrong clock can pick the wrong side. The losing version stays in the other file and in the automatic backups.

## 5. Session and safety

### 5.1 Unlock

- passh asks for the passphrase itself, on `/dev/tty` with echo off. There is no gpg and no pinentry.
- The passphrase decrypts the key block, which runs scrypt once: about a second on a laptop, a few seconds and 256 MiB of memory on a Raspberry Pi. Everything after that uses the vault key and is fast.
- After unlock, the whole data block is decrypted and kept in memory.
- A command gets the vault key from, in order:
  1. the agent, if one is running for this vault (§5.3);
  2. a passphrase prompt, if there is a terminal (the command doesn't start an agent);
  3. otherwise it fails with "vault is locked: run `passh unlock` in a terminal (over SSH: `ssh -t host passh unlock`)".

How each outcome of the agent is handled: [agent-session.md §A2.8](docs/spec/agent-session.md#a28-where-the-key-comes-from-spec-51).

### 5.2 Lock

The TUI locks when:

- the user presses `L`, except in a text field (the entry form, a prompt, or the search while typing), where `L` is a letter;
- the TUI exits;
- the TUI has been idle for `session.idle_ttl`;
- passh receives SIGHUP, SIGTERM or SIGINT, e.g. when the SSH connection drops.

On lock, passh wipes the decrypted data and the vault key from its memory. If `session.stop_agent` is on, it also stops the agent. A lock by `L`, by the idle timer or by a signal also clears a pending clipboard value at once (§6.3). Quitting the TUI instead waits for the clipboard clear, with a countdown; Ctrl-C clears it at once.

`passh lock` stops the agent. An open TUI keeps its own state until it locks by the rules above.

What a lock does, in order, and what the lock screen reports: [tui.md §10](docs/spec/tui.md#10-locking-52).

### 5.3 Agent

The agent does what gpg-agent did for pass: it keeps the vault unlocked for a limited time, so later commands, including ones without a terminal, don't ask for the passphrase (ADR-8).

- **Start:** only `passh unlock [--ttl d]` starts it. It asks for the passphrase, starts a copy of passh in the background (like `ssh-agent`) and hands it the vault key through a pipe, never in arguments or the environment. If an agent is already running for the same key block, `unlock` reports the time left and restarts its idle timer; an agent holding an older key block (after `passwd` elsewhere) is replaced. No other command, and not the TUI, starts an agent.
- **One agent per vault**, on `~/.local/state/passh/agent/agent-<hash of the vault's real path>.sock` (in `$XDG_STATE_HOME`). The agent folder has mode 0700 and the socket 0600; passh checks that the folder is a real folder (not a symlink) that belongs to the user.
  - The socket isn't in `$XDG_RUNTIME_DIR`: the system removes that folder when the user's last session ends, and the agent must outlive the SSH session that started it.
  - If the path is too long for a Unix socket (more than 103 bytes, the macOS limit, applied on Linux too), passh uses `passh-<uid>/` in `$TMPDIR` or `/tmp` instead, with the same checks.
  - If its socket file is removed or replaced, the agent exits.
- **Access:** the agent answers only processes of the same user, checked with peer credentials (`SO_PEERCRED` on Linux, `getpeereid` on macOS). It gives the vault key to passh commands and never writes it to disk.
- **Lifetime:** the agent exits at the first of:
  - `agent.idle_ttl` (default 15 min) without a request for the key (status requests don't count);
  - `agent.max_ttl` (default 2 h; `unlock --ttl` overrides it) since start;
  - `passh lock`;
  - a TUI lock when `session.stop_agent` is on;
  - `passwd`, `recover` or `rekey` of the vault (§5.4);
  - SIGTERM or SIGINT. It ignores SIGHUP.

  It survives the end of the SSH session that started it; that is its purpose (§6.4).
- On exit it wipes the vault key from memory and removes the socket.

Socket path, folder checks, the start handshake, the protocol and expiry: [agent-session.md §A2](docs/spec/agent-session.md#a2-agent-spec-53).

### 5.4 Passphrase, rekey and recovery key

- `passh init [--vault file]` asks for a new passphrase twice, generates the vault key and `vault_id`, writes an empty vault, and writes the config file if it doesn't exist. It then offers to print the recovery key.
- **Passphrase strength:** `init`, `passwd`, `rekey` and `recover` estimate the passphrase's strength (zxcvbn), warn when it is weak (a score below 3 of 0–4) and suggest 6 or more random words. They don't refuse. A stolen vault file can be attacked offline, so the passphrase is its main protection (§9).
- `passwd` and `rekey` always ask for the current passphrase, even when the agent is running, so a process that can reach the agent can't change the passphrase or replace the vault key.
- `passh passwd` changes the passphrase: it writes a new key block for the same vault key, so the vault key, and with it the paper recovery key, stays valid. Like every change it is a full save (§4.6): `revision` + 1, a new `saved_at`, the data block encrypted again, an automatic backup.
- `passh rekey` makes a new vault key, re-encrypts the data to it and asks for a passphrase (the same or a new one). The old paper key and the old key block no longer open new versions of the file. Use it when the passphrase or the paper key may have leaked.
- `passwd`, `recover` and `rekey` stop the vault's agent, which holds the old key block or key (§5.3); run `passh unlock` again if needed.
- After `passwd` or `rekey`, older copies and backups still open with whatever was valid when they were made.
- **Paper recovery key:** `passh recovery-key print [-o file]` for a text sheet, or `--web` for the print page (§7.4). The sheet holds:
  - the vault key (`AGE-SECRET-KEY-1…`) in groups of four characters, and on the print page also as a QR code;
  - the `vault_id` and the print date;
  - a warning that whoever has the sheet and a copy of the vault can read everything;
  - the manual recovery steps of §8, with the commands byte for byte as there; on `ru` and `sr` sheets only the comment `# asks for the passphrase` is translated.

  Printing it, also with `--web`, needs a terminal and typing `PRINT RECOVERY KEY`. The output file rules of §7.2 apply.
- `passh recover [--vault file]` asks for the paper key, opens the vault with it, asks for a new passphrase and writes a new key block (a full save, like `passwd`). White space of any kind (spaces, line breaks), hyphens and the case of ASCII letters in the typed key are ignored, and the key's built-in checksum (bech32) catches typos.

Key and data blocks, how each operation changes them, and the recovery key's layout and checks: [vault-format.md §3](docs/spec/vault-format.md#3-keys-and-encryption-41-54-adr-6).

### 5.5 Built-in safety rules

These cost no setup and don't touch the system:

| Rule | Detail |
|---|---|
| S1 | Plaintext is never written to persistent disk by passh. The vault, its temporary file and its backups hold only ciphertext. `edit --editor` uses a temporary file on tmpfs (`$XDG_RUNTIME_DIR` or `/dev/shm`), mode 0600, deleted afterwards. passh looks for tmpfs only on Linux: elsewhere (macOS), even where a tmpfs is mounted, `edit --editor` uses the built-in form instead, with a note |
| S2 | Secrets are never passed as arguments or environment variables. The passphrase is read from `/dev/tty`; the vault key reaches the agent through a pipe and clients through the socket; for `import pass`, gpg returns plaintext on stdout |
| S3 | Password generation uses `crypto/rand` with rejection sampling (no modulo bias). Default length 24, from letters and digits; `--symbols` adds the 32 ASCII punctuation characters. No other alphabet can be configured ([import-export.md §3](docs/spec/import-export.md#3-password-generator-s3)) |
| S4 | Terminal output escapes control characters and escape sequences from entry content, so an entry can't drive your terminal, e.g. by injecting an OSC 52 clipboard write. `show --raw` prints exact bytes |
| S5 | Passwords are masked in the TUI with a fixed-length mask; revealing one hides it again after 10 s |
| S6 | The clipboard is cleared after `clipboard.clear_after`, if the session is still alive (best effort) |
| S7 | Core dumps are disabled (`setrlimit`) for passh and the agent, which affects only those processes |
| S8 | External programs (`$EDITOR`, the clipboard command, and gpg for `import pass` only) are started without a shell, with argument lists, and with `--` before paths for programs known to accept it. gpg results are read from `--status-fd`, not from human-readable output |
| S9 | The vault key's public recipient (`age1…`) is never written to the vault, backups, exports, logs or output (§4.1) |

Not provided, by design (ADR-4):

- locked or non-swappable memory: `doctor` warns if swap is active;
- rollback detection on a machine that has never seen a newer revision of the vault (§4.10).

How each rule is met: [agent-session.md §A9](docs/spec/agent-session.md#a9-safety-rules-how-they-are-met).

### 5.6 Editing

- `passh edit <path>` opens a built-in form: separate fields for password, username, url and tags, and a text area for notes. Single-line fields reject newlines.
- `passh edit --editor <path>` opens the entry's text form (§4.3) in `$EDITOR` (else `$VISUAL`, else `vi`), split into words without a shell, with a temporary file under S1. It adds leak-safe flags for known editors:
  - vim: `-n -u NONE -i NONE -c "set nobackup nowritebackup noundofile noswapfile"`;
  - neovim: `-n --clean -i NONE -c "set nobackup nowritebackup noundofile noswapfile"`;
  - nano: `--ignorercfiles --nohelp`.

  Other editors get a warning that passh can't control their backup files.

The form's keys and layout: [tui.md §11](docs/spec/tui.md#11-entry-form-56); the external editor step by step: [agent-session.md §A6](docs/spec/agent-session.md#a6-external-editor-edit---editor-spec-56-s1).

## 6. Interfaces

### 6.1 CLI

Running `passh` with no arguments opens the TUI.

| Command | Description |
|---|---|
| `passh init [--vault file]` | Create a new vault, and the config file if it doesn't exist (§5.4) |
| `passh import pass [dir] [--overwrite] [--dry-run]` | One-way import from a pass store (§4.9) |
| `passh ls [folder] [--tag t]` | Print the tree, optionally filtered by tag |
| `passh find <query>` | Fuzzy search on paths and tags |
| `passh show <path> [--field f] [--raw]` | Print the entry (text form, §4.3) or one field |
| `passh copy <path> [--field f]` | Copy to the clipboard (§6.3) |
| `passh add <path> [-f\|--force]` | Interactive add: password (or generate), username, url, tags, notes |
| `passh generate <path> [len] [--symbols] [-f\|--force]` | Generate and store a password |
| `passh edit <path> [--editor]` | Built-in form, or `$EDITOR` (§5.6) |
| `passh mv <src> <dst>` / `passh rm <path> [-f\|--force]` | Move or delete; `rm` asks first unless `--force` is given (needed without a terminal) |
| `passh tag <path> --add a --remove b` / `passh tags` | Edit tags / list tags with counts |
| `passh unlock [--ttl d]` / `passh lock` | Start / stop the agent (§5.3) |
| `passh passwd` / `passh rekey` | Change the passphrase / make a new vault key (§5.4) |
| `passh recovery-key print [-o file] [--web]` / `passh recover` | Print the paper recovery key / open the vault with it and set a new passphrase (§5.4) |
| `passh verify [file] [--full]` | Check the vault or a copy (§4.8) |
| `passh backup <dest>` / `passh backups` | Make a checked copy / list the automatic backups (§4.7, §4.8) |
| `passh merge <file> [--dry-run]` | Merge another copy of the same vault into this one (v1.1, §4.11) |
| `passh export …` / `passh print …` | §7 |
| `passh doctor` | Check the config, the vault file (structure, mode 0600, writable folder, leftover temporary files), the state and agent folders, the agent, free memory for unlock (scrypt needs 256 MiB; on macOS the total memory is judged), swap and terminal clipboard support. Read-only: it reports, never fixes |
| `passh version` / `passh --version` / `passh -v` | Print `passh <version>` |
| `passh help [command…]` | The same as `passh <command…> --help` |

Global flags: `--config <file>`, `--vault <file>`. Every command has `-h`/`--help`. Where a command has `--output` (`export`, `print`, `recovery-key print`) or `--force` (`add`, `generate`, `rm`), `-o` and `-f` are their short forms.

Commands that read or change entries need the vault key (§5.1). `init`, `verify` without `--full`, `backup`, `backups`, `lock`, `doctor`, `version` and `help` don't.

Synopsis, flags, prompts, outputs, messages and exit statuses of every command: [cli.md](docs/spec/cli.md).

### 6.2 TUI

Built on Bubble Tea + Bubbles + Lip Gloss (charmbracelet). The mock-up is informative (tui.md §5.1):

```
┌ passh ── unlocked · locks in 4:12 ───────────────────────────────────────────┐
│ VIEW: [Folders]  Tags                                               / search │
├───────────────────────────┬──────────────────────────────────────────────────┤
│ ▸ bank                (3) │ work/github                                      │
│ ▸ homelab             (7) │ username  arsenii                                │
│ ▾ work               (12) │ password  ••••••••               [c]opy [r]eveal │
│     confluence            │ url       https://github.com                     │
│     github                │ tags      work · dev · 2fa                       │
│     jira                  │ notes     Recovery codes in notes…               │
├───────────────────────────┴──────────────────────────────────────────────────┤
│ c copy pw · u copy user · r reveal · e edit · a add · t tags · d delete      │
│ Tab folders/tags · / search · P print · R reload · L lock · ? help · q quit  │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Two views**, switched with `Tab`:
  - *Folders*: a collapsible tree of the entry paths;
  - *Tags*: a list of tags with counts; selecting tags lists their entries (AND).
- `/` opens fuzzy search across paths and tags.
- `d` deletes, `m` moves or renames, `R` reloads, and `P` opens the print setup (what to print), then the print page (§7.4). Destructive actions ask for confirmation.
- The lock screen asks for the passphrase, or takes the key from the agent if one is running.
- If the vault file changes on disk while the TUI is open, the TUI shows "vault changed on disk — R to reload", and saving is blocked until you reload (§4.6).
- Narrow terminals (under 80 columns, such as phones) use a single pane: list → Enter → detail → Esc.
- All values are rendered through S4.

Screens, every key, layout rules and messages: [tui.md](docs/spec/tui.md).

### 6.3 Clipboard

- **OSC 52** (`clipboard.osc52`): passh writes the value through the terminal (`ESC ] 52 ; c ; <base64> BEL`). This works locally and over SSH in terminals that support it: iTerm2, kitty, WezTerm, Windows Terminal, Alacritty, tmux with `set-clipboard on`, and Termux with the OSC 52 setting.
- **Local tool** (`clipboard.command`): e.g. `["pbcopy"]`, `["wl-copy"]` or `["xclip", "-selection", "clipboard"]`. passh passes the value through stdin. Useful where the terminal lacks OSC 52, such as macOS Terminal.app.
- **Clearing:** after `clipboard.clear_after`, passh sends an empty value the same way. `passh copy` waits for the clear before it exits, and so does the TUI when you quit it (with a countdown; Ctrl-C clears at once). A TUI lock clears at once (§5.2).
- **Neither available:** `copy` fails with a hint (`passh show <path> --field password | pbcopy`). It doesn't print the secret.
- `passh doctor` sends a test string, then clears it, so you can check your terminal.
- Client clipboard history (macOS Universal Clipboard, Android, clipboard managers) may keep copies. The README says to exclude the terminal from those tools.

Choice of method, the bytes sent, the schedule and the messages: [agent-session.md §A5](docs/spec/agent-session.md#a5-clipboard-spec-63-s6).

### 6.4 Over SSH

There is no special server mode; passh is just a command on the remote machine:

```bash
ssh -t pi passh                                       # TUI
ssh pi passh show work/github --field password | pbcopy
```

- The TUI and prompts need a terminal, so use `ssh -t`.
- To pipe a secret from the server, start the agent first with `ssh -t pi passh unlock`. Commands without `-t` then work until the agent exits (§5.3); `ssh pi passh lock` stops it.
- Data exports must not use `-t`: a PTY turns LF into CRLF and mixes stderr into the stream (§7.1).

## 7. Export and print

### 7.1 Export

```
passh export --format <csv|json|bitwarden-json> [--tag t] [--folder f] [-o file]
             [--age <recipient> | --confirm-plaintext] [--spreadsheet-safe]
```

Exports are for moving data to other tools. To back up the vault, copy the file (§4.8).

| Format | Content | Use case |
|---|---|---|
| `json` | The data format of §4.2 (§7.3) | Scripting, migration |
| `csv` | `folder,name,username,password,url,tags,notes`, RFC 4180 quoting | KeePassXC and others |
| `bitwarden-json` | Bitwarden unencrypted export schema | Vaultwarden/Bitwarden |

Every format is plaintext unless `--age <recipient>` encrypts it to an age public key: an X25519 recipient (`age1…`) or a hybrid post-quantum one (`age1pq1…`). The encrypted output is always ASCII-armored.

Mapping:

- `csv`: tags are joined with `, `; custom fields have no column and are left out, with a warning.
- `bitwarden-json`: folders become Bitwarden folders named by their path (`work/sub`), and every ancestor folder is listed too; `login.totp` is the first field named `otp` (in any case), or else the first value starting with `otpauth://`; other fields become custom fields, hidden when the key is `password` or `otp` (in any case) or the value starts with `otpauth://`; tags become one custom field `tags`, joined with `, `.

Rules:

- **Export data is never written to a terminal.** Use `-o file` or redirect stdout.
- **Plaintext** (without `--age`) needs confirmation:
  - when passh has a terminal, the user types `EXPORT PLAINTEXT` on `/dev/tty`;
  - otherwise `--confirm-plaintext` is required.
- **`-o file`** creates the file with mode 0600. If the file isn't on tmpfs, passh warns that plaintext is going to persistent disk.
- **CSV values are exact by default**, because the target is a password manager. `--spreadsheet-safe` prefixes `'` to cells starting with `= + - @`, tab or CR, to prevent formula injection in spreadsheets. That changes values, passwords included, so don't import that file into a password manager.

The order of checks and every format byte for byte: [import-export.md §2](docs/spec/import-export.md#2-export-71-73).

### 7.2 Print

```
passh print [--tag t] [--folder f] [--fields password,username,url] [-o file] [--confirm-plaintext]
passh print --web [--tag t] [--folder f] [--fields …]
```

- Same confirmation rules as plaintext export (§7.1).
- Without `--web`: a text sheet, a paginated monospaced layout grouped by folder, with ambiguous characters marked (`0/O`, `1/l/I`) and the print date and CONFIDENTIAL (in the language of §3.3) on each page.
- `--web`: the print page (§7.4), the way to print from a browser; the browser can also save it as PDF.
- There is no PDF output (removed in v0.6 to keep the binary small: the print page covers it).
- Print, then delete the file; the README notes that sheets left on disk, e.g. a PDF saved from the browser in Downloads, are a leak.
- The paper recovery key has its own sheet (§5.4).

Both sheets line by line, and their pagination: [print.md](docs/spec/print.md).

### 7.3 JSON export

The `json` format is the data format of §4.2 with `exported_at` added and without `deleted`, so `vault_id`, entry `id`s and timestamps are kept.

### 7.4 Print page (web)

A one-shot HTTPS page with the password sheet. You open it in a browser on another device on the LAN or VPN, print it, and nothing is saved anywhere.

**Starting**

- Needs `print_web.enabled = true`.
- Start it from the TUI with `P`, which first asks what to print (all entries, the folder or the selected tags; which fields), or with `passh print --web …`. It needs a terminal, and the user types `PRINT` to confirm.
- passh shows:
  - the URL for each bound address, and a QR code of it for phones; the TUI shows one URL and its QR code at a time, and Tab moves to the next;
  - the certificate fingerprint and a countdown.

  `c` copies the URL shown to the clipboard.
- The server runs inside the passh process; there is no daemon.

**Network**

- Listens only on the addresses of `print_web.interfaces`, and only on **private** addresses: RFC 1918, `100.64.0.0/10` (Tailscale) and IPv6 ULA `fc00::/7`.
  - A public address is refused.
  - It never binds to `0.0.0.0` or `::`.
- Connections from outside the allowed ranges are closed before TLS. By default these are the subnets of the bound addresses; for an address without a subnet (a /32 or /128, as Tailscale assigns), the private range that contains it (e.g. `100.64.0.0/10`). A non-empty `allow_from` replaces the default ranges (open question in §14).
- The `Host` header must be a bound address or one of `hostnames`, which defeats DNS rebinding.
- passh doesn't open firewall ports. If a firewall blocks the port, opening it is up to you.

**Certificate**

- **No CA, nothing installed on any device.** On first use passh creates a self-signed certificate (ECDSA P-256, valid 1 year) for the bound addresses and `hostnames`.
- It keeps the certificate in `~/.local/state/passh/print-web/` (key mode 0600) and reuses it, so the fingerprint stays the same.
- If the addresses change or the certificate expires, passh makes a new one and says so.
- **First visit from a device:** the browser warns about the certificate. Compare the SHA-256 fingerprint the browser shows with the one passh shows, then accept. Firefox can remember the exception permanently; after that, any other certificate on that address triggers a warning again. Accepting without comparing leaves you open to an active attacker on the LAN (§9).
- TLS 1.3 only. Plain HTTP is never offered.

**Token and lifetime**

- The URL is `https://<address>:<port>/p/<token>`, with a 128-bit random token (`crypto/rand`, base64url).
- **The page is served once.** The first `GET` with the right token consumes it, and the server stops after the response is written.
- The server also stops at the first of:
  - `print_web.ttl`, default 5 min, maximum 15;
  - a lock (§5.2);
  - passh exiting;
  - `Esc` in the print dialog;
  - 5 requests to `/p/` with a wrong token. Other paths, such as `/favicon.ico`, get 404 and don't count.
- Link previews and browser prefetching can consume the token first. The server has then stopped, so the user's browser can't connect; passh shows which address got the page ("served to 192.168.1.23"), so the user notices and starts again. A request that arrives while the page is still being sent gets "already used".

**Page**

- Same content as the text sheet (§7.2), laid out for printing.
- No JavaScript, external fonts or images. The user prints with Ctrl/Cmd+P.
- The page is rendered from memory when the request arrives and is streamed. Every value is escaped with `html/template`, plus S4.
- Response headers:
  ```
  Cache-Control: no-store
  Content-Security-Policy: default-src 'none'; style-src 'sha256-…'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  ```
  The CSP blocks scripts and every outgoing request, so even if escaping failed, the page couldn't send passwords anywhere.
- After printing, close the tab. Browsers may keep the page in session restore, and "Save as PDF" or print spoolers can leave files.

Addresses, certificate, request handling, results, the page's HTML and CSS, and the terminal dialog: [print.md §6](docs/spec/print.md#6-print-page-server).

## 8. Backup and recovery

| What | How |
|---|---|
| Vault file | Copy it anywhere, as often as you like; it's encrypted. `passh backup <dest>` makes a checked copy, and `passh verify` checks any copy (§4.8). passh also keeps the last 10 versions on this machine (§4.7) |
| Passphrase | Remember it. Use 6 or more random words |
| Paper recovery key | `passh recovery-key print`, once, and again after `rekey` (§5.4). It opens any copy made with this vault key if the passphrase is forgotten. Keep it offline, like cash |
| Config file | Optional; it holds only the vault path and preferences |

**Moving to a new machine:**

1. copy the `passh` binary;
2. copy the vault file, then run `passh verify --full <file>`;
3. write the config file (`vault = "…"`), or use `--vault`.

**Forgotten passphrase:** `passh recover` with the paper key (§5.4).

**Without passh**, on any machine with [age](https://age-encryption.org) v1.0 or later:

```bash
tr -d '\r' < vault.passh | awk '/BEGIN AGE ENCRYPTED FILE/{n++} n==1{print} n==1 && /END AGE ENCRYPTED FILE/{exit}' > key.age
tr -d '\r' < vault.passh | awk '/BEGIN AGE ENCRYPTED FILE/{n++} n==2{print} n==2 && /END AGE ENCRYPTED FILE/{exit}' > data.age
age -d -o /dev/shm/key.txt key.age                            # asks for the passphrase
age -d -i /dev/shm/key.txt -o /dev/shm/vault.json data.age
rm /dev/shm/key.txt
```

- With the paper key instead of the passphrase, skip the first and third commands: write the key to `/dev/shm/key.txt` as one line without spaces, then run the second, fourth and fifth.
- `vault.json` is plaintext (§4.2). Keep it on tmpfs (`/dev/shm` on Linux) and delete it when done.
- If a mail client or editor re-wrapped the lines, `age` may reject the blocks. passh still opens such a file (§4.5), and `passh backup` writes it back in canonical form.

Files with CR-only line endings and the exact form of `key.txt`: [vault-format.md §8](docs/spec/vault-format.md#8-notes-on-recovery-without-passh-8).

## 9. Threat model

| Threat | Mitigation | Residual risk |
|---|---|---|
| Stolen vault file or backup | Everything inside is encrypted, including names and tags; the vault key is protected by the passphrase through scrypt | File size leaks. Offline guessing: use a strong passphrase (6+ random words); passh warns about weak ones |
| Stolen paper recovery key | Keep it offline | With any copy of the vault made before the next `rekey`: full access. Run `passh rekey` if the sheet is lost |
| Leaked passphrase | `passh rekey` | Copies made before the rekey still open with the old passphrase |
| Forgotten passphrase | Paper recovery key | Without the paper key, the data is lost |
| Someone with access to your user account, including a stolen SSH key for it | Out of scope | Full access while the TUI or the agent is unlocked (any process of the user can ask the agent for the key); can also plant a keylogger |
| Modified vault file (cloud folder, USB stick, shared backup) | A valid data block can only be made with the vault key (S9); any change makes the file fail to open. Rollback warning (§4.10) | An older valid copy put back is noticed only on a machine that has seen a newer revision |
| Damaged or truncated copy | age authenticates every byte; clear errors (§4.5); read-back check on save; automatic backups; `verify` | Damage to every copy you have |
| Lost change from concurrent edits | Save lock and change check (§4.6); `passh merge` from v1.1 (§4.11) | Until v1.1, edits made in two separate copies must be redone by hand. Merge conflicts are decided by the clocks of two machines |
| Malicious content in entries (e.g. from an import) | S4 output escaping; print page escaping and CSP | — |
| Plaintext on disk | S1; exports warn when not on tmpfs | Swap may hold process memory (`doctor` warns) |
| Clipboard persistence | Clearing after a timeout | Clipboard history on clients; no clear if the session ends first |
| Print page intercepted on the LAN | HTTPS with fingerprint check, private addresses only, `allow_from`, `Host` check, single-use token, 5-minute limit | If a certificate is accepted without comparing fingerprints, an active LAN attacker can read the page. Copies kept by the browser or print spooler |
| Terminal escape injection | S4 | `show --raw`, by explicit choice |
| Shoulder surfing | Masked by default; reveal times out | — |

## 10. Technical design

Informative: the choices of the reference implementation (library versions: `go.mod`). A compatible implementation needs only the behaviour; where a library's behaviour is part of the contract, the appendices state that behaviour.

### 10.1 Stack

| Concern | Choice |
|---|---|
| Language | Go 1.26 or later (the `go` line of `go.mod`; `os.Root` for `import pass`), `CGO_ENABLED=0` |
| CLI | `spf13/cobra` |
| TUI | `charmbracelet/bubbletea`, `bubbles`, `lipgloss` |
| Config | TOML (`BurntSushi/toml`), strict: unknown keys are errors |
| Fuzzy search | `sahilm/fuzzy` |
| Crypto | `filippo.io/age` (scrypt and X25519 recipients, armor) for the vault and for `--age` exports. No GnuPG |
| Terminal and OS | `golang.org/x/term` (passphrase prompt), `golang.org/x/sys/unix` (`flock`, peer credentials, `setrlimit`) |
| Passphrase strength | A Go port of zxcvbn (`trustelem/zxcvbn`); another port may score borderline passphrases differently, and only the warning threshold (§5.4) is specified |
| Import from pass | `gpg` subprocess, only in `passh import pass` |
| QR | `skip2/go-qrcode`: the print page URL in the terminal, and the recovery key on the print page |
| Print page | Standard library: `net/http`, `crypto/tls`, `crypto/x509`, `html/template` |
| Release | GoReleaser; checksums published with each release; `-trimpath` |

### 10.2 Package layout

```
cmd/passh/            main, cobra commands
internal/config/      config file: locate, parse, validate
internal/vaultfile/   container: lenient parse, canonical write, structure check (verify)
internal/vault/       open, save (lock, change check, atomic write, read-back check), backups, rollback record
internal/merge/       merge of two copies (v1.1)
internal/keys/        vault key, passphrase wrap (scrypt), recovery key format
internal/model/       data schema, entries, unknown-field preservation, tombstones
internal/entrytext/   text form for show and --editor
internal/paths/       entry path validator
internal/agent/       agent process, socket, peer check, TTLs; client
internal/session/     TUI lock state, idle timer, signals
internal/exec/        the only place that starts processes (S8)
internal/sanitize/    terminal output escaping (S4)
internal/clipboard/   OSC 52, local clipboard command, clearing
internal/gen/         password generator (S3)
internal/editor/      built-in form; external editor launcher
internal/importpass/  pass store reader: walk via os.Root, gpg --decrypt, parse
internal/export/      csv, json, bitwarden-json
internal/i18n/        message catalogs (en, ru, sr), plural forms, translated errors (§3.3 `language`)
internal/print/       sheet model, txt, recovery key sheet
internal/printweb/    print page server, self-signed certificate
internal/doctor/      read-only checks
internal/tui/         bubbletea models: tree, tags, detail, search, form, lock screen, print dialog
```

### 10.3 Key interfaces

```go
// KeySource yields the vault key: from the agent, a passphrase prompt or a paper key.
type KeySource interface {
    VaultKey(ctx context.Context, keyBlock []byte) (*age.X25519Identity, error)
}

type Vault interface {
    Entries() []model.Entry
    Get(p paths.Path) (model.Entry, bool)
    Put(e model.Entry) error        // validate → save (§4.6)
    Move(src, dst paths.Path) error // save
    Remove(p paths.Path) error      // tombstone → save
}

// Open: lenient parse → vault key → decrypt → strict checks (§4.5).
func Open(file string, ks KeySource) (Vault, error)
```

`paths.Path` can only be constructed by the validator.

## 11. Architecture decisions

**ADR-1: An own vault file encrypted with age; no GnuPG, no git.** Owner decision in v0.6: compatibility with pass isn't needed; what matters is one file that survives copying. age is a small, well-specified format with several independent implementations (Go, Rust, TypeScript), and its Go library is pure Go, so passh stays one static binary with no runtime dependencies. If passh is ever gone, the standard `age` tool opens the vault (§8). Cost: no shared store with `pass`; `import pass` is one-way. This replaces v0.5's "use the system gpg".

**ADR-2: Folders stay primary; tags are additive.** Tags are stored in the entries. With the whole vault in memory after unlock, no index is needed.

**ADR-3: A plain CLI that doesn't change the system.** Owner decision in v0.5: one binary, one config file, run as a normal command. This replaces the v0.2–v0.4 restricted SSH server model. Since v0.6 there is one background process, the agent, started only by `passh unlock` and exiting by itself (ADR-8). Trade-off: there are no per-device rights, and anyone who can log in as you can use passh fully.

**ADR-4: Minimal protections.** Owner decision in v0.5, kept: no signed history, no locked memory, only the cheap, setup-free rules in §5.5. In v0.6 the file format adds some protection at no cost: names and tags are encrypted, and a modified file doesn't open (S9). A rollback to an older valid copy only triggers a warning, and only on a machine that has seen a newer revision (§4.10).

**ADR-5: Print page on the LAN/VPN over HTTPS with a self-signed certificate.** passh must not change device trust stores, so it uses a persistent self-signed certificate and a fingerprint check instead of a local CA (§7.4).

**ADR-6: Two layers in one file: a key block and a data block.** Owner decision in v0.6. The passphrase protects a random vault key, and the vault key encrypts the data. As a result:

- scrypt runs once per unlock, not on every save or command;
- the agent holds a key, not the passphrase;
- `passwd` wraps the same vault key with the new passphrase, so the data stays encrypted to the same key;
- the vault key doubles as the paper recovery key;
- manual recovery takes two `age` commands.

Rejected: a single `age -p` file (scrypt on every save and command, seconds each on a Pi, with the passphrase kept in memory) and a custom Argon2id format (no standard tool could open it). The recipient stays secret because age doesn't authenticate the sender (S9).

**ADR-7: One vault, one home.** Owner decision in v0.6: the vault lives in one place (a laptop, or a Pi used over SSH), and other copies are backups. Instead of merging, passh refuses to overwrite a file that changed after it was opened (§4.6). Entries carry ids, timestamps and tombstones, so `passh merge` arrives in v1.1 without a format change (§4.11).

**ADR-8: A passh agent instead of gpg-agent.** Owner decision in v0.6. It keeps the workflow of `ssh -t pi passh unlock`, then `ssh pi passh show … | pbcopy`. The agent starts only on `passh unlock`, serves only the same user, and exits by itself after an idle time and a maximum time (§5.3). Its role and its risk are the same as gpg-agent's in v0.5.

## 12. Milestones

| M | Scope | Done when |
|---|---|---|
| M1 Core | config, paths, model, entry text, vault file (open, save, backups, rollback warning), keys; `init`, `ls`, `show`, `add`, `generate`, `edit` (form), `mv`, `rm`, `passwd`, `rekey`, `verify`, `backup`, `backups`; `doctor` | Functional criteria 8 and 9 pass (copying, recovery with `age`); safety tests 1, 2, 4, 9, 10, 11 pass |
| M2 TUI + session | TUI views, search, detail, form, idle lock, agent, `unlock` / `lock`, clipboard | Usable on 80×24 and on a phone over SSH; safety tests 3, 6 pass |
| M3 Tags + import | tag commands and view, `import pass` | A real pass store imports with folders, tags and extra fields |
| M4 Export | json, csv, bitwarden-json, confirmation rules | Bitwarden export imports into Vaultwarden; safety test 5 passes |
| M5 Print + recovery | txt, print page, recovery key sheet, `recover` | Functional criterion 10 and safety test 7 pass |
| M6 Release | GoReleaser builds, README, EXAMPLES | Install on a fresh machine = copy binary + `passh init`; safety test 8 passes |
| v1.1 | TOTP, `merge` (§4.11) | Copies edited on two machines, and a sync tool's conflict copy, merge without losing an entry; conflicts and renames are reported |

## 13. Acceptance criteria (v1)

### 13.1 Functional

1. Installing means copying the binary and running `passh init`; `passh doctor` reports no errors.
2. `passh import pass` imports an existing pass store with its folders, tags and extra fields. After that, passh works with gpg uninstalled.
3. The TUI asks for the passphrase once per session. After `session.idle_ttl` idle, it asks again.
4. After `ssh -t pi passh unlock`, `ssh pi passh show … | pbcopy` works without a terminal. After `agent.idle_ttl` or `passh lock`, the agent process is gone and the command fails with a hint.
5. Copy works through OSC 52, locally and over SSH, and through `clipboard.command`; the clipboard is cleared after 30 s.
6. A Bitwarden JSON export imports into Vaultwarden. A CSV export imports into KeePassXC, with passwords starting with `= + - @` intact.
7. The print page, started on the Pi, opens in a laptop browser over the LAN and over the VPN. After the certificate is accepted (fingerprint matches), the page prints and the server stops after the load.
8. A vault copied by `scp`, through a FAT32 and an exFAT USB stick, through a cloud folder, as an email attachment, and pasted as text (CRLF, re-wrapped lines) opens on another machine, between Linux and macOS and between amd64 and arm. `passh verify` reports each copy as OK, and the byte-exact copies have the original's SHA-256.
9. Without passh, the steps in §8 with the standard `age` tool produce the vault's JSON, both with the passphrase and with the paper key.
10. With a forgotten passphrase, `passh recover` with the paper key opens the vault and sets a new passphrase.

### 13.2 Safety tests

1. Paths with `.` or `..` segments, empty segments, a leading `-` in any segment, or control characters are rejected. `import pass` doesn't follow symlinks leading outside the pass store.
2. No plaintext file exists on persistent disk after any command except an explicit `export -o` or `print -o` (filesystem diff test). The vault, its temporary files and its backups contain none of the entries' values.
3. Escape sequences (including OSC 52) in entry content render inert in the TUI and in `show`.
4. Generated passwords pass a chi-square uniformity test over 10⁶ samples.
5. Plaintext export without confirmation fails. An export with confirmation contains no prompt text. Writing export data to a terminal is refused.
6. Agent:
   - the agent folder has mode 0700 and the socket 0600;
   - a connection from another user is refused;
   - the agent exits at `agent.idle_ttl`, at `agent.max_ttl`, on `passh lock`, and on a TUI lock with `session.stop_agent`;
   - the vault key never appears in the arguments or environment of any process (`/proc/<pid>/cmdline`, `/proc/<pid>/environ`);
   - no command other than `unlock` starts an agent.
7. Print page:
   - it binds only to private addresses;
   - it is served once;
   - a wrong `Host` header or a client outside `allow_from` is rejected;
   - it stops at the TTL and on lock;
   - the response headers match §7.4, and a headless browser loading the page makes no request caused by the page (the browser's own background traffic aside);
   - `<script>` or `<img>` in entry content renders as text.
8. A full session (init, add, edit, unlock, export, print page, lock) writes nothing outside the vault file and its temporary file, the config file, `~/.local/state/passh/`, the `/tmp` agent folder if used, and the tmpfs temporary folder (filesystem diff of `$HOME` and `/etc`, plus a syscall trace).
9. Saving:
   - a save killed at every step of §4.6 (fault injection before and after each `fsync` and the `rename`) leaves a vault that opens, at either the old or the new revision;
   - leftover temporary files are removed by the next save;
   - a vault changed on disk after it was opened is not overwritten;
   - of two passh processes saving changes to the same vault, the second is refused, and no change is lost silently.
10. Damage and tampering:
    - flipping any single byte of the vault, or truncating it at any point, gives an error that names the problem and never shows partial data (a change the lenient rules of §4.5 absorb, such as the final line break, may instead open with identical data);
    - a data block encrypted to a different key is rejected;
    - the recipient (`age1…`) never appears in the vault, backups, exports or output.
11. Rollback warning:
    - with `rollback.warn` on, opening an older copy of a vault this machine has seen gives the warning; with a terminal, declining exits without changes, and accepting stops the warning from repeating;
    - without a terminal, the warning goes to stderr and the record doesn't change;
    - files in the automatic backups folder, `verify --full` and the other file of `merge` never prompt;
    - with `rollback.warn` off, nothing warns.

## 14. Open questions

Owner decisions raised by the 2026-11-16 audit. The appendices describe the current behaviour; code issues that need no decision are listed in [docs/reviews/2026-11-16-spec-audit.md](docs/reviews/2026-11-16-spec-audit.md).

1. **`verify --full` and the rollback record.** §4.10 says `verify --full` only reports the comparison. It never prompts, but like every open it raises the record when it sees a higher revision; so does opening a file in the automatic backups folder with `--vault`. After checking a newer copy (say, from another machine), this machine's own vault then gets the rollback warning at its next open. Options: (a) keep it and say so in §4.10; (b) report-only opens and backup files never change the record.
2. **File systems without `flock`.** Every temporary file (a save, an automatic backup, `passh backup`) is locked with `flock` while it is written, so that a cleaner never removes another process's write in progress; where `flock` fails, the save or copy fails (`locking the temporary file: …`). That may include exFAT and FAT (msdos) volumes on macOS, SMB shares and some FUSE file systems, while §4.8 promises that FAT32 and exFAT USB sticks work. Needs testing on macOS. Options: (a) keep `flock` and narrow §4.8 to the file systems tested; (b) write without the lock where `flock` is unsupported, at the cost of that guarantee; (c) as (b), but only for `passh backup` destinations.
3. **`import pass` and symlinks inside the store.** Symlinks to folders inside the store aren't followed, and an absolute symlink is reported as leading outside the store even when it points into it; `pass` itself follows both. Options: (a) keep, as the safe and simple choice, and document it; (b) follow folder links that stay inside the store (with loop detection) and resolve absolute targets against the store's real path.
4. **`print_web.allow_from`.** A non-empty `allow_from` replaces the default ranges (the subnets of the bound addresses); the comment in §3.3 calls it an "extra CIDR limit", and the config accepts any CIDR, public ranges and `0.0.0.0/0` included. Options: (a) replace, as now, and fix the comment (in `passh init`'s template too); (b) intersect with the default ranges, so it can only narrow them. Separately: whether `0.0.0.0/0`, `::/0` and public ranges should be refused.
5. **Exit statuses.** A signal ends a command with 128 + n at a prompt and in the TUI, 0 for `copy` (after clearing the clipboard), 1 for the print page dialog and the external editor, and by its default action elsewhere. Proposal: 128 + n everywhere, after cleaning up. Invalid path, folder and tag arguments and unknown `--field` names give 1, while passh documents a value that doesn't parse as a usage error (2), as it does for `generate`'s length and `print --fields`. Options: (a) keep 1 for values the vault's validators check, and document it; (b) make them usage errors (2).

Decided in v0.6: the rollback warning is a config option (§4.10); `merge` comes in v1.1 (§4.11); the scrypt work factor stays at age's default, with no lighter setting.
