// Russian texts of the print area (sheets, print page, its server and dialog), to be merged
// into the ru catalogue by the lead. The sheet frame strings (print.md §8) are normative;
// the rest follows the glossary of docs/translations.md (wording not normative, i18n.md).

import type { Catalog } from "../i18n/index.ts";

export const PRINT_CATALOG_RU: Catalog = {
  // print.md §8: sheet frame strings (normative)
  CONFIDENTIAL: "КОНФИДЕНЦИАЛЬНО",
  "passh password sheet": "лист паролей passh",
  "passh paper recovery key": "ключ восстановления passh",
  "page %d of %d": "страница %d из %d",
  "printed %s": "напечатано %s",
  "%d entries": { one: "%d запись", few: "%d записи", many: "%d записей" },
  "folder %s": "папка %s",
  "tag %s": "тег %s",
  "tags %s": "теги %s",
  "fields: %s": "поля: %s",
  "(top level)": "(верхний уровень)",
  "%s (continued)": "%s (продолжение)",
  "Under 0 O 1 l I and spaces: D digit, U capital letter, L small letter, S space": "Под 0 O 1 l I и пробелами: D — цифра, U — заглавная, L — строчная, S — пробел",
  "%s continues the line above; \\uXXXX is a character that can't be printed": "%s продолжает строку выше; \\uXXXX — символ, который нельзя напечатать",
  "Vault key": "Ключ хранилища",
  "Forgotten passphrase": "Если забыта парольная фраза",
  "Without passh": "Без passh",
  "# asks for the passphrase": "# запросит парольную фразу",
  "QR code of the vault key": "QR-код ключа хранилища",

  // Recovery key sheet prose
  "Whoever has this sheet and a copy of the vault can read everything in the vault.": "Тот, у кого есть этот лист и копия хранилища, может прочитать всё, что есть в хранилище.",
  "Keep it offline, like cash. If it may have been seen, copied or lost, run `passh rekey` and print a new sheet: the old key then no longer opens new versions of the vault (copies made before still open with it).":
    "Храните его вне сети, как наличные. Если его могли увидеть, скопировать или потерять, выполните `passh rekey` и распечатайте новый лист: старый ключ тогда больше не откроет новые версии хранилища (копии, сделанные раньше, им по-прежнему открываются).",
  "After AGE-SECRET-KEY-1 the key never has the letters B, I or O or the digit 1: 0 is always the digit zero.": "После AGE-SECRET-KEY-1 в ключе не бывает букв B, I и O и цифры 1: 0 — это всегда цифра ноль.",
  "The key's QR code is on the web page (`passh recovery-key print --web`).": "QR-код ключа есть на странице печати (`passh recovery-key print --web`).",
  "Run `passh recover` and type the key above. Spaces, line breaks and letter case are ignored, and the key's checksum catches typos. passh then asks for a new passphrase.":
    "Выполните `passh recover` и введите ключ, напечатанный выше. Пробелы, переводы строк и регистр букв не важны, а контрольная сумма ключа выявляет опечатки. Затем passh запросит новую парольную фразу.",
  "On any machine with age (https://age-encryption.org) v1.0 or later, where vault.passh is a copy of the vault file:": "На любом компьютере с age (https://age-encryption.org) версии 1.0 или новее, где vault.passh — копия файла хранилища:",
  "With this key instead of the passphrase: write it to /dev/shm/key.txt as one line, without spaces, in capital letters as printed (AGE-SECRET-KEY-1 and then the groups), instead of running the first and third commands. The other commands stay the same.":
    "С этим ключом вместо парольной фразы: запишите его в /dev/shm/key.txt одной строкой, без пробелов, заглавными буквами, как напечатано (AGE-SECRET-KEY-1, затем группы), вместо первой и третьей команд. Остальные команды те же.",
  "vault.json is plaintext. Keep it on tmpfs (/dev/shm on Linux) and delete it when done.": "vault.json — открытый текст. Держите его на tmpfs (/dev/shm в Linux) и удалите, когда закончите.",
  "If a mail client or editor re-wrapped the lines, age may reject the blocks. passh still opens such a file, and `passh backup` writes it back in canonical form.":
    "Если почтовый клиент или редактор перенёс строки, age может отвергнуть блоки. passh всё равно открывает такой файл, а `passh backup` записывает его обратно в канонической форме.",

  // The page and its error bodies
  "Print with Ctrl+P (Cmd+P on a Mac), then close this tab. This page was served once and is gone from passh; the browser may still keep it in its session history.":
    "Распечатайте с помощью Ctrl+P (Cmd+P на Mac), затем закройте эту вкладку. Страница отдана один раз, и в passh её больше нет; браузер может хранить её в истории сеанса.",
  "misdirected request: unknown host": "запрос не по адресу: неизвестный хост",
  "method not allowed": "метод не разрешён",
  "already used: start the print page again in passh": "уже использована: снова запустите страницу печати в passh",
  "stopped after too many wrong addresses: start the print page again in passh": "остановлена после слишком многих неверных адресов: снова запустите страницу печати в passh",

  // Server start, addresses, certificate
  "the print page is off: set enabled = true in the [print_web] table of the config file": "страница печати выключена: задайте enabled = true в таблице [print_web] конфигурационного файла",
  "print_web.ttl: %s is not between 1m0s and 15m0s": "print_web.ttl: %s не в пределах от 1m0s до 15m0s",
  "print_web.port: %d is not between 1 and 65535": "print_web.port: %d не в пределах от 1 до 65535",
  "print_web.hostnames: %q is not a hostname": "print_web.hostnames: %q — не имя хоста",
  'print_web.allow_from: %q is not a CIDR such as "192.168.1.0/24" or "fd00::/8"': 'print_web.allow_from: %q — не CIDR вида "192.168.1.0/24" или "fd00::/8"',
  "%s: no such network interface": "%s: нет такого сетевого интерфейса",
  "%s: no address": "%s: нет адреса",
  "%s: %s is link-local, not used": "%s: %s — адрес link-local, не используется",
  "%s: %s is the wildcard address, never used": "%s: %s — адрес «любой», никогда не используется",
  "%s: %s is a loopback address, not private": "%s: %s — адрес обратной петли, не частный",
  "%s: %s is a multicast address, not used": "%s: %s — групповой адрес, не используется",
  "%s: %s is a public address, refused": "%s: %s — публичный адрес, отклонён",
  'print_web.interfaces is empty: name the interfaces of your LAN or VPN, e.g. ["eth0", "wg0"]': 'print_web.interfaces пуст: укажите интерфейсы вашей локальной сети или VPN, например ["eth0", "wg0"]',
  "the print page has no private address to listen on (print_web.interfaces): %s": "у страницы печати нет частного адреса для приёма соединений (print_web.interfaces): %s",
  "not used: %s": "не используется: %s",
  "print page: %s": "страница печати: %s",
  "print page certificate folder %s is not a folder": "папка сертификата страницы печати %s — не папка",
  "print page certificate folder %s: %v": "папка сертификата страницы печати %s: %v",
  "print page certificate: can't create a temporary file in %s": "сертификат страницы печати: не удаётся создать временный файл в %s",
  "first use": "первое использование",
  "the stored certificate can't be read: %v": "сохранённый сертификат нельзя прочитать: %v",
  "the stored key can't be read: %v": "сохранённый ключ нельзя прочитать: %v",
  "the stored key is not a regular file": "сохранённый ключ — не обычный файл",
  "the stored key had mode %s, readable by others": "у сохранённого ключа были права %s, его могли читать другие",
  "the stored certificate can't be used: %v": "сохранённый сертификат нельзя использовать: %v",
  "the stored certificate is not valid until %s": "сохранённый сертификат действителен только с %s",
  "the stored certificate expired on %s": "срок сохранённого сертификата истёк %s",
  "the stored certificate expires on %s": "срок сохранённого сертификата истекает %s",
  "the addresses or hostnames changed: the old one doesn't cover %s": "адреса или имена хостов изменились: старый сертификат не покрывает %s",
  "made a new certificate for the print page (%s); browsers will warn about it: compare the fingerprint": "создан новый сертификат для страницы печати (%s); браузеры будут о нём предупреждать: сравните отпечаток",

  // Results (print.md §6.7)
  "the page was served to %s; if that wasn't you, start the print page again": "страница отдана %s; если это были не вы, снова запустите страницу печати",
  "the page was only partly sent to %s (%v); start the print page again": "страница лишь частично отправлена %s (%v); снова запустите страницу печати",
  "the print page was stopped while it was sent to %s": "страница печати остановлена во время отправки %s",
  "the print page was stopped": "страница печати остановлена",
  "the print page stopped after %s without being opened": "страница печати остановилась через %s, так и не открытая",
  "the print page stopped after 5 requests with a wrong address": "страница печати остановилась после 5 запросов с неверным адресом",

  // The dialog (print.md §6.9)
  "certificate SHA-256  %s": "сертификат SHA-256  %s",
  "Compare it with the fingerprint your browser shows before you accept the certificate.": "Сравните его с отпечатком, который показывает браузер, прежде чем принять сертификат.",
  "c copies the URL · Esc stops": "c копирует URL · Esc останавливает",
  "stops after one load or in %s": "остановится после одной загрузки или через %s",
  "URL copied · ": "URL скопирован · ",
  "copy failed · ": "копирование не удалось · ",
  "no clipboard · ": "нет буфера обмена · ",
  "Done: %s.": "Готово: %s.",

  // Commands (print.md §1, cli.md §2.17, §2.24)
  "PDF output was removed; use --web to print from a browser (it can save as PDF), or omit --format for the text sheet": "вывод в PDF удалён; используйте --web, чтобы распечатать из браузера (он может сохранить PDF), или уберите --format для текстового листа",
  "--output can't be used with --web": "--output нельзя использовать вместе с --web",
  "--confirm-plaintext can't be used with --web: the print page needs a terminal": "--confirm-plaintext нельзя использовать вместе с --web: странице печати нужен терминал",
  "invalid field %q: use password, username, url, tags, notes, fields, or the key of a custom field": "недопустимое поле %q: используйте password, username, url, tags, notes, fields или ключ дополнительного поля",
  "invalid field %q: no selected entry has a field with this key": "недопустимое поле %q: ни у одной выбранной записи нет поля с таким ключом",
  "no entries to print: the vault has no entries": "нечего распечатать: в хранилище нет записей",
  "no entries to print: none matches %s": "нечего распечатать: ни одна запись не подходит под %s",
  "refusing to write the sheet to a terminal: add -o file or redirect stdout": "лист не выводится в терминал: добавьте -o файл или перенаправьте stdout",
  "refusing to write the recovery key to a terminal: add -o file or redirect stdout": "ключ восстановления не выводится в терминал: добавьте -o файл или перенаправьте stdout",
  "The sheet holds your passwords unencrypted.": "Лист содержит ваши пароли без шифрования.",
  "printing needs confirmation: without a terminal, add --confirm-plaintext": "для печати нужно подтверждение: без терминала добавьте --confirm-plaintext",
  "printed %d entries (text sheet) to %s; print it, then delete the file": {
    one: "%d запись записана (текстовый лист) в %s; распечатайте его, затем удалите файл",
    few: "%d записи записаны (текстовый лист) в %s; распечатайте его, затем удалите файл",
    many: "%d записей записано (текстовый лист) в %s; распечатайте его, затем удалите файл",
  },
  "the print page needs a terminal (over SSH: use `ssh -t`)": "странице печати нужен терминал (через SSH: используйте `ssh -t`)",
  "passh %s needs a terminal (over SSH: use `ssh -t`)": "passh %s нужен терминал (через SSH: используйте `ssh -t`)",
  "Wrote the paper recovery key to %s.": "Бумажный ключ восстановления записан в %s.",
  "print it, keep the sheet offline, then delete the file: rm %s": "распечатайте его, храните лист вне сети, затем удалите файл: rm %s",
  "%s already exists; passh doesn't overwrite files": "%s уже существует; passh не перезаписывает файлы",
  "%s isn't on tmpfs: the plaintext is on persistent disk. Delete it when you're done": "%s не на tmpfs: открытый текст на постоянном диске. Удалите его, когда закончите",
  "%w; the partial file was removed": "%w; неполный файл удалён",
  "%w; the partial file %s could not be removed (%v): delete it": "%w; неполный файл %s не удалось удалить (%v): удалите его",
};
