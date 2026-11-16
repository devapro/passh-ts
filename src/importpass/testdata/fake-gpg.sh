#!/bin/sh
# A fake gpg for the import tests (test code: S8 applies to the product, not to fakes).
# It reads the "ciphertext" on stdin and follows the directives in it:
#
#   #!fake-gpg              first line, else it reports NODATA and exits 2
#   status <text>           writes "[GNUPG:] <text>" to fd 3
#   raw <text>              writes "<text>" to fd 3
#   rawcr <text>            writes "<text>" CR LF to fd 3
#   exit <n>                exit status at the end (default 0)
#   kill <SIG>              kills itself with the signal at the end
#   sleep <s>               sleeps
#   big <n>                 writes n bytes "a" to stdout
#   bigstatus <n>           writes n bytes "x" (no LF) to fd 3
#   hold <s>                leaves a background process holding fd 3 for s seconds
#   tty <text>              writes the text to /dev/tty
#   --                      everything after this line is the plaintext, copied to stdout
#
# $FAKE_GPG_LOG, if set, gets one line per run: "<argv0>|<args>|GPG_TTY=<value or <unset>>".
tmp=$(mktemp) || exit 70
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"
if [ -n "$FAKE_GPG_LOG" ]; then
  printf '%s|%s|GPG_TTY=%s\n' "$(basename "$0")" "$*" "${GPG_TTY-<unset>}" >> "$FAKE_GPG_LOG"
fi
if [ "$(head -n 1 "$tmp")" != "#!fake-gpg" ]; then
  printf '[GNUPG:] NODATA 1\n' >&3
  exit 2
fi
code=0
sig=
while IFS= read -r line; do
  case $line in
    "--") break ;;
    "status "*) printf '[GNUPG:] %s\n' "${line#status }" >&3 ;;
    "raw "*) printf '%s\n' "${line#raw }" >&3 ;;
    "rawcr "*) printf '%s\r\n' "${line#rawcr }" >&3 ;;
    "exit "*) code=${line#exit } ;;
    "kill "*) sig=${line#kill } ;;
    "sleep "*) sleep "${line#sleep }" ;;
    "big "*) head -c "${line#big }" /dev/zero | tr '\0' a ;;
    "bigstatus "*) head -c "${line#bigstatus }" /dev/zero | tr '\0' x >&3 ;;
    "hold "*) sleep "${line#hold }" </dev/null >/dev/null 2>&1 & ;;
    "tty "*) printf '%s' "${line#tty }" > /dev/tty ;;
  esac
done < "$tmp"
sed '1,/^--$/d' "$tmp"
if [ -n "$sig" ]; then kill -s "$sig" $$; fi
exit "$code"
