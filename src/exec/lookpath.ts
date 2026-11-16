// Finding a program (agent-session.md §A7): a name without `/` is looked up in $PATH; a
// match found through a relative $PATH entry (such as `.` or an empty entry) is refused.
// The rules and texts follow Go's os/exec LookPath (the reference wraps its error once
// more: `exec: exec: "<name>": executable file not found in $PATH`).

import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { codedError, errorf, type PasshError } from "../i18n/index.ts";
import { Errno, osError } from "../fsx/oserror.ts";

/** Reports whether the error is a "not found in $PATH" lookup failure. */
export const NOT_FOUND = "exec-not-found";
/** The code of a match refused because it was found through a relative $PATH entry. */
export const RELATIVE = "exec-relative";

function findExecutable(file: string): Error | null {
  let st;
  try {
    st = statSync(file);
  } catch (e) {
    return osError("stat", file, e);
  }
  if (st.isDirectory()) return new Errno("EISDIR");
  try {
    accessSync(file, constants.X_OK);
    return null;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "ENOSYS" && code !== "EPERM") return new Errno(code && /^E[A-Z]+$/.test(code) ? code : "EACCES");
  }
  return (st.mode & 0o111) !== 0 ? null : new Errno("EACCES");
}

/** Go's *exec.Error text, wrapped as the reference's process module does: `exec: exec: "<name>": <err>`. */
function lookError(code: string | undefined, name: string, reason: Error | string): PasshError {
  const inner = typeof reason === "string" ? errorf("exec: %q: %s", name, reason) : errorf("exec: %q: %w", name, reason);
  return code ? codedError(code, "exec: %w", inner) : errorf("exec: %w", inner);
}

/**
 * The program to run for `name`: the name itself if it holds a `/` (and is an executable
 * file), else the first executable `<dir>/<name>` of $PATH (an empty entry means `.`).
 * Throws when nothing is found, or when the first match comes from a relative entry.
 */
export function lookPath(name: string, env: Record<string, string | undefined> = process.env): string {
  if (name.includes("/")) {
    const err = findExecutable(name);
    if (err) throw lookError(undefined, name, err);
    return name;
  }
  const path = env.PATH ?? "";
  if (path !== "") {
    for (let dir of path.split(":")) {
      if (dir === "") dir = ".";
      const p = join(dir, name);
      if (findExecutable(p) !== null) continue;
      if (!isAbsolute(p)) throw lookError(RELATIVE, name, "cannot run executable found relative to current directory");
      return p;
    }
  }
  throw lookError(NOT_FOUND, name, "executable file not found in $PATH");
}
