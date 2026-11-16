# Appendix: vault file format and data

Normative appendix to [spec.md](../../spec.md) §4.1–§4.5, §4.8 (`verify`), §5.4 (keys, recovery key) and §8. Scope: the vault file byte for byte (the container and its lenient parse, the key and data blocks, the data JSON with its validation and serialization), the entry text form, the path rules and the recovery key format: what a second implementation needs to read and write files that passh accepts, and to behave the same on every input. Where files go on disk, saving and backups are in [storage.md](storage.md). Precedence: see [spec.md §1.1](../../spec.md#11-appendices-normative). Section numbers like §4.5 refer to spec.md.

MUST/SHOULD/MAY are used as in RFC 2119, sparingly. "passh" means the reference implementation. Strings in `code` are exact bytes; LF is 0x0A, CR is 0x0D. "White space" means the Unicode White_Space property: TAB, LF, VT, FF, CR, SP, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000. "Control character" means Unicode category Cc: U+0000–U+001F and U+007F–U+009F. "In any case" means equal under Unicode simple case folding (not only ASCII): `uſername` (U+017F) equals `username`, `K` (U+212A KELVIN SIGN) equals `k`.

**Unicode version** (for every appendix): 15.0.0, for NFC, the general categories (L, M, Nd, Cc, Cf, …), White_Space, simple case folding and East Asian Width. That is what the release builds use: Go 1.26's `unicode` tables (`unicode.Version` = `15.0.0`) and the `norm` and `width` tables of `golang.org/x/text` v0.44.0, which that module picks to match the Go release, so the two always agree. A build with Go 1.27 or later uses 17.0.0 for both. Not normative: behaviour for code points unassigned in Unicode 15.0.0.

Every error below ends the command with exit status 1. It is printed to stderr as `passh: <path>: <message>`; for data damage the list of automatic backups follows (§4.7, [storage.md](storage.md)). Messages are given in English; with `language = ru|sr` they are translated, except the parts that come from the OS.

## 1. Layers and constants

```
vault.passh (text)  = magic line + armor(key block) + armor(data block)          §2
key block  (binary) = age v1 file, one scrypt stanza; plaintext = vault key line §3.2
data block (binary) = age v1 file, X25519 stanza(s) to the vault key's recipient;
                      plaintext = UTF-8 JSON                                     §3.3, §4
```

| Constant | Value |
|---|---|
| Magic line | `passh-vault 1` (container version 1) |
| Armor lines | `-----BEGIN AGE ENCRYPTED FILE-----`, `-----END AGE ENCRYPTED FILE-----` |
| age format | age v1 ([age-encryption.org/v1](https://age-encryption.org/v1)), header line `age-encryption.org/v1` |
| scrypt work factor | log2 N = 18 on write; 1–18 accepted on read; above 18 refused before scrypt |
| Vault key | age X25519 identity, 74 characters: `AGE-SECRET-KEY-1` + 58 Bech32 characters |
| Key block plaintext limit | 4096 bytes |
| Data format / version | `"format": "passh-vault-data"`, `"version": 1` |
| Vault file read limit | 64 MiB (67 108 864 bytes), regular files only |
| Path limit | 1024 bytes after NFC |
| Passphrase | 1–4096 bytes |

## 2. Container (§4.1, §4.5)

### 2.1 Canonical form (written)

A writer MUST produce exactly:

```
file      = "passh-vault 1" LF armor(key-block) armor(data-block)
armor(b)  = "-----BEGIN AGE ENCRYPTED FILE-----" LF
            lines LF
            "-----END AGE ENCRYPTED FILE-----" LF
lines     = base64(b) split into lines of exactly 64 characters, the last 1–64
```

- `base64` is RFC 4648 §4 (standard alphabet, `=` padding). There is no empty line, nothing before line 1 and nothing after the last LF. This is byte for byte what age's own armor writer produces, so the stock `age` tool reads each block.
- Both blocks MUST pass the checks of §2.3 before the file is written; passh refuses otherwise.
- passh writes the canonical form on every save, so a save turns a lenient copy (§2.2) back into it. The key block's *binary* bytes are kept; only its armor is rewritten.

### 2.2 Reading (lenient parse)

Input: the file bytes `D`. Steps, in order:

1. Remove one UTF-8 BOM (`EF BB BF`) at the very start of `D`.
2. Split into lines at CR LF, LF or a lone CR. Trim white space from both ends of every line. A line that is empty after trimming is *blank*.
3. Find the first line that matches `"passh-vault" 1*(SP / HTAB) 1*DIGIT` and nothing else (after trimming). Its number is the container version `V` (leading zeros allowed; a number too large for an int counts as newer).
   - No such line: the trimmed content is empty → `file is truncated: the file is empty`; the trimmed content is a prefix of `passh-vault ` → `file is truncated: it ends in the passh-vault line`; otherwise `not a passh vault`.
   - `V > 1` → `made by a newer passh; upgrade passh (container version V)`. Nothing after the magic line is examined, so a later container version may change everything below it.
   - `V = 0` → `not a passh vault: unknown container version 0`.
4. Non-blank lines before the magic line are ignored with the warning `ignored N line(s) of text before the passh-vault line`.
5. Read block 1, then block 2, from the line after the magic line:
   1. Skip blank lines. No lines left → `file is truncated: block n is missing`.
   2. The line MUST equal the BEGIN line. If it is a proper prefix of the BEGIN line and only blank lines follow → `file is truncated: block n is cut short`; otherwise → damaged, `its BEGIN line is missing or damaged`. So text between the magic line and block 1, or between the blocks, is damage, not ignored.
   3. Concatenate the following lines (blank lines add nothing) up to a line equal to the END line. A BEGIN line first → damaged, `its END line is missing or damaged` (so "file is truncated" means only that the file ends early, as §4.5's table says). End of input first → `file is truncated: block n has no END line`.
   4. Decode the concatenation as strict base64 (padding required, non-zero pad bits rejected; any other character, including inner spaces, fails) → damaged, `bad base64`. Zero bytes → damaged, `the block is empty`.
   5. Check the block (§2.3). Block 1 is fully read and checked before block 2.
6. Non-blank lines after block 2's END line are ignored with the warning `ignored N line(s) of text after the last END line`. A second vault appended to the first is ignored this way.
7. The file is *canonical* if `D` equals the canonical form (§2.1) of the two blocks.

Damaged errors read `file is damaged (block n): <reason>`. Accepted variants include: CRLF, CR, mixed endings, BOM, indented lines, blank lines anywhere, base64 re-wrapped at any width (also one long line), no final newline, text around the vault.

### 2.3 Block checks (no key needed)

| Check | Failure reason (`file is damaged (block n): …`) |
|---|---|
| The block starts with an age v1 header that follows the header rules below. The header MAC is **not** verified: that needs the file key | `bad age header` |
| Block 1: exactly one stanza, type `scrypt`, exactly two arguments. The arguments themselves (salt, work factor) are checked only when opening (§3.2), so `verify` passes `-> scrypt !! abc` | `the key block isn't encrypted with a passphrase` |
| Block 2: at least one stanza of type `X25519` with exactly one argument, and no stanza of type `scrypt`; other stanza types are tolerated. Types compare exactly (`Scrypt` is another type) | `the data block isn't encrypted to a vault key` |
| The payload after the header's MAC line has a length `L` that age's STREAM can produce: `L = 16 + P + 16·max(1, ⌈P / 65536⌉)` for some plaintext length `P ≥ 0` (16-byte nonce, 64 KiB chunks with 16-byte tags, the last chunk shorter, empty only when it is the only one). So 32 and 65 568 are possible, 31 and 65 584 aren't | `the encrypted data has an impossible size (cut short or extended)` |

**Header rules** (the age v1 grammar; any break gives `bad age header`):

1. Line 1 is exactly `age-encryption.org/v1` LF. Every header line ends in LF; a CR anywhere in the header is a break.
2. One or more stanzas, at most 1024. A stanza's first line is `->`, then SP and the type, then 0–128 arguments, each after one SP, then LF. The type and each argument are non-empty strings of bytes 0x21–0x7E (so no double, leading or trailing space, no TAB, no non-ASCII).
3. The stanza's body follows: lines of canonical unpadded base64 (standard alphabet, no `=`, unused bits zero), each decoding to at most 48 bytes (64 characters). The first line decoding to fewer than 48 bytes, possibly the empty line, ends the body; a stanza without such a line is a break.
4. Where a stanza could start, a line starting with `---` is the MAC line: `---` SP and one argument, canonical unpadded base64 of exactly 32 bytes (43 characters), then LF. Any other line must start a stanza.
5. The header, from line 1 up to and including the MAC line's LF, is at most 2 MiB (2 097 152 bytes). The payload is every byte after that LF; nothing lies in between.

Informative: these are the rules of age v1.3.2's header parser (`filippo.io/age`, the reference). "An `scrypt` stanza must be the only stanza" is a decryption rule of age, not part of this check; passh's own rows above cover it.

### 2.4 `verify` and the file's SHA-256 (§4.8)

- `passh verify [file]` runs §2.2 and §2.3 without any key. It prints, on stdout, the file's status (`OK` or `FAILED`), the SHA-256 of the exact file bytes as stored (BOM, CRLF and surrounding text included; lower-case hex, as `sha256sum` prints it) and the size in bytes. SHA-256 and size are printed even when the check fails; the error then follows on stderr with exit status 1. A file that can't be read at all (missing, not a regular file, over 64 MiB, unreadable) prints nothing on stdout ([storage.md §6.2](storage.md#62-passh-verify-file---full)). Warnings of §2.2 and a note when the file isn't canonical go to stderr.
- `verify` without `--full` can't detect damage inside the encrypted payload or the stanza bodies that keeps the sizes valid; only decryption (`--full`, or any opening) authenticates every byte.
- The same whole-file SHA-256 is what a save compares to detect a change on disk (§4.6 step 2, [storage.md](storage.md)). A non-canonical copy has a different SHA-256 from the original although it holds the same blocks.

### 2.5 Size and file type

A vault file larger than 64 MiB is refused before parsing: `not a passh vault: the file is larger than 64 MiB` (opening, `backup`) or `<~path> is larger than 64 MiB: not a passh vault` (`verify`). A path that isn't a regular file after resolving symlinks gives `not a passh vault: not a regular file` (`verify`: `<~path> is not a regular file`; `<~path>` as in [storage.md §0](storage.md#0-conventions)). A writer MUST refuse a save whose encoded file would be larger than 64 MiB (nothing is saved), since no implementation opens it. passh v0.6 doesn't check the size when it saves and writes such a file (known issue, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md) #3).

## 3. Keys and encryption (§4.1, §5.4, ADR-6)

### 3.1 Vault key

- 32 random bytes from a CSPRNG, as an age X25519 identity: Bech32 (BIP 173, not Bech32m) with human-readable part `AGE-SECRET-KEY-` and the 32-byte scalar as data, in upper case: `AGE-SECRET-KEY-1` + 52 data characters + 6 checksum characters = 74 characters.
- Its recipient (`age1…`, X25519 of the scalar with the base point) MUST NOT be written anywhere: not in the vault, a backup, an export, a log or output (S9). Implementations SHOULD hold it only in memory while encrypting a data block.

### 3.2 Key block

**Write.** An age v1 file with one scrypt recipient: a fresh random 16-byte salt, work factor 18 (N = 2^18, r = 8, p = 1 as age defines), and the plaintext `<vault key> LF` (75 bytes), which is a valid age identity file. Informative (a consequence of age's format): its binary form is always 257 bytes, a 150-byte header, a 16-byte nonce, 75 bytes of ciphertext and a 16-byte tag; armored, that is 5 lines of 64 characters and one of 24.

**Read (unwrap).** In this order:

| Step | Condition | Result |
|---|---|---|
| 1 | Empty passphrase | `passphrase is empty` (nothing is tried) |
| 2 | Exactly one `scrypt` stanza with two arguments, whose second argument `A` matches `[+-]?[0-9]+` and is above 18 (a sign and leading zeros allowed: `19`, `+19`, `019`; `N` in the message is its value) | `key block asks for scrypt work factor 2^N; passh uses 2^18: the file is damaged or not made by passh`, before any scrypt work; not retried as a wrong passphrase. The CLI adds the hint line of [storage.md §3.1](storage.md#31-order-of-checks) |
| 3 | age decryption with the passphrase fails for any reason: the stanza's own rules (salt of exactly 16 bytes; `A` in canonical decimal `[1-9][0-9]*` and at most 18, so `018`, `+18`, `0`, `-5` and `abc` land here, before any scrypt work), a wrong passphrase, a bad header MAC, a damaged or truncated payload | `wrong passphrase, or the key block is damaged` (counts as a wrong try) |
| 4 | Plaintext longer than 4096 bytes | `the key block is damaged: it doesn't hold exactly one vault key` |
| 5 | Plaintext read as an age identity file: split at LF, drop one trailing CR per line, skip empty lines and lines starting with `#`. Exactly one line MUST remain, start with `AGE-SECRET-KEY-1` (upper case) and parse as an X25519 identity (checksum included). Otherwise | same message as step 4 |

A key block made by hand from `age-keygen` output (with its comment lines, even CRLF) is therefore accepted; a post-quantum hybrid identity, two keys or a lower-case key are not. A key block with a work factor below 18 is accepted on read; passh never writes one. The CLI asks up to 3 times while the error is step 1 or 3. Not normative: which of steps 2 and 3 handles an `A` above 2^31−1 (passh compares it as a platform integer: 64 bits, 32 on `linux/arm`; beyond that range it falls to step 3).

**Passphrase bytes.** The scrypt password is the exact bytes entered: no trimming, case folding or Unicode normalization, as with the stock `age` tool, so `age -d` opens the key block with the same passphrase. passh's prompt (`/dev/tty`, echo off) ends input at CR or LF, ignores other bytes below 0x20 (so a TAB can't be part of a passphrase), drops escape sequences of arrow and function keys, and accepts at most 4096 bytes.

### 3.3 Data block

**Write.** An age v1 file encrypted to the vault key's recipient (exactly one `X25519` stanza; a fresh file key on every save), plaintext = the JSON of §4. Informative: its binary size is `168 + 16 + P + 16·max(1, ⌈P/65536⌉)` bytes for `P` bytes of JSON.

**Read.** The whole plaintext is authenticated before any of it is used; nothing is shown from a block that fails. Opening maps failures as follows (all with `<path>: ` before them):

| Condition | Message |
|---|---|
| No stanza opens with the key, and the key came from this file's key block (passphrase) or from an agent that unwrapped this key block | `data is damaged; restore a backup (the data block isn't encrypted to this vault's key: damaged or replaced)` + backups |
| No stanza opens with a paper recovery key | `this key doesn't open this vault (rekeyed elsewhere? wrong recovery key?)`; `passh recover`, the only command that opens with a paper key, prints instead `this recovery key doesn't open <~path>: it belongs to another vault, or the vault was rekeyed after the sheet was printed` |
| Any other decryption failure | `data is damaged; restore a backup` + backups |
| Plaintext fails §4 (not JSON, wrong format, a broken rule) | `data is damaged; restore a backup (invalid vault data: <detail>)` + backups. `<detail>` is one of the texts of §4.4, or, for JSON syntax and type errors, the parser's own text (not normative, e.g. `invalid character 'x' after top-level value`) |
| `version` above 1 | `made by a newer passh; upgrade passh (data version)` |

### 3.4 How operations change the blocks

| Operation | Vault key | Key block | Data block |
|---|---|---|---|
| `init` | new | new (wraps it) | new: revision 1, no entries |
| Any change (add, edit, move, rm, tag, import) | same | binary bytes copied unchanged | re-encrypted, revision + 1 |
| `passwd`, `recover` | same | new wrap of the same key (new salt) | re-encrypted, revision + 1 |
| `rekey` | new | new | re-encrypted to the new key, revision + 1 |
| Opening, reading, `verify`, `backup` | — | not written | not written |

So `passwd` keeps the vault key and the entries, but like every change it is a new revision (§4.6, §5.4): the data block is encrypted again and an automatic backup is made.

**Key block identity.** Where passh needs to recognize "the same key block" (the agent, §5.3; backups that belong to a vault, §4.7) it uses the de-armored binary bytes, so line endings and re-wrapping don't matter. The agent protocol carries their SHA-256 in lower-case hex ([agent-session.md](agent-session.md)). Each `passwd` makes a different key block, because the salt is new.

### 3.5 Passphrase strength (§5.4)

`init`, `passwd`, `rekey` and `recover` ask for the new passphrase twice. After the first entry passh scores it with zxcvbn (the Go port `trustelem/zxcvbn` v1.0.1) on its first 100 code points (an invalid UTF-8 byte counts as one), with `passh`, `vault`, `$USER` (if set) and the host name as the kernel reports it (`uname -n`, short or qualified as configured) as user inputs. A score below 3 (of 0–4) prints `warning: weak passphrase: <reason>; use 6 or more random words` (or `warning: weak passphrase; use 6 or more random words` without a reason) before the repetition. It never refuses. The reason follows zxcvbn's feedback for the longest match: a top-10, top-100 or very common password, similar to a common password, a word or names by themselves, common words or names, straight rows or short keyboard patterns, repeats, sequences, recent years, dates, `it is empty or too short`. Not normative: the estimator, its inputs, the score and the reason texts; a re-implementation may warn differently or not at all (the warning goes to `/dev/tty` and changes no file and no exit status). What binds: it never refuses a passphrase. An empty first entry says `The passphrase must not be empty.` and a differing repetition `Passphrases don't match. Try again.`; each uses one of 3 attempts, after which the command fails with `passphrases don't match`.

### 3.6 Paper recovery key (§5.4)

**Layout** (the sheet itself: [print.md](print.md)). Line 1 is `AGE-SECRET-KEY-1`; the 58 characters after it follow in groups of 4 separated by one space, 5 groups per line: three lines of 5, 5 and 5 groups, the last group 2 characters. Lines are separated by LF, without a final LF.

**Input.** The CLI reads the key on `/dev/tty` with every character shown as `*` (a space as a space), on one or several lines, ended by an empty line or Ctrl-D, at most 64 KiB; it asks up to 3 times. The typed bytes are normalized and checked in this order:

1. Remove every white space character and every `-`; turn ASCII `a`–`z` into upper case (other letters stay as they are).
2. Nothing left → `not a valid recovery key: nothing was typed`.
3. It MUST start with `AGESECRETKEY1` → else `not a valid recovery key: it must start with AGE-SECRET-KEY-1`.
4. Every byte after that MUST be one of `QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L` → else `not a valid recovery key: group G, character C is not used in keys (B, I, O and 1 never appear after AGE-SECRET-KEY-1)`, where for the 0-based byte offset `i` after the prefix `G = i/4 + 1` and `C = i mod 4 + 1`.
5. Exactly 58 bytes → else `not a valid recovery key: it has N characters after AGE-SECRET-KEY-1 instead of 58; a character is missing or extra`.
6. `AGE-SECRET-KEY-1` + the 58 characters MUST decode as Bech32 with a valid checksum (and zero padding bits) → else `recovery key has a typo (checksum mismatch)`. Every single substitution and every swap of two neighbouring characters is caught.

Errors never repeat the typed characters. A well-formed key that doesn't open the data block gives the paper-key message of §3.3.

**Damaged key block.** `passh recover` also works when block 1 fails §2.2–§2.3 with a *damaged* error (not truncation): it takes the last armored block in the file (the last BEGIN line, base64 up to the next END line, as leniently as §2.2) as the data block, warns `the key block is damaged; setting a new passphrase rewrites it`, and writes a new key block. Only `passh recover` opens such a vault: every other command, `passwd` and `rekey` included, needs the current key block and stops at the container check (`file is damaged (block 1): …`, with the hint of [storage.md §3.1](storage.md#31-order-of-checks)). A vault opened this way refuses every save that doesn't write a new key block ([storage.md §4.2](storage.md#42-steps) step 0); `recover` writes one at once.

## 4. Data (§4.2)

The data block's plaintext is one JSON object (RFC 8259, UTF-8, no BOM).

### 4.1 Schema

**Top level**

| Key | Type | Read | passh writes |
|---|---|---|---|
| `format` | string | MUST be `passh-vault-data`; checked first | `passh-vault-data` |
| `version` | integer | MUST be a JSON integer; checked second: above 1 → newer, below 1 → invalid | `1` |
| `vault_id` | string | MUST be non-empty; any string | lower-case UUID v4, set by `init`, never changed |
| `revision` | integer 0…2^64−1 | MUST be present | `1` at `init`, + 1 on every save |
| `saved_at` | time | optional | time of the save |
| `entries` | array of entry | optional | always, `[]` if empty |
| `deleted` | array of tombstone | optional | always, `[]` if empty |

**Entry**

| Key | Type | Rule |
|---|---|---|
| `id` | string | non-empty, unique among entries; passh writes a lower-case UUID v4 |
| `path` | string | a valid path (§6), unique among entries after NFC |
| `password`, `username`, `url` | string | single line |
| `tags` | array of string | each a valid tag (§4.3) |
| `fields` | array of field | ordered; keys may repeat |
| `notes` | string | any text, several lines allowed |
| `created_at`, `updated_at` | time | |

**Field**: `key` (string, §4.3 key grammar), `value` (string, single line). **Tombstone**: `id` (non-empty string; neither unique nor checked against the entries), `deleted_at` (time).

**Times** are strings. Written as RFC 3339 in UTC with whole seconds: `YYYY-MM-DDThh:mm:ssZ`. A missing or `null` time is the zero time, written back as `0001-01-01T00:00:00Z`. Read (after JSON unescaping, so `"\u0032026-…"` is fine):

```
time   = date "T" hour ":" MM ":" SS [ ("." / ",") 1*DIGIT ] ( "Z" / ("+" / "-") OH ":" OM )
date   = 4DIGIT "-" 2DIGIT "-" 2DIGIT     ; a real Gregorian date: 2026-02-30 is refused
hour   = 1*2DIGIT                         ; 0–23
MM, SS = 2DIGIT                           ; 00–59: no leap second 60
OH, OM = 2DIGIT                           ; OH 00–24, OM 00–60
```

The fraction may have any number of digits (only the first 9 count). The time is converted to UTC and truncated (not rounded) to whole seconds; the UTC year MUST then lie in 0000–9999 (`0000-01-01T00:30:00+01:00` and `9999-12-31T23:30:00-01:00` are refused). `-00:00` is read as `Z`. Refused, among others: lower-case `t` or `z`, a space for `T`, `24:00:00`, `23:59:60`, no offset, `+0100`, `+01`, `+25:00`, `.Z`, surrounding spaces. Not normative: the forms passh accepts beyond RFC 3339 (a one-digit hour, `,` before the fraction, an offset hour of 24 or minute of 60); a reader MAY refuse them. Errors: `<key>: bad time "<s>"`, `<key>: time "<s>" is out of range`, a non-string `<key>: <parser text>`.

**IDs** are 36-character UUID v4 strings from a CSPRNG (version nibble 4, variant `10`), lower-case hex, written `8-4-4-4-12`. Readers accept any non-empty string.

### 4.2 Reading rules

- Key names are compared after JSON unescaping, case-sensitively and exactly: `"form\u0061t"` is `format`; `"Password"` is an unknown key (§4.5), not the password.
- A duplicate key in one object: the last occurrence wins, for known and unknown keys alike (an unknown key is kept once, with its last value).
- `null` for a known key means its zero value: `""`, `0`, no list, the zero time. So `vault_id: null` fails as `missing vault_id`, `version: null` as `unsupported version 0`, while `revision: null` reads as 0.
- `version` is read as a signed 64-bit integer and `revision` as an unsigned one; both MUST be plain integer literals. Table below.
- Each element of `entries`, `fields` and `deleted` MUST be an object (`null` included: `expected an object, got null`); a wrong JSON type for any known key is invalid. A `null` element of `tags` reads as `""` and fails `invalid tag: a tag can't be empty`.
- Invalid UTF-8 and unpaired surrogate escapes inside JSON strings, and inside the names of unknown keys, are replaced by U+FFFD on read; a writer MUST NOT produce them (passh refuses to, except inside unknown values, §4.6).
- Paths are normalized to NFC and tags normalized (§4.3) as they are read; the normalized form is written on the next save.
- Then the data is validated (§4.4). Any failure: the vault doesn't open (§3.3).

| Input | Result (`invalid vault data: …` unless noted) |
|---|---|
| a BOM, a form feed or other non-JSON white space; bytes other than SP, TAB, LF, CR after the closing `}`; invalid UTF-8 outside strings; a raw (unescaped) U+0000–U+001F inside a string; empty input | invalid (parser text) |
| top level not an object: `[]`, `"x"`, `null` | invalid (`null`: `expected an object, got null`) |
| nesting deeper than 10 000 levels, the top-level object counting as 1 (only possible inside unknown values) | invalid |
| `"version": 1E0`, `1.0`, `"1"`, ≥ 2^63, or missing | `missing or bad version` |
| `"version": 0`, `-0`, `-1` | `unsupported version 0`, `… 0`, `… -1` |
| `"version": 2` (any 2 … 2^63−1) | `made by a newer passh; upgrade passh` (not invalid) |
| `"revision": -0`, `-1`, `1E0`, `1.0`, ≥ 2^64, or missing | `missing or bad revision` |
| a number with a leading zero (`01`) anywhere | invalid (not JSON) |
| `\u0000` (escaped) in a string | allowed where control characters are (password, username, url, field values, notes, `vault_id`, ids, unknown values); refused in paths, tags and field keys by §4.3 and §6.1 |

### 4.3 Content rules

| Rule | Error (`invalid entry: …` / `invalid tag …`) |
|---|---|
| `password`, `username`, `url` and every field value contain no CR or LF; other control characters are allowed (S4 escapes them on screen) | `<name> must be a single line` |
| Every string is valid UTF-8 | `<name> is not valid UTF-8`, `notes are not valid UTF-8` |
| Field key: a letter or decimal digit (Unicode L*, Nd), then letters, digits, marks (M*), `_`, `.`, `-` | `field key "k" is not valid (letters, digits, then also _ . -)` |
| Field key is not `username`, `url` or `tags` in any case (`password`, `notes` and `otp` are allowed as custom keys) | `"URL" can't be a custom field key` |
| Tag: valid UTF-8; normalized to NFC, then white space trimmed; then non-empty, no `,`, no control character | `invalid tag: a tag can't be empty`, `invalid tag "a,b": it contains a comma`, `… it contains a control character`, `… not valid UTF-8` |
| Tags of an entry: duplicates (after normalization) removed, first occurrence and order kept; case-sensitive (`Work` ≠ `work`) | — |

A tag list typed as text (`tags:` line, `passh tag`, the form) is split at `,`; blank items are skipped and each other item is normalized.

**Limits.** None besides those of §1 (path 1024 bytes, file 64 MiB) and §4.2 (JSON nesting): field keys, tags, values and notes have no maximum length, and the numbers of entries, tags, fields and tombstones no maximum. Not normative: limits of the input methods (prompt and editor line lengths, [cli.md](cli.md)).

### 4.4 Validation

On read and before every write: `vault_id` non-empty; every entry has an `id` and a `path`; ids unique; paths unique; every entry passes §4.3; every tombstone has an `id`. Details name the 1-based position: `entry 3: missing id`, `entry 3: duplicate id "x"`, `entry 3: duplicate path "work/a"`, `entry 3: invalid entry: …`, `tombstone 2: missing id`; header problems read `format is not "passh-vault-data"`, `missing or bad version`, `unsupported version 0`, `missing or bad vault_id`, `missing vault_id`, `missing or bad revision`.

Any relaxation of these rules by a later writer (multi-line values, new value types, fewer reserved keys) MUST come with a higher data `version`: a version-1 reader reports such data as damaged.

### 4.5 Unknown keys

Unknown keys are kept at all four levels (top, entry, field, tombstone) through every change: edits, moves, tag changes, `passwd`, `rekey`. An edit that supplies an entry without unknown keys keeps the stored ones. Removing an entry drops its unknown keys with it (the tombstone holds only `id` and `deleted_at`). Kept values are semantically identical; their whitespace and position are not (§4.6).

A **field's** unknown keys live in the field. When new content replaces an entry's fields:

| Change | Fields afterwards |
|---|---|
| `edit --editor` | each field of the new text takes, if there is one, the first stored field with the same key and value not yet taken (stored order), unknown keys included; so a reordered list keeps them, duplicates pair up one to one in order, and a field whose key or value changed loses them |
| the TUI form, `tag`, `mv`, `generate --force` | stored fields unchanged (the form doesn't edit custom fields) |
| `add --force`, `import pass --overwrite` | the new content's fields only: the prompts of `add` enter none, so the old fields go, unknown keys included; an imported field never has unknown keys. The entry's own unknown keys stay |

### 4.6 Serialization (what passh writes)

Informative: readers MUST NOT depend on this, and another writer may lay out its JSON differently; it fixes the plaintext passh produces, which its save read-back compares byte for byte (§4.6 step 5). What binds writers is §4.1–§4.5 (no invalid UTF-8, unknown keys kept).

- Keys in this order, every known key always present (`""`, `[]` when empty): top `format, version, vault_id, revision, saved_at, entries, deleted`; entry `id, path, password, username, url, tags, fields, notes, created_at, updated_at`; field `key, value`; tombstone `id, deleted_at`. Unknown keys follow the known ones of their object, sorted by the UTF-8 bytes of their decoded names (`"\u0061"` sorts, and is written, as `"a"`; `B` < `a` < `e`+U+0301 < `é` < U+FFFF < `😀`), each name encoded like a string below.
- Indented with two spaces per level, `": "` after a key, one array element per line, `[]` and `{}` for empty ones, a final LF.
- Strings: UTF-8 as is, no HTML escaping (`<`, `>`, `&` literal). Escaped: `\"`, `\\`, `\n`, `\r`, `\t`, `\b`, `\f`, other U+0000–U+001F as `\u00xx` (lower-case hex), U+2028 and U+2029 as `\u2028`, `\u2029`. DEL and everything else are literal.
- Unknown values are written as read with insignificant whitespace removed, then indented with the rest: numbers as written (`1E0`, `-0`, `1.50`), escapes kept and unescaped characters left as they are (`\/`, an escaped lone surrogate, a raw U+2028 all stay), duplicate keys inside them kept. Invalid UTF-8 bytes inside an unknown value's strings are copied byte for byte, so passh writes them back although §4.2 forbids it (known issue, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)); a writer SHOULD replace them with U+FFFD.
- Entries keep their stored order (§4.7); `deleted` is in order of deletion.

### 4.7 Changes to the data

| Operation | Effect |
|---|---|
| New vault | new `vault_id`, `revision` 1, `saved_at` now, no entries, no tombstones |
| Every save | `revision` = max(revision of the data being saved, current revision) + 1; `saved_at` = now (UTC, whole seconds). In v1 the two are always equal (every change starts from a copy of the opened data), so a save writes the opened revision + 1; the max is for `merge` (v1.1), which may save the other copy's higher revision. At revision 2^64−1 the next save writes 0, and the next open then asks about an older copy (known issue, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)); a writer SHOULD refuse that save |
| Add | new `id`; `created_at` = `updated_at` = now; appended at the end. A taken path fails with `<path>: already exists`, unless overwriting (`add --force`, `import pass --overwrite`): the existing entry keeps `id`, `created_at`, position and unknown keys and takes the new content, `updated_at` = now |
| Edit (`edit`, the TUI form, `generate --force`, which changes only the password) | by `id`; keeps `created_at`, position and unknown keys; a new path moves it (`<path>: already exists` if taken); `updated_at` = now |
| Move | keeps `id` and position; `updated_at` = now; the destination must not exist (`mv a a` is `already exists`) |
| Remove | the entry leaves the array (others keep their order); a tombstone `{id, deleted_at: now}` is appended. Tombstones are never removed |
| Tag edit | add the given tags, then remove the given ones (compared after normalization), then as Edit |

Add-with-overwrite, edit and tag edit save nothing when nothing would change (same values, tags, fields and unknown keys): no new revision, no backup. The CLI's status line and exit status don't change (`add --force` with identical content still prints `Saved <path>.` and exits 0). Exception: `import pass --overwrite` saves a new revision even when nothing changed (known issue, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md) #7). Move and remove always save. Listings are sorted by path (§6.2), independent of the array order.

**Field lookup** (`show --field`, [cli.md](cli.md)): `password`, `username`, `url`, `notes` give the standard value, `tags` the tags joined with `, `; any other name gives the first custom field with exactly that key (case-sensitive). **Masked like a password** (S5, print, Bitwarden hidden fields): the password, custom fields keyed `password` or `otp` in any case, and any value starting with `otpauth://` (scheme in any case).

## 5. Entry text form (§4.3)

### 5.1 Writing

```
text = password LF
       [ "username: " username LF ]                 ; only if non-empty
       [ "url: " url LF ]                           ; only if non-empty
       [ "tags: " tag *( ", " tag ) LF ]            ; only if there are tags
       *( key ":" [ " " value ] LF )                ; custom fields in order; "key:" if value is ""
       [ "---" LF notes LF ]                        ; only if notes are non-empty
```

### 5.2 Reading

1. The text MUST be valid UTF-8 → else `the text is not valid UTF-8`.
2. Line 1, up to the first LF, is the password exactly, minus one trailing CR (`---`, spaces and `:` included). A text without LF is all password (`abc` and `abc` CR give `abc`; the empty text gives an entry with every value empty). If line 1 ended with CR LF, every CR LF in the rest becomes LF; otherwise other CRs stay (in notes).
3. For each following line `n` (1-based in the text), with one trailing CR removed (whatever line 1 ended with, so a metadata value never keeps the CR of a CR LF line ending; a second CR stays in the value, where step 5 refuses it, except in tags, which are trimmed):
   1. `---` exactly: the notes are everything after this line's LF; stop. `---` CR LF is a separator too; `--- ` (with a space) is not metadata, so it starts the notes and stays in them.
   2. A metadata line is `key ":"` or `key ": " value`: the key is everything before the first `:` and MUST satisfy the field key grammar (§4.3); after the `:` comes either nothing or one space and the value (the rest of the line, verbatim, `:` and spaces included). `PIN:1234`, `k:\tv`, ` username: u`, `Security question: x` and `https://…` are not metadata.
   3. Not metadata: the notes are this line and everything after it; stop.
   4. Key `username` or `url` in any case (Unicode simple folding, so `uſername` too) sets that value; a second one fails with `line n: username appears twice` / `line n: url appears twice`. Key `tags` in any case adds its tags (several lines add up); a bad tag fails with `line n: invalid tag …`. Any other key adds a custom field, with the key as written.
4. If the notes didn't follow `---`, blank (white-space-only) lines at their start are dropped. One final LF is removed from the notes.
5. The result is checked by §4.3 (e.g. `invalid entry: password must be a single line` for a lone CR in line 1).

Reading what was written gives back the same content for every valid entry. The text itself isn't preserved: metadata comes back in the order of §5.1, `Username:` becomes `username:`, several `tags:` lines become one.

### 5.3 `import pass` variant

For `import pass` (§4.9, [import-export.md](import-export.md)) the same reading differs in that: `user:` and `login:` also set the username (any case), and a second username line among them becomes a custom field; every line after line 1 that is `otpauth://…` (after trimming, scheme in any case), in the metadata or the notes, becomes an `otp` field and leaves the notes; a metadata line that can't be stored (a second `username`/`url`, bad tags) goes to the start of the notes instead of failing; trailing blank lines of the notes are dropped.

## 6. Paths and folders (§4.4)

### 6.1 Validation

Applied to every path from the user, a folder argument, an import and the data block. The first rule broken is reported as `invalid path: <reason>` (`invalid folder: <reason>` for folder arguments):

| # | Rule | Reason |
|---|---|---|
| 1 | non-empty | `it is empty` |
| 2 | valid UTF-8 | `it is not valid UTF-8` |
| 3 | normalize to NFC; every later rule applies to the NFC form, which is what is stored | — |
| 4 | at most 1024 bytes | `it is longer than 1024 bytes` |
| 5 | no control character (Cc) | `it contains a control character` |
| 6 | doesn't start with `/` | `it starts with /` |
| 7 | doesn't end with `/` | `it ends with /` |
| 8 | split at `/`, in order for each segment: not empty; not `.` or `..`; first byte not `-` | `it has an empty segment (//)`, `it has a "." or ".." segment`, `a segment starts with -` |

Allowed: spaces anywhere (also at the start or end of a segment), `...`, `.hidden`, `a.`, `~2`, `\`, any letter or emoji, and format characters such as U+200B or U+202E (S4 escapes them on screen).

### 6.2 Semantics

- Paths are case-sensitive and compared by their NFC bytes.
- A folder is the path of a segment prefix; it exists while it holds entries. An entry may have the same path as a folder of other entries: `work` and `work/github` can both exist.
- An entry is inside folder `F` if its path starts with `F/`: `work/x` is in `work`, `workshop/x` is not, and `work` isn't inside itself.
- Order (listings, exports): compare segment by segment, each segment by bytes; a path whose segments run out first sorts first. So `work` < `work/x` < `work-old/y` (plain byte order would put `work-old/y` first).
- Tags filter with AND, compared exactly after NFC and trimming; tag lists with counts are sorted by bytes.

## 7. Worked examples

### 7.1 A vault file

Values are fake; base64 runs are shortened with `…`, and the line lengths are those of a real file.

```
passh-vault 1                                        magic line, container version 1
-----BEGIN AGE ENCRYPTED FILE-----                   block 1: key block, 257 bytes
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IHNjcnlwdC…          64 chars ("age-encryption.org/v1\n-> scrypt …")
…                                                    3 more lines of 64
…                                                    1 line of 64
…=                                                   24 chars
-----END AGE ENCRYPTED FILE-----
-----BEGIN AGE ENCRYPTED FILE-----                   block 2: data block
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOS…          64 chars ("age-encryption.org/v1\n-> X25519 …")
…                                                    lines of 64
…==                                                  last line, 1–64 chars
-----END AGE ENCRYPTED FILE-----
```

Every block's armor starts with `YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+I` (`age-encryption.org/v1` LF `->` SP). De-armored:

```
age-encryption.org/v1                                key block
-> scrypt <22 chars: base64 of the 16-byte salt, unpadded> 18
<43 chars: the wrapped file key>
--- <43 chars: header MAC>
<16-byte nonce><91 bytes: "AGE-SECRET-KEY-1…" LF, encrypted, with its tag>

age-encryption.org/v1                                data block
-> X25519 <43 chars: ephemeral share>
<43 chars: the wrapped file key>
--- <43 chars: header MAC>
<16-byte nonce><STREAM chunks of the JSON below>
```

Informative: an empty vault right after `init` has a 194-byte JSON, so a 394-byte data block of 8 lines of 64 characters and one of 16.

### 7.2 Data JSON, as passh writes it

```json
{
  "format": "passh-vault-data",
  "version": 1,
  "vault_id": "0f6c1d2e-0000-4000-8000-000000000001",
  "revision": 42,
  "saved_at": "2026-11-15T12:00:00Z",
  "entries": [
    {
      "id": "8d1e7a90-0000-4000-8000-000000000002",
      "path": "work/github",
      "password": "s3cr3t-P@ss",
      "username": "arsenii",
      "url": "https://github.com",
      "tags": [
        "work",
        "2fa"
      ],
      "fields": [
        {
          "key": "recovery-email",
          "value": "me@example.com"
        }
      ],
      "notes": "Free-form notes.\nRecovery codes, etc.",
      "created_at": "2026-11-01T09:00:00Z",
      "updated_at": "2026-11-15T12:00:00Z"
    }
  ],
  "deleted": [
    {
      "id": "3b9f0000-0000-4000-8000-000000000003",
      "deleted_at": "2026-11-10T18:30:00Z"
    }
  ]
}
```

Its text form (§5.1):

```
s3cr3t-P@ss
username: arsenii
url: https://github.com
tags: work, 2fa
recovery-email: me@example.com
---
Free-form notes.
Recovery codes, etc.
```

### 7.3 Recovery key

Fake, with a checksum that doesn't verify:

```
AGE-SECRET-KEY-1
QPZR Y9X8 GF2T VDW0 S3JN
54KH CE6M UA7L QPZR Y9X8
GF2T VDW0 S3JN 54KH CE
```

Typed back, `age secret key 1 qpzr-y9x8 gf2t…` (any case, spaces, hyphens, line breaks) normalizes to `AGESECRETKEY1QPZRY9X8GF2T…`; the key is `AGE-SECRET-KEY-1QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7LQPZRY9X8GF2TVDW0S3JN54KHCE`.

## 8. Notes on recovery without passh (§8)

- The stock `age` tool needs canonical armor: 64-column lines, no blank or indented lines. The §8 commands handle LF and CRLF files; for a file with CR-only line endings use `tr '\r' '\n'` instead of `tr -d '\r'`. A re-wrapped file needs `passh backup` (or re-wrapping the base64 at 64 columns by hand).
- With the paper key, `key.txt` holds one line: `AGE-SECRET-KEY-1` followed by the 58 characters, in upper case, without spaces; the stock tool doesn't accept a lower-case key.
- `age -d` asks for the passphrase and uses its exact bytes (§3.2), so the passphrase passh uses works unchanged.
