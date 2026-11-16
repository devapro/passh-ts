// Go-compatible quoting (strconv.Quote, used by fmt's %q verb).
// i18n.md §4, cli.md §1.1: values in several messages are "Go-quoted".

const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

/** Reports whether Go's unicode.IsPrint would accept the code point (L, M, N, P, S and U+0020). */
export function isGoPrint(cp: number): boolean {
  if (cp === 0x20) return true;
  if (cp < 0x20 || cp === 0x7f) return false;
  return PRINTABLE.test(String.fromCodePoint(cp));
}

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, "0");
}

function escapeRune(cp: number, quote: string): string {
  if (cp === quote.codePointAt(0) || cp === 0x5c) return "\\" + String.fromCodePoint(cp);
  if (isGoPrint(cp)) return String.fromCodePoint(cp);
  switch (cp) {
    case 0x07: return "\\a";
    case 0x08: return "\\b";
    case 0x0c: return "\\f";
    case 0x0a: return "\\n";
    case 0x0d: return "\\r";
    case 0x09: return "\\t";
    case 0x0b: return "\\v";
  }
  if (cp < 0x20 || cp === 0x7f) return "\\x" + hex(cp, 2);
  if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd; // lone surrogate in a JS string: Go would see U+FFFD
  if (cp === 0xfffd) return String.fromCodePoint(cp); // U+FFFD is printable (So)
  if (cp < 0x10000) return "\\u" + hex(cp, 4);
  return "\\U" + hex(cp, 8);
}

/**
 * Go's strconv.Quote. A string is taken as already-decoded text; a Uint8Array is
 * decoded as UTF-8 with each invalid byte written as \xNN, exactly like Go.
 */
export function goQuote(s: string | Uint8Array): string {
  let out = '"';
  if (typeof s === "string") {
    for (const ch of s) out += escapeRune(ch.codePointAt(0)!, '"');
    return out + '"';
  }
  let i = 0;
  while (i < s.length) {
    const [cp, size] = decodeRune(s, i);
    if (cp < 0) {
      out += "\\x" + hex(s[i]!, 2);
      i += 1;
      continue;
    }
    out += escapeRune(cp, '"');
    i += size;
  }
  return out + '"';
}

/**
 * Decodes one UTF-8 character at s[i]. Returns [codePoint, size]; codePoint is -1 for an
 * invalid byte (size 1): truncated, overlong, surrogate, above U+10FFFF.
 */
export function decodeRune(s: Uint8Array, i: number): [number, number] {
  const b0 = s[i]!;
  if (b0 < 0x80) return [b0, 1];
  let need: number, min: number, cp: number;
  if (b0 >= 0xc2 && b0 <= 0xdf) { need = 1; min = 0x80; cp = b0 & 0x1f; }
  else if (b0 >= 0xe0 && b0 <= 0xef) { need = 2; min = 0x800; cp = b0 & 0x0f; }
  else if (b0 >= 0xf0 && b0 <= 0xf4) { need = 3; min = 0x10000; cp = b0 & 0x07; }
  else return [-1, 1];
  for (let k = 1; k <= need; k++) {
    const b = s[i + k];
    if (b === undefined || (b & 0xc0) !== 0x80) return [-1, 1];
    cp = (cp << 6) | (b & 0x3f);
  }
  if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return [-1, 1];
  return [cp, need + 1];
}

/** Reports whether the bytes are valid UTF-8 (no surrogates, no overlongs). */
export function isValidUTF8(s: Uint8Array): boolean {
  let i = 0;
  while (i < s.length) {
    if (s[i]! < 0x80) { i++; continue; }
    const [cp, size] = decodeRune(s, i);
    if (cp < 0) return false;
    i += size;
  }
  return true;
}
