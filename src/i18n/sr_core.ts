// Serbian (Latin script, ekavian) catalogue, area core (keys from src/ outside cli and tui). The English
// texts are the keys (i18n.md §4); terms follow the glossary of spec/docs/translations.md.
// Entries are grouped by the source file of their first call site.
// Left English on purpose: "EOF" (Go's io.EOF text); texts of Go's libraries inside a message
// ("dial unix …", "context deadline exceeded", "exec: …") stay as they are (i18n.md §3).

import type { Catalog } from "./index.ts";

export const SR_CORE: Catalog = {
  // src/age/recipients.ts
  "--age: invalid age recipient %q: %w": "--age: neispravan age primalac %q: %w",
  "--age: this is an age secret key; give its public recipient (age1…), as printed by age-keygen -y": "--age: ovo je tajni ključ age; navedite njegovog javnog primaoca (age1…), kako ga ispisuje age-keygen -y",
  "--age: the recipient is empty; give an age public key (age1…)": "--age: primalac je prazan; navedite javni ključ age (age1…)",
  "--age: not an age recipient; give an age public key (age1…)": "--age: nije age primalac; navedite javni ključ age (age1…)",

  // src/agent/client.ts
  "agent: %w": "agent: %w",
  "agent: connecting to %s: dial unix %s: connect: %w": "agent: povezivanje sa %s: dial unix %s: connect: %w",
  "agent: connecting to %s: dial unix %s: i/o timeout": "agent: povezivanje sa %s: dial unix %s: i/o timeout",
  "agent: refusing the agent socket %s: peer is uid %d, not uid %d": "agent: soket agenta %s se odbija: druga strana je uid %d, a ne uid %d",
  "agent: refusing the agent socket %s: %w": "agent: soket agenta %s se odbija: %w",
  "agent: reading the answer: context deadline exceeded": "agent: čitanje odgovora: context deadline exceeded",
  "agent: reading the answer: message too large": "agent: čitanje odgovora: poruka je prevelika",
  "agent: reading the answer: connection closed in the middle of a message": "agent: čitanje odgovora: veza je zatvorena usred poruke",
  "agent: the agent closed the connection without answering": "agent: agent je zatvorio vezu bez odgovora",
  "agent: reading the answer: %w": "agent: čitanje odgovora: %w",
  "agent: waiting for the agent (pid %d) to exit: %w": "agent: čekanje da se agent (pid %d) ugasi: %w",
  "agent: waiting for the agent (pid %d) to exit: context deadline exceeded": "agent: čekanje da se agent (pid %d) ugasi: context deadline exceeded",

  // src/agent/commands.ts
  "opening the vault: %w": "otvaranje trezora: %w",
  "%s: not a passh vault: %w": "%s: nije passh trezor: %w",
  "Already unlocked: %s.": "Već je otključano: %s.",
  "--ttl was not applied: the agent was already running; run `passh lock`, then `passh unlock --ttl …`": "--ttl nije primenjen: agent je već radio; pokrenite `passh lock`, pa `passh unlock --ttl …`",
  "--ttl must be more than zero": "--ttl mora biti veći od nule",
  "an agent is running, but the vault can't be checked against it: %w": "agent radi, ali trezor ne može da se proveri prema njemu: %w",
  "the running agent was unlocked with another key block (passwd elsewhere?); replacing it": "pokrenuti agent je otključan drugim blokom ključa (passwd negde drugde?); zamenjuje se",
  "passh unlock needs a terminal to ask for the passphrase (over SSH: `ssh -t host passh unlock`)": "za passh unlock je potreban terminal radi traženja pristupne fraze (preko SSH-a: `ssh -t host passh unlock`)",
  "agent: starting the agent: %w": "agent: pokretanje agenta: %w",
  "agent: starting the agent: the agent exited before it was ready": "agent: pokretanje agenta: agent se ugasio pre nego što je bio spreman",
  "agent: starting the agent: the agent didn't report ready within %s": "agent: pokretanje agenta: agent nije javio spremnost u roku od %s",
  "agent: the agent (pid %d) started but doesn't answer: %s": "agent: agent (pid %d) je pokrenut, ali ne odgovara: %s",
  "Unlocked %s: %s.": "Trezor %s je otključan: %s.",
  "Run `passh lock` to stop the agent now.": "Pokrenite `passh lock` da odmah zaustavite agenta.",
  "agent: the vault's key block isn't the one this agent was unlocked with": "agent: blok ključa trezora nije onaj kojim je ovaj agent otključan",
  "agent: starting the agent: another agent started meanwhile and exited": "agent: pokretanje agenta: u međuvremenu se pokrenuo drugi agent i ugasio se",
  "agent: starting the agent: %s": "agent: pokretanje agenta: %s",
  "agent: starting the agent: unexpected readiness line %q": "agent: pokretanje agenta: neočekivan red spremnosti %q",
  "No agent is running for %s.": "Nijedan agent ne radi za %s.",
  "Locked: the agent (pid %d) stopped.": "Zaključano: agent (pid %d) je zaustavljen.",
  "the agent couldn't be stopped: %s; stop it with `passh lock`": "agent nije mogao da se zaustavi: %s; zaustavite ga sa `passh lock`",
  "The agent held the old key and was stopped; run `passh unlock` again if you need it.": "Agent je imao stari ključ i zaustavljen je; ponovo pokrenite `passh unlock` ako vam treba.",
  "The agent was unlocked with the old key block and was stopped; run `passh unlock` again if you need it.": "Agent je bio otključan starim blokom ključa i zaustavljen je; ponovo pokrenite `passh unlock` ako vam treba.",
  "not running (`passh unlock` starts it)": "ne radi (`passh unlock` ga pokreće)",
  "%s doesn't exist yet; `passh unlock` creates it": "%s još ne postoji; napraviće je `passh unlock`",
  "%s (0700, yours)": "%s (0700, vaša)",
  "running: %s": "radi: %s",

  // src/agent/keysource.ts
  "the vault's key block isn't the one `passh unlock` opened (passwd elsewhere, or damaged): the agent's key isn't used; asking for the passphrase": "blok ključa trezora nije onaj koji je otvorio `passh unlock` (passwd negde drugde, ili je oštećen): ključ agenta se ne koristi; traži se pristupna fraza",
  "can't use the agent of %s: %s": "agent za %s ne može da se koristi: %s",

  // src/agent/protocol.ts
  "request too large": "zahtev je prevelik",
  "malformed request": "neispravan zahtev",
  "a key request must name the vault's key block (key_block)": "zahtev za ključ mora da navede blok ključa trezora (key_block)",
  "key_block is not a hex SHA-256": "key_block nije heksadecimalni SHA-256",
  "the vault's key block isn't the one this agent was unlocked with": "blok ključa trezora nije onaj kojim je ovaj agent otključan",
  "the agent has expired": "agentu je istekao rok",
  "not a vault key": "nije ključ trezora",
  "not a valid vault key": "nije ispravan ključ trezora",
  "agent: malformed answer": "agent: neispravan odgovor",
  "agent: the running agent speaks protocol version %d, this passh 1; kill it and run `passh unlock` again": "agent: pokrenuti agent govori verziju protokola %d, ovaj passh 1; zaustavite ga (kill) i ponovo pokrenite `passh unlock`",
  "agent: %v": "agent: %v",
  "agent: the agent refused the request: %v": "agent: agent je odbio zahtev: %v",
  "agent: the agent's answer holds no vault key": "agent: odgovor agenta ne sadrži ključ trezora",
  "agent: the agent's answer holds no valid vault key: %s": "agent: odgovor agenta ne sadrži ispravan ključ trezora: %s",

  // src/agent/server.ts
  "agent: listen unix %s: bind: %w": "agent: listen unix %s: bind: %w",
  "agent: connecting to %s: %w": "agent: povezivanje sa %s: %w",

  // src/agent/times.ts
  "the agent (pid %d) exits in %s": "agent (pid %d) će se ugasiti za %s",
  "the agent (pid %d) exits in %s if unused, in %s at the latest": "agent (pid %d) će se ugasiti za %s ako se ne koristi, a najkasnije za %s",

  // src/clipboard/index.ts
  "OSC 52 through the terminal": "OSC 52 preko terminala",
  "command %q": "komanda %q",
  "no clipboard: %s; copy with: passh show %s --field %s | pbcopy": "nema ostave: %s; kopirajte sa: passh show %s --field %s | pbcopy",
  "no clipboard: %s": "nema ostave: %s",
  "clipboard command: %w": "komanda za ostavu: %w",
  "clipboard.command: the program name is empty": "clipboard.command: ime programa je prazno",
  "clipboard.command: %w": "clipboard.command: %w",
  "OSC 52 needs a terminal and there is none, and clipboard.command is empty": "za OSC 52 je potreban terminal, a njega nema, i clipboard.command je prazan",
  "clipboard.osc52 is off and clipboard.command is empty": "clipboard.osc52 je isključen i clipboard.command je prazan",
  "Copied the %s of %s (%s); the clipboard clears in %s, Ctrl-C clears it now.": "Kopirano je polje %s stavke %s (%s); ostava se čisti za %s, Ctrl-C je čisti odmah.",
  "interrupted (%s), and clearing the clipboard failed: %w": "prekinuto (%s), a čišćenje ostave nije uspelo: %w",
  "clearing the clipboard failed: %w": "čišćenje ostave nije uspelo: %w",
  "Clipboard cleared.": "Ostava je očišćena.",

  // src/config/agentdir.ts
  "the agent's socket path is longer than 103 bytes even in /tmp": "putanja soketa agenta je duža od 103 bajta čak i u /tmp",
  "agent folder %s is not a directory (a symlink or a file); refusing to use it": "fascikla agenta %s nije direktorijum (simbolička veza ili datoteka); neće se koristiti",
  "opening the agent folder %s: %w": "otvaranje fascikle agenta %s: %w",
  "checking the agent folder %s: %w": "provera fascikle agenta %s: %w",
  "agent folder %s belongs to uid %d, not to you (uid %d); refusing to use it": "fascikla agenta %s pripada uid-u %d, a ne vama (uid %d); neće se koristiti",
  "agent folder %s has mode %s, not 0700; refusing to use it (fix it with chmod 700, or remove it)": "fascikla agenta %s ima dozvole %s, a ne 0700; neće se koristiti (popravite to sa chmod 700 ili je uklonite)",

  // src/config/paths.ts
  "$HOME (%q) is not an absolute path": "$HOME (%q) nije apsolutna putanja",

  // src/config/template.ts
  "vault path %q is not valid UTF-8, which TOML can't hold": "putanja trezora %q nije ispravan UTF-8, a TOML to ne može da sadrži",

  // src/editor/choose.ts
  "the editor command is empty": "komanda uređivača je prazna",

  // src/editor/edit.ts
  "creating the temporary folder: %w": "pravljenje privremene fascikle: %w",
  "the temporary folder %s is not on tmpfs": "privremena fascikla %s nije na tmpfs-u",
  "creating the temporary folder in %s: too many attempts": "pravljenje privremene fascikle u %s: previše pokušaja",
  "the edited file is larger than 16 MiB": "uređena datoteka je veća od 16 MiB",
  "removing the temporary folder %s: %w; remove it yourself, it holds the entry in plain text": "uklanjanje privremene fascikle %s: %w; uklonite je sami, u njoj je stavka kao otvoreni tekst",
  "editing interrupted by %s; nothing was changed": "uređivanje je prekinuto (%s); ništa nije promenjeno",
  "the editor failed (%w); nothing was changed": "uređivač nije uspeo (%w); ništa nije promenjeno",
  "warning: passh can't control backup, swap or history files of %s: they may keep a copy of the entry on disk. Graphical editors must also wait until the file is closed (e.g. code --wait).":
    "upozorenje: passh ne može da kontroliše datoteke rezervnih kopija, swap ni istorije programa %s: one mogu da zadrže kopiju stavke na disku. Grafički uređivači takođe moraju da sačekaju da se datoteka zatvori (npr. code --wait).",
  "The entry isn't valid: %s": "Stavka nije ispravna: %s",
  "Edit it again?": "Urediti je ponovo?",

  // src/editor/tmpfs.ts
  "no tmpfs for the temporary file (passh looks for one only on Linux): the entry would be written to disk in plain text; use the built-in form (passh edit without --editor)":
    "nema tmpfs-a za privremenu datoteku (passh ga traži samo na Linuxu): stavka bi bila upisana na disk kao otvoreni tekst; koristite ugrađeni obrazac (passh edit bez --editor)",
  "no tmpfs for the temporary file (checked $XDG_RUNTIME_DIR (%s) and /dev/shm): the entry would be written to disk in plain text; use the built-in form (passh edit without --editor)":
    "nema tmpfs-a za privremenu datoteku (provereni su $XDG_RUNTIME_DIR (%s) i /dev/shm): stavka bi bila upisana na disk kao otvoreni tekst; koristite ugrađeni obrazac (passh edit bez --editor)",
  "no tmpfs for the temporary file (checked /dev/shm): the entry would be written to disk in plain text; use the built-in form (passh edit without --editor)":
    "nema tmpfs-a za privremenu datoteku (proveren je /dev/shm): stavka bi bila upisana na disk kao otvoreni tekst; koristite ugrađeni obrazac (passh edit bez --editor)",

  // src/entrytext/index.ts
  "line %d: %w": "red %d: %w",
  "the text is not valid UTF-8": "tekst nije ispravan UTF-8",
  "username appears twice": "username se pojavljuje dvaput",
  "url appears twice": "url se pojavljuje dvaput",

  // src/errors.ts
  "interrupted (%s)": "prekinuto (%s)",

  // src/exec/lookpath.ts
  "exec: %q: %s": "exec: %q: %s",
  "exec: %q: %w": "exec: %q: %w",
  "exec: %w": "exec: %w",

  // src/exec/run.ts
  "the command is empty": "komanda je prazna",

  // src/exec/words.ts
  "unterminated single quote in %q": "nezatvoren jednostruki navodnik u %q",
  "unterminated double quote in %q": "nezatvoren dvostruki navodnik u %q",
  "trailing backslash in %q": "obrnuta kosa crta na kraju u %q",

  // src/export/export.ts
  "--format is required: csv, json or bitwarden-json": "--format je obavezan: csv, json ili bitwarden-json",
  "unknown export format %q (use csv, json or bitwarden-json)": "nepoznat format izvoza %q (koristite csv, json ili bitwarden-json)",
  "--age and --confirm-plaintext can't be used together": "--age i --confirm-plaintext ne mogu da se koriste zajedno",
  "--spreadsheet-safe applies only to --format csv": "--spreadsheet-safe važi samo za --format csv",
  "refusing to write export data to a terminal: add -o file or redirect stdout": "podaci izvoza se ne ispisuju na terminal: dodajte -o datoteka ili preusmerite stdout",
  "a plaintext export needs confirmation: without a terminal, add --confirm-plaintext (or encrypt it with --age <recipient>)": "izvoz kao otvoreni tekst traži potvrdu: bez terminala dodajte --confirm-plaintext (ili ga šifrujte sa --age <recipient>)",
  "This writes your passwords unencrypted.": "Ovim se vaše lozinke upisuju nešifrovane.",
  "exported %d entries (%s, encrypted with age) to %s": {
    one: "izvezena je %d stavka (%s, šifrovano age-om) u %s",
    few: "izvezene su %d stavke (%s, šifrovano age-om) u %s",
    many: "izvezeno je %d stavki (%s, šifrovano age-om) u %s",
  },
  "exported %d entries (%s, plaintext) to %s": {
    one: "izvezena je %d stavka (%s, kao otvoreni tekst) u %s",
    few: "izvezene su %d stavke (%s, kao otvoreni tekst) u %s",
    many: "izvezeno je %d stavki (%s, kao otvoreni tekst) u %s",
  },
  "CSV has no column for custom fields: %d fields were left out (otp fields included); use --format json or bitwarden-json to keep them": {
    one: "CSV nema kolonu za dodatna polja: %d polje je izostavljeno (uključujući otp polja); koristite --format json ili bitwarden-json da biste ih zadržali",
    few: "CSV nema kolonu za dodatna polja: %d polja su izostavljena (uključujući otp polja); koristite --format json ili bitwarden-json da biste ih zadržali",
    many: "CSV nema kolonu za dodatna polja: %d polja je izostavljeno (uključujući otp polja); koristite --format json ili bitwarden-json da biste ih zadržali",
  },

  // src/fsx/dirs.ts
  "mkdirs: %s is not an absolute path": "mkdirs: %s nije apsolutna putanja",
  "%s is not a folder": "%s nije fascikla",
  "mkdirP: %s is not an absolute path": "mkdirP: %s nije apsolutna putanja",

  // src/fsx/files.ts
  "not a regular file": "nije obična datoteka",
  "the file is larger than %s": "datoteka je veća od %s",

  // src/fsx/lock.ts
  "locking %s: %w": "zaključavanje %s: %w",
  "stopped waiting for another passh process: %w": "čekanje na drugi passh proces je prekinuto: %w",
  "another passh process has held %s for %s": "drugi passh proces drži %s već %s",

  // src/fsx/temp.ts
  "locking the temporary file: %w": "zaključavanje privremene datoteke: %w",
  "temporary files keep disappearing": "privremene datoteke stalno nestaju",

  // src/gen/index.ts
  "invalid password length %d": "neispravna dužina lozinke %d",
  "reading random bytes: %w": "čitanje nasumičnih bajtova: %w",
  "the alphabet must have 2 to 256 characters": "abeceda mora imati od 2 do 256 znakova",
  "the alphabet is not valid UTF-8": "abeceda nije ispravan UTF-8",
  "the alphabet holds a control or space character": "abeceda sadrži kontrolni znak ili razmak",
  "the alphabet holds %q twice": "abeceda sadrži %q dvaput",
  "length %q: give a number from 1 to 4096": "dužina %q: navedite broj od 1 do 4096",

  // src/importpass/gpg.ts
  "gpg not found: import pass needs GnuPG (gpg) to decrypt the store": "gpg nije pronađen: za import pass je potreban GnuPG (gpg) radi dešifrovanja skladišta",
  "no secret key for key ID %s": "nema tajnog ključa za ID ključa %s",
  "bad passphrase": "pogrešna pristupna fraza",
  "no passphrase given": "pristupna fraza nije data",
  "not an OpenPGP message (damaged file?)": "nije OpenPGP poruka (oštećena datoteka?)",
  "gpg reported %s": "gpg je prijavio %s",
  "gpg failed (exit status %d)": "gpg nije uspeo (izlazni status %d)",
  "gpg did not report a successful decryption": "gpg nije prijavio uspešno dešifrovanje",
  "gpg: %w": "gpg: %w",

  // src/importpass/importpass.ts
  "larger than 1 MiB": "veća od 1 MiB",
  "Decrypting %d/%d…": "Dešifrovanje %d/%d…",
  "import canceled at the passphrase prompt": "uvoz je otkazan na upitu za pristupnu frazu",
  "the decrypted entry is larger than %d MiB": "dešifrovana stavka je veća od %d MiB",
  "nothing was imported: %w": "ništa nije uvezeno: %w",

  // src/importpass/report.ts
  " (%d replacing entries already in the vault)": " (zamena postojećih stavki u trezoru: %d)",
  "Dry run: nothing was decrypted or saved. Store: %s": "Proba: ništa nije dešifrovano ni sačuvano. Skladište: %s",
  "Would import %d entries:": {
    one: "Biće uvezena %d stavka:",
    few: "Biće uvezene %d stavke:",
    many: "Biće uvezeno %d stavki:",
  },
  "%s  (replaces the entry in the vault)": "%s  (zamenjuje stavku u trezoru)",
  "Would import %d entries%s.": {
    one: "Biće uvezena %d stavka%s.",
    few: "Biće uvezene %d stavke%s.",
    many: "Biće uvezeno %d stavki%s.",
  },
  "Imported %d entries%s from %s.": {
    one: "Uvezena je %d stavka%s iz %s.",
    few: "Uvezene su %d stavke%s iz %s.",
    many: "Uvezeno je %d stavki%s iz %s.",
  },
  "Would skip %d: %s.": "Biće preskočeno %d: %s.",
  "Skipped %d: %s.": "Preskočeno %d: %s.",

  // src/importpass/root.ts
  "pass store: %w": "skladište pass-a: %w",

  // src/importpass/skips.ts
  "invalid path": "neispravna putanja",
  "already in the vault": "već je u trezoru",
  "duplicate path": "duplirana putanja",
  "symlink leads outside the store": "simbolička veza vodi izvan skladišta",
  "broken symlink": "prekinuta simbolička veza",
  "symlink to a folder": "simbolička veza ka fascikli",
  unreadable: "nečitljivo",
  "too large": "preveliko",
  "decryption failed": "dešifrovanje nije uspelo",
  "not a text entry": "nije tekstualna stavka",

  // src/importpass/walk.ts
  "not followed": "ne prati se",
  "pass store %s: %w": "skladište pass-a %s: %w",
  "same path as %s": "ista putanja kao %s",
  "use --overwrite to replace it": "koristite --overwrite da biste je zamenili",

  // src/keys/errors.ts
  "passphrase is empty": "pristupna fraza je prazna",
  "key block asks for scrypt work factor 2^%d; passh uses 2^18: the file is damaged or not made by passh": "blok ključa traži scrypt faktor rada 2^%d; passh koristi 2^18: datoteka je oštećena ili je nije napravio passh",
  "wrong passphrase, or the key block is damaged": "pogrešna pristupna fraza, ili je blok ključa oštećen",
  "the key block is damaged: it doesn't hold exactly one vault key": "blok ključa je oštećen: ne sadrži tačno jedan ključ trezora",
  "data is damaged; restore a backup (the data block isn't encrypted to this vault's key: damaged or replaced)": "podaci su oštećeni; vratite rezervnu kopiju (blok podataka nije šifrovan ključem ovog trezora: oštećen je ili zamenjen)",
  "this key doesn't open this vault (rekeyed elsewhere? wrong recovery key?)": "ovaj ključ ne otvara ovaj trezor (ključ trezora je promenjen negde drugde? pogrešan ključ za oporavak?)",
  "data is damaged; restore a backup": "podaci su oštećeni; vratite rezervnu kopiju",

  // src/keys/recovery.ts
  "not a valid recovery key: nothing was typed": "neispravan ključ za oporavak: ništa nije otkucano",
  "not a valid recovery key: it must start with AGE-SECRET-KEY-1": "neispravan ključ za oporavak: mora počinjati sa AGE-SECRET-KEY-1",
  "not a valid recovery key: group %d, character %d is not used in keys (B, I, O and 1 never appear after AGE-SECRET-KEY-1)": "neispravan ključ za oporavak: grupa %d, znak %d se ne koristi u ključevima (B, I, O i 1 se nikad ne javljaju posle AGE-SECRET-KEY-1)",
  "not a valid recovery key: it has %d characters after AGE-SECRET-KEY-1 instead of 58; a character is missing or extra": "neispravan ključ za oporavak: ima %d znakova posle AGE-SECRET-KEY-1 umesto 58; neki znak nedostaje ili je višak",
  "recovery key has a typo (checksum mismatch)": "ključ za oporavak ima grešku u kucanju (kontrolni zbir se ne slaže)",

  // src/keys/strength.ts
  "this is a top-10 common password": "ovo je jedna od 10 najčešćih lozinki",
  "this is a top-100 common password": "ovo je jedna od 100 najčešćih lozinki",
  "this is a very common password": "ovo je veoma česta lozinka",
  "this is similar to a commonly used password": "ovo liči na često korišćenu lozinku",
  "names and surnames by themselves are easy to guess": "imena i prezimena sama po sebi se lako pogađaju",
  "common names and surnames are easy to guess": "uobičajena imena i prezimena se lako pogađaju",
  "a word by itself is easy to guess": "reč sama po sebi se lako pogađa",
  "common words are easy to guess": "uobičajene reči se lako pogađaju",
  "straight rows of keys are easy to guess": "pravi nizovi tastera se lako pogađaju",
  "short keyboard patterns are easy to guess": "kratki obrasci na tastaturi se lako pogađaju",
  'repeats like "aaa" are easy to guess': 'ponavljanja kao "aaa" se lako pogađaju',
  'repeats like "abcabcabc" are only slightly harder to guess than "abc"': 'ponavljanja kao "abcabcabc" su tek malo teža za pogađanje od "abc"',
  "sequences like abc or 6543 are easy to guess": "nizovi kao abc ili 6543 se lako pogađaju",
  "recent years are easy to guess": "skorašnje godine se lako pogađaju",
  "dates are often easy to guess": "datumi se često lako pogađaju",
  "it is empty or too short": "prazna je ili prekratka",
  "warning: weak passphrase; use 6 or more random words": "upozorenje: slaba pristupna fraza; koristite 6 ili više nasumičnih reči",
  "warning: weak passphrase: %s; use 6 or more random words": "upozorenje: slaba pristupna fraza: %s; koristite 6 ili više nasumičnih reči",

  // src/main.ts
  "disabling core dumps: %s": "isključivanje core dump-ova: %s",

  // src/model/data.ts
  "made by a newer passh; upgrade passh (data version)": "napravio ga je noviji passh; ažurirajte passh (verzija podataka)",
  "invalid vault data: %w": "neispravni podaci trezora: %w",
  "expected an object, got null": "očekivan je objekat, dobijen je null",
  'format is not "passh-vault-data"': 'format nije "passh-vault-data"',
  "missing or bad version": "version nedostaje ili je neispravan",
  "unsupported version %d": "nepodržana verzija %d",
  "missing or bad vault_id": "vault_id nedostaje ili je neispravan",
  "missing or bad revision": "revision nedostaje ili je neispravan",
  "field key %q is not valid (letters, digits, then also _ . -)": "ključ polja %q nije ispravan (slova, cifre, zatim i _ . -)",
  "%q can't be a custom field key": "%q ne može biti ključ dodatnog polja",
  "invalid entry: %w": "neispravna stavka: %w",
  "%s is not valid UTF-8": "%s nije ispravan UTF-8",
  "%s must be a single line": "%s mora biti jedan red",
  "invalid tag %q: it isn't normalized": "neispravna oznaka %q: nije normalizovana",
  "field key %q is not valid UTF-8": "ključ polja %q nije ispravan UTF-8",
  "field %s is not valid UTF-8": "polje %s nije ispravan UTF-8",
  "field %s must be a single line": "polje %s mora biti jedan red",
  "notes are not valid UTF-8": "polje notes nije ispravan UTF-8",
  "entry %d: %w": "stavka %d: %w",
  "missing vault_id": "nedostaje vault_id",
  "vault_id is not valid UTF-8": "vault_id nije ispravan UTF-8",
  "entry %d: missing id": "stavka %d: nedostaje id",
  "entry %d: missing path": "stavka %d: nedostaje path",
  "entry %d: invalid path: %w": "stavka %d: neispravna putanja: %w",
  "entry %d: path %q isn't in NFC": "stavka %d: putanja %q nije u NFC obliku",
  "entry %d: duplicate id %q": "stavka %d: dupliran id %q",
  "entry %d: duplicate path %q": "stavka %d: duplirana putanja %q",
  "tombstone %d: missing id": "zapis o brisanju %d: nedostaje id",

  // src/model/ops.ts
  "%s: already exists": "%s: već postoji",
  "entry %s: not found": "stavka %s: nije pronađena",
  "can't move the folder %s into itself": "fascikla %s ne može da se premesti u samu sebe",
  "the vault is at the largest revision (%d); it can't be saved again": "trezor je na najvećoj reviziji (%d); ne može ponovo da se sačuva",

  // src/model/time.ts
  "bad time %q": "neispravno vreme %q",
  "time %q is out of range": "vreme %q je van opsega",

  // src/paths/index.ts
  "it is empty": "prazna je",
  "it is not valid UTF-8": "nije ispravan UTF-8",
  "it is longer than 1024 bytes": "duža je od 1024 bajta",
  "it contains a control character": "sadrži kontrolni znak",
  "it starts with /": "počinje sa /",
  "it ends with /": "završava se sa /",
  "it has an empty segment (//)": "ima prazan segment (//)",
  'it has a "." or ".." segment': 'ima segment "." ili ".."',
  "a segment starts with -": "segment počinje sa -",
  "invalid path: %w": "neispravna putanja: %w",
  "invalid folder: %w": "neispravna fascikla: %w",
  "%s: no such folder": "%s: nema takve fascikle",
  "invalid tag %q: not valid UTF-8": "neispravna oznaka %q: nije ispravan UTF-8",
  "invalid tag: a tag can't be empty": "neispravna oznaka: oznaka ne može biti prazna",
  "invalid tag %q: it contains a comma": "neispravna oznaka %q: sadrži zarez",
  "invalid tag %q: it contains a control character": "neispravna oznaka %q: sadrži kontrolni znak",

  // src/tty/lineedit.ts
  interrupted: "prekinuto",
  "passphrase longer than %d bytes": "pristupna fraza duža od %d bajtova",
  "input longer than %d bytes": "unos duži od %d bajtova",

  // src/tty/prompts.ts
  "not confirmed": "nije potvrđeno",
  "Passphrase: ": "Pristupna fraza: ",
  "reading the passphrase: %w": "čitanje pristupne fraze: %w",
  "New passphrase: ": "Nova pristupna fraza: ",
  "Repeat passphrase: ": "Ponovite pristupnu frazu: ",
  "The passphrase must not be empty.": "Pristupna fraza ne sme biti prazna.",
  "Passphrases don't match. Try again.": "Pristupne fraze se ne slažu. Pokušajte ponovo.",
  "passphrases don't match": "pristupne fraze se ne slažu",
  "Password (empty to generate): ": "Lozinka (prazno za generisanje): ",
  "Repeat password: ": "Ponovite lozinku: ",
  "The password must not be empty.": "Lozinka ne sme biti prazna.",
  "Passwords don't match. Try again.": "Lozinke se ne slažu. Pokušajte ponovo.",
  "passwords don't match": "lozinke se ne slažu",
  "Please answer y or n.": "Odgovorite sa d ili n.",
  "Type %s to confirm: ": "Otkucajte %s za potvrdu: ",
  "not confirmed: no answer": "nije potvrđeno: nema odgovora",
  "not confirmed: you didn't type %s": "nije potvrđeno: niste otkucali %s",

  // src/tty/tty.ts
  "reading the terminal state: %w": "čitanje stanja terminala: %w",
  "setting the terminal state: %w": "podešavanje stanja terminala: %w",

  // src/vault/backups.ts
  "no automatic backups of this vault were found; use another copy (passh verify --full <copy>)": "nisu pronađene automatske rezervne kopije ovog trezora; koristite drugu kopiju (passh verify --full <copy>)",
  "automatic backups of this vault, newest first:": "automatske rezervne kopije ovog trezora, od najnovije:",
  "automatic backups on this machine, newest first:": "automatske rezervne kopije na ovom računaru, od najnovije:",
  "old automatic backups couldn't be removed: %v": "stare automatske rezervne kopije nisu mogle da se uklone: %v",

  // src/vault/commands.ts
  "Continue with this copy?": "Nastaviti sa ovom kopijom?",
  "this machine hasn't seen this vault before": "ovaj računar ranije nije video ovaj trezor",
  "OK: the newest revision seen on this machine (r%d)": "U redu: najnovija revizija viđena na ovom računaru (r%d)",
  "OK: newer than seen before on this machine (r%d)": "U redu: novija od ranije viđene na ovom računaru (r%d)",
  "OLDER than seen before on this machine (seen r%d of %s)": "STARIJA od ranije viđene na ovom računaru (viđena r%d od %s)",
  "note: %s": "napomena: %s",
  "note: the file isn't in passh's canonical form (line endings or line wrapping changed in copying); it opens, and `passh backup` writes a canonical copy":
    "napomena: datoteka nije u kanonskom obliku passh-a (krajevi redova ili prelamanje redova su promenjeni pri kopiranju); otvara se, a `passh backup` upisuje kanonsku kopiju",
  "this copy is older than one seen before on this machine (r%d of %s; seen r%d of %s). If you didn't restore it on purpose, the file may have been replaced.":
    "ova kopija je starija od one ranije viđene na ovom računaru (r%d od %s; viđena r%d od %s). Ako je niste namerno vratili, datoteka je možda zamenjena.",
  "%s doesn't pass the structure check, so it isn't copied: %w": "%s ne prolazi proveru strukture, pa se ne kopira: %w",
  "%s: a file already exists there; passh doesn't overwrite files": "%s: tu već postoji datoteka; passh ne prepisuje datoteke",
  "%s (SHA-256 %s, expected %s): the copy didn't read back as written; nothing was written under its name": "%s (SHA-256 %s, očekivano %s): kopija se nije pročitala onako kako je upisana; ništa nije upisano pod njenim imenom",
  "%s is written, but its folder couldn't be synced: %w": "%s je upisana, ali njena fascikla nije mogla da se sinhronizuje: %w",
  "Backed up %s to %s.": "Trezor %s je kopiran u %s.",
  "The copy is byte for byte the vault; `passh verify` shows the same SHA-256 for both.": "Kopija je bajt po bajt jednaka trezoru; `passh verify` prikazuje isti SHA-256 za obe.",
  "The vault isn't in canonical form, so the copy was written in canonical form;": "Trezor nije u kanonskom obliku, pa je kopija upisana u kanonskom obliku;",
  "its SHA-256 differs from the vault's, and the stock age tool reads its blocks (§8).": "njen SHA-256 se razlikuje od SHA-256 trezora, a standardni alat age čita njene blokove (§8).",
  "note: %s can't be read (%v); listing every automatic backup on this machine": "napomena: %s ne može da se pročita (%v); prikazuju se sve automatske rezervne kopije na ovom računaru",
  "note: no backup has this vault's current key block (it was changed by passwd or rekey and not saved since, or the file is damaged); listing every automatic backup on this machine":
    "napomena: nijedna rezervna kopija nema trenutni blok ključa ovog trezora (promenjen je sa passwd ili rekey i od tada nije sačuvan, ili je datoteka oštećena); prikazuju se sve automatske rezervne kopije na ovom računaru",
  "No automatic backups yet. passh makes one before each save (backup.keep = %d).": "Još nema automatskih rezervnih kopija. passh pravi jednu pre svakog čuvanja (backup.keep = %d).",

  // src/vault/create.ts
  "creating the vault's folder: %w": "pravljenje fascikle trezora: %w",
  "removing leftover temporary files: %w": "uklanjanje zaostalih privremenih datoteka: %w",
  "creating the vault file: %w": "pravljenje datoteke trezora: %w",
  "the vault's folder couldn't be flushed to disk: %v": "fascikla trezora nije mogla da se upiše na disk: %v",

  // src/vault/errors.ts
  "vault changed on disk after it was opened (another passh, a sync tool or a copy); nothing was saved: reload and repeat the change": "trezor je promenjen na disku nakon otvaranja (drugi passh, alat za sinhronizaciju ili kopija); ništa nije sačuvano: ponovo učitajte i ponovite izmenu",
  "vault is being saved by another passh process; nothing was saved: try again": "trezor čuva drugi passh proces; ništa nije sačuvano: pokušajte ponovo",
  "this is an automatic backup: copy it out first (e.g. over the vault file) and open the copy": "ovo je automatska rezervna kopija: prvo je kopirajte napolje (npr. preko datoteke trezora) i otvorite kopiju",
  "the key block is damaged: set a new passphrase first (passh recover)": "blok ključa je oštećen: prvo postavite novu pristupnu frazu (passh recover)",
  "vault is locked: run `passh unlock` in a terminal (over SSH: `ssh -t host passh unlock`)": "trezor je zaključan: pokrenite `passh unlock` u terminalu (preko SSH-a: `ssh -t host passh unlock`)",
  "stopped: this copy is older than one seen before on this machine; nothing was changed": "zaustavljeno: ova kopija je starija od one ranije viđene na ovom računaru; ništa nije promenjeno",
  "%s: a file already exists there": "%s: tu već postoji datoteka",
  "the save was cancelled; nothing was saved": "čuvanje je otkazano; ništa nije sačuvano",
  "no vault at %s: run `passh init` to create one, or pass --vault <file>": "nema trezora na %s: pokrenite `passh init` da ga napravite, ili navedite --vault <file>",
  "vault %s: %w": "trezor %s: %w",
  "The key block only protects the vault key with the passphrase: if the data block is intact, `passh recover` with the paper recovery key writes a new key block; or restore a backup (passh backups)":
    "Blok ključa samo štiti ključ trezora pristupnom frazom: ako je blok podataka čitav, `passh recover` sa papirnim ključem za oporavak upisuje novi blok ključa; ili vratite rezervnu kopiju (passh backups)",
  "The key block only protects the vault key with the passphrase: if the data block is intact, `passh recover` with the paper recovery key writes a new key block":
    "Blok ključa samo štiti ključ trezora pristupnom frazom: ako je blok podataka čitav, `passh recover` sa papirnim ključem za oporavak upisuje novi blok ključa",

  // src/vault/keysources.ts
  "Wrong passphrase. Try again.": "Pogrešna pristupna fraza. Pokušajte ponovo.",
  "Type the recovery key from the paper sheet (AGE-SECRET-KEY-1…); it shows as *.": "Otkucajte ključ za oporavak sa papirnog lista (AGE-SECRET-KEY-1…); prikazuje se kao *.",
  "Spaces, line breaks and letter case don't matter. End with an empty line.": "Razmaci, prelomi redova i veličina slova nisu bitni. Završite praznim redom.",
  "%v. Type it again.": "%v. Otkucajte ga ponovo.",
  "this recovery key doesn't open %s: it belongs to another vault, or the vault was rekeyed after the sheet was printed": "ovaj ključ za oporavak ne otvara %s: pripada drugom trezoru, ili je ključ trezora promenjen nakon što je list odštampan",

  // src/vault/open.ts
  "%s: the key block is damaged; setting a new passphrase rewrites it": "%s: blok ključa je oštećen; postavljanje nove pristupne fraze ga ponovo upisuje",
  "%s: data is damaged; restore a backup (%w)%v": "%s: podaci su oštećeni; vratite rezervnu kopiju (%w)%v",

  // src/vault/rollback.ts
  "%s was written by a newer passh (version %d)": "%s potiče od novijeg passh-a (verzija %d)",
  "the rollback record wasn't updated: %v": "evidencija revizija nije ažurirana: %v",
  "the rollback record %s is damaged; a new one is started, so older copies aren't detected this time": "evidencija revizija %s je oštećena; počinje se nova, pa starije kopije ovog puta nisu otkrivene",
  "the rollback record can't be used, so older copies aren't detected: %v": "evidencija revizija ne može da se koristi, pa starije kopije nisu otkrivene: %v",

  // src/vault/save.ts
  "creating the state folder: %w": "pravljenje fascikle stanja: %w",
  "opening the lock file: %w": "otvaranje datoteke za zaključavanje: %w",
  "reading the vault file again: %w": "ponovno čitanje datoteke trezora: %w",
  "writing the new vault file: %w; the vault is unchanged": "upisivanje nove datoteke trezora: %w; trezor je nepromenjen",
  "the new vault file didn't read back as written; the vault is unchanged: %w": "nova datoteka trezora se nije pročitala onako kako je upisana; trezor je nepromenjen: %w",
  "the bytes read differ from those written": "pročitani bajtovi se razlikuju od upisanih",
  "the key block differs": "blok ključa se razlikuje",
  "the data differs from what was serialized": "podaci se razlikuju od serijalizovanih",
  "vault_id, revision or number of entries differ": "vault_id, revizija ili broj stavki se razlikuju",
  "%s (a temporary name: move it elsewhere before the next save, which would remove it)": "%s (privremeno ime: premestite je negde drugde pre sledećeg čuvanja, koje bi je uklonilo)",
  "replacing the vault file: %w; the vault is unchanged": "zamena datoteke trezora: %w; trezor je nepromenjen",
  "the replaced vault file couldn't be checked (%v); it is kept in %v": "zamenjena datoteka trezora nije mogla da se proveri (%v); sačuvana je u %v",
  "the replaced vault file couldn't be removed (the next save removes it): %v": "zamenjena datoteka trezora nije mogla da se ukloni (sledeće čuvanje će je ukloniti): %v",
  "%w; the save couldn't be undone (%v): the vault now holds this save, the other version is in %v": "%w; čuvanje nije moglo da se poništi (%v): trezor sada sadrži ovo čuvanje, druga verzija je u %v",
  "%w; a file that was in its place is kept in %v": "%w; datoteka koja je bila na njenom mestu sačuvana je u %v",
  "the new vault file couldn't be closed: %v": "nova datoteka trezora nije mogla da se zatvori: %v",
  "making the automatic backup: %w; the vault is unchanged": "pravljenje automatske rezervne kopije: %w; trezor je nepromenjen",

  // src/vaultfile/errors.ts
  "not a passh vault": "nije passh trezor",
  "not a passh vault: unknown container version 0": "nije passh trezor: nepoznata verzija kontejnera 0",
  "made by a newer passh; upgrade passh (container version %d)": "napravio ga je noviji passh; ažurirajte passh (verzija kontejnera %d)",
  "file is truncated: %s": "datoteka je skraćena: %s",
  "file is damaged (block %d): %s": "datoteka je oštećena (blok %d): %s",
  "the file is empty": "datoteka je prazna",
  "it ends in the passh-vault line": "završava se redom passh-vault",
  "block %d is missing": "blok %d nedostaje",
  "block %d is cut short": "blok %d je skraćen",
  "block %d has no END line": "blok %d nema red END",
  "its BEGIN line is missing or damaged": "njegov red BEGIN nedostaje ili je oštećen",
  "its END line is missing or damaged": "njegov red END nedostaje ili je oštećen",
  "bad base64": "neispravan base64",
  "the block is empty": "blok je prazan",
  "bad age header": "neispravno age zaglavlje",
  "the key block isn't encrypted with a passphrase": "blok ključa nije šifrovan pristupnom frazom",
  "the data block isn't encrypted to a vault key": "blok podataka nije šifrovan ključem trezora",
  "the encrypted data has an impossible size (cut short or extended)": "šifrovani podaci imaju nemoguću veličinu (skraćeni ili produženi)",
  "ignored %d lines of text before the passh-vault line": {
    one: "zanemaren je %d red teksta pre reda passh-vault",
    few: "zanemarena su %d reda teksta pre reda passh-vault",
    many: "zanemareno je %d redova teksta pre reda passh-vault",
  },
  "ignored %d lines of text after the last END line": {
    one: "zanemaren je %d red teksta posle poslednjeg reda END",
    few: "zanemarena su %d reda teksta posle poslednjeg reda END",
    many: "zanemareno je %d redova teksta posle poslednjeg reda END",
  },
  "not a passh vault: the file is larger than 64 MiB": "nije passh trezor: datoteka je veća od 64 MiB",
  "%s is larger than 64 MiB: not a passh vault": "%s ima više od 64 MiB: nije passh trezor",
  "not a passh vault: not a regular file": "nije passh trezor: nije obična datoteka",
  "%s is not a regular file": "%s nije obična datoteka",
  "the vault file would be %d bytes, larger than 64 MiB, which passh can't open; nothing was saved": "datoteka trezora bi imala %d bajtova, više od 64 MiB, što passh ne može da otvori; ništa nije sačuvano",
};
