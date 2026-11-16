// Go durations: time.ParseDuration and Duration.String, and passh's short form <D>
// (cli.md notation, agent-session.md §A2.3). Durations are bigint nanoseconds.

export const NS = 1n;
export const US = 1000n;
export const MS = 1_000_000n;
export const SEC = 1_000_000_000n;
export const MIN = 60n * SEC;
export const HOUR = 60n * MIN;
const MAX_INT64 = (1n << 63n) - 1n;

const UNITS: Record<string, bigint> = {
  ns: NS,
  us: US,
  "µs": US, // U+00B5
  "μs": US, // U+03BC
  ms: MS,
  s: SEC,
  m: MIN,
  h: HOUR,
};

/** Go's time.quote: ASCII printable kept (with \" and \\), every other byte as \xNN. */
function timeQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x80 || c < 0x20) {
      for (const b of new TextEncoder().encode(ch)) out += "\\x" + b.toString(16).padStart(2, "0");
    } else {
      if (ch === '"' || ch === "\\") out += "\\";
      out += ch;
    }
  }
  return out + '"';
}

export class DurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurationError";
  }
}

/** Go's time.ParseDuration. Returns nanoseconds; throws DurationError with Go's message. */
export function parseGoDuration(input: string): bigint {
  const orig = input;
  let s = input;
  let neg = false;
  if (s !== "") {
    const c = s[0];
    if (c === "-" || c === "+") {
      neg = c === "-";
      s = s.slice(1);
    }
  }
  if (s === "0") return 0n;
  if (s === "") throw new DurationError("time: invalid duration " + timeQuote(orig));
  let d = 0n;
  while (s !== "") {
    // the next character must be [0-9.]
    if (!(s[0] === "." || (s[0]! >= "0" && s[0]! <= "9"))) throw new DurationError("time: invalid duration " + timeQuote(orig));
    let i = 0;
    while (i < s.length && s[i]! >= "0" && s[i]! <= "9") i++;
    const intPart = s.slice(0, i);
    const pre = i > 0;
    let v = 0n;
    if (pre) {
      v = BigInt(intPart);
      if (v > MAX_INT64) throw new DurationError("time: invalid duration " + timeQuote(orig));
    }
    s = s.slice(i);
    let frac = 0n;
    let scale = 1n;
    let post = false;
    if (s[0] === ".") {
      s = s.slice(1);
      let j = 0;
      let overflow = false;
      while (j < s.length && s[j]! >= "0" && s[j]! <= "9") {
        if (!overflow) {
          if (frac > MAX_INT64 / 10n) overflow = true;
          else {
            frac = frac * 10n + BigInt(s.charCodeAt(j) - 48);
            scale *= 10n;
          }
        }
        j++;
      }
      post = j > 0;
      s = s.slice(j);
    }
    if (!pre && !post) throw new DurationError("time: invalid duration " + timeQuote(orig));
    let u = 0;
    while (u < s.length && s[u] !== "." && !(s[u]! >= "0" && s[u]! <= "9")) u++;
    if (u === 0) throw new DurationError("time: missing unit in duration " + timeQuote(orig));
    const unitName = s.slice(0, u);
    s = s.slice(u);
    const unit = UNITS[unitName];
    if (unit === undefined) throw new DurationError("time: unknown unit " + timeQuote(unitName) + " in duration " + timeQuote(orig));
    if (v > MAX_INT64 / unit) throw new DurationError("time: invalid duration " + timeQuote(orig));
    v *= unit;
    if (frac > 0n) {
      // float64(frac) * (float64(unit) / scale) in Go; integer math is exact enough here
      v += (frac * unit) / scale;
      if (v > MAX_INT64) throw new DurationError("time: invalid duration " + timeQuote(orig));
    }
    d += v;
    if (d > MAX_INT64) throw new DurationError("time: invalid duration " + timeQuote(orig));
  }
  if (neg) return -d;
  if (d > MAX_INT64) throw new DurationError("time: invalid duration " + timeQuote(orig));
  return d;
}

function fmtFrac(v: bigint, prec: number): [string, bigint] {
  // Formats the fraction of v / 10**prec, omitting trailing zeros (Go's fmtFrac).
  let s = "";
  let print = false;
  for (let i = 0; i < prec; i++) {
    const digit = v % 10n;
    print = print || digit !== 0n;
    if (print) s = digit.toString() + s;
    v /= 10n;
  }
  if (print) s = "." + s;
  return [s, v];
}

/** Go's Duration.String: "1h30m0s", "5m0s", "1.5s", "500ms", "0s". */
export function formatGoDuration(d: bigint): string {
  if (d === 0n) return "0s";
  const neg = d < 0n;
  let u = neg ? -d : d;
  let out: string;
  if (u < SEC) {
    let prec: number;
    let unit: string;
    if (u < US) return (neg ? "-" : "") + u.toString() + "ns";
    if (u < MS) {
      prec = 3;
      unit = "µs";
    } else {
      prec = 6;
      unit = "ms";
    }
    const [frac, rest] = fmtFrac(u, prec);
    out = rest.toString() + frac + unit;
  } else {
    const [frac, rest] = fmtFrac(u, 9);
    u = rest;
    out = (u % 60n).toString() + frac + "s";
    u /= 60n;
    if (u > 0n) {
      out = (u % 60n).toString() + "m" + out;
      u /= 60n;
      if (u > 0n) out = u.toString() + "h" + out;
    }
  }
  return (neg ? "-" : "") + out;
}

/**
 * passh's short duration <D> (agent-session.md §A2.3): rounded to the nearest second (a half
 * second rounds up), negative as 0; ≥ 1 h: hours and minutes if not 0 (seconds dropped);
 * ≥ 1 min: minutes and seconds if not 0; else seconds.
 */
export function formatShortDuration(ms: number): string {
  let secs = Math.floor(ms / 1000 + 0.5);
  if (!(secs > 0)) secs = 0;
  if (secs >= 3600) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return m ? `${h}h${m}m` : `${h}h`;
  }
  if (secs >= 60) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s ? `${m}m${s}s` : `${m}m`;
  }
  return `${secs}s`;
}

/** Nanoseconds to milliseconds (number). */
export function nsToMs(d: bigint): number {
  return Number(d / MS);
}
