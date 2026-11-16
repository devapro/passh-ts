# Appendix: import, export and the password generator

Normative appendix to [spec.md](../../spec.md) §4.9 (`import pass`), §7.1 and §7.3 (`export`), S3 and §6.1 (`generate`). Scope: how `import pass` finds and walks a store, runs gpg, parses each entry and reports; every export format byte for byte, with the order of checks and `--age`; the password generator and `passh generate`: what a re-implementation needs for the same import results, byte-identical exports and the same generator. It describes passh as built (v0.6). spec.md gives the design; this appendix gives the exact formats and behaviour. Precedence: see [spec.md §1.1](../../spec.md#11-appendices-normative).

Conventions:

- Messages are quoted in English. The user sees them in the config's language (§3.3, [i18n.md](i18n.md)); data on stdout, names and the phrase `EXPORT PLAINTEXT` never change.
- Errors print as `passh: <message>` on stderr. Exit status 0 = success, 1 = error, 2 = usage error (which also prints `Run 'passh --help' or 'passh <command> --help' for usage.`). Notes are `passh: …` and warnings `passh: warning: …`, on stderr. See [cli.md](cli.md) for these conventions and for escaping (S4).
- `‹x›` marks a value filled in. "Escaped" means the single-line form of the S4 escaping ([agent-session.md §A9.1](agent-session.md#a91-s4-escaping-must)).
- Points this appendix decides, and known issues, are listed in §4.

---

## 1. Import from pass (§4.9)

### 1.1 Command flow

`passh import pass [dir] [--overwrite] [--dry-run]`

1. Check the arguments: 0 or 1 `dir` (else exit 2). `passh import` on its own fails with exit 2: ``say what to import from, e.g. `passh import pass` ``. `passh import ‹other›` fails with exit 2: `unknown command "‹other›" for "passh import"`.
2. Unlock the vault (§5.1). `--dry-run` needs this too, to find conflicts.
3. Find the store (§1.2) and open it as an `os.Root`.
4. Walk it (§1.3), map file names to paths and plan (§1.4). Nothing is read or decrypted yet.
5. Without `--dry-run`, and only if at least one file is planned: start gpg once per planned file, in walk order (§1.5), and parse each plaintext (§1.6). With `--dry-run`, gpg is never looked up or started.
6. Without `--dry-run`, and only if at least one entry survived step 5: apply all entries in **one save** (§1.7).
7. Print the report (§1.8) to **stdout**. Exit 0, even when files were skipped.

On a terminal (stderr is a TTY), step 5 shows progress on stderr before each file: `\r` + `Decrypting ‹n›/‹total›…` + `ESC[K`, where `…` is the one character U+2026 (bytes `E2 80 A6`), translated per `language`. For the last file this is followed at once by `\r` + `ESC[K`, which clears the line.

### 1.2 Locating the store

| Source, first match | Handling |
|---|---|
| `dir` argument | A leading `~/` (or a lone `~`) becomes `$HOME`; `~user` is not expanded. Relative paths become absolute against the working directory |
| `$PASSWORD_STORE_DIR`, if not empty | Same expansion |
| otherwise | `$HOME/.password-store`. `$HOME` must be set and absolute (`$HOME is not set`, `$HOME ("‹v›") is not an absolute path`) |

- The store folder itself may be a symlink. It is followed when the root is opened.
- passh never reads `.gpg-id`. gpg picks the secret key. The store is never written.
- A missing store, or one that isn't a folder, fails with `pass store: open ‹dir›: ‹OS error›` (exit 1). If the root folder can't be listed, the error is `pass store ‹dir›: ‹error›` (exit 1).

### 1.3 Walk

The walk is depth-first and pre-order, through the root (*informative:* the reference uses `fs.WalkDir` on an `os.Root`). Each folder's entries are visited in byte order of their names. Paths are store-relative and use `/` (e.g. `work/github.gpg`). Order matters only for which file wins a duplicate path (§1.4) and for the progress numbers. The final lists are sorted (§1.8).

For every name below the root:

| Item | Name ends in `.gpg` (case-sensitive) | Other name |
|---|---|---|
| Name starts with `.` (file, folder, symlink; e.g. `.git`, `.gpg-id`, `.extensions`) | ignored silently; a folder is not entered | same |
| Folder (including one named `x.gpg`) | entered | entered |
| Folder that can't be listed | skip `unreadable: ‹OS error›` for the folder's own path | same |
| Regular file | **planned** | ignored silently |
| FIFO, device, socket | skip `not a regular file` | ignored |
| Symlink | resolved through the root (see below) | resolved through the root |

Symlinks are resolved with `root.Stat`, which follows links only while they stay inside the store. **Absolute targets always count as leading outside**, even when they point into the store. Chains count as outside as soon as any link leaves the store.

| Symlink resolves to | `.gpg` name | Other name |
|---|---|---|
| A regular file inside the store | **planned** (imported under the link's own path) | ignored |
| A folder inside the store | skip `symlink to a folder: not followed` | same (not entered) |
| A path that leaves the store, or an absolute target | skip `symlink leads outside the store: not followed` | same |
| Nothing (dangling, inside) | skip `broken symlink` | ignored |
| A non-regular file | skip `not a regular file` | ignored |
| Permission error or a loop (ELOOP) | skip `unreadable: ‹OS error›` (e.g. `too many levels of symbolic links`) | ignored |

A dangling link whose target would leave the store (e.g. `../nothing.gpg`) is reported as leading outside. Whether to follow folder links and absolute links that stay inside the store is an open question ([spec.md §14](../../spec.md#14-open-questions)).

### 1.4 Path mapping and planning

For each planned file, in walk order:

1. **Path:** remove one trailing `.gpg` from the store-relative path, then apply the §4.4 validator. The validator normalizes to NFC. If it fails, skip with `invalid path: ‹rule›`. A walk can only break these rules: `a segment starts with -`, `it contains a control character`, `it is not valid UTF-8` and `it is longer than 1024 bytes`.
2. **Duplicate:** a path already produced by an earlier file is skipped with `duplicate path: same path as ‹earlier file›`. This happens only with names that are equal after NFC, such as `café` in NFC and in NFD. The earlier file in walk order wins.
3. **Conflict:** the vault already has an entry at exactly this path (case-sensitive, NFC). Without `--overwrite`: skip `already in the vault: use --overwrite to replace it`. With it, the file is planned as a *replace*.

In a dry run the plan is the result: decryption, parsing and file-reading failures can't show up.

### 1.5 Decrypting with gpg

| Aspect | Rule |
|---|---|
| Program | `gpg2` if found in `$PATH`, else `gpg` (as pass does). Neither found: `gpg not found: import pass needs GnuPG (gpg) to decrypt the store` (exit 1). This is checked only when something needs decrypting |
| Arguments | exactly `--quiet --status-fd 3 --decrypt`. No `--batch`, no file argument |
| stdin | the `.gpg` file's bytes, read through the root by passh. The file is opened `O_RDONLY\|O_NONBLOCK`, and its type is checked on the open file |
| stdout | plaintext into memory |
| fd 3 | write end of a pipe; status lines |
| stderr | `/dev/null`. gpg's human-readable text is never used |
| Environment | inherited. If `$GPG_TTY` is set and not empty, it is passed on unchanged, even if wrong. Otherwise passh adds `GPG_TTY=‹device›`: the controlling terminal's device (e.g. `/dev/pts/3`, never `/dev/tty`), else that of the first of stdin, stderr, stdout that is a terminal; with no terminal it adds nothing. How the device is found: [agent-session.md §A4](agent-session.md#a4-terminal-io-devtty) |
| Shell | none (S8) |

Limits for each file:

| Limit | Value | Result |
|---|---|---|
| Ciphertext size | > 1 MiB (1 048 576 bytes) | skip `too large: larger than 1 MiB`; gpg is not started |
| Plaintext size | > 4 MiB (4 194 304 bytes) | gpg's stdout is closed; skip `decryption failed: the decrypted entry is larger than 4 MiB` |
| Status output | first 1 MiB kept, rest read and discarded | — |
| Status pipe after gpg exits | closed after 2 s if still open (e.g. held by gpg-agent) | — |

There is no timeout on gpg itself: pinentry may wait for the user.

**Status parsing.** Status output is split on LF and one trailing CR is dropped. Only lines starting with `[GNUPG:] ` (with the space) count. They are split on whitespace, and the first field is the keyword.

- **Success** needs all three: exit status 0, a `DECRYPTION_OKAY` line, and none of the failure keywords `DECRYPTION_FAILED BADMDC NODATA BADARMOR UNEXPECTED ERROR FAILURE BAD_PASSPHRASE`. `NO_SECKEY` alone is not a failure: another recipient's key may have decrypted.
- **Import aborted** (nothing saved, exit 1, `import canceled at the passphrase prompt`): an `ERROR` or `FAILURE` line whose third field is an unsigned decimal *c* with `c & 0xFFFF` = 99 (GPG_ERR_CANCELED) or 198 (GPG_ERR_FULLY_CANCELED). This is checked before anything else, so the prompt doesn't come back for every file. If gpg can't be started at all, the import also aborts: `gpg: ‹error›` (exit 1).
- **Otherwise the file is skipped** as `decryption failed: ‹detail›`. The first matching detail applies:

| Status seen | Detail |
|---|---|
| `NO_SECKEY ‹id›…` and no `DECRYPTION_OKAY` | `no secret key for key ID ‹id1›, ‹id2›` |
| `BAD_PASSPHRASE` | `bad passphrase` |
| `MISSING_PASSPHRASE` | `no passphrase given` |
| `NODATA`, `BADARMOR` or `UNEXPECTED` | `not an OpenPGP message (damaged file?)` |
| any failure keyword | `gpg reported ‹line›; ‹line›` (each matching line's fields joined with single spaces, e.g. `BADMDC`, `ERROR decrypt 1`) |
| exit status ≠ 0 | `gpg failed (exit status ‹n›)` |
| none of the above | `gpg did not report a successful decryption` |

A file that can't be opened or read at this stage, including one swapped for an escaping symlink after the walk, is skipped as `unreadable: ‹OS error›` (e.g. `path escapes from parent`). A non-regular file is skipped as `not a regular file`.

### 1.6 Parsing a decrypted entry

The plaintext is parsed with the import variant of the §4.3 text form. Any failure skips the file as `not a text entry: ‹message›`.

**Metadata line.** A line is metadata when it has the form `‹key›:` (value `""`) or `‹key›: ‹value›`. Only **one** space after the colon is removed; the value is otherwise exact (later spaces, trailing spaces). `‹key›` is everything before the first `:`. It must start with a Unicode letter or decimal digit, and the following characters may be letters, digits, combining marks, `_`, `.` or `-`. So `PIN:1234`, `https://x`, `key with space: v` and `Note to self: …` are **not** metadata.

**Algorithm:**

1. The plaintext must be valid UTF-8 (`the text is not valid UTF-8`). There is no other encoding detection and no BOM stripping: a BOM becomes part of the password.
2. Line 1 runs up to the first LF and is the password, exact, minus one trailing CR. If line 1 ended in CRLF, every CRLF in the rest becomes LF. Otherwise each later line loses one trailing CR when it is tested or stored as metadata, but notes keep their CRs.
3. The metadata loop runs over the following lines until it stops:
   - A line exactly `---` ends the metadata. Notes are everything after it ("separated").
   - A line whose whitespace-trimmed text starts with `otpauth://` (ASCII case-insensitive) becomes the field `{otp, ‹trimmed line›}`, and the loop continues.
   - A metadata line is assigned by its key, compared case-insensitively:

     | Key | First occurrence | Later occurrence |
     |---|---|---|
     | `username`, `user`, `login` (shared) | → `username` | key `username`: the line moves to the notes; key `user`/`login`: a custom field with the key as written |
     | `url` | → `url` | the line moves to the notes |
     | `tags` | the list is added to `tags` | added too (tags add up) |
     | any other key (including `password`, `notes`, `otp`) | custom field `{key as written, value}`, in order | same; keys may repeat |

     Tag list: split on `,`, skip blank items, normalize each item to NFC and trim it. A list is invalid when an item then holds a control character (Cc: U+0000–U+001F, U+007F–U+009F, e.g. a TAB inside `a<TAB>b`; a TAB at either end is trimmed), and the **whole line** moves to the notes. That is the only way a `tags:` line fails: invalid UTF-8 was refused in step 1, commas split, and blank items are skipped.
   - Any other line ends the metadata. Notes are this line and everything after it.
4. If the notes were not separated by `---`, leading whitespace-only lines are dropped.
5. The notes are split on LF. Every line whose trimmed text starts with `otpauth://` is removed from the notes and becomes an `{otp, trimmed}` field, after all metadata fields. Lines moved in step 3 go first, in their order, then the remaining note lines. Trailing whitespace-only lines are dropped, and the rest is joined with LF, with no final LF.
6. Validation (§4.2 content rules): password, username, url and field values must not contain CR or LF, so a lone CR inside line 1 fails with `invalid entry: password must be a single line`. Tags are de-duplicated, keeping the first occurrence. Values other than tags and paths are not normalized.

An empty plaintext gives an entry with an empty password. Line 1 is the password even when it is an `otpauth://` URI.

**Example.** This plaintext:

```
pw
otpauth://totp/A?secret=X
login: bob
username: other
URL: https://a
url: https://b
tags: a, , b, a
pin: 1234
PIN:5678
note
  OTPAUTH://totp/B?secret=Y

```

becomes password `pw`, username `bob`, url `https://a` and tags `["a","b"]`. Fields are `otp`=`otpauth://totp/A?secret=X`, `pin`=`1234`, then `otp`=`OTPAUTH://totp/B?secret=Y`. Notes are `username: other\nurl: https://b\nPIN:5678\nnote`.

### 1.7 Writing to the vault

- The entries are added in path order (§1.8), in one save (§4.6). Every entry gets the same "now", the save time in UTC truncated to seconds.
- A **new** path gets a fresh random UUIDv4 `id`, and `created_at` = `updated_at` = now.
- A **replace** (`--overwrite`) keeps the existing `id`, `created_at` and unknown JSON keys, and takes the imported content. `updated_at` becomes now, unless the content is identical, in which case the entry stays unchanged.
- A save happens whenever at least one entry was decrypted, even if every replace was identical. That save is a new revision with a backup.
- If the save fails (e.g. `vault changed on disk`), the import fails with `nothing was imported: ‹error›` (exit 1). The report is not printed.

### 1.8 Report (stdout)

The report lists items sorted by entry path, segment by segment in byte order (`work/x` < `work-old/y`), and skips sorted by store file name in byte order. Every path, file name and detail is escaped (S4); the store path is shown absolute, not `~`-contracted.

```
Dry run: nothing was decrypted or saved. Store: ‹store›          ← dry run only
Would import ‹n› entries:                                         ← dry run, n > 0
  ‹path›
  ‹path›  (replaces the entry in the vault)                       ← two spaces before "("
Would import ‹n› entries‹R›.                                      ← dry run
Imported ‹n› entries‹R› from ‹store›.                             ← real run
Would skip ‹k›: ‹counts›.  |  Skipped ‹k›: ‹counts›.              ← only if k > 0
  ‹store file› — ‹reason›[: ‹detail›]                             ← one per skip; " — " is U+2014
```

- `entries` is `entry` when n = 1, including `Would import 1 entry:`. For n = 0 the forms are `Would import 0 entries.` and `Imported 0 entries from ‹store›.`, with no list.
- `‹R›` is ` (‹m› replacing entries already in the vault)` when m > 0 items replace existing entries, and empty otherwise.
- `‹counts›` is `‹count› ‹reason›` items joined by `, `, in the reason order of the table below. Reasons are not pluralized, e.g. `2 invalid path, 1 already in the vault`.

| Reason (order) | Detail |
|---|---|
| `invalid path` | the validator rule (§1.4) |
| `already in the vault` | `use --overwrite to replace it` |
| `duplicate path` | `same path as ‹file›` |
| `symlink leads outside the store` | `not followed` |
| `broken symlink` | — |
| `symlink to a folder` | `not followed` |
| `not a regular file` | — |
| `unreadable` | OS error text, without the "op path:" prefix |
| `too large` | `larger than 1 MiB` |
| `decryption failed` | §1.5 |
| `not a text entry` | §1.6 message |

Example of a real run:

```
Imported 12 entries from /home/me/.password-store.
Skipped 3: 1 symlink leads outside the store, 1 decryption failed, 1 not a text entry.
  broken.gpg — decryption failed: not an OpenPGP message (damaged file?)
  etclink — symlink leads outside the store: not followed
  latin1.gpg — not a text entry: the text is not valid UTF-8
```

---

## 2. Export (§7.1, §7.3)

### 2.1 Flags and order of checks

`passh export --format F [--tag t]… [--folder f] [-o file] [--age r | --confirm-plaintext] [--spreadsheet-safe]`

| Flag | Notes |
|---|---|
| `--format` | `csv`, `json`, `bitwarden-json`, exact and case-sensitive |
| `--tag` | Repeatable; each value is also split on commas (`--tag a,b` = `--tag a --tag b`); all must match. An empty value is dropped, so `--tag ""` means no tag filter |
| `--folder` | One folder (§4.4 rules); the last one given wins |
| `-o`, `--output` | Path, `~/` expanded, made absolute |
| `--age` | One recipient; the last one given wins. **An empty value counts as no `--age`** (plaintext) |

Checks, in this order. The first failure ends the command.

| # | Condition | Message | Exit |
|---|---|---|---|
| 1 | no `--format` | `--format is required: csv, json or bitwarden-json` | 2 |
| 2 | unknown format | `unknown export format "‹v›" (use csv, json or bitwarden-json)` | 2 |
| 3 | bad `--folder` | `invalid folder: ‹rule›` | 1 |
| 3 | bad `--tag` | `invalid tag "‹t›": it contains a control character` (etc.) | 1 |
| 4 | `--age` and `--confirm-plaintext` | `--age and --confirm-plaintext can't be used together` | 2 |
| 5 | `--spreadsheet-safe` with json or bitwarden-json | `--spreadsheet-safe applies only to --format csv` | 2 |
| 6 | bad `--age` value | see §2.7 | 1 |
| 7 | `-o` path exists (Lstat, so a dangling symlink counts) | `‹path› already exists; passh doesn't overwrite files` | 1 |
| 7 | no `-o` and stdout is a terminal (also for `--age`) | `refusing to write export data to a terminal: add -o file or redirect stdout` | 1 |
| 8 | plaintext, no controlling terminal, no `--confirm-plaintext` | `a plaintext export needs confirmation: without a terminal, add --confirm-plaintext (or encrypt it with --age <recipient>)` | 1 |
| 8 | plaintext and a controlling terminal (`/dev/tty` opens), **even with `--confirm-plaintext`** | prompt on `/dev/tty`: `This writes your passwords unencrypted.` then `Type EXPORT PLAINTEXT to confirm: `. The answer must equal `EXPORT PLAINTEXT` after trimming surrounding whitespace, case-sensitive. Otherwise `not confirmed: you didn't type EXPORT PLAINTEXT`; on EOF `not confirmed: no answer` | 1 |
| 9 | vault key (§5.1): agent, passphrase prompt, or `vault is locked…` | §5.1 | 1 |
| 10 | build in memory, encrypt (§2.7), write | write error (with `-o`, the partial file is removed: `…; the partial file was removed`, or `…; the partial file ‹p› could not be removed (‹err›): delete it`) | 1 |

Nothing reaches stdout or the file unless every step succeeds. The data is written with one write.

After writing, these lines go to stderr in this order:

1. If `-o` and plaintext and the file's folder is not on tmpfs: `passh: warning: ‹dest› isn't on tmpfs: the plaintext is on persistent disk. Delete it when you're done`. tmpfs means: Linux statfs type tmpfs or ramfs; macOS f_fstypename `tmpfs`; no other OS counts.
2. `passh: exported ‹n› entries (‹format›, plaintext) to ‹dest›`, or `(‹format›, encrypted with age)`. The singular is `1 entry`. `‹dest›` is `stdout` or the path, `~`-contracted and escaped.
3. CSV only, if the selected entries have m > 0 custom fields: `passh: warning: CSV has no column for custom fields: ‹m› fields were left out (otp fields included); use --format json or bitwarden-json to keep them`. The singular is `1 field was left out`.

`-o` files are created with `O_CREAT|O_EXCL` (never through a symlink, never overwriting) and mode 0600, then fsynced, and the folder is fsynced on a best-effort basis.

### 2.2 Selection and order

- `--folder f` selects entries strictly inside `f` at any depth: `work` holds `work/x` and `work/a/b`, but not `workshop/x` and not an entry whose path is exactly `work`.
- `--tag` selects entries that have every given tag. Tags are compared exactly, after trimming and NFC.
- Entries are sorted by path, segment by segment, each segment by bytes. Tags and fields keep their stored order.

### 2.3 JSON text rules (json and bitwarden-json)

The rules are those of Go's `encoding/json` with HTML escaping off, indented with two spaces:

- Layout: `{`/`[` then a newline. Each member goes on its own line, indented two spaces per level, as `"key": value`, and lines end with `,` except the last. Empty arrays and objects are `[]` and `{}`. The file ends with `}` and LF.
- In strings, these are escaped: `"` → `\"`, `\` → `\\`, U+0008 → `\b`, U+000C → `\f`, LF → `\n`, CR → `\r`, TAB → `\t`, any other U+0000–U+001F → `\u00XX` (lowercase hex), U+2028 → `\u2028`, U+2029 → `\u2029`.
- Everything else is literal UTF-8, including `<`, `>`, `&`, `/`, DEL (U+007F) and C1 characters.
- Numbers are plain integers. Values are never invalid UTF-8: the vault refuses such data.

### 2.4 `json`

The data format of §4.2 (see [vault-format.md](vault-format.md)) with these differences:

- `exported_at` is added after `saved_at`. Its value is the export time in UTC, truncated to seconds, in RFC 3339 (`2026-11-16T18:21:42Z`).
- `deleted` is left out.
- `entries` holds only the selected entries, in the §2.2 order. An empty selection gives `[]`.
- The header (`vault_id`, `revision`, `saved_at`) is the vault's own, also for a filtered export.

Key order:

- top level: `format`, `version`, `vault_id`, `revision`, `saved_at`, `exported_at`, `entries`, then the data's unknown keys;
- entry: `id`, `path`, `password`, `username`, `url`, `tags`, `fields`, `notes`, `created_at`, `updated_at`, then unknown keys;
- field: `key`, `value`, then unknown keys.

Unknown keys come in byte order of the key. Their values are copied from the vault with whitespace removed, then re-indented, so number text and string escapes are kept as they were. Every standard key is always present (`""`, `[]`).

Not normative: the export of data that holds an unknown top-level key `exported_at`. The reference then writes `exported_at` twice, the export time after `saved_at` and the stored value among the unknown keys (verified; known issue, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)); a re-implementation needn't reproduce that.

```json
{
  "format": "passh-vault-data",
  "version": 1,
  "vault_id": "364c1458-fbc9-46a7-9a1f-3d275180e828",
  "revision": 2,
  "saved_at": "2026-11-16T18:21:42Z",
  "exported_at": "2026-11-16T18:21:42Z",
  "entries": [
    {
      "id": "7ecc4de1-e4b2-4672-9bb9-2b764e680774",
      "path": "router",
      "password": "=admin",
      "username": "",
      "url": "",
      "tags": [],
      "fields": [],
      "notes": "",
      "created_at": "2026-11-16T18:21:42Z",
      "updated_at": "2026-11-16T18:21:42Z"
    },
    {
      "id": "56d9d9ab-982f-41d3-9424-9e15b976fb93",
      "path": "work/github",
      "password": "s3cr3t-P@ss",
      "username": "arsenii",
      "url": "https://github.com",
      "tags": [
        "work",
        "dev",
        "2fa"
      ],
      "fields": [
        {
          "key": "recovery-email",
          "value": "me@example.com"
        },
        {
          "key": "otp",
          "value": "otpauth://totp/GitHub:arsenii?secret=JBSWY3DPEHPK3PXP"
        }
      ],
      "notes": "Recovery codes in the safe.\nSecond line, \"quoted\".",
      "created_at": "2026-11-16T18:21:42Z",
      "updated_at": "2026-11-16T18:21:42Z"
    }
  ]
}
```

The output is valid vault data: the passh data decoder reads it back.

### 2.5 `csv`

- UTF-8 without a BOM. Every record, the header included, ends in **CRLF**. There is no blank line at the end.
- The header is `folder,name,username,password,url,tags,notes`. Each entry gives one record, in the §2.2 order:

  | Column | Value |
  |---|---|
  | folder | the path without its last segment (`""` at top level, `a/b` when nested) |
  | name | last path segment |
  | username, password, url, notes | exact |
  | tags | joined with `, ` |

- Custom fields, `otp` included, have no column and are counted for the warning in §2.1.
- Quoting is per cell. A cell is wrapped in `"…"` when it contains `,`, `"`, CR or LF, or when it starts or ends with a space or TAB. Inside quotes, `"` becomes `""`. Nothing else is escaped: **line breaks inside notes are written as they are** (LF stays LF, CR stays CR). An empty cell is empty.
- `--spreadsheet-safe` puts `'` in front of every data cell (folder and name included; the header is unchanged) whose **first byte** is `=`, `+`, `-`, `@`, TAB or CR. Quoting is then decided on the changed cell. The prefix is added before quoting, so `"\tTAB"` becomes `'\tTAB`, unquoted.

The same two entries (`·` = CR, `¶` = LF; the notes cell holds a bare LF):

```
folder,name,username,password,url,tags,notes·¶
,router,,=admin,,,·¶
work,github,arsenii,s3cr3t-P@ss,https://github.com,"work, dev, 2fa","Recovery codes in the safe.¶
Second line, ""quoted""."·¶
```

With `--spreadsheet-safe`, the second line becomes `,router,,'=admin,,,·¶`.

### 2.6 `bitwarden-json`

This is Bitwarden's unencrypted export schema, which Bitwarden and Vaultwarden import as "Bitwarden (json)". It follows the §2.3 rules and is written by an encoder with 2-space indent and a final LF.

Top level: `encrypted` (`false`), `folders`, `items`.

**Folders.** Every distinct folder path of the selected entries is listed, **with each of its ancestors** (`a/b/c/leaf` lists `a`, `a/b` and `a/b/c`). Folders are sorted by byte order of the name (`work` < `work-old` < `work/dev`). Each is written as `{"id", "name"}`, where `name` is the folder path with `/`.

**Items.** There is one item per entry, in the §2.2 order. Keys come in this order:

| Key | Value |
|---|---|
| `passwordHistory` | `null` |
| `revisionDate` | `updated_at` as `YYYY-MM-DDTHH:MM:SS.000Z` (UTC, always `.000`) |
| `creationDate` | `created_at`, same form |
| `deletedDate` | `null` |
| `id` | derived UUID (below) |
| `organizationId` | `null` |
| `folderId` | id of the entry's direct folder; `null` at top level |
| `type` | `1` (login) |
| `reprompt` | `0` |
| `name` | last path segment |
| `notes` | notes, or `null` if empty |
| `favorite` | `false` |
| `fields` | custom fields (below); **the key is left out** when there are none |
| `login` | `fido2Credentials` (`[]`), `uris` (left out when url is empty, else `[{"match": null, "uri": ‹url›}]`), `username` (`null` if empty), `password` (`null` if empty), `totp` (`null` or a value, below) |
| `collectionIds` | `null` |

**TOTP.** The first field whose key equals `otp` case-insensitively becomes `login.totp`, **whatever its value**: an empty one gives `"totp": ""`, and a later `otp` or `otpauth://` field then stays a hidden custom field (known issue, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)). If there is none, the first field whose value starts with `otpauth://` (case-insensitive) becomes it. That field is left out of `fields`. `"totp": null` only when no field qualifies.

**Fields.** The other custom fields come in order as `{"name": key, "value": value, "type": T, "linkedId": null}`; an empty value is written `"value": ""`, never `null`. T is `1` (hidden) when the key is `password` or `otp` (case-insensitive) or the value starts with `otpauth://`, and `0` (text) otherwise. If the entry has tags, one last field follows, with the same four members: `{"name": "tags", "value": tags joined with ", ", "type": 0, "linkedId": null}`. No custom field can be named `tags` (§4.3 reserved key).

**Ids.** The ids are deterministic, so exporting twice gives identical bytes:

```
uuid(parts…) = first 16 bytes of SHA-256("passh bitwarden-json id" ‖ 0x00 ‖ part1 ‖ 0x00 ‖ part2 …)
               with byte 6 = (b6 & 0x0F) | 0x80   (version 8)
               and  byte 8 = (b8 & 0x3F) | 0x80   (RFC 9562 variant),
               lowercase hex as 8-4-4-4-12
item id   = uuid("item", entry id)
folder id = uuid("folder", vault_id, folder path)
```

Test vectors:

- `uuid("item","56d9d9ab-982f-41d3-9424-9e15b976fb93")` = `87c1129d-bd48-85fb-a157-7e78ebbb7a0d`
- `uuid("folder","364c1458-fbc9-46a7-9a1f-3d275180e828","work")` = `07843e65-6a7c-8b82-8397-6aa43dbcb6ff`
- `uuid("item","8d1e7a90-0000-4000-8000-000000000001")` = `6cea433d-74fd-8314-a7e1-35702e643c3b`

**Dropped:** the passh entry `id` (only hashed), `vault_id`, `revision` and the other header fields, tombstones, and every unknown JSON key. Paths survive as folder + name, and tags survive as the `tags` field.

For the two entries above:

```json
{
  "encrypted": false,
  "folders": [
    {
      "id": "07843e65-6a7c-8b82-8397-6aa43dbcb6ff",
      "name": "work"
    }
  ],
  "items": [
    {
      "passwordHistory": null,
      "revisionDate": "2026-11-16T18:21:42.000Z",
      "creationDate": "2026-11-16T18:21:42.000Z",
      "deletedDate": null,
      "id": "5879b159-7a3b-8709-a577-3a8f726ba26a",
      "organizationId": null,
      "folderId": null,
      "type": 1,
      "reprompt": 0,
      "name": "router",
      "notes": null,
      "favorite": false,
      "login": {
        "fido2Credentials": [],
        "username": null,
        "password": "=admin",
        "totp": null
      },
      "collectionIds": null
    },
    {
      "passwordHistory": null,
      "revisionDate": "2026-11-16T18:21:42.000Z",
      "creationDate": "2026-11-16T18:21:42.000Z",
      "deletedDate": null,
      "id": "87c1129d-bd48-85fb-a157-7e78ebbb7a0d",
      "organizationId": null,
      "folderId": "07843e65-6a7c-8b82-8397-6aa43dbcb6ff",
      "type": 1,
      "reprompt": 0,
      "name": "github",
      "notes": "Recovery codes in the safe.\nSecond line, \"quoted\".",
      "favorite": false,
      "fields": [
        {
          "name": "recovery-email",
          "value": "me@example.com",
          "type": 0,
          "linkedId": null
        },
        {
          "name": "tags",
          "value": "work, dev, 2fa",
          "type": 0,
          "linkedId": null
        }
      ],
      "login": {
        "fido2Credentials": [],
        "uris": [
          {
            "match": null,
            "uri": "https://github.com"
          }
        ],
        "username": "arsenii",
        "password": "s3cr3t-P@ss",
        "totp": "otpauth://totp/GitHub:arsenii?secret=JBSWY3DPEHPK3PXP"
      },
      "collectionIds": null
    }
  ]
}
```

An empty selection gives `"folders": []` and `"items": []`.

### 2.7 `--age` encryption

- **Recipient:** surrounding whitespace is trimmed. Then the value is matched in this order:

  | Value | Result |
  |---|---|
  | starts with `age1pq1` | the age hybrid post-quantum recipient built into age v1.3.0 and later (the recipients `age-keygen -pq` prints; HPKE with ML-KEM-768 + X25519, stanza type `mlkem768x25519`, as `filippo.io/age` v1.3.2 implements it); a compatible implementation MUST accept it, since passh does |
  | starts with `age1` | an age X25519 recipient (bech32 with checksum) |
  | starts with `AGE-SECRET-KEY-` (any case) | error `--age: this is an age secret key; give its public recipient (age1…), as printed by age-keygen -y` |
  | empty after trimming | error `--age: the recipient is empty; give an age public key (age1…)` |
  | anything else (SSH keys, `AGE1…`, …) | error `--age: not an age recipient; give an age public key (age1…)` |

  If an `age1…` value fails to parse, the error is `--age: invalid age recipient "‹value›": ‹age error›`. Only values that look like a recipient are echoed in errors, so a pasted secret key is never repeated. Plugin recipients such as `age1yubikey1…` are refused, and there is one recipient only.
- **Output:** one age file encrypted to that recipient, always in age's **ASCII armor**: `-----BEGIN AGE ENCRYPTED FILE-----` LF, base64 in 64-column lines, `-----END AGE ENCRYPTED FILE-----` LF. The plaintext inside is the exact bytes the format would have written. `age -d -i key` reads the armored file directly.
- An encrypted export needs no confirmation and gives no tmpfs warning. It is still never written to a terminal.

---

## 3. Password generator (S3)

### 3.1 Alphabets

The order matters because a random byte maps to an index:

| Name | Characters, in index order | Size n | Rejection limit L = 256 − (256 mod n) |
|---|---|---|---|
| default | `A`–`Z`, `a`–`z`, `0`–`9` | 62 | 248 |
| `--symbols` | default, then ``!"#$%&'()*+,-./:;<=>?@[\]^_`{\|}~`` (the 32 printable ASCII punctuation characters, in ASCII order) | 94 | 188 |

Index 0 is `A`, 26 is `a`, 52 is `0`, and in the symbols alphabet 62 is `!` and 93 is `~`.

There are **no class guarantees** ("at least one digit"): forcing classes would make some passwords more likely than others. The CLI and config offer no other alphabet (see §4). Internally, a custom alphabet must have 2–256 distinct code points, be valid UTF-8, and hold no control (Cc) or space characters.

### 3.2 Algorithm

```
out ← []
while |out| < length:
    read exactly (length − |out|) bytes from crypto/rand      (a short read or error fails: "reading random bytes: …")
    for each byte b, in order:
        if b < L: append alphabet[b mod n] to out              (b ≥ L is discarded, never reduced)
```

The result consists of the first `length` accepted bytes of the random stream, mapped. passh never reads more bytes than it examines.

Test vectors, given as a byte stream and the resulting password:

- default, length 5, `F8 FF 00 3D 3E F7 64` → `A9A9m`
- symbols, length 4, `BC 00 FF 5D C8 BB 5E` → `A~~A`

**Strength** is shown as `⌊length × log2(n)⌋` bits: 24 default → 142; 24 symbols → 157; 32 symbols → 209.

### 3.3 `passh generate <path> [len] [--symbols] [-f|--force]`

| # | Check | Message | Exit |
|---|---|---|---|
| 1 | 1 or 2 arguments | cobra's argument-count message | 2 |
| 2 | path (§4.4) | `invalid path: ‹rule›` | 1 |
| 3 | `len` is a decimal integer from 1 to 4096 (an optional sign and leading zeros are accepted: `+5`, `007`) | `length "‹arg›": give a number from 1 to 4096` | 2 |
| 4 | vault key (§5.1) | §5.1 | 1 |
| 5 | path exists without `--force` | `‹path› already exists: use --force to replace its password (its other values are kept)` | 1 |

Without `len`, the length is 24.

- **New path:** creates an entry with only `path` and `password` (§1.7 rules for id and times).
- **Existing path with `--force`:** replaces only `password`; username, url, tags, fields, notes and id stay. `updated_at` becomes now.
- **The password is never printed.** stdout stays empty. Exactly this message goes to stderr:

  ```
  Stored ‹path›: a new ‹len›-character password (‹kind›, ‹bits› bits).
  Show it with: passh show ‹qpath› --field password
  ```

  `Replaced the password of ‹path›: …` replaces `Stored ‹path›: …` for `--force`. `‹kind›` is `letters and digits` or `letters, digits and symbols`. `‹path›` is escaped. `‹qpath›` is the path as is when every character is in `[A-Za-z0-9/._\-+@:,=]`; otherwise it is in single quotes, with `'` written as `'\''`.

The same generator with the defaults (24 characters, letters and digits) is used by:

- `passh add`, when the password prompt is left empty. It prints `Generated a 24-character password.` before `Saved ‹path›.`
- the built-in entry form (`ctrl+g`). Its status line reads `Generated a new password (24 characters); ctrl+r shows it.`, or `…; it is shown.` while the password is revealed.

---

## 4. Points decided here, and points reported

Edge cases this appendix describes as passh behaves today, and where each one is tracked, so a re-implementation can follow passh exactly:

1. The generator offers no alphabet setting, only `--symbols` (§3.1). Now in spec §5.5 S3.
2. bitwarden-json: a field named `otp` in any case, or else the first `otpauth://` value, becomes `login.totp`; ancestor folders are listed; `password`-named fields are hidden too (§2.6). Now in spec §7.1.
3. `--age` accepts hybrid post-quantum recipients (`age1pq1…`), and the output is always armored (§2.7). Now in spec §7.1.
4. `--age ""` is a plaintext export; `--tag ""` is ignored, and `--tag a,b` is two tags (§2.1). Code issues in [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md).
5. A plaintext larger than 4 MiB is reported as `decryption failed`, not `too large` (§1.5). Code issue, same file.
6. If the vault data holds an unknown top-level key `exported_at`, the json export writes that key twice (§2.4; verified with a crafted vault). Code issue, same file; not normative.
7. Absolute symlinks into the store, and symlinks to folders inside the store, are not followed (§1.3). Open question in spec §14.
8. An `--overwrite` import whose content is identical still saves a new revision (§1.7). Code issue, same file.
9. bitwarden-json: a first `otp` field with an empty value becomes `"totp": ""`, and a real `otpauth://` value in a later field is exported as a hidden custom field instead (§2.6). Code issue, same file.
10. `--tag` takes only the first line of a value (`--tag "$(printf 'a\nb')"` filters by `a` alone): part of the string-slice issue of point 4.
