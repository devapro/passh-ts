// Times of the data block (vault-format.md §4.1): whole seconds since the Unix epoch, UTC.
// Written `YYYY-MM-DDThh:mm:ssZ`; read with the grammar of §4.1 (RFC 3339 and the forms Go's
// time.Parse also accepts: a one-digit hour, `,` before the fraction, an offset hour of 24
// or minute of 60).

import { errorf } from "../i18n/index.ts";
import { ZERO_TIME, type Time } from "./types.ts";

export { ZERO_TIME };

/** Smallest and largest times passh reads: 0000-01-01T00:00:00Z … 9999-12-31T23:59:59Z. */
export const MIN_TIME: Time = -62167219200;
export const MAX_TIME: Time = 253402300799;

/** Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's days_from_civil). */
export function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The date of a day number (inverse of daysFromCivil). */
export function civilFromDays(z: number): [number, number, number] {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function pad(n: number, w: number): string {
  return String(n).padStart(w, "0");
}

/** Formats a time as passh writes it: `YYYY-MM-DDThh:mm:ssZ` (UTC). */
export function formatTime(t: Time): string {
  const days = Math.floor(t / 86400);
  const secs = t - days * 86400;
  const [y, m, d] = civilFromDays(days);
  const ys = y < 0 ? "-" + pad(-y, 4) : pad(y, 4);
  return `${ys}-${pad(m, 2)}-${pad(d, 2)}T${pad(Math.floor(secs / 3600), 2)}:${pad(Math.floor(secs / 60) % 60, 2)}:${pad(secs % 60, 2)}Z`;
}

/** Builds a time from UTC parts. */
export function timeFromParts(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Time {
  return daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s;
}

/** The current time in whole seconds (truncated). */
export function nowTime(): Time {
  return Math.floor(Date.now() / 1000);
}

/** Converts a JS Date to a Time (truncated to the second). */
export function timeFromDate(d: Date): Time {
  return Math.floor(d.getTime() / 1000);
}

/** Converts a Time to a JS Date. */
export function dateFromTime(t: Time): Date {
  return new Date(t * 1000);
}

function digits(s: string, i: number, n: number): number {
  let v = 0;
  for (let k = 0; k < n; k++) {
    const c = s.charCodeAt(i + k);
    if (!(c >= 0x30 && c <= 0x39)) return -1;
    v = v * 10 + (c - 0x30);
  }
  return v;
}

function isDigit(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c >= 0x30 && c <= 0x39;
}

/**
 * Parses a time by the grammar of §4.1. Returns the time, "bad" or "range" (a valid time
 * whose UTC year lies outside 0000–9999).
 */
export function parseTimeResult(s: string): Time | "bad" | "range" {
  // date = 4DIGIT "-" 2DIGIT "-" 2DIGIT
  if (s.length < 10) return "bad";
  const y = digits(s, 0, 4);
  if (y < 0 || s[4] !== "-") return "bad";
  const mo = digits(s, 5, 2);
  if (mo < 0 || s[7] !== "-") return "bad";
  const d = digits(s, 8, 2);
  if (d < 0 || s[10] !== "T") return "bad";
  if (mo < 1 || mo > 12) return "bad";
  const dim = mo === 2 && isLeap(y) ? 29 : MONTH_DAYS[mo - 1]!;
  if (d < 1 || d > dim) return "bad";
  // hour = 1*2DIGIT
  let i = 11;
  if (!isDigit(s, i)) return "bad";
  let h = s.charCodeAt(i) - 0x30;
  i++;
  if (isDigit(s, i)) {
    h = h * 10 + (s.charCodeAt(i) - 0x30);
    i++;
  }
  if (h > 23 || s[i] !== ":") return "bad";
  const mi = digits(s, i + 1, 2);
  if (mi < 0 || mi > 59 || s[i + 3] !== ":") return "bad";
  const sec = digits(s, i + 4, 2);
  if (sec < 0 || sec > 59) return "bad";
  i += 6;
  // [ ("." / ",") 1*DIGIT ]: only the first 9 digits count, and the time is truncated anyway
  if (s[i] === "." || s[i] === ",") {
    i++;
    if (!isDigit(s, i)) return "bad";
    while (isDigit(s, i)) i++;
  }
  // "Z" / ("+" / "-") OH ":" OM
  let offset = 0;
  if (s[i] === "Z") {
    i++;
  } else if (s[i] === "+" || s[i] === "-") {
    const oh = digits(s, i + 1, 2);
    if (oh < 0 || oh > 24 || s[i + 3] !== ":") return "bad";
    const om = digits(s, i + 4, 2);
    if (om < 0 || om > 60) return "bad";
    offset = (oh * 60 + om) * 60 * (s[i] === "-" ? -1 : 1);
    i += 6;
  } else {
    return "bad";
  }
  if (i !== s.length) return "bad";
  const t = timeFromParts(y, mo, d, h, mi, sec) - offset;
  if (t < MIN_TIME || t > MAX_TIME) return "range";
  return t;
}

/**
 * Parses a time (§4.1). Throws `bad time "<s>"` or `time "<s>" is out of range` (the value
 * Go-quoted); the caller puts the key in front (`saved_at: bad time "x"`).
 */
export function parseTime(s: string): Time {
  const r = parseTimeResult(s);
  if (r === "bad") throw errorf("bad time %q", s);
  if (r === "range") throw errorf("time %q is out of range", s);
  return r;
}
