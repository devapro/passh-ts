// A small cobra/pflag work-alike: the parsing rules of cli.md §1.1 (flag positions,
// long/short forms, bool values, repeated and *strings* flags, help, argument counts) and
// cobra's default help layout (informative, cli.md §2.26). Texts for people go through T().

import { T, E, PasshError } from "../i18n/index.ts";
import { goQuote } from "../i18n/quote.ts";
import { UsageError } from "../errors.ts";
import { parseGoDuration } from "../util/duration.ts";
import { readCSVRecord } from "./csv.ts";

export type FlagType = "string" | "bool" | "strings" | "duration";

export interface FlagDef {
  name: string;
  short?: string;
  type: FlagType;
  /** Help text (English; translated when shown). */
  usage: string;
  /** Default as text for help and the initial value (string flags), e.g. "password". */
  def?: string;
  hidden?: boolean;
  /** Persistent: also valid on every subcommand (the global flags). */
  persistent?: boolean;
  /** An argument for `usage` as a format (e.g. "help for %s" with the command name). */
  usageArg?: string;
}

export interface ParsedFlags {
  /** Values of string, bool and duration flags (last wins), and strings flags (added up). */
  get(name: string): string | boolean | string[] | bigint | undefined;
  string(name: string): string | undefined;
  bool(name: string): boolean;
  strings(name: string): string[];
  duration(name: string): bigint | undefined;
  /** Whether the flag was given on the command line. */
  changed(name: string): boolean;
}

export interface RunContext {
  cmd: Command;
  args: string[];
  flags: ParsedFlags;
  /** The global flags (--config, --vault), from wherever they were given. */
  global: { config?: string; vault?: string };
}

export type ArgsRule = { min: number; max: number } | "none" | "any";

export interface CommandSpec {
  /** Use line, e.g. "show <path>"; the first word is the name. */
  use: string;
  short: string;
  long?: string;
  hidden?: boolean;
  args?: ArgsRule;
  flags?: FlagDef[];
  /** Called for a command with subcommands but no run when none is named (usage error text). */
  noSubcommand?: string;
  run?: (ctx: RunContext) => Promise<void> | void;
  /** Extra checks of argument counts run after help/flags (e.g. `version x`). */
}

export class Command {
  readonly spec: CommandSpec;
  readonly name: string;
  parent: Command | undefined;
  readonly children: Command[] = [];
  readonly flags: FlagDef[];

  constructor(spec: CommandSpec) {
    this.spec = spec;
    this.name = spec.use.split(" ")[0]!;
    this.flags = [...(spec.flags ?? [])];
  }

  add(...cmds: Command[]): this {
    for (const c of cmds) {
      c.parent = this;
      this.children.push(c);
    }
    return this;
  }

  get path(): string {
    return this.parent ? this.parent.path + " " + this.name : this.name;
  }

  root(): Command {
    return this.parent ? this.parent.root() : this;
  }

  /** Local flags plus help (and version on the root). */
  localFlags(): FlagDef[] {
    const fl = [...this.flags];
    fl.push({ name: "help", short: "h", type: "bool", usage: "help for %s", usageArg: this.name });
    if (!this.parent) fl.push({ name: "version", short: "v", type: "bool", usage: "version for %s", usageArg: "passh" });
    return fl;
  }

  inheritedFlags(): FlagDef[] {
    const out: FlagDef[] = [];
    for (let p = this.parent; p; p = p.parent) for (const f of p.flags) if (f.persistent) out.push(f);
    return out;
  }

  allFlags(): FlagDef[] {
    return [...this.localFlags(), ...this.inheritedFlags()];
  }

  findChild(name: string): Command | undefined {
    return this.children.find((c) => c.name === name);
  }

  runnable(): boolean {
    return this.spec.run !== undefined;
  }
}

// ---------------------------------------------------------------------------
// Finding the command (cobra's Find with stripFlags)

function flagTakesValue(token: string, flags: FlagDef[], long: boolean): boolean {
  const name = token;
  const f = long ? flags.find((x) => x.name === name) : flags.find((x) => x.short === name);
  if (!f) return true; // unknown: cobra assumes '--flag arg'
  return f.type !== "bool";
}

function stripFlags(args: string[], cmd: Command): string[] {
  const flags = cmd.allFlags();
  const commands: string[] = [];
  let a = [...args];
  while (a.length > 0) {
    const s = a.shift()!;
    if (s === "--") break;
    if (s.startsWith("--") && !s.includes("=") && flagTakesValue(s.slice(2), flags, true)) {
      if (a.length <= 1) break;
      a = a.slice(1);
      continue;
    }
    if (s.startsWith("-") && !s.startsWith("--") && !s.includes("=") && s.length === 2 && flagTakesValue(s.slice(1), flags, false)) {
      if (a.length <= 1) break;
      a = a.slice(1);
      continue;
    }
    if (s !== "" && !s.startsWith("-")) commands.push(s);
  }
  return commands;
}

function argsMinusFirst(args: string[], x: string, cmd: Command): string[] {
  // cobra's argsMinusFirstX: remove the first occurrence of x that isn't a flag value.
  const flags = cmd.allFlags();
  for (let pos = 0; pos < args.length; pos++) {
    const s = args[pos]!;
    if (s === "--") break;
    if (s.startsWith("--") && !s.includes("=") && flagTakesValue(s.slice(2), flags, true)) {
      pos++;
      continue;
    }
    if (s.startsWith("-") && !s.startsWith("--") && !s.includes("=") && s.length === 2 && flagTakesValue(s.slice(1), flags, false)) {
      pos++;
      continue;
    }
    if (s === x) return [...args.slice(0, pos), ...args.slice(pos + 1)];
  }
  return args;
}

export function findCommand(root: Command, args: string[]): { cmd: Command; rest: string[] } {
  let cmd = root;
  let rest = args;
  for (;;) {
    const words = stripFlags(rest, cmd);
    if (words.length === 0) break;
    const next = cmd.findChild(words[0]!);
    if (!next) break;
    rest = argsMinusFirst(rest, words[0]!, cmd);
    cmd = next;
  }
  return { cmd, rest };
}

// ---------------------------------------------------------------------------
// Flag parsing (pflag)

class FlagValues implements ParsedFlags {
  values = new Map<string, string | boolean | string[] | bigint>();
  changedSet = new Set<string>();
  constructor(defs: FlagDef[]) {
    for (const f of defs) {
      if (f.type === "bool") this.values.set(f.name, false);
      else if (f.type === "strings") this.values.set(f.name, []);
      else if (f.type === "string" && f.def !== undefined) this.values.set(f.name, f.def);
    }
  }
  get(name: string) {
    return this.values.get(name);
  }
  string(name: string) {
    const v = this.values.get(name);
    return typeof v === "string" ? v : undefined;
  }
  bool(name: string) {
    return this.values.get(name) === true;
  }
  strings(name: string) {
    const v = this.values.get(name);
    return Array.isArray(v) ? v : [];
  }
  duration(name: string) {
    const v = this.values.get(name);
    return typeof v === "bigint" ? v : undefined;
  }
  changed(name: string) {
    return this.changedSet.has(name);
  }
}

const BOOL_TRUE = new Set(["1", "t", "T", "TRUE", "true", "True"]);
const BOOL_FALSE = new Set(["0", "f", "F", "FALSE", "false", "False"]);

function flagDisplayName(f: FlagDef): string {
  return f.short ? `-${f.short}, --${f.name}` : `--${f.name}`;
}

function setFlag(values: FlagValues, f: FlagDef, value: string): void {
  try {
    switch (f.type) {
      case "bool":
        if (BOOL_TRUE.has(value)) values.values.set(f.name, true);
        else if (BOOL_FALSE.has(value)) values.values.set(f.name, false);
        else throw new Error(`strconv.ParseBool: parsing ${goQuote(value)}: invalid syntax`);
        break;
      case "string":
        values.values.set(f.name, value);
        break;
      case "duration":
        values.values.set(f.name, parseGoDuration(value));
        break;
      case "strings": {
        const rec = readCSVRecord(value);
        const cur = values.changedSet.has(f.name) ? (values.values.get(f.name) as string[]) : [];
        values.values.set(f.name, [...cur, ...rec]);
        break;
      }
    }
  } catch (e) {
    throw new UsageError('invalid argument %s for %s flag: %s', goQuote(value), goQuote(flagDisplayName(f)), e instanceof Error ? e.message : String(e));
  }
  values.changedSet.add(f.name);
}

export class HelpRequested extends Error {
  constructor() {
    super("help requested");
  }
}

/** pflag's interspersed parse of a command's arguments. */
export function parseFlags(cmd: Command, args: string[]): { flags: FlagValues; positional: string[] } {
  const defs = cmd.allFlags();
  const values = new FlagValues(defs);
  const positional: string[] = [];
  let a = [...args];
  while (a.length > 0) {
    const s = a.shift()!;
    if (s.length === 0 || s[0] !== "-" || s.length === 1) {
      positional.push(s);
      continue;
    }
    if (s[1] === "-") {
      if (s.length === 2) {
        positional.push(...a);
        break;
      }
      const name0 = s.slice(2);
      if (name0.length === 0 || name0[0] === "-" || name0[0] === "=") throw new UsageError("bad flag syntax: %s", s);
      const eq = name0.indexOf("=");
      const name = eq >= 0 ? name0.slice(0, eq) : name0;
      const f = defs.find((x) => x.name === name);
      if (!f) throw new UsageError("unknown flag: --%s", name);
      let value: string;
      if (eq >= 0) value = name0.slice(eq + 1);
      else if (f.type === "bool") value = "true";
      else if (a.length > 0) value = a.shift()!;
      else throw new UsageError("flag needs an argument: %s", s);
      setFlag(values, f, value);
      continue;
    }
    // shorthand cluster
    let shorts = s.slice(1);
    while (shorts.length > 0) {
      const c = [...shorts][0]!;
      const f = defs.find((x) => x.short === c);
      if (!f) throw new UsageError("unknown shorthand flag: %s in -%s", goQuoteChar(c), shorts);
      let value: string;
      let restShorts = shorts.slice(c.length);
      if (restShorts.length > 1 && restShorts[0] === "=") {
        value = restShorts.slice(1);
        restShorts = "";
      } else if (f.type === "bool") {
        value = "true";
      } else if (restShorts.length > 0) {
        value = restShorts;
        restShorts = "";
      } else if (a.length > 0) {
        value = a.shift()!;
      } else {
        throw new UsageError("flag needs an argument: %s in -%s", goQuoteChar(c), shorts);
      }
      setFlag(values, f, value);
      shorts = restShorts;
    }
  }
  return { flags: values, positional };
}

/** Go's %q of a rune: 'x'. */
function goQuoteChar(c: string): string {
  const q = goQuote(c);
  let inner = q.slice(1, -1).replace(/\\"/g, '"');
  if (inner === "'") inner = "\\'";
  return "'" + inner + "'";
}

// ---------------------------------------------------------------------------
// Execution

export interface ExecuteResult {
  /** Text to print on stdout (help, version). */
  stdout?: string;
}

function checkArgs(cmd: Command, args: string[]): void {
  const rule = cmd.spec.args ?? "any";
  if (rule === "any") return;
  if (rule === "none") {
    if (args.length > 0) throw new UsageError("unknown command %s for %s", goQuote(args[0]!), goQuote(cmd.path));
    return;
  }
  const { min, max } = rule;
  if (min === max) {
    if (args.length !== min) throw new UsageError("accepts %d arg(s), received %d", min, args.length);
    return;
  }
  if (args.length < min || args.length > max) throw new UsageError("accepts between %d and %d arg(s), received %d", min, max, args.length);
}

/**
 * Runs the command line. Help and version are returned as stdout text; usage errors are
 * thrown as UsageError (exit 2); a command's own errors propagate.
 */
export async function execute(root: Command, argv: string[], version: string): Promise<ExecuteResult> {
  // `passh help [command…]`
  const { cmd, rest } = findCommand(root, argv);
  if (cmd.name === "help" && cmd.parent === root) {
    const { flags, positional } = parseFlags(cmd, rest);
    if (flags.bool("help")) return { stdout: helpText(cmd) };
    let target: Command = root;
    for (const w of positional) {
      const next = target.findChild(w);
      if (!next) {
        if (target === root) target = root;
        break;
      }
      target = next;
    }
    return { stdout: helpText(target) };
  }
  // An unknown word at the root (cobra's legacyArgs): only when the root has no Args rule.
  const { flags, positional } = parseFlags(cmd, rest);
  if (flags.bool("help")) return { stdout: helpText(cmd) };
  if (cmd === root && flags.bool("version")) return { stdout: `passh ${version}\n` };
  if (cmd === root && positional.length > 0) throw new UsageError("unknown command %s for passh", goQuote(positional[0]!));
  if (!cmd.runnable()) {
    if (positional.length > 0 && cmd.children.length > 0) throw new UsageError("unknown command %s for %s", goQuote(positional[0]!), goQuote(cmd.path));
    if (cmd.spec.noSubcommand) throw new UsageError(cmd.spec.noSubcommand);
    return { stdout: helpText(cmd) };
  }
  checkArgs(cmd, positional);
  const global = { config: flags.string("config"), vault: flags.string("vault") };
  await cmd.spec.run!({ cmd, args: positional, flags, global });
  return {};
}

// ---------------------------------------------------------------------------
// Help (cobra's default layout; informative, cli.md §2.26)

function cpLen(s: string): number {
  return [...s].length;
}

function flagUsages(flags: FlagDef[]): string {
  const visible = flags.filter((f) => !f.hidden).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const lines: Array<[string, string]> = [];
  let maxlen = 0;
  for (const f of visible) {
    let line = f.short ? `  -${f.short}, --${f.name}` : `      --${f.name}`;
    const varname = f.type === "bool" ? "" : f.type;
    if (varname) line += " " + varname;
    let usage = f.usageArg !== undefined ? T(f.usage, f.usageArg) : T(f.usage);
    if (f.def !== undefined && f.def !== "") usage += f.type === "string" ? T(" (default %s)", goQuote(f.def)) : T(" (default %s)", f.def);
    if (cpLen(line) + 1 > maxlen) maxlen = cpLen(line) + 1;
    lines.push([line, usage]);
  }
  return lines.map(([l, u]) => l + " " + " ".repeat(maxlen - cpLen(l)) + " " + u + "\n").join("");
}

export function usageText(cmd: Command): string {
  let out = T("Usage:");
  const hasFlags = cmd.allFlags().some((f) => !f.hidden);
  if (cmd.runnable() || cmd.spec.noSubcommand) {
    let use = cmd.parent ? cmd.parent.path + " " + cmd.spec.use : cmd.spec.use;
    if (hasFlags && !use.includes("[flags]")) use += " [flags]";
    out += "\n  " + use;
  }
  const subs = cmd.children.filter((c) => !c.spec.hidden);
  if (subs.length > 0) out += "\n  " + cmd.path + " [command]";
  if (subs.length > 0) {
    const pad = Math.max(11, ...cmd.children.map((c) => cpLen(c.name)));
    out += "\n\n" + T("Available Commands:");
    for (const c of [...subs].sort((a, b) => (a.name < b.name ? -1 : 1))) out += "\n  " + c.name.padEnd(pad) + " " + T(c.spec.short);
  }
  const local = cmd.localFlags().filter((f) => !f.hidden);
  if (local.length > 0) out += "\n\n" + T("Flags:") + "\n" + flagUsages(local).trimEnd();
  const inherited = cmd.inheritedFlags().filter((f) => !f.hidden);
  if (inherited.length > 0) out += "\n\n" + T("Global Flags:") + "\n" + flagUsages(inherited).trimEnd();
  if (subs.length > 0) out += "\n\n" + T('Use "%s [command] --help" for more information about a command.', cmd.path);
  return out + "\n";
}

export function helpText(cmd: Command): string {
  const head = cmd.spec.long ?? cmd.spec.short;
  let out = "";
  if (head) out += T(head).trimEnd() + "\n\n";
  if (cmd.runnable() || cmd.children.length > 0) out += usageText(cmd);
  return out;
}

/** The usage hint printed after every usage error (cli.md §1.3). */
export function usageHint(): string {
  return T("Run 'passh --help' or 'passh <command> --help' for usage.");
}

export { PasshError, E };
