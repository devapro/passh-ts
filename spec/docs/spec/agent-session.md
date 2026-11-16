# Appendix: agent, session and safety mechanics

Normative appendix to [spec.md](../../spec.md) §5.1, §5.3, §5.5, §5.6, §6.3 and §6.4. Scope: the agent (socket location and folder, start, protocol, expiry, `passh lock`), where a command gets the vault key, terminal I/O on `/dev/tty`, the clipboard, the external editor, how processes are started, hardening, and how the safety rules S1–S9 are met: what a re-implementation needs for the same behaviour and the same security properties. The TUI session (idle lock, what a lock does) is in [tui.md §10](tui.md#10-locking-52). spec.md gives the design; this appendix gives the exact formats and behaviour. Precedence: see [spec.md §1.1](../../spec.md#11-appendices-normative). `§4.5` means a section of spec.md, `§A2.5` a section of this file. **MUST** marks what other passh versions or the safety rules depend on (socket location, protocol, file modes, the key-block check); the rest describes the reference behaviour. Messages are the English texts (translated per `language`, §3.3; typed phrases and the agent's wire texts stay English).

Exit statuses (0 success, 1 error, 2 usage error, 128 + n after signal n, and the exceptions) are those of [cli.md §1.4](cli.md#14-exit-statuses).

## A1. Constants

| What | Value |
|---|---|
| `session.idle_ttl` / `session.stop_agent` defaults | 5 min / true |
| `agent.idle_ttl` / `agent.max_ttl` defaults | 15 min / 2 h (`unlock --ttl` replaces `max_ttl` only). Config durations and `--ttl` are Go durations (`30s`, `1h30m`), > 0 |
| `clipboard.clear_after` default | 30 s |
| Unix socket path, max | 103 bytes (macOS `sun_path` 104 incl. NUL; the same limit on Linux) |
| Agent start: readiness wait | 10 s (or the caller's deadline, if earlier); readiness line ≤ 1024 bytes |
| Agent: one connection | 5 s deadline, both sides; a client call without its own deadline gets 5 s |
| Agent: socket ownership check | every 1 s |
| Agent: request or response line | ≤ 4096 bytes including `\n` |
| Agent: stdin from `unlock` | ≤ 511 bytes; key text ≤ 128 bytes |
| `lock`: wait for the socket to vanish | poll every 10 ms, ≤ 5 s |
| Passphrase prompt attempts / pair attempts / yes-no tries | 3 / 3 / 3 |
| Passphrase max / line max | 4096 bytes / 65536 bytes |
| Clipboard command timeout (copy or clear) | 10 s |
| `doctor` clipboard test wait | min(`clear_after`, 5 s) |
| Edited file max size | 16 MiB |

The TUI's constants (clock tick, lock bound, mask and reveal time) are in [tui.md §2](tui.md#2-constants).

## A2. Agent (spec §5.3)

### A2.1 Socket location (MUST)

```
real  = realpath(vault)        # absolute, cleaned, every symlink resolved; the vault must exist
name  = "agent-" + lowercase_hex(SHA-256(bytes of real))[0:16] + ".sock"     # 27 bytes
state = $XDG_STATE_HOME/passh   if XDG_STATE_HOME is set and absolute
        else $HOME/.local/state/passh
dir   = first of  state + "/agent"
                  $TMPDIR + "/passh-" + uid   (only if TMPDIR is set and absolute)
                  "/tmp/passh-" + uid
        for which len(dir + "/" + name) <= 103
        none fits -> error "the agent's socket path is longer than 103 bytes even in /tmp"
socket = dir + "/" + name
```

`uid` is the real uid in decimal (§A2.2, "uids"). Example: `/home/alice/.local/share/passh/vault.passh` → `/home/alice/.local/state/passh/agent/agent-7235202d1eb458e0.sock`. The hash input is the real path's bytes with no terminator; every name for the same file (relative path, symlink) finds the same agent. The choice depends on lengths only: if `$TMPDIR` is chosen but doesn't exist, creating the folder fails, with no further fallback to `/tmp`. The fallback depends on `$TMPDIR` at the time of each call, so `unlock` and later commands must see the same `$TMPDIR` (normally true for one user's SSH sessions).

### A2.2 Agent folder (MUST)

- **Create** (agent only): for `state/agent`, create the state folder's missing parents (`mkdir -p`, mode 0700 reduced by the umask) and the state folder itself with mode exactly 0700 if missing (an existing one is left as is; [storage.md §1.3](storage.md#13-creating-folders)); then create the agent folder with mode exactly 0700 (chmod after mkdir, whatever the umask). For the fallback, `$TMPDIR` or `/tmp` must exist. An existing folder is never fixed, only checked.
- **Check** (agent and every client call): open the folder with `O_DIRECTORY|O_NOFOLLOW`, `fstat` the handle, and require: a directory; owner = own uid; permission bits (`mode & 07777`) exactly `0700`. Failures:

| Condition | Error |
|---|---|
| Missing | client: "no agent" (§A2.7); agent: created |
| Symlink or file | `agent folder <dir> is not a directory (a symlink or a file); refusing to use it` |
| Other owner | `agent folder <dir> belongs to uid <n>, not to you (uid <m>); refusing to use it` |
| Mode ≠ 0700 | `agent folder <dir> has mode <0nnn>, not 0700; refusing to use it (fix it with chmod 700, or remove it)` |
| Other open or `fstat` error | `opening the agent folder <dir>: <error>` / `checking the agent folder <dir>: <error>` |

`<dir>` is the absolute folder path (no `~/`). A `passh-<uid>` folder pre-created by another user in a shared `/tmp` therefore blocks the agent (denial of service only).

**uids.** "Own uid", "you" and the `<uid>` of folder names are the **real** uid (`getuid`). A peer's uid is what the kernel reports for the socket (`SO_PEERCRED` on Linux, `getpeereid` on macOS): the peer's **effective** uid. passh never looks at its own effective uid. With real = effective (normal use, `sudo -u u passh …`) this is one uid; under a setuid wrapper (real ≠ effective) the folder the agent creates belongs to the effective uid and fails the owner check (`belongs to uid <euid>, not to you (uid <ruid>)`), so the agent can't be used (not supported).

### A2.3 Starting: `passh unlock [--ttl d]`

1. `--ttl` given and ≤ 0 → usage error `--ttl must be more than zero` (exit 2). Load the config; the vault file must exist.
2. Send `status`. If an agent answers: read and leniently parse the vault file (§4.5; on failure: `an agent is running, but the vault can't be checked against it: …`, exit 1) and send `key` with its key block's digest (§A2.5). This key request restarts the idle TTL.
   - Served → print `Already unlocked: <times>.` (exit 0; no terminal needed). With `--ttl`, also warn ``--ttl was not applied: the agent was already running; run `passh lock`, then `passh unlock --ttl …` ``.
   - `key_block_changed`, or the agent vanished → note `the running agent was unlocked with another key block (passwd elsewhere?); replacing it`, send `stop` (§A2.9), continue.
   - Any other status error → exit 1.
3. No terminal → ``passh unlock needs a terminal to ask for the passphrase (over SSH: `ssh -t host passh unlock`)``, exit 1.
4. Open the vault with the passphrase only (the agent is not asked): the full open of §4.5, data block and rollback check included, up to 3 attempts.
5. Start the agent process (below) with idle = `agent.idle_ttl`, max = `--ttl` or `agent.max_ttl`.
6. Readiness `running` (another `unlock` won the race): send `key` with this vault's key block (restarts its idle TTL), then print `Already unlocked: …`.
7. Success: `Unlocked <path>: <times>.` and ``Run `passh lock` to stop the agent now.`` on stderr.

`<times>` = `the agent (pid <n>) exits in <D>` when idle_left ≥ max_left, else `the agent (pid <n>) exits in <D1> if unused, in <D2> at the latest`. `<D>`: the duration rounded to the nearest second (a half second rounds up), negative as 0; then with ≥ 1 h: hours, and minutes if not 0 (`2h`, `1h30m`; seconds dropped: 1 h 0 min 59 s is `1h`); else with ≥ 1 min: minutes, and seconds if not 0 (`15m`, `14m59s`); else seconds (`45s`; under 0.5 s: `0s`).

**Agent process.** MUST (S2): the key reaches the agent only through a pipe, never through argv, the environment or a file. *Informative:* the rest of this block (argv, fd 3, readiness lines, cwd) is the reference implementation's channel between parent and child; only the socket location, the folder checks and the protocol (§A2.1, §A2.2, §A2.5) cross implementations. The parent re-executes its own binary (`/proc/self/exe` equivalent):

```
argv:   <passh> __agent --vault=<real path> --idle-ttl=<Go duration> --max-ttl=<Go duration>
        e.g.    __agent --vault=/home/a/.local/share/passh/vault.passh --idle-ttl=15m0s --max-ttl=2h0m0s
env:    inherited unchanged (holds no secret)
setup:  new session (setsid: no controlling terminal, no SIGHUP from the SSH session), cwd "/",
        stdin = pipe, stdout/stderr = /dev/null, fd 3 = write end of the readiness pipe, no other fds
stdin:  "<AGE-SECRET-KEY-1…>\n<lowercase hex SHA-256 of the binary key block>\n", then EOF
```

The parent writes stdin and closes it, then reads one readiness line from fd 3's other end. It never waits for the agent to exit (it may reap it if it is still running).

| Readiness | Parent result |
|---|---|
| `ok` | send `status`; return it. No answer → `agent: the agent (pid <n>) started but doesn't answer: …` |
| `running` | step 6 above |
| `error: <one-line English text>` | kill the child; `agent: starting the agent: <text without a leading "agent: ">`, exit 1 |
| pipe closed without a line | kill; `… the agent exited before it was ready` |
| no line within 10 s | kill; `… the agent didn't report ready within 10s` |

**Child (`__agent`)**, in order: (a) fd 3 must be a FIFO, else print ``passh: __agent is started by `passh unlock`, not by hand`` and exit 2; (b) umask 077; (c) core dumps off (S7; failure is fatal); (d) parse exactly `--vault` (absolute) and both TTLs (> 0), resolve the vault's real path; (e) read stdin to EOF: trim each line, drop blank lines, require exactly two lines: a valid key (§A2.5 key text plus a valid bech32 X25519 identity) and a 64-character lowercase hex digest; (f) handle SIGTERM and SIGINT (exit), ignore SIGHUP; (g) create the folder and bind the socket (§A2.4); (h) write `ok\n` to fd 3 and close it; (i) serve (§A2.6). Any failure in (c)–(g) is reported as `error: …` and exits 1; a live agent on the socket gives `running` (exit 1). The child never reads a config file and speaks English.

### A2.4 Binding the socket

Up to 3 times: bind. On `EADDRINUSE`: `lstat` the path; gone → retry; not a socket → `agent: <path> exists and is not a socket; refusing to replace it`; a socket → connect to it (5 s): it answers → readiness `running`; `ECONNREFUSED`/`ENOENT` (a crashed agent's leftover) → remove it and retry. Three failures → `agent: <path> keeps reappearing`. After binding: `lstat` must show a socket; `chmod 0600`; record its device and inode. Nothing is accepted before the chmod (the umask already gives ≤ 0700, and the folder is 0700).

### A2.5 Protocol v1 (MUST)

One request and one response per connection, then both sides close. Each message is one JSON object on one line ending in `\n`, at most 4096 bytes including the `\n`. Bytes after the first `\n` are ignored.

Framing on the agent's side: a line may end in `\r\n` (the `\r` is JSON white space, so the request is valid); bytes followed by end of input (a close or half-close) without `\n` get no answer; nothing complete within the 5 s deadline → closed without an answer; 4096 bytes without `\n` → `request too large`.

**Key-block digest:** `key_block` = lowercase hex SHA-256 (64 characters) of the **binary** key block, i.e. the base64-decoded content of the vault's first armored block (an age file starting `age-encryption.org/v1\n`). It is independent of line endings and wrapping. It is not a secret (anyone who can read the vault can compute it); it only stops the agent's key from being used with another key block.

Requests (clients send exactly these member names, lower case):

```
{"v":1,"op":"status"}
{"v":1,"op":"stop"}
{"v":1,"op":"key","key_block":"e06160386f434f2e25f80f79bb24060403bdb6ca1bd9869fe021edd04a3acf44"}
```

Responses:

```
{"v":1,"ok":true,"key":"AGE-SECRET-KEY-1…"}                                          key
{"v":1,"ok":true,"pid":24892,"vault":"/home/a/v.passh","idle_left_ms":899821,"max_left_ms":7199821}   status, stop
{"v":1,"ok":false,"code":"key_block_changed","error":"the vault's key block isn't the one this agent was unlocked with"}
```

- `vault` is the agent's real vault path. `idle_left_ms` = idle_ttl − time since the last served key request (or start); `max_left_ms` = max_ttl − time since start; both clamped to ≥ 1. `stop` answers with the status from just before stopping.
- The key response is exactly `{"v":1,"ok":true,"key":"` + key + `"}` + `\n`. Key text: `AGE-SECRET-KEY-1` followed by `[A-Z0-9]`, at most 128 bytes in total (needs no JSON escaping). The agent never sends the recipient (S9).
- Server checks, in order (first failure answers and closes):

| # | Check | Response `code` | `error` text |
|---|---|---|---|
| 1 | Peer uid = agent's uid | none: the connection is closed unanswered | — |
| 2 | A line within 4096 bytes | `bad_request` | `request too large` (a connection closed mid-line gets no answer) |
| 3 | Valid JSON object | `bad_request` | `malformed request` |
| 4 | `v` = 1 (absent counts as 0) | `version` | `the agent speaks protocol version 1, not <v>` |
| 5 | `op` is `key`, `status` or `stop` | `bad_request` | `unknown request "<op, first 32 characters>"` |
| 6 | `key`: `key_block` present | `bad_request` | `a key request must name the vault's key block (key_block)` |
| 7 | `key`: `key_block` is 64 lowercase hex | `bad_request` | `key_block is not a hex SHA-256` |
| 8 | `key`: equals the digest from `unlock` (constant-time) | `key_block_changed` | `the vault's key block isn't the one this agent was unlocked with` |
| 9 | `key`: not expired and not stopping | `expired` | `the agent has expired` |

  Decoding (MUST, so that old and new agents refuse the same requests): the request is decoded into the members `v` (integer), `op` (string) and `key_block` (string); member names match case-insensitively (`{"V":1,"OP":"status"}` is valid), a repeated member keeps its last value, unknown members are ignored. Then:

  | Request | Check | Answer |
  |---|---|---|
  | not JSON; JSON other than an object or `null` (`[]`, `"x"`); text after the object on the line; a member of the wrong JSON type: `"v":"1"`, `"v":1.0`, `"v":1e0`, `"op":5` | 3 | `malformed request` |
  | `null`, `{}`, `"v":null`, `v` missing | 4 | `the agent speaks protocol version 1, not 0` |
  | `"op":null` or `""` | 5 | `unknown request ""` |
  | `op` not known | 5 | `unknown request <op>`: the op cut to its first 32 characters, then Go-quoted (`%q`: `"…"`, with `\"`, `\\`, `\a`, `\uXXXX` … escapes), e.g. `unknown request "sté\a"` for `"sté\u0007"` |

  Every response, refusals included, carries `"v":1`. `status` and `stop` are answered in every state, also by an agent that has expired or is stopping but still accepts (its times are then clamped to 1); only `key` gets `expired`. Not normative: the byte form of status and refusal responses (member order, omitted empty members, Go's escaping of `<`, `>`, `&` as `\u003c`, `\u003e`, `\u0026`); clients decode them as JSON. The key response is exact (above).
- Client parsing: read one line ≤ 4096 bytes; decode `v` first (as an integer; absent = 0): ≠ 1 → ``agent: the running agent speaks protocol version <v>, this passh 1; kill it and run `passh unlock` again``. Then: `ok:false` with `expired` → "no agent"; `key_block_changed` → key block changed (also counts as "no agent"); `version` → `agent: <error>`; any other or no `code` → `agent: the agent refused the request: <error>` (empty if absent). A key response's `key` must be a JSON string whose bytes between the quotes, taken as they are (no unescaping), pass the key-text rule and parse as an X25519 identity (bech32 checksum); `ok:true` without `key`, or `key` not a string → `agent: the agent's answer holds no vault key`; otherwise invalid → `agent: the agent's answer holds no valid vault key: not a vault key` (or `… not a valid vault key`). The client checks nothing else: not that `vault` is its own real path, not that `pid` is alive; missing status members read as 0 (`pid 0`, `0s`). Not JSON, or `v` not an integer → `agent: malformed answer`; a line over 4096 bytes → `agent: reading the answer: message too large`; closed mid-line → `agent: reading the answer: connection closed in the middle of a message` (unless the socket path is gone: no agent, §A2.7).

### A2.6 Serving and expiry (MUST for the TTL rules)

- Each connection is served concurrently with a 5 s deadline; there is no limit on connections served at once (only the process's file limit: `accept` failing with EMFILE or ENFILE waits 50 ms and retries). Only a **served** key request (step 9 passed) sets `lastUse = now`; `status`, `stop` and refused requests don't count (§5.3).
- `elapsed(a, now) = max(monotonic difference, wall-clock difference)`: time while the machine sleeps counts. Expired when `elapsed(start) ≥ max_ttl` (checked first) or `elapsed(lastUse) ≥ idle_ttl`; `lastUse` starts at `start`.
- Main loop: check expiry; sleep until the earlier of 1 s and the next expiry (≥ 1 ms); on wake, `lstat` the socket path and exit if it is missing or its device/inode differ (removed or replaced). Also exit on a `stop` request, SIGTERM or SIGINT, or a fatal `accept` error (timeouts are retried at once; EMFILE, ENFILE, ECONNABORTED and EINTR after 50 ms).
- Shutdown, in order: mark stopping (later key requests get `expired`); remove the socket path only if it still has the recorded device/inode; close the listener; wait for connections in progress; overwrite the key with zeros; exit 0. The key is never written to disk.

### A2.7 Client calls

Every call opens its own connection; a client never starts an agent.

1. Real path of the vault (it must exist) and socket path (§A2.1).
2. Check the folder (§A2.2) without creating it: missing → **no agent**; failing → error `agent: <folder error>`.
3. Connect (deadline: the caller's, else 5 s). `ENOENT` or `ECONNREFUSED` → **no agent**.
4. The agent's peer uid must be the client's: else `agent: refusing the agent socket <path>: peer is uid <n>, not uid <m>`.
5. Write the request, read the response (§A2.5). `EOF`, `ECONNRESET` or `EPIPE` while the socket path no longer exists → **no agent** (it exited meanwhile); `EOF` otherwise → `agent: the agent closed the connection without answering`; timeouts → the deadline error.

### A2.8 Where the key comes from (spec §5.1)

CLI commands that need the key ask the agent of the vault (`key` with the key block of the file being opened); `verify --full <file>` asks the file's own agent, then the configured vault's (useful only for a copy with the same key block). The TUI does the same without these messages. Then:

| Agent outcome | What passh does |
|---|---|
| Key served and the data block decrypts | Use it |
| Key served, data block doesn't decrypt | "data is damaged" error of §4.5 (with the backup list); no passphrase fallback |
| No agent (no folder, no socket, refused, expired, exited) | Silently go on |
| `key_block_changed` | Note ``passh: the vault's key block isn't the one `passh unlock` opened (passwd elsewhere, or damaged): the agent's key isn't used; asking for the passphrase``, go on |
| Any other agent error (folder check, foreign peer, version, malformed, timeout) | Warn `passh: warning: can't use the agent of <file>: <error>` (`<file>`: `~/` form), go on |

An agent that accepts connections but doesn't answer (stopped with SIGSTOP, hung) costs every such command the 5 s deadline before the passphrase prompt (or `vault is locked`), with the warning `… can't use the agent of <file>: agent: reading the answer: context deadline exceeded`.

Going on: with a terminal, the passphrase prompt (`Passphrase: `, up to 3 attempts, `Wrong passphrase. Try again.` before each retry, all on `/dev/tty`); without one, ``vault is locked: run `passh unlock` in a terminal (over SSH: `ssh -t host passh unlock`)``, exit 1. `passwd` and `rekey` never use the agent (§5.4).

### A2.9 `passh lock` and stale agents

- `passh lock`: the config and the vault file must exist (the socket is named by its real path). Send `stop`, then wait until the socket path is gone (10 ms polling, ≤ 5 s; timeout → `agent: waiting for the agent (pid <n>) to exit: …`, exit 1). Prints `Locked: the agent (pid <n>) stopped.` (`<n>` from the `stop` answer) or `No agent is running for <file>.` (`<file>`: the vault path as configured, `~/` form, single-line escaped); both exit 0. An agent whose vault file was moved or deleted can't be reached and lives until its TTLs (a known issue: [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)).
- After `passwd` and `recover` (new key block) and `rekey` (new key), passh stops the vault's agent: ``The agent was unlocked with the old key block and was stopped; run `passh unlock` again if you need it.`` (`rekey`: `The agent held the old key and was stopped; …`). A failed stop only warns (``the agent couldn't be stopped: …; stop it with `passh lock` ``); the command still succeeds.
- `doctor` reports the folder (`doesn't exist yet`, OK, or the check error) and the agent (`not running` or its times), read-only.

## A3. TUI session (spec §5.2)

Specified in [tui.md](tui.md): unlocking at start ([§4.2](tui.md#42-unlock-sources)), the idle lock and what a lock does ([§10](tui.md#10-locking-52)), exit, signals and the wait for a pending clipboard clear on quit ([§1.2](tui.md#12-exit)). On the agent's side: the TUI takes the key as in §A2.8, never starts an agent, and with `session.stop_agent` sends `stop` at every lock, quitting included (so quitting the TUI also stops an agent started by `unlock`).

## A4. Terminal I/O (`/dev/tty`)

- All prompts read and write `/dev/tty` (opened read-write), never stdin/stdout. No `/dev/tty`, or not a terminal → "no terminal": callers fall back (§5.1) or need a flag (§7.1). Most commands that need one fail with ``<command> needs a terminal (over SSH: use `ssh -t`)``.
- **Secret prompts** (passphrase, masked lines, pairs) use raw mode (as cfmakeraw(3): echo, canonical mode, signal keys, output processing, CR/NL translation and flow control off; 8 bits; VMIN 1, VTIME 0). Order: raw mode, then prompt, then read, so type-ahead is never echoed. Output in raw mode writes `\r\n` for line breaks. On return the saved termios is restored and, if the cursor is still after a prompt, a `\n` is written.
- **Line editor** (raw prompts), byte by byte: CR or LF ends the line (an LF right after a CR that ended the previous line is skipped: CRLF pastes); `0x03` Ctrl-C → "interrupted"; `0x04` Ctrl-D on an empty line → end of input; `0x7F`/`0x08` delete the last UTF-8 character; `0x15` Ctrl-U clears; `0x17` Ctrl-W deletes trailing spaces and the last word; `ESC [` params (0x20–0x3F)* final (0x40–0x7E) and `ESC O` final are swallowed (arrow and function keys); ESC followed by anything else: the ESC is dropped; other bytes < 0x20 are ignored; more than the limit → `passphrase longer than 4096 bytes` (`input longer than …` for masked lines). Passphrases echo nothing. End of input (Ctrl-D on an empty line) at `Passphrase: ` or `Current passphrase: ` fails the command at once, without using further tries: `passh: reading the passphrase: EOF`; in a pair (`New passphrase: `/`Repeat passphrase: `, `Password (empty to generate): `/`Repeat password: `) it fails with `passh: EOF`; exit 1 (known issue: Go's bare `EOF` as the message, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)).
- **Masked lines** (paper key, prompt `> `): `*` per character, a space as a space; after Ctrl-U/W the line is redrawn as `\r` + last prompt line + masks + `ESC [K`; blank lines before the first character are ignored; the first blank line after it, or Ctrl-D, ends the input; result ≤ 64 KiB.
- **Pairs** (new passphrase, entry password): both prompts in one raw-mode stay. Empty first answer → say the "empty" text and ask again, or return empty when the caller allows it (`Password (empty to generate): `); an optional check (strength warning) is printed before the repetition; compared in constant time; mismatch → say it and restart; after 3 mismatches → `passphrases don't match` (`passwords don't match`). Texts: `New passphrase: `, `Repeat passphrase: `, `The passphrase must not be empty.`, `Passphrases don't match. Try again.`
- **Plain lines** (cooked mode, echo on): up to `\n`, a trailing `\r` dropped, ≤ 64 KiB; Ctrl-D on an empty line → end of input.
- **Yes/no:** prompt + ` [y/N] ` (` [Y/n] ` when the default is yes; the hint and the accepted words per language: [i18n.md §5](i18n.md#5-answers-and-typed-phrases)). Cooked line; the answer is trimmed and lower-cased; empty → default; anything not understood → `Please answer y or n.` and ask again; after 3 → `not confirmed`.
- **Typed phrases:** `Type <PHRASE> to confirm: `; the answer, trimmed of surrounding white space, must equal the phrase exactly (case-sensitive): `PRINT RECOVERY KEY`, `EXPORT PLAINTEXT`, `PRINT`. Else `not confirmed: you didn't type <PHRASE>` (`not confirmed: no answer` on end of input), exit 1.
- **Signals at a prompt:** SIGINT, SIGTERM and SIGHUP are caught while any prompt waits. On one, for a raw prompt: discard unread input (`TCIFLUSH`; macOS `TIOCFLUSH` with FREAD) while echo is still off, restore termios, end the prompt line, then interrupt the blocked read. Where a read can't be interrupted (macOS `/dev/tty`, or after the terminal was put in blocking mode by the TUI or an editor), stop catching and re-raise the signal, so the process dies by it with the terminal restored. The prompt fails with `interrupted (<signal name>)` → exit 128 + n. A signal that arrives just after the answer was complete still counts. Ctrl-C typed at a raw prompt → `interrupted` (exit 1); Ctrl-C at a cooked prompt is SIGINT (exit 130). The flush also runs when a raw prompt ends with Ctrl-C or an error, never after a normal answer.
- **Passphrase in the TUI** (lock screen, [tui.md §4.2](tui.md#42-unlock-sources)) is text, not bytes, so it differs from the raw prompt above: typed keys arrive as UTF-8 characters (a byte that isn't UTF-8 is dropped); keys with Ctrl or Alt, and TAB, insert nothing (at the raw prompt Alt-x sends `ESC x`, which gives `x`); a paste is inserted as it is, less one trailing line break, and refused if it holds a line break inside or isn't valid UTF-8, so a TAB or another control character in a paste is kept (the raw prompt drops bytes < 0x20); no 4096-byte limit. A passphrase of valid UTF-8 without control characters, at most 4096 bytes, typed or pasted, gives the same bytes in both; others may not open the vault in the other place (known issue, see [docs/reviews/2026-11-16-spec-audit.md](../reviews/2026-11-16-spec-audit.md)).
- **`GPG_TTY`** for `import pass` ([import-export.md §1.5](import-export.md#15-decrypting-with-gpg)): if `$GPG_TTY` is set and not empty, gpg inherits it unchanged (even a wrong value). Otherwise passh adds `GPG_TTY=<device>`: the device of `/dev/tty`, found as the `/proc/self/fd/<n>` link target when that names a device other than `/dev/tty`, else by the device number (`TIOCGDEV` on Linux, the process table's `e_tdev` on macOS) looked up among the character devices in `/dev/pts`, then `/dev` (never `/dev/tty` itself); without `/dev/tty`, or when its device isn't found, the device of the first of stdin, stderr, stdout that is a terminal (found the same way); with none, nothing is added.

## A5. Clipboard (spec §6.3, S6)

- **Method**, chosen once per command: `clipboard.command` if non-empty (its program must be found in `$PATH`, else an error, no fallback; an empty first element is a config error); else OSC 52 if `clipboard.osc52` and `/dev/tty` is a terminal; else `no clipboard: <reason>; copy with: passh show <path> --field <field> | pbcopy`, exit 1. Reasons: `clipboard.osc52 is off and clipboard.command is empty`, `OSC 52 needs a terminal and there is none, and clipboard.command is empty`. `<path>` and `<field>` are single-quoted for a POSIX shell unless they only hold `[A-Za-z0-9_\-./@%+=:,]`. `passh copy` chooses the method before unlocking, so a missing clipboard never asks for the passphrase.
- **OSC 52 bytes:** `ESC ] 5 2 ; c ; <base64> BEL` = `\x1b]52;c;` + standard base64 with padding, no line breaks, of the value's UTF-8 bytes + `\x07`. Written to `/dev/tty` in one `write`, never through stdout, without a tmux/screen passthrough wrapper. No length limit is applied (terminals may drop long payloads). Clearing writes `\x1b]52;c;\x07`.
- **Command:** started per S8 with the value on stdin (stdout and stderr to `/dev/null`, so a tool that forks a clipboard server doesn't hold a pipe), killed after 10 s; a non-zero exit is an error. Clearing runs the same command with empty stdin.
- **Schedule:** each copy schedules a clear at `now + clear_after`. A newer copy in the same process cancels the older schedule (an old timer never clears a newer value). A clear sends the empty value whatever the clipboard holds then: passh can't read it back, so a value the user copied elsewhere meanwhile is cleared too; another passh process's clear isn't coordinated. "Cleared" means the empty value was sent successfully; clipboard histories are out of reach.
- **`passh copy <path> [--field f]`:** default field `password`; unknown field → `<path> has no field "<f>"`; empty value → `<path>: the <f> is empty; nothing was copied` (exit 1). The vault is closed before waiting. SIGINT, SIGTERM and SIGHUP are caught from before the copy. Prints `Copied the <f> of <path> (<method>); the clipboard clears in <D>, Ctrl-C clears it now.`, waits, clears, prints `Clipboard cleared.`, exit 0. A signal clears at once and also exits 0. A failed clear → `clearing the clipboard failed: <cause>` (after an interruption: `interrupted (<why>), and clearing the clipboard failed: <cause>`), exit 1. The value is never printed.
- **Errors** (*informative*, the reference's internal structure): a failed clear is a `ClearError` whose text is its cause's and which matches "clearing the clipboard failed"; callers branch on that, never on text.
- **`doctor`:** copies `passh clipboard test`, waits min(`clear_after`, 5 s), clears; notes for tmux (`set -g set-clipboard on`), GNU screen (`$STY`) and Terminal.app (`TERM_PROGRAM=Apple_Terminal`).

## A6. External editor (`edit --editor`, spec §5.6, S1)

- **Temporary base** (Linux only; elsewhere none, so the built-in form is used with the note `no tmpfs for the temporary file (checked …): …; using the built-in form instead`; on macOS this holds even where a `tmpfs` is mounted, unlike the plaintext warning of `export` and `print`, which counts a macOS `tmpfs` as memory): `$XDG_RUNTIME_DIR` if absolute, a real directory (not a symlink) owned by the user, and on tmpfs or ramfs (`statfs` magic `0x01021994` / `0x858458f6`); else `/dev/shm` if a directory on tmpfs/ramfs. Nothing else.
- **Files:** a new folder `passh-edit-<random>` in the base (mode 0700, set explicitly; re-checked to be on tmpfs), holding `entry.txt` created with `O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600 (set explicitly), containing the entry's text form (§4.3).
- **Editor:** `$EDITOR` if it holds anything but white space, else `$VISUAL` likewise, else `vi`; split into words without a shell (§A7); the first word is looked up in `$PATH`. This happens before unlocking; a failure ends the command (exit 1) with `$EDITOR: <error>` (`$VISUAL: …`; no prefix for `vi`): `unterminated single quote in <value>`, `unterminated double quote in <value>`, `trailing backslash in <value>` (`<value>` Go-quoted), `the editor command is empty` (e.g. `EDITOR='""'`), or the lookup error, e.g. `exec: exec: "<word>": executable file not found in $PATH` (not normative: the lookup error's wording). Kind, from the base name of the resolved path's symlink target, then the resolved path, then the word: `nvim`/`nvim.*` → neovim; `vim`/`vim.*` → vim (so `vi` → `vim.basic` is vim; busybox `vi` is not); `nano` → nano.
- **argv** = `$EDITOR`'s remaining words + flags + (`--` for known kinds) + the absolute file path:

| Kind | Flags |
|---|---|
| vim | `-n -u NONE -i NONE -c "set nobackup nowritebackup noundofile noswapfile"` |
| neovim | `-n --clean -i NONE -c "set nobackup nowritebackup noundofile noswapfile"` |
| nano | `--ignorercfiles --nohelp` |
| other | none; warns first on the terminal: `passh can't control backup, swap or history files of <name>: they may keep a copy of the entry on disk. Graphical editors must also wait until the file is closed (e.g. code --wait).` |

The `-c` value is one argument.

- **Run:** stdin, stdout and stderr are `/dev/tty`; the environment is inherited. The terminal state is saved before and restored after.
- **Signals:** SIGINT, SIGTERM and SIGHUP are caught from before the folder exists until it is gone. A signal kills the editor (SIGKILL), and the edit fails with `editing interrupted by <signal>; nothing was changed` (exit 1). If the editor fails, passh waits 200 ms for a signal that may have caused it.
- **Result:** a non-zero exit (e.g. vim `:cq`) → `the editor failed (…); nothing was changed`; a file > 16 MiB → error; identical text, or an entry equal to the old one → `No change.`; invalid UTF-8 or text → `The entry isn't valid: <error>` and `Edit it again? [Y/n]` (yes reopens the editor on the user's text; no, or a failed prompt, drops it). Custom fields that are unchanged keep their unknown JSON keys.
- **Cleanup**, whatever happens: overwrite every regular file in the folder (the edit, and any swap or backup file) with zeros, `fsync`, then remove the folder; failure → `removing the temporary folder <dir>: …; remove it yourself, it holds the entry in plain text`. A `kill -9` leaves the folder; `doctor` lists the user's leftover `passh-edit-*` folders in both bases.

## A7. Process execution (S8)

- One module starts processes. Starts in v1: the agent (self), `clipboard.command`, the editor, `gpg` (`import pass`: `gpg --quiet --status-fd 3 --decrypt`, ciphertext on stdin, `GPG_TTY` set, results judged from fd 3 status lines and the exit status, see the import appendix).
- Always a program path plus an argument list; never a shell. A name without `/` is looked up in `$PATH`; a match found through a relative `$PATH` entry (such as `.`) is refused. Unset stdio is `/dev/null`. The environment is inherited, with explicit `KEY=value` additions (e.g. `GPG_TTY`) replacing inherited ones.
- `--` goes before the file path for the editors known to accept it (§A6); no other start passes a path (the agent takes `--vault=<path>` as one argument).
- **Word splitting** of `$EDITOR`: words split on unquoted space, tab and newline; `'…'` literal; `"…"` literal except `\"`, `\\`, `\$`, `` \` ``; outside quotes `\x` → `x`; adjacent parts join; `""` is an empty word; nothing is expanded (`$VAR`, `$(…)`, `~`, globs, `; | & < >` are plain characters); an unterminated quote or a trailing backslash is an error.

## A8. Hardening (S7)

- `RLIMIT_CORE` soft and hard = 0, as the first action of every passh process (failure: a warning, passh continues) and again in the agent before it reads the key (failure: the agent doesn't start). Children inherit it. No other process attribute is changed; nothing system-wide.

## A9. Safety rules: how they are met

| Rule | Mechanism |
|---|---|
| S1 | Vault, temporary file and backups are written only as age ciphertext (§4.6). `edit --editor`: §A6. The agent never writes the key. Exports and print `-o` are the user's explicit choice (§7.1). Not covered: swap, including tmpfs pages |
| S2 | Passphrase and paper key only from `/dev/tty` (§A4). Key to the agent only on its stdin pipe, to clients only over the socket (§A2). Clipboard value on the command's stdin. No flag, config key or environment variable takes a secret. Checkable in `/proc/<pid>/cmdline` and `environ` |
| S3 | `crypto/rand` bytes; alphabet size n (2–256 runes): accept byte b only if b < 256 − (256 mod n), then take `alphabet[b mod n]`; no forced character classes. Default 24 characters (1–4096) from `A–Z a–z 0–9`; `--symbols` adds the 32 ASCII punctuation characters (94) |
| S4 | Everything printed for a terminal (stdout listings, stderr, `/dev/tty`, TUI) is escaped: §A9.1 |
| S5 | Fixed 8-bullet mask; reveal hides after 10 s ([tui.md §6.3](tui.md#63-reveal-s5)) |
| S6 | §A5; a TUI lock clears a pending value at once ([tui.md §10.2](tui.md#102-what-a-lock-does)) |
| S7 | §A8 |
| S8 | §A7 |
| S9 | The recipient is derived only to encrypt the data block; the agent protocol carries the identity, never the recipient |

### A9.1 S4 escaping (MUST)

Two forms, applied to a string of bytes: **single-line** for one value or name, and **multi-line**, which is single-line except that LF (0x0A) and TAB (0x09) are kept as they are. Scan from the start; at each position:

1. A byte below 0x80 is kept, except 0x00–0x1F and 0x7F: TAB → `\t` and LF → `\n` (kept raw in multi-line), CR → `\r` (in both forms), any other → `\x` + two lower-case hex digits (`\x1b`, `\x00`, `\x7f`).
2. Otherwise one UTF-8 character is decoded. A byte that doesn't start a valid UTF-8 sequence (truncated, overlong, a surrogate U+D800–U+DFFF, above U+10FFFF) → `\x` + its hex for that one byte; decoding resumes at the next byte.
3. A decoded character is written `\u` + 4 lower-case hex digits (`\U` + 8 above U+FFFF) when it is U+0080–U+009F (C1 controls), U+2028, U+2029, or of general category Cf (U+00AD, U+061C, U+200B–U+200F, U+202A–U+202E, U+2060–U+2064, U+2066–U+206F, U+FEFF, U+E0001, U+E0020–U+E007F, …), with one exception: ZWNJ U+200C and ZWJ U+200D are kept when the character just before **and** the character just after them in the input are both visible non-ASCII. Visible non-ASCII: a valid character ≥ U+0080, not U+FFFD, of general category L, M, N or S. Not visible: the start or end of the string, an invalid byte, another joiner or Cf character, spaces, punctuation, every ASCII character.
4. Everything else is kept: printable ASCII and `\` itself, U+00A0 and other spaces, U+FFFD, private-use (Co) and unassigned (Cn) code points, noncharacters, combining marks anywhere (also first).

Categories come from the Unicode tables of the build (Go's `unicode` package; Unicode 17.0.0 for go1.27.4). The backslash is not escaped **on purpose**: `\x1b` typed in a value and an escaped ESC look the same; the output is for people, and `show --raw` (or `show --field` into a pipe) gives the exact bytes. Escaped text passed through either form again is unchanged. Print sheets escape more ([print.md §3.2](print.md)).

Test vectors (input in Go notation, output as printed; the multi-line form differs only in the first row, where it prints a real TAB and LF and `\r`):

| Input | Single-line output |
|---|---|
| `"a\tb\nc\rd"` | `a\tb\nc\rd` |
| `"\x1b[31mred"`, `"x\x7fy\x00z"`, `"\xff\xc3("` | `\x1b[31mred`, `x\x7fy\x00z`, `\xff\xc3(` |
| `"a\u009bb"`, `"so\u00adft"`, `"\ufeffbom"`, `"l\u2028p"`, `"\u202eevil"`, `"tag\U000E0041"` | `a\u009bb`, `so\u00adft`, `\ufeffbom`, `l\u2028p`, `\u202eevil`, `tag\U000e0041` |
| `"👨\u200d👩"`, `"क\u200dष"`, `"©\u200d®"`, `"\u0301\u200dé"`, `"é\u200d١"` | unchanged (joiner kept) |
| `"a\u200d👩"`, `"\u200d👩"`, `"👩\u200d"`, `"«\u200dé"`, `"é\u200d1"` | `a\u200d👩`, `\u200d👩`, `👩\u200d`, `«\u200dé`, `é\u200d1` |
| `"क\u200d\u200dष"`, `"\u200b\u200d👩"`, `"\xff\u200d👩"`, `"\ufffd\u200d👩"` | `क\u200d\u200dष`, `\u200b\u200d👩`, `\xff\u200d👩`, `�\u200d👩` |
| `"\u0301x\u00a0\ufffd\ue000\u0378\uffff"`, `` `C:\x1b` `` (a backslash) | unchanged |

Where each form is used (CLI; the TUI escapes each value single-line, [tui.md](tui.md)):

| Output | Form |
|---|---|
| stdout of `ls` (header, names, bare path), `find` (paths, tags), `tags` (names; the padding counts the escaped text), `verify` (file, `vault_id`), `backup` and `backups` (files), the `import pass` report (store, paths, file names, details) | single-line, each value |
| stdout of `show` (the whole text form) and of `show --field` on a terminal (the value, then `\n`) | multi-line |
| stdout of `doctor` | multi-line, each message |
| stderr (status lines, notes, warnings, errors: the whole text after the `passh: …` prefix) and messages on `/dev/tty` | multi-line, the whole message; values and entry paths in it are escaped single-line first. File paths (`<abs>`, OS errors) are not, so a LF or TAB in a file name reaches stderr raw |
| `show --raw`; `show --field` when stdout isn't a terminal; `export` data | none: exact bytes |
| print sheets and the print page | [print.md](print.md) |
