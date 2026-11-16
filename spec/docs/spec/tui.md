# Appendix: TUI and entry form

Normative appendix to [spec.md](../../spec.md) §5.2, §5.6 and §6.2. Scope: the TUI (`passh` without arguments) and the built-in entry form, which `passh edit` uses too: start and exit, the lock screen, key routing, layout, browsing and search, the operations, the changed-on-disk banner and reload, the rollback question, locking, and the TUI's print setup and dialog. Precedence: see [spec.md §1.1](../../spec.md#11-appendices-normative). Quoted texts are the English (`en`) catalogue; every human-readable text is translated per §3.3, but key names, field labels (`password`, `username`, `url`, `tags`, `notes`, `fields`) and the typed phrase `PRINT` stay the same in all languages (see [i18n.md](i18n.md)). `§` numbers refer to `spec.md`; linked numbers such as [4.2](#42-unlock-sources) to sections of this appendix.

**What binds.** Normative: the states, the keys and what they do, the operations and their effect on the vault, the timings, and the safety rules (S4 escaping, S5 masks and reveal, locking, the clipboard). Not normative: the exact frame. Nothing reads the TUI's screen, so a compatible TUI need not match it cell for cell: layout arithmetic, wrapping and truncation, character widths (the reference measures grapheme clusters with its terminal library, `charmbracelet/x/ansi`), styles and colours, hint-bar texts, and the exact wording of on-screen texts (the quoted ones are the reference's) are informative. The lines printed to stderr after the TUI has left the screen ([1.2](#12-exit)) are output like the CLI's.

Related appendices: [agent-session.md](agent-session.md) (agent, key requests), [storage.md](storage.md) (save, the changed-on-disk check, reload, rollback record), [print.md](print.md) (print page, sheet, outcomes), [cli.md](cli.md) (exit statuses, `passh edit`).

## 1. Start, terminal and exit

### 1.1 Start

1. Load the config and check that the vault file exists, as every command does ([cli.md 1.2](cli.md#12-global-flags-config-and-vault)): `no config file at …` or ``no vault at <file>: run `passh init` to create one, or pass --vault <file>``, exit 1. The TUI never creates a vault. (The TUI component's own checks, `no vault: set vault in the config file or pass --vault` and `opening the vault: <error>`, can't be reached from `passh`: this step runs first.)
2. Open `/dev/tty`. If it isn't a terminal: "the TUI needs a terminal: run passh in one (over SSH: `ssh -t host passh`); without a terminal, use the commands (passh --help) after `passh unlock`". Input and output both go to `/dev/tty`, not stdin/stdout.
3. Draw on the **alternate screen**, in raw mode (Ctrl-C arrives as a key, not as SIGINT). Bracketed paste is used (a paste is one event). No mouse. Until the terminal reports its size, assume 80×24.
4. Show the lock screen and immediately ask the vault's agent for the key ([4.2](#42-unlock-sources)) without a key press (skipped if the agent client can't be set up, e.g. an unusable agent folder: then the passphrase field shows at once).

### 1.2 Exit

| How | What happens |
|---|---|
| `q` in the list, detail or search results; Ctrl-C there, in the help, in the search while typing (known issue: easy to quit by accident; proposed fix: Ctrl-C closes the search like Esc, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)) and at a rollback question (elsewhere Ctrl-C cancels the open form, prompt, print setup or delete question, or stops the print page) | Session ends, lock with reason *exit* ([10](#10-locking-52)). Then, on the normal screen, if a clipboard clear is still pending: the line `Clipboard clears in N s — Ctrl-C clears now`, rewritten in place every second, until the clear is due; then `Clipboard cleared.` (or `Clearing the clipboard failed: …`). Ctrl-C (SIGINT) during the wait clears at once and exits normally; SIGHUP/SIGTERM clear at once and exit as for a signal. |
| Ctrl-C / Ctrl-D on the lock screen, Esc with an empty passphrase, `q`/Esc on the "damaged" lock screen | Exit; nothing is pending (a lock already cleared the clipboard). |
| SIGHUP, SIGTERM, SIGINT (any time) | Lock at once from the signal handler, even while the UI is busy: a pending rollback question is dropped unanswered, a running save or copy is finished first, the clipboard is cleared at once, the agent stopped (`stop_agent`), the print page stopped. Then the TUI exits with "locked and stopped: received <signal>" and exit status 128 + signal number. |
| "No" to the rollback question at unlock ([9](#9-rollback-question-410)) | Exit with the vault's "stopped: this copy is older …" error (§4.10). |

In every case the session is locked (§5.2) before the process exits, a save that was running is waited for, and a final bounded (5 s) clipboard clear is attempted. What the lock on exit could not do, and the result of a save that was still running at quit ("Saved work/x." or "Not saved (work/x): …"), are printed to stderr after the TUI has left the screen, one line each, prefixed `passh: ` and escaped (S4).

## 2. Constants

| Constant | Value |
|---|---|
| UI clock tick (countdowns, idle check, reveal and status expiry) | 1 s |
| Poll of the vault file for "changed on disk" | every 2 s |
| Status message lifetime (non-sticky) | 8 s |
| Reveal duration (S5), list/detail and form | 10 s |
| Mask (S5) | `••••••••` (8 × U+2022), whatever the length |
| Bound on clipboard clear and agent stop at a lock | 5 s for both together |
| Bound on one clipboard copy | 15 s |
| Bound on the "is an agent running" check after a lock | 2 s |
| Wide layout | width ≥ 80 columns; narrower = single pane |
| "Window too small" | width < 20 or height < 6 (main screen, form, print dialog) |
| Status area cap | 6 lines (the 6th becomes `…`) |
| Generated password in the form | 24 characters, letters and digits (S3) |

Countdowns show `m:ss` (`h:mm:ss` from one hour), rounded **up** to whole seconds. Informative: durations in sentences ("Locked after 5 min without input.", the print dialog's copy note) are written as whole hours `N h`, whole minutes `N min` (the unit translated), else rounded to seconds in Go's form (`1m30s`, `30s`). This differs from the CLI's `<D>` (`2h`, `15m`; [cli.md](cli.md)) only because these are on-screen sentences; neither form binds the TUI.

## 3. State model and key routing

### 3.1 States

```
LOCK ── passphrase field ─ busy (unlocking / asking the agent / locking) ─ asking (rollback) ─ damaged
  │ unlocked                                                       ▲ L, idle_ttl
  ▼                                                                │
MAIN = list mode × detail × at most one overlay
  list mode:  Folders | Tags | Search (typing | results)           (Tab: Folders↔Tags; / : Search)
  detail:     closed | open (full-width entry view)
  overlays:   help | prompt (add path, move, tags, PRINT) | confirm (delete, rollback)
              | print setup | print dialog | form
  flags:      changed-on-disk banner, save in flight, reload in flight, kept input ([8](#8-vault-changed-on-disk-and-reload))
BYE (quitting; nothing drawn)
```

Lock wipes all of MAIN (data, cursor positions, expanded folders, tag selection, search, form, prompts, kept input) and returns to LOCK; nothing of the previous session is restored after unlocking.

### 3.2 Key routing in MAIN (first match wins)

1. `L` locks, unless a **text field** has the keys: the form (including its own "Discard the changes?" question), a prompt, or the search while typing. There `L` is a letter. The idle lock and signals lock from anywhere.
2. Form open → the form ([11](#11-entry-form-56)).
3. Print dialog open → the dialog ([7.9](#79-print-dialog)).
4. Confirm question → [7.6](#76-delete) / [9](#9-rollback-question-410).
5. Prompt → Enter submits, Esc or Ctrl-C cancels (and wipes the input), other keys edit ([11.4](#114-editing-keys) editing keys, unmasked). A paste with a line break inside is refused: "Paste refused: one line only."
6. Print setup → [7.8](#78-print-setup-p-74).
7. Help shown → ↑/`k`, ↓/`j` scroll; Ctrl-C quits; any other key closes the help (the key is consumed).
8. Search typing → [5.4](#54-search).
9. Global keys (table 3.3); they work from the list, the search results and an open detail.
10. Detail open → detail keys (table 3.4).
11. List keys (table 3.5).

Every key press and paste, anywhere, restarts the idle timer ([10.1](#101-triggers)).

### 3.3 Global keys (list, search results, detail)

| Key | Action |
|---|---|
| `q`, Ctrl-C | Quit ([1.2](#12-exit)) |
| `?` | Help: one line per key of [3.3](#33-global-keys-list-search-results-detail)–[3.5](#35-list-keys), plus "In the form: ctrl+s saves, esc cancels, ctrl+r shows the password, ctrl+g generates." and "Text fields (form, search, prompts): Esc first, then L. The idle lock and signals lock from anywhere." |
| `R` | Reload ([8.3](#83-reload-r)) |
| `/` | Close the detail; start a search (empty query) or, if results are shown, resume typing the query |
| `Tab` | Close the detail and any search; switch Folders ↔ Tags |
| `P` | Print setup ([7.8](#78-print-setup-p-74)) |
| `a` | Add ([7.2](#72-add)) |
| `c` / `u` | Copy password / username of the selected entry ([7.1](#71-copy-63)) |
| `r` | Reveal / hide the selected entry's secrets ([6.3](#63-reveal-s5)) |
| `e` | Edit in the form ([7.3](#73-edit)) |
| `t` | Tags prompt ([7.5](#75-tags)) |
| `m` | Move/rename prompt ([7.4](#74-move)) |
| `d` | Delete question ([7.6](#76-delete)) |
| `L` | Lock |

The **selected entry** is the open detail's entry, else the entry under the cursor. Entry keys on anything else (folder, tag, note, empty vault) show "Select an entry first.".

### 3.4 Detail keys

Esc, ←, `h`, Backspace: back to the list, cursor on that entry, reveal hidden. ↑/`k`, ↓/`j`: scroll one line; PgUp, PgDn/Space: one page; Home/`g`: top.

### 3.5 List keys

| Key | Action |
|---|---|
| ↑ `k` Ctrl-P / ↓ `j` Ctrl-N | Previous / next selectable row; stops at the ends (no wrap) |
| PgUp / PgDn | Move by (body height − 1) rows |
| Home `g` / End `G` | First / last selectable row |
| Enter | Folder: open/close. Tag: select/unselect. Entry: open the detail |
| → `l` | Folder: open it, or if already open move to its first row. Tag: select/unselect. Entry: open the detail |
| Space | Folder or tag: as Enter. Entry: nothing |
| ← `h` | Folders view only: an open folder closes; otherwise the cursor goes to the parent folder's row (which stays open) |
| Esc | Search results: close the search. Tags view with a selection: clear the selection. Otherwise nothing (Esc never quits the main screen) |

Note rows ("No matches.", the tag-selection heading, …) are never selected; the cursor skips them.

## 4. Lock screen

### 4.1 Layout

```
 passh — vault locked
 ~/.local/share/passh/vault.passh          (the vault path, $HOME shown as ~)

 Passphrase  ••••••••█                     (or: busy text, rollback question, nothing when damaged)
 [agent hint]
 [message]
 [key hints]
```

No title countdown and no minimum size: lines are wrapped/truncated to the window. The passphrase field shows the Mask when not empty (nothing when empty) plus a cursor; its length is never shown (S5).

### 4.2 Unlock sources

- **At start**: ask the agent for the key of the vault's current key block (§5.1, §5.3; a key request, so it restarts the agent's idle timer). Busy text "asking the agent…". No agent: show the passphrase field, no message.
- **Passphrase**: Enter with a non-empty field. The typed bytes are taken and the field wiped at once; the key block is unwrapped exactly once with them; busy text "unlocking… (this takes a few seconds on small devices)" while scrypt runs in the background. There is no limit and no delay on retries.
- **Passphrase bytes**: the UTF-8 encoding of the field's characters. They come from key presses that the terminal reports as text without a Ctrl or Alt modifier (Enter, Tab and other special keys add nothing) and from pastes (one line; one trailing line break dropped; text that isn't valid UTF-8 refused; other control characters, such as a TAB, kept). There is no length limit. The CLI prompt instead drops bytes below 0x20 and refuses more than 4096 bytes ([agent-session.md §A4](agent-session.md#a4-terminal-io-devtty)), so a pasted passphrase holding a TAB or another control character gives different bytes in the TUI (known issue, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)).
- **Agent after a lock**: after `L` or the idle lock, the TUI checks (status request) whether an agent still runs (possible with `stop_agent = false`). If so it shows "An agent is running for this vault: Enter with an empty passphrase unlocks with it." and Enter on an empty field asks the agent; the agent is never used automatically after a lock. Otherwise Enter on an empty field shows "Type the passphrase, then Enter.".

### 4.3 Keys

| State | Keys |
|---|---|
| Passphrase field | Enter: unlock ([4.2](#42-unlock-sources)). Esc: clear the field, or quit if it is empty. Ctrl-C, Ctrl-D: quit. Typing: appends (masked editing, [11.4](#114-editing-keys)). Paste: one line only, else "Paste refused: the passphrase is one line." Hints: `Enter unlock · Esc clear · ctrl+c quit` |
| Busy | Only Ctrl-C / Ctrl-D (quit, abandoning the job). Other keys and pastes are ignored. Hint `ctrl+c quit` |
| Rollback question | [9](#9-rollback-question-410) |
| Damaged | Enter: try again (agent, else back to the passphrase field), e.g. after restoring a backup. Esc, `q`: quit. Hints `Enter try again · q quit` |

### 4.4 Results of an unlock attempt

| Result | Shown / next state |
|---|---|
| Success | MAIN; status "Unlocked: N entries, revision R." |
| Wrong passphrase / bad key block | "Wrong passphrase, or the key block is damaged. Try again." (error) |
| Data block doesn't open with a key that fits the key block | Damaged state; the vault's "data is damaged; restore a backup" message with the backup list (§4.5); no passphrase field |
| Agent unlocked for another key block | "The agent was unlocked for another key block (the passphrase was changed?): enter the passphrase." |
| Agent failed otherwise | "The agent didn't give the key (<error>): enter the passphrase." |
| Key block asks for a scrypt work factor above 2^18 (§4.1) | "The vault file's key block asks for more scrypt work than passh ever uses: the file is damaged or wasn't made by passh. Restore a backup (passh backups lists them), then unlock again." |
| Rollback declined | Quit ([1.2](#12-exit)) |
| Any other error (truncated, not a passh vault, newer version, …) | The error text (§4.5), passphrase field stays |

Vault warnings (e.g. text ignored around the blocks, §4.5) are appended to the next status message as "Warning: …".

## 5. Main screen

### 5.1 Layout

Informative: the layout below (boxes, widths, clamps, chrome heights, wrapping, hint-bar texts); the modes it shows (wide/narrow, single pane under 80 columns, "window too small") are normative.

**Wide (≥ 80 columns)**: a box of line-drawing characters.

```
┌ passh ── unlocked · locks in 4:12 ─────────────────────────────┐   title + idle countdown
│ VIEW: [Folders]  Tags                         / search         │   view tabs; search on the right
├────────────────────┬───────────────────────────────────────────┤
│ list               │ pane: the selected row                    │   body
├────────────────────┴───────────────────────────────────────────┤
│ status area (≥ 1 line)                                         │
│ hint bar(s)                                                    │
└────────────────────────────────────────────────────────────────┘
```

- Inner width `I = W − 2`. List width `clamp(I × 35 / 100, 24, 40)`; the pane takes the rest minus the divider.
- Help, an open detail and the print setup replace both columns with one full-width block.
- The title reads "reloading…" while a reload runs. The countdown is the time to the idle lock and restarts on every key.
- The tabs line shows the active view as `[Folders]` / `[Tags]`. Right side: while typing, `/ ` and the query input (at most 30 cells); with results shown, `/ <query>`; otherwise `/ search` (faint).

**Narrow (< 80)**: no box, one pane: title line `passh · unlocked · locks in 4:12` (if too wide, `passh · locks in 4:12`), the tabs line without `VIEW:` and without the `/ search` hint, a rule, the body (the list, or the full-width block), a rule, the status area, the hints. Enter opens the entry's detail, Esc returns (spec §6.2); `r` on a list entry opens its detail already revealed.

**Too small** (< 20 × 6): only "passh: window too small". Keys still work as usual.

Body height = window height − chrome (wide 5, narrow 4) − status lines − hint lines, at least 1. The list scrolls to keep the cursor visible; the help and the detail scroll with their own offset.

**Status area**: first the changed-on-disk banner if set ([8.1](#81-detection), warning style), then one of: an open prompt (bold label, then the input; if the label is wider than half the width it goes on its own line; a validation error below in red), a confirm question (warning style, ending in `[y/N]`), or the current message (error style if it is an error), wrapped, split at line breaks, at most 6 lines.

**Hint bars** (footer; items joined with ` · `, wrapped between items; key names untranslated):

| Context | Items |
|---|---|
| Default, wide | Line 1: `c copy pw · u copy user · r reveal · e edit · a add · t tags · d delete`; line 2: `Tab folders/tags · / search · P print · R reload · L lock · ? help · q quit`. If they need more than 2 lines, all items flow as one list when that takes fewer lines |
| Detail, wide | `Esc back · ↑↓ scroll · c copy pw · u copy user · r reveal · e edit · t tags · d delete · ? help` |
| Narrow list | `↵ open · c copy · / search · Tab view · ? help · q quit` |
| Narrow detail | `Esc back · c copy · u user · r reveal · e edit · ? help` |
| Search typing | `type to search · ↑↓ move · Enter done · Esc close` |
| Help | `↑↓ scroll · any other key closes` |
| Prompt | `Enter ok · Esc cancel` |
| Confirm | `y yes · any other key: no` |
| Print setup | `↑↓ move · space choose · Enter continue · Esc cancel · L lock` |

All contexts except the default are cut to 2 lines.

### 5.2 Folders view

- The tree of entry paths (§4.4). At each level: **subfolders first, then entries**. Both sorted by segment, each segment by bytes (no locale collation: `Bank` < `apple`; `work` sorts before `work-old`).
- Folder row: indent 2 cells per depth, `▸ name` (closed) / `▾ name` (open), and `(N)` right-aligned, N = entries at any depth below. Entry row: the last path segment, indented under its folder. Root entries appear after the root folders.
- All folders start closed after each unlock. The open/closed state survives view switches, saves and reloads.
- Empty vault: the note "No entries yet: a adds one.".

### 5.3 Tags view

- One row per tag in the vault: `[ ] tag` / `[x] tag` with `(count)` right-aligned, sorted by bytes.
- Enter, Space or → toggles a tag's selection. Below the tags a note row, then the result:
  - nothing selected: "Space selects tags; the entries that have all of them show here.";
  - otherwise "── N entries with a + b ──" (selected tags sorted, joined ` + `), followed by every entry that has **all** selected tags (AND), as full paths sorted as in [5.2](#52-folders-view). Zero matches shows just the heading.
- Esc clears the selection. The selection survives Tab; a selected tag that no longer exists after a save or reload is dropped.
- No tags: "No tags yet: t edits an entry's tags.".

### 5.4 Search

- `/` opens the search with an empty query, which lists every entry (full paths, sorted as [5.2](#52-folders-view)). The list shows results while the search is active; the Folders/Tags view underneath is kept.
- What is searched: entry **paths** (the full path string) and **tags**. Nothing else (no usernames, URLs, notes or field values).
- Matching and score: the fuzzy match and score of `passh find` ([cli.md, fuzzy matching](cli.md#fuzzy-matching)), applied to the query as typed: not normalized (no NFC, no trimming), with spaces as pattern characters; a query that is empty or only white space lists every entry instead. Each path is matched as its raw string (not its S4-escaped form), and so is each tag.
- Tags are matched once each, in the order of first appearance: entries sorted as in [5.2](#52-folders-view), each entry's tags in stored order. A tag's score counts, unchanged, for every entry that has it. An entry's score is the best of its path's score and its tags' scores; a tag replaces the path match only if it scores strictly higher, and of several tags with the entry's best score the first in that order wins. The row then shows `#tag` at the right.
- Order: score descending, then path by plain byte comparison of the whole string (`work-old/y` before `work/x`; known issue: the proposed fix is the order of [5.2](#52-folders-view), see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)).
- Differences from `passh find` ([cli.md §2.4](cli.md#24-find)): `find` counts a tag at its score − 1 (a tag must beat the path by 2, and an entry found through a tag ranks one point lower than here), orders ties segment by segment, and refuses an empty query; it also matches a query of only spaces as spaces.
- The results update on every change of the query (typing, deleting, paste) and after every save or reload; each change of the query puts the cursor on the first result. No results: the note "No matches.".
- Keys while typing: all printable keys are text (including `q`, `L`, `?`, `c`); readline editing keys ([11.4](#114-editing-keys)); ↑/Ctrl-P, ↓/Ctrl-N move in the results; Enter stops typing and keeps the results (list and global keys then apply; `/` resumes typing), or closes the search when there are no results; Esc closes the search (query wiped); Tab closes it and switches the view; Ctrl-C quits. A paste must be one line.

### 5.5 Cursor

Each list (Folders, Tags, Search) remembers its own cursor by item (folder path, tag, entry id), so it stays on the same item across view switches, saves and reloads. If that item is gone, the cursor goes to the nearest selectable row at the same index (looking down first, then up). After a save the cursor goes to the saved entry, opening its folders in the Folders view.

## 6. Entry display

### 6.1 Pane and detail

In the wide layout the right pane always shows the row under the cursor:

- entry: the entry view ([6.2](#62-entry-view)); if it doesn't fit, the last line becomes "… Enter shows all";
- folder: `<folder>/`, "N entries", "Enter opens it, ← closes it.";
- tag: "tag <name>", "N entries", "Space selects it; entries with all selected tags are listed.";
- nothing: "Nothing selected.".

Enter on an entry opens the **detail**: the same entry view, full width, scrollable (both layouts).

### 6.2 Entry view

Lines, in order (each value escaped per S4, on one line; values wrap to the value column):

1. The full path (bold, wrapped).
2. `username` — only if not empty.
3. `password` — always: the Mask, or the value when revealed, or "(none)" (faint) when empty. If there is room on its last line (and the view isn't stacked): `[c]opy [r]eveal`, or `[c]opy [r] hide` when revealed.
4. `url` — only if not empty.
5. `tags` — only if any, joined with ` · `.
6. Custom fields in stored order, labelled by key. A field is **secret** when its key is `password` or `otp` (any case) or its value starts with `otpauth://` (any case); secret fields are masked and revealed exactly like the password ("(none)" when empty).
7. `notes` — only if not empty: each stored line on its own (tab → 4 spaces), wrapped.
8. "updated YYYY-MM-DD HH:MM" in local time (faint), if `updated_at` is set.
9. When revealed: "shown for N s more (r hides)" (warning style), counting down.

Informative: labels sit in a 10-cell column. When the width is under 30 cells, or a label is wider than 8 cells, the view is **stacked**: label on its own line, value below indented by 2.

### 6.3 Reveal (S5)

- `r` reveals every secret value of the selected entry (password and secret fields) for 10 s; `r` again hides at once. In the narrow list, `r` also opens the entry's detail.
- It hides when the 10 s are over, when the cursor moves to another row, when the detail is left or another entry's detail is opened, when a form opens, and on lock. A reveal belongs to one entry id only.
- Nothing else ever shows a secret in clear: copying shows no value, and status messages never contain values.

## 7. Operations

### 7.1 Copy (§6.3)

- `c` / `u` copy the selected entry's password / username. An empty value: "<path> has no password." (or username), nothing copied. URL and custom fields can't be copied from the TUI.
- No clipboard (OSC 52 off and no `clipboard.command`, or the clipboard couldn't be set up): sticky error with the hint of §6.3 (`passh show <path> --field password | pbcopy`).
- The copy runs in the background ("Copying…"). Then the status line becomes a live countdown, not subject to the 8 s expiry: "Password copied · clears in N s (L clears it now)" (or "Username copied …"); when due "Clearing the clipboard…" until the clear has run; then "Clipboard cleared." or "Clearing the clipboard failed: <error>" (error). It never says "cleared" for a clear that hasn't happened or failed. Failure of the copy: "Not copied: <error>" (sticky error).
- A later copy replaces the earlier one's schedule; only the latest copy's result is shown.
- The clear itself is timed by the clipboard component (`clipboard.clear_after`), independent of the UI. A lock by `L`, idle or a signal clears a pending clear at once; quitting waits for it ([1.2](#12-exit)).

### 7.2 Add

1. Refused while busy or changed on disk ([7.10](#710-refusals)).
2. Prompt "New entry's path: " pre-filled with the folder under the cursor plus `/` (a folder row: that folder; an entry row: its folder; else empty).
3. Enter: the path is validated (§4.4; the validator's error under the prompt) and must not exist ("<path> already exists: e edits it."). Then the form opens titled "add <path>" ([11](#11-entry-form-56)) with all fields empty.
4. Saving (Ctrl-S) adds the entry: "Added <path>."; the cursor goes to it.

### 7.3 Edit

`e` (refused while busy or changed on disk) opens the form titled "edit <path>". Saving: "Saved <path>.", or "No changes." when nothing changed (no save is made then). The path can't be changed in the form; use `m`.

### 7.4 Move

`m` (refused while busy or changed on disk): prompt "Move to: " pre-filled with the current path. Enter: validate (§4.4); the same path closes the prompt silently; otherwise move (one save): "Moved <src> to <dst>.", cursor follows the entry. A failure (e.g. the destination exists) reopens the prompt with the error.

### 7.5 Tags

`t` (refused while busy or changed on disk): prompt "Tags (comma-separated): " pre-filled with the tags joined by `, `. Enter: the list is split at commas, empty items skipped, each tag normalized and checked (§4.4, error under the prompt), duplicates dropped. Tags in the list but not on the entry are added, tags on the entry but not in the list removed (one save, as `passh tag --add … --remove …`): the remaining tags keep their stored order and the added ones follow in the order typed (`a, b` edited to `c, b, a` gives `a, b, c`). "Tags of <path> saved.". No difference (order ignored): "No changes.", no save.

### 7.6 Delete

`d` (refused while busy or changed on disk): "Delete <path>? [y/N]". `y`/`Y` deletes (one save, tombstone per §4.2): "Deleted <path>."; an open detail of that entry closes. Any other key (Esc, Enter, Ctrl-C included): "Not deleted.". `L` locks instead (nothing deleted).

### 7.7 Saves

Every change is one save of §4.6 in the background; the UI keeps running (countdown, `L`, idle lock):

- Status "Saving…" (sticky). One save at a time: while one runs, or a reload runs, starting another change is refused with "Busy: wait for the save to finish." / "Busy: wait for the reload to finish.".
- Before saving, the vault file is checked; if it changed on disk nothing is saved and the input is kept ([8.2](#82-kept-input)).
- Success: the displayed data is replaced by the saved data and the operation's message is shown.
- Other failure: the form comes back with "Not saved: <error>" ([11.6](#116-in-the-tui)), a prompt comes back with the error, a delete says "Not deleted: <error>" (sticky).
- A lock or quit during a save: the save keeps the vault's lock and finishes (or, if it was still waiting for another passh process's lock, stops). The lock screen shows "locking: the change to <path> is still being saved…", then reports either the success message or "Not saved (<path>): the lock came before it was written." / "…: the vault changed on disk." / "…: <error>". After quitting, the same report goes to stderr ([1.2](#12-exit)).

### 7.8 Print setup (`P`, §7.4)

- `print_web.enabled = false`: error "The print page is off: set enabled = true in the [print_web] table of the config file (print_web.enabled)." Busy (save, reload, or a print page still starting): busy message.
- Full-width screen "Print page: what to print" with two groups:
  - **Entries** (radio, `(•)`/`( )`): "all entries (N entries)"; "folder <f>/ (N entries)" if the cursor is on a folder or on an entry inside a folder; "tags a + b (N entries)" if the Tags view has selected tags (AND). Default: the folder in the Folders view, the tags in the Tags view, else all.
  - **Fields** (checkboxes): `password`, `username`, `url` (on by default, the defaults of `passh print`), "custom fields" (off).
- Keys: ↑/`k`, ↓/`j`/Tab, Home/`g`, End/`G` move; Space or `x` chooses the scope under the cursor or toggles the field; Enter continues; Esc/Ctrl-C: "Print page cancelled."; `L` locks.
- Enter refuses "Choose at least one field." or "No entries to print there: choose another." Otherwise the prompt "Type PRINT to start the print page: ". Anything but exactly `PRINT` (case-sensitive): "Not confirmed: the print page wasn't started.".
- The page is built from a copy of the data and started in the background ("Starting the print page…"); a failure (no private address, nothing to print, …) is a sticky "Print page: <error>". An empty selection that gets this far reads `nothing to print: the vault has no entries` whatever the scope (known issue: the CLI's `no entries to print: none matches …` is the proposed fix, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)).

### 7.9 Print dialog

Full screen under the title line `passh · print page · unlocked · locks in m:ss`:

- "Print page", "Open this address in a browser on your LAN or VPN, compare the certificate fingerprint, then print:", **one URL at a time** (bold) with "(i of n, Tab: next)" when there are several, "Certificate fingerprint (SHA-256); the browser must show the same:" and the fingerprint, a certificate notice if any (new certificate, warning style), "Not used: …" for skipped interfaces.
- The QR code of the shown URL: beside the text when the width is ≥ 40 + QR width + 3, else below; "(no QR code for this address)" or "(the window is too narrow for the QR code)" when it can't be shown. The content scrolls; when cut, the last visible line reads "↓ more (↓ scrolls)".
- Footer: "Stops in m:ss, after the page is loaded once, or with Esc.", the copy note, hints `c copy URL · Tab next URL · ↑↓ scroll · Esc stop`.
- Keys: `c` copies the shown URL (cleared after `clipboard.clear_after`, like a password; "URL copied · the clipboard clears in 30s." or the reason it couldn't); Tab/`n` next URL, Shift-Tab/`p` previous; ↑/`k`, ↓/`j` scroll by 1, PgUp, PgDn/Space by 10, Home/`g` top; Esc or Ctrl-C stops the server (the dialog closes when it has stopped); `L` locks (which stops the server).
- The server's state is checked every second. When it stops by itself (page served, TTL, too many wrong tokens), the dialog shows "Print page stopped" and the outcome (e.g. who got the page; see [print.md](print.md)), warning style unless served; any key closes. Closing leaves "Print page: <outcome>." (or "Print page stopped.") in the status line.
- The idle lock keeps running while the dialog is open; it stops the page like any lock, so in the TUI the page lives at most until `idle_ttl` after the last key, even if `print_web.ttl` is longer.

### 7.10 Refusals

`e`, `a`, `t`, `m`, `d` are refused before anything opens when a save or reload runs (busy message) or when the vault changed on disk: "The vault changed on disk: R reloads it. Changes are blocked until then." (sticky error). Copy, reveal, browsing, search and print are never blocked by "changed on disk".

## 8. Vault changed on disk and reload

### 8.1 Detection

Every 2 s, while the main screen is shown and no save, reload or earlier check runs, the TUI checks whether the vault file still is the one opened or last saved (content hash, file gone, symlink retargeted; [storage.md](storage.md)). Once changed, checking stops until a reload. The banner "Vault changed on disk — R to reload. Saving is blocked until then." heads the status area (in the form: "Vault changed on disk: saving is refused; your input is kept for after R."). A failed check is shown once as "Checking the vault file failed: <error>" and doesn't block saving (each save checks again under its lock). The TUI's own saves don't trigger the banner.

### 8.2 Kept input

A save refused because the file changed (detected before or during the save) never loses what the user typed:

- The form or prompt closes; status "Not saved: the vault changed on disk. R reloads it; your input is kept." (sticky error). A refused delete says "Not deleted: the vault changed on disk. R reloads it; then delete again." and keeps nothing.
- After a successful `R` the kept input comes back:
  - a prompt: reopened as it was; Enter then applies it to the reloaded entry (a tags prompt adds and removes against the reloaded tags);
  - an add form, or an edit form whose entry is unchanged on disk (the same id, path, times, values, custom fields and unknown keys): the same form, every value as left, message "Reloaded: your input is back; ctrl+s saves it." (drawn in the error style: known issue, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md));
  - the entry (found by id) was deleted on disk: an add form "add <path> (not saved yet)" with the user's values (saving adds it again under a new id and new times, with the custom fields and unknown keys the entry had when the form opened), message "<path> was deleted on disk: saving adds it again.";
  - the entry changed on disk: an edit form "edit <path> (not saved yet)" on the reloaded entry, where each of password, username, url, tags, notes that the user had changed (compared with the entry when the form opened) takes the user's value, the others the new ones from disk. Everything else comes from the reloaded entry: path (it may have been moved), id, times, custom fields, and unknown keys of the entry and of its fields. Message "Reloaded: your input is back; ctrl+s saves it. It changed on disk too; the other values are the new ones.".
- Esc/Ctrl-C in a reopened form never drops the kept input silently: the same form asks its own question ([11.3](#113-keys)) when values differ from when it first opened; a recreated form ("not saved yet") with no further change asks "Discard the changes that weren't saved? esc: discard · any other key: keep editing" (Esc/Ctrl-C again: "Changes discarded."; any other key is consumed and editing continues).
- A lock drops kept input.

### 8.3 Reload (`R`)

Allowed at any time in the main screen when nothing is busy. Runs in the background ("Reloading…"; title "reloading…"). The current vault key is tried first (so a `passwd` elsewhere reloads fine). A file rekeyed elsewhere needs the unlock source again: the agent works only if it was unlocked for the new key block; a typed passphrase is never kept, so then "Reload failed: the vault was rekeyed elsewhere: lock (L) and unlock with its current passphrase". Success: banner cleared, data replaced (cursor, expansion and tag selection kept where items still exist), "Reloaded: revision R, N entries.", then kept input returns ([8.2](#82-kept-input)). Failure: "Reload failed: <error>" (sticky error); the old data stays shown and saving stays blocked.

## 9. Rollback question (§4.10)

| When | Shown | Keys |
|---|---|---|
| Unlock (lock screen) | "Warning: <rollback warning>" (warning style), "Continue with this copy? y/N" | `y`/`Y`: continue. `n`/`N`, Esc, Enter: no → the TUI exits with the "stopped" error. Ctrl-C: quit. Other keys ignored. Hints `y continue · n stop` |
| Reload (`R`) | In the status area: "Warning: <warning> Continue with this copy? [y/N]" | `y`/`Y`: continue (reload proceeds, record updated). Any other key: no → "Reload failed: stopped: this copy is older …", old data kept, saving stays blocked. Ctrl-C: quit. `L`: lock (question dropped) |

A question belongs to the job that asked it: a lock or quit cancels the job, and a late answer can never reach a later question.

## 10. Locking (§5.2)

### 10.1 Triggers

- `L` outside text fields ([3.2](#32-key-routing-in-main-first-match-wins)).
- Idle: no key press or paste for `session.idle_ttl` (checked every second, while the main screen is shown, forms and the print dialog included). Nothing else counts as activity: not window resizes, background results, or the print page being loaded. Unsaved form input is dropped. The reference compares monotonic times, so time while the machine sleeps doesn't count (unlike the agent, [agent-session.md §A2.6](agent-session.md#a26-serving-and-expiry-must-for-the-ttl-rules); a known issue: [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)).
- Quitting ([1.2](#12-exit)), signals ([1.2](#12-exit)).

### 10.2 What a lock does

Immediately: the UI's data and typed input are wiped (decrypted data, passphrase input, form, prompts, search query, kept input), the running reload/unlock job is cancelled, the print page is told to stop, and the lock screen shows "locking…". Then, in the background, after any save or copy that started before the lock has finished (no new one can start): the vault is closed (key and data wiped), the print page stopped, a pending clipboard clear done at once (not on quit, [1.2](#12-exit)), and the agent stopped if `session.stop_agent` is on.

The lock screen then shows one message: the save report if a save was running ([7.7](#77-saves)), "Locked." or "Locked after <idle_ttl> without input.", then "Clipboard cleared." if a pending clear was done, "Agent stopped." if one was stopped, and "Clearing the clipboard failed: …." / "Stopping the agent failed: …." (error style) for failures. After `L` or the idle lock, the agent hint of [4.2](#42-unlock-sources) appears if an agent still runs.

## 11. Entry form (§5.6)

Used by the TUI (`e`, and `a` after the path) and by `passh edit <path>` without `--editor` ([cli.md](cli.md)).

### 11.1 Layout

Informative: the arrangement and widths below.

```
edit work/github                         title (bold); in the TUI under the title line with the countdown
                                         blank line only when the form area is ≥ 16 lines
› password  ••••••••  changed            focus marker ›, labels right-aligned in 8 cells
  username  arsenii
       url  https://github.com
      tags  work, dev, 2fa
     notes  │ free text, soft-wrapped at spaces,
            │ scrolls to keep the cursor visible
    fields  recovery-email (kept as they are; edit them with --editor)
                                         blank line only when ≥ 16 lines
[status line]
ctrl+s save · esc cancel · tab next · ctrl+r show password · ctrl+g generate
```

- Value column = width − 12 (at least 8). An unfocused value that doesn't fit ends in `…`; a focused one scrolls horizontally to keep the cursor visible.
- Password: the Mask when not empty, faint "(empty)" when empty, and faint " changed" once it differs from the starting value; the clear value with a cursor only while revealed.
- Notes take all remaining height (at least 1 line). The `fields` line lists the custom field keys (wrapped at spaces, at most 3 lines, `…` when cut); absent when there are none.
- An inline error appears under its field (red label, red `›` if focused). The key help adds "enter new line" when the notes have focus and says "ctrl+r hide password" while revealed.
- In the TUI, the TUI's own status (banner, messages) is drawn under the form. Every value is escaped per S4; control characters show as escapes and the cursor moves over each as one unit.

### 11.2 Fields and focus

Focus order: password, username, url, tags, notes (cyclic). The form opens with the password focused, each cursor at the end of its value. Custom fields, the path, id, times and unknown keys are not editable and are kept exactly.

### 11.3 Keys

| Key | Action |
|---|---|
| Ctrl-S, Alt-Enter | Save ([11.5](#115-save-and-validation)). Enter never saves |
| Esc, Ctrl-C | Cancel. If any value differs from the start: "Discard the changes? esc: discard · any other key: keep editing" (warning style); Esc/Ctrl-C then discards (TUI status "Cancelled."), any other key or a paste is consumed and editing continues |
| Tab / Shift-Tab | Next / previous field |
| Enter, ↓, Ctrl-N / ↑, Ctrl-P | In a single-line field: next / previous field |
| Enter, Ctrl-J, Ctrl-M | In the notes: new line |
| ↑ ↓ (Ctrl-P/N), PgUp/PgDn | In the notes: move by visual row / by (height − 1) rows, keeping the column; ↑ on the first row moves to the previous field, ↓ on the last row stays |
| Ctrl-R | Reveal the password for 10 s ("Password shown; it hides again in 10 s (ctrl+r hides it now)."); again hides it |
| Ctrl-G | Replace the password with a new one (24 letters and digits, `crypto/rand`, S3): "Generated a new password (24 characters); ctrl+r shows it." (or "…; it is shown." when revealed) |

`L`, `q`, `?` and every other printable key are text. The idle lock and signals still apply in the TUI.

### 11.4 Editing keys

All one-line inputs (form fields, TUI prompts, search, passphrase) and the notes use the same readline-style set: ←/Ctrl-B, →/Ctrl-F, Home/Ctrl-A, End/Ctrl-E, Alt-←/Ctrl-←/Alt-B and Alt-→/Ctrl-→/Alt-F (word), Backspace/Ctrl-H, Delete/Ctrl-D, Ctrl-W/Alt-Backspace/Ctrl-Backspace (word before), Alt-D/Alt-Delete/Ctrl-Delete (word after), Ctrl-U (to start of line), Ctrl-K (to end of line). In the notes, Backspace at a line start, and Delete/Ctrl-K/Alt-D at a line end, join lines. Words are separated by whitespace. No key reads the system clipboard; text comes only from typing and terminal paste.

**Masked editing** (the hidden password field, the passphrase field): the cursor is always at the end; typed text is appended; Backspace removes the last character; Ctrl-U, Ctrl-W, Alt-Backspace, Ctrl-Backspace clear everything; movement and forward-deletion keys do nothing. This keeps a hidden value's content from showing through cursor movement.

**Line breaks**: typed line breaks in a single-line field are dropped. A paste into a single-line field loses one trailing line break (`\r\n`, `\n` or `\r`); a paste with a line break inside is refused with an inline error ("paste refused: <field> is a single line and the text has line breaks") and nothing changes. A paste into the notes has CRLF and CR turned into LF. A paste that isn't valid UTF-8 is refused. Values are otherwise kept exactly, control characters included.

### 11.5 Save and validation

On Ctrl-S the result is the original entry with, for each of password, username, url, tags, notes: the **original value exactly** if the input wasn't changed, else the input. Changed tags are parsed as in [7.5](#75-tags) but stored in the order typed (the whole list replaces the old one, as a `tags:` line of `edit --editor` does; `a, b` edited to `b, a` is a change); an invalid tag shows an inline error under `tags` and moves the focus there. Then the entry is checked (single-line values without line breaks, valid UTF-8, §4.2/§4.4 rules); a failure shows in the status line (error). An empty password is allowed.

### 11.6 In the TUI

On save the form closes at once and the save runs in the background ([7.7](#77-saves)). A failed save reopens the same form with every value as left and "Not saved: <error>" in its status line; Esc behaves as in [11.3](#113-keys) (values are compared with the start, so changed input is never dropped without the question). Refused because the file changed: [8.2](#82-kept-input). Cancel: status "Cancelled.". While the window is under 20 × 6 the form isn't drawn ("passh: window too small") but keeps its input.

### 11.7 Standalone (`passh edit`)

Same form on its own alternate screen, sized to the terminal, without the TUI's title line, countdown, idle lock or banner. Ctrl-C is a key ([11.3](#113-keys)). It needs a terminal ("the entry form needs a terminal").

## 12. Output safety and styles

- Every value from the vault (paths, tags, fields, notes, errors that carry them) is escaped per S4 where it is drawn, one line at a time. In addition, every complete frame passes a final filter that escapes any ESC sequence except SGR with the parameters `0 1 2 7 22 27 39 30–37 90–97` (the styles below) and turns tabs into spaces. A value that missed its own escaping still can't drive the terminal.
- The alternate screen keeps revealed values out of the scrollback.
- Informative: styles use only the basic 16 colours and attributes; every meaning is also carried by text:

| Style | Used for |
|---|---|
| Bold | title, active view tab, key names, prompt labels, URL and fingerprint |
| Faint | hints, secondary text, empty values, list note rows |
| Reverse | selected list row, the cursor |
| Red | errors, inline field errors |
| Yellow | warnings: changed-on-disk banner, confirm questions, rollback warning, reveal countdown, certificate notice |
| Cyan | field labels in the entry view; focused label in the form |
