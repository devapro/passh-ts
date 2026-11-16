// POSIX shell quoting for the hints passh prints (agent-session.md §A5: `<path>` and
// `<field>` are single-quoted unless they only hold [A-Za-z0-9_\-./@%+=:,]).

const SAFE = /^[A-Za-z0-9_\-./@%+=:,]+$/;

/** The word as a POSIX shell would read it back: as it is when safe, else '…' with ' as '\''. */
export function shellQuote(s: string): string {
  if (SAFE.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
