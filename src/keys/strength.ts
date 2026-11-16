// Passphrase strength (vault-format.md §3.5, spec §5.4). Not normative: the estimator, its
// inputs, the score and the reasons. What binds: it never refuses a passphrase.
//
// passh scores with a Go port of zxcvbn (trustelem/zxcvbn); this uses the original
// zxcvbn 4.4.2 (same dictionaries and scoring), loaded lazily because parsing its
// dictionaries takes ~50 ms. The reason texts follow passh's (checked against the
// reference): zxcvbn's warnings in lower case, plus "common words are easy to guess" and
// "a word by itself is easy to guess" for every word list, not only Wikipedia's.

import { hostname } from "node:os";
import { T } from "../i18n/index.ts";
import { decodeUtf8Lossy } from "./recovery.ts";

/** The score below which passh warns (of 0–4). */
export const WEAK_SCORE = 3;

interface ZxcvbnMatch {
  pattern: string;
  token: string;
  dictionary_name?: string;
  rank?: number;
  l33t?: boolean;
  reversed?: boolean;
  guesses_log10?: number;
  turns?: number;
  base_token?: string;
  regex_name?: string;
}

interface ZxcvbnResult {
  score: number;
  sequence: ZxcvbnMatch[];
}

type Zxcvbn = (password: string, userInputs?: string[]) => ZxcvbnResult;

let zxcvbnFn: Zxcvbn | undefined;

function zxcvbn(): Zxcvbn {
  // A static string, so `bun build --compile` bundles the module.
  zxcvbnFn ??= require("zxcvbn") as Zxcvbn;
  return zxcvbnFn;
}

/** The user inputs passh gives zxcvbn: `passh`, `vault`, `$USER` (if set) and the host name. */
export function defaultUserInputs(env: Record<string, string | undefined> = process.env): string[] {
  const inputs = ["passh", "vault"];
  const user = env.USER;
  if (user) inputs.push(user);
  try {
    const h = hostname();
    if (h) inputs.push(h);
  } catch {
    /* no host name */
  }
  return inputs;
}

/** The English reason for the longest match (zxcvbn's feedback, passh's wording); null for none. */
function matchReason(m: ZxcvbnMatch, sole: boolean): string | null {
  switch (m.pattern) {
    case "dictionary": {
      const d = m.dictionary_name;
      if (d === "passwords") {
        if (sole && !m.l33t && !m.reversed) {
          if ((m.rank ?? Infinity) <= 10) return "this is a top-10 common password";
          if ((m.rank ?? Infinity) <= 100) return "this is a top-100 common password";
          return "this is a very common password";
        }
        return (m.guesses_log10 ?? Infinity) <= 4 ? "this is similar to a commonly used password" : null;
      }
      if (d === "surnames" || d === "male_names" || d === "female_names") {
        return sole ? "names and surnames by themselves are easy to guess" : "common names and surnames are easy to guess";
      }
      if (d === "english_wikipedia" || d === "us_tv_and_film") {
        return sole ? "a word by itself is easy to guess" : "common words are easy to guess";
      }
      return null;
    }
    case "spatial":
      return m.turns === 1 ? "straight rows of keys are easy to guess" : "short keyboard patterns are easy to guess";
    case "repeat":
      return (m.base_token ?? "").length === 1 ? 'repeats like "aaa" are easy to guess' : 'repeats like "abcabcabc" are only slightly harder to guess than "abc"';
    case "sequence":
      return "sequences like abc or 6543 are easy to guess";
    case "regex":
      return m.regex_name === "recent_year" ? "recent years are easy to guess" : null;
    case "date":
      return "dates are often easy to guess";
    default:
      return null;
  }
}

export interface Strength {
  /** zxcvbn's score, 0–4. */
  score: number;
  /** The English reason (a catalogue key) when the score is below 3 and zxcvbn has one. */
  reason: string | null;
}

/**
 * Scores a passphrase on its first 100 code points (an invalid UTF-8 byte counts as one)
 * with the given user inputs.
 */
export function passphraseStrength(passphrase: Uint8Array, userInputs: string[] = defaultUserInputs()): Strength {
  const cps = decodeUtf8Lossy(passphrase).slice(0, 100);
  const text = String.fromCodePoint(...cps);
  cps.fill(0);
  const r = zxcvbn()(text, userInputs);
  if (r.score >= WEAK_SCORE) return { score: r.score, reason: null };
  if (r.sequence.length === 0) return { score: r.score, reason: "it is empty or too short" };
  let longest = r.sequence[0]!;
  for (const m of r.sequence.slice(1)) if (m.token.length > longest.token.length) longest = m;
  return { score: r.score, reason: matchReason(longest, r.sequence.length === 1) };
}

/**
 * The warning passh shows on /dev/tty after the first entry of a new passphrase, in the
 * current language, or null when the passphrase isn't weak:
 * `warning: weak passphrase: <reason>; use 6 or more random words`, or without a reason
 * `warning: weak passphrase; use 6 or more random words`.
 */
export function weakPassphraseWarning(passphrase: Uint8Array, userInputs: string[] = defaultUserInputs()): string | null {
  const s = passphraseStrength(passphrase, userInputs);
  if (s.score >= WEAK_SCORE) return null;
  if (s.reason === null) return T("warning: weak passphrase; use 6 or more random words");
  return T("warning: weak passphrase: %s; use 6 or more random words", T(s.reason));
}
