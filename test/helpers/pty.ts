// A small expect-like driver over Bun's PTY support (Bun.spawn with `terminal`).
// The child gets the PTY as its controlling terminal, so /dev/tty works.
//
//   const p = spawnPty([REF_BIN, "init"], env.env);
//   await p.expect("New passphrase: ");
//   p.send("correct horse battery staple\r");
//   ...
//   const r = await p.wait();   // { code, output }

export interface PtyResult {
  code: number;
  signal: string | null;
  /** Everything the child wrote to the terminal (stdout and stderr both, if not redirected). */
  output: string;
}

export interface PtyProcess {
  /** Waits until the output (since the last expect) contains the text or matches the regexp. */
  expect(what: string | RegExp, timeoutMs?: number): Promise<string>;
  /** Writes to the terminal (use "\r" for Enter, "\x03" for Ctrl-C, "\x04" for Ctrl-D). */
  send(text: string): void;
  /** Sends text followed by Enter. */
  line(text: string): void;
  /** All output so far. */
  output(): string;
  /** Output since the last successful expect. */
  pending(): string;
  wait(timeoutMs?: number): Promise<PtyResult>;
  kill(signal?: NodeJS.Signals | number): void;
  pid: number;
  resize(cols: number, rows: number): void;
}

export interface SpawnPtyOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  /**
   * A file path: the child's stdout goes to this file (through `sh -c 'exec … >file'`),
   * separate from the terminal; stderr and /dev/tty stay on the PTY.
   */
  stdoutFile?: string;
}

export function spawnPty(cmd: string[], env: Record<string, string>, opts: SpawnPtyOptions = {}): PtyProcess {
  let out = "";
  let mark = 0;
  const waiters: Array<() => void> = [];
  const decoder = new TextDecoder();
  const spawnOpts: Record<string, unknown> = {
    env,
    cwd: opts.cwd,
    terminal: {
      cols: opts.cols ?? 100,
      rows: opts.rows ?? 30,
      data(_t: unknown, data: Uint8Array) {
        out += decoder.decode(data, { stream: true });
        for (const w of waiters.splice(0)) w();
      },
    },
  };
  if (opts.stdoutFile) cmd = ["/bin/sh", "-c", 'f="$1"; shift; exec "$@" >"$f"', "sh", opts.stdoutFile, ...cmd];
  const proc = Bun.spawn(cmd, spawnOpts as Parameters<typeof Bun.spawn>[1]) as ReturnType<typeof Bun.spawn> & { terminal?: { write(s: string): void; resize?(c: number, r: number): void } };
  const term = proc.terminal!;

  const p: PtyProcess = {
    pid: proc.pid,
    async expect(what, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hay = out.slice(mark);
        let idx = -1;
        let len = 0;
        if (typeof what === "string") {
          idx = hay.indexOf(what);
          len = what.length;
        } else {
          const m = what.exec(hay);
          if (m) {
            idx = m.index;
            len = m[0].length;
          }
        }
        if (idx >= 0) {
          const got = hay.slice(0, idx + len);
          mark += idx + len;
          return got;
        }
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`pty: timed out waiting for ${String(what)}; output so far:\n${JSON.stringify(out.slice(mark))}`);
        if (proc.exitCode !== null || proc.signalCode !== null) {
          // give the last bytes a moment to arrive
          await Bun.sleep(50);
          const again = out.slice(mark);
          const ok = typeof what === "string" ? again.includes(what) : what.test(again);
          if (!ok) throw new Error(`pty: process exited (${proc.exitCode ?? proc.signalCode}) before ${String(what)}; output:\n${JSON.stringify(out.slice(mark))}`);
          continue;
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, Math.min(left, 200));
          waiters.push(() => {
            clearTimeout(t);
            resolve();
          });
        });
      }
    },
    send(text) {
      term.write(text);
    },
    line(text) {
      term.write(text + "\r");
    },
    output() {
      return out;
    },
    pending() {
      return out.slice(mark);
    },
    async wait(timeoutMs = 30_000) {
      const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
      const code = await proc.exited;
      clearTimeout(timer);
      await Bun.sleep(30);
      return { code, signal: proc.signalCode === null || proc.signalCode === undefined ? null : String(proc.signalCode), output: out };
    },
    kill(signal = "SIGTERM") {
      proc.kill(signal as NodeJS.Signals);
    },
    resize(cols, rows) {
      term.resize?.(cols, rows);
    },
  };
  return p;
}
