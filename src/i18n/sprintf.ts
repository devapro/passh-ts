// A subset of Go's fmt.Sprintf, enough for passh's messages (i18n.md §4):
// verbs %s %v %d %q %x %X %c %f %t %%, flags "-+ 0#", width, precision, '*' width,
// and explicit argument indexes (%[2]s). %w is rendered as %v.
// Values: strings, numbers, bigints, booleans, Uint8Array (as bytes), Errors (their
// message, or a renderer chosen by the caller), and objects with toString().

import { goQuote } from "./quote.ts";

export type ArgRenderer = (arg: unknown) => string;

const defaultRender: ArgRenderer = (a) => {
  if (a instanceof Error) return a.message;
  if (a instanceof Uint8Array) return new TextDecoder().decode(a);
  if (a === null || a === undefined) return "<nil>";
  return String(a);
};

function pad(s: string, width: number | undefined, left: boolean, zero: boolean): string {
  if (width === undefined) return s;
  const len = [...s].length;
  if (len >= width) return s;
  const fill = (zero && !left ? "0" : " ").repeat(width - len);
  if (left) return s + " ".repeat(width - len);
  if (zero && (s.startsWith("-") || s.startsWith("+"))) return s[0] + fill + s.slice(1);
  return fill + s;
}

function formatInt(a: unknown, plus: boolean, space: boolean): string {
  let v: bigint | number;
  if (typeof a === "bigint") v = a;
  else if (typeof a === "number") v = Math.trunc(a);
  else if (typeof a === "boolean") return `%!d(bool=${a})`;
  else return `%!d(string=${String(a)})`;
  let s = v.toString();
  if (!s.startsWith("-")) {
    if (plus) s = "+" + s;
    else if (space) s = " " + s;
  }
  return s;
}

/** Go-style Sprintf. `render` turns %s/%v arguments into text (errors, self-describing values). */
export function sprintf(format: string, args: readonly unknown[], render: ArgRenderer = defaultRender): string {
  let out = "";
  let argNum = 0;
  let i = 0;
  const n = format.length;
  while (i < n) {
    const c = format[i]!;
    if (c !== "%") {
      out += c;
      i++;
      continue;
    }
    i++;
    if (i >= n) {
      out += "%!(NOVERB)";
      break;
    }
    let minus = false, plus = false, space = false, zero = false, sharp = false;
    for (; i < n; i++) {
      const f = format[i];
      if (f === "-") minus = true;
      else if (f === "+") plus = true;
      else if (f === " ") space = true;
      else if (f === "0") zero = true;
      else if (f === "#") sharp = true;
      else break;
    }
    // explicit argument index
    const readIndex = () => {
      if (format[i] === "[") {
        const close = format.indexOf("]", i);
        if (close > i) {
          const idx = parseInt(format.slice(i + 1, close), 10);
          if (!Number.isNaN(idx)) argNum = idx - 1;
          i = close + 1;
        }
      }
    };
    readIndex();
    let width: number | undefined;
    if (format[i] === "*") {
      const w = args[argNum++];
      width = typeof w === "number" ? w : Number(w);
      if (width < 0) {
        minus = true;
        width = -width;
      }
      i++;
    } else {
      let ws = "";
      while (i < n && format[i]! >= "0" && format[i]! <= "9") ws += format[i++];
      if (ws) width = parseInt(ws, 10);
    }
    let prec: number | undefined;
    if (format[i] === ".") {
      i++;
      readIndex();
      if (format[i] === "*") {
        prec = Number(args[argNum++]);
        i++;
      } else {
        let ps = "";
        while (i < n && format[i]! >= "0" && format[i]! <= "9") ps += format[i++];
        prec = ps ? parseInt(ps, 10) : 0;
      }
    }
    readIndex();
    const verb = format[i++];
    if (verb === undefined) {
      out += "%!(NOVERB)";
      break;
    }
    if (verb === "%") {
      out += "%";
      continue;
    }
    if (argNum >= args.length) {
      out += `%!${verb}(MISSING)`;
      continue;
    }
    const a = args[argNum++];
    let s: string;
    switch (verb) {
      case "s":
      case "v":
      case "w": {
        if (typeof a === "number" || typeof a === "bigint") s = String(a);
        else s = render(a);
        if (prec !== undefined) s = [...s].slice(0, prec).join("");
        break;
      }
      case "q": {
        const v = a instanceof Uint8Array ? a : typeof a === "string" ? a : render(a);
        s = goQuote(v);
        break;
      }
      case "d":
        s = formatInt(a, plus, space);
        break;
      case "x":
      case "X": {
        if (typeof a === "number" || typeof a === "bigint") {
          s = a.toString(16);
          if (s.startsWith("-")) s = "-" + (sharp ? "0x" : "") + s.slice(1);
          else s = (sharp ? "0x" : "") + s;
        } else {
          const bytes = a instanceof Uint8Array ? a : new TextEncoder().encode(render(a));
          s = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
        }
        if (verb === "X") s = s.toUpperCase();
        break;
      }
      case "o": {
        s = typeof a === "number" || typeof a === "bigint" ? a.toString(8) : String(a);
        if (sharp) s = "0" + s;
        break;
      }
      case "c":
        s = String.fromCodePoint(Number(a));
        break;
      case "t":
        s = String(Boolean(a));
        break;
      case "f":
      case "F":
        s = Number(a).toFixed(prec ?? 6);
        if (plus && !s.startsWith("-")) s = "+" + s;
        break;
      case "g":
        s = String(Number(a));
        break;
      default:
        s = `%!${verb}(${String(a)})`;
    }
    out += pad(s, width, minus, zero && verb !== "s" && verb !== "q" && verb !== "v");
  }
  return out;
}
