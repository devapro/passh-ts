// Serbian (Latin) texts of the print area (sheets, print page, its server and dialog), to be
// merged into the sr catalogue by the lead. The sheet frame strings (print.md §8) are
// normative; the rest follows the glossary of docs/translations.md (wording not normative).

import type { Catalog } from "../i18n/index.ts";

export const PRINT_CATALOG_SR: Catalog = {
  // print.md §8: sheet frame strings (normative)
  CONFIDENTIAL: "POVERLJIVO",
  "passh password sheet": "passh list sa lozinkama",
  "passh paper recovery key": "passh papirni ključ za oporavak",
  "page %d of %d": "strana %d od %d",
  "printed %s": "odštampano %s",
  "%d entries": { one: "%d stavka", few: "%d stavke", many: "%d stavki" },
  "folder %s": "fascikla %s",
  "tag %s": "oznaka %s",
  "tags %s": "oznake %s",
  "fields: %s": "polja: %s",
  "(top level)": "(najviši nivo)",
  "%s (continued)": "%s (nastavak)",
  "Under 0 O 1 l I and spaces: D digit, U capital letter, L small letter, S space": "Ispod 0 O 1 l I i razmaka: D cifra, U veliko slovo, L malo slovo, S razmak",
  "%s continues the line above; \\uXXXX is a character that can't be printed": "%s nastavlja red iznad; \\uXXXX je znak koji ne može da se odštampa",
  "Vault key": "Ključ trezora",
  "Forgotten passphrase": "Zaboravljena pristupna fraza",
  "Without passh": "Bez programa passh",
  "# asks for the passphrase": "# traži pristupnu frazu",
  "QR code of the vault key": "QR kod ključa trezora",

  // Recovery key sheet prose
  "Whoever has this sheet and a copy of the vault can read everything in the vault.": "Ko ima ovaj list i kopiju trezora može da pročita sve što je u trezoru.",
  "Keep it offline, like cash. If it may have been seen, copied or lost, run `passh rekey` and print a new sheet: the old key then no longer opens new versions of the vault (copies made before still open with it).":
    "Čuvajte ga van mreže, kao gotovinu. Ako je možda viđen, kopiran ili izgubljen, pokrenite `passh rekey` i odštampajte novi list: stari ključ tada više ne otvara nove verzije trezora (kopije napravljene ranije i dalje se otvaraju njime).",
  "After AGE-SECRET-KEY-1 the key never has the letters B, I or O or the digit 1: 0 is always the digit zero.": "Posle AGE-SECRET-KEY-1 ključ nikad nema slova B, I ni O ni cifru 1: 0 je uvek cifra nula.",
  "The key's QR code is on the web page (`passh recovery-key print --web`).": "QR kod ključa je na stranici za štampu (`passh recovery-key print --web`).",
  "Run `passh recover` and type the key above. Spaces, line breaks and letter case are ignored, and the key's checksum catches typos. passh then asks for a new passphrase.":
    "Pokrenite `passh recover` i otkucajte ključ odozgo. Razmaci, prelomi redova i veličina slova se zanemaruju, a kontrolni zbir ključa otkriva greške u kucanju. passh zatim traži novu pristupnu frazu.",
  "On any machine with age (https://age-encryption.org) v1.0 or later, where vault.passh is a copy of the vault file:": "Na bilo kom računaru sa programom age (https://age-encryption.org) v1.0 ili novijim, gde je vault.passh kopija datoteke trezora:",
  "With this key instead of the passphrase: write it to /dev/shm/key.txt as one line, without spaces, in capital letters as printed (AGE-SECRET-KEY-1 and then the groups), instead of running the first and third commands. The other commands stay the same.":
    "Sa ovim ključem umesto pristupne fraze: upišite ga u /dev/shm/key.txt kao jedan red, bez razmaka, velikim slovima kako je odštampan (AGE-SECRET-KEY-1 pa grupe), umesto prve i treće komande. Ostale komande ostaju iste.",
  "vault.json is plaintext. Keep it on tmpfs (/dev/shm on Linux) and delete it when done.": "vault.json je otvoreni tekst. Držite ga na tmpfs-u (/dev/shm na Linuxu) i obrišite ga kada završite.",
  "If a mail client or editor re-wrapped the lines, age may reject the blocks. passh still opens such a file, and `passh backup` writes it back in canonical form.":
    "Ako je klijent e-pošte ili uređivač ponovo prelomio redove, age može da odbije blokove. passh i dalje otvara takvu datoteku, a `passh backup` je zapisuje nazad u kanonskom obliku.",

  // The page and its error bodies
  "Print with Ctrl+P (Cmd+P on a Mac), then close this tab. This page was served once and is gone from passh; the browser may still keep it in its session history.":
    "Odštampajte sa Ctrl+P (Cmd+P na Mac-u), pa zatvorite ovu karticu. Stranica je poslata jednom i više je nema u passh-u; pregledač je možda još čuva u istoriji sesije.",
  "misdirected request: unknown host": "pogrešno usmeren zahtev: nepoznat host",
  "method not allowed": "metod nije dozvoljen",
  "already used: start the print page again in passh": "već iskorišćena: ponovo pokrenite stranicu za štampu u passh-u",
  "stopped after too many wrong addresses: start the print page again in passh": "zaustavljena posle previše pogrešnih adresa: ponovo pokrenite stranicu za štampu u passh-u",

  // Server start, addresses, certificate
  "the print page is off: set enabled = true in the [print_web] table of the config file": "stranica za štampu je isključena: postavite enabled = true u tabeli [print_web] konfiguracione datoteke",
  "print_web.ttl: %s is not between 1m0s and 15m0s": "print_web.ttl: %s nije između 1m0s i 15m0s",
  "print_web.port: %d is not between 1 and 65535": "print_web.port: %d nije između 1 i 65535",
  "print_web.hostnames: %q is not a hostname": "print_web.hostnames: %q nije ime hosta",
  'print_web.allow_from: %q is not a CIDR such as "192.168.1.0/24" or "fd00::/8"': 'print_web.allow_from: %q nije CIDR kao "192.168.1.0/24" ili "fd00::/8"',
  "%s: no such network interface": "%s: nema takvog mrežnog interfejsa",
  "%s: no address": "%s: nema adrese",
  "%s: %s is link-local, not used": "%s: %s je link-local adresa, ne koristi se",
  "%s: %s is the wildcard address, never used": "%s: %s je džoker adresa, nikad se ne koristi",
  "%s: %s is a loopback address, not private": "%s: %s je loopback adresa, nije privatna",
  "%s: %s is a multicast address, not used": "%s: %s je multicast adresa, ne koristi se",
  "%s: %s is a public address, refused": "%s: %s je javna adresa, odbijena",
  'print_web.interfaces is empty: name the interfaces of your LAN or VPN, e.g. ["eth0", "wg0"]': 'print_web.interfaces je prazan: navedite interfejse vaše lokalne mreže ili VPN-a, npr. ["eth0", "wg0"]',
  "the print page has no private address to listen on (print_web.interfaces): %s": "stranica za štampu nema privatnu adresu na kojoj bi slušala (print_web.interfaces): %s",
  "not used: %s": "ne koristi se: %s",
  "print page: %s": "stranica za štampu: %s",
  "print page certificate folder %s is not a folder": "fascikla sertifikata stranice za štampu %s nije fascikla",
  "print page certificate folder %s: %v": "fascikla sertifikata stranice za štampu %s: %v",
  "print page certificate: can't create a temporary file in %s": "sertifikat stranice za štampu: ne može da se napravi privremena datoteka u %s",
  "first use": "prva upotreba",
  "the stored certificate can't be read: %v": "sačuvani sertifikat ne može da se pročita: %v",
  "the stored key can't be read: %v": "sačuvani ključ ne može da se pročita: %v",
  "the stored key is not a regular file": "sačuvani ključ nije obična datoteka",
  "the stored key had mode %s, readable by others": "sačuvani ključ je imao dozvole %s, čitljiv drugima",
  "the stored certificate can't be used: %v": "sačuvani sertifikat ne može da se koristi: %v",
  "the stored certificate is not valid until %s": "sačuvani sertifikat važi tek od %s",
  "the stored certificate expired on %s": "sačuvanom sertifikatu je istekao rok %s",
  "the stored certificate expires on %s": "sačuvanom sertifikatu ističe rok %s",
  "the addresses or hostnames changed: the old one doesn't cover %s": "adrese ili imena hostova su se promenili: stari sertifikat ne pokriva %s",
  "made a new certificate for the print page (%s); browsers will warn about it: compare the fingerprint": "napravljen je novi sertifikat za stranicu za štampu (%s); pregledači će upozoravati na njega: uporedite otisak",

  // Results (print.md §6.7)
  "the page was served to %s; if that wasn't you, start the print page again": "stranica je poslata na %s; ako to niste bili vi, ponovo pokrenite stranicu za štampu",
  "the page was only partly sent to %s (%v); start the print page again": "stranica je samo delimično poslata na %s (%v); ponovo pokrenite stranicu za štampu",
  "the print page was stopped while it was sent to %s": "stranica za štampu je zaustavljena dok je slata na %s",
  "the print page was stopped": "stranica za štampu je zaustavljena",
  "the print page stopped after %s without being opened": "stranica za štampu se zaustavila posle %s, a da nije otvorena",
  "the print page stopped after 5 requests with a wrong address": "stranica za štampu se zaustavila posle 5 zahteva sa pogrešnom adresom",

  // The dialog (print.md §6.9)
  "certificate SHA-256  %s": "sertifikat SHA-256  %s",
  "Compare it with the fingerprint your browser shows before you accept the certificate.": "Uporedite ga sa otiskom koji pregledač prikazuje pre nego što prihvatite sertifikat.",
  "c copies the URL · Esc stops": "c kopira URL · Esc zaustavlja",
  "stops after one load or in %s": "zaustavlja se posle jednog učitavanja ili za %s",
  "URL copied · ": "URL kopiran · ",
  "copy failed · ": "kopiranje nije uspelo · ",
  "no clipboard · ": "nema ostave · ",
  "Done: %s.": "Gotovo: %s.",

  // Commands (print.md §1, cli.md §2.17, §2.24)
  "PDF output was removed; use --web to print from a browser (it can save as PDF), or omit --format for the text sheet": "izlaz u PDF je uklonjen; koristite --web da odštampate iz pregledača (može da sačuva kao PDF), ili izostavite --format za tekstualni list",
  "--output can't be used with --web": "--output ne može da se koristi uz --web",
  "--confirm-plaintext can't be used with --web: the print page needs a terminal": "--confirm-plaintext ne može da se koristi uz --web: stranici za štampu treba terminal",
  "invalid field %q: use password, username, url, tags, notes, fields, or the key of a custom field": "neispravno polje %q: koristite password, username, url, tags, notes, fields ili ključ dodatnog polja",
  "invalid field %q: no selected entry has a field with this key": "neispravno polje %q: nijedna izabrana stavka nema polje sa tim ključem",
  "no entries to print: the vault has no entries": "nema stavki za štampu: trezor nema stavki",
  "no entries to print: none matches %s": "nema stavki za štampu: nijedna ne odgovara uslovu %s",
  "refusing to write the sheet to a terminal: add -o file or redirect stdout": "list se ne ispisuje na terminal: dodajte -o datoteka ili preusmerite stdout",
  "refusing to write the recovery key to a terminal: add -o file or redirect stdout": "ključ za oporavak se ne ispisuje na terminal: dodajte -o datoteka ili preusmerite stdout",
  "The sheet holds your passwords unencrypted.": "List sadrži vaše lozinke nešifrovane.",
  "printing needs confirmation: without a terminal, add --confirm-plaintext": "za štampu je potrebna potvrda: bez terminala dodajte --confirm-plaintext",
  "printed %d entries (text sheet) to %s; print it, then delete the file": {
    one: "upisana je %d stavka (tekstualni list) u %s; odštampajte ga, pa obrišite datoteku",
    few: "upisane su %d stavke (tekstualni list) u %s; odštampajte ga, pa obrišite datoteku",
    many: "upisano je %d stavki (tekstualni list) u %s; odštampajte ga, pa obrišite datoteku",
  },
  "the print page needs a terminal (over SSH: use `ssh -t`)": "stranici za štampu treba terminal (preko SSH-a: koristite `ssh -t`)",
  "passh %s needs a terminal (over SSH: use `ssh -t`)": "passh %s treba terminal (preko SSH-a: koristite `ssh -t`)",
  "Wrote the paper recovery key to %s.": "Papirni ključ za oporavak je upisan u %s.",
  "print it, keep the sheet offline, then delete the file: rm %s": "odštampajte ga, čuvajte list van mreže, pa obrišite datoteku: rm %s",
  "%s already exists; passh doesn't overwrite files": "%s već postoji; passh ne prepisuje datoteke",
  "%s isn't on tmpfs: the plaintext is on persistent disk. Delete it when you're done": "%s nije na tmpfs-u: otvoreni tekst je na trajnom disku. Obrišite ga kada završite",
  "%w; the partial file was removed": "%w; nepotpuna datoteka je obrisana",
  "%w; the partial file %s could not be removed (%v): delete it": "%w; nepotpuna datoteka %s nije mogla da se obriše (%v): obrišite je",
};
