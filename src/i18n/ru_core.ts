// Russian catalogue, area core (keys from src/ outside cli and tui). The English
// texts are the keys (i18n.md §4); terms follow the glossary of spec/docs/translations.md.
// Entries are grouped by the source file of their first call site.
// Left English on purpose: "EOF" (Go's io.EOF text); Go's network texts inside a message
// (`dial unix …: connect:`, `i/o timeout`, `context deadline exceeded`, `listen unix …: bind:`)
// and Go's `exec: …` prefixes are kept as the library writes them (i18n.md §3).

import type { Catalog } from "./index.ts";

export const RU_CORE: Catalog = {
  // src/age/recipients.ts
  "--age: invalid age recipient %q: %w": "--age: недопустимый получатель age %q: %w",
  "--age: this is an age secret key; give its public recipient (age1…), as printed by age-keygen -y": "--age: это секретный ключ age; укажите его открытого получателя (age1…), как его выводит age-keygen -y",
  "--age: the recipient is empty; give an age public key (age1…)": "--age: получатель пуст; укажите открытый ключ age (age1…)",
  "--age: not an age recipient; give an age public key (age1…)": "--age: это не получатель age; укажите открытый ключ age (age1…)",

  // src/agent/client.ts
  "agent: %w": "агент: %w",
  "agent: connecting to %s: dial unix %s: connect: %w": "агент: подключение к %s: dial unix %s: connect: %w",
  "agent: connecting to %s: dial unix %s: i/o timeout": "агент: подключение к %s: dial unix %s: i/o timeout",
  "agent: refusing the agent socket %s: peer is uid %d, not uid %d": "агент: сокет агента %s отклонён: на другой стороне uid %d, а не uid %d",
  "agent: refusing the agent socket %s: %w": "агент: сокет агента %s отклонён: %w",
  "agent: reading the answer: context deadline exceeded": "агент: чтение ответа: context deadline exceeded",
  "agent: reading the answer: message too large": "агент: чтение ответа: сообщение слишком большое",
  "agent: reading the answer: connection closed in the middle of a message": "агент: чтение ответа: соединение закрыто посреди сообщения",
  "agent: the agent closed the connection without answering": "агент: агент закрыл соединение, не ответив",
  "agent: reading the answer: %w": "агент: чтение ответа: %w",
  "agent: waiting for the agent (pid %d) to exit: %w": "агент: ожидание завершения агента (pid %d): %w",
  "agent: waiting for the agent (pid %d) to exit: context deadline exceeded": "агент: ожидание завершения агента (pid %d): context deadline exceeded",

  // src/agent/commands.ts
  "opening the vault: %w": "открытие хранилища: %w",
  "%s: not a passh vault: %w": "%s: не хранилище passh: %w",
  "Already unlocked: %s.": "Уже разблокировано: %s.",
  "--ttl was not applied: the agent was already running; run `passh lock`, then `passh unlock --ttl …`": "--ttl не применён: агент уже был запущен; выполните `passh lock`, затем `passh unlock --ttl …`",
  "--ttl must be more than zero": "--ttl должен быть больше нуля",
  "an agent is running, but the vault can't be checked against it: %w": "агент запущен, но сверить с ним хранилище нельзя: %w",
  "the running agent was unlocked with another key block (passwd elsewhere?); replacing it": "запущенный агент был разблокирован с другим блоком ключа (passwd на другом компьютере?); он будет заменён",
  "passh unlock needs a terminal to ask for the passphrase (over SSH: `ssh -t host passh unlock`)": "passh unlock нужен терминал, чтобы запросить парольную фразу (через SSH: `ssh -t host passh unlock`)",
  "agent: starting the agent: %w": "агент: запуск агента: %w",
  "agent: starting the agent: the agent exited before it was ready": "агент: запуск агента: агент завершился, не успев стать готовым",
  "agent: starting the agent: the agent didn't report ready within %s": "агент: запуск агента: агент не сообщил о готовности за %s",
  "agent: the agent (pid %d) started but doesn't answer: %s": "агент: агент (pid %d) запущен, но не отвечает: %s",
  "Unlocked %s: %s.": "Хранилище %s разблокировано: %s.",
  "Run `passh lock` to stop the agent now.": "Выполните `passh lock`, чтобы остановить агент сейчас.",
  "agent: the vault's key block isn't the one this agent was unlocked with": "агент: блок ключа хранилища не тот, с которым был разблокирован этот агент",
  "agent: starting the agent: another agent started meanwhile and exited": "агент: запуск агента: тем временем запустился другой агент и завершился",
  "agent: starting the agent: %s": "агент: запуск агента: %s",
  "agent: starting the agent: unexpected readiness line %q": "агент: запуск агента: неожиданная строка готовности %q",
  "No agent is running for %s.": "Для %s агент не запущен.",
  "Locked: the agent (pid %d) stopped.": "Заблокировано: агент (pid %d) остановлен.",
  "the agent couldn't be stopped: %s; stop it with `passh lock`": "агент не удалось остановить: %s; остановите его командой `passh lock`",
  "The agent held the old key and was stopped; run `passh unlock` again if you need it.": "Агент хранил старый ключ и был остановлен; если он нужен, снова выполните `passh unlock`.",
  "The agent was unlocked with the old key block and was stopped; run `passh unlock` again if you need it.": "Агент был разблокирован со старым блоком ключа и был остановлен; если он нужен, снова выполните `passh unlock`.",
  "not running (`passh unlock` starts it)": "не запущен (его запускает `passh unlock`)",
  "%s doesn't exist yet; `passh unlock` creates it": "%s ещё не существует; её создаст `passh unlock`",
  "%s (0700, yours)": "%s (0700, ваша)",
  "running: %s": "запущен: %s",

  // src/agent/keysource.ts
  "the vault's key block isn't the one `passh unlock` opened (passwd elsewhere, or damaged): the agent's key isn't used; asking for the passphrase": "блок ключа хранилища не тот, который открыл `passh unlock` (passwd на другом компьютере или повреждение): ключ агента не используется; запрашивается парольная фраза",
  "can't use the agent of %s: %s": "нельзя использовать агент хранилища %s: %s",

  // src/agent/protocol.ts
  "request too large": "запрос слишком большой",
  "malformed request": "некорректный запрос",
  "a key request must name the vault's key block (key_block)": "запрос ключа должен указывать блок ключа хранилища (key_block)",
  "key_block is not a hex SHA-256": "key_block — не шестнадцатеричный SHA-256",
  "the vault's key block isn't the one this agent was unlocked with": "блок ключа хранилища не тот, с которым был разблокирован этот агент",
  "the agent has expired": "срок действия агента истёк",
  "not a vault key": "не ключ хранилища",
  "not a valid vault key": "недействительный ключ хранилища",
  "agent: malformed answer": "агент: некорректный ответ",
  "agent: the running agent speaks protocol version %d, this passh 1; kill it and run `passh unlock` again": "агент: запущенный агент использует протокол версии %d, а этот passh — версии 1; завершите его и снова выполните `passh unlock`",
  "agent: %s": "агент: %s",
  "agent: the agent refused the request: %s": "агент: агент отклонил запрос: %s",
  "agent: the agent's answer holds no vault key": "агент: в ответе агента нет ключа хранилища",
  "agent: the agent's answer holds no valid vault key: %s": "агент: в ответе агента нет действительного ключа хранилища: %s",

  // src/agent/server.ts
  "agent: listen unix %s: bind: %w": "агент: listen unix %s: bind: %w",
  "agent: connecting to %s: %w": "агент: подключение к %s: %w",

  // src/agent/times.ts
  "the agent (pid %d) exits in %s": "агент (pid %d) завершится через %s",
  "the agent (pid %d) exits in %s if unused, in %s at the latest": "агент (pid %d) завершится через %s, если не используется, и не позже чем через %s",

  // src/clipboard/index.ts
  "OSC 52 through the terminal": "OSC 52 через терминал",
  "command %q": "команда %q",
  "no clipboard: %s; copy with: passh show %s --field %s | pbcopy": "нет буфера обмена: %s; скопируйте так: passh show %s --field %s | pbcopy",
  "no clipboard: %s": "нет буфера обмена: %s",
  "clipboard command: %w": "команда буфера обмена: %w",
  "clipboard.command: the program name is empty": "clipboard.command: имя программы пустое",
  "clipboard.command: %w": "clipboard.command: %w",
  "OSC 52 needs a terminal and there is none, and clipboard.command is empty": "для OSC 52 нужен терминал, а его нет, и clipboard.command пуст",
  "clipboard.osc52 is off and clipboard.command is empty": "clipboard.osc52 выключен, а clipboard.command пуст",
  "Copied the %s of %s (%s); the clipboard clears in %s, Ctrl-C clears it now.": "Поле %s записи %s скопировано (%s); буфер обмена очистится через %s, Ctrl-C очистит его сейчас.",
  "interrupted (%s), and clearing the clipboard failed: %w": "прервано (%s), и очистить буфер обмена не удалось: %w",
  "clearing the clipboard failed: %w": "очистить буфер обмена не удалось: %w",
  "Clipboard cleared.": "Буфер обмена очищен.",

  // src/config/agentdir.ts
  "the agent's socket path is longer than 103 bytes even in /tmp": "путь к сокету агента длиннее 103 байт даже в /tmp",
  "agent folder %s is not a directory (a symlink or a file); refusing to use it": "папка агента %s — не каталог (символическая ссылка или файл); использовать её нельзя",
  "opening the agent folder %s: %w": "открытие папки агента %s: %w",
  "checking the agent folder %s: %w": "проверка папки агента %s: %w",
  "agent folder %s belongs to uid %d, not to you (uid %d); refusing to use it": "папка агента %s принадлежит uid %d, а не вам (uid %d); использовать её нельзя",
  "agent folder %s has mode %s, not 0700; refusing to use it (fix it with chmod 700, or remove it)": "у папки агента %s права %s, а не 0700; использовать её нельзя (исправьте их командой chmod 700 или удалите папку)",

  // src/config/paths.ts
  "$HOME (%q) is not an absolute path": "$HOME (%q) — не абсолютный путь",

  // src/config/template.ts
  "vault path %q is not valid UTF-8, which TOML can't hold": "путь к хранилищу %q не является корректным UTF-8, а TOML такое хранить не может",

  // src/editor/choose.ts
  "the editor command is empty": "команда редактора пуста",

  // src/editor/edit.ts
  "creating the temporary folder: %w": "создание временной папки: %w",
  "the temporary folder %s is not on tmpfs": "временная папка %s не на tmpfs",
  "creating the temporary folder in %s: too many attempts": "создание временной папки в %s: слишком много попыток",
  "the edited file is larger than 16 MiB": "отредактированный файл больше 16 MiB",
  "removing the temporary folder %s: %w; remove it yourself, it holds the entry in plain text": "удаление временной папки %s: %w; удалите её сами, в ней запись в открытом виде",
  "editing interrupted by %s; nothing was changed": "редактирование прервано (%s); ничего не изменено",
  "the editor failed (%w); nothing was changed": "ошибка редактора (%w); ничего не изменено",
  "warning: passh can't control backup, swap or history files of %s: they may keep a copy of the entry on disk. Graphical editors must also wait until the file is closed (e.g. code --wait).":
    "предупреждение: passh не может управлять файлами резервных копий, подкачки и истории редактора %s: в них может остаться копия записи на диске. Графические редакторы также должны ждать, пока файл не будет закрыт (например, code --wait).",
  "The entry isn't valid: %s": "Запись некорректна: %s",
  "Edit it again?": "Отредактировать её снова?",

  // src/editor/tmpfs.ts
  "no tmpfs for the temporary file (passh looks for one only on Linux): the entry would be written to disk in plain text; use the built-in form (passh edit without --editor)":
    "нет tmpfs для временного файла (passh ищет его только в Linux): запись попала бы на диск в открытом виде; используйте встроенную форму (passh edit без --editor)",
  "no tmpfs for the temporary file (checked $XDG_RUNTIME_DIR (%s) and /dev/shm): the entry would be written to disk in plain text; use the built-in form (passh edit without --editor)":
    "нет tmpfs для временного файла (проверены $XDG_RUNTIME_DIR (%s) и /dev/shm): запись попала бы на диск в открытом виде; используйте встроенную форму (passh edit без --editor)",
  "no tmpfs for the temporary file (checked /dev/shm): the entry would be written to disk in plain text; use the built-in form (passh edit without --editor)":
    "нет tmpfs для временного файла (проверен /dev/shm): запись попала бы на диск в открытом виде; используйте встроенную форму (passh edit без --editor)",

  // src/entrytext/index.ts
  "line %d: %w": "строка %d: %w",
  "the text is not valid UTF-8": "текст не является корректным UTF-8",
  "username appears twice": "username встречается дважды",
  "url appears twice": "url встречается дважды",

  // src/errors.ts
  "interrupted (%s)": "прервано (%s)",

  // src/exec/lookpath.ts (Go's exec.Error text, kept)
  "exec: %q: %s": "exec: %q: %s",
  "exec: %q: %w": "exec: %q: %w",
  "exec: %w": "exec: %w",

  // src/exec/run.ts
  "the command is empty": "команда пуста",

  // src/exec/words.ts
  "unterminated single quote in %q": "незакрытая одинарная кавычка в %q",
  "unterminated double quote in %q": "незакрытая двойная кавычка в %q",
  "trailing backslash in %q": "обратная косая черта в конце %q",

  // src/export/export.ts
  "--format is required: csv, json or bitwarden-json": "нужен --format: csv, json или bitwarden-json",
  "unknown export format %q (use csv, json or bitwarden-json)": "неизвестный формат экспорта %q (используйте csv, json или bitwarden-json)",
  "--age and --confirm-plaintext can't be used together": "--age и --confirm-plaintext нельзя использовать вместе",
  "--spreadsheet-safe applies only to --format csv": "--spreadsheet-safe применяется только с --format csv",
  "refusing to write export data to a terminal: add -o file or redirect stdout": "данные экспорта не выводятся в терминал: добавьте -o файл или перенаправьте stdout",
  "a plaintext export needs confirmation: without a terminal, add --confirm-plaintext (or encrypt it with --age <recipient>)": "для экспорта в открытом виде нужно подтверждение: без терминала добавьте --confirm-plaintext (или зашифруйте его с --age <recipient>)",
  "This writes your passwords unencrypted.": "Пароли будут записаны без шифрования.",
  "exported %d entries (%s, encrypted with age) to %s": {
    one: "экспортирована %d запись (%s, зашифровано с помощью age) в %s",
    few: "экспортированы %d записи (%s, зашифровано с помощью age) в %s",
    many: "экспортировано %d записей (%s, зашифровано с помощью age) в %s",
  },
  "exported %d entries (%s, plaintext) to %s": {
    one: "экспортирована %d запись (%s, в открытом виде) в %s",
    few: "экспортированы %d записи (%s, в открытом виде) в %s",
    many: "экспортировано %d записей (%s, в открытом виде) в %s",
  },
  "CSV has no column for custom fields: %d fields were left out (otp fields included); use --format json or bitwarden-json to keep them": {
    one: "в CSV нет столбца для дополнительных полей: %d поле не попало в экспорт (включая поля otp); чтобы сохранить их, используйте --format json или bitwarden-json",
    few: "в CSV нет столбца для дополнительных полей: %d поля не попали в экспорт (включая поля otp); чтобы сохранить их, используйте --format json или bitwarden-json",
    many: "в CSV нет столбца для дополнительных полей: %d полей не попало в экспорт (включая поля otp); чтобы сохранить их, используйте --format json или bitwarden-json",
  },

  // src/fsx/dirs.ts
  "mkdirs: %s is not an absolute path": "mkdirs: %s — не абсолютный путь",
  "%s is not a folder": "%s — не папка",
  "mkdirP: %s is not an absolute path": "mkdirP: %s — не абсолютный путь",

  // src/fsx/files.ts
  "not a regular file": "не обычный файл",
  "the file is larger than %s": "файл больше %s",

  // src/fsx/lock.ts
  "locking %s: %w": "блокировка %s: %w",
  "stopped waiting for another passh process: %w": "ожидание другого процесса passh прекращено: %w",
  "another passh process has held %s for %s": "другой процесс passh удерживает %s уже %s",

  // src/fsx/temp.ts
  "locking the temporary file: %w": "блокировка временного файла: %w",
  "temporary files keep disappearing": "временные файлы всё время исчезают",

  // src/gen/index.ts
  "invalid password length %d": "недопустимая длина пароля %d",
  "reading random bytes: %w": "чтение случайных байтов: %w",
  "the alphabet must have 2 to 256 characters": "в алфавите должно быть от 2 до 256 символов",
  "the alphabet is not valid UTF-8": "алфавит не является корректным UTF-8",
  "the alphabet holds a control or space character": "в алфавите есть управляющий символ или пробел",
  "the alphabet holds %q twice": "в алфавите дважды встречается %q",
  "length %q: give a number from 1 to 4096": "длина %q: укажите число от 1 до 4096",

  // src/importpass/gpg.ts
  "gpg not found: import pass needs GnuPG (gpg) to decrypt the store": "gpg не найден: import pass нужен GnuPG (gpg), чтобы расшифровать хранилище pass",
  "no secret key for key ID %s": "нет секретного ключа для ID ключа %s",
  "bad passphrase": "неверная парольная фраза",
  "no passphrase given": "парольная фраза не введена",
  "not an OpenPGP message (damaged file?)": "не сообщение OpenPGP (файл повреждён?)",
  "gpg reported %s": "gpg сообщил %s",
  "gpg failed (exit status %d)": "ошибка gpg (код завершения %d)",
  "gpg did not report a successful decryption": "gpg не сообщил об успешной расшифровке",
  "gpg: %w": "gpg: %w",

  // src/importpass/importpass.ts
  "larger than 1 MiB": "больше 1 MiB",
  "Decrypting %d/%d…": "Расшифровка %d/%d…",
  "import canceled at the passphrase prompt": "импорт отменён при запросе парольной фразы",
  "the decrypted entry is larger than %d MiB": "расшифрованная запись больше %d MiB",
  "nothing was imported: %w": "ничего не импортировано: %w",

  // src/importpass/report.ts
  " (%d replacing entries already in the vault)": " (из них заменяют записи, уже имеющиеся в хранилище: %d)",
  "Dry run: nothing was decrypted or saved. Store: %s": "Пробный запуск: ничего не расшифровано и не сохранено. Хранилище pass: %s",
  "Would import %d entries:": {
    one: "Будет импортирована %d запись:",
    few: "Будут импортированы %d записи:",
    many: "Будет импортировано %d записей:",
  },
  "%s  (replaces the entry in the vault)": "%s  (заменит запись в хранилище)",
  "Would import %d entries%s.": {
    one: "Будет импортирована %d запись%s.",
    few: "Будут импортированы %d записи%s.",
    many: "Будет импортировано %d записей%s.",
  },
  "Imported %d entries%s from %s.": {
    one: "Импортирована %d запись%s из %s.",
    few: "Импортированы %d записи%s из %s.",
    many: "Импортировано %d записей%s из %s.",
  },
  "Would skip %d: %s.": "Будет пропущено %d: %s.",
  "Skipped %d: %s.": "Пропущено %d: %s.",

  // src/importpass/root.ts
  "pass store: %w": "хранилище pass: %w",

  // src/importpass/skips.ts (shown after a count, "3 invalid path", and after "— ")
  "invalid path": "недопустимый путь",
  "already in the vault": "уже в хранилище",
  "duplicate path": "повторяющийся путь",
  "symlink leads outside the store": "символическая ссылка ведёт за пределы хранилища pass",
  "broken symlink": "битая символическая ссылка",
  "symlink to a folder": "символическая ссылка на папку",
  unreadable: "не читается",
  "too large": "слишком большой",
  "decryption failed": "расшифровать не удалось",
  "not a text entry": "не текстовая запись",

  // src/importpass/walk.ts
  "not followed": "не раскрывается",
  "pass store %s: %w": "хранилище pass %s: %w",
  "same path as %s": "тот же путь, что у %s",
  "use --overwrite to replace it": "чтобы заменить её, используйте --overwrite",

  // src/keys/errors.ts
  "passphrase is empty": "парольная фраза пуста",
  "key block asks for scrypt work factor 2^%d; passh uses 2^18: the file is damaged or not made by passh": "блок ключа требует коэффициент сложности scrypt 2^%d; passh использует 2^18: файл повреждён или создан не passh",
  "wrong passphrase, or the key block is damaged": "неверная парольная фраза или повреждён блок ключа",
  "the key block is damaged: it doesn't hold exactly one vault key": "блок ключа повреждён: в нём не ровно один ключ хранилища",
  "data is damaged; restore a backup (the data block isn't encrypted to this vault's key: damaged or replaced)": "данные повреждены; восстановите резервную копию (блок данных не зашифрован ключом этого хранилища: повреждён или подменён)",
  "this key doesn't open this vault (rekeyed elsewhere? wrong recovery key?)": "этот ключ не открывает это хранилище (ключ хранилища сменили на другом компьютере? не тот ключ восстановления?)",
  "data is damaged; restore a backup": "данные повреждены; восстановите резервную копию",

  // src/keys/recovery.ts
  "not a valid recovery key: nothing was typed": "недействительный ключ восстановления: ничего не введено",
  "not a valid recovery key: it must start with AGE-SECRET-KEY-1": "недействительный ключ восстановления: он должен начинаться с AGE-SECRET-KEY-1",
  "not a valid recovery key: group %d, character %d is not used in keys (B, I, O and 1 never appear after AGE-SECRET-KEY-1)": "недействительный ключ восстановления: группа %d, символ %d не используется в ключах (B, I, O и 1 никогда не встречаются после AGE-SECRET-KEY-1)",
  "not a valid recovery key: it has %d characters after AGE-SECRET-KEY-1 instead of 58; a character is missing or extra": "недействительный ключ восстановления: после AGE-SECRET-KEY-1 в нём %d символов вместо 58; какой-то символ пропущен или лишний",
  "recovery key has a typo (checksum mismatch)": "в ключе восстановления опечатка (не совпадает контрольная сумма)",

  // src/keys/strength.ts (reasons follow "weak passphrase: ")
  "this is a top-10 common password": "это один из 10 самых распространённых паролей",
  "this is a top-100 common password": "это один из 100 самых распространённых паролей",
  "this is a very common password": "это очень распространённый пароль",
  "this is similar to a commonly used password": "это похоже на распространённый пароль",
  "names and surnames by themselves are easy to guess": "имена и фамилии сами по себе легко угадать",
  "common names and surnames are easy to guess": "распространённые имена и фамилии легко угадать",
  "a word by itself is easy to guess": "одно слово само по себе легко угадать",
  "common words are easy to guess": "распространённые слова легко угадать",
  "straight rows of keys are easy to guess": "прямые ряды клавиш легко угадать",
  "short keyboard patterns are easy to guess": "короткие узоры на клавиатуре легко угадать",
  "repeats like \"aaa\" are easy to guess": "повторы вроде \"aaa\" легко угадать",
  "repeats like \"abcabcabc\" are only slightly harder to guess than \"abc\"": "повторы вроде \"abcabcabc\" угадать лишь немного сложнее, чем \"abc\"",
  "sequences like abc or 6543 are easy to guess": "последовательности вроде abc или 6543 легко угадать",
  "recent years are easy to guess": "недавние годы легко угадать",
  "dates are often easy to guess": "даты часто легко угадать",
  "it is empty or too short": "она пуста или слишком коротка",
  "warning: weak passphrase; use 6 or more random words": "предупреждение: слабая парольная фраза; используйте 6 или больше случайных слов",
  "warning: weak passphrase: %s; use 6 or more random words": "предупреждение: слабая парольная фраза: %s; используйте 6 или больше случайных слов",

  // src/main.ts
  "disabling core dumps: %s": "отключение дампов памяти: %s",

  // src/model/data.ts
  "made by a newer passh; upgrade passh (data version)": "создано более новой версией passh; обновите passh (версия данных)",
  "invalid vault data: %w": "некорректные данные хранилища: %w",
  "expected an object, got null": "ожидался объект, получен null",
  "format is not \"passh-vault-data\"": "format — не \"passh-vault-data\"",
  "missing or bad version": "поле version отсутствует или некорректно",
  "unsupported version %d": "неподдерживаемая версия %d",
  "missing or bad vault_id": "поле vault_id отсутствует или некорректно",
  "missing or bad revision": "поле revision отсутствует или некорректно",
  "field key %q is not valid (letters, digits, then also _ . -)": "недопустимый ключ поля %q (буквы и цифры, далее также _ . -)",
  "%q can't be a custom field key": "%q не может быть ключом дополнительного поля",
  "invalid entry: %w": "некорректная запись: %w",
  "%s is not valid UTF-8": "поле %s не является корректным UTF-8",
  "%s must be a single line": "поле %s должно быть одной строкой",
  "invalid tag %q: it isn't normalized": "недопустимый тег %q: он не нормализован",
  "field key %q is not valid UTF-8": "ключ поля %q не является корректным UTF-8",
  "field %s is not valid UTF-8": "поле %s не является корректным UTF-8",
  "field %s must be a single line": "поле %s должно быть одной строкой",
  "notes are not valid UTF-8": "поле notes не является корректным UTF-8",
  "entry %d: %w": "запись %d: %w",
  "missing vault_id": "нет vault_id",
  "vault_id is not valid UTF-8": "vault_id не является корректным UTF-8",
  "entry %d: missing id": "запись %d: нет id",
  "entry %d: missing path": "запись %d: нет path",
  "entry %d: invalid path: %w": "запись %d: недопустимый путь: %w",
  "entry %d: path %q isn't in NFC": "запись %d: путь %q не в NFC",
  "entry %d: duplicate id %q": "запись %d: повторяющийся id %q",
  "entry %d: duplicate path %q": "запись %d: повторяющийся путь %q",
  "tombstone %d: missing id": "отметка об удалении %d: нет id",

  // src/model/ops.ts
  "%s: already exists": "%s: уже существует",
  "entry %s: not found": "запись %s: не найдена",
  "can't move the folder %s into itself": "нельзя переместить папку %s в саму себя",
  "the vault is at the largest revision (%d); it can't be saved again": "у хранилища наибольшая возможная ревизия (%d); сохранить его снова нельзя",

  // src/model/time.ts
  "bad time %q": "некорректное время %q",
  "time %q is out of range": "время %q вне допустимого диапазона",

  // src/paths/index.ts (path reasons follow "invalid path: ")
  "it is empty": "он пуст",
  "it is not valid UTF-8": "он не является корректным UTF-8",
  "it is longer than 1024 bytes": "он длиннее 1024 байт",
  "it contains a control character": "в нём есть управляющий символ",
  "it starts with /": "он начинается с /",
  "it ends with /": "он заканчивается на /",
  "it has an empty segment (//)": "в нём есть пустой сегмент (//)",
  "it has a \".\" or \"..\" segment": "в нём есть сегмент \".\" или \"..\"",
  "a segment starts with -": "сегмент начинается с -",
  "invalid path: %w": "недопустимый путь: %w",
  "invalid folder: %w": "недопустимый путь папки: %w",
  "%s: no such folder": "%s: нет такой папки",
  "invalid tag %q: not valid UTF-8": "недопустимый тег %q: не является корректным UTF-8",
  "invalid tag: a tag can't be empty": "недопустимый тег: тег не может быть пустым",
  "invalid tag %q: it contains a comma": "недопустимый тег %q: в нём есть запятая",
  "invalid tag %q: it contains a control character": "недопустимый тег %q: в нём есть управляющий символ",

  // src/tty/lineedit.ts
  interrupted: "прервано",
  "passphrase longer than %d bytes": "парольная фраза длиннее %d байт",
  "input longer than %d bytes": "ввод длиннее %d байт",

  // src/tty/prompts.ts
  "not confirmed": "не подтверждено",
  "Passphrase: ": "Парольная фраза: ",
  "reading the passphrase: %w": "чтение парольной фразы: %w",
  "New passphrase: ": "Новая парольная фраза: ",
  "Repeat passphrase: ": "Повторите парольную фразу: ",
  "The passphrase must not be empty.": "Парольная фраза не может быть пустой.",
  "Passphrases don't match. Try again.": "Парольные фразы не совпадают. Попробуйте ещё раз.",
  "passphrases don't match": "парольные фразы не совпадают",
  "Password (empty to generate): ": "Пароль (пусто — сгенерировать): ",
  "Repeat password: ": "Повторите пароль: ",
  "The password must not be empty.": "Пароль не может быть пустым.",
  "Passwords don't match. Try again.": "Пароли не совпадают. Попробуйте ещё раз.",
  "passwords don't match": "пароли не совпадают",
  "Please answer y or n.": "Ответьте д или н.",
  "Type %s to confirm: ": "Введите %s для подтверждения: ",
  "not confirmed: no answer": "не подтверждено: нет ответа",
  "not confirmed: you didn't type %s": "не подтверждено: вы не ввели %s",

  // src/tty/tty.ts
  "reading the terminal state: %w": "чтение состояния терминала: %w",
  "setting the terminal state: %w": "установка состояния терминала: %w",

  // src/vault/backups.ts
  "no automatic backups of this vault were found; use another copy (passh verify --full <copy>)": "автоматических резервных копий этого хранилища не найдено; используйте другую копию (passh verify --full <copy>)",
  "automatic backups of this vault, newest first:": "автоматические резервные копии этого хранилища, сначала новые:",
  "automatic backups on this machine, newest first:": "автоматические резервные копии на этом компьютере, сначала новые:",
  "old automatic backups couldn't be removed: %v": "старые автоматические резервные копии не удалось удалить: %v",

  // src/vault/commands.ts
  "Continue with this copy?": "Продолжить с этой копией?",
  "this machine hasn't seen this vault before": "это хранилище ещё не открывалось на этом компьютере",
  "OK: the newest revision seen on this machine (r%d)": "ОК: самая новая ревизия из открывавшихся на этом компьютере (r%d)",
  "OK: newer than seen before on this machine (r%d)": "ОК: новее той, что уже открывалась на этом компьютере (r%d)",
  "OLDER than seen before on this machine (seen r%d of %s)": "СТАРЕЕ той, что уже открывалась на этом компьютере (открывалась r%d от %s)",
  "note: %s": "примечание: %s",
  "note: the file isn't in passh's canonical form (line endings or line wrapping changed in copying); it opens, and `passh backup` writes a canonical copy": "примечание: файл не в канонической форме passh (при копировании изменились концы строк или переносы); он открывается, а `passh backup` запишет каноническую копию",
  "this copy is older than one seen before on this machine (r%d of %s; seen r%d of %s). If you didn't restore it on purpose, the file may have been replaced.": "эта копия старее той, что уже открывалась на этом компьютере (r%d от %s; открывалась r%d от %s). Если вы не восстанавливали её намеренно, файл мог быть подменён.",
  "%s doesn't pass the structure check, so it isn't copied: %w": "%s не проходит проверку структуры, поэтому не копируется: %w",
  "%s: a file already exists there; passh doesn't overwrite files": "%s: там уже есть файл; passh не перезаписывает файлы",
  "%s (SHA-256 %s, expected %s): the copy didn't read back as written; nothing was written under its name": "%s (SHA-256 %s, ожидалось %s): копия при обратном чтении не совпала с записанной; под этим именем ничего не записано",
  "%s is written, but its folder couldn't be synced: %w": "%s записан, но его папку не удалось синхронизировать: %w",
  "Backed up %s to %s.": "Хранилище %s скопировано в %s.",
  "The copy is byte for byte the vault; `passh verify` shows the same SHA-256 for both.": "Копия побайтно совпадает с хранилищем; `passh verify` покажет для обоих одинаковый SHA-256.",
  "The vault isn't in canonical form, so the copy was written in canonical form;": "Хранилище не в канонической форме, поэтому копия записана в канонической форме;",
  "its SHA-256 differs from the vault's, and the stock age tool reads its blocks (§8).": "её SHA-256 отличается от SHA-256 хранилища, а стандартная утилита age читает её блоки (§8).",
  "note: %s can't be read (%v); listing every automatic backup on this machine": "примечание: %s не читается (%v); выводятся все автоматические резервные копии на этом компьютере",
  "note: no backup has this vault's current key block (it was changed by passwd or rekey and not saved since, or the file is damaged); listing every automatic backup on this machine":
    "примечание: ни в одной резервной копии нет текущего блока ключа этого хранилища (его изменили passwd или rekey и с тех пор не сохраняли, или файл повреждён); выводятся все автоматические резервные копии на этом компьютере",
  "No automatic backups yet. passh makes one before each save (backup.keep = %d).": "Автоматических резервных копий пока нет. passh делает копию перед каждым сохранением (backup.keep = %d).",

  // src/vault/create.ts
  "creating the vault's folder: %w": "создание папки хранилища: %w",
  "removing leftover temporary files: %w": "удаление оставшихся временных файлов: %w",
  "creating the vault file: %w": "создание файла хранилища: %w",
  "the vault's folder couldn't be flushed to disk: %v": "папку хранилища не удалось сбросить на диск: %v",

  // src/vault/errors.ts
  "vault changed on disk after it was opened (another passh, a sync tool or a copy); nothing was saved: reload and repeat the change": "хранилище изменилось на диске после открытия (другой passh, синхронизация или копирование); ничего не сохранено: перечитайте его и повторите изменение",
  "vault is being saved by another passh process; nothing was saved: try again": "хранилище сохраняет другой процесс passh; ничего не сохранено: попробуйте ещё раз",
  "this is an automatic backup: copy it out first (e.g. over the vault file) and open the copy": "это автоматическая резервная копия: сначала скопируйте её в другое место (например, поверх файла хранилища) и откройте копию",
  "the key block is damaged: set a new passphrase first (passh recover)": "блок ключа повреждён: сначала задайте новую парольную фразу (passh recover)",
  "vault is locked: run `passh unlock` in a terminal (over SSH: `ssh -t host passh unlock`)": "хранилище заблокировано: выполните `passh unlock` в терминале (через SSH: `ssh -t host passh unlock`)",
  "stopped: this copy is older than one seen before on this machine; nothing was changed": "остановлено: эта копия старее той, что уже открывалась на этом компьютере; ничего не изменено",
  "%s: a file already exists there": "%s: там уже есть файл",
  "the save was cancelled; nothing was saved": "сохранение отменено; ничего не сохранено",
  "no vault at %s: run `passh init` to create one, or pass --vault <file>": "нет хранилища по пути %s: выполните `passh init`, чтобы создать его, или укажите --vault <file>",
  "vault %s: %w": "хранилище %s: %w",
  "The key block only protects the vault key with the passphrase: if the data block is intact, `passh recover` with the paper recovery key writes a new key block; or restore a backup (passh backups)":
    "Блок ключа лишь защищает ключ хранилища парольной фразой: если блок данных цел, `passh recover` с бумажным ключом восстановления запишет новый блок ключа; или восстановите резервную копию (passh backups)",
  "The key block only protects the vault key with the passphrase: if the data block is intact, `passh recover` with the paper recovery key writes a new key block":
    "Блок ключа лишь защищает ключ хранилища парольной фразой: если блок данных цел, `passh recover` с бумажным ключом восстановления запишет новый блок ключа",

  // src/vault/keysources.ts
  "Wrong passphrase. Try again.": "Неверная парольная фраза. Попробуйте ещё раз.",
  "Type the recovery key from the paper sheet (AGE-SECRET-KEY-1…); it shows as *.": "Введите ключ восстановления с бумажного листа (AGE-SECRET-KEY-1…); он отображается как *.",
  "Spaces, line breaks and letter case don't matter. End with an empty line.": "Пробелы, переводы строк и регистр букв не важны. Завершите ввод пустой строкой.",
  "%v. Type it again.": "%v. Введите его ещё раз.",
  "this recovery key doesn't open %s: it belongs to another vault, or the vault was rekeyed after the sheet was printed": "этот ключ восстановления не открывает %s: он от другого хранилища, или ключ хранилища сменили после печати листа",

  // src/vault/open.ts
  "%s: the key block is damaged; setting a new passphrase rewrites it": "%s: блок ключа повреждён; задание новой парольной фразы перезапишет его",
  "%s: data is damaged; restore a backup (%w)%v": "%s: данные повреждены; восстановите резервную копию (%w)%v",

  // src/vault/rollback.ts
  "%s was written by a newer passh (version %d)": "файл %s записан более новой версией passh (версия %d)",
  "the rollback record wasn't updated: %v": "журнал ревизий не обновлён: %v",
  "the rollback record %s is damaged; a new one is started, so older copies aren't detected this time": "журнал ревизий %s повреждён; начат новый, поэтому старые копии на этот раз не распознаются",
  "the rollback record can't be used, so older copies aren't detected: %v": "журнал ревизий нельзя использовать, поэтому старые копии не распознаются: %v",

  // src/vault/save.ts
  "creating the state folder: %w": "создание папки состояния: %w",
  "opening the lock file: %w": "открытие файла блокировки: %w",
  "reading the vault file again: %w": "повторное чтение файла хранилища: %w",
  "writing the new vault file: %w; the vault is unchanged": "запись нового файла хранилища: %w; хранилище не изменено",
  "the new vault file didn't read back as written; the vault is unchanged: %w": "новый файл хранилища при обратном чтении не совпал с записанным; хранилище не изменено: %w",
  "the bytes read differ from those written": "прочитанные байты отличаются от записанных",
  "the key block differs": "блок ключа отличается",
  "the data differs from what was serialized": "данные отличаются от сериализованных",
  "vault_id, revision or number of entries differ": "отличаются vault_id, revision или число записей",
  "%s (a temporary name: move it elsewhere before the next save, which would remove it)": "%s (временное имя: перенесите файл в другое место до следующего сохранения, которое его удалит)",
  "replacing the vault file: %w; the vault is unchanged": "замена файла хранилища: %w; хранилище не изменено",
  "the replaced vault file couldn't be checked (%v); it is kept in %v": "заменённый файл хранилища не удалось проверить (%v); он сохранён в %v",
  "the replaced vault file couldn't be removed (the next save removes it): %v": "заменённый файл хранилища не удалось удалить (его удалит следующее сохранение): %v",
  "%w; the save couldn't be undone (%v): the vault now holds this save, the other version is in %v": "%w; сохранение не удалось отменить (%v): в хранилище теперь это сохранение, другая версия — в %v",
  "%w; a file that was in its place is kept in %v": "%w; файл, который был на его месте, сохранён в %v",
  "the new vault file couldn't be closed: %v": "новый файл хранилища не удалось закрыть: %v",
  "making the automatic backup: %w; the vault is unchanged": "создание автоматической резервной копии: %w; хранилище не изменено",

  // src/vaultfile/errors.ts
  "not a passh vault": "не хранилище passh",
  "not a passh vault: unknown container version 0": "не хранилище passh: неизвестная версия контейнера 0",
  "made by a newer passh; upgrade passh (container version %d)": "создано более новой версией passh; обновите passh (версия контейнера %d)",
  "file is truncated: %s": "файл обрезан: %s",
  "file is damaged (block %d): %s": "файл повреждён (блок %d): %s",
  "the file is empty": "файл пуст",
  "it ends in the passh-vault line": "он заканчивается строкой passh-vault",
  "block %d is missing": "блок %d отсутствует",
  "block %d is cut short": "блок %d оборван",
  "block %d has no END line": "у блока %d нет строки END",
  "its BEGIN line is missing or damaged": "его строка BEGIN отсутствует или повреждена",
  "its END line is missing or damaged": "его строка END отсутствует или повреждена",
  "bad base64": "некорректный base64",
  "the block is empty": "блок пуст",
  "bad age header": "некорректный заголовок age",
  "the key block isn't encrypted with a passphrase": "блок ключа не зашифрован парольной фразой",
  "the data block isn't encrypted to a vault key": "блок данных не зашифрован ключом хранилища",
  "the encrypted data has an impossible size (cut short or extended)": "у зашифрованных данных невозможный размер (обрезаны или дополнены)",
  "ignored %d lines of text before the passh-vault line": {
    one: "пропущена %d строка текста перед строкой passh-vault",
    few: "пропущены %d строки текста перед строкой passh-vault",
    many: "пропущено %d строк текста перед строкой passh-vault",
  },
  "ignored %d lines of text after the last END line": {
    one: "пропущена %d строка текста после последней строки END",
    few: "пропущены %d строки текста после последней строки END",
    many: "пропущено %d строк текста после последней строки END",
  },
  "not a passh vault: the file is larger than 64 MiB": "не хранилище passh: файл больше 64 MiB",
  "%s is larger than 64 MiB: not a passh vault": "%s больше 64 MiB: это не хранилище passh",
  "not a passh vault: not a regular file": "не хранилище passh: не обычный файл",
  "%s is not a regular file": "%s — не обычный файл",
  "the vault file would be %d bytes, larger than 64 MiB, which passh can't open; nothing was saved": "файл хранилища занял бы %d байт, больше 64 MiB, а такой passh открыть не может; ничего не сохранено",
};
