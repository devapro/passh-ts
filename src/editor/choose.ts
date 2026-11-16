// Choosing the editor (agent-session.md §A6, spec §5.6): $EDITOR if it holds anything but
// white space, else $VISUAL likewise, else `vi`; split into words without a shell (§A7);
// the first word is looked up in $PATH. Failures: `$EDITOR: <error>` (`$VISUAL: …`; no
// prefix for vi). Kind from the base name of the resolved path's symlink target, then the
// resolved path, then the word: nvim/nvim.* → neovim; vim/vim.* → vim; nano → nano.

import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { errorf } from "../i18n/index.ts";
import { lookPath, splitWords } from "../exec/index.ts";
import { goTrimSpace } from "../tty/prompts.ts";

export type EditorKind = "vim" | "neovim" | "nano" | "other";

export interface EditorChoice {
  /** Where the command came from. */
  source: "$EDITOR" | "$VISUAL" | "vi";
  /** The words of the command (the first is the program as written). */
  words: string[];
  /** The program, looked up in $PATH. */
  path: string;
  kind: EditorKind;
  /** The name shown in the warning for other editors (base name of the first word). */
  name: string;
}

const VIM_SET = "set nobackup nowritebackup noundofile noswapfile";

/** The leak-safe flags for a kind (§A6 table); the `-c` value is one argument. */
export function editorFlags(kind: EditorKind): string[] {
  switch (kind) {
    case "vim":
      return ["-n", "-u", "NONE", "-i", "NONE", "-c", VIM_SET];
    case "neovim":
      return ["-n", "--clean", "-i", "NONE", "-c", VIM_SET];
    case "nano":
      return ["--ignorercfiles", "--nohelp"];
    default:
      return [];
  }
}

/** The kind a base name stands for, or undefined. */
export function kindOfName(name: string): EditorKind | undefined {
  if (name === "nvim" || name.startsWith("nvim.")) return "neovim";
  if (name === "vim" || name.startsWith("vim.")) return "vim";
  if (name === "nano") return "nano";
  return undefined;
}

/** The kind of an editor: symlink target's base name, then the resolved path's, then the word's. */
export function detectKind(path: string, word: string): EditorKind {
  const names: string[] = [];
  try {
    names.push(basename(realpathSync(path)));
  } catch {
    /* unresolvable: the other names decide */
  }
  names.push(basename(path), basename(word));
  for (const n of names) {
    const k = kindOfName(n);
    if (k) return k;
  }
  return "other";
}

/** The argv of a run: the command's other words, the flags, `--` for known kinds, the file. */
export function editorArgv(e: EditorChoice, file: string): string[] {
  return [e.path, ...e.words.slice(1), ...editorFlags(e.kind), ...(e.kind === "other" ? [] : ["--"]), file];
}

/**
 * Chooses the editor from the environment (before unlocking). Throws `$EDITOR: unterminated
 * single quote in "…"`, `$EDITOR: the editor command is empty`, `$EDITOR: exec: exec: "x":
 * executable file not found in $PATH`, or (for vi) the lookup error alone.
 */
export function chooseEditor(env: Record<string, string | undefined> = process.env): EditorChoice {
  let source: EditorChoice["source"] = "vi";
  let value = "vi";
  for (const name of ["EDITOR", "VISUAL"] as const) {
    const v = env[name];
    if (v !== undefined && goTrimSpace(v) !== "") {
      source = name === "EDITOR" ? "$EDITOR" : "$VISUAL";
      value = v;
      break;
    }
  }
  const fail = (e: unknown) => (source === "vi" ? e : errorf("%s: %w", source, e));
  let words: string[];
  try {
    words = splitWords(value);
  } catch (e) {
    throw fail(e);
  }
  if (words.length === 0 || words[0] === "") throw fail(errorf("the editor command is empty"));
  const word = words[0]!;
  let path: string;
  try {
    path = lookPath(word, env);
  } catch (e) {
    throw fail(e);
  }
  return { source, words, path, kind: detectKind(path, word), name: basename(word) };
}
