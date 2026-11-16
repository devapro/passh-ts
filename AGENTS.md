# AGENTS.md — passh-ts (TypeScript/Bun implementation of passh)

Read this first. The specification in `spec/` is the only source of truth: `spec/spec.md` (read §1.1 on precedence), the normative appendices `spec/docs/spec/*.md`, `spec/EXAMPLES.md`, `spec/docs/translations.md`, `spec/docs/reviews/2026-11-16-spec-audit.md` (known issues: reproduce current behaviour or implement the proposed fix, and say which).

## Hard rules

1. **Clean room.** Never read, list or grep anything under `/home/auser/Projects/passh` (the original Go source), and never fetch the original source from the internet (e.g. GitHub `devapro/passh`). Library docs on the web are fine. The reference binary `reference/passh-go` (`--version` → `0.1.0-ref`) may only be *run* as a black box (no disassembly, no `strings`).
2. **Isolation.** Tests and manual runs never touch the real user's files. Use `test/helpers/env.ts` (`isolatedEnv()`), which points HOME, XDG_*, TMPDIR, PASSH_CONFIG, PASSWORD_STORE_DIR, GNUPGHOME at a fresh folder under `tmp/`. Never use the real `~/.config/passh`, `~/.local/state/passh`, `~/.password-store`, `~/.gnupg`; never start an agent for a real vault; stop every agent you start (`passh lock`, or kill it) and remove your sockets. Put scratch files under `tmp/`.
3. Install nothing outside this folder; no sudo, no global installs. To add an npm dependency: `flock tmp/.bun-add.lock bun add <pkg>` (serializes concurrent agents), and mention it in your report.
4. Safety rules S1–S9 of spec §5.5 apply to the code (no plaintext on persistent disk, secrets never in argv/env, crypto-secure randomness with rejection sampling, terminal escaping, …).
5. **Edit only the files you own** (your brief lists them). Read anything else in this repo. Don't run `git commit`, `git add -A`, `git stash` or anything that changes git state: the lead commits.

## Toolchain

- Bun 1.4.3 (`bun`), TypeScript 7 (`bunx tsc --noEmit -p .` must stay clean for your files).
- Tests: `bun test src/<module>` (unit tests next to the code as `*.test.ts`), `bun test test/interop` (side-by-side with the reference), `bun test test/cli` (black-box CLI).
- Run passh from source: `bun run src/main.ts …` (once the CLI exists); compiled: `bun run build:host` → `dist/passh`.
- PTY for tests: `test/helpers/pty.ts` (`spawnPty`, expect-like, uses `Bun.spawn({terminal})`, the child gets a controlling terminal so `/dev/tty` works). Without a terminal: `run()` from `test/helpers/env.ts` (wraps in `setsid -w`, so `/dev/tty` can't be opened). Driving a passh binary's prompts: `test/helpers/passh.ts` (`initVault`, `withPassphrase`); they work for the reference and ours.
- scrypt 2^18 costs ~0.6 s natively (`node:crypto.scryptSync`, fine); `node:crypto` in Bun has **no** chacha20-poly1305: use `@noble/ciphers`. X25519: `@noble/curves` (or node:crypto). Installed: `@noble/{curves,ciphers,hashes,post-quantum}`, `smol-toml`.
- Native OS calls: `bun:ffi` `dlopen("libc.so.6")` (Linux) / `libc.dylib` (macOS) — works inside `bun build --compile` binaries. Real fds from `node:fs` `openSync` are OS fds.

## Layout and ownership

```
src/main.ts            entry: harden (S7), choose language, run the CLI           (lead)
src/errors.ts          UsageError (exit 2), SignalError (128+n), SilentExit        (lead)
src/i18n/              T/TN/TC, errorf, PasshError, renderError, sprintf (Go verbs), goQuote, yes/no (lead; catalogs ru/sr later)
src/util/duration.ts   Go ParseDuration / Duration.String, short <D> form           (lead)
src/model/types.ts     Entry, Field, Tombstone, VaultData, Time, Unknowns           (data agent; shape fixed)
src/age/ src/keys/ src/vaultfile/                                                    crypto agent
src/model/ src/entrytext/ src/paths/ src/sanitize/ src/gen/ src/fuzzy/ src/util/unicode.ts   data agent
src/ffi/ src/harden/ src/tty/ src/exec/ src/clipboard/ src/editor/ src/config/ src/fsx/       platform agent
src/vault/             open, save, backups, verify, rollback record                 storage agent (phase 2)
src/agent/             agent server (__agent), client, unlock/lock core             agent agent (phase 2)
src/importpass/ src/export/                                                          import/export agent (phase 2)
src/print/ src/printweb/ src/qr/                                                     print agent
src/tui/               TUI framework, screens, built-in entry form                  TUI agent
src/cli/               command parser (cobra-like), commands, doctor, output        CLI (phase 3)
test/helpers/          shared test helpers                                           (lead; ask before changing)
test/interop/          side-by-side suites (one file per area, named by owner)
```

## Conventions

- **Messages and i18n** (`src/i18n/index.ts`): every text for people goes through `T(fmt, ...args)` (Go `fmt.Sprintf` verbs: `%s %d %q %v %x %[2]s`, `%w` = `%v`). The English text is the catalogue key, so write the exact English text of the spec. Plurals: `TN(n, one, other, ...args)`. Errors: `throw errorf("%s: not found", path)` (a `PasshError`: English `.message`, localized `.localize()`); `codedError("changed", fmt, …)` + `hasCode(e, "changed")` for matching (like Go sentinels); `%w` sets `cause`. Never build the user-visible English text of an error by string concatenation outside `errorf`, or it can't be translated. Data on stdout is never translated.
- **Exit statuses** (cli.md §1.4): `UsageError` → 2, `SignalError(sig)` → 128+n, `SilentExit(n)`; any other error → 1. The CLI prints `passh: <renderError(e)>` once at exit (escaped with S4 multi-line form).
- **Streams**: stdout only for data; status lines, notes (`passh: …`), warnings (`passh: warning: …`) and errors on stderr; prompts and their texts on `/dev/tty` only.
- **Bytes vs strings**: the spec talks about bytes (UTF-8). JS strings are UTF-16: be careful with lengths (`Buffer.byteLength`/`TextEncoder`), invalid UTF-8 (decode with replacement only where the spec allows), surrogates, NFC (`String.prototype.normalize("NFC")`). Unicode categories: regex `\p{L}` etc. with the `u` flag.
- **Times** in the data model are whole Unix seconds (`Time`), revisions are `bigint`, Go durations are `bigint` nanoseconds (`src/util/duration.ts`).
- **No shell, ever** in product code (S8): processes start only through `src/exec/`.
- Comments cite the spec section they implement (`// storage.md §4.2 step 5`). Keep modules small and dependencies pointing down (cli/tui → vault/agent/… → model/keys/… → i18n/util). Leaves don't import `cli` or `tui`.
- Each module has unit tests that use the spec's test vectors. Interop with the reference binary is the acceptance bar: byte-identical stdout/exports, same exit statuses, files each implementation opens.
- When the spec is silent, ambiguous or contradictory: decide, leave a `// SPEC-GAP:` comment, and list it in your final report (section, what you decided). The lead collects them into SPEC-GAPS.md.
