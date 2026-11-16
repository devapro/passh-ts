// The config file (spec §3.3, storage.md §2, cli.md §1.2): location, loading, validation.

import { codedError, errorf, hasCode, PasshError, type Language } from "../i18n/index.ts";
import { DurationError, MIN, parseGoDuration, SEC, HOUR } from "../util/duration.ts";
import { isErrno } from "../fsx/oserror.ts";
import { MAX_CONFIG_SIZE, readFileLimited } from "../fsx/files.ts";
import { cleanPath, defaultConfigFile, expandPath, homeDir, joinPath, type Env, type PathOptions } from "./paths.ts";
import { keyString, parseToml, TomlError, type TomlDocument, type TomlValue } from "./toml.ts";
import { parseCidr, type Cidr } from "./cidr.ts";

// ---------------------------------------------------------------------------
// The typed config

export interface Config {
  /** The config file that was read (absolute, as located), or undefined when none was. */
  file: string | undefined;
  /** Where the config file was looked for; undefined when that couldn't be computed ($HOME unset). */
  location: ConfigLocation | undefined;
  /** The vault (absolute, cleaned): `--vault`, else the file's `vault`; "" only with `allowMissing` and neither. */
  vault: string;
  /** The vault came from `--vault`. */
  vaultFromFlag: boolean;
  language: Language;
  session: { idleTTL: bigint; stopAgent: boolean };
  agent: { idleTTL: bigint; maxTTL: bigint };
  backup: { keep: number };
  rollback: { warn: boolean };
  clipboard: { clearAfter: bigint; osc52: boolean; command: string[] };
  printWeb: {
    enabled: boolean;
    port: number;
    interfaces: string[];
    hostnames: string[];
    /** Masked prefixes, in file order. */
    allowFrom: Cidr[];
    ttl: bigint;
  };
}

/** The defaults of storage.md §2.3 (durations in nanoseconds). */
export function defaultConfig(): Config {
  return {
    file: undefined,
    location: undefined,
    vault: "",
    vaultFromFlag: false,
    language: "en",
    session: { idleTTL: 5n * MIN, stopAgent: true },
    agent: { idleTTL: 15n * MIN, maxTTL: 2n * HOUR },
    backup: { keep: 10 },
    rollback: { warn: true },
    clipboard: { clearAfter: 30n * SEC, osc52: true, command: [] },
    printWeb: { enabled: false, port: 8443, interfaces: ["wg0", "eth0"], hostnames: [], allowFrom: [], ttl: 5n * MIN },
  };
}

// ---------------------------------------------------------------------------
// Errors

/** A list of problems rendered as indented lines: `\n  p1\n  p2`. */
class ProblemLines {
  constructor(readonly problems: readonly Error[]) {}
  toString(): string {
    return this.problems.map((p) => "\n  " + p.message).join("");
  }
  localize(): string {
    return this.problems.map((p) => "\n  " + (p instanceof PasshError ? p.localize() : p.message)).join("");
  }
}

/**
 * A config file that doesn't load (code "config"): `config <path>: <problem>`, or
 * `config <path>:` followed by one problem per line, indented by two spaces (storage.md §2.2 step 4).
 */
export class ConfigError extends PasshError {
  readonly path: string;
  readonly problems: readonly Error[];
  constructor(path: string, problems: readonly Error[]) {
    if (problems.length === 1) super("config %s: %w", [path, problems[0]], { code: "config", cause: problems[0] });
    else super("config %s:%s", [path, new ProblemLines(problems)], { code: "config" });
    this.name = "ConfigError";
    this.path = path;
    this.problems = problems;
  }
}

function noConfigError(loc: ConfigLocation): PasshError {
  // storage.md §2.6
  switch (loc.source) {
    case "flag":
      return codedError("no-config", 'no config file at %s (from --config): run `passh init` to create one, or create it with the line vault = "/path/to/vault.passh", or pass --vault <file>', loc.path);
    case "env":
      return codedError("no-config", 'no config file at %s (from $PASSH_CONFIG): run `passh init` to create one, or create it with the line vault = "/path/to/vault.passh", or pass --vault <file>', loc.path);
    default:
      return codedError("no-config", 'no config file at %s: run `passh init` to create one, or create it with the line vault = "/path/to/vault.passh", or pass --vault <file>', loc.path);
  }
}

// ---------------------------------------------------------------------------
// Location (storage.md §2.1)

export type ConfigSource = "flag" | "env" | "default";

export interface ConfigLocation {
  /** Absolute and cleaned. */
  path: string;
  /** `--config`, `$PASSH_CONFIG` or the default location. */
  source: ConfigSource;
}

export interface LoadOptions extends PathOptions {
  /** The value of `--config` ("" or undefined: not given). */
  configFlag?: string;
  /** The value of `--vault` ("" or undefined: not given). */
  vaultFlag?: string;
  /**
   * `passh init` (storage.md §2.5): a missing config file (any source, or a location that
   * can't be computed) gives the defaults, with `vault` from `--vault` or "" (init then
   * uses `<data folder>/vault.passh`) and `file` undefined. An existing file is still
   * read and must be valid, with `vault` unless `--vault` is given.
   */
  allowMissing?: boolean;
}

/**
 * Where the config file is (storage.md §2.1): `--config`, `$PASSH_CONFIG`, then
 * `<config folder>/config.toml`; the first two expanded (errors `--config: …`,
 * `$PASSH_CONFIG: …`), the last needing $HOME unless $XDG_CONFIG_HOME is absolute.
 */
export function locateConfig(opts: LoadOptions = {}): ConfigLocation {
  const env = opts.env ?? process.env;
  if (opts.configFlag) {
    try {
      return { path: expandPath(opts.configFlag, opts), source: "flag" };
    } catch (e) {
      throw errorf("--config: %w", e);
    }
  }
  const pc = env.PASSH_CONFIG;
  if (pc) {
    try {
      return { path: expandPath(pc, opts), source: "env" };
    } catch (e) {
      throw errorf("$PASSH_CONFIG: %w", e);
    }
  }
  return { path: defaultConfigFile(env), source: "default" };
}

/**
 * Locates and loads the config (storage.md §2.1 table, cli.md §1.2):
 * - an existing file is always read and must be valid (ConfigError);
 * - a missing file named by `--config` fails (`no config file at … (from --config): …`);
 * - a missing file from `$PASSH_CONFIG` or the default location fails without `--vault`,
 *   else gives all defaults with the flag's vault (language English);
 * - a location that can't be computed ($HOME unset) fails without `--vault`, else defaults;
 * - read errors: `config: <os error>`; `--vault` expansion errors: `--vault: …`.
 */
export function loadConfig(opts: LoadOptions = {}): Config {
  const env = opts.env ?? process.env;
  let loc: ConfigLocation | undefined;
  let locErr: unknown;
  try {
    loc = locateConfig(opts);
  } catch (e) {
    if (opts.configFlag) throw e;
    locErr = e;
  }
  let vaultFlag: string | undefined;
  if (opts.vaultFlag) {
    try {
      vaultFlag = expandPath(opts.vaultFlag, opts);
    } catch (e) {
      throw errorf("--vault: %w", e);
    }
  }
  const defaults = (location: ConfigLocation | undefined): Config => {
    const c = defaultConfig();
    c.location = location;
    c.vault = vaultFlag ?? "";
    c.vaultFromFlag = vaultFlag !== undefined;
    return c;
  };
  if (!loc) {
    if (vaultFlag === undefined && !opts.allowMissing) throw locErr;
    return defaults(undefined);
  }
  let data: Uint8Array;
  try {
    data = readFileLimited(loc.path, MAX_CONFIG_SIZE);
  } catch (e) {
    if (hasCode(e, "too-large")) throw new ConfigError(loc.path, [errorf("the file is larger than 1 MiB")]);
    if (isErrno(e, "ENOENT")) {
      if (opts.allowMissing || (loc.source !== "flag" && vaultFlag !== undefined)) return defaults(loc);
      throw noConfigError(loc);
    }
    throw errorf("config: %w", e);
  }
  // An existing file must be valid, with `vault` unless --vault is given (init too, storage.md §2.5 step 1).
  const c = parseConfig(data, loc.path, { vault: vaultFlag, env });
  c.location = loc;
  return c;
}

// ---------------------------------------------------------------------------
// Parsing and validation (storage.md §2.2–§2.3)

type Leaf = "string" | "int" | "bool" | "strings";
interface TableSchema {
  /** The Go struct BurntSushi names in a type mismatch (not normative, kept for the same text). */
  goStruct: string;
  fields: Record<string, Leaf>;
}

const SCHEMA: Record<string, Leaf | TableSchema> = {
  vault: "string",
  language: "string",
  session: {
    goStruct: 'struct { IdleTTL *string "toml:\\"idle_ttl\\""; StopAgent *bool "toml:\\"stop_agent\\"" }',
    fields: { idle_ttl: "string", stop_agent: "bool" },
  },
  agent: {
    goStruct: 'struct { IdleTTL *string "toml:\\"idle_ttl\\""; MaxTTL *string "toml:\\"max_ttl\\"" }',
    fields: { idle_ttl: "string", max_ttl: "string" },
  },
  backup: { goStruct: 'struct { Keep *int64 "toml:\\"keep\\"" }', fields: { keep: "int" } },
  rollback: { goStruct: 'struct { Warn *bool "toml:\\"warn\\"" }', fields: { warn: "bool" } },
  clipboard: {
    goStruct: 'struct { ClearAfter *string "toml:\\"clear_after\\""; OSC52 *bool "toml:\\"osc52\\""; Command *[]string "toml:\\"command\\"" }',
    fields: { clear_after: "string", osc52: "bool", command: "strings" },
  },
  print_web: {
    goStruct:
      'struct { Enabled *bool "toml:\\"enabled\\""; Port *int64 "toml:\\"port\\""; Interfaces *[]string "toml:\\"interfaces\\""; AllowFrom *[]string "toml:\\"allow_from\\""; Hostnames *[]string "toml:\\"hostnames\\""; TTL *string "toml:\\"ttl\\"" }',
    fields: { enabled: "bool", port: "int", interfaces: "strings", allow_from: "strings", hostnames: "strings", ttl: "string" },
  },
};

const LEAF_DEST: Record<Leaf, string> = { string: "string", int: "integer", bool: "boolean", strings: "slice" };

function tomlTypeName(v: TomlValue): string {
  switch (v.type) {
    case "string":
      return "string";
    case "integer":
      return "int64";
    case "float":
      return "float64";
    case "boolean":
      return "bool";
    case "datetime":
      return "time.Time";
    case "array":
      return v.ofTables ? "[]map[string]any" : "[]any";
    case "table":
      return "map[string]any";
  }
}

function isKnownKey(path: readonly string[]): boolean {
  const top = SCHEMA[path[0]!];
  if (top === undefined) return false;
  if (path.length === 1) return true;
  return typeof top !== "string" && path.length === 2 && Object.hasOwn(top.fields, path[1]!);
}

/** The first type error in file order (the decoder stops at one, storage.md §2.2 step 2). */
function typeError(doc: TomlDocument): TomlError | undefined {
  const errs: TomlError[] = [];
  const leaf = (v: TomlValue, kind: Leaf, path: string[]) => {
    const key = keyString(path);
    const bad = (val: TomlValue, dest: string) =>
      errs.push(new TomlError(val.line, `incompatible types: TOML value has type ${tomlTypeName(val)}; destination has type ${dest}`, key));
    switch (kind) {
      case "string":
        if (v.type !== "string") bad(v, "string");
        return;
      case "int":
        if (v.type !== "integer") bad(v, "integer");
        return;
      case "bool":
        if (v.type !== "boolean") bad(v, "boolean");
        return;
      case "strings":
        if (v.type !== "array") bad(v, "slice");
        else {
          const e = v.value.find((x) => x.type !== "string");
          if (e) bad(e, "string");
        }
        return;
    }
  };
  for (const [name, v] of doc.root.value) {
    const s = SCHEMA[name];
    if (s === undefined) continue;
    if (typeof s === "string") {
      leaf(v, s, [name]);
      continue;
    }
    if (v.type !== "table") {
      errs.push(new TomlError(v.line, `type mismatch for ${s.goStruct}: expected table but found ${tomlTypeName(v)}`, keyString([name])));
      continue;
    }
    for (const [k, vv] of v.value) {
      const f = s.fields[k];
      if (f !== undefined) leaf(vv, f, [name, k]);
    }
  }
  if (errs.length === 0) return undefined;
  return errs.reduce((a, b) => (b.line < a.line ? b : a));
}

/**
 * The unknown keys in file order (storage.md §2.2 step 3). Keys inside an unknown table
 * aren't listed: a key is dropped when an unknown key listed before it is a proper prefix.
 */
export function unknownKeys(doc: TomlDocument): string[][] {
  const out: string[][] = [];
  for (const k of doc.keys) {
    if (isKnownKey(k.path)) continue;
    const hidden = out.some((u) => u.length < k.path.length && u.every((p, i) => p === k.path[i]));
    if (!hidden) out.push(k.path);
  }
  return out;
}

/** Go's unicode.IsSpace. */
export function goIsSpace(cp: number): boolean {
  if (cp <= 0xff) return cp === 0x09 || cp === 0x0a || cp === 0x0b || cp === 0x0c || cp === 0x0d || cp === 0x20 || cp === 0x85 || cp === 0xa0;
  return cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 || cp === 0x202f || cp === 0x205f || cp === 0x3000;
}

/** Go's unicode.IsControl (Cc: C0, DEL, C1). */
function goIsControl(cp: number): boolean {
  return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
}

function isBlank(s: string): boolean {
  for (const ch of s) if (!goIsSpace(ch.codePointAt(0)!)) return false;
  return true;
}

function validName(s: string): boolean {
  if (s === "") return false;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (goIsSpace(cp) || goIsControl(cp)) return false;
  }
  return true;
}

export interface ParseOptions {
  /** The vault from `--vault` (already expanded): replaces the file's `vault`, which is then optional. */
  vault?: string;
  env?: Env;
}

/**
 * Parses and validates the text of a config file (storage.md §2.2–§2.3). `path` is the
 * file's absolute path, used in the errors. Throws ConfigError.
 */
export function parseConfig(data: Uint8Array | string, path: string, opts: ParseOptions = {}): Config {
  const env = opts.env ?? process.env;
  let doc: TomlDocument;
  try {
    doc = parseToml(data);
  } catch (e) {
    if (e instanceof TomlError) throw new ConfigError(path, [e]);
    throw e;
  }
  const te = typeError(doc);
  if (te) throw new ConfigError(path, [te]);

  const problems: Error[] = [];
  for (const k of unknownKeys(doc)) problems.push(errorf("unknown key %q", keyString(k)));

  const c = defaultConfig();
  c.file = path;
  const root = doc.root.value;
  const table = (name: string) => {
    const t = root.get(name);
    return t && t.type === "table" ? t.value : new Map<string, TomlValue>();
  };
  const str = (m: Map<string, TomlValue>, k: string) => {
    const v = m.get(k);
    return v && v.type === "string" ? v.value : undefined;
  };
  const bool = (m: Map<string, TomlValue>, k: string) => {
    const v = m.get(k);
    return v && v.type === "boolean" ? v.value : undefined;
  };
  const int = (m: Map<string, TomlValue>, k: string) => {
    const v = m.get(k);
    return v && v.type === "integer" ? v.value : undefined;
  };
  const strs = (m: Map<string, TomlValue>, k: string) => {
    const v = m.get(k);
    return v && v.type === "array" ? v.value.map((x) => (x.type === "string" ? x.value : "")) : undefined;
  };
  const duration = (key: string, v: string | undefined, def: bigint, check?: (d: bigint) => boolean, rangeMsg?: string): bigint => {
    if (v === undefined) return def;
    let d: bigint;
    try {
      d = parseGoDuration(v);
    } catch (e) {
      if (!(e instanceof DurationError)) throw e;
      problems.push(errorf('%s: %q is not a duration such as "30s", "5m" or "2h"', key, v));
      return def;
    }
    if (d <= 0n) {
      problems.push(errorf("%s: %q must be more than zero", key, v));
      return def;
    }
    if (check && !check(d)) {
      problems.push(errorf(rangeMsg!, v));
      return def;
    }
    return d;
  };

  // vault
  const v = str(root, "vault");
  if (v === undefined) {
    if (opts.vault === undefined) problems.push(errorf('vault is required, e.g. vault = "~/.local/share/passh/vault.passh"'));
  } else if (v === "") {
    problems.push(errorf("vault is empty"));
  } else if (v.startsWith("/")) {
    c.vault = cleanPath(v);
  } else if (v.startsWith("~/")) {
    try {
      c.vault = joinPath(homeDir(env), v.slice(2));
    } catch (e) {
      problems.push(errorf("vault: %w", e));
    }
  } else {
    problems.push(errorf("vault: %q must be an absolute path or start with ~/", v));
  }
  if (opts.vault !== undefined) {
    c.vault = opts.vault;
    c.vaultFromFlag = true;
  }

  // language (English only, i18n.md §6)
  const lang = str(root, "language");
  if (lang !== undefined) {
    if (lang === "en" || lang === "ru" || lang === "sr") c.language = lang;
    else problems.push(errorf('language: %q is not one of "en", "ru" or "sr"', lang));
  }

  const session = table("session");
  c.session.idleTTL = duration("session.idle_ttl", str(session, "idle_ttl"), c.session.idleTTL);
  c.session.stopAgent = bool(session, "stop_agent") ?? c.session.stopAgent;

  const agent = table("agent");
  c.agent.idleTTL = duration("agent.idle_ttl", str(agent, "idle_ttl"), c.agent.idleTTL);
  c.agent.maxTTL = duration("agent.max_ttl", str(agent, "max_ttl"), c.agent.maxTTL);

  const backup = table("backup");
  const keep = int(backup, "keep");
  if (keep !== undefined) {
    if (keep < 0n) problems.push(errorf("backup.keep: %d must be 0 or more", keep));
    else if (keep > 1_000_000n) problems.push(errorf("backup.keep: %d is more than 1000000", keep));
    else c.backup.keep = Number(keep);
  }

  c.rollback.warn = bool(table("rollback"), "warn") ?? c.rollback.warn;

  const clip = table("clipboard");
  c.clipboard.clearAfter = duration("clipboard.clear_after", str(clip, "clear_after"), c.clipboard.clearAfter);
  c.clipboard.osc52 = bool(clip, "osc52") ?? c.clipboard.osc52;
  const cmd = strs(clip, "command");
  if (cmd !== undefined) {
    if (cmd.length > 0 && isBlank(cmd[0]!)) problems.push(errorf("clipboard.command: the program name (first element) is empty"));
    else c.clipboard.command = cmd;
  }

  const pw = table("print_web");
  c.printWeb.enabled = bool(pw, "enabled") ?? c.printWeb.enabled;
  const port = int(pw, "port");
  if (port !== undefined) {
    if (port < 1n || port > 65535n) problems.push(errorf("print_web.port: %d is not between 1 and 65535", port));
    else c.printWeb.port = Number(port);
  }
  for (const key of ["interfaces", "hostnames"] as const) {
    const list = strs(pw, key);
    if (list === undefined) continue;
    let ok = true;
    for (const name of list) {
      if (!validName(name)) {
        problems.push(key === "interfaces" ? errorf("print_web.interfaces: %q is not a valid name", name) : errorf("print_web.hostnames: %q is not a valid name", name));
        ok = false;
      }
    }
    if (ok) c.printWeb[key] = list;
  }
  const allow = strs(pw, "allow_from");
  if (allow !== undefined) {
    const out: Cidr[] = [];
    for (const s of allow) {
      const p = parseCidr(s);
      if (p) out.push(p);
      else problems.push(errorf('print_web.allow_from: %q is not a CIDR such as "192.168.1.0/24" or "fd00::/8"', s));
    }
    c.printWeb.allowFrom = out;
  }
  c.printWeb.ttl = duration("print_web.ttl", str(pw, "ttl"), c.printWeb.ttl, (d) => d >= MIN && d <= 15n * MIN, 'print_web.ttl: %q is not between 1m and 15m');

  if (problems.length > 0) throw new ConfigError(path, problems);
  return c;
}
