# passh — Usage examples

Practical examples for [`spec.md`](spec.md) (v0.6). Command output shown here is illustrative; the spec is authoritative.

passh is one binary, one config file and one vault file. It runs as your own user, needs no root and no other software, and changes nothing outside the vault, its config file, `~/.local/state/passh/` and the agent's socket.

---

## 1. Install

No requirements: no GnuPG, no git.

```bash
install -m 755 passh ~/.local/bin/passh     # any folder on your PATH
passh doctor                                # read-only check
```

## 2. Your first vault

### 2.1 Start from scratch

```bash
passh init
```

passh asks for a passphrase twice. Use 6 or more random words; passh warns if it looks weak. It creates `~/.local/share/passh/vault.passh` and `~/.config/passh/config.toml`, then offers to print the recovery key.

Print the recovery key now, keep the sheet somewhere safe offline, and delete the file:

```bash
passh recovery-key print -o /dev/shm/recovery.txt   # a text sheet; type PRINT RECOVERY KEY
# print it, then:
rm /dev/shm/recovery.txt
```

For a sheet with the key as a QR code, use the print page (§9.2): `passh recovery-key print --web`.

### 2.2 Coming from `pass`

gpg is needed only for this step. Your pass store is only read, never changed.

```bash
passh init
passh import pass --dry-run            # what would be imported, conflicts; decrypts nothing
passh import pass                      # ~/.password-store, or pass a folder
passh ls                               # check the result
```

Once you're happy with it, you can remove the pass store and, if nothing else needs it, gpg.

---

## 3. Configure

`~/.config/passh/config.toml`. Only `vault` is required:

```toml
vault = "~/.local/share/passh/vault.passh"
```

A fuller example:

```toml
vault = "~/.local/share/passh/vault.passh"

[session]
idle_ttl   = "5m"
stop_agent = true

[agent]
idle_ttl = "15m"
max_ttl  = "2h"

[backup]
keep = 10

[rollback]
warn = true                  # warn if a vault is older than one seen before on this machine

[clipboard]
clear_after = "30s"
osc52       = true
command     = ["pbcopy"]     # macOS Terminal.app has no OSC 52; on Linux e.g. ["wl-copy"]
```

Other ways to point at a vault:

```bash
passh --config ~/work/passh.toml ls          # per command
export PASSH_CONFIG=~/work/passh.toml        # per shell
passh --vault /media/usb/vault.passh ls      # a different vault file, no config needed
```

---

## 4. Everyday commands

Every command that reads or changes entries needs the vault unlocked: it asks for the passphrase, or uses the agent if you started one with `passh unlock`.

```bash
passh unlock                               # optional: no more prompts for up to 2 h (15 min idle)

passh ls                                   # whole tree
passh ls work
passh ls --tag 2fa
passh find github
passh tags                                 # tags with counts

passh show work/github
passh show work/github --field username
passh copy work/github                     # password to clipboard, cleared after 30 s

passh add work/gitlab                      # form: password (or generate), username, url, tags, notes
passh generate work/new-site 32 --symbols
passh generate work/new-site 32 --force    # replace an existing password
passh edit work/github                     # built-in form
passh edit work/github --editor            # $EDITOR, temp file on tmpfs (Linux)
passh mv work/jira work/atlassian/jira
passh rm work/old-site                     # asks for confirmation
passh tag work/github --add rotate-soon --remove dev

passh lock                                 # stop the agent now
```

Paths with spaces need quotes, as with any command: `passh show "bank/My Bank"`.

---

## 5. The TUI

```bash
passh
```

| Key | Action |
|---|---|
| ↑ ↓, Enter | Move, open folder or entry |
| `Tab` | Switch between the Folders and Tags views |
| `/` | Fuzzy search over paths and tags |
| `c` / `u` | Copy password / username |
| `r` | Reveal the password for 10 s |
| `e` / `a` / `d` | Edit / add / delete |
| `t` | Edit tags |
| `R` | Reload after "vault changed on disk" |
| `P` | Print page (§9.2) |
| `L` | Lock now (also stops the agent) |
| `?` / `q` | Help / quit (quitting also locks) |

The TUI locks after 5 minutes without input (`session.idle_ttl`).

---

## 6. Vault on a server (e.g. a Raspberry Pi)

Install passh on the Pi as in §1, as your normal user, and keep the vault there. Then use it over plain SSH from any device:

```bash
ssh -t pi passh                                  # TUI on the Pi
ssh -t pi passh copy work/github                 # lands in your laptop's clipboard (OSC 52)
```

To pipe a secret into a local tool, start the agent once with a terminal. Commands without `-t` then work until the agent exits (15 min idle, 2 h at most), even after that SSH session ends:

```bash
ssh -t pi passh unlock
ssh pi passh show work/github --field password | pbcopy        # macOS
ssh pi passh show work/github --field password | wl-copy       # Linux (Wayland)
ssh pi passh show work/github --field password | clip          # Windows
ssh pi passh lock                                              # done: stop the agent
```

Unlocking takes a few seconds on a Pi: scrypt is slow on purpose. After that, commands are fast.

A shorter name in `~/.ssh/config` on the laptop helps:

```
Host pi
    HostName 100.101.102.103      # VPN address, or pi.local on the LAN
    User arsenii
```

---

## 7. Copies, backups and recovery

### 7.1 Copy the vault anywhere

The vault is one encrypted text file. Copy it any way you like; then check the copy.

```bash
passh backup /media/usb/                         # checked copy: vault-20261115-120000.passh
scp pi:.local/share/passh/vault.passh ~/backup/  # or any other tool
passh verify ~/backup/vault.passh                # structure + SHA-256, no passphrase needed
passh verify --full ~/backup/vault.passh         # also decrypts: revision, date, entry count
```

A byte-exact copy shows the same SHA-256 as `passh verify` on the original. A copy that went through email or was pasted as text (CRLF, re-wrapped lines) still opens; `passh backup` writes it back in canonical form.

### 7.2 Undo a mistake: automatic backups

passh keeps the last 10 versions on this machine.

```bash
passh backups
#  2026-11-15 12:00:31  r42  ~/.local/state/passh/backups/0f6c…/00000042-20261115T120031Z-r42.passh
#  2026-11-15 11:58:02  r41  …
passh --vault ~/.local/state/passh/backups/0f6c…/00000042-20261115T120031Z-r42.passh show work/github
cp ~/.local/state/passh/backups/0f6c…/00000042-20261115T120031Z-r42.passh ~/.local/share/passh/vault.passh
passh ls
#  warning: this copy is older than one seen before on this machine (r42 of 2026-11-15; seen r43 …)
#  Continue with this copy? [y/N] y
```

The rollback warning appears once after a deliberate restore; answer `y`. If you see it without having restored anything, someone or something replaced the file: answer `N` and check your other copies with `passh verify --full`.

### 7.3 Move to a new machine

```bash
install -m 755 passh ~/.local/bin/passh
mkdir -p ~/.local/share/passh
scp oldhost:.local/share/passh/vault.passh ~/.local/share/passh/
passh verify --full ~/.local/share/passh/vault.passh
mkdir -p ~/.config/passh && echo 'vault = "~/.local/share/passh/vault.passh"' > ~/.config/passh/config.toml
passh ls
```

### 7.4 Change the passphrase, or rekey

```bash
passh passwd     # new passphrase; the paper recovery key stays valid
passh rekey      # new vault key: old passphrase and old paper key stop working on new versions
passh recovery-key print -o /dev/shm/recovery.txt   # after rekey, print a new sheet
```

Use `rekey`, not `passwd`, if the passphrase or the paper sheet may have leaked. Copies made before either command still open with what was valid back then.

### 7.5 Forgot the passphrase

```bash
passh recover    # type the key from the paper sheet; spaces and case don't matter
```

passh opens the vault with the paper key and asks for a new passphrase.

### 7.6 Without passh

If passh is ever gone, the standard [age](https://age-encryption.org) tool opens the vault:

```bash
tr -d '\r' < vault.passh | awk '/BEGIN AGE ENCRYPTED FILE/{n++} n==1{print} n==1 && /END AGE ENCRYPTED FILE/{exit}' > key.age
tr -d '\r' < vault.passh | awk '/BEGIN AGE ENCRYPTED FILE/{n++} n==2{print} n==2 && /END AGE ENCRYPTED FILE/{exit}' > data.age
age -d -o /dev/shm/key.txt key.age                            # asks for the passphrase
age -d -i /dev/shm/key.txt -o /dev/shm/vault.json data.age    # all entries as JSON
rm /dev/shm/key.txt
```

With the paper key instead: skip the first and third commands, write the key to `/dev/shm/key.txt` as one line without spaces, then run the second, fourth and fifth. Delete `vault.json` when you're done; it's plaintext.

### 7.7 Two copies diverged (v1.1)

You edited the vault on the laptop and on the Pi, or a sync tool left a conflict copy. Merge the other copy into this one:

```bash
scp pi:.local/share/passh/vault.passh /dev/shm/pi.passh
passh merge /dev/shm/pi.passh --dry-run        # report only: added, updated, deleted, conflicts, renames
passh merge /dev/shm/pi.passh
scp ~/.local/share/passh/vault.passh pi:.local/share/passh/vault.passh   # bring the Pi up to date
```

For an entry changed in both copies, the later edit wins; check the conflicts in the report. Two different entries with the same path are both kept, and the incoming one gets `~2` appended.

---

## 8. Export

```bash
# encrypted to an age key, safe to move around
passh export --format bitwarden-json --age age1qy… -o vault.json.age
age -d -i ~/.config/age/key.txt vault.json.age > vault.json     # import into Vaultwarden, then delete

# plaintext CSV for KeePassXC (asks you to type EXPORT PLAINTEXT)
passh export --format csv -o /dev/shm/vault.csv

# from the Pi over SSH: no -t (a terminal would corrupt the file); needs the agent
ssh -t pi passh unlock
ssh pi passh export --format csv --confirm-plaintext > vault.csv
```

`--spreadsheet-safe` protects against formulas when you open the CSV in Excel, but it changes values that start with `= + - @`. Don't import that file into a password manager.

For a backup, don't export: copy the vault file (§7.1).

---

## 9. Printing

### 9.1 Text sheet

```bash
passh print -o /dev/shm/sheet.txt                       # asks you to confirm; print it, then delete it
passh print --folder bank --fields username,password -o /dev/shm/bank.txt
ssh pi passh print --confirm-plaintext > sheet.txt      # from the Pi, no -t; needs the agent
```

passh writes no PDF. For one, open the print page (§9.2) and use the browser's "Save as PDF"; delete the file after printing.

### 9.2 Print page in a browser on another device

Enable it in the config on the machine that holds the vault:

```toml
[print_web]
enabled    = true
interfaces = ["wg0", "eth0"]   # VPN and LAN; only private addresses are used
hostnames  = ["pi.local"]
```

Then:

1. `ssh -t pi passh`, press `P`, choose all entries, a tag or a folder, and the fields to include.
2. Type `PRINT`. passh shows the URL, a QR code and the certificate fingerprint. With several addresses, Tab shows the next URL and its QR code:
   ```
   https://192.168.1.10:8443/p/kq7Z…        (1 of 2, Tab: next)
   certificate SHA-256  4F:A1:9C:…:07:D2
   stops after one load or in 5:00
   ```
3. Open the URL on the laptop. **The first time**, the browser warns about the certificate. Open the certificate details from the warning page, compare the SHA-256 fingerprint with the one passh shows, and only accept if they match. Firefox can remember it permanently.
4. Press Ctrl/Cmd+P, then close the tab.

The server stops after that one load, after 5 minutes, on lock or when you quit. To print again, press `P` again. Don't paste the URL into a chat app: its link preview would use up the page.

The paper recovery key can go through the same page: `passh recovery-key print --web`.

passh doesn't change firewall settings. If the Pi runs a firewall, allow the port from the LAN and VPN yourself, e.g. `sudo ufw allow from 192.168.1.0/24 to any port 8443 proto tcp`.

---

## 10. Uninstall

```bash
rm ~/.local/bin/passh
rm -r ~/.config/passh ~/.local/state/passh     # the state folder holds automatic backups
```

The vault file stays where it is.

---

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| `no config file` | `passh init`, or create `~/.config/passh/config.toml` with `vault = "…"`, or pass `--vault` |
| `vault is locked: run passh unlock in a terminal` | The command has no terminal to ask for the passphrase. Run `passh unlock` (over SSH: `ssh -t pi passh unlock`), or run the command with `ssh -t` |
| Unlock takes several seconds on a Pi | Expected: scrypt is slow on purpose. It runs once per unlock |
| `vault changed on disk` | Another process, a sync tool or a copy replaced the file after you opened it. Reload (`R` in the TUI, or run the command again) and repeat the change |
| `wrong passphrase, or the key block is damaged` | Check the passphrase. If it's right, the file is damaged: use a backup (`passh backups`) or another copy |
| `data is damaged; restore a backup` | The file was damaged in copying or on disk. passh lists the automatic backups; any other copy works too (`passh verify --full <copy>`) |
| `file is truncated` | The copy is incomplete. Copy it again, then `passh verify` |
| `made by a newer passh` | Upgrade passh on this machine |
| `this copy is older than one seen before` | If you restored a backup or an old copy on purpose, answer `y`. If not, the file may have been replaced: answer `N` and check your other copies with `passh verify --full`. To turn the check off: `[rollback] warn = false` |
| Copy doesn't reach the clipboard | Run `passh doctor`. Use a terminal with OSC 52 (or tmux `set-clipboard on`), or set `clipboard.command` |
| `refusing to write export data to a terminal` | Add `-o file` or redirect stdout |
| `edit --editor` refused on macOS | There's no tmpfs there; use the built-in form (`passh edit <path>`) |
| Print page certificate warning | Expected on first visit: compare fingerprints. If they **don't** match, don't continue |
| Print page says `already used` | Something loaded the URL first (link preview, prefetch). Press `P` again |
| `doctor` warns about swap | Advice only; passh never changes it. Fix it yourself if you want |
