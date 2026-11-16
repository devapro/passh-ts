// Catching signals while a prompt (or the editor, or `copy`'s wait) runs
// (agent-session.md §A4 "Signals at a prompt", §A5, §A6).
//
// Bun design: JS signal handlers run on the event loop, so a blocking read on /dev/tty
// would keep them from running. passh never blocks: reads wait with poll(2) (timeout 0)
// and short timers (src/tty/source.ts), so a handler runs within a few milliseconds and
// the waiting read sees `received` and gives up. While a SignalWatch is started, the
// default action (death by the signal) is off; stop() restores it (Bun, like Node,
// uninstalls the handler when the last listener goes).

export const PROMPT_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** Thrown by a byte source when a watched signal arrived while it waited. */
export class SignalInterrupt extends Error {
  readonly signal: string;
  constructor(signal: string) {
    super("interrupted by " + signal);
    this.name = "SignalInterrupt";
    this.signal = signal;
  }
}

/** Records the first of some signals while started; other listeners are told of each one. */
export class SignalWatch {
  /** The first signal received since start(), e.g. "SIGTERM". */
  received: string | null = null;
  private readonly handlers = new Map<NodeJS.Signals, () => void>();
  private readonly listeners = new Set<(signal: string) => void>();
  private started = false;

  constructor(readonly signals: readonly NodeJS.Signals[] = PROMPT_SIGNALS) {}

  /** Starts catching (idempotent). */
  start(): this {
    if (this.started) return this;
    this.started = true;
    for (const sig of this.signals) {
      const h = () => {
        if (this.received === null) this.received = sig;
        for (const l of [...this.listeners]) l(sig);
      };
      this.handlers.set(sig, h);
      process.on(sig, h);
    }
    return this;
  }

  /** Stops catching; the default actions come back (unless someone else still listens). */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const [sig, h] of this.handlers) process.off(sig, h);
    this.handlers.clear();
  }

  /** Calls cb for every signal caught from now on; returns the unsubscribe function. */
  onSignal(cb: (signal: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Throws SignalInterrupt if a signal was received. */
  check(): void {
    if (this.received !== null) throw new SignalInterrupt(this.received);
  }

  /** Resolves with the signal (at once if one was received already). */
  whenSignaled(): Promise<string> {
    if (this.received !== null) return Promise.resolve(this.received);
    return new Promise((resolve) => {
      const off = this.onSignal((s) => {
        off();
        resolve(s);
      });
    });
  }
}
