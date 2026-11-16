# passh

English · [Русский](README.ru.md)

passh is a password manager in one file, for one person. Your passwords live in **one encrypted vault file** that you can copy anywhere and check after copying. It opens with your passphrase, or with a paper recovery key if you forget the passphrase. Everything inside is encrypted with [age](https://age-encryption.org), including entry names and tags, and the standard `age` tool opens the vault if passh is ever gone.

- One static binary for Linux (amd64, arm64, armv7, e.g. a Raspberry Pi) and macOS (Intel, Apple silicon). No root, no GnuPG, no git, no services.
- Works the same locally and over plain `ssh`, including copying to your local clipboard (OSC 52).
- Folders and tags, fuzzy search, a password generator, a TUI.
- Checked copies, automatic backups, a paper recovery key.
- One-way import from `pass`; export to CSV, JSON and Bitwarden JSON; printing as a text sheet or on a one-shot print page in your browser.

More: [EXAMPLES.md](EXAMPLES.md) (usage examples), [spec.md](spec.md) (full specification).

## Install

Download the archive for your platform from the [release page](https://github.com/devapro/passh/releases), together with `passh_<version>_checksums.txt`, then check it and copy the binary to a folder on your `PATH`:

```bash
sha256sum -c --ignore-missing passh_<version>_checksums.txt   # macOS: shasum -a 256 -c --ignore-missing …
tar -xzf passh_<version>_linux_arm64.tar.gz
install -m 755 passh ~/.local/bin/passh
passh --version
```

On a Raspberry Pi, use `linux_arm64` with a 64-bit OS and `linux_armv7` with a 32-bit one.

With Go 1.26 or later you can also build and install it in one step: `go install github.com/devapro/passh/cmd/passh@latest` (the binary then reports its version as `dev`).

That's all: no root, no other software. passh writes only to the vault file, its config file (`~/.config/passh/config.toml`), `~/.local/state/passh/` and, for `edit --editor`, a temporary folder on tmpfs. It changes nothing else on the system. The release binaries aren't signed. If macOS blocks a binary you downloaded with a browser, run `xattr -d com.apple.quarantine ~/.local/bin/passh`.

## Quick start

```bash
passh init                 # asks for a new passphrase twice, creates the vault and the config file
passh doctor               # read-only check of the setup
passh add work/github      # password (or generate one), username, url, tags, notes
passh ls
passh show work/github
passh copy work/github     # password to the clipboard, cleared after 30 s
passh                      # the TUI: browse by folder or tag
```

`passh init` offers to print the paper recovery key. Do it (see [Paper recovery key](#paper-recovery-key)).

Coming from `pass`? Run `passh import pass --dry-run`, then `passh import pass`. gpg is needed only for this one command, and your pass store is only read.

## Daily commands

```bash
passh unlock                         # optional: no passphrase prompts for a while (15 min idle, 2 h at most)
passh ls [folder]                    # the tree; --tag t filters by tag
passh find github                    # fuzzy search on paths and tags
passh tags                           # tags with counts
passh show work/github --field username
passh copy work/github --field username
passh generate work/new-site 32 --symbols    # --force replaces an existing password
passh edit work/github               # built-in form; --editor uses $EDITOR (Linux)
passh mv work/jira work/atlassian/jira
passh rm work/old-site               # asks for confirmation
passh tag work/github --add rotate-soon --remove dev
passh lock                           # stop the agent now
```

Every command has `--help`. Global flags: `--config <file>` and `--vault <file>` (a different vault, no config file needed).

**Language.** passh speaks English by default. For Russian or Serbian (Latin script), add `language = "ru"` or `language = "sr"` to `~/.config/passh/config.toml`. Messages, prompts, `--help`, the TUI, `doctor` and printouts change language. Output meant for scripts (`ls`, `show`, `export`, …), the names of commands, flags and fields, and the phrases you type to confirm (`PRINT RECOVERY KEY`) stay the same.

## On a Raspberry Pi over SSH

Install passh on the Pi as above, as your normal user, and keep the vault there. There's no server to set up: passh is just a command you run over `ssh`.

```bash
ssh -t pi passh                      # the TUI; anything that asks for input needs -t
ssh -t pi passh copy work/github     # reaches your local clipboard through OSC 52
```

To pipe a secret into a local tool, start the agent once with a terminal. Commands **without** `-t` then work until the agent exits (15 min without use, 2 h at most), even after that SSH session ends:

```bash
ssh -t pi passh unlock               # --ttl 30m for a shorter maximum
ssh pi passh show work/github --field password | pbcopy
ssh pi passh lock                    # done: stop the agent
```

Don't use `-t` when piping or exporting: a terminal turns line endings into CRLF and mixes error messages into the data. Unlocking takes a few seconds on a Pi (scrypt is slow on purpose); after that, commands are fast. See [EXAMPLES.md §6](EXAMPLES.md#6-vault-on-a-server-eg-a-raspberry-pi).

## Copies and backups

The vault (default `~/.local/share/passh/vault.passh`) is one encrypted text file. Copy it with anything: `cp`, `scp`, a USB stick, a cloud folder, email. Then check the copy:

```bash
passh backup /media/usb/                    # checked copy: written, read back, SHA-256 compared
passh verify /media/usb/vault-….passh       # structure and SHA-256, no passphrase needed
passh verify --full /media/usb/vault-….passh  # also decrypts: revision, date, entry count
```

A byte-exact copy has the same SHA-256 as the original. A copy that was re-wrapped by a mail client or pasted as text still opens.

**Automatic backups.** Before each change, passh keeps the previous version in `~/.local/state/passh/backups/` (the last 10; `[backup] keep` in the config). `passh backups` lists them. To go back, copy one over the vault file and run `passh verify --full`; passh then warns once that the copy is older than one it has seen: answer `y`. These protect against mistakes, not against losing the disk, so keep copies elsewhere too.

**Moving to a new machine:** copy the binary and the vault file, run `passh verify --full <file>`, then write `vault = "<path>"` into `~/.config/passh/config.toml` or use `--vault`.

### Paper recovery key

```bash
passh recovery-key print -o /dev/shm/recovery.txt   # a text sheet; type PRINT RECOVERY KEY
# print it, then:
rm /dev/shm/recovery.txt
passh recovery-key print --web                       # or: the print page, with the key as a QR code
```

If you forget the passphrase, the sheet opens any copy of the vault made since the last `rekey`: `passh recover` asks for the key and sets a new passphrase. Whoever has the sheet and a copy of the vault can read everything, so keep it offline, like cash.

- `passh passwd` changes the passphrase; the paper key stays valid.
- `passh rekey` makes a new vault key: the old passphrase and the old paper key stop working on new versions of the file. Use it if either may have leaked, then print a new sheet. Older copies and backups still open with what was valid when they were made.

### Recovery without passh

With the standard `age` tool (v1.0 or later), you can decrypt the vault on any machine, with the passphrase or with the paper key. The steps are in [spec.md §8](spec.md#8-backup-and-recovery), and also in [EXAMPLES.md §7.6](EXAMPLES.md#76-without-passh), which is included in the release archive. Try them once, so you know they work.

## Export and printing

Exports are for moving to another tool. To back up, copy the vault file instead.

```bash
passh export --format bitwarden-json --age age1… -o vault.json.age   # encrypted to an age key
passh export --format csv -o /dev/shm/vault.csv                      # plaintext: type EXPORT PLAINTEXT
ssh pi passh export --format csv --confirm-plaintext > vault.csv     # over SSH: no -t, needs the agent
passh print -o /dev/shm/sheet.txt                                    # a text password sheet; delete it after printing
passh print --web                                                    # one-shot print page for a browser on the LAN/VPN
```

Formats: `csv`, `json`, `bitwarden-json`. Filters: `--tag`, `--folder`; `print` also takes `--fields`. passh prints plain text; for a PDF, use the print page and your browser's "Save as PDF". Export data is never written to a terminal. `--spreadsheet-safe` protects a CSV against formulas in spreadsheets but changes values, so don't import that file into a password manager.

The print page needs `[print_web] enabled = true` in the config. passh shows a URL, a QR code and the certificate's fingerprint. On the first visit from a device the browser warns about the certificate: accept it only if its SHA-256 fingerprint matches the one passh shows. The page is served once and stops after 5 minutes. In the TUI, `P` first asks which entries and fields to print. See [EXAMPLES.md §9](EXAMPLES.md#9-printing).

## Uninstall

```bash
passh lock                                       # stop the agent, if one is running
rm ~/.local/bin/passh
rm -r ~/.config/passh ~/.local/state/passh       # the state folder holds the automatic backups: keep them if you like
```

The vault file stays where it is.

## Security notes

- **Use a strong passphrase: 6 or more random words.** A stolen copy of the vault can be attacked offline, and the passphrase is its main protection. passh warns about weak passphrases but doesn't refuse them.
- **Exclude your terminal from clipboard history.** passh clears the clipboard after 30 s, but tools that keep a history may already have copied the password: macOS Universal Clipboard (it sends the clipboard to your other Apple devices), Android clipboard history and sync, and clipboard managers. Exclude the terminal app in them, or turn them off. If the session ends before the timeout (e.g. the SSH connection drops), the clipboard isn't cleared.
- **Printed files are plaintext.** A text sheet, or a PDF the browser saved from the print page, left in Downloads or anywhere on disk is a copy of your passwords. On Linux, write it to `/dev/shm` with `-o` (passh warns when a file isn't on tmpfs); print it, then delete it. The same goes for plaintext exports.
- **After using the print page, close the tab.** Browsers may keep the page in session restore, and "Save as PDF" or print spoolers can leave files behind. Don't paste the URL into a chat app: its link preview would use up the one-shot page.
- **Swap may hold memory.** passh doesn't lock its memory, so decrypted data can end up in swap. `passh doctor` warns when swap is active; turning it off or encrypting it is up to you.
- **Keep the paper recovery key offline.** With any copy of the vault made before the next `passh rekey`, it gives full access. Run `passh rekey` if the sheet is lost.
- **Out of scope** ([spec.md §9](spec.md#9-threat-model)): passh doesn't protect against someone who can act as your user account, including with a stolen SSH key for it. Such an attacker has full access while the TUI or the agent is unlocked (any process of your user can ask the agent for the vault key), and can install a keylogger. Other limits: the vault's size is visible; an older valid copy put back in place is noticed only on a machine that has seen a newer one; copies made before a `rekey` still open with the old passphrase or paper key; `show --raw` prints entry content without escaping.

## Building from source

You need Go 1.26 or later. passh has no C dependencies, so any machine can build it for any target. For example, for a Raspberry Pi from a laptop:

```bash
# Pi 3/4/5 or Zero 2 W with a 64-bit OS (`uname -m` on the Pi prints aarch64)
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o passh-linux-arm64 ./cmd/passh

# the same Pis with a 32-bit OS (armv7l)
CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build -trimpath -ldflags "-s -w" -o passh-linux-armv7 ./cmd/passh

scp passh-linux-arm64 pi:.local/bin/passh
```

Pi 1 and Pi Zero/Zero W (armv6l) need `GOARM=6`; that target isn't in the official release. Run the tests with `go test ./...`.

## License

MIT, see [LICENSE](LICENSE).
