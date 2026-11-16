// Display width of text (print.md §3.2): a rune of East Asian Width Wide (W) or Fullwidth (F)
// takes 2 columns, a non-spacing or enclosing mark (Mn, Me) 0, every other rune 1
// (Ambiguous, Neutral, Narrow and Halfwidth count 1; a spacing mark Mc counts 1). Unicode
// 15.0.0 tables (EastAsianWidth.txt, general categories).
//
// This is the width of text that S4 has already escaped (no control characters left). The
// TUI's widths are informative (tui.md: the reference measures grapheme clusters); it uses
// the same rule.

// SPEC-GAP: print.md §3.2 defines widths for text after S4, so control characters have no
// rule; they count 1 here.

import { isWide, isZeroWidthMark } from "../util/unicode.ts";

/** Columns of one code point: 0 for Mn/Me, 2 for East Asian Wide/Fullwidth, else 1. */
export function runeWidth(cp: number): number {
  if (cp < 0x300) return 1; // ASCII, Latin-1, Latin Extended: neither marks nor wide
  if (isZeroWidthMark(cp)) return 0;
  return isWide(cp) ? 2 : 1;
}

/** Display width of a string: the sum of its runes' widths (a lone surrogate counts 1). */
export function stringWidth(s: string): number {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x300) {
      w++;
      continue;
    }
    let cp = c;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      cp = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(i + 1) - 0xdc00);
      i++;
    }
    w += runeWidth(cp);
  }
  return w;
}
