# Translations

passh speaks English (`en`, the default), Russian (`ru`) and Serbian in Latin script (`sr`), chosen by the `language` key of the config file (spec §3.3). This guide says how to write a message so it can be translated, how to translate it, and how the tests check both. The code is in `internal/i18n`; its package comment is the short version of this page.

## What is translated and what is not

Translated: everything passh writes **for people**: status lines and confirmations, warnings, notes, hints, prompts and their explanations, error messages, `--help` (cobra's headings and flag texts included), the TUI, `doctor`, the text sheet, the recovery key sheet and the print page.

The same in every language:

- **data on stdout** that scripts or passh read: `ls`, `find`, `tags`, `show` and the entry text form, `export`, `generate`'s password, the `backups` listing, `--version`;
- **names**: commands, flags, entry fields (`password`, `username`, `url`, `tags`, `notes`, custom field keys), config keys and values, file names, cobra `Use` lines (`passh init [--vault file]`), placeholders in command lines (`<path>`, `[command]`, `<copy>`);
- **typed confirmation phrases**: `PRINT RECOVERY KEY`, `EXPORT PLAINTEXT`, `PRINT` (`tty.Phrase*`). The y/n answers of yes/no questions stay accepted in every language (see [Answers](#answers));
- **exit statuses**;
- values from the vault or an import, `age1…`, `AGE-SECRET-KEY-1…`, SHA-256 fingerprints, dates (`2026-11-15 14:03`), Go durations (`30s`, `1h30m`), revisions (`r42`);
- text from the operating system or a library (`open /x: permission denied`) may stay English.

A report for people that goes to stdout (`doctor`, the prose of `verify`, the import report) is translated, except the names in it. When it is unclear whether a line is data or a message, ask the owner rather than guess.

Without a config file (`--vault` alone, before `passh init`) and when the config file doesn't load, passh speaks English: the config's problem is reported in English.

## The pieces

```go
type Lang uint8                      // i18n.En (zero), i18n.Ru, i18n.Sr
func Parse(s string) (Lang, error)   // "en", "ru", "sr" exactly
func Langs() []Lang

type Printer struct{ … }             // zero value: English; a small value, pass it down
func New(l Lang) Printer
func (p Printer) Lang() Lang
func (p Printer) T(msg string, args ...any) string
func (p Printer) TC(context, msg string, args ...any) string
func (p Printer) N(n int, one, other string, args ...any) string
func (p Printer) Error(err error) string

type Localizer interface{ Localize(p Printer) string }

func NewError(msg string) error                // a sentinel, like errors.New
func Errorf(format string, args ...any) error  // fmt.Errorf, translatable
type Message struct{ … }                       // text whose translation waits for a Printer
func Msg(format string, args ...any) Message
func Raw(text string) Message                  // never translated: data, OS text
func Mark(msg string) string                   // marks a key kept in a string
```

The English text is the key. A `Printer` looks it up in its language's catalog and falls back to English. With arguments, the text is formatted with `fmt.Sprintf`; arguments that are errors are rendered with `Printer.Error`, and arguments that implement `Localizer` with `Localize`, so they come out translated too. **Pass values, not their `.String()`**: a type that describes itself (a print page `Result`, a clipboard `Method`, a lock `Reason`) translates itself once it has a `Localize` method.

Without arguments a message is plain text, never a format: a `%` in it would be printed as is, so the tests reject one there (write "percent", or pass the number as an argument). `Errorf` is the exception: like `fmt.Errorf` it always formats, and `%%` is a percent sign.

## Where the Printer is

Only packages that talk to people hold a Printer; core packages make translatable errors and messages instead.

| Package | Printer | How it gets it |
|---|---|---|
| `internal/cli` | `a.p`, and `a.T(…)` = `a.p.T(…)` | `cli.Main` chooses the language before the cobra tree is built (`language.go`) |
| `cmd/passh` | — | `main` passes the core-dump error to `cli.Main(args, warnings...)`, which prints it |
| `internal/tui` | `m.d.p` (`deps.p`) | `tui.Options.Printer` |
| `internal/editor` | `f.opts.Printer` | `editor.FormOptions.Printer` (form and `editor.Run`) |
| `internal/tty` | `t.p` | `(*TTY).SetPrinter`; `cli` sets it when it opens the terminal |
| `internal/print` | `s.p` (Sheet), `r.p` (RecoverySheet), `doc.printer()` in `WriteTXT` | `print.Options.Printer`, `NewRecoverySheet(…, p)` |
| `internal/printweb` | `s.p` (Server), `renderPage(w, doc, p)` | `printweb.Options.Printer` |
| `internal/vault`, `keys`, `config`, `agent`, `model`, `paths`, `vaultfile`, `exec`, `gen`, `entrytext`, `export`, `importpass`, `clipboard`, `session`, `harden` | none | errors (`NewError`, `Errorf`, `Localize`), `Message` values, `Mark` |

Hand-offs between packages that carry text:

- `vault.Options.Warn func(i18n.Message)` and `vault.Options.Prompt func(i18n.Message) (bool, error)`: the vault's warnings and the rollback question; `cli` and `tui` render them with `Localize`.
- `vault.RollbackStatus.Localize`, `keys.Strength.Localize`, `printweb.Result.Localize`: descriptions with a `Localize` method next to their English `Message`/`String`.
- `printweb.Server.CertNotice` and `Skipped` are rendered by printweb in `Options.Printer`'s language.
- `clipboard.NoClipboardError.Reason`, `clipboard.EnvironmentNotes`: English keys written with `i18n.Mark`, shown with `p.T(reason) // i18n:dynamic`.
- An answer read from the agent's socket is text only: the agent writes it with `i18n.Mark`, and `Printer.Error` translates an error whose whole text is a catalog key.

`TODO(i18n)` marks the stubs left for the translators (`grep -rn 'TODO(i18n)' internal`); `i18n.Raw` marks English passed on untranslated until then (`grep -rn 'i18n.Raw(' internal`). Both lists are empty when an area is done, except `Raw` for real data.

## Writing messages

### A sentence

```go
a.statusf("Saved %s.", displayPath(p))                 // cli, once statusf is an i18n:wrapper
termf(t, "%s", a.T("Choose a passphrase: …\n"))         // a.T anywhere in cli
b.WriteString(m.d.p.T("Locked."))                       // tui
help := t.p.T("Please answer y or n.\n")                 // tty
```

Write each message whole, as one call: never build a sentence from translated pieces (`T("Saved") + " " + path`), because word order differs between languages. Paths, names and values go in as arguments, already escaped (`line`, `displayPath`; S4).

### A plural

```go
p.N(n, "%d entry", "%d entries", n)                  // pass n again if the text shows it
p.N(n, "Deleted %[2]s and %[1]d entry below it.", "Deleted %[2]s and %[1]d entries below it.", n, name)
```

English has two forms, `one` and `other`; Russian and Serbian three: one (1, 21, 101), few (2–4, 22–24) and many/other (0, 5–20, 25, 11–14). Every form uses the same arguments.

### A sentinel error (core packages)

```go
var ErrLocked = i18n.NewError("vault is being saved by another passh process; nothing was saved: try again")
```

`errors.Is` works by identity, as with `errors.New`; `Error()` is the English text. The message is plain text (no `%`).

### A wrapped error

```go
return i18n.Errorf("reading backup %s: %w", name, err)    // a key: translated
return i18n.Errorf("%w: %v", ErrDamaged, err)               // no letters: not a key; the parts translate
```

`i18n.Errorf` is a drop-in for `fmt.Errorf`: the same text, `Unwrap` and `errors.Is/As`. The translation keeps `%w`. Errors still made with `fmt.Errorf("context: %w", err)` keep their English context, and the wrapped error is rendered translated, so a chain can be converted one package at a time.

### A typed error

A type with fields, several lines or a custom `Error` implements `Localize` and builds `Error` from it, so English stays one text:

```go
func (e *OpenError) Error() string { return e.Localize(i18n.Printer{}) }

func (e *OpenError) Localize(p i18n.Printer) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s: %s", e.Path, p.Error(e.Err)) // render wrapped errors with p.Error
	if errors.Is(e.Err, ErrDataDamaged) {
		b.WriteString("\n" + p.T("automatic backups of this vault, newest first:"))
	}
	return b.String()
}
```

`Printer.Error` returns `err.Error()` in English, so English output never depends on `Localize`.

### A message from a package without a Printer

```go
o.Warn(i18n.Msg("old automatic backups couldn't be removed: %v", err))   // vault
…
a.warnf("%s", msg.Localize(a.p))                                          // cli renders it
```

### A key kept in a string

Text stored in a table or a field and shown later is marked where it is written and translated where it is shown, with a comment so the tests accept the variable:

```go
var keyHelp = []struct{ key, help string }{
	{"c", i18n.Mark("copy")},
	{"e", i18n.Mark("edit")},
}
…
s := m.d.p.T(h.help) // i18n:dynamic
```

### One English text, two translations

The same English text has the same translation everywhere (a test checks the area files agree). If one place needs a different translation, give it a context:

```go
p.TC("menu", "Open")         // catalog key "menu\x04Open"; falls back to English "Open"
```

### Helpers that format a message (wrappers)

A helper that takes a message and passes it to `T` (cli's `statusf`, `notef`, `warnf`, `termf`, `usagef`; a TUI `setStatus`) is marked in its doc comment, so the tests read the literals at its call sites:

```go
// statusf prints a confirmation or hint on stderr, translated.
//
// i18n:wrapper
func (a *app) statusf(format string, args ...any) { a.say("", a.T(format, args...)) }
```

The message parameter must be named `format` or `msg`; when it is followed only by `args ...any`, the tests also count the arguments at each call. Calls are matched by the helper's name, so give helpers distinct names. Marking a helper makes every literal at its calls a key: translate them all in the same change. (The pilot in `initcmd.go` uses `a.statusf("%s", a.T(…))` until cli's helpers become wrappers; then it is written `a.statusf("Created the vault %s.", …)`.)

### Rules the tests enforce

- The message is a string constant: a literal, a concatenation, or a constant of the same package or another passh package. Anything else needs a comment containing `i18n:dynamic` on the call's line or the line above, and its keys must be marked with `i18n.Mark` somewhere.
- Methods named `T`, `TC` or `N` are translation calls: don't give other methods these names. Import `internal/i18n` under any name, never with a dot.
- A message called without arguments contains no `%` (it would be printed as is); with arguments, the call passes exactly as many as the format uses.
- `NewError` messages contain no `%`.
- A message without any letter (`"%s: %v"`, `"%w (%v)"`) is not a key and needs no translation.

## Translating

### Catalog files

Each language has one file per area, so translators of different areas never edit the same file:

| Area | Packages | Files |
|---|---|---|
| core | `internal/{vault,vaultfile,keys,model,paths,config,agent,exec,gen,entrytext,export,importpass}` | `ru_core.go`, `sr_core.go` |
| ui | `internal/{tty,editor,print,printweb,clipboard,session,harden}` | `ru_ui.go`, `sr_ui.go` |
| cli | `internal/cli`, `cmd/passh` | `ru_cli.go`, `sr_cli.go` |
| tui | `internal/tui` | `ru_tui.go`, `sr_tui.go` |

A file is a Go map literal; keep entries grouped by source file with a comment:

```go
var ruCLI = catalog{
	msgs: map[string]string{
		// internal/cli/initcmd.go
		"Created the vault %s.": "Хранилище %s создано.",
		// a context key: "context\x04English"
		"menu\x04Open": "Открыть",
	},
	plurals: map[pluralKey][3]string{
		{"%d entry", "%d entries"}: {"%d запись", "%d записи", "%d записей"},
	},
}
```

A key used in two areas may be in either file, or in both with the same translation. Never change the English key in a catalog to fix a translation; change the code's English, then the key.

### Format verbs

Keep every verb (`%s`, `%d`, `%q`, `%v`, `%w`, …) for the same argument. Reorder with indexed verbs when the language needs another order:

```go
"%d entries in %s": "%[2]s: записей — %[1]d",
```

Keep leading and trailing spaces and line breaks exactly (prompts end with `": "`, some messages with `"\n"`). Keep command names, flags, paths, `age1…`, `SHA-256` and code in backquotes as in the English.

### Style

- **ru**: «вы» lowercase; write ё; typographic quotes «» only in prose, never around code, commands or names (those keep the English quoting); a dash (—) for "is" only where a noun follows (`%s — папка`), not before «не в пределах», «не на tmpfs».
- **sr**: Latin script only, with č ć š ž đ; ekavian (lozinka, promeniti, uneti, reči); Serbian words, not Croatian or Bosnian ones (datoteka, fascikla, računar, šifrovanje, podešavanje); case endings on names with a hyphen (passh-a, tmpfs-u, SSH-a, pass-a); "QR kod" without the circumflex.
- Both: short, like the English; the next command to run stays a command (`passh unlock`); units and durations as passh prints them (`256 MiB`, `13.6 GiB`, `30s`): `doctor` formats sizes itself, so the catalogs don't write «МиБ».

Verb forms, by the kind of text:

| Text | ru | sr |
|---|---|---|
| command summary (`Short`) and flag description in `--help` | infinitive: «Вывести дерево записей», «не запрашивать подтверждение» | informal imperative: "Prikaži stablo stavki", "ne traži potvrdu" |
| long description (`Long`) | third person, present: «Копирует пароль…» | third person, present: "Kopira lozinku…" |
| key hints, the TUI help screen, form hints | infinitive: «копировать», «ctrl+s сохранить» | informal imperative: "kopiraj", "ctrl+s sačuvaj", "obriši stavku (uz potvrdu)" |
| navigation hints (`move`, `scroll`) | noun: «перемещение», «прокрутка» | noun: "kretanje", "listanje" |
| an instruction to the user, in a message, error or prompt explanation | imperative, «вы» form: «Выполните», «Введите» | formal imperative: "Pokrenite", "Unesite" |
| a yes/no question and an input prompt | infinitive: «Удалить %s?», «Переместить в: » | infinitive: "Obrisati %s?", "Premestiti u: " |
| what a key does, in a sentence | third person: «R перечитает его», «Enter открывает» | third person: "R ga ponovo učitava", "Enter otvara" |
| a status line or confirmation | passive or short form: «Запись %s сохранена.» | passive with je: "Stavka %s je sačuvana." |
| an error (lowercase, no final period) | noun phrase or short clause: «чтение ответа: %w», «не удалось …» | noun phrase or short clause: "čitanje odgovora: %w", "… nije uspelo" |

A message with a path or a name in `%s` names what it is where the grammar needs it: «Запись %s сохранена», "Stavka %s je sačuvana", «У записи %s нет поля %s». A file is «файл» (masculine) / "datoteka" (feminine), a vault «хранилище» (neuter) / "trezor" (masculine): participles after `%s` agree with that word, or the sentence is turned so that nothing has to agree («создано более новой версией passh»).

The Serbian key hints use the informal imperative, as Serbian software usually does there and as the command summaries do; the TUI and form tests quote them (`internal/tui/lang_test.go`, `internal/editor/i18n_test.go`), so a change to a hint changes those tests too.

### Answers

A yes/no question (`tty.YesNo`) shows its hint in the language: `[y/N]`, `[д/Н]`, `[d/N]` (the capital letter is the default). It accepts, in any case:

| Language | yes | no |
|---|---|---|
| every language | `y`, `yes` | `n`, `no` |
| ru | `д`, `да` | `н`, `нет` |
| sr | `d`, `da` | `n`, `ne` |

So scripts, habits and an English keyboard layout keep working; the answers of one language are not accepted in another (`da` is not Russian). The words live in `tty.answer`, not in the catalogs. Typed confirmation phrases (`PRINT RECOVERY KEY`, …) are never translated: only the sentence around them is.

### Glossary

One English term has one translation in every area. The reviewer settled the terms below; a new term goes into this table in the change that introduces it.

| English | ru | sr (Latin) |
|---|---|---|
| vault | хранилище | trezor |
| vault file | файл хранилища | datoteka trezora |
| passphrase | парольная фраза | pristupna fraza |
| password (of an entry) | пароль | lozinka |
| username | имя пользователя («логин» only in tight hints and `Short` lines) | korisničko ime ("kor. ime" only in tight hints and `Short` lines) |
| entry | запись | stavka |
| folder | папка | fascikla |
| directory (only "the folder is not a directory") | каталог | direktorijum |
| tag | тег | oznaka |
| field | поле | polje |
| custom field | дополнительное поле | dodatno polje |
| notes | заметки | beleške |
| path | путь | putanja |
| backup (automatic copy) | (автоматическая) резервная копия | (automatska) rezervna kopija |
| checked copy (`passh backup`) | проверенная копия | proverena kopija |
| restore a backup | восстановить резервную копию | vratiti rezervnu kopiju |
| paper recovery key | бумажный ключ восстановления | papirni ključ za oporavak |
| recovery key sheet | лист с ключом восстановления | list sa ključem za oporavak |
| password sheet | лист паролей | list sa lozinkama |
| text sheet | текстовый лист | tekstualni list |
| agent | агент (inanimate: «запустить агент») | agent (accusative "agenta": "pokreni agenta") |
| the agent exits / stop the agent | агент завершится / остановить агент | agent će se ugasiti / zaustaviti agenta |
| unlock / lock | разблокировать / заблокировать | otključati / zaključati |
| clipboard | буфер обмена | ostava |
| clear the clipboard | очистить буфер обмена | očistiti ostavu |
| paste | вставить, вставка | nalepiti, lepljenje |
| print page | страница печати | stranica za štampu |
| print (on paper) | распечатать; «печать» as a noun | odštampati; "štampa" as a noun |
| print (to the terminal) | вывести | prikazati (summaries), ispisati (flags and descriptions) |
| revision | ревизия | revizija |
| seen before on this machine | уже открывалась на этом компьютере | ranije viđena na ovom računaru |
| rollback record | журнал ревизий | evidencija revizija |
| tombstone | отметка об удалении | zapis o brisanju |
| export / import | экспорт / импорт | izvoz / uvoz |
| pass store | хранилище pass | skladište pass-a |
| generate | сгенерировать | generisati |
| config file | конфигурационный файл | konfiguraciona datoteka |
| config (the settings) | конфигурация | konfiguracija |
| damaged | повреждён | oštećen |
| invalid | недопустимый (a value), некорректный (data), недействительный (a key) | neispravan |
| key block / data block | блок ключа / блок данных | blok ključa / blok podataka |
| vault key | ключ хранилища | ključ trezora |
| rekeyed | ключ (хранилища) сменили | ključ (trezora) je promenjen |
| encrypt to a key | зашифровать ключом | šifrovati ključem |
| decrypt | расшифровать | dešifrovati |
| checksum | контрольная сумма | kontrolni zbir |
| plaintext, in plain text | открытый текст; в открытом виде (an export, a sheet) | otvoreni tekst; kao otvoreni tekst |
| unencrypted | без шифрования | nešifrovan |
| canonical form | каноническая форма | kanonski oblik |
| line (of text) / line break | строка / перевод строки | red / prelom reda |
| character | символ | znak |
| flag (command-line option) | флаг | opcija |
| command | команда | komanda |
| usage / help | использование / справка | upotreba / pomoć |
| default | по умолчанию | podrazumevano |
| terminal | терминал | terminal |
| prompt (for the passphrase) | запрос (парольной фразы) | upit; traženje (pristupne fraze) |
| confirmation | подтверждение («запрашивать подтверждение») | potvrda ("tražiti potvrdu") |
| form (built-in entry form) | форма | obrazac |
| text form (of an entry) | текстовая форма | tekstualni oblik |
| editor | редактор | uređivač |
| temporary file / folder | временный файл / временная папка | privremena datoteka / fascikla |
| mode (of a file) | права | dozvole |
| symlink | символическая ссылка | simbolička veza |
| save / saving | сохранить / сохранение | sačuvati / čuvanje |
| reload (the vault) | перечитать | ponovo učitati |
| discard (changes) | отбросить | odbaciti |
| delete / remove | удалить | obrisati (an entry, a file) / ukloniti (a tag, a leftover file) |
| move / rename | переместить / переименовать | premestiti / preimenovati |
| copy (to the clipboard) | скопировать | kopirati |
| reveal / hide | показать / скрыть | prikazati / sakriti |
| fuzzy search | нечёткий поиск | približna pretraga |
| fingerprint (certificate) | отпечаток | otisak |
| certificate | сертификат | sertifikat |
| browser | браузер | pregledač |
| core dump | дамп памяти | core dump |
| swap | swap («файлы подкачки» for an editor's swap files) | swap |
| memory | память | memorija |
| warning / note | предупреждение / примечание | upozorenje / napomena |
| ok (a key hint) | ок | u redu |
| ok (`doctor` status column, `TC("doctor", …)`) | ок | ok |
| warn (`doctor` status column) | внимание | upozorenje |

## How the tests check

`go test ./internal/i18n` (part of `go test ./internal/...`) parses every non-test `.go` file under `internal/` and `cmd/` (except `internal/i18n`) and:

- `TestMessageCalls`: every translation call has a constant message (or `i18n:dynamic`) and passes the arguments its format uses; wrappers name their message parameter;
- `TestCatalogsAreComplete`: every message has a ru and a sr translation; the failure lists `file:line` and the missing key;
- `TestCatalogsHaveNoStaleKeys`: no catalog entry without a call;
- `TestAreaCatalogsAgree`: a key in two area files has one translation;
- `TestTranslationsKeepFormat`: the same verbs for the same arguments, the same leading and trailing white space, no empty translation, no Cyrillic in Serbian;
- `TestPluralForms` and the API tests: the plural rules, `Errorf` behaving like `fmt.Errorf`, `Printer.Error`.

So: add the call and its two translations in the same change, and run `go test ./internal/i18n/` before handing work back. The black-box tests in `cmd/passh/language_test.go` check the whole path: the config's language, `--help`, a translated error and `passh init`.
