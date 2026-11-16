// Word splitting of $EDITOR without a shell (agent-session.md §A7, errors §A6).
//
// Words split on unquoted space, tab and newline; '…' is literal; "…" is literal except
// \" \\ \$ \` ; outside quotes \x is x; adjacent parts join; "" is an empty word; nothing
// is expanded ($VAR, $(…), ~, globs, ; | & < > are plain characters).

import { errorf, type PasshError } from "../i18n/index.ts";

const BLANK = new Set([" ", "\t", "\n"]);
const DQ_ESCAPABLE = new Set(['"', "\\", "$", "`"]);

/** Splits a command line into words. Throws the §A6 errors (`unterminated single quote in "…"`, …). */
export function splitWords(s: string): string[] {
  const words: string[] = [];
  let cur: string | null = null;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    if (BLANK.has(c)) {
      if (cur !== null) words.push(cur);
      cur = null;
      i++;
      continue;
    }
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) throw wordError("unterminated single quote in %q", s);
      cur = (cur ?? "") + s.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      cur = cur ?? "";
      i++;
      for (;;) {
        if (i >= n) throw wordError("unterminated double quote in %q", s);
        const d = s[i]!;
        if (d === '"') {
          i++;
          break;
        }
        if (d === "\\" && i + 1 < n && DQ_ESCAPABLE.has(s[i + 1]!)) {
          cur += s[i + 1]!;
          i += 2;
          continue;
        }
        cur += d;
        i++;
      }
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= n) throw wordError("trailing backslash in %q", s);
      cur = (cur ?? "") + s[i + 1]!;
      i += 2;
      continue;
    }
    cur = (cur ?? "") + c;
    i++;
  }
  if (cur !== null) words.push(cur);
  return words;
}

function wordError(format: string, value: string): PasshError {
  const e = errorf(format, value);
  return e;
}
