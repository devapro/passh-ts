# Appendix: storage, state and config

Normative appendix to [spec.md](../../spec.md) v0.6 §3.2, §3.3, §4.5–§4.8 and §4.10. Scope: every file and folder passh creates and their modes, the config file, opening a vault, saving step by step (locks, temporary files, the final rename), automatic backups, `passh backup` and `passh verify`, and the rollback record: what a re-implementation needs to produce the same files on disk and the same behaviour. It doesn't repeat the spec. Precedence: see [spec.md §1.1](../../spec.md#11-appendices-normative).

Related appendices: container bytes and the parse errors in [vault-format.md](vault-format.md); the agent's socket, folder and protocol in [agent-session.md](agent-session.md); commands, prompts and exit statuses in [cli.md](cli.md); translation in [i18n.md](i18n.md).

## 0. Conventions

- **real path** of `p`, computed on the bytes, in this order (not `realpath(3)`):
  1. Make it absolute: a relative `p` is joined to the current folder (`$PWD` if it is absolute and names the current folder, else `getcwd(3)`).
  2. Clean it lexically: collapse `//`, drop `.`, and resolve `..` against the previous component *before* any symlink is looked at (`/a/link/../b` → `/a/b`).
  3. From the left, `lstat` each component; a symlink is replaced by its target exactly as `readlink(2)` returns it (a relative target is relative to the link's folder), and resolution continues inside the result; `..` that comes from a link target goes back one component of the path resolved so far. More than 255 links, or a missing component, is an error. A component that isn't a symlink keeps its bytes as given.
  4. Clean the result.

  No case folding and no Unicode normalization on any OS: on macOS the bytes hashed are those typed (or of `$PWD`, or of the link targets), never the file system's stored or NFD form. So names of one file typed in NFC and in NFD, or in other letter case, give different real paths (§4.7). With no symlink and an absolute, clean `p`, the real path is `p` byte for byte.
- **h32(s)** = the first 16 bytes of SHA-256 of the bytes of `s`, as 32 lower-case hex digits. **h16(s)** = the first 8 bytes, 16 hex digits.
- **stamp** = UTC time as `YYYYMMDDTHHMMSSZ`.
- **`<~path>`** = a path with a leading `$HOME/` written as `~/`; **`<path>`** = the absolute path as passh got it (expanded as in §2.1, not symlink-resolved). Errors and warnings of opening and saving (§3, §4) use `<path>`; the output of `verify`, `backup` and `backups` (stdout, their notes and status lines) uses `<~path>`. OS errors quoted inside a message carry the path the OS call got (`stat /home/alice/v.passh: no such file or directory`).
- Messages are the English catalog keys; passh shows them in the config's language (§3.3) except where marked *English only*. The CLI prints errors as `passh: <message>` (multi-line messages keep their lines), warnings as `passh: warning: <message>`, notes as `passh: <message>`, all on stderr. Every error in this appendix gives exit status 1.

## 1. Folders and files (§3.2)

### 1.1 Base folders

| Name | Value |
|---|---|
| `$HOME` | must be set and absolute, else `$HOME is not set` / `$HOME ("<v>") is not an absolute path`. No passwd-database fallback |
| config folder | `$XDG_CONFIG_HOME/passh`, else `$HOME/.config/passh` |
| data folder | `$XDG_DATA_HOME/passh`, else `$HOME/.local/share/passh`. Used only for the default vault of `init` |
| state folder `<state>` | `$XDG_STATE_HOME/passh`, else `$HOME/.local/state/passh` |

An XDG variable that is empty or not absolute is ignored. `$XDG_RUNTIME_DIR` plays no part in storage (only S1's `edit --editor`).

### 1.2 Every path passh creates

| Path | Mode | When |
|---|---|---|
| the vault's folder and missing parents | 0700 exactly (§1.3) | `init` only |
| the vault file | 0600 | `init`, every save (new inode each time, §4.4) |
| `.<vault name>.tmp-<n>` in the vault's real folder | 0600 | each save; removed by it, or by the next save if a crash left it |
| `<base>.conflict-<stamp>.passh`, then `<base>.conflict-<stamp>-2.passh` … `-99` in the vault's real folder; `<base>` = vault file name minus a trailing `.passh` | as the file was | only when a save meets a vault replaced during its final rename and can't put it back (§4.3) |
| `<state>` and missing parents | 0700 exactly | first open that writes the record, first save, `unlock` |
| `<state>/locks/` | 0700 | first save or record update |
| `<state>/locks/vault-<h32(real path of the vault)>.lock` | 0600, empty | save lock (§4.1); never removed |
| `<state>/locks/backups-<h32(vault_id)>.lock` | 0600, empty | backups lock; never removed |
| `<state>/locks/revisions.lock` | 0600, empty | record lock; never removed |
| `<state>/revisions.json` (via `.revisions.json.tmp-<n>`) | 0600 | §7 |
| `<state>/backups/`, `<state>/backups/<dir>/` | 0700 | first backup (§5.1) |
| `<state>/backups/<dir>/<seq>-<stamp>-r<rev>.passh` (via `.backup.tmp-<n>`) | 0600 | each save with `backup.keep` > 0 |
| `<state>/agent/`, or `$TMPDIR/passh-<uid>/`, or `/tmp/passh-<uid>/` | 0700 exactly, checked ([agent-session.md §A2.2](agent-session.md#a22-agent-folder-must)) | `passh unlock` |
| `<state>/print-web/`, `cert.pem`, `key.pem` | 0700 / 0600 | print page ([print.md](print.md)) |
| the config file and missing folders above it | 0600 / 0700, both reduced by the umask | `init`, only if no config file exists (§2.5) |
| `passh backup` destination, `.<dest name>.tmp-<n>` next to it | 0600 | §6.1 |

Opening a vault for reading (`ls`, `show`, …) never writes the vault, its folder or the backups, but may create `<state>`, `locks/`, `revisions.lock` and `revisions.json` (§7.3).

### 1.3 Creating folders

`mkdirs(d)` (vault folder, `<state>` and everything under it): for each missing component from the top: `mkdir` 0700, `chmod 0700` (the umask doesn't apply), fsync the parent (§1.4). An existing component that isn't a folder fails with `<path> is not a folder`. Existing folders are never changed or checked. Two exceptions use `mkdir -p` with 0700 reduced by the umask: the config file's folders (`init`), and the parents of `<state>` when `unlock` creates it.

### 1.4 Shared mechanisms

**Contract** (what another implementation sharing these files relies on): BSD `flock(2)` locks, never `fcntl`/`lockf`, on the lock files and on every temporary file while it is written; the file names of this appendix; lock files never deleted; temporary files cleaned only as below; and after any crash each file is the old or the new version, complete. Informative in this section and §4.5: open flags, the 20 ms poll, the fsync order and the errno lists, which are how passh meets that contract.

**Temporary files** (vault, backups, record, `passh backup`): `.<target>.tmp-<n>` in the target's folder; `<target>` is the target's file name, `backup` for backups, `revisions.json` for the record. Not normative: the form of `<n>` (passh: a random number 0–4 294 967 295 in decimal without leading zeros, created `O_CREAT|O_EXCL` and retried on collision, up to 10 000 times); cleaners ignore it.

1. Create (mode 0600), take `flock(LOCK_EX|LOCK_NB)` on it and hold it until the file is renamed into place or removed. flock fails → remove it, fail `locking the temporary file: …`. If the file is no longer at its name after locking (a cleaner removed it), start again; the third time fail `temporary files keep disappearing`.
2. `fchmod 0600`; EPERM, EINVAL, ENOTSUP, EOPNOTSUPP are ignored (FAT and exFAT have no modes).
3. Write, fsync. Any error removes the file.

**Cleaning leftovers** of `<target>`: for each *regular* file (not a symlink) in the folder whose name starts with `.<target>.tmp-`, whatever follows (digits, other characters or nothing): open `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, try `flock(LOCK_EX|LOCK_NB)`; EWOULDBLOCK means a write in progress: skip it; check it is still at its name; unlink. A cleaner therefore never removes another process's file in progress, even one serialized by a different lock file; any other file with that prefix is removed.

**Lock files**: open `O_RDONLY|O_CREAT|O_NOFOLLOW` 0600, `fchmod 0600`, then `flock(LOCK_EX|LOCK_NB)` (EINTR retried). Busy: retry every 20 ms; give up **15 s** after the first busy try. Any other flock error fails (`locking <path>: …`); a cancelled operation (TUI) stops waiting with `stopped waiting for another passh process: …`. Never delete lock files.

**Renames**

- *exchange(a, b)*: Linux `renameat2(RENAME_EXCHANGE)`, macOS `renamex_np(RENAME_SWAP)`.
- *rename-no-replace(a, b)*: Linux `renameat2(RENAME_NOREPLACE)`, macOS `renamex_np(RENAME_EXCL)`; EEXIST if `b` exists.
- *Unsupported* = EINVAL, ENOSYS, ENOTSUP or EOPNOTSUPP. Exchange unsupported → plain `rename(2)` (§4.3). No-replace unsupported → `link(a, b)` + `unlink(a)` (EEXIST stays EEXIST); if `link` fails otherwise (FAT) → `lstat(b)` exists → EEXIST, else `rename(2)`.

**Folder fsync**: open the folder and fsync it; EINVAL, ENOTSUP, EOPNOTSUPP, EBADF and ENOTTY count as success (FUSE, network file systems).

**Limits**: a vault file that is opened, verified, copied or backed up must be a regular file (`stat`, following symlinks) of at most 64 MiB (67 108 864 bytes). A config file: at most 1 MiB.

## 2. Config file (§3.3)

### 2.1 Location and `--vault`

First match wins: `--config <file>`, `$PASSH_CONFIG`, `<config folder>/config.toml`. An empty value counts as not given. `--config`, `$PASSH_CONFIG` and `--vault` are expanded: `~` and `~/…` with `$HOME` (`~user` is not), a relative path against the current folder, then cleaned.

| Config file | Without `--vault` | With `--vault` |
|---|---|---|
| exists, valid | used | used; `vault` comes from the flag and isn't required in the file |
| exists, invalid | error | error (an existing file is always read) |
| missing, named by `--config` | error (§2.6) | error (§2.6) |
| missing, from `$PASSH_CONFIG` or the default location | error (§2.6) | all defaults + the flag; language English |
| location can't be computed (`$HOME` unset) | that error | all defaults + the flag, unless `--config` was given |

### 2.2 Parsing

1. Read (§1.4 limit: problem `the file is larger than 1 MiB`; read error `config: <os error>`).
2. Decode as TOML 1.1.0 (so also the 1.1 additions, e.g. newlines and a trailing comma in an inline table, the `\e` and `\xHH` escapes: `language = "\x65n"` is `en`). The first syntax error or value of a wrong TOML type stops here with one problem (later ones aren't reported): the decoder's message without its `toml: ` prefix, *English only*. Not normative: the text of that message (passh's decoder, BurntSushi/toml v1.6.0, writes e.g. `line 3 (last key "session.idle_ttl"): incompatible types: TOML value has type int64; destination has type string` or `line 4: Key 'session' has already been defined.`); what binds is one problem line in the form of step 4.
3. Otherwise all problems are collected, in this order: `unknown key "<dotted.key>"` for each unknown key in file order (for an unknown table only the table: `unknown key "sesion"`), then the checks of §2.3 in table order.
4. One problem: `config <path>: <problem>`. Several: `config <path>:`, then one problem per line, indented by two spaces.

An absent key or table takes its default.

### 2.3 Keys

| Key | TOML type | Default | Rule → problem |
|---|---|---|---|
| `vault` | string | required, unless `--vault` | absent → `vault is required, e.g. vault = "~/.local/share/passh/vault.passh"`; `""` → `vault is empty`; neither absolute nor starting with `~/` (also `~` alone, `~user/…`, `./x`) → `vault: "<v>" must be an absolute path or start with ~/`. Then `~/` is expanded and the path cleaned |
| `language` | string | `"en"` | exactly `en`, `ru` or `sr` (case-sensitive) → `language: "<v>" is not one of "en", "ru" or "sr"` *(English only)* |
| `session.idle_ttl` | duration | `"5m"` | duration > 0 |
| `session.stop_agent` | bool | `true` | — |
| `agent.idle_ttl` | duration | `"15m"` | > 0 |
| `agent.max_ttl` | duration | `"2h"` | > 0; not compared with `idle_ttl` |
| `backup.keep` | integer | `10` | 0 … 1 000 000 → `backup.keep: <n> must be 0 or more` / `backup.keep: <n> is more than 1000000` |
| `rollback.warn` | bool | `true` | — |
| `clipboard.clear_after` | duration | `"30s"` | > 0 |
| `clipboard.osc52` | bool | `true` | — |
| `clipboard.command` | array of strings | `[]` | if not empty, the first element is not blank → `clipboard.command: the program name (first element) is empty` |
| `print_web.enabled` | bool | `false` | — |
| `print_web.port` | integer | `8443` | 1 … 65535 → `print_web.port: <n> is not between 1 and 65535` |
| `print_web.interfaces` | array of strings | `["wg0", "eth0"]` | each non-empty, no whitespace or control character → `print_web.interfaces: "<v>" is not a valid name` |
| `print_web.hostnames` | array of strings | `[]` | as `interfaces` (`print_web.hostnames: …`) |
| `print_web.allow_from` | array of strings | `[]` | each an IPv4 or IPv6 CIDR prefix (a bare address or a zone is refused) → `print_web.allow_from: "<v>" is not a CIDR such as "192.168.1.0/24" or "fd00::/8"`; host bits are cleared silently (`10.1.2.3/8` = `10.0.0.0/8`) |
| `print_web.ttl` | duration | `"5m"` | 1m ≤ ttl ≤ 15m → `print_web.ttl: "<v>" is not between 1m and 15m` |

**Durations** are TOML strings: an optional `+` or `-`, then one or more `<decimal><unit>` with no spaces, where `<decimal>` is digits with an optional `.` fraction (`1.5`, `.5`, `5.`; not `.` alone) and the units are `ns`, `us`, `µs` (U+00B5 or U+03BC), `ms`, `s`, `m`, `h` (no days); e.g. `30s`, `1.5h`, `1h30m`. A bare `0` parses (and fails the > 0 rule); a value beyond about 292 years doesn't parse. Not a duration → `<key>: "<v>" is not a duration such as "30s", "5m" or "2h"`; ≤ 0 → `<key>: "<v>" must be more than zero`.

### 2.4 The file `passh init` writes

Normative: the file sets exactly the keys and values of the `toml` block of spec §3.3 (every default spelled out, `language = "en"`), with `vault` as below, and passes §2.2. Informative: comments, blank lines, spacing and alignment; passh writes that block byte for byte (LF, final LF), and a test keeps the two identical. The value of `vault` is replaced by the created vault's path as a TOML basic string: a path under `$HOME` (with `$HOME` ≠ `/`) is written `~/…`; `"` → `\"`, `\` → `\\`, U+0000–U+001F and U+007F → `\uXXXX` (upper-case hex); a path that isn't valid UTF-8 fails (`vault path "<p>" is not valid UTF-8, which TOML can't hold`). Written with `O_CREAT|O_EXCL` (so an existing path, even a dangling symlink, is never overwritten), fsynced, closed; on a write error the new file is removed. No folder fsync.

### 2.5 `init` and its files

1. Locate the config (§2.1) and load it if it exists; an invalid one fails, so does one without `vault` when `--vault` isn't given.
2. Vault path: `--vault`, else the config's `vault`, else `<data folder>/vault.passh`.
3. `lstat(vault)` succeeds → fail `<~path> already exists; passh init doesn't overwrite a vault` (before any prompt). Then a terminal is required.
4. Create the vault (§4.6).
5. Only if the config file didn't exist: write it (§2.4) at the located path and say `Wrote the config file <~path>.` Failure → `the vault was created, but the config file wasn't: …` (the vault stays). If it existed and names another vault, it isn't changed, and the status lines are `The config file <~config> exists and wasn't changed; it names the vault <~vault>.` and `Use --vault <~path> with each command, or change vault in the config file.`

### 2.6 Missing files

- Config: `no config file at <path>: run `passh init` to create one, or create it with the line vault = "/path/to/vault.passh", or pass --vault <file>`; after `<path>`, ` (from --config)` or ` (from $PASSH_CONFIG)` when it came from there.
- Vault (`stat` gives ENOENT, for every command that uses the config's vault, except `backups`): `no vault at <~path>: run `passh init` to create one, or pass --vault <file>`; another `stat` error: `vault <~path>: <error>`. `backups` instead prints the note of §5.4 (`can't be read`), lists every backup on the machine and exits 0.

## 3. Opening (§4.5)

### 3.1 Order of checks

A command that needs the key: config (§2) → `stat` of the vault (§2.6) → open with the agent's key source, then with the passphrase (§5.1, [cli.md](cli.md)). One open:

| # | Step | Failure |
|---|---|---|
| 1 | real path | `opening the vault: <os error>` |
| 2 | read (§1.4 limits) | `<path>: not a passh vault: not a regular file`; `<path>: not a passh vault: the file is larger than 64 MiB`; other: `opening the vault: <os error>` |
| 3 | SHA-256 of the bytes read becomes the **opened hash** (§4.2) | — |
| 4 | container parse ([vault-format.md](vault-format.md)) | `<path>: <parse error>`. Text around the vault: warnings `<path>: ignored <n> line(s) of text before the passh-vault line` / `… after the last END line` |
| 5 | vault key from the key source | `<path>: wrong passphrase, or the key block is damaged` (after 3 tries); `<path>: the key block is damaged: it doesn't hold exactly one vault key`; `<path>: key block asks for scrypt work factor 2^N; passh uses 2^18: the file is damaged or not made by passh` (refused before scrypt; [vault-format.md §3.2](vault-format.md#32-key-block)). Agent failures: [agent-session.md](agent-session.md) |
| 6 | decrypt the data block | §3.2 |
| 7 | decode the JSON (§4.2) | `version` > 1 → `<path>: made by a newer passh; upgrade passh (data version)`; otherwise §3.2 |
| 8 | rollback check | §7.4 |

Steps 1–4 come before any key is asked for: a damaged or foreign file never prompts and never contacts the agent. For a damaged key block (block 1) and for the work-factor error, the CLI adds the line ``The key block only protects the vault key with the passphrase: if the data block is intact, `passh recover` with the paper recovery key writes a new key block`` (for the work factor followed by `; or restore a backup (passh backups)`).

`passh recover` opens in recovery mode: if step 4 fails only on block 1, the last `BEGIN`…`END` block of the file is taken as the data block, a warning `<path>: the key block is damaged; setting a new passphrase rewrites it` is shown, and only a save with a new key block is allowed (§4.2 step 0).

### 3.2 A data block that doesn't open, and the list of backups

| Cause | Message |
|---|---|
| age decryption fails (payload damaged or truncated) | `<path>: data is damaged; restore a backup` + list |
| the key opens no stanza; key from the passphrase or the agent (it belongs to this key block) | `<path>: data is damaged; restore a backup (the data block isn't encrypted to this vault's key: damaged or replaced)` + list |
| the same with a paper key (`recover`) | `<path>: this key doesn't open this vault (rekeyed elsewhere? wrong recovery key?)`, no list; `passh recover` prints instead `this recovery key doesn't open <~path>: it belongs to another vault, or the vault was rekeyed after the sheet was printed` |
| JSON invalid or fails the checks of §4.2 | `<path>: data is damaged; restore a backup (invalid vault data: <detail>)` + list ([vault-format.md §3.3](vault-format.md#33-data-block)) |

The list follows on the next lines:

1. Take every backup on the machine (§5.4 order). Unreadable or unparsable backup files are skipped for matching.
2. A backups folder **matches** if one of its backups has the same key block bytes as this file, or a data block whose age header this key unwraps (header only).
3. Some folder matches: `automatic backups of this vault, newest first:` and the backups of the matching folders. None: `automatic backups on this machine, newest first:` and all. No backups at all: `no automatic backups of this vault were found; use another copy (passh verify --full <copy>)`.
4. One line per backup: two spaces, `YYYY-MM-DD HH:MM:SS  r<rev>  <absolute path>` (UTC time and revision from the name).

### 3.3 Warnings, changes and reload

- The CLI prints each distinct warning once per command, though it may open the file twice (agent, then passphrase).
- **Changed** (the TUI's "vault changed on disk"): the real path differs from the one opened (symlink retargeted), the file is gone, or the SHA-256 of its bytes differs from the opened hash. A byte-identical replacement is no change.
- **Reload**: a new open (§3.1). The current key is tried first if the key block bytes are unchanged; a changed key block goes through the key source. The rollback check runs again.

## 4. Saving (§4.6)

### 4.1 Locks

| Lock file (in `<state>/locks/`) | Held | Serializes |
|---|---|---|
| `vault-<h32(real path)>.lock` | the whole save (§4.2 steps 1–8), `init` | saves of one vault file |
| `backups-<h32(vault_id)>.lock` | writing and rotating one backup | copies of one vault at different paths, which share a backups folder |
| `revisions.lock` | read-modify-write of the record | all record updates |

Nesting order: vault → backups (released) → revisions. Locks are per open file, so two opens of one vault in one process exclude each other too; a dead process's locks vanish with it. Opening takes no vault lock: readers rely on the atomic rename. The state folder must be writable for every save, even with `backup.keep = 0`.

### 4.2 Steps

Input: the new data (a changed copy of the data in memory), the key block (the opened one byte for byte, or a new one from `passwd`, `rekey`, `recover`) and the key. **changed** = fail with `vault changed on disk after it was opened (another passh, a sync tool or a copy); nothing was saved: reload and repeat the change`.

0. Opened in recovery mode and no new key block → fail `the key block is damaged: set a new passphrase first (passh recover)`.
1. Real path again: missing → changed; different from the opened one → changed; inside the real path of `<state>/backups/` → fail `this is an automatic backup: copy it out first (e.g. over the vault file) and open the copy`. `mkdirs <state>/locks` (`creating the state folder: …`), take the vault lock (busy 15 s → `vault is being saved by another passh process; nothing was saved: try again`; `opening the lock file: …`), clean leftovers of `<name>` in the real folder (`removing leftover temporary files: …`).
2. Read the vault: missing or SHA-256 ≠ opened hash → changed; other errors `reading the vault file again: …`.
3. `revision` = max(revision of the new data, opened revision) + 1; `saved_at` = now in UTC, truncated to the second; serialize, encrypt, encode the canonical container.
4. Temporary file (§1.4): `writing the new vault file: <error>; the vault is unchanged`.
5. Read it back: same bytes; parses; same key block; the data block decrypts with the key; the plaintext equals a fresh serialization of the data; it decodes with the same `vault_id`, `revision` and number of entries. Otherwise remove it and fail `the new vault file didn't read back as written; the vault is unchanged: <detail>`.
6. Read the vault again; SHA-256 ≠ opened hash → changed. If `backup.keep` > 0, back up exactly these bytes (§5.2) under the opened revision; failure → `making the automatic backup: …; the vault is unchanged`. Failures to remove old backups are a warning: `old automatic backups couldn't be removed: …`.
7. Replace (§4.3). Then close the temporary file's descriptor (an error is a warning) and fsync the folder (an error is a warning: `the vault's folder couldn't be flushed to disk: …`).
8. The opened hash becomes the hash of the new file; update the record (§7.3; failure is a warning).

The data in memory changes only after step 7, so after any failure the caller still has the user's input (the TUI form keeps its values). A cancellation (TUI) is honoured while waiting for a lock and before steps 2 and 3; once the file is replaced, the save completes.

### 4.3 Replacing the vault

The temporary file goes to the vault's **real** path: a symlinked vault keeps its link, and the temporary file lies in the target's folder.

1. exchange(temp, real). Unsupported → `rename(temp, real)`, done. ENOENT → changed. Other errors → `replacing the vault file: …; the vault is unchanged`.
2. The temporary name now holds the previous vault. Read it:
   - its SHA-256 is the opened hash → unlink it (failure: warning `the replaced vault file couldn't be removed (the next save removes it): …`); done;
   - different (replaced between step 6 and the exchange) → exchange back. If that fails: move the other version aside and fail with changed + `; the save couldn't be undone (<error>): the vault now holds this save, the other version is in <file>`. If what comes back isn't this save's bytes: move it aside and fail with changed + `; a file that was in its place is kept in <file>`. Otherwise fail with changed (the other version stays the vault);
   - unreadable (other than ENOENT) → move it aside; warning `the replaced vault file couldn't be checked (<error>); it is kept in <file>`; the save stands;
   - missing → done.
3. **Move aside**: rename-no-replace to `<base>.conflict-<stamp>.passh`, then `-2` … `-99`. If none works, it stays at its temporary name and `<file>` reads `<path> (a temporary name: move it elsewhere before the next save, which would remove it)`.

### 4.4 What a save does to the file

A new inode with mode 0600, owned by the user running passh, in canonical form. ACLs, extended attributes and other hard links to the old inode are not carried over; a symlink to the vault stays.

### 4.5 fsync order

Informative (§1.4): the order passh uses; the guarantee in the last paragraph binds.

1. the parent of each folder `mkdirs` creates;
2. the temporary vault file (step 4), before the read-back;
3. the backup: its temporary file, its rename, the backups folder;
4. the exchange or rename of the vault, then its folder;
5. the record: its temporary file, its rename, `<state>`.

A crash at any point leaves the old or the new vault, each complete; a backup complete or absent; at most a `.<…>.tmp-<n>` file, which the next write to that folder removes.

### 4.6 Creating (`init`)

As §4.2, except: `mkdirs` the vault's folder; real path = real path of the folder + the file name; inside the backups folder → the backup-file error; after taking the lock, `lstat` of the target succeeds → `<path>: a file already exists there`; revision 1, no backup; step 7 is rename-no-replace (EEXIST → the same error); the record gets revision 1.

### 4.7 Concurrency

- Two processes saving one vault: the second waits for the lock, then fails with changed at step 2 (§13.2 safety test 9). If the first holds the lock for 15 s, the second fails with the lock error. No change is lost silently.
- Names of one file that resolve differently (bind mounts, other letter case or Unicode normalization on macOS, another `$XDG_STATE_HOME`) don't share the vault lock. Steps 2 and 6 and the exchange check still refuse to overwrite a changed file, and temporary-file locks keep cleaners away from writes in progress.
- A sync tool or `cp` replacing the vault: caught at step 2, at step 6 or by the exchange. Where exchange is unsupported, a replacement in the microseconds between step 6 and `rename` is overwritten.

## 5. Automatic backups (§4.7)

### 5.1 Folder, name and content

- Folder `<state>/backups/<dir>/`: `<dir>` = `vault_id` if it matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` (every UUID does), else `id-<h32(vault_id)>`.
- Name `<seq>-<stamp>-r<rev>.passh`: `<seq>` decimal, zero-padded to at least 8 digits (more once larger); `<stamp>` = the save's clock (§4.2 step 3); `<rev>` = the revision of the file backed up (the one being replaced), unpadded. Example: `00000042-20261115T120031Z-r41.passh`.
- Content: the vault's bytes as read at step 6, unchanged (possibly not canonical). Mode 0600.
- A file is a backup if it is a regular file (symlinks don't count) named `^(\d{1,20})-(\d{8}T\d{6}Z)-r(\d{1,20})\.passh$` (ASCII digits) with 1 ≤ seq ≤ 2^62, a valid stamp and a revision that fits 64 bits. Other files are ignored: never listed, counted or removed. Not normative: passh also recognizes `^(\d{8}T\d{6}Z)-r(\d{1,20})(-\d{1,6})?\.passh$` (seq 0), written only by development builds before v0.1.0; a re-implementation MAY ignore such files (it then never lists or removes them).

### 5.2 Writing one

Under the backups lock: `mkdirs` the folder; clean leftovers of `backup`; seq = highest seq in the folder + 1 (1 when there is none: the counter isn't stored anywhere, and restarts only if every numbered backup is gone); temporary file (§1.4); rename-no-replace to the name, on EEXIST seq + 1 and again (at most 1000 times); fsync the folder; rotate.

### 5.3 Order and rotation

Newest first = seq descending; seq-0 names after all others, by stamp, then revision, then the `-N` suffix, descending; a remaining tie by path, ascending. A list of several folders (§3.2, §5.4) is grouped by folder name, folders in byte order of their names, each folder newest first. Rotation keeps the first `keep` and unlinks the rest, never the backup just written nor the vault's real path. Clock and revision play no part, so a clock set back or a restored older vault never removes the newest backups. `keep` = 0: no backup is made and none removed. A lower `keep` takes effect at the next save.

### 5.4 `passh backups`

Needs no key. The `vault_id` is encrypted, so the vault's folder is found by key block (§3.2 step 2 without a key). Output on stdout, one line per backup, in the order of §5.3 (by folder name in byte order, then newest first): `YYYY-MM-DD HH:MM:SS  r<rev>  <~path>` (UTC, from the name). Exit status 0 in every case below. The two notes go to stderr as `passh: note: …` (the word `note:` is part of their text, as in §6.2; other notes have none):

- No folder matches (the file is damaged, or `passwd`/`rekey` changed its key block and nothing was saved since): `note: no backup has this vault's current key block (it was changed by passwd or rekey and not saved since, or the file is damaged); listing every automatic backup on this machine`, then all backups.
- The vault can't be read (also when it is missing, §2.6): `note: <~path> can't be read (<error>); listing every automatic backup on this machine`, then all, e.g. `<error>` = `stat /home/alice/v.passh: no such file or directory` or `not a passh vault: not a regular file`.
- None: `No automatic backups yet. passh makes one before each save (backup.keep = <n>).` on stderr (after the `can't be read` note, if any).

### 5.5 Opening a backup

A file whose real path is inside `<state>/backups/` opens normally (`passh --vault <backup>`), never gets the rollback prompt or warning (§7.4), and refuses every save (§4.2 step 1). Restoring = copying it over the vault; the rollback prompt then appears once.

## 6. Copying and verifying (§4.8)

### 6.1 `passh backup <dest>`

The source is the config's vault (so `--vault` sets it, §2.1). No key and no lock files: the vault is read once, and atomic saves make that read the old or the new file.

1. Destination (expanded as in §2.1): an existing folder, also through a symlink → `<folder>/<vault file name minus .passh>-<YYYYMMDD-HHMMSS>.passh` (UTC; the path keeps the link's name); a `<dest>` ending in `/` that isn't a folder → `<~path>: no such folder`; otherwise the file `<dest>` (a dangling symlink then fails at step 3).
2. Read the source (§1.4 limits), parse the container without decrypting; failure → `<path> doesn't pass the structure check, so it isn't copied: <error>`. Not canonical → the content is the canonical re-encoding of the two blocks. The warnings about ignored text (vault-format §2.2) aren't printed.
3. `lstat(dest)` succeeds → `<dest>: a file already exists there; passh doesn't overwrite files`.
4. Clean leftovers of the destination name (best effort); temporary file next to it (§1.4); read it back (at most size + 1 bytes); not equal → `<dest> (SHA-256 <got>, expected <want>): the copy didn't read back as written; nothing was written under its name`, `<want>` being the SHA-256 of the content of step 2 (the source's bytes, or their canonical re-encoding).
5. rename-no-replace to `<dest>` (EEXIST → the error of step 3); fsync the folder (`<dest> is written, but its folder couldn't be synced: …`).

The copy's SHA-256 equals the source's only for a canonical source. Stdout: `<~dest>: OK`, `  SHA-256   <hex of the copy>`, `  size      <n> bytes`. Stderr: `Backed up <~src> to <~dest>.`, then either `The copy is byte for byte the vault; `passh verify` shows the same SHA-256 for both.` or, for a re-encoded source, the two lines `The vault isn't in canonical form, so the copy was written in canonical form;` and `its SHA-256 differs from the vault's, and the stock age tool reads its blocks (§8).` A failure up to the rename leaves nothing under the destination name; no failure prints anything on stdout.

### 6.2 `passh verify [file] [--full]`

Target: `file` (expanded as in §2.1; a config file is loaded if it exists and must then be valid, but is needed only when named by `--config`), else the config's vault. Read (§1.4: `<~path> is not a regular file`, `<~path> is larger than 64 MiB: not a passh vault`), then the container check ([vault-format.md](vault-format.md)). Stdout:

```
<~path>: OK                         (or: FAILED)
  SHA-256   <64 lower-case hex digits of the file's bytes>
  size      <n> bytes
```

FAILED → error `<~path>: <parse error>`, exit 1. OK → notes on stderr: `note: <ignored text warning>` for each, and for a file not in canonical form ``note: the file isn't in passh's canonical form (line endings or line wrapping changed in copying); it opens, and `passh backup` writes a canonical copy``.

A file that can't be read prints nothing on stdout; the error goes to stderr, exit 1: missing → the OS error (`stat <path>: no such file or directory`; with no `file` argument, the `no vault at` error of §2.6), not a regular file → `<~path> is not a regular file`, over 64 MiB → `<~path> is larger than 64 MiB: not a passh vault`, unreadable → the OS error (`open <path>: permission denied`).

`--full`, only after OK: open (§3.1), trying the agent of the file, then the agent of the config's vault if that is another existing file, then the passphrase; the rollback check is report-only (§7.4). If the open fails (wrong passphrase after 3 tries, damaged data, a newer version, a stopped prompt), stdout keeps the three lines above and nothing more; the error goes to stderr, exit 1. Otherwise stdout continues:

```
  vault_id  <vault_id>
  revision  <n>
  saved_at  YYYY-MM-DD HH:MM:SS UTC
  entries   <number of entries>
  rollback  <report>
```

`saved_at` of a vault without one is the zero time: `0001-01-01 00:00:00 UTC`. `<report>` (translated; the labels aren't): `this machine hasn't seen this vault before` · `OK: the newest revision seen on this machine (r<n>)` · `OK: newer than seen before on this machine (r<n>)` · `OLDER than seen before on this machine (seen r<n> of YYYY-MM-DD)`, with `<n>` the record before this open. When older, the §7.4 text also goes to stderr as a warning; the exit status stays 0. The report is the same with `rollback.warn = false` and for a file in the backups folder (both compared with the record like any file, the warning included). A damaged, newer or unreadable record gives `this machine hasn't seen this vault before` plus the §7.2 warning (a damaged one is then replaced, §7.3), although the comparison wasn't made (known issue, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)).

## 7. Rollback record (§4.10)

### 7.1 Format

`<state>/revisions.json`, JSON, written with two-space indentation, fields in the order shown, `vault_id` keys sorted by their UTF-8 bytes (before escaping), a final LF. Strings are escaped as JSON with HTML escaping on: `"` → `\"`, `\` → `\\`, `<` → `\u003c`, `>` → `\u003e`, `&` → `\u0026`, LF, CR, TAB, BS, FF → `\n` `\r` `\t` `\b` `\f`, other U+0000–U+001F → `\u00xx`, U+2028/U+2029 → `\u2028`/`\u2029`; DEL and other non-ASCII literal UTF-8. So the key `<a&>"` is written `"\u003ca\u0026\u003e\""`. A reader decodes the escapes; only the decoded `vault_id` matters.

```json
{
  "version": 1,
  "vaults": {
    "4067e724-036b-4e69-8cbc-54e0bf2a5df7": {
      "revision": 42,
      "saved_at": "2026-11-15T12:00:00Z",
      "seen_at": "2026-11-15T12:00:05Z"
    }
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `version` | integer | 1. Missing or < 1: damaged; > 1: newer |
| `vaults` | object | key: the `vault_id` string exactly as in the data; missing or `null` = empty |
| `revision` | unsigned 64-bit integer | highest revision opened or saved here, or the lower one the user accepted |
| `saved_at` | RFC 3339 string | that revision's `saved_at` (UTC, whole seconds as passh writes it; `0001-01-01T00:00:00Z` for a vault without one) |
| `seen_at` | RFC 3339 string, UTC, whole seconds | when the entry was written |

Nothing else: no paths, names or hashes. Readers ignore unknown fields; passh v1 doesn't keep them when it rewrites the file (known issue, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md) #12). Times are read as in [vault-format.md §4.1](vault-format.md#41-schema) (fractional seconds and offsets accepted, `null` or missing = zero time); passh rewrites the entries it doesn't update as it read them (`2026-11-15T12:00:00.250+02:00` comes back as `2026-11-15T12:00:00.25+02:00`). An offset hour of 24 in any entry makes every later update fail with `the rollback record wasn't updated: …` until the file is fixed (known issue, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)).

### 7.2 Reading

- Missing → empty record.
- Not JSON (a BOM, trailing data), not an object, `version` < 1 (`null` or missing included), or a wrong type anywhere, even in one entry (`"revision": "5"`, a negative or fractional revision, a time that isn't a valid RFC 3339 string) → **damaged**: warning `the rollback record <path> is damaged; a new one is started, so older copies aren't detected this time`; the check continues with an empty record; the next update replaces the file (other vaults' entries are lost). An extra member in an entry is ignored; an entry that is `null` reads as revision 0.
- `version` > 1, or unreadable → warning `the rollback record can't be used, so older copies aren't detected: <path> was written by a newer passh (version <n>)` (or the OS error); no check; the file is never written.
- Not normative (passh's leniency for hand-edited files): member names match case-insensitively (`"VERSION"`, `"Revision"`); for a duplicate member the last wins, and duplicate `vaults` objects merge.

### 7.3 Updating

Under `revisions.lock`: read (§7.2); if the `vault_id` has a revision ≥ the new one and the update isn't forced, stop; else set the entry (`seen_at` = now) and write it as a temporary file, fsync, rename, fsync `<state>`. Updates happen:

- at every open and reload (any command, including `verify --full`, files in the backups folder, and with `rollback.warn = false`) when the `vault_id` is unknown or the revision is higher (for `verify --full` and backup files an open question: [spec.md §14](../../spec.md#14-open-questions));
- after every save and `init`;
- forced, to the lower revision, when the user accepts the prompt.

Failures, a 15 s lock timeout included, are warnings: `the rollback record wasn't updated: …`.

### 7.4 Check at open

**Older** = the `vault_id` is recorded and the file's revision is lower (an equal revision is not older, even with other content).

| Situation | Result |
|---|---|
| not older | continue |
| older, `rollback.warn = false` | continue silently |
| older, report-only open (`verify --full`, the other file of `merge`) | continue; the caller reports it (§6.2) |
| older, the file's real path inside `<state>/backups/` | continue silently |
| older, no terminal (`/dev/tty` can't be opened) | warning on stderr; continue; record unchanged |
| older, a terminal | on `/dev/tty`: `warning: <text>`, then `Continue with this copy? [y/N] ` (default No; answers in [cli.md](cli.md)). Yes → forced update, continue. No → fail `stopped: this copy is older than one seen before on this machine; nothing was changed`. A prompt error (EOF, Ctrl-C, unclear answers) fails with that error |

`<text>` = `this copy is older than one seen before on this machine (r<rev> of <date>; seen r<recorded> of <recorded date>). If you didn't restore it on purpose, the file may have been replaced.`, dates `YYYY-MM-DD` of the two `saved_at` values in UTC. The question comes after the passphrase, since the revision is encrypted.

## 8. Agent folder (§5.3)

The socket's name and folder, how the folder is created and the checks made on it are specified in [agent-session.md §A2.1–§A2.2](agent-session.md#a21-socket-location-must) (`h16` above is the hash used for the socket name). On the storage side: when the agent folder is `<state>/agent`, `<state>` is created as in §1.3 (its missing parents with `mkdir -p` and 0700 reduced by the umask, `<state>` itself 0700 exactly), and the folder is checked again by `doctor` without being created.

## 9. Edge cases

| Case | Behaviour |
|---|---|
| FAT32 / exFAT | modes can't be set (ignored); no exchange → `rename(2)`; no no-replace and no hard links → `lstat` + `rename(2)`; folder fsync may be unsupported (ignored). flock is still required for temporary files |
| network or FUSE file system | the same fallbacks; without flock, saving the vault there and `passh backup` to it fail with `locking the temporary file: …` (which file systems lack flock, e.g. exFAT on macOS, is an open question: [spec.md §14](../../spec.md#14-open-questions)) |
| read-only vault folder | opens; a save fails at step 4, before any backup |
| state folder not writable | opens, with a warning about the record; every save fails at step 1 |
| vault removed, or its symlink retargeted, after opening | changed |
| clock wrong or set back | `saved_at`, backup stamps and `seen_at` are display only; order and the rollback check use revisions and seq |
| two copies of one vault (laptop file, USB copy) | share the backups folder (by `vault_id`, under the backups lock) and the record entry; not the vault lock |
| `$HOME` unset | the default config location, `~` and the default folders fail with `$HOME is not set`; set the XDG variables or use `--vault` |
