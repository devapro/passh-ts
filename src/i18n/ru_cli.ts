// Russian catalogue, area cli (keys from src/cli/). The English
// texts are the keys (i18n.md §4); terms follow the glossary of spec/docs/translations.md.
// Entries are grouped by the source file of their first call site.

import type { Catalog } from "./index.ts";

export const RU_CLI: Catalog = {
  // src/cli/cmd_add.ts
  "Tags (comma-separated): ": "Теги (через запятую): ",
  "Notes (end with an empty line):": "Заметки (завершите пустой строкой):",
  "%s already exists: use --force to replace it": "запись %s уже существует: используйте --force, чтобы заменить её",
  "Username: ": "Имя пользователя: ",
  "URL: ": "URL: ",
  "Generated a %d-character password.": "Сгенерирован пароль из %d симв.",
  "Saved %s.": "Запись %s сохранена.",

  // src/cli/cmd_change.ts
  "%s already exists: use --force to replace its password (its other values are kept)": "запись %s уже существует: используйте --force, чтобы заменить её пароль (остальные значения сохранятся)",
  "letters, digits and symbols": "буквы, цифры и спецсимволы",
  "letters and digits": "буквы и цифры",
  "Replaced the password of %s: a new %d-character password (%s, %d bits).": "Пароль записи %s заменён: новый пароль из %d симв. (%s, %d бит).",
  "Stored %s: a new %d-character password (%s, %d bits).": "Запись %s сохранена: новый пароль из %d симв. (%s, %d бит).",
  "Show it with: passh show %s --field password": "Показать его: passh show %s --field password",
  "Moved %s to %s.": "Запись %s перемещена в %s.",
  "Moved the folder %s/ to %s/ (%d entries).": {
    one: "Папка %s/ перемещена в %s/ (%d запись).",
    few: "Папка %s/ перемещена в %s/ (%d записи).",
    many: "Папка %s/ перемещена в %s/ (%d записей).",
  },
  "passh rm asks for confirmation on a terminal: run it in one, or add --force": "passh rm запрашивает подтверждение на терминале: запустите его в терминале или добавьте --force",
  "Delete %s?": "Удалить %s?",
  "not deleted": "не удалено",
  "Deleted %s.": "Запись %s удалена.",
  "give --add and/or --remove": "укажите --add и/или --remove",
  "%s: no tags": "%s: тегов нет",
  "%s: no tags (unchanged)": "%s: тегов нет (без изменений)",
  "%s: tags %s": "%s: теги %s",
  "%s: tags %s (unchanged)": "%s: теги %s (без изменений)",

  // src/cli/cmd_edit.ts
  "nothing was saved: %w": "ничего не сохранено: %w",
  "edit %s": "изменение %s",
  "cancelled; nothing was saved": "отменено; ничего не сохранено",
  "The vault changed on disk since it was opened; reload and apply your edit again?": "Хранилище изменилось на диске после открытия; перечитать его и применить вашу правку снова?",
  "not saved: the vault changed on disk since it was opened": "не сохранено: хранилище изменилось на диске после открытия",
  "not saved: %s was deleted or replaced in the vault on disk": "не сохранено: запись %s удалена или заменена в хранилище на диске",
  "%s; using the built-in form instead": "%s; вместо этого используется встроенная форма",
  "No change.": "Изменений нет.",

  // src/cli/cmd_init.ts
  "--vault: %w": "--vault: %w",
  "%s already exists; passh init doesn't overwrite a vault": "%s уже существует; passh init не перезаписывает хранилище",
  "Write the text sheet to [%s]: ": "Записать текстовый лист в [%s]: ",
  "For a version with the key as a QR code: passh recovery-key print --web": "Версия с ключом в виде QR-кода: passh recovery-key print --web",
  "Creating the vault %s.": "Создание хранилища %s.",
  "Choose a passphrase: 6 or more random words are best.": "Выберите парольную фразу: лучше всего 6 или больше случайных слов.",
  "Created the vault %s.": "Хранилище %s создано.",
  "$HOME is not set": "переменная $HOME не задана",
  "the vault was created, but the config file wasn't: %w": "хранилище создано, а конфигурационный файл — нет: %w",
  "Wrote the config file %s.": "Конфигурационный файл %s записан.",
  "The config file %s exists and wasn't changed; it names the vault %s.": "Конфигурационный файл %s уже есть и не изменён; в нём указано хранилище %s.",
  "Use --vault %s with each command, or change vault in the config file.": "Указывайте --vault %s в каждой команде или измените vault в конфигурационном файле.",
  "Print the recovery key now?": "Распечатать ключ восстановления сейчас?",
  "Print the paper recovery key now and keep the sheet offline:": "Распечатайте бумажный ключ восстановления сейчас и храните лист вне сети:",
  "  passh recovery-key print -o <file>   (or --web, with the key as a QR code)": "  passh recovery-key print -o <file>   (или --web, с ключом в виде QR-кода)",
  "Without it, a forgotten passphrase means the data is lost.": "Без него забытая парольная фраза означает потерю данных.",
  "the vault was created, but the recovery sheet wasn't written: %w; run `passh recovery-key print` later":
    "хранилище создано, но лист с ключом восстановления не записан: %w; выполните `passh recovery-key print` позже",

  // src/cli/cmd_keys.ts
  "passh %s needs the current passphrase, typed on a terminal; the agent's key isn't enough to change the passphrase or the vault key (over SSH: `ssh -t host passh %s`)":
    "команде passh %s нужна текущая парольная фраза, введённая на терминале; ключа агента недостаточно, чтобы сменить парольную фразу или ключ хранилища (через SSH: `ssh -t host passh %s`)",
  "Current passphrase: ": "Текущая парольная фраза: ",
  "Choose the new passphrase.": "Выберите новую парольную фразу.",
  "Choose the passphrase for the new vault key (it may be the same as before).": "Выберите парольную фразу для нового ключа хранилища (можно прежнюю).",
  "Passphrase changed. The paper recovery key stays valid.": "Парольная фраза изменена. Бумажный ключ восстановления остаётся действительным.",
  "Copies and backups made before still open with the old passphrase.": "Копии и резервные копии, сделанные раньше, по-прежнему открываются старой парольной фразой.",
  // one sentence over two lines (cmd_keys.ts:68-69): each half is translated as a half
  "The vault has a new key. The old passphrase and the old paper recovery key": "У хранилища новый ключ. Старая парольная фраза и старый бумажный ключ восстановления",
  "no longer open new versions of it; copies made before still open with them.": "больше не открывают его новые версии; копии, сделанные раньше, ими по-прежнему открываются.",
  "Print a new paper recovery key now: passh recovery-key print": "Распечатайте новый бумажный ключ восстановления сейчас: passh recovery-key print",
  "The recovery key opens the vault. Choose a new passphrase.": "Ключ восстановления открывает хранилище. Выберите новую парольную фразу.",
  "New passphrase set for %s. The paper recovery key stays valid.": "Для %s задана новая парольная фраза. Бумажный ключ восстановления остаётся действительным.",

  // src/cli/cmd_ls.ts
  "no entry matches %q": "ни одна запись не подходит под %q",
  "no tags": "тегов нет",

  // src/cli/cmd_show.ts
  "%s has no field %q": "у записи %s нет поля %q",
  "%s: the %s is empty; nothing was copied": "%s: поле %s пустое; ничего не скопировано",

  // src/cli/cmd_tui.ts
  "the TUI needs a terminal: run passh in one (over SSH: `ssh -t host passh`); without a terminal, use the commands (passh --help) after `passh unlock`":
    "TUI нужен терминал: запустите passh в терминале (через SSH: `ssh -t host passh`); без терминала используйте команды (passh --help) после `passh unlock`",

  // src/cli/command.ts
  "help for %s": "справка по %s",
  "version for %s": "версия %s",
  "invalid argument %s for %s flag: %s": "недопустимый аргумент %s для флага %s: %s",
  "bad flag syntax: %s": "неверный синтаксис флага: %s",
  "unknown flag: --%s": "неизвестный флаг: --%s",
  "flag needs an argument: %s": "флагу нужен аргумент: %s",
  "unknown shorthand flag: %s in -%s": "неизвестный короткий флаг: %s в -%s",
  "flag needs an argument: %s in -%s": "флагу нужен аргумент: %s в -%s",
  "unknown command %s for %s": "неизвестная команда %s для %s",
  "accepts %d arg(s), received %d": "принимает аргументов: %d, получено: %d",
  "accepts between %d and %d arg(s), received %d": "принимает от %d до %d аргументов, получено: %d",
  "unknown command %s for passh": "неизвестная команда %s для passh",
  " (default %s)": " (по умолчанию %s)",
  "Usage:": "Использование:",
  "Available Commands:": "Доступные команды:",
  "Flags:": "Флаги:",
  "Global Flags:": "Глобальные флаги:",
  'Use "%s [command] --help" for more information about a command.': 'Выполните "%s [command] --help", чтобы узнать больше о команде.',
  "Run 'passh --help' or 'passh <command> --help' for usage.": "Справка об использовании: 'passh --help' или 'passh <command> --help'.",

  // src/cli/open.ts
  "%s is a folder, not an entry: list it with `passh ls %s`": "%s — папка, а не запись: выведите её содержимое с помощью `passh ls %s`",
  "%s: not found": "%s: не найдено",

  // src/cli/output.ts
  // the text of an OS error (Go's os.PathError): stays English (i18n.md §3)
  "warning: ": "предупреждение: ",

  // src/cli/runs.ts
  "%s is not implemented yet": "%s: ещё не реализовано",

  // src/cli/tree.ts
  "only entries with this tag (repeat for several: all must match)": "только записи с этим тегом (повторите для нескольких: должны совпасть все)",
  "only entries in this folder": "только записи в этой папке",
  "write to this new file (mode 0600) instead of stdout": "записать в этот новый файл (права 0600) вместо stdout",
  "show the sheet on the one-shot print page (§7.4), with a QR code; a browser can print it or save it as PDF":
    "показать лист на одноразовой странице печати (§7.4), с QR-кодом; браузер может распечатать его или сохранить в PDF",
  "passh keeps passwords in one age-encrypted vault file.\n\nRun `passh init` to create a vault, then `passh` alone for the TUI. Commands that\nread or change entries ask for the passphrase on the terminal, or use the agent\nstarted by `passh unlock`.":
    "passh хранит пароли в одном файле хранилища, зашифрованном age.\n\nВыполните `passh init`, чтобы создать хранилище, затем `passh` без аргументов\nдля TUI. Команды, которые читают или изменяют записи, запрашивают парольную\nфразу на терминале или используют агент, запущенный командой `passh unlock`.",
  "config file (default $PASSH_CONFIG, then ~/.config/passh/config.toml)": "конфигурационный файл (по умолчанию $PASSH_CONFIG, затем ~/.config/passh/config.toml)",
  "vault file, overriding the config's vault (no config file needed)": "файл хранилища вместо vault из конфигурации (конфигурационный файл не нужен)",
  "Add an entry interactively: password (or generate), username, url, tags, notes": "Добавить запись интерактивно: пароль (или сгенерировать), логин, url, теги, заметки",
  "replace an existing entry": "заменить существующую запись",
  "Make a checked copy of the vault in a file or folder": "Сделать проверенную копию хранилища в файл или папку",
  "Copy the vault to a file, or into a folder as <name>-<UTC time>.passh, with\nmode 0600. The copy is flushed to disk, read back and compared by SHA-256.\nAn existing file is never overwritten. A vault that isn't in canonical form\n(e.g. after an email or a paste) is written in canonical form. No passphrase\nis needed.":
    "Копирует хранилище в файл или в папку как <name>-<UTC time>.passh, с правами\n0600. Копия сбрасывается на диск, читается обратно и сравнивается по SHA-256.\nСуществующий файл никогда не перезаписывается. Хранилище не в канонической\nформе (например, после письма или вставки) записывается в канонической форме.\nПарольная фраза не нужна.",
  "List the automatic backups of the vault": "Вывести автоматические резервные копии хранилища",
  "List the automatic backups passh made before each save (§4.7), newest first,\nwith time and revision. To restore one, copy it over the vault file and run\n`passh verify --full`. No passphrase is needed.":
    "Выводит автоматические резервные копии, которые passh сделал перед каждым\nсохранением (§4.7), от новых к старым, со временем и ревизией. Чтобы\nвосстановить резервную копию, скопируйте её поверх файла хранилища и выполните\n`passh verify --full`. Парольная фраза не нужна.",
  "Copy a field (default: the password) to the clipboard, cleared after a while": "Скопировать поле (по умолчанию пароль) в буфер обмена, который затем очищается",
  "Copy the password, or another field, to the clipboard: through the terminal\n(OSC 52, which works over SSH) or with clipboard.command. passh waits and clears\nthe clipboard after clipboard.clear_after; Ctrl-C clears it at once. The value\nis never printed.":
    "Копирует пароль или другое поле в буфер обмена: через терминал (OSC 52,\nработает через SSH) или с помощью clipboard.command. passh ждёт и очищает\nбуфер обмена через clipboard.clear_after; Ctrl-C очищает его сразу. Значение\nникогда не выводится.",
  "field to copy: password, username, url, tags, notes or a custom field": "поле для копирования: password, username, url, tags, notes или дополнительное поле",
  "Check the config, the vault file, the state and agent folders, memory and swap": "Проверить конфигурацию, файл хранилища, папки состояния и агента, память и swap",
  "Read-only checks of everything passh depends on: the config file, the vault\nfile (structure, mode 0600, writable folder, leftover temporary files), the\nstate and agent folders, the agent, free memory for unlock (scrypt needs\n256 MiB), swap, core dumps and the terminal. It reports, never fixes. The exit\nstatus is 1 if a check found an error; warnings are advice.":
    "Проверяет, ничего не меняя, всё, от чего зависит passh: конфигурационный\nфайл, файл хранилища (структура, права 0600, папка с правом записи, оставшиеся\nвременные файлы), папки состояния и агента, агент, свободную память для\nразблокировки (scrypt нужно 256 MiB), swap, дампы памяти и терминал. Только\nсообщает, ничего не исправляет. Код выхода 1, если проверка нашла ошибку;\nпредупреждения — это советы.",
  "Edit an entry in the built-in form, or in $EDITOR": "Изменить запись во встроенной форме или в $EDITOR",
  "Edit an entry in the built-in form: password, username, url, tags and notes\n(ctrl+s saves, esc cancels, ctrl+r reveals the password, ctrl+g generates one).\n\n--editor opens the entry's text form in $EDITOR instead, in a temporary file on\ntmpfs that is wiped afterwards. vim, neovim and nano get flags that keep them\nfrom writing swap, backup or history files. Where there is no tmpfs (macOS),\nthe built-in form is used.":
    "Изменяет запись во встроенной форме: пароль, имя пользователя, url, теги и\nзаметки (ctrl+s сохраняет, esc отменяет, ctrl+r показывает пароль, ctrl+g\nгенерирует новый).\n\n--editor вместо этого открывает текстовую форму записи в $EDITOR, во временном\nфайле на tmpfs, который потом затирается. vim, neovim и nano получают флаги,\nкоторые не дают им писать файлы подкачки, резервных копий и истории. Где нет\ntmpfs (macOS), используется встроенная форма.",
  "edit the text form in $EDITOR (temporary file on tmpfs)": "изменить текстовую форму в $EDITOR (временный файл на tmpfs)",
  "Export entries for other tools (plaintext unless --age)": "Экспортировать записи для других программ (в открытом виде, если нет --age)",
  "Export entries as csv, json (the vault's data format) or bitwarden-json.\n\nExport data is never written to a terminal: use -o file or redirect stdout.\nA plaintext export needs confirmation: with a terminal you type EXPORT PLAINTEXT;\nwithout one (e.g. over ssh without -t) add --confirm-plaintext. --age <recipient>\nencrypts the export to an age public key instead. -o creates a new file with\nmode 0600 and never overwrites one.\n\nFor a backup, don't export: copy the vault file (passh backup).":
    "Экспортирует записи в csv, json (формат данных хранилища) или bitwarden-json.\n\nДанные экспорта никогда не выводятся в терминал: используйте -o файл или\nперенаправьте stdout. Экспорт в открытом виде требует подтверждения: на\nтерминале вы вводите EXPORT PLAINTEXT; без терминала (например, через ssh без\n-t) добавьте --confirm-plaintext. --age <recipient> вместо этого шифрует\nэкспорт открытым ключом age. -o создаёт новый файл с правами 0600 и никогда не\nперезаписывает существующий.\n\nДля резервной копии не экспортируйте: скопируйте файл хранилища (passh backup).",
  "encrypt to this age public key (age1…)": "зашифровать этим открытым ключом age (age1…)",
  "confirm a plaintext export when there is no terminal": "подтвердить экспорт в открытом виде, когда нет терминала",
  "csv, json or bitwarden-json": "csv, json или bitwarden-json",
  "CSV: prefix ' to cells starting with = + - @ (changes values; not for password managers)": "CSV: добавить ' перед ячейками, начинающимися с = + - @ (меняет значения; не для менеджеров паролей)",
  "Fuzzy search on paths and tags": "Нечёткий поиск по путям и тегам",
  "Generate and store a password": "Сгенерировать и сохранить пароль",
  "Generate a random password (default 24 letters and digits) and store it.\n\nA new path makes a new entry. For an existing entry, --force replaces its\npassword and keeps its other values (username, url, tags, fields, notes).\nThe password is not printed; show it with `passh show <path> --field password`.":
    "Генерирует случайный пароль (по умолчанию 24 буквы и цифры) и сохраняет его.\n\nНовый путь создаёт новую запись. Для существующей записи --force заменяет её\nпароль и сохраняет остальные значения (username, url, tags, fields, notes).\nПароль не выводится; покажите его: `passh show <path> --field password`.",
  "replace the password of an existing entry": "заменить пароль существующей записи",
  "also use punctuation characters": "использовать также знаки препинания",
  "Help about any command": "Справка по любой команде",
  "Help provides help for any command in the application.\nSimply type passh help [path to command] for full details.":
    "Выводит справку по любой команде приложения.\nПросто введите passh help [path to command], чтобы получить подробности.",
  "Import entries from another password manager": "Импортировать записи из другого менеджера паролей",
  "say what to import from, e.g. `passh import pass`": "укажите, откуда импортировать, например `passh import pass`",
  "One-way import from a pass store (needs gpg)": "Односторонний импорт из хранилища pass (нужен gpg)",
  "Import a pass store (password-store.org) into the vault, in one save. The store\nis only read. dir defaults to $PASSWORD_STORE_DIR, then ~/.password-store.\nEach entry is decrypted with gpg, as pass does. Paths already in the vault are\nskipped unless --overwrite is given. --dry-run lists what would be imported\nand the conflicts without decrypting anything.":
    "Импортирует хранилище pass (password-store.org) в хранилище passh за одно\nсохранение. Хранилище pass только читается. dir по умолчанию —\n$PASSWORD_STORE_DIR, затем ~/.password-store. Каждая запись расшифровывается\nс помощью gpg, как это делает pass. Пути, которые уже есть в хранилище,\nпропускаются, если не задан --overwrite. --dry-run выводит, что было бы\nимпортировано, и конфликты, ничего не расшифровывая.",
  "list what would be imported and the conflicts; decrypt nothing": "вывести, что было бы импортировано, и конфликты; ничего не расшифровывать",
  "replace entries whose path is already in the vault": "заменить записи, путь которых уже есть в хранилище",
  "Create a new vault, and the config file if it doesn't exist": "Создать новое хранилище и конфигурационный файл, если его нет",
  "Stop the agent": "Остановить агент",
  "Print the tree of entries, optionally filtered by tag": "Вывести дерево записей, при желании с отбором по тегу",
  "Move or rename an entry or a folder": "Переместить или переименовать запись или папку",
  "Move or rename an entry. A destination ending in / moves the entry into that\nfolder, keeping its name. If <src> is a folder, every entry in it moves, in\none save; nothing moves if any destination is taken.":
    "Перемещает или переименовывает запись. Назначение, оканчивающееся на /,\nперемещает запись в эту папку, сохраняя её имя. Если <src> — папка,\nперемещаются все записи в ней, за одно сохранение; ничего не перемещается,\nесли хоть одно назначение занято.",
  "Change the passphrase (the paper recovery key stays valid)": "Сменить парольную фразу (бумажный ключ восстановления остаётся действительным)",
  "Change the passphrase: only the key block is rewritten, and the paper recovery\nkey stays valid. It asks for the current passphrase on the terminal, also while\nthe agent runs: the agent's key isn't enough to change it. A running agent is\nstopped afterwards.":
    "Меняет парольную фразу: перезаписывается только блок ключа, и бумажный ключ\nвосстановления остаётся действительным. Текущая парольная фраза запрашивается\nна терминале, даже когда работает агент: ключа агента недостаточно, чтобы её\nсменить. Работающий агент затем останавливается.",
  "Print a password sheet (text), or show it on the print page (--web)": "Распечатать лист паролей (текст) или показать его на странице печати (--web)",
  "Lay out the chosen entries as a text password sheet, grouped by folder, with\nthe chosen fields (default password,username,url; also tags, notes, fields, or\na custom field's key). Ambiguous characters are marked.\n\nThe sheet is plaintext: it is never written to a terminal, and it needs\nconfirmation as a plaintext export does (type EXPORT PLAINTEXT, or\n--confirm-plaintext without a terminal). Use -o file (mode 0600) or redirect\nstdout; print it, then delete the file.\n\n--web shows it on the one-shot print page instead (print_web.enabled; needs a\nterminal and typing PRINT); the browser prints it, or saves it as PDF.":
    "Раскладывает выбранные записи в текстовый лист паролей, сгруппированный по\nпапкам, с выбранными полями (по умолчанию password,username,url; также tags,\nnotes, fields или ключ дополнительного поля). Неоднозначные символы\nпомечаются.\n\nЛист — открытый текст: он никогда не выводится в терминал и требует\nподтверждения, как экспорт в открытом виде (введите EXPORT PLAINTEXT или\n--confirm-plaintext без терминала). Используйте -o файл (права 0600) или\nперенаправьте stdout; распечатайте его, затем удалите файл.\n\n--web вместо этого показывает его на одноразовой странице печати\n(print_web.enabled; нужен терминал и ввод PRINT); браузер распечатывает его\nили сохраняет в PDF.",
  "confirm a plaintext sheet when there is no terminal": "подтвердить лист в открытом виде, когда нет терминала",
  "fields to print, comma-separated (default password,username,url)": "поля для печати через запятую (по умолчанию password,username,url)",
  removed: "удалено",
  "Open the vault with the paper recovery key and set a new passphrase": "Открыть хранилище бумажным ключом восстановления и задать новую парольную фразу",
  "The paper recovery key": "Бумажный ключ восстановления",
  "say what to do, e.g. `passh recovery-key print`": "укажите, что сделать, например `passh recovery-key print`",
  "Print the paper recovery key (needs a terminal and typing PRINT RECOVERY KEY)": "Распечатать бумажный ключ восстановления (нужен терминал и ввод PRINT RECOVERY KEY)",
  "Print the paper recovery key as a text sheet: the vault key in groups of four\ncharacters, the vault_id, the print date, a warning and the manual recovery\nsteps. Whoever has the sheet and a copy of the vault can read everything: keep\nit offline, and print a new one after `passh rekey`.\n\nIt needs a terminal and typing PRINT RECOVERY KEY. The sheet is never written\nto a terminal: use -o file (mode 0600) or redirect stdout, print it, then delete\nthe file. --web shows it on the one-shot print page instead, with the key as a\nQR code; the browser prints it, or saves it as PDF.":
    "Выводит бумажный ключ восстановления как текстовый лист: ключ хранилища\nгруппами по четыре символа, vault_id, дату печати, предупреждение и шаги\nвосстановления вручную. Тот, у кого есть лист и копия хранилища, может\nпрочитать всё: храните лист вне сети и распечатайте новый после `passh rekey`.\n\nНужен терминал и ввод PRINT RECOVERY KEY. Лист никогда не выводится в\nтерминал: используйте -o файл (права 0600) или перенаправьте stdout,\nраспечатайте его, затем удалите файл. --web вместо этого показывает его на\nодноразовой странице печати, с ключом в виде QR-кода; браузер распечатывает\nего или сохраняет в PDF.",
  "Make a new vault key (the old passphrase and paper key stop working on new versions)": "Создать новый ключ хранилища (старые парольная фраза и бумажный ключ не откроют новые версии)",
  "Make a new vault key and re-encrypt the data to it, with a passphrase (the same or\na new one). The old passphrase and paper recovery key don't open new versions of\nthe file. It asks for the current passphrase on the terminal, also while the\nagent runs: the agent's key isn't enough to replace the vault key. A running\nagent is stopped afterwards.":
    "Создаёт новый ключ хранилища и заново шифрует им данные, с парольной фразой\n(прежней или новой). Старые парольная фраза и бумажный ключ восстановления не\nоткрывают новые версии файла. Текущая парольная фраза запрашивается на\nтерминале, даже когда работает агент: ключа агента недостаточно, чтобы\nзаменить ключ хранилища. Работающий агент затем останавливается.",
  "Delete an entry (asks for confirmation)": "Удалить запись (с подтверждением)",
  "don't ask for confirmation": "не запрашивать подтверждение",
  "Print an entry (text form) or one field": "Вывести запись (текстовая форма) или одно поле",
  "Print an entry in its text form: the password on line 1, then username, url,\ntags and other fields, then the notes after ---.\n\nControl characters and escape sequences in the entry are shown escaped, so an\nentry can't drive your terminal. --raw prints the exact bytes instead.\n--field prints one value (password, username, url, tags, notes or a custom\nfield). When stdout is not a terminal (a pipe or a file), --field prints the\nexact value without a final newline, e.g.\n  passh show work/github --field password | pbcopy":
    "Выводит запись в текстовой форме: пароль в строке 1, затем username, url,\ntags и другие поля, затем заметки после ---.\n\nУправляющие символы и escape-последовательности в записи показываются\nэкранированными, чтобы запись не могла управлять вашим терминалом. --raw\nвместо этого выводит точные байты. --field выводит одно значение (password,\nusername, url, tags, notes или дополнительное поле). Когда stdout — не\nтерминал (канал или файл), --field выводит точное значение без перевода\nстроки в конце, например\n  passh show work/github --field password | pbcopy",
  "print only this field: password, username, url, tags, notes or a custom field": "вывести только это поле: password, username, url, tags, notes или дополнительное поле",
  "print exact bytes, without escaping control characters": "вывести точные байты, без экранирования управляющих символов",
  "Add and remove tags of an entry": "Добавить и удалить теги записи",
  "tag to add (repeat, or separate with commas)": "тег для добавления (повторите или перечислите через запятую)",
  "tag to remove (repeat, or separate with commas)": "тег для удаления (повторите или перечислите через запятую)",
  "List tags with their entry counts": "Вывести теги с числом записей",
  "Start the agent: no passphrase prompts for a while, also without a terminal": "Запустить агент: какое-то время без запросов парольной фразы, даже без терминала",
  "Ask for the passphrase and start the agent, which keeps the vault key in memory\nso later commands, including ones without a terminal (ssh host passh show …),\ndon't ask for it. The agent exits after agent.idle_ttl without use, after\nagent.max_ttl (or --ttl) in any case, and on `passh lock`.\n\nWith an agent already running for the vault, unlock restarts its idle time and\nsays how long it has left. --ttl only applies to a new agent: passh says when it\nwasn't applied (run `passh lock` first).":
    "Запрашивает парольную фразу и запускает агент, который держит ключ хранилища\nв памяти, чтобы следующие команды, в том числе без терминала (ssh host passh\nshow …), её не спрашивали. Агент завершится через agent.idle_ttl без\nиспользования, в любом случае через agent.max_ttl (или --ttl) и по\n`passh lock`.\n\nЕсли агент для хранилища уже работает, unlock заново отсчитывает его время\nпростоя и сообщает, сколько ему осталось. --ttl действует только на новый\nагент: passh сообщает, когда он не применён (сначала выполните `passh lock`).",
  "stop a new agent after this long in any case (overrides agent.max_ttl), e.g. 30m": "остановить новый агент через это время в любом случае (вместо agent.max_ttl), например 30m",
  "Check the vault or a copy of it": "Проверить хранилище или его копию",
  "Check a vault file without the passphrase: the passh-vault line, both blocks\ncomplete, base64 and age headers valid. It prints the file's SHA-256 and size;\na byte-exact copy has the same SHA-256 as the original.\n\n--full also decrypts the file (through the agent, or by asking for the\npassphrase) and prints its vault_id, revision, saved_at and entry count, and\nhow it compares with the newest revision seen on this machine.":
    "Проверяет файл хранилища без парольной фразы: строка passh-vault, оба блока\nцелы, base64 и заголовки age корректны. Выводит SHA-256 и размер файла;\nпобайтная копия имеет тот же SHA-256, что и оригинал.\n\n--full также расшифровывает файл (через агент или запросив парольную фразу) и\nвыводит его vault_id, revision, saved_at и число записей, а также то, как он\nсоотносится с самой новой ревизией, которая уже открывалась на этом\nкомпьютере.",
  "also decrypt the file and check its data": "также расшифровать файл и проверить его данные",
  "Print passh's version": "Вывести версию passh",

  // src/cli/cmd_doctor.ts
  "--vault overrides the config's vault": "--vault заменяет vault из конфигурации",
  "no config file at %s; using --vault and the defaults": "нет конфигурационного файла %s; используются --vault и значения по умолчанию",
  "no config, so no vault to check": "нет конфигурации, поэтому нет хранилища для проверки",
  "%s doesn't exist: run `passh init`, or point the config's vault at your vault file": "%s не существует: выполните `passh init` или укажите в vault конфигурации ваш файл хранилища",
  "%s is a symlink that can't be resolved: %v": "%s — символическая ссылка, которую нельзя разрешить: %v",
  "%s is a symlink to %s; saves write the target": "%s — символическая ссылка на %s; сохранения записываются в её цель",
  "%s: structure OK, %d bytes": "%s: структура в порядке, байт: %d",
  "not in canonical form (line endings or wrapping changed); it opens, and the next save rewrites it":
    "не в канонической форме (изменены концы строк или переносы); файл открывается, а следующее сохранение перезапишет его",
  "%s: %v (SHA-256 %s)": "%s: %v (SHA-256 %s)",
  "mode %s, not 0600: fix it with chmod 600 %s": "права %s, а не 0600: исправьте это командой chmod 600 %s",
  "%s isn't writable (%v): saving needs a temporary file there": "в %s нельзя писать (%v): для сохранения там нужен временный файл",
  "%s is writable": "в %s можно писать",
  "can't list the vault's folder: %v": "не удаётся прочитать содержимое папки хранилища: %v",
  none: "нет",
  "%d files left by an interrupted save (%s); the next save removes them": {
    one: "файлов от прерванного сохранения: %d (%s); следующее сохранение их удалит",
    few: "файлов от прерванного сохранения: %d (%s); следующее сохранение их удалит",
    many: "файлов от прерванного сохранения: %d (%s); следующее сохранение их удалит",
  },
  "%s doesn't exist yet; the first save creates it": "папка %s ещё не существует; первое сохранение создаст её",
  "%s is not a folder (backups, locks and the agent's socket go there)": "%s — не папка (там хранятся резервные копии, блокировки и сокет агента)",
  "%s belongs to uid %d, not to you": "%s принадлежит uid %d, а не вам",
  "%s isn't writable: %v": "в %s нельзя писать: %v",
  "%s has mode %s: other users can look inside (the backups are encrypted); chmod 700 is better":
    "у %s права %s: другие пользователи могут заглянуть внутрь (резервные копии зашифрованы); лучше chmod 700",
  "no vault to check the agent for": "нет хранилища, для которого можно проверить агент",
  "can't read the available memory: %v": "не удаётся прочитать объём доступной памяти: %v",
  "no MemAvailable line in /proc/meminfo": "в /proc/meminfo нет строки MemAvailable",
  "%s available: unlock needs 256 MiB for scrypt and may fail or swap": "доступно %s: разблокировке нужно 256 MiB для scrypt, и она может не удаться или задействовать swap",
  "%s available (unlock needs 256 MiB)": "доступно %s (разблокировке нужно 256 MiB)",
  "can't read the memory size: %v": "не удаётся прочитать объём памяти: %v",
  "%s in total: unlock needs 256 MiB for scrypt and may fail or swap; available memory isn't checked on macOS":
    "всего %s: разблокировке нужно 256 MiB для scrypt, и она может не удаться или задействовать swap; доступная память в macOS не проверяется",
  "%s in total (unlock needs 256 MiB); available memory isn't checked on macOS": "всего %s (разблокировке нужно 256 MiB); доступная память в macOS не проверяется",
  "not checked on this system": "в этой системе не проверяется",
  "can't read /proc/swaps: %v": "не удаётся прочитать /proc/swaps: %v",
  "no swap is active": "swap не используется",
  "%d swap areas are active (%s): process memory, decrypted secrets included, may be written to disk. passh doesn't change this; turn swap off or encrypt it if that matters to you": {
    one: "активна %d область swap (%s): память процессов, включая расшифрованные секреты, может попасть на диск. passh это не меняет; отключите swap или зашифруйте его, если это для вас важно",
    few: "активны %d области swap (%s): память процессов, включая расшифрованные секреты, может попасть на диск. passh это не меняет; отключите swap или зашифруйте его, если это для вас важно",
    many: "активно %d областей swap (%s): память процессов, включая расшифрованные секреты, может попасть на диск. passh это не меняет; отключите swap или зашифруйте его, если это для вас важно",
  },
  "can't read vm.swapusage: %v": "не удаётся прочитать vm.swapusage: %v",
  "no swap is in use": "swap не используется",
  "swap is active (%s used) and encrypted by macOS": "swap активен (занято %s) и зашифрован macOS",
  "swap is active (%s used) and not encrypted: process memory, decrypted secrets included, may be written to disk":
    "swap активен (занято %s) и не зашифрован: память процессов, включая расшифрованные секреты, может попасть на диск",
  "reading core dump limit: %v": "чтение ограничения дампов памяти: %v",
  "disabled for passh and the agent": "отключены для passh и агента",
  "not disabled: a crash could write secrets to a core file": "не отключены: при сбое секреты могут попасть в файл дампа памяти",
  "/dev/tty: passphrase prompts work": "/dev/tty: запросы парольной фразы работают",
  "none: prompts are impossible, so commands need the agent (`passh unlock` in a terminal)": "нет: запросы невозможны, поэтому командам нужен агент (`passh unlock` в терминале)",
  "no files left by an interrupted `edit --editor`": "нет файлов, оставшихся от прерванного `edit --editor`",
  "left by an interrupted `edit --editor`, possibly with an entry in plain text: %s; delete them (rm -r)":
    "остались от прерванного `edit --editor`, возможно, с записью в открытом виде: %s; удалите их (rm -r)",
  "no config, so no clipboard settings to check": "нет конфигурации, поэтому нет настроек буфера обмена для проверки",
  "not tested without a terminal: run `passh doctor` in one (over SSH: ssh -t)": "без терминала не проверяется: запустите `passh doctor` в терминале (через SSH: ssh -t)",
  "inside tmux: OSC 52 needs `set -g set-clipboard on` in ~/.tmux.conf": "внутри tmux: для OSC 52 нужно `set -g set-clipboard on` в ~/.tmux.conf",
  "inside GNU screen: screen doesn't pass OSC 52 to the terminal; set clipboard.command or run passh outside screen":
    "внутри GNU screen: screen не передаёт OSC 52 терминалу; задайте clipboard.command или запускайте passh вне screen",
  'Terminal.app has no OSC 52: set clipboard.command = ["pbcopy"]': 'в Terminal.app нет OSC 52: задайте clipboard.command = ["pbcopy"]',
  "no clipboard: %v; copy with: passh show <path> --field password | pbcopy": "нет буфера обмена: %v; копируйте так: passh show <path> --field password | pbcopy",
  'Testing the clipboard: copied "passh clipboard test" (%s). Paste it somewhere to check; it is cleared in %s.':
    'Проверка буфера обмена: скопировано "passh clipboard test" (%s). Вставьте это куда-нибудь для проверки; буфер обмена очистится через %s.',
  "clearing the clipboard failed: %v": "не удалось очистить буфер обмена: %v",
  'sent a test string with %s and cleared it; if pasting gave "passh clipboard test", copying works':
    'тестовая строка отправлена через %s и стёрта; если вставка дала "passh clipboard test", копирование работает',
  "%d errors": { one: "%d ошибка", few: "%d ошибки", many: "%d ошибок" },
  "%d warnings": { one: "%d предупреждение", few: "%d предупреждения", many: "%d предупреждений" },
  // doctor's check names (cli.md §2.25) and level column (glossary: ok → ок, warn → внимание)
  "doctor\u0004config": "конфигурация",
  "doctor\u0004vault": "хранилище",
  "doctor\u0004vault mode": "права хранилища",
  "doctor\u0004vault folder": "папка хранилища",
  "doctor\u0004temp files": "временные файлы",
  "doctor\u0004state folder": "папка состояния",
  "doctor\u0004agent": "агент",
  "doctor\u0004agent folder": "папка агента",
  "doctor\u0004memory": "память",
  "doctor\u0004swap": "swap",
  "doctor\u0004core dumps": "дампы памяти",
  "doctor\u0004terminal": "терминал",
  "doctor\u0004edit temp": "файлы edit",
  "doctor\u0004clipboard": "буфер обмена",
  "doctor\u0004ok": "ок",
  "doctor\u0004info": "инфо",
  "doctor\u0004skip": "пропуск",
  "doctor\u0004warn": "внимание",
  "doctor\u0004error": "ошибка",
};
