// Languages (spec §3.3, i18n.md). The English text is the catalogue key; ru and sr
// catalogues translate it. Messages are formatted like Go's fmt.Sprintf (i18n.md §4).
//
// Usage:
//   T("Saved %s.", line(path))                     a message for people
//   TN(n, "%d entry", "%d entries", n)             a plural message (key: the `other` text)
//   TC("tui", "Edit")                              a message with a context (key: ctx U+0004 text)
//   throw errorf("%s: not found", path)            an error, rendered in the language at exit
//   renderError(e)                                 the text of any error in the language (§6)

import { sprintf } from "./sprintf.ts";

export type Language = "en" | "ru" | "sr";

/** Plural forms of one message: en uses one/other, ru and sr one/few/many (i18n.md §4). */
export interface PluralForms {
  one: string;
  few?: string;
  many?: string;
  other?: string;
}

export type Catalog = Record<string, string | PluralForms>;

let language: Language = "en";
const catalogs: Partial<Record<Language, Catalog>> = {};
const loaders: Partial<Record<Language, () => Catalog>> = {};

/** Registers a lazily loaded catalogue for a language (called by the catalogue modules). */
export function registerCatalog(lang: Language, load: () => Catalog): void {
  loaders[lang] = load;
  delete catalogs[lang];
}

function catalog(): Catalog | undefined {
  if (language === "en") return undefined;
  let c = catalogs[language];
  if (!c) {
    const load = loaders[language];
    if (!load) return undefined;
    c = load();
    catalogs[language] = c;
  }
  return c;
}

export function setLanguage(lang: Language): void {
  language = lang;
}

export function getLanguage(): Language {
  return language;
}

/** The value of `<html lang>` for the print page (i18n.md §7). */
export function htmlLang(): string {
  return language === "sr" ? "sr-Latn" : language;
}

function lookup(key: string): string | undefined {
  const c = catalog();
  if (!c) return undefined;
  const v = c[key];
  return typeof v === "string" ? v : undefined;
}

/** A value that renders itself in the current language when used as a message argument. */
export interface Localizable {
  localize(): string;
}

function isLocalizable(v: unknown): v is Localizable {
  return typeof v === "object" && v !== null && typeof (v as Localizable).localize === "function";
}

/** Renders a message argument in the current language (errors by §6, self-describing values). */
export function renderArg(a: unknown): string {
  if (a instanceof Error) return renderError(a);
  if (isLocalizable(a)) return a.localize();
  if (a instanceof Uint8Array) return new TextDecoder().decode(a);
  if (a === null || a === undefined) return "<nil>";
  return String(a);
}

/** Renders a message argument in English (for the English text of errors). */
export function englishArg(a: unknown): string {
  if (a instanceof Error) return a.message;
  if (a instanceof Uint8Array) return new TextDecoder().decode(a);
  if (a === null || a === undefined) return "<nil>";
  return String(a);
}

/** Translates and formats a message. Without arguments the text is literal (no % processing). */
export function T(format: string, ...args: unknown[]): string {
  const f = lookup(format) ?? format;
  if (args.length === 0) return f;
  return sprintf(f, args, renderArg);
}

/** English formatting with the same rules as T (no lookup). */
export function E(format: string, ...args: unknown[]): string {
  if (args.length === 0) return format;
  return sprintf(format, args, englishArg);
}

/** The CLDR plural category of n for the current language (i18n.md §4). */
export function pluralCategory(n: number | bigint, lang: Language = language): "one" | "few" | "many" | "other" {
  let v = typeof n === "bigint" ? n : BigInt(Math.trunc(n));
  if (v < 0n) v = -v;
  if (lang === "en") return v === 1n ? "one" : "other";
  const m10 = v % 10n;
  const m100 = v % 100n;
  if (m10 === 1n && m100 !== 11n) return "one";
  if (m10 >= 2n && m10 <= 4n && !(m100 >= 12n && m100 <= 14n)) return "few";
  return "many";
}

/** A plural message: `one` and `other` are the English forms; the key is `other`. */
export function TN(n: number | bigint, one: string, other: string, ...args: unknown[]): string {
  const c = catalog();
  const v = c?.[other];
  let f: string;
  if (v && typeof v === "object") {
    const cat = pluralCategory(n);
    f = (cat === "one" ? v.one : cat === "few" ? v.few : cat === "many" ? v.many : v.other) ?? v.many ?? v.other ?? other;
  } else {
    const abs = typeof n === "bigint" ? (n < 0n ? -n : n) : Math.abs(n);
    f = abs == 1 ? one : other;
  }
  if (args.length === 0) return f;
  return sprintf(f, args, renderArg);
}

/** English plural (for the English text of errors). */
export function EN(n: number | bigint, one: string, other: string, ...args: unknown[]): string {
  const abs = typeof n === "bigint" ? (n < 0n ? -n : n) : Math.abs(n);
  const f = abs == 1 ? one : other;
  return args.length === 0 ? f : sprintf(f, args, englishArg);
}

/** A message with a context: the key is ctx U+0004 text; without that key, English. */
export function TC(ctx: string, text: string, ...args: unknown[]): string {
  const f = lookup(ctx + "\u0004" + text) ?? text;
  if (args.length === 0) return f;
  return sprintf(f, args, renderArg);
}

// ---------------------------------------------------------------------------
// Errors (i18n.md §6). Lower layers make errors in English; they are rendered in the
// language only when shown.

export interface PasshErrorOptions {
  /** A stable identifier for matching (like a Go sentinel), e.g. "changed", "locked". */
  code?: string;
  /** The wrapped error (Go's %w). errorf sets it from the first Error argument of a %w verb. */
  cause?: unknown;
  /** Exit status when this error ends the command (default 1; usage errors 2). */
  exitCode?: number;
}

/** passh's own error: an English format string with arguments, rendered in the language when shown. */
export class PasshError extends Error {
  readonly format: string;
  readonly args: readonly unknown[];
  readonly code: string | undefined;
  exitCode: number;

  constructor(format: string, args: readonly unknown[] = [], opts: PasshErrorOptions = {}) {
    super(args.length === 0 ? format : sprintf(format, args, englishArg), opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "PasshError";
    this.format = format;
    this.args = args;
    this.code = opts.code;
    this.exitCode = opts.exitCode ?? 1;
  }

  /** The text in the current language. */
  localize(): string {
    const f = lookup(this.format) ?? this.format;
    if (this.args.length === 0) return f;
    return sprintf(f, this.args, renderArg);
  }
}

/** Like Go's fmt.Errorf: the first Error argument consumed by %w becomes the cause. */
export function errorf(format: string, ...args: unknown[]): PasshError {
  let cause: unknown;
  if (format.includes("%w")) cause = args.find((a) => a instanceof Error);
  return new PasshError(format, args, cause !== undefined ? { cause } : {});
}

/** An error with a matching code: codedError("changed", "vault changed on disk …"). */
export function codedError(code: string, format: string, ...args: unknown[]): PasshError {
  let cause: unknown;
  if (format.includes("%w")) cause = args.find((a) => a instanceof Error);
  return new PasshError(format, args, { code, cause });
}

/** Reports whether e, or an error it wraps, has the code. */
export function hasCode(e: unknown, code: string): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 50; depth++) {
    if (cur instanceof PasshError && cur.code === code) return true;
    if (cur instanceof AggregateError && cur.errors.some((x) => hasCode(x, code))) return true;
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return false;
}

/** Finds the first error in the chain that satisfies pred (like errors.As). */
export function findError<T>(e: unknown, pred: (x: unknown) => x is T): T | undefined {
  for (let cur: unknown = e, depth = 0; cur && depth < 50; depth++) {
    if (pred(cur)) return cur;
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return undefined;
}

/** The English text of any error. */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Renders an error in the current language (i18n.md §6). */
export function renderError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  if (language === "en") return e.message;
  if (e instanceof PasshError || isLocalizable(e)) return (e as unknown as Localizable).localize();
  const whole = lookup(e.message);
  if (whole !== undefined) return whole;
  const cause = e.cause;
  if (cause instanceof Error && e.message.endsWith(cause.message)) {
    return e.message.slice(0, e.message.length - cause.message.length) + renderError(cause);
  }
  if (e instanceof AggregateError && e.errors.map(errorText).join("\n") === e.message) {
    return e.errors.map(renderError).join("\n");
  }
  return e.message;
}

/** An error that joins several (Go's errors.Join): its text is theirs joined by line breaks. */
export function joinErrors(errs: unknown[]): AggregateError {
  return new AggregateError(errs, errs.map(errorText).join("\n"));
}

// ---------------------------------------------------------------------------
// Yes/no answers (i18n.md §5).

/** The hint after a yes/no question, with its leading and trailing space: " [y/N] ". */
export function yesNoHint(defaultYes: boolean): string {
  switch (language) {
    case "ru":
      return defaultYes ? " [Д/н] " : " [д/Н] ";
    case "sr":
      return defaultYes ? " [D/n] " : " [d/N] ";
    default:
      return defaultYes ? " [Y/n] " : " [y/N] ";
  }
}

/** Parses an answer: true yes, false no, undefined not understood. Empty is not handled here. */
export function parseYesNo(answer: string): boolean | undefined {
  const a = answer.trim().toLowerCase();
  if (a === "y" || a === "yes") return true;
  if (a === "n" || a === "no") return false;
  if (language === "ru") {
    if (a === "д" || a === "да") return true;
    if (a === "н" || a === "нет") return false;
  }
  if (language === "sr") {
    if (a === "d" || a === "da") return true;
    if (a === "ne") return false;
  }
  return undefined;
}
