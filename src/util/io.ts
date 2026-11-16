// The output channels a command uses (cli.md §1.3). The CLI implements it over the real
// streams (src/cli/output.ts); tests use captureIO(). Modules below the CLI take an IO
// parameter instead of writing to the process streams themselves.

export interface CommandIO {
  /** Data on stdout (never translated). Written as given. */
  stdout(data: string | Uint8Array): void;
  /** A status line, confirmation or hint on stderr: the (translated) text alone. */
  status(text: string): void;
  /** A note on stderr: `passh: <text>`. */
  note(text: string): void;
  /** A warning on stderr: `passh: warning: <text>`. */
  warn(text: string): void;
  /** A warning printed at most once per command (storage.md §3.3). */
  warnOnce(text: string): void;
  /** Whether stdout is a terminal (`show --field`, export/print refusals). */
  stdoutIsTerminal(): boolean;
  /** Whether stderr is a terminal (`import pass` progress). */
  stderrIsTerminal(): boolean;
}

export interface CapturedIO extends CommandIO {
  out: string;
  err: string[];
}

/** An IO that records everything: `out` is stdout, `err` the stderr lines as they would print. */
export function captureIO(opts: { stdoutTerminal?: boolean; stderrTerminal?: boolean } = {}): CapturedIO {
  const seen = new Set<string>();
  const io: CapturedIO = {
    out: "",
    err: [],
    stdout(d) {
      io.out += typeof d === "string" ? d : new TextDecoder().decode(d);
    },
    status(t) {
      io.err.push(t);
    },
    note(t) {
      io.err.push("passh: " + t);
    },
    warn(t) {
      io.err.push("passh: warning: " + t);
    },
    warnOnce(t) {
      if (seen.has(t)) return;
      seen.add(t);
      io.warn(t);
    },
    stdoutIsTerminal: () => opts.stdoutTerminal ?? false,
    stderrIsTerminal: () => opts.stderrTerminal ?? false,
  };
  return io;
}
