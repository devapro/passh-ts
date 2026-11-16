#!/usr/bin/env bun
// Extracts the English catalogue keys (i18n.md §4: the English text is the key) from
// src/**/*.ts and compares them with the ru and sr catalogues.
//
//   bun run scripts/i18n-keys.ts                  every key, one JSON string per line
//   bun run scripts/i18n-keys.ts --missing ru     keys missing from ru (with a call site)
//   bun run scripts/i18n-keys.ts --stale sr       catalogue entries no call site uses
//   bun run scripts/i18n-keys.ts --check ru       format verbs, white space, plural forms, script
//   bun run scripts/i18n-keys.ts --dynamic        call sites whose message isn't a literal
//   bun run scripts/i18n-keys.ts --suspects       prose literals in the UI layers that are no key
//   bun run scripts/i18n-keys.ts --sites          every key with its call sites
//   bun run scripts/i18n-keys.ts --json           everything as one JSON document
//
// What counts as a key:
//   - the message argument of T, TC (ctx U+0004 text), tr (a translator parameter), TN (the `other` text is the key; the
//     `one` text is recorded with it), errorf, codedError, new PasshError, and of every
//     wrapper that passes one of its parameters on as such a message (found automatically,
//     to a fixpoint: UsageError, SignalError, ContainerError, agentError, wrapPromptError, …;
//     a wrapper may add a literal prefix or suffix, e.g. agentError's "agent: " + format);
//   - a string default of such a wrapper parameter (SignalError's "interrupted (%s)");
//   - the help texts of the command tree (src/cli: `short`, `long`, `usage`, `noSubcommand`);
//   - the string literals of the tables listed in TABLES below (messages kept in data and
//     translated where they are shown: T(table[x]));
//   - a comment `// i18n-key: "text"` (a JSON string) anywhere in src.
// A message argument is a literal when it is a string (or a template without
// substitutions), a `+` concatenation of those, or a `const` bound to one. Anything else is
// reported as a dynamic call site (--dynamic) so a person can check where its keys come from.

import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Tokens

type Tok =
  | { t: "str"; v: string; line: number }
  | { t: "tpl"; line: number }
  | { t: "id"; v: string; line: number }
  | { t: "num"; line: number }
  | { t: "re"; line: number }
  | { t: "p"; v: string; line: number };

interface Lexed {
  /** The main token stream, then one stream per template substitution. */
  streams: Tok[][];
  comments: { line: number; text: string }[];
}

const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);

function isIdStart(c: string): boolean {
  return /[A-Za-z_$\u0080-\uffff]/.test(c);
}
function isIdPart(c: string): boolean {
  return /[A-Za-z0-9_$\u0080-\uffff]/.test(c);
}

/** Decodes one escape sequence at src[i] (just after the backslash); returns [text, next index]. */
function escape(src: string, i: number): [string, number] {
  const c = src[i]!;
  switch (c) {
    case "n":
      return ["\n", i + 1];
    case "r":
      return ["\r", i + 1];
    case "t":
      return ["\t", i + 1];
    case "b":
      return ["\b", i + 1];
    case "f":
      return ["\f", i + 1];
    case "v":
      return ["\v", i + 1];
    case "0":
      return ["\0", i + 1];
    case "x":
      return [String.fromCharCode(parseInt(src.slice(i + 1, i + 3), 16)), i + 3];
    case "u":
      if (src[i + 1] === "{") {
        const close = src.indexOf("}", i);
        return [String.fromCodePoint(parseInt(src.slice(i + 2, close), 16)), close + 1];
      }
      return [String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16)), i + 5];
    case "\r":
      return ["", src[i + 1] === "\n" ? i + 2 : i + 1];
    case "\n":
      return ["", i + 1];
    default:
      return [c, i + 1];
  }
}

function lex(src: string): Lexed {
  const streams: Tok[][] = [];
  const comments: { line: number; text: string }[] = [];
  let line = 1;

  // Tokenizes from i; with stopAtBrace, stops at the `}` closing a template substitution.
  function run(i: number, stopAtBrace: boolean): number {
    const toks: Tok[] = [];
    streams.push(toks);
    let depth = 0;
    const prevAllowsRegex = (): boolean => {
      const p = toks[toks.length - 1];
      if (!p) return true;
      if (p.t === "p") return !(p.v === ")" || p.v === "]" || p.v === "}");
      if (p.t === "id") return REGEX_KEYWORDS.has(p.v);
      return false;
    };
    while (i < src.length) {
      const c = src[i]!;
      if (c === "\n") {
        line++;
        i++;
        continue;
      }
      if (c === " " || c === "\t" || c === "\r") {
        i++;
        continue;
      }
      if (c === "/" && src[i + 1] === "/") {
        const end = src.indexOf("\n", i);
        const stop = end < 0 ? src.length : end;
        comments.push({ line, text: src.slice(i + 2, stop) });
        i = stop;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        const stop = end < 0 ? src.length : end + 2;
        const text = src.slice(i + 2, stop - 2);
        comments.push({ line, text });
        for (const ch of text) if (ch === "\n") line++;
        i = stop;
        continue;
      }
      if (c === "'" || c === '"') {
        const start = line;
        let v = "";
        i++;
        while (i < src.length && src[i] !== c) {
          if (src[i] === "\\") {
            if (src[i + 1] === "\n") line++;
            const [s, n] = escape(src, i + 1);
            v += s;
            i = n;
          } else {
            v += src[i];
            i++;
          }
        }
        i++;
        toks.push({ t: "str", v, line: start });
        continue;
      }
      if (c === "`") {
        const start = line;
        let v = "";
        let subst = false;
        i++;
        while (i < src.length && src[i] !== "`") {
          if (src[i] === "\\") {
            if (src[i + 1] === "\n") line++;
            const [s, n] = escape(src, i + 1);
            v += s;
            i = n;
          } else if (src[i] === "$" && src[i + 1] === "{") {
            subst = true;
            i = run(i + 2, true);
          } else {
            if (src[i] === "\n") line++;
            if (src[i] === "\r" && src[i + 1] === "\n") i++;
            v += src[i];
            i++;
          }
        }
        i++;
        toks.push(subst ? { t: "tpl", line: start } : { t: "str", v, line: start });
        continue;
      }
      if (c === "/" && prevAllowsRegex()) {
        let inClass = false;
        i++;
        while (i < src.length) {
          const d = src[i]!;
          if (d === "\\") {
            i += 2;
            continue;
          }
          if (d === "\n") break;
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) break;
          i++;
        }
        i++;
        while (i < src.length && /[a-z]/.test(src[i]!)) i++;
        toks.push({ t: "re", line });
        continue;
      }
      if (isIdStart(c) || (c === "#" && isIdStart(src[i + 1] ?? ""))) {
        let j = i + 1;
        while (j < src.length && isIdPart(src[j]!)) j++;
        toks.push({ t: "id", v: src.slice(i, j), line });
        i = j;
        continue;
      }
      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
        let j = i + 1;
        while (j < src.length && /[0-9A-Za-z_.]/.test(src[j]!)) j++;
        toks.push({ t: "num", line });
        i = j;
        continue;
      }
      if (c === "{") depth++;
      if (c === "}") {
        if (depth === 0 && stopAtBrace) return i + 1;
        depth--;
      }
      const three = src.slice(i, i + 3);
      const two = src.slice(i, i + 2);
      if (three === "...") {
        toks.push({ t: "p", v: "...", line });
        i += 3;
      } else if (two === "=>" || two === "?." || two === "??" || two === "==" || two === "!=" || two === "&&" || two === "||") {
        toks.push({ t: "p", v: two, line });
        i += 2;
      } else {
        toks.push({ t: "p", v: c, line });
        i++;
      }
    }
    return i;
  }
  run(0, false);
  return { streams, comments };
}

// ---------------------------------------------------------------------------
// Source files, constants, imports

interface SourceFile {
  path: string; // relative to the repo
  src: string;
  lexed: Lexed;
  imports: Set<string>;
}

const ROOT = join(import.meta.dir, "..");

function isSkipped(rel: string): boolean {
  return (
    rel.endsWith(".test.ts") ||
    rel.includes("/testdata/") ||
    rel.startsWith("src/i18n/") ||
    /^src\/print\/catalog_[a-z]+\.ts$/.test(rel) ||
    rel === "src/util/gen-unicode-data.ts" ||
    rel === "src/tui/fake.ts" // an in-memory backend for tests, not used by passh
  );
}

function loadSources(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  for (const rel of new Glob("src/**/*.ts").scanSync({ cwd: root })) {
    const r = rel.split("\\").join("/");
    if (isSkipped(r)) continue;
    const src = readFileSync(join(root, r), "utf8");
    const imports = new Set<string>();
    for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from/g)) {
      for (const part of m[1]!.split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim();
        if (name) imports.add(name);
      }
    }
    out.push({ path: r, src, lexed: lex(src), imports });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** Splits a call's arguments (tokens between the parentheses) at top-level commas. */
function callArgs(toks: Tok[], open: number): { args: Tok[][]; end: number } {
  const args: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  let i = open + 1;
  for (; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.t === "p") {
      if (t.v === "(" || t.v === "[" || t.v === "{") depth++;
      else if (t.v === ")" || t.v === "]" || t.v === "}") {
        if (depth === 0) break;
        depth--;
      } else if (t.v === "," && depth === 0) {
        args.push(cur);
        cur = [];
        continue;
      }
    }
    cur.push(t);
  }
  if (cur.length > 0) args.push(cur);
  return { args, end: i };
}

type Consts = Map<string, Map<string, string>>; // name → file → value

function stripParens(ts: Tok[]): Tok[] {
  while (ts.length >= 2 && ts[0]!.t === "p" && (ts[0] as { v: string }).v === "(" && ts[ts.length - 1]!.t === "p" && (ts[ts.length - 1] as { v: string }).v === ")") {
    // only when the parentheses enclose everything
    let depth = 0;
    let whole = true;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i]!;
      if (t.t === "p" && t.v === "(") depth++;
      if (t.t === "p" && t.v === ")") depth--;
      if (depth === 0 && i < ts.length - 1) {
        whole = false;
        break;
      }
    }
    if (!whole) break;
    ts = ts.slice(1, -1);
  }
  // `x as const`, `x as string`
  if (ts.length >= 3 && ts[ts.length - 2]!.t === "id" && (ts[ts.length - 2] as { v: string }).v === "as") ts = ts.slice(0, -2);
  return ts;
}

/** The value of a literal expression: strings, templates without substitutions, consts, `+`. */
function literal(ts: Tok[], file: SourceFile, consts: Consts): string | undefined {
  ts = stripParens(ts);
  if (ts.length === 0) return undefined;
  let out = "";
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i]!;
    if (i % 2 === 1) {
      if (!(t.t === "p" && t.v === "+")) return undefined;
      continue;
    }
    if (t.t === "str") out += t.v;
    else if (t.t === "id") {
      const v = constValue(t.v, file, consts);
      if (v === undefined) return undefined;
      out += v;
    } else return undefined;
  }
  return ts.length % 2 === 1 ? out : undefined;
}

function constValue(name: string, file: SourceFile, consts: Consts): string | undefined {
  const byFile = consts.get(name);
  if (!byFile) return undefined;
  const own = byFile.get(file.path);
  if (own !== undefined) return own;
  if (file.imports.has(name)) {
    const values = new Set(byFile.values());
    if (values.size === 1) return [...values][0];
  }
  return undefined;
}

/** `const NAME = <literal>;` and `const NAME: string = <literal>;` anywhere in the files. */
function collectConsts(files: SourceFile[]): Consts {
  const consts: Consts = new Map();
  for (let round = 0; round < 3; round++) {
    for (const f of files) {
      const toks = f.lexed.streams[0]!;
      for (let i = 0; i + 3 < toks.length; i++) {
        const t = toks[i]!;
        if (!(t.t === "id" && t.v === "const")) continue;
        const name = toks[i + 1]!;
        if (name.t !== "id") continue;
        let j = i + 2;
        if (toks[j]?.t === "p" && (toks[j] as { v: string }).v === ":") j += 2;
        if (!(toks[j]?.t === "p" && (toks[j] as { v: string }).v === "=")) continue;
        const expr: Tok[] = [];
        let k = j + 1;
        for (; k < toks.length; k++) {
          const u = toks[k]!;
          if (u.t === "p" && (u.v === ";" || u.v === "," || u.v === ")" || u.v === "}")) break;
          if (u.t === "id" && (u.v === "const" || u.v === "let" || u.v === "export" || u.v === "function")) break;
          expr.push(u);
        }
        const v = literal(expr, f, consts);
        if (v === undefined) continue;
        if (!consts.has(name.v)) consts.set(name.v, new Map());
        consts.get(name.v)!.set(f.path, v);
      }
    }
  }
  return consts;
}

// ---------------------------------------------------------------------------
// Callees

/** How a call carries its message. `arg` is the index of the message argument. */
interface Callee {
  kind: "msg" | "ctx" | "plural";
  arg: number; // msg: the message; ctx: the text; plural: the `other` text
  ctxArg?: number;
  oneArg?: number;
  prefix?: string;
  suffix?: string;
  isNew?: boolean;
  /** Where it is defined (undefined: the i18n primitives, visible everywhere). */
  file?: string;
  exported?: boolean;
  member?: boolean;
}

const BASE: Record<string, Callee> = {
  T: { kind: "msg", arg: 0 },
  TC: { kind: "ctx", arg: 1, ctxArg: 0 },
  TN: { kind: "plural", arg: 2, oneArg: 1 },
  errorf: { kind: "msg", arg: 0 },
  codedError: { kind: "msg", arg: 1 },
  PasshError: { kind: "msg", arg: 0, isNew: true },
  // a local translator parameter, by convention named tr: render(tr) with tr = T or E
  // (DamagedBackupList, print's Scope)
  tr: { kind: "msg", arg: 0 },
};

/** Callees that only one file knows (a local translator function). */
const FILE_CALLEES: Record<string, Record<string, Callee>> = {};

/**
 * Tables of messages kept in data and translated where shown (`T(table[x])`): every string
 * literal inside the named declaration (a const, a function, a method) of the file is a key,
 * except object keys and those that `skip` matches. With `plural`, the literals come in
 * [one, other] pairs and the `other` text is a plural key.
 */
interface Table {
  file: string;
  decl: string;
  skip?: RegExp;
  plural?: boolean;
  /** The context of TC(ctx, value). */
  ctx?: string;
}

const TABLES: Table[] = [
  // import report: T(SKIP_REASON_TEXT[reason]) (import-export.md §1.8)
  { file: "src/importpass/skips.ts", decl: "SKIP_REASON_TEXT" },
  // weak passphrase reasons: T(s.reason); the names of zxcvbn's patterns are skipped
  { file: "src/keys/strength.ts", decl: "matchReason", skip: /^\S+$/ },
  // the hint line after a damaged key block: HintText → T(this.text)
  { file: "src/vault/errors.ts", decl: "openHint" },
  // ContainerWarning: TN(lines, one, other)
  { file: "src/vaultfile/errors.ts", decl: "#forms", plural: true, skip: /^(before|after)$/ },
  // the agent's refusals, sent as English text and translated by the client (i18n.md §6 rule 2)
  { file: "src/agent/protocol.ts", decl: "WIRE" },
  // why a key text was refused: errorf(r)
  { file: "src/agent/protocol.ts", decl: "parseKeyText" },
  // doctor's level names: TC("doctor", level) (cli.md §2.25)
  { file: "src/cli/cmd_doctor.ts", decl: "DOCTOR_LEVELS", ctx: "doctor" },
];

/**
 * Object properties whose literal values are messages (`when` must match the file's source).
 */
const PROPS: { file: RegExp; when?: RegExp; props: string[]; ctx?: string }[] = [
  // doctor's check names: TC("doctor", finding.check) (cli.md §2.25)
  { file: /^src\/cli\/cmd_doctor\.ts$/, props: ["check"], ctx: "doctor" },
  // the command tree's help texts (cli.md §2.26): T(spec.short), T(f.usage), …
  { file: /^src\/cli\//, props: ["short", "long", "usage", "noSubcommand"] },
  // PairTexts of readSecretPair: T(t.first), T(t.second), T(t.empty), T(t.mismatch), codedError(…, t.failure)
  { file: /^src\//, when: /\bPairTexts\b|\breadSecretPair\(/, props: ["first", "second", "empty", "mismatch", "failure"] },
  // passphraseKeySource(tty, { prompt }): T(opts.prompt)
  { file: /^src\//, props: ["prompt"] },
  // strength reasons: T(s.reason)
  { file: /^src\/keys\/strength\.ts$/, props: ["reason"] },
];

/**
 * Dynamic call sites explained by the tables and properties above, or English-only.
 */
const COVERED: RegExp[] = [
  /^src\/cli\/command\.ts:\d+: (T|UsageError)\((f \. usage|c \. spec \. short|head|cmd \. spec \. noSubcommand)\)$/,
  /^src\/importpass\/report\.ts:\d+: T\(SKIP_REASON_TEXT/,
  /^src\/keys\/strength\.ts:\d+: T\(s \. reason\)$/,
  /^src\/tty\/prompts\.ts:\d+: (T|codedError)\(t \. (first|second|empty|mismatch|failure)\)$/,
  /^src\/vault\/backups\.ts:\d+: T\(s\)$/,
  /^src\/vault\/errors\.ts:\d+: T\(this \. text\)$/,
  /^src\/vault\/keysources\.ts:\d+: T\(opts \. prompt \?\? "Passphrase: "\)$/,
  /^src\/vaultfile\/errors\.ts:\d+: TN\(other\)$/,
  /^src\/agent\/protocol\.ts:\d+: errorf\(r\)$/,
  /^src\/cli\/cmd_doctor\.ts:\d+: TC\((l|c)\)$/,
  // config problems are shown in English (i18n.md §2, §6)
  /^src\/config\/config\.ts:\d+: errorf\(rangeMsg !\)$/,
];

/**
 * Files whose messages stay English (i18n.md §2, §3, §6): config problems that prevent
 * loading (the language is English then), the age library's own texts. A key is English-only
 * when all its call sites are in these files.
 */
const ENGLISH_ONLY: RegExp[] = [/^src\/config\/config\.ts$/, /^src\/age\/(bech32|x25519|hybrid)\.ts$/];

/**
 * Single keys that stay English wherever they are made (i18n.md §3, OS and library texts):
 * Go's io.EOF text, the OS error of a failed write to stdout (cli.md §1.3), the net
 * package's dial errors of the agent socket.
 */
const ENGLISH_KEYS = new Set(["EOF", "write /dev/stdout: %s", "dial unix %s: i/o timeout", "dial unix %s: connect: %w"]);

interface Site {
  file: string;
  line: number;
  callee: string;
  text: string;
}

export interface KeyInfo {
  key: string;
  kind: "msg" | "ctx" | "plural";
  /** The English `one` form of a plural (the key is the `other` form). */
  one?: string;
  sites: string[];
  /** Every call site is in an ENGLISH_ONLY file: the message is never shown translated. */
  english: boolean;
}

export interface Extraction {
  keys: Map<string, KeyInfo>;
  dynamic: Site[];
  /** String literals of the UI layers that read like prose for people but are no key. */
  suspects: Site[];
}

/**
 * Literals of the UI layers checked by hand and found not to be messages: data on stdout
 * (`ls`), the doctor's test string, Go's csv and OS error texts, an editor command line.
 */
const NOT_MESSAGES = new Set([
  "passh clipboard test",
  "bun:ffi",
  "(no entries)",
  "help requested",
  'bare " in non-quoted-field',
  'extraneous or missing " in quoted-field',
  "no space left on device",
  "input/output error",
  "bad file descriptor",
  "set nobackup nowritebackup noundofile noswapfile",
]);

/** Layers that talk to people: their prose literals should be keys (--suspects). */
const UI_FILES = /^src\/(cli|tui|editor|tty|clipboard)\//;

interface FnDef {
  name: string;
  params: string[];
  defaults: Map<string, Tok[]>;
  bodyStart: number; // token index range in stream 0
  bodyEnd: number;
  isClass?: string; // constructor of this class
  superClass?: string;
  exported: boolean;
  member: boolean;
}

/** Parameter names (and defaults) of a parameter list starting after `(` at `open`. */
function params(toks: Tok[], open: number): { names: string[]; defaults: Map<string, Tok[]>; close: number } {
  const { args, end } = callArgs(toks, open);
  const names: string[] = [];
  const defaults = new Map<string, Tok[]>();
  for (const a of args) {
    let k = 0;
    while (a[k] && a[k]!.t === "id" && ["readonly", "private", "public", "protected"].includes((a[k] as { v: string }).v)) k++;
    if (a[k]?.t === "p" && (a[k] as { v: string }).v === "...") k++;
    const n = a[k];
    if (n?.t !== "id") {
      names.push("");
      continue;
    }
    names.push(n.v);
    // default value: after a top-level `=`
    let depth = 0;
    for (let i = k + 1; i < a.length; i++) {
      const t = a[i]!;
      if (t.t === "p" && (t.v === "(" || t.v === "[" || t.v === "{" || t.v === "<")) depth++;
      if (t.t === "p" && (t.v === ")" || t.v === "]" || t.v === "}" || t.v === ">")) depth--;
      if (depth === 0 && t.t === "p" && t.v === "=") {
        defaults.set(n.v, a.slice(i + 1));
        break;
      }
    }
  }
  return { names, defaults, close: end };
}

/** The end of a body starting at `{` (index of the matching `}`), or of an expression body. */
function bodyEnd(toks: Tok[], start: number): number {
  let depth = 0;
  const brace = toks[start]?.t === "p" && (toks[start] as { v: string }).v === "{";
  for (let i = start; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.t !== "p") continue;
    if (t.v === "(" || t.v === "[" || t.v === "{") depth++;
    else if (t.v === ")" || t.v === "]" || t.v === "}") {
      depth--;
      if (depth === 0 && brace) return i;
      if (depth < 0) return i;
    } else if (!brace && depth === 0 && (t.v === ";" || t.v === ",")) return i;
  }
  return toks.length;
}

function findFunctions(f: SourceFile): FnDef[] {
  const toks = f.lexed.streams[0]!;
  const defs: FnDef[] = [];
  const classes: { name: string; superClass?: string; start: number; end: number; exported: boolean }[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.t === "id" && t.v === "class" && toks[i + 1]?.t === "id") {
      const name = (toks[i + 1] as { v: string }).v;
      let superClass: string | undefined;
      let j = i + 2;
      if (toks[j]?.t === "id" && (toks[j] as { v: string }).v === "extends" && toks[j + 1]?.t === "id") superClass = (toks[j + 1] as { v: string }).v;
      while (j < toks.length && !(toks[j]!.t === "p" && (toks[j] as { v: string }).v === "{")) j++;
      classes.push({ name, superClass, start: j, end: bodyEnd(toks, j), exported: toks[i - 1]?.t === "id" && (toks[i - 1] as { v: string }).v === "export" });
    }
  }
  const exportedAt = (i: number) => {
    for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
      const u = toks[k]!;
      if (u.t === "id" && u.v === "export") return true;
      if (u.t === "p") return false;
    }
    return false;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    // function NAME(…) {
    if (t.t === "id" && t.v === "function" && toks[i + 1]?.t === "id" && toks[i + 2]?.t === "p" && (toks[i + 2] as { v: string }).v === "(") {
      const p = params(toks, i + 2);
      let b = p.close + 1;
      while (b < toks.length && !(toks[b]!.t === "p" && (toks[b] as { v: string }).v === "{")) b++;
      defs.push({ name: (toks[i + 1] as { v: string }).v, params: p.names, defaults: p.defaults, bodyStart: b, bodyEnd: bodyEnd(toks, b), exported: exportedAt(i), member: false });
      continue;
    }
    // const NAME = (…) => …   /  const NAME = function (…) {
    if (t.t === "id" && (t.v === "const" || t.v === "let") && toks[i + 1]?.t === "id" && toks[i + 2]?.t === "p" && (toks[i + 2] as { v: string }).v === "=") {
      let j = i + 3;
      if (toks[j]?.t === "id" && ((toks[j] as { v: string }).v === "function" || (toks[j] as { v: string }).v === "async")) j++;
      if (!(toks[j]?.t === "p" && (toks[j] as { v: string }).v === "(")) continue;
      const p = params(toks, j);
      let b = p.close + 1;
      // skip a return type up to => or {
      while (b < toks.length && !(toks[b]!.t === "p" && ((toks[b] as { v: string }).v === "=>" || (toks[b] as { v: string }).v === "{"))) b++;
      if (toks[b]?.t === "p" && (toks[b] as { v: string }).v === "=>") b++;
      defs.push({ name: (toks[i + 1] as { v: string }).v, params: p.names, defaults: p.defaults, bodyStart: b, bodyEnd: bodyEnd(toks, b), exported: exportedAt(i), member: false });
      continue;
    }
    // methods and constructors inside a class body
    const cls = classes.find((c) => i > c.start && i < c.end);
    if (cls && t.t === "id" && toks[i + 1]?.t === "p" && (toks[i + 1] as { v: string }).v === "(") {
      const prev = toks[i - 1];
      const atMemberStart = !prev || (prev.t === "p" && (prev.v === "{" || prev.v === "}" || prev.v === ";")) || (prev.t === "id" && ["static", "async", "private", "public", "protected", "override", "get", "set"].includes(prev.v));
      if (!atMemberStart) continue;
      const p = params(toks, i + 1);
      let b = p.close + 1;
      while (b < toks.length && !(toks[b]!.t === "p" && ((toks[b] as { v: string }).v === "{" || (toks[b] as { v: string }).v === ";"))) b++;
      if (!(toks[b]?.t === "p" && (toks[b] as { v: string }).v === "{")) continue;
      const isCtor = t.v === "constructor";
      defs.push({
        name: isCtor ? cls.name : t.v,
        params: p.names,
        defaults: p.defaults,
        bodyStart: b,
        bodyEnd: bodyEnd(toks, b),
        isClass: isCtor ? cls.name : undefined,
        superClass: isCtor ? cls.superClass : undefined,
        exported: isCtor ? cls.exported : true,
        member: !isCtor,
      });
    }
  }
  return defs;
}

interface Call {
  stream: number;
  index: number; // token index of the callee name
  name: string;
  args: Tok[][];
  line: number;
  isNew: boolean;
  member: boolean;
  isSuper: boolean;
}

function findCalls(f: SourceFile): Call[] {
  const calls: Call[] = [];
  f.lexed.streams.forEach((toks, s) => {
    for (let i = 0; i + 1 < toks.length; i++) {
      const t = toks[i]!;
      if (t.t !== "id") continue;
      const next = toks[i + 1]!;
      if (!(next.t === "p" && next.v === "(")) continue;
      const prev = toks[i - 1];
      if (prev?.t === "id" && prev.v === "function") continue;
      const { args } = callArgs(toks, i + 1);
      // a definition's parameter list (`name: Type`) is not a call
      const a0 = args[0] ?? [];
      let k = 0;
      while (a0[k]?.t === "id" && ["readonly", "private", "public", "protected"].includes((a0[k] as { v: string }).v)) k++;
      if (a0[k]?.t === "p" && (a0[k] as { v: string }).v === "...") k++;
      if (a0[k]?.t === "id" && a0[k + 1]?.t === "p" && ((a0[k + 1] as { v: string }).v === ":" || ((a0[k + 1] as { v: string }).v === "?" && a0[k + 2]?.t === "p" && (a0[k + 2] as { v: string }).v === ":"))) continue;
      calls.push({
        stream: s,
        index: i,
        name: t.v,
        args,
        line: t.line,
        isNew: prev?.t === "id" && prev.v === "new",
        member: prev?.t === "p" && (prev.v === "." || prev.v === "?."),
        isSuper: t.v === "super",
      });
    }
  });
  return calls;
}

function resolve(call: Call, f: SourceFile, callees: Map<string, Callee[]>): Callee | undefined {
  const local = FILE_CALLEES[f.path]?.[call.name];
  if (local) return local;
  const list = callees.get(call.name);
  if (!list) return undefined;
  for (const c of list) {
    if (c.file === undefined) {
      if (call.member) continue;
      return c;
    }
    if (c.member !== call.member) continue;
    if (c.file === f.path) return c;
    if (c.member) return c; // methods: matched by name
    if (c.exported && f.imports.has(call.name)) return c;
  }
  return undefined;
}

/** The text of an argument for reports. */
function argText(ts: Tok[]): string {
  return ts
    .map((t) => (t.t === "str" ? JSON.stringify(t.v) : t.t === "id" || t.t === "p" ? t.v : t.t === "tpl" ? "`…`" : t.t === "re" ? "/…/" : "0"))
    .join(" ")
    .slice(0, 120);
}

/** Finds the wrappers: functions that pass a parameter on as a message, to a fixpoint. */
function findWrappers(files: SourceFile[], consts: Consts): Map<string, Callee[]> {
  const callees = new Map<string, Callee[]>();
  for (const [k, v] of Object.entries(BASE)) callees.set(k, [v]);
  const defsByFile = new Map(files.map((f) => [f.path, functionsOf(f)]));
  const callsByFile = new Map(files.map((f) => [f.path, findCalls(f)]));
  let changed = true;
  const seen = new Set<string>();
  while (changed) {
    changed = false;
    for (const f of files) {
      for (const d of defsByFile.get(f.path)!) {
        const id = `${f.path}:${d.name}:${d.bodyStart}`;
        if (seen.has(id)) continue;
        for (const call of callsByFile.get(f.path)!) {
          if (call.stream !== 0 || call.index <= d.bodyStart || call.index >= d.bodyEnd) continue;
          let target: Callee | undefined;
          if (call.isSuper && d.superClass) {
            const base = callees.get(d.superClass)?.find((c) => c.isNew);
            target = base;
          } else target = resolve(call, f, callees);
          if (!target || target.kind !== "msg") continue;
          const a = stripParens(call.args[target.arg] ?? []);
          // param, or "prefix" + param + "suffix"
          let pi = -1;
          let prefix = target.prefix ?? "";
          let suffix = target.suffix ?? "";
          const idx = a.findIndex((t) => t.t === "id" && d.params.includes(t.v));
          if (idx < 0) continue;
          const before = a.slice(0, idx);
          const after = a.slice(idx + 1);
          const pre = before.length === 0 ? "" : before[before.length - 1]!.t === "p" && (before[before.length - 1] as { v: string }).v === "+" ? literal(before.slice(0, -1), f, consts) : undefined;
          const post = after.length === 0 ? "" : after[0]!.t === "p" && (after[0] as { v: string }).v === "+" ? literal(after.slice(1), f, consts) : undefined;
          if (pre === undefined || post === undefined) continue;
          pi = d.params.indexOf((a[idx] as { v: string }).v);
          prefix += pre;
          suffix = post + suffix;
          const w: Callee = { kind: "msg", arg: pi, prefix, suffix, isNew: !!d.isClass, file: f.path, exported: d.exported, member: d.member };
          if (!callees.has(d.name)) callees.set(d.name, []);
          callees.get(d.name)!.push(w);
          // a string default of the parameter is a key too
          const def = d.defaults.get(d.params[pi]!);
          if (def) {
            const v = literal(def, f, consts);
            if (v !== undefined) defaultKeys.push({ key: prefix + v + suffix, site: `${f.path}:${def[0]?.line ?? 0}` });
          }
          seen.add(id);
          changed = true;
          break;
        }
      }
    }
  }
  return callees;
}

const defaultKeys: { key: string; site: string }[] = [];

/** Format verbs (Go fmt): `%s`, `%-6d`, `%[2]q`, `%%`. */
export const VERB_RE = /%(?:\[\d+\])?[-+# 0]*(?:\[\d+\])?(?:\d+|\*)?(?:\.(?:\d+|\*)?)?(?:\[\d+\])?[a-zA-Z%]/g;

/** Does the text have a letter outside its format verbs? Without one it is not a key. */
export function hasLetters(text: string): boolean {
  return /\p{L}/u.test(text.replace(VERB_RE, ""));
}

/**
 * The format verbs of a text, as the argument each one reads (Go's numbering: an explicit
 * `[n]` sets the position, `*` reads one) and its spec without the index: `0:s`, `1:-6d`.
 * Sorted, so a translation that reorders with `%[n]` compares equal (i18n.md §4).
 */
export function verbSignature(text: string): string[] {
  const out: string[] = [];
  let arg = 0;
  const re = /%(?:\[(\d+)\])?([-+# 0]*)(?:\[(\d+)\])?(\d+|\*)?(?:\.(\d+|\*)?)?(?:\[(\d+)\])?([a-zA-Z%])/g;
  for (const m of text.matchAll(re)) {
    const verb = m[7]!;
    if (verb === "%") continue;
    const idx = m[1] ?? m[3];
    if (idx !== undefined) arg = Number(idx) - 1;
    if (m[4] === "*") arg++;
    if (m[6] !== undefined) arg = Number(m[6]) - 1;
    const prec = m[5] !== undefined ? "." + m[5] : m[0].includes(".") ? "." : "";
    out.push(`${arg}:${m[2] ?? ""}${m[4] ?? ""}${prec}${verb}`);
    arg++;
  }
  return out.sort();
}

/** Problems of one catalogue entry: verbs, white space at the ends, plural forms, script. */
export function entryProblems(lang: "ru" | "sr", key: string, value: unknown): string[] {
  const problems: string[] = [];
  const english = key.includes("\u0004") ? key.slice(key.indexOf("\u0004") + 1) : key;
  const want = verbSignature(english).join(" ");
  const lead = (t: string) => /^\s*/.exec(t)![0];
  const trail = (t: string) => /\s*$/.exec(t)![0];
  const check = (t: unknown, form: string) => {
    if (typeof t !== "string" || t === "") {
      problems.push(`${form}: empty or not a string`);
      return;
    }
    const got = verbSignature(t).join(" ");
    if (got !== want) problems.push(`${form}: verbs [${got}] differ from the key's [${want}]`);
    if (lead(t) !== lead(english) || trail(t) !== trail(english)) problems.push(`${form}: leading or trailing white space differs from the key's`);
    if (lang === "sr" && /\p{Script=Cyrillic}/u.test(t)) problems.push(`${form}: Cyrillic in Serbian (Latin only)`);
  };
  if (typeof value === "object" && value !== null) {
    const v = value as Record<string, unknown>;
    for (const f of ["one", "few", "many"]) check(v[f], f);
    for (const f of Object.keys(v)) if (!["one", "few", "many", "other"].includes(f)) problems.push(`unknown plural form ${f}`);
  } else check(value, "text");
  return problems;
}

/** The tokens of a property's value: from after the `:` to the next top-level `,` or close. */
function valueTokens(toks: Tok[], from: number): Tok[] {
  const expr: Tok[] = [];
  let depth = 0;
  for (let k = from; k < toks.length; k++) {
    const u = toks[k]!;
    if (u.t === "p" && (u.v === "(" || u.v === "[" || u.v === "{")) depth++;
    if (u.t === "p" && (u.v === ")" || u.v === "]" || u.v === "}")) {
      if (depth === 0) break;
      depth--;
    }
    if (depth === 0 && u.t === "p" && (u.v === "," || u.v === ";")) break;
    expr.push(u);
  }
  return expr;
}

/** The token range of a table's declaration body: [start, end). */
function tableRange(toks: Tok[], decl: string): [number, number] | undefined {
  const at = toks.findIndex((t, i) => {
    if (!(t.t === "id" && t.v === decl)) return false;
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (prev?.t === "id" && ["const", "let", "function", "var"].includes(prev.v)) return true;
    // a method definition: `name(…) … {` at the start of a class member
    return next?.t === "p" && next.v === "(" && (!prev || (prev.t === "p" && (prev.v === "{" || prev.v === "}" || prev.v === ";")) || (prev.t === "id" && ["static", "private", "public", "protected", "get"].includes(prev.v)));
  });
  if (at < 0) return undefined;
  let b = at + 1;
  if (toks[b]?.t === "p" && (toks[b] as { v: string }).v === "(") {
    // a function or method: skip the parameter list and the return type
    b = callArgs(toks, b).end + 1;
    while (b < toks.length && !(toks[b]!.t === "p" && (toks[b] as { v: string }).v === "{")) b++;
  } else {
    while (b < toks.length && !(toks[b]!.t === "p" && ["{", "[", "("].includes((toks[b] as { v: string }).v))) b++;
  }
  return [b, bodyEnd(toks, b) + 1];
}

export function extract(root = ROOT): Extraction {
  defaultKeys.length = 0;
  const files = loadSources(root);
  const consts = collectConsts(files);
  const callees = findWrappers(files, consts);
  const keys = new Map<string, KeyInfo>();
  const dynamic: Site[] = [];
  const add = (key: string, kind: KeyInfo["kind"], site: string, one?: string) => {
    if (!hasLetters(key)) return; // no letters: not a key (i18n.md §4; "%s: %v")
    let k = keys.get(key);
    if (!k) {
      k = { key, kind, sites: [], english: true };
      keys.set(key, k);
    }
    if (one !== undefined) k.one = one;
    if (kind === "plural") k.kind = "plural";
    if (!k.sites.includes(site)) k.sites.push(site);
    const file = site.slice(0, site.lastIndexOf(":"));
    if (!ENGLISH_ONLY.some((r) => r.test(file)) && !ENGLISH_KEYS.has(key)) k.english = false;
  };

  for (const f of files) {
    const toks = f.lexed.streams[0]!;
    for (const call of findCalls(f)) {
      let c: Callee | undefined;
      if (call.isSuper) {
        // super(…) in the constructor of a class that extends a message class (PasshError)
        const ctor = functionsOf(f).find((d) => d.isClass && call.stream === 0 && call.index > d.bodyStart && call.index < d.bodyEnd);
        const base = ctor?.superClass ? callees.get(ctor.superClass)?.find((x) => x.isNew) : undefined;
        if (!base) continue;
        c = { ...base, isNew: false };
      } else c = resolve(call, f, callees);
      if (!c) continue;
      if (c.isNew && !call.isNew) continue;
      const site = `${f.path}:${call.line}`;
      const arg = call.args[c.arg];
      if (arg === undefined) continue; // an optional message left out (SignalError's default)
      const v = literal(arg, f, consts);
      if (v === undefined) {
        // a wrapper's own forwarding call is not a dynamic site
        if (!isForwarding(f, call, callees)) dynamic.push({ file: f.path, line: call.line, callee: call.name, text: argText(arg) });
        continue;
      }
      const text = (c.prefix ?? "") + v + (c.suffix ?? "");
      if (c.kind === "msg") add(text, "msg", site);
      else if (c.kind === "ctx") {
        const ctx = literal(call.args[c.ctxArg!] ?? [], f, consts);
        if (ctx === undefined) dynamic.push({ file: f.path, line: call.line, callee: call.name, text: argText(call.args[c.ctxArg!] ?? []) });
        else add(ctx + "\u0004" + text, "ctx", site);
      } else {
        const one = literal(call.args[c.oneArg!] ?? [], f, consts);
        add(text, "plural", site, one);
      }
    }
    // object properties whose values are messages
    const props = new Map<string, string | undefined>();
    for (const p of PROPS) if (p.file.test(f.path) && (!p.when || p.when.test(f.src))) for (const n of p.props) props.set(n, p.ctx);
    if (props.size > 0) {
      for (let i = 0; i + 2 < toks.length; i++) {
        const t = toks[i]!;
        if (!(t.t === "id" && props.has(t.v) && toks[i + 1]!.t === "p" && (toks[i + 1] as { v: string }).v === ":")) continue;
        const ctx = props.get(t.v);
        const prev = toks[i - 1];
        if (!(prev?.t === "p" && (prev.v === "{" || prev.v === ","))) continue;
        const expr = valueTokens(toks, i + 2);
        // `a ?? "text"`, `cond ? "a" : "b"`: the literal alternatives
        const parts = expr.some((u) => u.t === "p" && (u.v === "?" || u.v === "??")) ? expr.filter((u) => u.t === "str").map((u) => [u]) : [expr];
        for (const part of parts) {
          const v = literal(part, f, consts);
          // a flag's one-letter shorthand (`short: "o"`) is a name, not a text
          if (v !== undefined && [...v].length > 1) {
            if (ctx !== undefined) add(ctx + "\u0004" + v, "ctx", `${f.path}:${t.line}`);
            else add(v, "msg", `${f.path}:${t.line}`);
          }
        }
      }
    }
    // tables
    for (const tb of TABLES.filter((x) => x.file === f.path)) {
      const range = tableRange(toks, tb.decl);
      if (!range) {
        dynamic.push({ file: f.path, line: 0, callee: "TABLES", text: `declaration ${tb.decl} not found` });
        continue;
      }
      const strs: Extract<Tok, { t: "str" }>[] = [];
      for (let k = range[0]; k < range[1]; k++) {
        const u = toks[k]!;
        if (u.t !== "str") continue;
        const next = toks[k + 1];
        if (next?.t === "p" && next.v === ":" && !(toks[k - 1]?.t === "p" && (toks[k - 1] as { v: string }).v === "?")) continue; // an object key
        if (tb.skip?.test(u.v)) continue;
        strs.push(u);
      }
      if (tb.plural) {
        for (let k = 0; k + 1 < strs.length; k += 2) add(strs[k + 1]!.v, "plural", `${f.path}:${strs[k + 1]!.line}`, strs[k]!.v);
      } else if (tb.ctx !== undefined) {
        for (const u of strs) add(tb.ctx + "\u0004" + u.v, "ctx", `${f.path}:${u.line}`);
      } else for (const u of strs) add(u.v, "msg", `${f.path}:${u.line}`);
    }
    // comments: i18n-key: "text"
    for (const c of f.lexed.comments) {
      for (const m of c.text.matchAll(/i18n-key:\s*("(?:[^"\\]|\\.)*")/g)) {
        try {
          add(JSON.parse(m[1]!), "msg", `${f.path}:${c.line}`);
        } catch {
          dynamic.push({ file: f.path, line: c.line, callee: "i18n-key", text: m[1]! });
        }
      }
    }
  }
  for (const d of defaultKeys) add(d.key, "msg", d.site);
  const unexplained = dynamic.filter((d) => !COVERED.some((r) => r.test(`${d.file}:${d.line}: ${d.callee}(${d.text})`)));
  // prose literals that are no key: possibly shown untranslated
  const suspects: Site[] = [];
  const allKeys = new Set([...keys.keys()].map((k) => (k.includes("\u0004") ? k.slice(k.indexOf("\u0004") + 1) : k)));
  for (const k of keys.values()) if (k.one !== undefined) allKeys.add(k.one);
  const allKeysText = [...allKeys].join("\u0000");
  for (const f of files.filter((x) => UI_FILES.test(x.path))) {
    for (const toks of f.lexed.streams) {
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i]!;
        if (t.t !== "str" || allKeys.has(t.v)) continue;
        if (allKeysText.includes(t.v) || NOT_MESSAGES.has(t.v)) continue; // a piece of a concatenated key
        if (!/\p{L}{2,}[ ,;:]+\p{L}{2,}/u.test(t.v.replace(VERB_RE, ""))) continue;
        const next = toks[i + 1];
        const prev = toks[i - 1];
        if (next?.t === "p" && next.v === ":" && !(prev?.t === "p" && prev.v === "?")) continue; // object key
        if (prev?.t === "id" && (prev.v === "from" || prev.v === "import")) continue;
        // `use:` lines, English-only E(…)/EN(…), comparisons and switch cases are names or data
        const before = toks[i - 2];
        if (prev?.t === "p" && prev.v === ":" && before?.t === "id" && ["use", "name", "def"].includes(before.v)) continue;
        if (prev?.t === "p" && prev.v === "(" && before?.t === "id" && ["E", "EN", "require", "Error", "describe", "test"].includes(before.v)) continue;
        if (prev?.t === "id" && prev.v === "case") continue;
        suspects.push({ file: f.path, line: t.line, callee: "", text: JSON.stringify(t.v).slice(0, 120) });
      }
    }
  }
  return { keys, dynamic: unexplained, suspects };
}

/** Is the call inside a wrapper's definition, forwarding the wrapper's own parameter? */
function isForwarding(f: SourceFile, call: Call, callees: Map<string, Callee[]>): boolean {
  if (call.stream !== 0) return false;
  for (const d of functionsOf(f)) {
    if (call.index <= d.bodyStart || call.index >= d.bodyEnd) continue;
    const isWrapper = (callees.get(d.name) ?? []).some((c) => c.file === f.path);
    if (!isWrapper) continue;
    const c = resolve(call, f, callees);
    const a = call.args[c?.arg ?? 0] ?? [];
    if (a.some((t) => t.t === "id" && d.params.includes(t.v))) return true;
  }
  return false;
}

const fnCache = new WeakMap<SourceFile, FnDef[]>();
function functionsOf(f: SourceFile): FnDef[] {
  let d = fnCache.get(f);
  if (!d) {
    d = findFunctions(f);
    fnCache.set(f, d);
  }
  return d;
}

// ---------------------------------------------------------------------------
// CLI

async function loadCatalog(lang: string): Promise<Record<string, unknown>> {
  if (lang === "ru") return (await import("../src/i18n/ru.ts")).RU;
  if (lang === "sr") return (await import("../src/i18n/sr.ts")).SR;
  throw new Error(`unknown language ${lang} (use ru or sr)`);
}

/** Keys missing from a catalogue (a plural key needs a plural entry); English-only keys aren't. */
export function missingKeys(ex: Extraction, catalog: Record<string, unknown>): KeyInfo[] {
  return [...ex.keys.values()].filter((k) => {
    if (k.english) return false;
    const v = catalog[k.key];
    if (v === undefined) return true;
    if (k.kind === "plural") return typeof v !== "object";
    return false;
  });
}

/** Catalogue entries no call site uses. */
export function staleKeys(ex: Extraction, catalog: Record<string, unknown>): string[] {
  return Object.keys(catalog).filter((k) => !ex.keys.has(k));
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? "") : undefined;
  };
  const ex = extract();
  const sorted = [...ex.keys.values()].sort((a, b) => (a.sites[0]! < b.sites[0]! ? -1 : a.sites[0]! > b.sites[0]! ? 1 : 0));
  const missing = opt("--missing");
  const stale = opt("--stale");
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ keys: sorted, dynamic: ex.dynamic }, null, 1));
  } else if (missing !== undefined) {
    const cat = await loadCatalog(missing);
    const m = missingKeys(ex, cat);
    for (const k of m) console.log(`${k.sites[0]}\t${k.kind === "plural" ? "[plural] " : ""}${JSON.stringify(k.key)}`);
    console.error(`${m.length} of ${ex.keys.size} keys missing from ${missing}`);
  } else if (stale !== undefined) {
    const cat = await loadCatalog(stale);
    const s = staleKeys(ex, cat);
    for (const k of s) console.log(JSON.stringify(k));
    console.error(`${s.length} entries of ${stale} are not used by any call site`);
  } else if (opt("--check") !== undefined) {
    const lang = opt("--check") as "ru" | "sr";
    const cat = await loadCatalog(lang);
    let n = 0;
    for (const [k, v] of Object.entries(cat)) {
      const kind = ex.keys.get(k)?.kind;
      const ps = entryProblems(lang, k, v);
      if (kind === "plural" && typeof v !== "object") ps.push("the key is a plural message: give {one, few, many}");
      if (kind !== undefined && kind !== "plural" && typeof v === "object") ps.push("the key is not a plural message: give a string");
      for (const p of ps) console.log(`${JSON.stringify(k)}: ${p}`);
      n += ps.length;
    }
    console.error(`${n} problems in ${lang}`);
  } else if (argv.includes("--suspects")) {
    for (const d of ex.suspects) console.log(`${d.file}:${d.line}\t${d.text}`);
    console.error(`${ex.suspects.length} prose literals in UI files that are no key (check they are data, names or English-only)`);
  } else if (argv.includes("--dynamic")) {
    for (const d of ex.dynamic) console.log(`${d.file}:${d.line}\t${d.callee}(${d.text})`);
    console.error(`${ex.dynamic.length} call sites whose message is not a literal`);
  } else if (argv.includes("--sites")) {
    for (const k of sorted) console.log(`${JSON.stringify(k.key)}\t${k.sites.join(" ")}`);
  } else {
    for (const k of sorted) console.log(JSON.stringify(k.key) + (k.english ? "\t(English only)" : ""));
    const english = sorted.filter((k) => k.english).length;
    console.error(`${ex.keys.size} keys (${english} English only); ${ex.dynamic.length} dynamic call sites (--dynamic)`);
  }
}
