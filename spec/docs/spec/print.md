# Appendix: printing (sheets and the print page)

Normative appendix to [spec.md](../../spec.md) §5.4, §7.2, §7.4 and §8. Scope: `passh print` and `passh recovery-key print`; the password sheet and the recovery key sheet (model, layout grid, text form, pagination); the one-shot print page (addresses, certificate, TLS, requests, results, HTML and CSS) and its terminal dialog. Precedence: see [spec.md §1.1](../../spec.md#11-appendices-normative). Quoted texts are the English (`en`) catalogue; texts for people are translated per spec §3.3 ([i18n.md](i18n.md)), and §8 lists the frame strings of the sheets in all three languages. Field labels (`password`, `username`, …), `vault_id`, the key, the commands, dates and the typed phrases are the same in every language.

Related appendices: [cli.md](cli.md) (exit statuses, `-o` and stdout rules shared with `export`), [tui.md](tui.md) (its §7.8 print setup and §7.9 print dialog), [agent-session.md](agent-session.md) (how the vault key is obtained), [i18n.md](i18n.md).

Exit statuses below: 0 success, 1 error, 2 usage error. Errors are printed as `passh: <message>` on stderr.

## 1. Commands

### 1.1 `passh print` (text sheet)

Flags: `--tag t` (string slice: repeatable, and `a,b` is two tags; all must match; `--tag ""` adds no tag, so it filters nothing: known issue, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)), `--folder f`, `--fields list`, `-o/--output file`, `--confirm-plaintext`, `--web`. A hidden `--format` exists only to explain its removal. Steps, in this order; the first failing one ends the command:

| # | Check / action | Failure → message | Exit |
|---|---|---|---|
| 1 | `--format` given | `PDF output was removed; use --web to print from a browser (it can save as PDF), or omit --format for the text sheet` | 2 |
| 2 | `--web` with `-o` | `--output can't be used with --web` | 2 |
| 3 | `--web` with `--confirm-plaintext` | `--confirm-plaintext can't be used with --web: the print page needs a terminal` | 2 |
| 4 | `--folder` through the path validator (spec §4.4) | the validator's error, e.g. `invalid folder: it has a "." or ".." segment` | 1 |
| 5 | each `--tag`: NFC, trim; not empty, no comma, no control character | `invalid tag …` | 1 |
| 6 | `--fields` parsed (§2.1) | `invalid field "a b": use password, username, url, tags, notes, fields, or the key of a custom field` | 2 |
| 7 | config loaded | config errors (cli.md) | 1 |
| 8 | output: without `-o`, stdout must not be a terminal; with `-o`, nothing may exist at the path (`lstat`, so a dangling symlink counts) | `refusing to write the sheet to a terminal: add -o file or redirect stdout` / `<path> already exists; passh doesn't overwrite files` | 1 |
| 9 | confirmation (spec §7.1 rules): if `/dev/tty` opens, the terminal shows `The sheet holds your passwords unencrypted.` and asks `Type EXPORT PLAINTEXT to confirm: ` (even when `--confirm-plaintext` is given); without a terminal `--confirm-plaintext` is required | `not confirmed: you didn't type EXPORT PLAINTEXT` / `not confirmed: no answer` (EOF) / `printing needs confirmation: without a terminal, add --confirm-plaintext` | 1 |
| 10 | unlock through the key chain of spec §5.1 | as for any command | 1 |
| 11 | build the sheet (§2) | `no entries to print: the vault has no entries` (no `--folder`, no `--tag`) / `no entries to print: none matches <scope>` (`<scope>` as in §2.3: `folder work`, `tag a`, `tags a, b`, `folder work; tag a`) / `invalid field "pin": no selected entry has a field with this key` | 1 |
| 12 | render (§4) and write (§1.5) | write errors | 1 |
| 13 | stderr: the tmpfs warning (§1.5) if any, then `passh: printed N entries (text sheet) to <dest>; print it, then delete the file` (`<dest>` is the path with `~` for the home folder, or `stdout`; singular `printed 1 entry …`) | — | 0 |

### 1.2 `passh print --web`

Steps 1–7 of §1.1, then:

1. `print_web.enabled` false → `the print page is off: set enabled = true in the [print_web] table of the config file` (exit 1).
2. `/dev/tty` doesn't open → ``the print page needs a terminal (over SSH: use `ssh -t`)`` (exit 1).
3. `Type PRINT to confirm: ` on the terminal; anything but `PRINT` (after trimming surrounding white space, case-sensitive) → `not confirmed: …` (exit 1).
4. Unlock, build the sheet (step 11 of §1.1). The vault is closed again before the server starts; the sheet stays in memory until the process ends.
5. Start the server (§6) and run the terminal dialog (§6.9). Outcome `Served` → stderr `Done: <result>.` (§6.7), exit 0; any other outcome → `passh: <result>`, exit 1.

### 1.3 `passh recovery-key print [-o file] [--web]`

`passh recovery-key` alone → usage error ``say what to do, e.g. `passh recovery-key print` `` (exit 2). For `print`:

1. `--format` / `--web` with `-o` → as steps 1–2 of §1.1 (exit 2). Config loaded.
2. With `--web`: steps 1–2 of §1.2, then `Type PRINT RECOVERY KEY to confirm: ` (the spec §5.4 phrase, not `PRINT`).
   Without `--web`: output check as step 8 of §1.1 with `refusing to write the recovery key to a terminal: add -o file or redirect stdout`; then a terminal is required even when stdout is redirected: ``passh recovery-key print needs a terminal (over SSH: use `ssh -t`)``; then `Type PRINT RECOVERY KEY to confirm: `.
3. Unlock through the usual chain (agent first, spec §5.1); the sheet gets the vault key, `vault_id` and the current time.
4. `--web`: serve as §1.2 step 5. Otherwise write (§1.5), then on stderr: the tmpfs warning if any, `Wrote the paper recovery key to <dest>.`, and only with `-o`: `passh: print it, keep the sheet offline, then delete the file: rm <path>` (path shell-quoted with `'…'` unless it has only `A–Z a–z 0–9 / . _ - + @ : , =`).

`passh init` offers the same sheet after creating the vault: `Print the recovery key now? [Y/n] ` (default yes). No (or no answer) → the hint `Print the paper recovery key now and keep the sheet offline:` / `  passh recovery-key print -o <file>   (or --web, with the key as a QR code)` / `Without it, a forgotten passphrase means the data is lost.`. Yes → `Write the text sheet to [<default>]: ` where the default is `/dev/shm/passh-recovery.txt` if `/dev/shm` is tmpfs, else `~/passh-recovery.txt`; an empty answer takes the default; a path that exists or can't be expanded is refused (the reason is shown) and asked again, 3 attempts in all; then `PRINT RECOVERY KEY`, the write, the two messages above and `For a version with the key as a QR code: passh recovery-key print --web`.

### 1.4 Order of confirmation and unlock

The confirmation phrase is always asked **before** the vault is unlocked, and the output destination is checked before both, so a refused destination never costs a passphrase prompt. "Nothing matches" and an unknown custom field key are found only after unlocking (§2).

### 1.5 Output (`-o` or stdout)

- `-o` path: `~` expanded; created with `O_WRONLY|O_CREAT|O_EXCL`, mode 0600 (chmod 0600 again, failure ignored for file systems without modes), written, `fsync`ed, closed, then the folder `fsync`ed (best effort). On any failure the partial file is removed and the error says `…; the partial file was removed` or `…; the partial file <path> could not be removed (<err>): delete it`.
- After a successful `-o` write, if the file's folder is not tmpfs: `passh: warning: <path> isn't on tmpfs: the plaintext is on persistent disk. Delete it when you're done`. tmpfs test: Linux `statfs` type `TMPFS_MAGIC` or `RAMFS_MAGIC`; macOS `statfs` `f_fstypename == "tmpfs"`; other systems: never tmpfs.
- Without `-o` the sheet bytes go to stdout unchanged; the messages still go to stderr.

## 2. Password sheet model

### 2.1 `--fields`

- Split at `,`; blanks around names trimmed; empty names skipped; duplicates kept once, first position wins; printed in the order given.
- `password`, `username`, `url`, `tags`, `notes` and `fields` (= every custom field) match in any case and are stored lower case. Any other name must be a valid custom field key (first character a letter or digit, then letters, digits, combining marks, `_`, `.`, `-`) and matches custom fields with exactly that key (case-sensitive; `pin` and `PIN` are two fields). A custom field whose key equals a standard name in another case (e.g. `Notes`) can only be printed through `fields`.
- No names at all (empty value) → the default `password,username,url`.
- A custom field key that no **selected** entry has → error (step 11, exit 1). `otp` and `otpauth://` values get no masking on a sheet: a chosen field is printed in full.

### 2.2 Selection, grouping, order

1. Select entries inside `--folder` at any depth (segment-aware: `work` holds `work/x` and `work/a/y`, not `workshop/x`, not an entry named `work`) that have **all** `--tag` tags (exact, case-sensitive, after NFC and trim). None → the no-entries error of §1.1 step 11 (the selection is described as in §2.3).
2. Group by the entry's immediate folder (the path without its last segment; `""` = top level). `work` and `work/dev` are separate groups; there is no nesting.
3. Order groups: top level first, then by folder path compared segment by segment, each segment by bytes (`work` < `work/dev` < `work-old`). Entries within a group by name, bytewise. No locale collation in any language.

### 2.3 Header block

Rows, in order (all text escaped by S4 in its single-line form, then wrapped as prose at 80 columns, §3.4):

1. Title: `passh password sheet`.
2. `printed <date> · <N entries>` and, when filtered, ` · <scope>`; `<date>` is the print date in local time as `YYYY-MM-DD HH:MM`, with no zone; the count is a plural (`1 entry`, `2 entries`). `<scope>` = `folder <f>` and/or `tag <t>` (one `--tag`) / `tags <t1>, <t2>` (two or more, in the order given, normalized, repeats kept), joined by `; `, folder first.
3. `fields: <names joined by ", ">`.

### 2.4 Entry rows

Per group: a folder heading (folder path, or `(top level)`), then per entry its name (last path segment) and one labelled value per chosen field, in field order. Empty values are left out (an entry may show only its name).

| Field | Label | Value lines | Spaces marked (§3.3) |
|---|---|---|---|
| `password`, `username`, `url` | the field name | 1, S4 single-line form | yes |
| custom (`fields` or a key) | the field's key (S4 single-line form) | 1 per field, in stored order, S4 single-line form | yes |
| `tags` | `tags` | 1: tags joined with `, `, S4 single-line form | no |
| `notes` | `notes` | S4 multi-line form (LF and TAB kept, CR as `\r`); then the trailing run of LF, space and tab removed; split at LF; in each line, tabs expanded to the next multiple of 4 columns (counting one column per character); each line laid out separately | no |

## 3. The layout grid (text sheet and print page)

Both outputs draw the same rows; the page adds the QR row and uses CSS instead of `paginate` (§4.2).

### 3.1 Constants

| Constant | Value |
|---|---|
| Columns (line width) | 80 |
| Value indent / label column / value prefix | 2 / 10 (label up to 9 columns + space) / 12 |
| Value column width | 68 |
| Continuation mark | `→` (U+2192) |
| Tab stop in notes | 4 |
| TXT page length | 60 lines, header and footer included |
| Date layout | `YYYY-MM-DD HH:MM`, local time, no zone |

### 3.2 Cells and widths

Text is split into cells (unbreakable units), after S4 escaping:

1. A rune that would be invisible or misleading on paper → one cell `\uXXXX` (lower-case hex, 4 digits; `\UXXXXXXXX`, 8 digits, above U+FFFF), width = its length, never marked. "Invisible": not U+0020 and in Unicode categories Cf, Zs, Zl, Zp, Co, Cc, or in none of L, M, N, P, S (unassigned, surrogates). Example: U+00A0 → `\u00a0`.
2. A combining mark (Mn, Me) joins the previous cell if there is one, it is unmarked and not an escape; otherwise it becomes its own `\uXXXX` cell.
3. Any other rune, a spacing mark (Mc) included, → one cell of width 2 if its East Asian Width is Wide (W) or Fullwidth (F), else 1 (Ambiguous, Neutral, Narrow and Halfwidth count 1). Example: `aः0` (U+0903, Mc) is three cells of width 1; `漢` is one cell of width 2.

Unicode data: version 15.0.0 for both the general categories and East Asian Width (`EastAsianWidth.txt`). That is what the release builds use: Go 1.26's `unicode` tables and the `width` tables of `golang.org/x/text` v0.44.0, which follow the Go version (a build with Go 1.27 or later uses 17.0.0 for both). Not normative: the layout of code points whose category or width differs between those versions.

S4 runs first (single-line form, or multi-line for notes: C0/DEL as `\xHH` with `\t` `\n` `\r`, C1 as `\u00HH`, invalid UTF-8 bytes as `\xHH`, Cf and U+2028/2029 as `\uHHHH`). Its output is ordinary ASCII text for the layout, so the digits `0` and `1` inside an S4 escape are marked like any other (`zero\u200bwidth` gets `D` under both `0`s). A literal backslash in a value is not escaped.

Display width of laid-out text (header gap, underlines) = sum of rune widths, Mn/Me counting 0.

### 3.3 Ambiguity marks

| Character | Code |
|---|---|
| `0` `1` | `D` (digit) |
| `O` `I` | `U` (upper-case letter) |
| `l` | `L` (lower-case letter) |
| U+0020, only in single-line values (§2.4) | `S` (space) |

No other character is marked (no `5/S`, `8/B`, and no Cyrillic or Greek look-alikes). Codes are the same Latin letters in every language. The marks line of a value line is: the 12-column blank prefix, then for each cell its code followed by `width−1` blanks, or `width` blanks; trailing blanks removed. It is emitted directly under its line only if at least one cell is marked. Titles, headings, names, meta lines, prose and the recovery key are never marked.

### 3.4 Wrapping

- **Values** (§2.4): each value line is broken into chunks of at most 68 columns between cells (a cell wider than 68 gets a chunk of its own). Prefix of chunk 1 of line 1: `"  " + label + spaces to 12 columns`; chunk 1 of later lines (notes): 12 blanks; every later chunk: `"          → "` (10 blanks, `→`, blank). Every character is kept; concatenating the chunks gives the value. A label wider than 9 columns gets a row of its own (`"  " + label`, hard-wrapped at 78), and all value lines then use the 12-blank prefix.
- **Names and headings** (entry names, folder paths, `(top level)`): hard-wrapped by cells at 80 columns, never at spaces.
- **Prose** (meta lines, recovery sheet text): words split at white space (the Unicode White_Space property, so a U+00A0 in a folder or tag named on a meta line becomes a plain space), rejoined with single spaces (runs collapse; no blank at either end), greedy fill to 80 columns; a word longer than a line is broken by cells. Bullets: wrapped at 78; first line `• ` (U+2022, blank), continuation lines two blanks.
- **Commands** of the recovery sheet: never wrapped; they may exceed 80 columns.

## 4. Text sheet

### 4.1 Page frame

UTF-8, LF line ends, every page exactly 60 lines; pages separated by a form feed `\f` written immediately before the next page's first line (no `\f` at the end; the file ends with `\n`):

| Lines | Content |
|---|---|
| 1 | left `CONFIDENTIAL · <title>`, right `<date> · page N of M`, separated by `max(1, 80 − width(left) − width(right))` blanks (80 columns unless that is too short) |
| 2 | `=` × 80 |
| 3 | empty |
| 4 … 3+B | body rows (§4.2), then empty lines up to B |
| next | empty |
| next | `-` × 80 |
| last L | legend lines |

B (body height) = 60 − 3 − (2 + L). Password sheet: L = 2, B = 53. Recovery sheet: L = 0, B = 55, the page ends with the dashes.

Row → text lines (also the row's height): folder heading → text + `=` × width(text); recovery heading → text + `-` × width(text); value → `prefix + text` (a label-only row: the label with trailing blanks removed), plus its marks line if any; space → one empty line; QR → nothing; every other kind → its text.

Blanks, exactly (no other line is trimmed):

- A value row with empty text is its prefix with trailing blanks removed: a label-only row is `  <label>`, an empty notes line is an empty line (not 12 blanks), and an empty first notes line gives `  notes` alone, the next notes line following with its 12-blank prefix.
- A value's own blanks are kept wherever they are, also at the end of the line: `pw␣␣` is written `  password  pw␣␣` (␣: a blank) with `SS` under the blanks; a notes line of three blanks is 15 blanks; notes blanks are kept but not marked.
- A marks line has no trailing blanks.
- Line 1: when `width(left) + width(right) ≥ 80`, one blank separates them and the line is longer than 80 columns (nothing is cut).

Legend (password sheet only; it explains `\uXXXX` but not the other S4 escapes `\xHH`, `\t`, `\n`, `\r` a value may hold: known issue, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)):

```
Under 0 O 1 l I and spaces: D digit, U capital letter, L small letter, S space
→ continues the line above; \uXXXX is a character that can't be printed
```

### 4.2 Blocks and pagination

The sheet is a list of blocks: the header block (§2.3); per group a folder block `[space, heading rows]` marked keep-with-next; per entry an entry block `[space, name rows, value rows]`. The recovery sheet's blocks are in §5.

Pagination (capacity = B, height = lines per row):

```
pages = []; cur = []; used = 0; folder = none
place(r):   skip r if it is a space row and cur is empty; else append r, used += h(r)
newPage(k): push cur; cur = []; used = 0
            if folder != none and k != folder-heading: place(folder.text + " (continued)")
for each block b at index i:
  need = h(b)
  if b is keep-with-next and a next block n exists:
     need += h(n) if h(n) <= capacity else h(first 4 rows of n)
  if cur not empty and used + need > capacity and need <= capacity:
     newPage(kind of b's first non-space row)
  head = none
  for each row r (index j) of b:
     if r is a space row and cur not empty and used + h(r) > capacity: skip r
     if cur not empty and used + h(r) > capacity:
        newPage(kind of r)
        if head != none and j > 0: place(head.text + " (continued)")
     if head == none and r is an entry name or recovery heading: head = r
     if r is a folder heading: folder = r
     place(r)
push cur if not empty or if no page exists
```

So: a block that fits on a page is never split; a folder heading moves with the start of its first entry; a page that starts inside a folder begins with `<folder> (continued)` (underlined like a heading); an entry split across pages repeats `<name> (continued)`; space rows never start a page. `(continued)` copies carry no marks.

### 4.3 Annotated example

Fake data, `--fields password,username,url,tags,notes,fields`, page 1 of 1 (the empty padding lines between the body and the footer are cut, `⏎` shows where; `[n]` notes are not part of the output):

```
CONFIDENTIAL · passh password sheet               2026-11-15 14:03 · page 1 of 1   [1]
================================================================================
                                                                          [2] empty
passh password sheet
printed 2026-11-15 14:03 · 4 entries
fields: password, username, url, tags, notes, fields
                                                                          [3] space row
(top level)
===========
                                                                          [3]
email
  password  Pa55 w0rd!
                S D                                                       [4]
  username  me@example.com
                    L

bank
====

main
  password  Xk0Olp1I
              DUL DU
  username  alice
             L
  url       https://bank.example
                              L
  tags      money, 2fa                                                    [5]
  notes     PIN in the safe
             U                                                            [6]
                card 2                                                    [7]

work
====

github
  password  aB3$aB3$aB3$aB3$aB3$aB3$aB3$aB3$aB3$aB3$aB3$aB3$aB3$aB3$aB3$aB3$aB3$
          → aB3$aB3$aB3$lI0O                                              [8]
                        LUDU
  username  alice
             L
  url       https://github.com                                            [9]
  recovery-email                                                          [10]
            me+gh@example.com
                       L
  pin       0101
            DDDD

work/dev                                                                  [11]
========

aws
  password  zero\u200bwidth                                               [12]
                   DD
  username  root
⏎
                                                                          [13]
--------------------------------------------------------------------------------
Under 0 O 1 l I and spaces: D digit, U capital letter, L small letter, S space
→ continues the line above; \uXXXX is a character that can't be printed
```

[1] exactly 80 columns. [2] line 3. [3] each folder and entry block starts with a space row. [4] `S` under the space, `D` under `0`. [5] tags: no marks for spaces. [6] notes are marked, spaces are not. [7] a tab expanded to 4 blanks after the 12-blank prefix. [8] an 84-character value wrapped at 68 columns; the marks follow each chunk. [9] nothing to mark: no marks line. [10] a label wider than 9 columns gets its own row. [11] subfolder: own group, full path. [12] U+200B escaped by S4; its digits are marked (§3.2). [13] the empty line before the footer.

Pages after the first start (line 4) with the next block, e.g. `f (continued)` + `=============` when the page begins inside folder `f`.

## 5. Recovery key sheet

Title `passh paper recovery key`; no legend. Blocks and rows, in order:

1. **Head**: title; `vault_id <uuid>` (`vault_id` untranslated); `printed <date>`; space; warning prose `Whoever has this sheet and a copy of the vault can read everything in the vault.`; prose ``Keep it offline, like cash. If it may have been seen, copied or lost, run `passh rekey` and print a new sheet: the old key then no longer opens new versions of the vault (copies made before still open with it).``
2. **Key**: space; heading `Vault key`; the key lines; space; prose `After AGE-SECRET-KEY-1 the key never has the letters B, I or O or the digit 1: 0 is always the digit zero.`; then text sheet: prose ``The key's QR code is on the web page (`passh recovery-key print --web`).``, print page: the QR row (§6.8).
3. **Forgotten passphrase**: space; heading; prose ``Run `passh recover` and type the key above. Spaces, line breaks and letter case are ignored, and the key's checksum catches typos. passh then asks for a new passphrase.``
4. **Without passh**: space; heading; prose `On any machine with age (https://age-encryption.org) v1.0 or later, where vault.passh is a copy of the vault file:`; space; the five commands of spec §8, one code row each, byte for byte as in the spec's `bash` block (fixed text: changing that block changes the sheet, and a test keeps the two identical), except that on a translated sheet the comment text after `# ` on the third line is translated (the command and its padding are not); then three bullets, each preceded by a space row:
   - `With this key instead of the passphrase: write it to /dev/shm/key.txt as one line, without spaces, in capital letters as printed (AGE-SECRET-KEY-1 and then the groups), instead of running the first and third commands. The other commands stay the same.`
   - `vault.json is plaintext. Keep it on tmpfs (/dev/shm on Linux) and delete it when done.`
   - ``If a mail client or editor re-wrapped the lines, age may reject the blocks. passh still opens such a file, and `passh backup` writes it back in canonical form.``

Key lines: `AGE-SECRET-KEY-1` alone, then the 58 bech32 characters after it (upper case, as age prints them) in groups of 4 separated by one blank, 5 groups per line: 3 lines of 5, 5 and 5 groups, the last group 2 characters. The key never appears in one piece in text; the recipient (`age1…`) never appears (S9).

```
Vault key
---------
AGE-SECRET-KEY-1
QPZR Y9X8 GF2T VDW0 S3JN
54KH CE6M UA7L QPZR Y9X8
GF2T VDW0 S3JN 54KH CE
```

In English and both translations the text sheet fits one page (47–49 of 55 body lines used); a longer text would paginate by §4.2. The text sheet's lines are at most 80 columns except the two `tr … | awk …` commands.

## 6. Print page server

### 6.1 Start

Validation order; each failure aborts with nothing listening:

1. `print_web.enabled` false → `the print page is off: …` (§1.2).
2. `ttl` outside 1m–15m (inclusive) → `print_web.ttl: <d> is not between 1m0s and 15m0s` (the config loader already rejects it: `print_web.ttl: "<v>" is not between 1m and 15m`).
3. `port` outside 1–65535 → `print_web.port: <n> is not between 1 and 65535`.
4. A hostname that is empty or contains blank, tab, CR, LF, `/`, `[` or `]` → `print_web.hostnames: "<h>" is not a hostname` (the config loader rejects empty names and white space or control characters).
5. Resolve the addresses (§6.2) and the allowed client ranges.
6. Load or create the certificate (§6.3).
7. Make the token (§6.5).
8. Listen on TCP `<addr>:<port>` for each address, in order. Any failure closes the listeners already opened → `print page: <system error>` (e.g. `listen tcp 192.168.1.10:8443: bind: address already in use`). There is no fallback port.
9. `Expires` = now + `ttl`; the countdown starts here.

Defaults: `port = 8443`, `interfaces = ["wg0", "eth0"]`, `allow_from = []`, `hostnames = []`, `ttl = "5m"`.

### 6.2 Addresses and `allow_from`

For each name in `print_web.interfaces`, in order:

1. Interface missing → recorded as `<name>: no such network interface`; no addresses → `<name>: no address`. These are shown only if nothing at all can be bound.
2. The interface's addresses with their prefix lengths (IPv4-mapped forms unmapped), IPv4 before IPv6, otherwise in system order. The interface's up/down state is not checked.
3. Per address: link-local (unicast or multicast) → skipped `<name>: <addr> is link-local, not used`; outside the private ranges → skipped with `<name>: <addr> is the wildcard address, never used` / `is a loopback address, not private` / `is a multicast address, not used` / `is a public address, refused`; an address already taken (same address on two interfaces, or a name listed twice) → dropped silently; otherwise bound.

Private ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `fc00::/7`. Loopback is not private. An address with a zone is refused. Nothing bound → `the print page has no private address to listen on (print_web.interfaces): <problems and skipped, joined by "; ">`; empty `interfaces` → `print_web.interfaces is empty: name the interfaces of your LAN or VPN, e.g. ["eth0", "wg0"]`.

Allowed clients:

- `allow_from` empty: for each bound address, its interface prefix masked to the network (`192.168.1.10/24` → `192.168.1.0/24`); a host prefix (/32 IPv4, /128 IPv6) → the private range that contains it (`100.101.102.103/32` → `100.64.0.0/10`, `fd7a:115c:a1e0::1/128` → `fc00::/7`). Duplicates removed.
- `allow_from` not empty: exactly its CIDRs (each masked to its network); the default subnets are **not** added. Any CIDR is accepted by the config, including public ranges. (Replace or intersect, and which CIDRs to accept, is an open question: [spec.md §14](../../spec.md#14-open-questions).)
- Each accepted TCP connection's peer address (unmapped, zone dropped) must be in one allowed prefix; otherwise the connection is closed immediately after `accept`, before any TLS byte. Refused connections don't count as wrong tokens and don't stop the server.

### 6.3 Certificate

Stored in `<state>/print-web/` (`<state>` = `$XDG_STATE_HOME/passh`, default `~/.local/state/passh`): `cert.pem` (PEM `CERTIFICATE`) and `key.pem` (PEM `PRIVATE KEY`, PKCS #8). The folder and a missing parent are created 0700; an existing folder that is a symlink or not a folder → `print page certificate folder <dir> is not a folder`; a folder with another mode is chmod'ed to 0700.

Reuse the stored pair unless one of these holds (checked in order; the reason goes into the notice):

| Condition | Reason text |
|---|---|
| neither file exists | `first use` |
| `cert.pem` can't be `lstat`ed | `the stored certificate can't be read: <err>` |
| `key.pem` can't be `lstat`ed | `the stored key can't be read: <err>` |
| `key.pem` is not a regular file | `the stored key is not a regular file` |
| `key.pem` mode has any group/other bit | `the stored key had mode 0644, readable by others` |
| the pair doesn't parse, or the key isn't ECDSA P-256 | `the stored certificate can't be used: <err>` |
| now < NotBefore | `the stored certificate is not valid until YYYY-MM-DD` |
| now > NotAfter | `the stored certificate expired on YYYY-MM-DD` |
| now + 24 h > NotAfter | `the stored certificate expires on YYYY-MM-DD` |
| a bound address not among its IP SANs, or a hostname not among its DNS SANs (case-insensitive) | `the addresses or hostnames changed: the old one doesn't cover <list, ", ">` |

A certificate covering more than the current addresses and hostnames is reused (an interface that is down doesn't change the fingerprint). Nothing else is checked: any pair that passes the table is reused whoever made it, whatever its subject, issuer, serial, key usage, extensions or signature (`cert.pem`: the first `CERTIFICATE` block is the certificate; `key.pem`: a PKCS #8 or SEC 1 EC key that matches it). So swapping in another implementation keeps the fingerprint as long as the stored pair passes. A new certificate covers only the current ones. `cert.pem` is read through a symlink and its mode is not checked (known issue: both files should be regular files of the user, opened without following symlinks, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)).

New certificate: ECDSA P-256 key; X.509 v3, self-signed (issuer = subject = `CN=passh print page`); serial uniform in [0, 2^127); NotBefore = now − 1 h; NotAfter = now + 365 × 24 h; Key Usage `digitalSignature` (critical); Extended Key Usage `serverAuth`; Basic Constraints `CA:FALSE` (critical); SAN: the bound addresses (in bind order) as IP entries and `hostnames` as DNS entries (as configured); signature ECDSA-SHA256; no subject or authority key identifier. Each file is written to a temporary `.tmp-<name>-*` in the folder, chmod 0600, `fsync`ed and renamed into place, key first.

Notice when a certificate was made: `made a new certificate for the print page (<reason>); browsers will warn about it: compare the fingerprint`.

Fingerprint: SHA-256 of the certificate's DER, upper-case hex, byte pairs joined by `:` (95 characters, `4F:A1:…:07:D2`), as browsers show it.

### 6.4 TLS and HTTP

- TLS 1.3 only (min = max = 1.3); ALPN `http/1.1` only; no HTTP/2; no plain-HTTP listener; nothing written to the terminal by the server (the reference discards its error log).
- Informative (the reference's library defaults and limits, not needed for compatibility): cipher suites and key exchange groups are Go's `crypto/tls` defaults; a plain-HTTP request on the port gets Go's TLS-port answer, a 400 "Client sent an HTTP request to an HTTPS server.", and counts for nothing; header read 10 s, request read 20 s, response write 60 s, idle keep-alive 20 s, header size 16 KiB.

### 6.5 Token and URLs

- Token: 16 bytes from the CSPRNG, base64url without padding: 22 characters `[A-Za-z0-9_-]`.
- One URL per bound address, in bind order: `https://<addr>:<port>/p/<token>`, IPv6 in brackets (`https://[fd12:3456::1]:8443/p/kq7Z…`). Hostnames never appear in a URL; they serve only the certificate and the `Host` check.

### 6.6 Request handling

For every request, in this order (the first matching row answers):

| # | Condition | Response | Counts / effect |
|---|---|---|---|
| 0 | always | headers `Cache-Control: no-store`, `Content-Security-Policy: <§6.8>`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` on every response, errors included | — |
| 1 | `Host` not allowed (below) | 421, `text/plain; charset=utf-8`, body `misdirected request: unknown host` + LF | nothing |
| 2 | path doesn't start with `/p/` (`/`, `/p`, `/favicon.ico`, …) | 404, body `404 page not found` + LF (library text, never translated) | nothing |
| 3 | path after `/p/` ≠ token (constant-time comparison; any method; `/p/<token>/x` is wrong) | 404 as above | wrong-token count + 1; at 5 (and the token not yet consumed) the server stops: `TooManyWrongTokens` |
| 4 | method ≠ `GET` (`HEAD` included) | 405, `Allow: GET`, body `method not allowed` + LF | nothing; the token stays valid |
| 5 | token already consumed | 410, body `already used: start the print page again in passh` + LF | — |
| 6 | wrong-token count ≥ 5 | 410, body `stopped after too many wrong addresses: start the print page again in passh` + LF | — |
| 7 | otherwise | 200, `Content-Type: text/html; charset=utf-8`, `Connection: close`, the page (§6.8) rendered and streamed, then flushed | consumes the token, records the client address, starts the stop |

`Host` check: the `Host` header split into host and port; a port, if present, must be the listening port as a decimal string; IPv6 brackets removed. An IP literal must have no zone and (after unmapping IPv4-mapped IPv6) be one of the bound addresses. Anything else is a name: one trailing `.` removed, compared case-insensitively with `hostnames`. An empty `Host` is refused. The query string is ignored throughout.

Request target: rows 2–3 compare the percent-decoded path, with no cleaning and no redirect. `/p/%6Bq7Z…` is the token `kq7Z…`; `//p/<token>` doesn't start with `/p/` (row 2, not counted); `/p/../p/<token>` and `/p/<token>/` are wrong tokens (row 3, counted). An absolute-form target (`GET https://<addr>:<port>/p/<token> HTTP/1.1`) is served; its authority, not the `Host` header, is checked in row 1. HTTP/1.0 without `Host` gets row 1 (421). Not normative: what the HTTP library answers before the table, without row 0's headers and without counting (in the reference: 400 for HTTP/1.1 without `Host` or for a target that doesn't parse, such as `/p/%zz`; 200 with an empty body for `OPTIONS *`).

Body texts of rows 1, 4, 5, 6 are in the page's language (spec §3.3).

### 6.7 Stopping and the result

The server stops at the first of: the token consumed (row 7), the 5th wrong token, `Expires`, the context cancelled (TUI lock, TUI exit, SIGINT/SIGHUP/SIGTERM in the CLI dialog), or `Stop` (Esc). On consumption the listeners close at once (new connections are refused); requests already in progress finish (a second request on an open connection gets row 5); the server waits up to 30 s for the page to be written, cut short by `Expires`, `Stop` or cancellation. Any other reason closes everything at once.

| Outcome | When | Message (`Result`; English) |
|---|---|---|
| Served | page written and flushed without error | `the page was served to <client>; if that wasn't you, start the print page again` |
| Failed | token consumed, rendering, writing or flushing failed | `the page was only partly sent to <client> (<error>); start the print page again` |
| Cancelled (with client) | stopped while the page was being written | `the print page was stopped while it was sent to <client>` |
| Cancelled | cancelled or `Stop` before any page | `the print page was stopped` |
| Expired | `ttl` ran out | `the print page stopped after <ttl> without being opened` (`<ttl>` as a Go duration, `5m0s`) |
| TooManyWrongTokens | 5 wrong tokens | `the print page stopped after 5 requests with a wrong address` |

`<client>` is the peer IP address (unmapped, no zone, no port).

### 6.8 The page

Rendered from memory when row 7 arrives, on top of the S4 escaping done by the layout (§3.2). Every data value in the template (text nodes, `<title>`, and the attribute values `lang` and `class`) is HTML-escaped with one table: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `'` → `&#39;`, `"` → `&#34;`, `+` → `&#43;`, U+0000 → U+FFFD (unreachable: S4 escapes it); every other character is written as is (UTF-8). The tip and the QR's `aria-label` are escaped the same way except that `+` is kept. Attribute values hold only passh's fixed strings; entry data reaches only text nodes.

Normative: the page's content (the rows of §2–§5, in order, with their texts), the headers of §6.6 and the CSP below, the escaping above, `lang`, the absence of anything active (the list below), and the QR code's content and level. Informative: the exact markup and the CSS, which are the reference's. The template, verbatim (Go template notation; `{{.CSS}}` stands for the CSS below, which is literal template text, not data):

```html
<!DOCTYPE html>
<html lang="{{.Lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>{{.Confidential}} · {{.Title}}</title>
<style>{{.CSS}}</style>
</head>
<body>
<p class="tip">{{.Tip}}</p>
<div class="wrap">
<table class="sheet">
<thead><tr><td><div class="hd"><span><b>{{.Confidential}}</b> · {{.Title}}</span><span>{{.Date}}</span></div></td></tr></thead>
<tfoot><tr><td><div class="ft">{{range .Legend}}<div>{{.}}</div>{{end}}</div></td></tr></tfoot>
<tbody><tr><td>
{{range .Blocks}}<div class="blk{{if .Whole}} nb{{end}}{{if .Keep}} keep{{end}}">
{{range .Rows}}{{if .QR}}<div class="qr">{{.QR}}</div>
{{else}}<div class="r {{.Class}}">{{if .Prefix}}<span class="lb">{{.Prefix}}</span>{{end}}{{.Text}}</div>
{{if .Marks}}<div class="mk">{{.Marks}}</div>
{{end}}{{end}}{{end}}</div>
{{end}}</td></tr></tbody>
</table>
</div>
</body>
</html>
```

Data: `Lang`; `Confidential` = `CONFIDENTIAL` translated; `Title` = the sheet's title; `Date` = `printed <date>`; `Legend` = the legend lines (none for the recovery sheet); per block `Whole` (≤ 16 rows) and `Keep` (keep-with-next); per row `Class`, `Prefix`, `Text` (escaped by the template), `Marks` and `QR` (trusted markup built by passh, below).

- `lang`: `en`, `ru` or `sr-Latn`. `tip`: `Print with Ctrl+P (Cmd+P on a Mac), then close this tab. This page was served once and is gone from passh; the browser may still keep it in its session history.` (hidden in print). The repeated table header and footer carry CONFIDENTIAL, the title, the print date and the legend on every printed page (browsers repeat `thead`/`tfoot`); there is no "page N of M" on the page.
- Block classes: `nb` if the block has at most 16 rows (`break-inside: avoid`); `keep` for keep-with-next blocks (folder headings). Row classes: title `title`, meta `meta`, folder `folder`, entry `entry`, value `value`, heading `heading`, text `text`, warning `warning`, key `key`, code `code`, space `sp`.
- Marks: each code letter as `<b>D</b>` (one column wide, smaller, centred), blanks as spaces.
- QR row (recovery sheet only): QR code of the bare key `AGE-SECRET-KEY-1…` (74 characters, upper case), error correction level M, 4-module quiet zone, as inline SVG. Not normative: the module pattern. The encoding mode, version and mask are the encoder's choice (the reference's encoder picks the smallest version), and any valid QR code of this content at level M is compatible, so N and the path may differ. The SVG: `<svg viewBox="0 0 N N" role="img" aria-label="QR code of the vault key" shape-rendering="crispEdges"><rect width="N" height="N" fill="#fff"/><path fill="#000" d="…"/></svg>`, N = modules including the quiet zone (41 in the reference: version 4, 33 modules, plus 2 × 4); the path is one `M{x} {y}h{len}v1h-{len}z` per horizontal run of dark modules, rows top to bottom, runs left to right. No `href`, `src` or `xmlns`.
- No script, image, link, form, external font, `url(…)`, `@import`, `style` attribute or event attribute.

CSS (the only style; the CSP hash is over exactly these bytes, from the line break after `<style>` up to `</style>`; it must contain no CSS comment, which `html/template` would strip):

```css

@page { size: auto; margin: 12mm 15mm; }
html { background: #fff; color: #000; color-scheme: light; }
body { margin: 0; padding: 12px; font-family: ui-monospace, "DejaVu Sans Mono", "Liberation Mono", Menlo, Consolas, monospace; font-size: 10pt; line-height: 1.3; }
.tip { font-family: system-ui, sans-serif; background: #ffe; border: 1px solid #cc9; padding: 8px 12px; margin: 0 0 12px; }
.wrap { overflow-x: auto; }
table.sheet { border-collapse: collapse; width: 100%; }
table.sheet td { padding: 0; vertical-align: top; }
.hd { display: flex; justify-content: space-between; gap: 2ch; font-size: 8.5pt; border-bottom: 1.5px solid #000; padding-bottom: 2pt; margin-bottom: 8pt; }
.ft { font-size: 7pt; color: #333; border-top: 1px solid #000; padding-top: 2pt; margin-top: 8pt; }
.nb { break-inside: avoid; page-break-inside: avoid; }
.keep { break-after: avoid; page-break-after: avoid; }
.r { white-space: pre; min-height: 1.3em; }
.r.sp { min-height: 0; height: 0.6em; }
.title { font-size: 14pt; font-weight: bold; }
.meta { font-size: 9pt; color: #444; }
.folder, .heading { font-size: 11pt; font-weight: bold; border-bottom: 1px solid #777; margin-bottom: 3pt; }
.entry, .warning, .key { font-weight: bold; }
.key { font-size: 16pt; }
.code { font-size: 6.5pt; }
.lb { color: #666; }
.mk { white-space: pre; line-height: 1; margin-bottom: 2pt; }
.mk b { display: inline-block; width: 1.4286ch; font-size: 7pt; text-align: center; color: #444; }
.qr { margin: 4pt 0; }
.qr svg { width: 38mm; height: 38mm; display: block; }
@media print {
  body { padding: 0; }
  .tip { display: none; }
  .wrap { overflow: visible; }
}
```

(The block starts with an empty line: the style text begins with LF and ends with `}` LF.)

`Content-Security-Policy` value: `default-src 'none'; style-src 'sha256-<B64>'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, where `<B64>` is standard base64 (with padding) of SHA-256 of the style text as served (every byte between `<style>` and `</style>`), whatever CSS is used. For the CSS above: `sha256-rLtWigDh0s379JybCrlCKrASvsF52LZTMcgTI5+BB1E=`.

### 6.9 Terminal dialog (CLI)

After `Start`, written to `/dev/tty` (escaped with S4, line breaks kept):

```
made a new certificate for the print page (first use); browsers will warn about it: compare the fingerprint
not used: lo: 127.0.0.1 is a loopback address, not private
<QR code of URL 1: 19 lines × 37 columns for a typical IPv4 URL>
https://192.168.1.10:8443/p/kq7Z…
<empty line>
<QR code, URL and empty line again for each further URL>
certificate SHA-256  4F:A1:…:07:D2
Compare it with the fingerprint your browser shows before you accept the certificate.
c copies the URL · Esc stops
stops after one load or in 5:00
```

- The notice line only when a certificate was made; one `not used: …` line per skipped address (§6.2). Two blanks after `SHA-256`.
- Terminal QR: the URL, error correction level L, 4-module quiet zone, two module rows per text line: both light `█`, top light and bottom dark `▀`, top dark and bottom light `▄`, both dark blank; a last odd row: light `▀`, dark blank. Light modules are drawn, so the code reads on a dark background. Not normative: the module pattern (as for the page's QR code, §6.8) and so the QR's size; `19 lines × 37 columns` is the reference's (version 3).
- Then the terminal is put in raw mode. The last line is redrawn every second as `\r ESC[K` + note + `stops after one load or in M:SS` (time left rounded to seconds, not below 0). Keys: `c`/`C` copies **the first URL** with the configured clipboard (spec §6.3; with several URLs, known issue: the user can't choose which, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)) and sets the note to `URL copied · `, `copy failed · ` or `no clipboard · `; Esc, `q`, `Q`, Ctrl-C stop the server. SIGINT, SIGHUP and SIGTERM cancel it. When the server stops: `\r ESC[K`; a clipboard clear still pending runs at once (bounded to 10 s), so the URL is cleared after `clipboard.clear_after` or when the dialog ends, whichever is first; the terminal mode is restored; the result is reported as in §1.2 step 5.

The TUI's `P` dialog (scope and field choice, `PRINT` prompt, one URL at a time, `Tab` to switch, `c` copies the URL shown) is specified in [tui.md](tui.md) §7.8–7.9. The dialog in `EXAMPLES.md` §9.2 (a second URL as `(also …)` on the first one's line) is an informal sketch; this section and tui.md are the reference.

## 7. Constants

| Constant | Value |
|---|---|
| Wrong tokens that stop the server | 5 |
| Wait for the served page to be written | 30 s |
| Certificate validity / early renewal | 365 × 24 h from now (NotBefore now − 1 h) / 24 h before NotAfter |
| `ttl` range / default | 1–15 min inclusive / 5 min |
| Default port | 8443 |
| Token | 128 bits, base64url, 22 characters |
| Page blocks kept whole | ≤ 16 rows |
| QR (terminal / page) | level L, URL / level M, recovery key |

## 8. Sheet frame strings

The frame of both sheets and of the page in the three languages (other texts: catalogues, [i18n.md](i18n.md)).

| en | ru | sr |
|---|---|---|
| `CONFIDENTIAL` | `КОНФИДЕНЦИАЛЬНО` | `POVERLJIVO` |
| `passh password sheet` | `лист паролей passh` | `passh list sa lozinkama` |
| `passh paper recovery key` | `ключ восстановления passh` | `passh papirni ključ za oporavak` |
| `page %d of %d` | `страница %d из %d` | `strana %d od %d` |
| `printed %s` | `напечатано %s` | `odštampano %s` |
| `%d entry` / `%d entries` | `%d запись` / `%d записи` / `%d записей` | `%d stavka` / `%d stavke` / `%d stavki` |
| `folder %s` · `tag %s` · `tags %s` | `папка %s` · `тег %s` · `теги %s` | `fascikla %s` · `oznaka %s` · `oznake %s` |
| `fields: %s` | `поля: %s` | `polja: %s` |
| `(top level)` | `(верхний уровень)` | `(najviši nivo)` |
| `%s (continued)` | `%s (продолжение)` | `%s (nastavak)` |
| legend line 1 | `Под 0 O 1 l I и пробелами: D — цифра, U — заглавная, L — строчная, S — пробел` | `Ispod 0 O 1 l I i razmaka: D cifra, U veliko slovo, L malo slovo, S razmak` |
| legend line 2 (`%s` = `→`) | `%s продолжает строку выше; \uXXXX — символ, который нельзя напечатать` | `%s nastavlja red iznad; \uXXXX je znak koji ne može da se odštampa` |
| `Vault key` · `Forgotten passphrase` · `Without passh` | `Ключ хранилища` · `Если забыта парольная фраза` · `Без passh` | `Ključ trezora` · `Zaboravljena pristupna fraza` · `Bez programa passh` |
| `# asks for the passphrase` | `# запросит парольную фразу` | `# traži pristupnu frazu` |
| `QR code of the vault key` | `QR-код ключа хранилища` | `QR kod ključa trezora` |
