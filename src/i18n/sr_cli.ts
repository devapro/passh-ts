// Serbian (Latin script, ekavian) catalogue, area cli (keys from src/cli/). The English
// texts are the keys (i18n.md §4); terms follow the glossary of spec/docs/translations.md.
// Entries are grouped by the source file of their first call site.

import type { Catalog } from "./index.ts";

export const SR_CLI: Catalog = {
  // src/cli/cmd_add.ts
  "Tags (comma-separated): ": "Oznake (odvojene zarezima): ",
  "Notes (end with an empty line):": "Beleške (završite praznim redom):",
  "%s already exists: use --force to replace it": "stavka %s već postoji: upotrebite --force da biste je zamenili",
  "Username: ": "Korisničko ime: ",
  "URL: ": "URL: ",
  "Generated a %d-character password.": "Generisana je lozinka dužine %d.",
  "Saved %s.": "Stavka %s je sačuvana.",

  // src/cli/cmd_change.ts
  "%s already exists: use --force to replace its password (its other values are kept)":
    "stavka %s već postoji: upotrebite --force da biste zamenili njenu lozinku (ostale vrednosti se zadržavaju)",
  "letters, digits and symbols": "slova, cifre i simboli",
  "letters and digits": "slova i cifre",
  "Replaced the password of %s: a new %d-character password (%s, %d bits).": "Lozinka stavke %s je zamenjena: nova lozinka dužine %d (%s, %d bita).",
  "Stored %s: a new %d-character password (%s, %d bits).": "Stavka %s je sačuvana: nova lozinka dužine %d (%s, %d bita).",
  "Show it with: passh show %s --field password": "Prikažite je komandom: passh show %s --field password",
  "Moved %s to %s.": "Stavka %s je premeštena u %s.",
  "Moved the folder %s/ to %s/ (%d entries).": {
    one: "Fascikla %s/ je premeštena u %s/ (%d stavka).",
    few: "Fascikla %s/ je premeštena u %s/ (%d stavke).",
    many: "Fascikla %s/ je premeštena u %s/ (%d stavki).",
  },
  "passh rm asks for confirmation on a terminal: run it in one, or add --force": "passh rm traži potvrdu na terminalu: pokrenite ga u terminalu ili dodajte --force",
  "Delete %s?": "Obrisati %s?",
  "not deleted": "nije obrisano",
  "Deleted %s.": "Stavka %s je obrisana.",
  "give --add and/or --remove": "navedite --add i/ili --remove",
  "%s: no tags": "%s: nema oznaka",
  "%s: no tags (unchanged)": "%s: nema oznaka (bez izmena)",
  "%s: tags %s": "%s: oznake %s",
  "%s: tags %s (unchanged)": "%s: oznake %s (bez izmena)",

  // src/cli/cmd_edit.ts
  "nothing was saved: %w": "ništa nije sačuvano: %w",
  "edit %s": "izmena %s",
  "cancelled; nothing was saved": "otkazano; ništa nije sačuvano",
  "The vault changed on disk since it was opened; reload and apply your edit again?": "Trezor je promenjen na disku otkako je otvoren; ponovo ga učitati i ponovo primeniti vašu izmenu?",
  "not saved: the vault changed on disk since it was opened": "nije sačuvano: trezor je promenjen na disku otkako je otvoren",
  "not saved: %s was deleted or replaced in the vault on disk": "nije sačuvano: stavka %s je obrisana ili zamenjena u trezoru na disku",
  "%s; using the built-in form instead": "%s; umesto toga se koristi ugrađeni obrazac",
  "No change.": "Bez izmena.",

  // src/cli/cmd_init.ts
  "--vault: %w": "--vault: %w",
  "%s already exists; passh init doesn't overwrite a vault": "%s već postoji; passh init ne prepisuje trezor",
  "Write the text sheet to [%s]: ": "Upisati tekstualni list u [%s]: ",
  "For a version with the key as a QR code: passh recovery-key print --web": "Za verziju sa ključem kao QR kodom: passh recovery-key print --web",
  "Creating the vault %s.": "Pravi se trezor %s.",
  "Choose a passphrase: 6 or more random words are best.": "Izaberite pristupnu frazu: najbolje je 6 ili više nasumičnih reči.",
  "Created the vault %s.": "Trezor %s je napravljen.",
  "$HOME is not set": "$HOME nije postavljen",
  "the vault was created, but the config file wasn't: %w": "trezor je napravljen, ali konfiguraciona datoteka nije: %w",
  "Wrote the config file %s.": "Konfiguraciona datoteka %s je upisana.",
  "The config file %s exists and wasn't changed; it names the vault %s.": "Konfiguraciona datoteka %s postoji i nije promenjena; u njoj je naveden trezor %s.",
  "Use --vault %s with each command, or change vault in the config file.": "Upotrebite --vault %s uz svaku komandu ili promenite vault u konfiguracionoj datoteci.",
  "Print the recovery key now?": "Odštampati ključ za oporavak sada?",
  "Print the paper recovery key now and keep the sheet offline:": "Odštampajte papirni ključ za oporavak sada i čuvajte list van mreže:",
  "  passh recovery-key print -o <file>   (or --web, with the key as a QR code)": "  passh recovery-key print -o <file>   (ili --web, sa ključem kao QR kodom)",
  "Without it, a forgotten passphrase means the data is lost.": "Bez njega, zaboravljena pristupna fraza znači da su podaci izgubljeni.",
  "the vault was created, but the recovery sheet wasn't written: %w; run `passh recovery-key print` later":
    "trezor je napravljen, ali list sa ključem za oporavak nije upisan: %w; pokrenite `passh recovery-key print` kasnije",

  // src/cli/cmd_keys.ts
  "passh %s needs the current passphrase, typed on a terminal; the agent's key isn't enough to change the passphrase or the vault key (over SSH: `ssh -t host passh %s`)":
    "passh %s traži trenutnu pristupnu frazu, otkucanu na terminalu; ključ agenta nije dovoljan za promenu pristupne fraze ili ključa trezora (preko SSH-a: `ssh -t host passh %s`)",
  "Current passphrase: ": "Trenutna pristupna fraza: ",
  "Choose the new passphrase.": "Izaberite novu pristupnu frazu.",
  "Choose the passphrase for the new vault key (it may be the same as before).": "Izaberite pristupnu frazu za novi ključ trezora (može biti ista kao ranije).",
  "Passphrase changed. The paper recovery key stays valid.": "Pristupna fraza je promenjena. Papirni ključ za oporavak ostaje važeći.",
  "Copies and backups made before still open with the old passphrase.": "Kopije i rezervne kopije napravljene ranije i dalje se otvaraju starom pristupnom frazom.",
  // one sentence over two lines (cmd_keys.ts:68–69): each half is translated as a line
  "The vault has a new key. The old passphrase and the old paper recovery key": "Trezor ima novi ključ. Stara pristupna fraza i stari papirni ključ za oporavak",
  "no longer open new versions of it; copies made before still open with them.": "više ne otvaraju njegove nove verzije; kopije napravljene ranije i dalje se otvaraju njima.",
  "Print a new paper recovery key now: passh recovery-key print": "Odštampajte novi papirni ključ za oporavak sada: passh recovery-key print",
  "The recovery key opens the vault. Choose a new passphrase.": "Ključ za oporavak otvara trezor. Izaberite novu pristupnu frazu.",
  "New passphrase set for %s. The paper recovery key stays valid.": "Nova pristupna fraza je postavljena za %s. Papirni ključ za oporavak ostaje važeći.",

  // src/cli/cmd_ls.ts
  "no entry matches %q": "nijedna stavka ne odgovara izrazu %q",
  "no tags": "nema oznaka",

  // src/cli/cmd_show.ts
  "%s has no field %q": "stavka %s nema polje %q",
  "%s: the %s is empty; nothing was copied": "%s: polje %s je prazno; ništa nije kopirano",

  // src/cli/cmd_tui.ts
  "the TUI needs a terminal: run passh in one (over SSH: `ssh -t host passh`); without a terminal, use the commands (passh --help) after `passh unlock`":
    "za TUI je potreban terminal: pokrenite passh u terminalu (preko SSH-a: `ssh -t host passh`); bez terminala koristite komande (passh --help) posle `passh unlock`",

  // src/cli/command.ts
  "help for %s": "pomoć za %s",
  "version for %s": "verzija programa %s",
  "invalid argument %s for %s flag: %s": "neispravan argument %s za opciju %s: %s",
  "bad flag syntax: %s": "neispravna sintaksa opcije: %s",
  "unknown flag: --%s": "nepoznata opcija: --%s",
  "flag needs an argument: %s": "opcija traži argument: %s",
  "unknown shorthand flag: %s in -%s": "nepoznata kratka opcija: %s u -%s",
  "flag needs an argument: %s in -%s": "opcija traži argument: %s u -%s",
  "unknown command %s for %s": "nepoznata komanda %s za %s",
  "accepts %d arg(s), received %d": "prihvata argumenata: %d, primljeno: %d",
  "accepts between %d and %d arg(s), received %d": "prihvata od %d do %d argumenata, primljeno: %d",
  "unknown command %s for passh": "nepoznata komanda %s za passh",
  " (default %s)": " (podrazumevano %s)",
  "Usage:": "Upotreba:",
  "Available Commands:": "Dostupne komande:",
  "Flags:": "Opcije:",
  "Global Flags:": "Globalne opcije:",
  "Use \"%s [command] --help\" for more information about a command.": "Pokrenite \"%s [command] --help\" za više informacija o komandi.",
  "Run 'passh --help' or 'passh <command> --help' for usage.": "Za upotrebu pokrenite 'passh --help' ili 'passh <command> --help'.",

  // src/cli/open.ts
  "%s is a folder, not an entry: list it with `passh ls %s`": "%s je fascikla, a ne stavka: prikažite je komandom `passh ls %s`",
  "%s: not found": "%s: nije pronađeno",

  // src/cli/output.ts
  // "write /dev/stdout: %s" stays English: it is the OS error text (cli.md §1.2, i18n.md §3).
  "warning: ": "upozorenje: ",

  // src/cli/runs.ts
  "%s is not implemented yet": "%s još nije implementirano",

  // src/cli/tree.ts
  "only entries with this tag (repeat for several: all must match)": "samo stavke sa ovom oznakom (ponovi za više oznaka: sve moraju da odgovaraju)",
  "only entries in this folder": "samo stavke u ovoj fascikli",
  "write to this new file (mode 0600) instead of stdout": "upiši u ovu novu datoteku (dozvole 0600) umesto na stdout",
  "show the sheet on the one-shot print page (§7.4), with a QR code; a browser can print it or save it as PDF":
    "prikaži list na jednokratnoj stranici za štampu (§7.4), sa QR kodom; pregledač može da ga odštampa ili sačuva kao PDF",
  "passh keeps passwords in one age-encrypted vault file.\n\nRun `passh init` to create a vault, then `passh` alone for the TUI. Commands that\nread or change entries ask for the passphrase on the terminal, or use the agent\nstarted by `passh unlock`.":
    "passh čuva lozinke u jednoj datoteci trezora, šifrovanoj programom age.\n\nPokrenite `passh init` da biste napravili trezor, a zatim samo `passh` za TUI.\nKomande koje čitaju ili menjaju stavke traže pristupnu frazu na terminalu ili\nkoriste agenta pokrenutog komandom `passh unlock`.",
  "config file (default $PASSH_CONFIG, then ~/.config/passh/config.toml)": "konfiguraciona datoteka (podrazumevano $PASSH_CONFIG, zatim ~/.config/passh/config.toml)",
  "vault file, overriding the config's vault (no config file needed)": "datoteka trezora, umesto vrednosti vault iz konfiguracije (konfiguraciona datoteka nije potrebna)",
  "Add an entry interactively: password (or generate), username, url, tags, notes": "Dodaj stavku interaktivno: lozinka (ili generisana), kor. ime, url, oznake, beleške",
  "replace an existing entry": "zameni postojeću stavku",
  "Make a checked copy of the vault in a file or folder": "Napravi proverenu kopiju trezora u datoteci ili fascikli",
  "Copy the vault to a file, or into a folder as <name>-<UTC time>.passh, with\nmode 0600. The copy is flushed to disk, read back and compared by SHA-256.\nAn existing file is never overwritten. A vault that isn't in canonical form\n(e.g. after an email or a paste) is written in canonical form. No passphrase\nis needed.":
    "Kopira trezor u datoteku ili u fasciklu kao <name>-<UTC time>.passh, sa\ndozvolama 0600. Kopija se upisuje na disk, ponovo čita i poredi po SHA-256.\nPostojeća datoteka se nikad ne prepisuje. Trezor koji nije u kanonskom obliku\n(npr. posle e-pošte ili lepljenja) upisuje se u kanonskom obliku. Pristupna\nfraza nije potrebna.",
  "List the automatic backups of the vault": "Prikaži automatske rezervne kopije trezora",
  "List the automatic backups passh made before each save (§4.7), newest first,\nwith time and revision. To restore one, copy it over the vault file and run\n`passh verify --full`. No passphrase is needed.":
    "Prikazuje automatske rezervne kopije koje je passh napravio pre svakog čuvanja\n(§4.7), od najnovije, sa vremenom i revizijom. Da biste vratili jednu, kopirajte\nje preko datoteke trezora i pokrenite `passh verify --full`. Pristupna fraza\nnije potrebna.",
  "Copy a field (default: the password) to the clipboard, cleared after a while": "Kopiraj polje (podrazumevano lozinku) u ostavu, koja se posle nekog vremena čisti",
  "Copy the password, or another field, to the clipboard: through the terminal\n(OSC 52, which works over SSH) or with clipboard.command. passh waits and clears\nthe clipboard after clipboard.clear_after; Ctrl-C clears it at once. The value\nis never printed.":
    "Kopira lozinku ili drugo polje u ostavu: preko terminala (OSC 52, što radi i\npreko SSH-a) ili komandom iz clipboard.command. passh čeka i čisti ostavu posle\nclipboard.clear_after; Ctrl-C je čisti odmah. Vrednost se nikad ne ispisuje.",
  "field to copy: password, username, url, tags, notes or a custom field": "polje za kopiranje: password, username, url, tags, notes ili dodatno polje",
  "Check the config, the vault file, the state and agent folders, memory and swap": "Proveri konfiguraciju, datoteku trezora, fascikle stanja i agenta, memoriju i swap",
  "Read-only checks of everything passh depends on: the config file, the vault\nfile (structure, mode 0600, writable folder, leftover temporary files), the\nstate and agent folders, the agent, free memory for unlock (scrypt needs\n256 MiB), swap, core dumps and the terminal. It reports, never fixes. The exit\nstatus is 1 if a check found an error; warnings are advice.":
    "Proverava, samo čitanjem, sve od čega passh zavisi: konfiguracionu datoteku,\ndatoteku trezora (struktura, dozvole 0600, fascikla u koju se može pisati,\nzaostale privremene datoteke), fascikle stanja i agenta, agenta, slobodnu\nmemoriju za otključavanje (scrypt traži 256 MiB), swap, core dump i terminal.\nIzveštava, nikad ne popravlja. Izlazni status je 1 ako je neka provera našla\ngrešku; upozorenja su saveti.",
  "Edit an entry in the built-in form, or in $EDITOR": "Izmeni stavku u ugrađenom obrascu ili u $EDITOR",
  "Edit an entry in the built-in form: password, username, url, tags and notes\n(ctrl+s saves, esc cancels, ctrl+r reveals the password, ctrl+g generates one).\n\n--editor opens the entry's text form in $EDITOR instead, in a temporary file on\ntmpfs that is wiped afterwards. vim, neovim and nano get flags that keep them\nfrom writing swap, backup or history files. Where there is no tmpfs (macOS),\nthe built-in form is used.":
    "Menja stavku u ugrađenom obrascu: lozinku, korisničko ime, url, oznake i\nbeleške (ctrl+s čuva, esc otkazuje, ctrl+r prikazuje lozinku, ctrl+g generiše\nnovu).\n\n--editor umesto toga otvara tekstualni oblik stavke u $EDITOR, u privremenoj\ndatoteci na tmpfs-u koja se posle briše. vim, neovim i nano dobijaju opcije\nkoje ih sprečavaju da pišu swap datoteke, rezervne kopije ili istoriju. Gde nema\ntmpfs-a (macOS), koristi se ugrađeni obrazac.",
  "edit the text form in $EDITOR (temporary file on tmpfs)": "uredi tekstualni oblik u $EDITOR (privremena datoteka na tmpfs-u)",
  "Export entries for other tools (plaintext unless --age)": "Izvezi stavke za druge alate (kao otvoreni tekst, osim uz --age)",
  "Export entries as csv, json (the vault's data format) or bitwarden-json.\n\nExport data is never written to a terminal: use -o file or redirect stdout.\nA plaintext export needs confirmation: with a terminal you type EXPORT PLAINTEXT;\nwithout one (e.g. over ssh without -t) add --confirm-plaintext. --age <recipient>\nencrypts the export to an age public key instead. -o creates a new file with\nmode 0600 and never overwrites one.\n\nFor a backup, don't export: copy the vault file (passh backup).":
    "Izvozi stavke kao csv, json (format podataka trezora) ili bitwarden-json.\n\nPodaci izvoza se nikad ne upisuju na terminal: upotrebite -o file ili\npreusmerite stdout. Izvoz kao otvoreni tekst traži potvrdu: na terminalu\nkucate EXPORT PLAINTEXT; bez njega (npr. preko ssh bez -t) dodajte\n--confirm-plaintext. --age <recipient> umesto toga šifruje izvoz javnim\nključem programa age. -o pravi novu datoteku sa dozvolama 0600 i nikad ne\nprepisuje postojeću.\n\nZa rezervnu kopiju nemojte izvoziti: kopirajte datoteku trezora (passh backup).",
  "encrypt to this age public key (age1…)": "šifruj ovim javnim ključem programa age (age1…)",
  "confirm a plaintext export when there is no terminal": "potvrdi izvoz kao otvoreni tekst kada nema terminala",
  "csv, json or bitwarden-json": "csv, json ili bitwarden-json",
  "CSV: prefix ' to cells starting with = + - @ (changes values; not for password managers)": "CSV: dodaj ' ispred ćelija koje počinju sa = + - @ (menja vrednosti; nije za menadžere lozinki)",
  "Fuzzy search on paths and tags": "Približna pretraga po putanjama i oznakama",
  "Generate and store a password": "Generiši i sačuvaj lozinku",
  "Generate a random password (default 24 letters and digits) and store it.\n\nA new path makes a new entry. For an existing entry, --force replaces its\npassword and keeps its other values (username, url, tags, fields, notes).\nThe password is not printed; show it with `passh show <path> --field password`.":
    "Generiše nasumičnu lozinku (podrazumevano 24 slova i cifre) i čuva je.\n\nNova putanja pravi novu stavku. Za postojeću stavku, --force zamenjuje njenu\nlozinku i zadržava ostale vrednosti (username, url, tags, fields, notes).\nLozinka se ne ispisuje; prikažite je komandom\n`passh show <path> --field password`.",
  "replace the password of an existing entry": "zameni lozinku postojeće stavke",
  "also use punctuation characters": "koristi i znakove interpunkcije",
  "Help about any command": "Pomoć za bilo koju komandu",
  "Help provides help for any command in the application.\nSimply type passh help [path to command] for full details.":
    "Help pruža pomoć za bilo koju komandu programa.\nOtkucajte passh help [path to command] za sve pojedinosti.",
  "Import entries from another password manager": "Uvezi stavke iz drugog menadžera lozinki",
  "say what to import from, e.g. `passh import pass`": "navedite odakle se uvozi, npr. `passh import pass`",
  "One-way import from a pass store (needs gpg)": "Jednosmerni uvoz iz skladišta pass-a (potreban je gpg)",
  "Import a pass store (password-store.org) into the vault, in one save. The store\nis only read. dir defaults to $PASSWORD_STORE_DIR, then ~/.password-store.\nEach entry is decrypted with gpg, as pass does. Paths already in the vault are\nskipped unless --overwrite is given. --dry-run lists what would be imported\nand the conflicts without decrypting anything.":
    "Uvozi skladište pass-a (password-store.org) u trezor, jednim čuvanjem.\nSkladište se samo čita. dir je podrazumevano $PASSWORD_STORE_DIR, zatim\n~/.password-store. Svaka stavka se dešifruje programom gpg, kao što to radi\npass. Putanje koje su već u trezoru preskaču se, osim uz --overwrite.\n--dry-run prikazuje šta bi bilo uvezeno i sukobe, bez ikakvog dešifrovanja.",
  "list what would be imported and the conflicts; decrypt nothing": "prikaži šta bi bilo uvezeno i sukobe; ne dešifruj ništa",
  "replace entries whose path is already in the vault": "zameni stavke čija je putanja već u trezoru",
  "Create a new vault, and the config file if it doesn't exist": "Napravi novi trezor i konfiguracionu datoteku ako ne postoji",
  "Stop the agent": "Zaustavi agenta",
  "Print the tree of entries, optionally filtered by tag": "Prikaži stablo stavki, po želji filtrirano po oznaci",
  "Move or rename an entry or a folder": "Premesti ili preimenuj stavku ili fasciklu",
  "Move or rename an entry. A destination ending in / moves the entry into that\nfolder, keeping its name. If <src> is a folder, every entry in it moves, in\none save; nothing moves if any destination is taken.":
    "Premešta ili preimenuje stavku. Odredište koje se završava sa / premešta\nstavku u tu fasciklu, uz zadržavanje njenog imena. Ako je <src> fascikla,\npremešta se svaka stavka u njoj, jednim čuvanjem; ništa se ne premešta ako je\nneko odredište zauzeto.",
  "Change the passphrase (the paper recovery key stays valid)": "Promeni pristupnu frazu (papirni ključ za oporavak ostaje važeći)",
  "Change the passphrase: only the key block is rewritten, and the paper recovery\nkey stays valid. It asks for the current passphrase on the terminal, also while\nthe agent runs: the agent's key isn't enough to change it. A running agent is\nstopped afterwards.":
    "Menja pristupnu frazu: prepisuje se samo blok ključa, a papirni ključ za\noporavak ostaje važeći. Traži trenutnu pristupnu frazu na terminalu, i dok\nagent radi: ključ agenta nije dovoljan da se ona promeni. Agent koji radi se\nposle zaustavlja.",
  "Print a password sheet (text), or show it on the print page (--web)": "Odštampaj list sa lozinkama (tekst) ili ga prikaži na stranici za štampu (--web)",
  "Lay out the chosen entries as a text password sheet, grouped by folder, with\nthe chosen fields (default password,username,url; also tags, notes, fields, or\na custom field's key). Ambiguous characters are marked.\n\nThe sheet is plaintext: it is never written to a terminal, and it needs\nconfirmation as a plaintext export does (type EXPORT PLAINTEXT, or\n--confirm-plaintext without a terminal). Use -o file (mode 0600) or redirect\nstdout; print it, then delete the file.\n\n--web shows it on the one-shot print page instead (print_web.enabled; needs a\nterminal and typing PRINT); the browser prints it, or saves it as PDF.":
    "Raspoređuje izabrane stavke u tekstualni list sa lozinkama, grupisane po\nfasciklama, sa izabranim poljima (podrazumevano password,username,url; takođe\ntags, notes, fields ili ključ dodatnog polja). Dvosmisleni znakovi su označeni.\n\nList je otvoreni tekst: nikad se ne upisuje na terminal i traži potvrdu kao\nizvoz kao otvoreni tekst (otkucajte EXPORT PLAINTEXT ili, bez terminala,\n--confirm-plaintext). Upotrebite -o file (dozvole 0600) ili preusmerite\nstdout; odštampajte ga, pa obrišite datoteku.\n\n--web ga umesto toga prikazuje na jednokratnoj stranici za štampu\n(print_web.enabled; potreban je terminal i kucanje PRINT); pregledač ga\nštampa ili čuva kao PDF.",
  "confirm a plaintext sheet when there is no terminal": "potvrdi list kao otvoreni tekst kada nema terminala",
  "fields to print, comma-separated (default password,username,url)": "polja za štampu, odvojena zarezima (podrazumevano password,username,url)",
  "removed": "uklonjeno",
  "Open the vault with the paper recovery key and set a new passphrase": "Otvori trezor papirnim ključem za oporavak i postavi novu pristupnu frazu",
  "The paper recovery key": "Papirni ključ za oporavak",
  "say what to do, e.g. `passh recovery-key print`": "navedite šta treba uraditi, npr. `passh recovery-key print`",
  "Print the paper recovery key (needs a terminal and typing PRINT RECOVERY KEY)": "Odštampaj papirni ključ za oporavak (potreban je terminal i kucanje PRINT RECOVERY KEY)",
  "Print the paper recovery key as a text sheet: the vault key in groups of four\ncharacters, the vault_id, the print date, a warning and the manual recovery\nsteps. Whoever has the sheet and a copy of the vault can read everything: keep\nit offline, and print a new one after `passh rekey`.\n\nIt needs a terminal and typing PRINT RECOVERY KEY. The sheet is never written\nto a terminal: use -o file (mode 0600) or redirect stdout, print it, then delete\nthe file. --web shows it on the one-shot print page instead, with the key as a\nQR code; the browser prints it, or saves it as PDF.":
    "Štampa papirni ključ za oporavak kao tekstualni list: ključ trezora u grupama\nod po četiri znaka, vault_id, datum štampe, upozorenje i korake ručnog\noporavka. Ko ima list i kopiju trezora može da pročita sve: čuvajte ga van\nmreže i odštampajte novi posle `passh rekey`.\n\nPotreban je terminal i kucanje PRINT RECOVERY KEY. List se nikad ne upisuje na\nterminal: upotrebite -o file (dozvole 0600) ili preusmerite stdout, odštampajte\nga, pa obrišite datoteku. --web ga umesto toga prikazuje na jednokratnoj\nstranici za štampu, sa ključem kao QR kodom; pregledač ga štampa ili čuva kao\nPDF.",
  "Make a new vault key (the old passphrase and paper key stop working on new versions)": "Napravi novi ključ trezora (stara pristupna fraza i papirni ključ ne rade na novim verzijama)",
  "Make a new vault key and re-encrypt the data to it, with a passphrase (the same or\na new one). The old passphrase and paper recovery key don't open new versions of\nthe file. It asks for the current passphrase on the terminal, also while the\nagent runs: the agent's key isn't enough to replace the vault key. A running\nagent is stopped afterwards.":
    "Pravi novi ključ trezora i ponovo šifruje podatke njime, sa pristupnom frazom\n(istom ili novom). Stara pristupna fraza i papirni ključ za oporavak ne\notvaraju nove verzije datoteke. Traži trenutnu pristupnu frazu na terminalu, i\ndok agent radi: ključ agenta nije dovoljan za zamenu ključa trezora. Agent\nkoji radi se posle zaustavlja.",
  "Delete an entry (asks for confirmation)": "Obriši stavku (traži potvrdu)",
  "don't ask for confirmation": "ne traži potvrdu",
  "Print an entry (text form) or one field": "Prikaži stavku (tekstualni oblik) ili jedno polje",
  "Print an entry in its text form: the password on line 1, then username, url,\ntags and other fields, then the notes after ---.\n\nControl characters and escape sequences in the entry are shown escaped, so an\nentry can't drive your terminal. --raw prints the exact bytes instead.\n--field prints one value (password, username, url, tags, notes or a custom\nfield). When stdout is not a terminal (a pipe or a file), --field prints the\nexact value without a final newline, e.g.\n  passh show work/github --field password | pbcopy":
    "Ispisuje stavku u tekstualnom obliku: lozinku u 1. redu, zatim username, url,\ntags i ostala polja, pa beleške posle ---.\n\nKontrolni znakovi i escape sekvence u stavci prikazuju se u bezbednom obliku,\npa stavka ne može da upravlja vašim terminalom. --raw umesto toga ispisuje\ntačne bajtove. --field ispisuje jednu vrednost (password, username, url, tags,\nnotes ili dodatno polje). Kada stdout nije terminal (cev ili datoteka),\n--field ispisuje tačnu vrednost bez završnog preloma reda, npr.\n  passh show work/github --field password | pbcopy",
  "print only this field: password, username, url, tags, notes or a custom field": "ispiši samo ovo polje: password, username, url, tags, notes ili dodatno polje",
  "print exact bytes, without escaping control characters": "ispiši tačne bajtove, bez bezbednog prikaza kontrolnih znakova",
  "Add and remove tags of an entry": "Dodaj i ukloni oznake stavke",
  "tag to add (repeat, or separate with commas)": "oznaka za dodavanje (ponovi ili odvoji zarezima)",
  "tag to remove (repeat, or separate with commas)": "oznaka za uklanjanje (ponovi ili odvoji zarezima)",
  "List tags with their entry counts": "Prikaži oznake sa brojem stavki",
  "Start the agent: no passphrase prompts for a while, also without a terminal": "Pokreni agenta: neko vreme bez traženja pristupne fraze, i bez terminala",
  "Ask for the passphrase and start the agent, which keeps the vault key in memory\nso later commands, including ones without a terminal (ssh host passh show …),\ndon't ask for it. The agent exits after agent.idle_ttl without use, after\nagent.max_ttl (or --ttl) in any case, and on `passh lock`.\n\nWith an agent already running for the vault, unlock restarts its idle time and\nsays how long it has left. --ttl only applies to a new agent: passh says when it\nwasn't applied (run `passh lock` first).":
    "Traži pristupnu frazu i pokreće agenta, koji drži ključ trezora u memoriji,\npa je kasnije komande, uključujući one bez terminala (ssh host passh show …),\nne traže. Agent će se ugasiti posle agent.idle_ttl bez upotrebe, u svakom\nslučaju posle agent.max_ttl (ili --ttl), i na `passh lock`.\n\nAko za trezor već radi agent, unlock ponovo pokreće njegovo vreme neaktivnosti\ni kaže koliko mu je ostalo. --ttl važi samo za novog agenta: passh kaže kada\nnije primenjen (prvo pokrenite `passh lock`).",
  "stop a new agent after this long in any case (overrides agent.max_ttl), e.g. 30m": "zaustavi novog agenta posle ovoliko vremena u svakom slučaju (umesto agent.max_ttl), npr. 30m",
  "Check the vault or a copy of it": "Proveri trezor ili njegovu kopiju",
  "Check a vault file without the passphrase: the passh-vault line, both blocks\ncomplete, base64 and age headers valid. It prints the file's SHA-256 and size;\na byte-exact copy has the same SHA-256 as the original.\n\n--full also decrypts the file (through the agent, or by asking for the\npassphrase) and prints its vault_id, revision, saved_at and entry count, and\nhow it compares with the newest revision seen on this machine.":
    "Proverava datoteku trezora bez pristupne fraze: red passh-vault, oba bloka\ncelovita, base64 i age zaglavlja ispravna. Ispisuje SHA-256 i veličinu\ndatoteke; kopija tačna do bajta ima isti SHA-256 kao original.\n\n--full takođe dešifruje datoteku (preko agenta ili traženjem pristupne fraze)\ni ispisuje njen vault_id, reviziju, saved_at i broj stavki, i kako se poredi\nsa najnovijom revizijom viđenom na ovom računaru.",
  "also decrypt the file and check its data": "takođe dešifruj datoteku i proveri njene podatke",
  "Print passh's version": "Prikaži verziju passh-a",

  // src/cli/cmd_doctor.ts: level names and check names (cli.md §2.25; glossary: ok, upozorenje)
  "doctor\u0004ok": "ok",
  "doctor\u0004info": "info",
  "doctor\u0004skip": "preskočeno",
  "doctor\u0004warn": "upozorenje",
  "doctor\u0004error": "greška",
  "doctor\u0004config": "konfiguracija",
  "doctor\u0004vault": "trezor",
  "doctor\u0004vault mode": "dozvole trezora",
  "doctor\u0004vault folder": "fascikla trezora",
  "doctor\u0004temp files": "privremene datoteke",
  "doctor\u0004state folder": "fascikla stanja",
  "doctor\u0004agent": "agent",
  "doctor\u0004agent folder": "fascikla agenta",
  "doctor\u0004memory": "memorija",
  "doctor\u0004swap": "swap",
  "doctor\u0004core dumps": "core dump",
  "doctor\u0004terminal": "terminal",
  "doctor\u0004edit temp": "datoteke edit-a",
  "doctor\u0004clipboard": "ostava",

  // src/cli/cmd_doctor.ts: messages
  "--vault overrides the config's vault": "--vault zamenjuje vrednost vault iz konfiguracije",
  "no config file at %s; using --vault and the defaults": "nema konfiguracione datoteke na %s; koriste se --vault i podrazumevane vrednosti",
  "no config, so no vault to check": "nema konfiguracije, pa nema trezora za proveru",
  "%s doesn't exist: run `passh init`, or point the config's vault at your vault file": "%s ne postoji: pokrenite `passh init` ili usmerite vault u konfiguraciji na vašu datoteku trezora",
  "%s is a symlink that can't be resolved: %v": "%s je simbolička veza koja ne može da se razreši: %v",
  "%s is a symlink to %s; saves write the target": "%s je simbolička veza ka %s; čuvanje upisuje cilj",
  "%s: structure OK, %d bytes": "%s: struktura je u redu, bajtova: %d",
  "not in canonical form (line endings or wrapping changed); it opens, and the next save rewrites it":
    "nije u kanonskom obliku (promenjeni su završeci redova ili prelomi); otvara se, a sledeće čuvanje ga prepisuje",
  "%s: %v (SHA-256 %s)": "%s: %v (SHA-256 %s)",
  "mode %s, not 0600: fix it with chmod 600 %s": "dozvole %s, a ne 0600: ispravite komandom chmod 600 %s",
  "%s isn't writable (%v): saving needs a temporary file there": "u %s ne može da se piše (%v): čuvanju je tu potrebna privremena datoteka",
  "%s is writable": "u %s može da se piše",
  "can't list the vault's folder: %v": "sadržaj fascikle trezora ne može da se pročita: %v",
  "none": "nema",
  "%d files left by an interrupted save (%s); the next save removes them": {
    one: "%d datoteka je ostala posle prekinutog čuvanja (%s); sledeće čuvanje je uklanja",
    few: "%d datoteke su ostale posle prekinutog čuvanja (%s); sledeće čuvanje ih uklanja",
    many: "%d datoteka je ostalo posle prekinutog čuvanja (%s); sledeće čuvanje ih uklanja",
  },
  "%s doesn't exist yet; the first save creates it": "%s još ne postoji; prvo čuvanje je pravi",
  "%s is not a folder (backups, locks and the agent's socket go there)": "%s nije fascikla (tu idu rezervne kopije, brave i utičnica agenta)",
  "%s belongs to uid %d, not to you": "%s pripada uid %d, a ne vama",
  "%s isn't writable: %v": "u %s ne može da se piše: %v",
  "%s has mode %s: other users can look inside (the backups are encrypted); chmod 700 is better":
    "%s ima dozvole %s: drugi korisnici mogu da vide sadržaj (rezervne kopije su šifrovane); bolje je chmod 700",
  "no vault to check the agent for": "nema trezora za koji bi se proverio agent",
  "can't read the available memory: %v": "dostupna memorija ne može da se pročita: %v",
  "no MemAvailable line in /proc/meminfo": "u /proc/meminfo nema reda MemAvailable",
  "%s available: unlock needs 256 MiB for scrypt and may fail or swap": "dostupno %s: otključavanju treba 256 MiB za scrypt i može da ne uspe ili da koristi swap",
  "%s available (unlock needs 256 MiB)": "dostupno %s (otključavanju treba 256 MiB)",
  "can't read the memory size: %v": "veličina memorije ne može da se pročita: %v",
  "%s in total: unlock needs 256 MiB for scrypt and may fail or swap; available memory isn't checked on macOS":
    "ukupno %s: otključavanju treba 256 MiB za scrypt i može da ne uspe ili da koristi swap; dostupna memorija se ne proverava na macOS-u",
  "%s in total (unlock needs 256 MiB); available memory isn't checked on macOS": "ukupno %s (otključavanju treba 256 MiB); dostupna memorija se ne proverava na macOS-u",
  "not checked on this system": "ne proverava se na ovom sistemu",
  "can't read /proc/swaps: %v": "/proc/swaps ne može da se pročita: %v",
  "no swap is active": "nijedan swap nije aktivan",
  "%d swap areas are active (%s): process memory, decrypted secrets included, may be written to disk. passh doesn't change this; turn swap off or encrypt it if that matters to you": {
    one: "%d swap oblast je aktivna (%s): memorija procesa, uključujući dešifrovane tajne, može da bude upisana na disk. passh to ne menja; isključite swap ili ga šifrujte ako vam je to važno",
    few: "%d swap oblasti su aktivne (%s): memorija procesa, uključujući dešifrovane tajne, može da bude upisana na disk. passh to ne menja; isključite swap ili ga šifrujte ako vam je to važno",
    many: "%d swap oblasti je aktivno (%s): memorija procesa, uključujući dešifrovane tajne, može da bude upisana na disk. passh to ne menja; isključite swap ili ga šifrujte ako vam je to važno",
  },
  "can't read vm.swapusage: %v": "vm.swapusage ne može da se pročita: %v",
  "no swap is in use": "swap se ne koristi",
  "swap is active (%s used) and encrypted by macOS": "swap je aktivan (zauzeto %s) i šifruje ga macOS",
  "swap is active (%s used) and not encrypted: process memory, decrypted secrets included, may be written to disk":
    "swap je aktivan (zauzeto %s) i nije šifrovan: memorija procesa, uključujući dešifrovane tajne, može da bude upisana na disk",
  "reading core dump limit: %v": "čitanje ograničenja za core dump: %v",
  "disabled for passh and the agent": "isključen za passh i agenta",
  "not disabled: a crash could write secrets to a core file": "nije isključen: pad programa bi mogao da upiše tajne u core datoteku",
  "/dev/tty: passphrase prompts work": "/dev/tty: traženje pristupne fraze radi",
  "none: prompts are impossible, so commands need the agent (`passh unlock` in a terminal)": "nema: upiti nisu mogući, pa je komandama potreban agent (`passh unlock` u terminalu)",
  "no files left by an interrupted `edit --editor`": "nema datoteka zaostalih posle prekinutog `edit --editor`",
  "left by an interrupted `edit --editor`, possibly with an entry in plain text: %s; delete them (rm -r)":
    "zaostalo posle prekinutog `edit --editor`, možda sa stavkom kao otvorenim tekstom: %s; obrišite ih (rm -r)",
  "no config, so no clipboard settings to check": "nema konfiguracije, pa nema podešavanja ostave za proveru",
  "not tested without a terminal: run `passh doctor` in one (over SSH: ssh -t)": "ne proverava se bez terminala: pokrenite `passh doctor` u terminalu (preko SSH-a: ssh -t)",
  "inside tmux: OSC 52 needs `set -g set-clipboard on` in ~/.tmux.conf": "unutar tmux-a: OSC 52 traži `set -g set-clipboard on` u ~/.tmux.conf",
  "inside GNU screen: screen doesn't pass OSC 52 to the terminal; set clipboard.command or run passh outside screen":
    "unutar GNU screen-a: screen ne prosleđuje OSC 52 terminalu; podesite clipboard.command ili pokrenite passh van screen-a",
  "Terminal.app has no OSC 52: set clipboard.command = [\"pbcopy\"]": "Terminal.app nema OSC 52: podesite clipboard.command = [\"pbcopy\"]",
  "no clipboard: %v; copy with: passh show <path> --field password | pbcopy": "nema ostave: %v; kopirajte sa: passh show <path> --field password | pbcopy",
  "Testing the clipboard: copied \"passh clipboard test\" (%s). Paste it somewhere to check; it is cleared in %s.":
    "Provera ostave: kopirano je \"passh clipboard test\" (%s). Nalepite ga negde radi provere; ostava se čisti za %s.",
  "clearing the clipboard failed: %v": "čišćenje ostave nije uspelo: %v",
  "sent a test string with %s and cleared it; if pasting gave \"passh clipboard test\", copying works":
    "probni tekst je poslat preko %s i obrisan; ako je lepljenje dalo \"passh clipboard test\", kopiranje radi",
  "%d errors": { one: "%d greška", few: "%d greške", many: "%d grešaka" },
  "%d warnings": { one: "%d upozorenje", few: "%d upozorenja", many: "%d upozorenja" },
};
