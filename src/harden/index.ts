// Hardening (spec S7, agent-session.md §A8): core dumps off. RLIMIT_CORE soft and hard = 0,
// as the first action of every passh process (failure: a warning, passh continues) and
// again in the agent before it reads the key (failure: the agent doesn't start).
// Children inherit it. No other process attribute is changed (PR_SET_DUMPABLE stays as
// it is: spec audit #24 is an open owner decision, so the current behaviour is kept).

import { RLIMIT_CORE, setrlimit, getrlimit } from "../ffi/libc.ts";
import { errnoError } from "../fsx/oserror.ts";

/**
 * Sets RLIMIT_CORE soft and hard to 0. Returns undefined on success, else the OS error,
 * whose text is the bare reason (`operation not permitted`), for
 * `passh: warning: disabling core dumps: <OS error>` (cli.md §1.3).
 */
export function disableCoreDumps(): Error | undefined {
  let r: number;
  try {
    r = setrlimit(RLIMIT_CORE, 0n, 0n);
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
  return r === 0 ? undefined : errnoError(r);
}

/** The current core-dump limits (for tests and `doctor`), or an Error. */
export function coreDumpLimits(): { soft: bigint; hard: bigint } | Error {
  const r = getrlimit(RLIMIT_CORE);
  return typeof r === "number" ? errnoError(r) : r;
}
