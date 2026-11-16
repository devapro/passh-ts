# passh-ts — passh in TypeScript on Bun, built from the specification alone

passh-ts is a clean-room re-implementation of **passh**, the single-binary password manager
specified in `spec/`. It is written in TypeScript and compiled with `bun build --compile`. The
original Go source was never read; the reference build `reference/passh-go` (0.1.0-ref) was only
**run**, as a black box, to check interoperability. The experiment had two goals: see what a
TypeScript implementation looks like, and test whether the specification is enough to build a
compatible implementation. The second goal is answered in [SPEC-GAPS.md](SPEC-GAPS.md).

## Status per priority

| Priority | Scope | Status |
|---|---|---|
| 1. Core compatibility | vault file, container, keys, data JSON, backups, rollback record, config, every v1 command, agent protocol, exports, import from pass, doctor, text sheet, English output | **Done.** The vault format, agent protocol and exports work in both directions with the reference. stdout, stderr and exit statuses match it side by side for every command and its error paths. |
| 2. TUI | spec §6.2, tui.md | **Done.** It has every screen and key, the lock screen, the idle lock, reload and the rollback question. The built-in form is used by `passh edit`. Its screens match the reference cell for cell. |
| 3. Print page, ru/sr | spec §7.4, print.md, i18n.md | **Done.** The HTTPS print page (TLS 1.3, self-signed P-256, single-use token, CSP) matches the reference's bytes. ru and sr catalogues hold 909 messages each, and the normative sheet-frame strings are byte-identical. |

Not done or not verified:
- **macOS.** Every FFI path has a macOS variant, but none is tested: termios, `select` on `/dev/tty`, `renamex_np`, `getpeereid`, `statfs`, `getifaddrs`, `sysctl vm.swapusage`.
- **`linux/arm/v7`** (spec §2 G1). Bun has no 32-bit ARM target.
- **Static binaries.** Bun executables link dynamically against glibc. Bun's musl targets exist but weren't tried.
- **Print page on a real LAN.** It is tested against the reference on a docker bridge address and by hand; the TUI's print dialog was not compared with the reference.
- **Untested side by side.** `edit --editor` on a machine without tmpfs, the busy save lock seen from the CLI, death by SIGPIPE.
- **`merge` and TOTP** are v1.1 and out of scope, as in the reference.

## Architecture and module map

`src/main.ts` first disables core dumps (S7). It then dispatches the hidden `__agent` child
before any config is read. Otherwise it picks the language from the config (i18n.md §2) and runs
the command line. Dependencies point down: `cli`/`tui` → `vault`/`agent`/`importpass`/`export`/
`print`/`printweb` → `keys`/`vaultfile`/`model`/`entrytext`/`paths`/`sanitize`/… → `age`, `fsx`,
`ffi`, `i18n`, `util`. Modules below the CLI write through a `CommandIO` interface, never to the
process streams.

| Module | Spec | Lines (prod / tests) | What it does |
|---|---|---|---|
| `src/age` | age v1 (C2SP) | 1389 / 524 | Our own age: header grammar, scrypt and X25519 stanzas, STREAM, armor, bech32, and hybrid ML-KEM-768+X25519 (`age1pq1…`) recipients for `export --age` |
| `src/keys` | vault-format §3 | 541 / 390 | Vault key; key block (2^18, an excessive work factor refused before scrypt); data block; paper recovery key; passphrase strength (zxcvbn) |
| `src/vaultfile` | vault-format §2 | 449 / 397 | Lenient container parse with every message, canonical writer, block checks |
| `src/model` | vault-format §4 | 1629 / 744 | Byte-level JSON reader that keeps unknown members as raw JSON; the exact serializer; validation; the data operations of §4.7 |
| `src/entrytext` | vault-format §5 | 195 / 159 | The pass-style text form and its import variant |
| `src/paths` | vault-format §6 | 365 / 208 | Path, folder and tag rules; segment order; the `ls` tree |
| `src/sanitize` | §A9.1, print §3.2 | 168 / 116 | S4 escaping, display widths |
| `src/fuzzy` | cli.md "Fuzzy matching" | 203 / 109 | sahilm/fuzzy's scoring, and the `find` and TUI rankings |
| `src/gen` | import-export §3 | 97 / 128 | Generator with rejection sampling (chi-square tested) |
| `src/util` | — | 768 / 179 | Go durations; Unicode 15.0.0 tables (categories, simple case folding, White_Space, width); CommandIO |
| `src/i18n` | i18n.md | 2774 / 419 | Go `Sprintf` verbs, CLDR plurals, errors rendered at exit, yes/no words; ru and sr catalogues (about 2300 of these lines) |
| `src/config` | storage §0–§2 | 1954 / 1062 | Our own TOML 1.1 parser, the config rules, real paths, socket paths, language choice |
| `src/fsx`, `src/ffi/libc.ts` | storage §1.4 | 1008 + part of 721 / 589 | flock locks, temp files, leftovers, RENAME_EXCHANGE/NOREPLACE, fsync, Go-style OS error texts, peer credentials |
| `src/ffi/termios.ts`, `src/tty` | §A4 | part of 721 + 1111 / 556 | /dev/tty prompts in raw and cooked mode, with signal handling |
| `src/exec` | §A7 | 624 / 223 | The only process starter (S8), PATH lookup, `$EDITOR` words, real fd-3 pipes |
| `src/clipboard`, `src/editor` | §A5, §A6 | 338 + 507 / 646 | OSC 52, `clipboard.command`, timed clears; `edit --editor` on tmpfs |
| `src/harden` | §A8 | 29 / 32 | RLIMIT_CORE |
| `src/vault` | storage §3–§7 | 2658 / 1786 | Open, save (lock, change check, read-back, backup, exchange), backups, rollback record, verify/backup/backups |
| `src/agent` | §A2 | 2240 / 1418 | Agent child, protocol v1, client, key sources, unlock/lock |
| `src/importpass`, `src/export` | import-export §1–§2 | 952 + 579 / 1397 | `import pass` (os.Root-like walk, gpg), json/csv/bitwarden-json, `--age` |
| `src/print`, `src/printweb`, `src/qr` | print.md | 1420 + 1803 + 562 / 1231 | Text and recovery sheets; HTTPS print page with our own DER/X.509 writer and HTTP/1.1; QR encoder |
| `src/tui` | tui.md | 5903 / 2760 | Hand-written model/update/view runtime, every screen, the entry form |
| `src/cli` | cli.md | 3478 / 437 | cobra/pflag work-alike, help texts, every command, doctor, the real TUI backend |

## Libraries and why

| Need | Choice | Why |
|---|---|---|
| ChaCha20-Poly1305 | `@noble/ciphers` | Bun's `node:crypto` doesn't have it |
| X25519, ML-KEM-768 | `@noble/curves`, `@noble/post-quantum` | Audited, pure JS, small. Our hybrid recipient reproduces the C2SP vector and decrypts with stock age 1.3.2 |
| scrypt, HKDF, HMAC, SHA-256, ECDSA | `node:crypto` (native in Bun) | scrypt at 2^18 takes 0.5–0.6 s natively; a pure-JS scrypt would be several times slower |
| Passphrase strength | `zxcvbn` 4.4.2 (lazy-loaded) | The original estimator; trustelem/zxcvbn is a port of it. It matched the reference on 36 probed passphrases and adds about 0.8 MB |
| age format | **own code** instead of `age-encryption` (typage) | The spec fixes the header grammar, the error per failure and "work factor refused before scrypt"; owning the parser made those exact |
| TOML | **own TOML 1.1 parser** (`smol-toml` was tried and dropped: it loses key order and line numbers) | The spec needs TOML 1.1 syntax, unknown keys in file order and line numbers |
| CLI parsing | **own cobra/pflag work-alike** | Exact pflag semantics and error texts (68 argv cases identical) |
| TUI | **own Elm-style runtime** (no Ink or blessed) | tui.md fixes layout cell by cell; owning the renderer let screens match the reference exactly, with no React-sized dependency |
| QR | **own encoder** | Byte-identical QR codes need skip2/go-qrcode's segment mixing and mask penalty |
| X.509, HTTP | **own DER writer, own HTTP/1.1 over `node:tls`** | `node:crypto` has no certificate builder; the peer must be checked before TLS; Go's exact response bytes |
| OS calls | `bun:ffi` to libc | flock, renameat2, termios, poll, SO_PEERCRED, statfs, getifaddrs, setrlimit, pipe2 |

Runtime dependencies: 5 npm packages (4 × `@noble/*`, `zxcvbn`). Everything else is ours.

## Interop results (passh-ts vs passh-go 0.1.0-ref, run as a black box)

Every row compares both binaries in isolated temporary homes. "Identical" means stdout, stderr and
exit status are byte-identical; only values that must differ are normalized (pids, times,
generated passwords, temporary paths).

| Check | Result |
|---|---|
| A vault made by passh-go opens in passh-ts; our canonical re-encoding is byte-identical to its file | pass |
| A vault made by passh-ts opens in passh-go (`verify --full`, `show`, `ls`, `recover` with our paper key) | pass |
| Alternating saves by both on one vault: revisions, one shared backups folder in seq order, `backups` output identical | pass |
| Data JSON written by passh-ts is byte-identical to passh-go's plaintext, unknown keys at all levels included; damaged-data details identical (18 cases) | pass |
| `verify` / `verify --full` on good, non-canonical, damaged, truncated and older copies | pass |
| `backup` output and the copies' SHA-256 | pass |
| `revisions.json` written by one and read by the other; rollback warning and `y` in both directions | pass |
| Config files: about 90 variants (unknown keys, types, durations, several problems, TOML 1.1) give the same stderr and exit status; the `init` config text is byte-identical | pass (TOML syntax error wording differs; it isn't normative) |
| Command line: 68 argv cases (help, usage errors, flag errors) | pass |
| Entry and key commands: `init ls find show copy add edit generate mv rm tag tags passwd rekey recover`, 108 side-by-side tests | pass |
| `unlock lock verify backup backups import export print recovery-key doctor`, 119 side-by-side tests | pass |
| Our client with passh-go's agent; passh-go's client (`ls`, `show`, `unlock`, `lock`, `passwd`) with our agent | pass |
| The same ~60 malformed requests to both agents give the same answers | pass |
| Exports `json`, `csv` (incl. `--spreadsheet-safe`) and `bitwarden-json` byte-identical; `--age` output (X25519 and `age1pq1…`) decrypts with stock age | pass |
| `import pass` of a real gpg store (about 35 tricky items): reports and resulting data identical | pass |
| Text sheet and recovery sheet byte-identical (en; ru/sr password sheets too) | pass |
| Print page on a docker bridge address: dialog, terminal QR codes, headers, HTML, chunk sizes, error responses, QR SVG | pass |
| TUI screens identical cell for cell at 80×24, 120×40, 40×20 and 60×16 (40+ states); real-backend TUI on the same vault (7 states) | pass |
| Prompts: passphrase, pairs, masked key, cooked lines, yes/no, typed phrases, Ctrl-C/Ctrl-D/SIGTERM/SIGHUP give the same bytes and statuses | pass |
| Stock age 1.3.2 runs the §8 recovery commands (passphrase and paper key, LF and CRLF) on vaults from both implementations | pass |
| End to end with the compiled binary (`test/interop/e2e.test.ts`, 7 tests) | pass |

**Intentional differences.** Where the spec audit proposes a fix, passh-ts implements it: #1, #3,
#4, #6, #7, #8, #9, #17, #18, #19, #26, #31, #32, #33, #39. The appendices allow this; each is listed
in SPEC-GAPS.md. Two minor message differences remain: the `backup` destination-folder error and
TOML syntax-error wording. Black-box testing also found a reference crash: `passh recover` panics
on a 65535-byte line.

**Test counts** (final run, all green): unit `bun test src` 1353 pass / 0 fail (62 files); side-by-side CLI `bun test test/cli` 295 pass / 0 fail (12 files, 687 s); interop `bun test test/interop` 323 pass / 0 fail (10 files, 237 s). Total 1 971 tests.

## Binary size and startup

| | passh-ts | passh-go |
|---|---|---|
| linux/amd64 binary | 92.8 MiB | 16.1 MiB |
| linux/arm64 | 92.4 MiB | — |
| darwin/amd64, darwin/arm64 | 81.3 MiB, 73.9 MiB | — |
| linux/arm/v7 | not possible (no Bun target) | — |
| `--version` (mean of 100 runs) | 30.5 ms | 28.4 ms |
| `--help` | 32.0 ms | 24.8 ms |
| `ls` failing on a missing config | 37.0 ms | 26.8 ms |
| Max RSS, `--help` | 42 MB | 23.5 MB |
| `ls` with the passphrase (scrypt 2^18, through a PTY) | 0.89 s | 1.09 s |

The size is the embedded Bun runtime: an empty program compiles to about 87 MiB. Startup depends on
`--bytecode`: without it, evaluating the bundle (215 modules) takes about 70 ms; with precompiled
bytecode it takes about 30 ms, close to Go, for about 5 MB more. scrypt runs natively in Bun, so
unlocking is as fast as Go's.

## Lines of code

| | Lines |
|---|---|
| Production TypeScript (`src`, without tests) | 34 567 (includes about 2 300 lines of ru/sr catalogues and a 13 KB generated Unicode table) |
| Unit tests and test drivers (`src/**/*.test.ts`, `testdata`) | 15 510 |
| Black-box CLI and interop suites, helpers (`test/`) | 7 602 |
| Scripts (build, i18n key extractor, Unicode table generator) | 1 178 |

## TypeScript and Bun: what was hard

- **Bytes versus strings.** The spec is written in bytes (UTF-8, invalid sequences, NFC). JS strings are UTF-16 and can hold lone surrogates, so every length, escape and comparison had to be byte-aware. Non-UTF-8 file names can't be represented faithfully. JS engines ship newer Unicode tables than the spec's 15.0.0, so we generated our own tables for categories, case folding, White_Space and East Asian Width.
- **Emulating Go's standard library.** Many "non-normative" texts reach the user: encoding/json errors, `%q` quoting, `time.ParseDuration`, strconv, encoding/csv, os/exec, net/http responses and chunking, the `flag` package, os.Root's 8-link limit, and Go's `%.1f` rounding. Matching the reference byte for byte meant re-creating them; SPEC-GAPS lists each one.
- **The terminal.** A blocking `readSync` on `/dev/tty` keeps JS signal handlers from running, so prompts couldn't honour §A4's signal rules. Prompts instead poll the fd through FFI and read one byte at a time, which keeps handlers responsive. termios structs differ between Linux and macOS (4- vs 8-byte flags).
- **Processes and sockets.**
  - Bun's `"pipe"` stdio slots are socketpairs, so the agent's fd-3 readiness pipe and gpg's `--status-fd 3` use `pipe2` through FFI.
  - `Bun.listen({unix})` unlinks the socket path when the listener stops, even if another agent's socket has replaced it. The agent therefore binds a temporary name and renames it into place.
  - Peer credentials need a socket's fd: `.fd` is present at run time but not documented.
- **TLS and X.509.**
  - `node:crypto` can't build certificates, so we wrote a DER writer.
  - The peer address must be checked before TLS starts: the server accepts paused TCP sockets and wraps them in `TLSSocket`.
  - Matching Go's HTTP response bytes needed our own small HTTP/1.1.
- **FFI ergonomics.** errno has to be read through `__errno_location()` / `__error()` right after each call. Struct layouts are hand-written per OS and untested on macOS. Variadic `ioctl` on darwin-arm64 needs a stack-slot trick.
- **Secrets in memory.** JS strings are immutable and garbage-collected, so key text that briefly exists as a string can't be wiped. Key material is kept in `Uint8Array`s and wiped wherever possible; a few parse steps still create strings.
- **Binary.** The binary is 74–93 MB and dynamically linked to glibc, so it isn't static. There is no 32-bit ARM build. Startup is acceptable only with `--bytecode`.
- **What went well.** Bun's PTY support (`Bun.spawn({terminal})`) made the side-by-side tests practical. `bun:ffi` reached every libc call we needed, inside the compiled binary too. scrypt is native and fast. `bun test` ran about 1 970 tests across unit, PTY and interop suites without a test framework dependency.

## Assessment: TypeScript + Bun versus Go for passh

**It works.** A compatible implementation was possible: the vault files, the agent protocol, the
exports and every command's output interoperate with the Go reference in both directions. Bun
covered every OS need through FFI. Performance where it matters (scrypt, encryption of large
vaults, startup with bytecode) is on par with Go.

**Go fits the project better.** passh's design leans on what Go gives for free:
- a static, roughly 16 MB binary for five targets, including 32-bit ARM for a Raspberry Pi;
- syscalls (`flock`, `renameat2`, termios, `SO_PEERCRED`) in the standard library rather than hand-written FFI structs per OS;
- `crypto/tls` and `x509` that can build certificates;
- one `[]byte` model of text;
- error texts that the spec, written against the Go implementation, often matches literally.

In TypeScript about a third of the effort went into re-creating Go's library behaviour and system
plumbing rather than passh's logic. The result is a 74–93 MB binary that needs glibc and can't run
on the Pi Zero/armv7 machines the spec targets.

**TypeScript was good at:**
- the data-heavy parts: JSON with unknown members, text forms, ranking, the TUI's pure update/view functions, the sheet layout;
- tests, where Bun's PTY support and fast test runner shone.

**Conclusion.** For a security tool that must be a small, static, multi-arch binary with no
runtime, Go remains the better choice. TypeScript/Bun is viable for a desktop-only (x64/arm64)
build where binary size doesn't matter.

## How to build and test

```bash
bun install
bun run build             # dist/passh-{linux,darwin}-{amd64,arm64} (bytecode)
bun run build:host        # dist/passh
bun test src              # unit tests (~1350)
bun test test/cli         # side-by-side CLI tests vs reference/passh-go (slow: PTYs, scrypt)
bun test test/interop     # interop suites, incl. test/interop/e2e.test.ts on dist/passh
bun run scripts/i18n-keys.ts --missing ru   # untranslated messages
```

Tests run in isolated temporary homes (`test/helpers/env.ts`). The stock-age tests use
`tmp/age/age` (age v1.3.2) and skip without it.
