// The program loop of the TUI and the standalone form: terminal setup (raw mode, alternate
// screen, bracketed paste; tui.md §1.1), input decoding, ticks, signals, background jobs and
// rendering with line diffs. The model's update/view never block; this loop does the I/O.

import { InputDecoder, type InputMsg } from "./keys.ts";
import { filterFrame, renderLine, type Line } from "./text.ts";

/** The terminal the loop drives (/dev/tty in production, a fake in tests). */
export interface Terminal {
  /** Writes bytes as they are. */
  write(s: string): void;
  /** The window size, or null if unknown. */
  size(): { cols: number; rows: number } | null;
  /** Calls cb when the window size changes; returns the unsubscribe function. */
  onResize(cb: () => void): () => void;
  /** Resolves with the bytes available (at least one), or null at end of input. */
  read(abort: AbortSignal): Promise<Uint8Array | null>;
  enterRaw(): void;
  restore(): void;
}

/** A program driven by the loop: the TUI's App or the standalone form. */
export interface Program<M> {
  update(msg: M): Array<() => Promise<M | null | undefined | void>>;
  render(): Line[];
  /** Set when the program is finished. */
  done(): boolean;
  resize(cols: number, rows: number): M | null;
  /** The first message, sent after the first resize (e.g. the TUI's agent request). */
  init(): M | null;
  tick(): M | null;
  signal(sig: "SIGHUP" | "SIGTERM" | "SIGINT"): M | null;
  input(m: InputMsg): M;
}

export interface LoopOptions {
  /** Tick period (default 1 s). */
  tickMs?: number;
  /** Signals to catch while the program runs (default SIGHUP, SIGTERM, SIGINT). */
  signals?: Array<"SIGHUP" | "SIGTERM" | "SIGINT">;
  /** Pause after a lone ESC before it counts as the Esc key. */
  escMs?: number;
  /** Enables the kitty keyboard protocol and modifyOtherKeys (default true). */
  extendedKeys?: boolean;
  /** Called after each update (tests). */
  onUpdate?: () => void;
}

export const ENTER_SEQ = (ext: boolean) => "\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?2004h" + (ext ? "\x1b[>1u\x1b[>4;2m" : "") + "\x1b[H\x1b[2J";
export const LEAVE_SEQ = (ext: boolean) => (ext ? "\x1b[>4m\x1b[<u" : "") + "\x1b[?2004l\x1b[?7h\x1b[m\x1b[H\x1b[2J\x1b[?25h\x1b[?1049l";

/** Renders frames with line diffs; a resize or the first frame redraws everything. */
export class Renderer {
  private prev: string[] = [];
  private full = true;
  constructor(private readonly term: Terminal) {}

  invalidate(): void {
    this.full = true;
  }

  draw(frame: Line[]): void {
    const lines = frame.map((l) => filterFrame(renderLine(l)));
    let out = "";
    if (this.full) {
      out += "\x1b[H\x1b[2J";
      this.prev = [];
    }
    for (let i = 0; i < lines.length; i++) {
      if (!this.full && this.prev[i] === lines[i]) continue;
      // Lines are padded to the full width; no erase-to-end (it would clear the last column
      // when the cursor waits there to wrap).
      out += `\x1b[${i + 1};1H\x1b[m` + lines[i] + "\x1b[m";
    }
    this.full = false;
    this.prev = lines;
    if (out) this.term.write("\x1b[?2026h" + out + "\x1b[?2026l");
  }
}

/**
 * Runs a program until it is done: sets the terminal up, feeds keys, pastes, ticks, resizes
 * and signals, runs the jobs update returns, draws after every change, and restores the
 * terminal at the end (also on an exception).
 */
export async function runLoop<M>(prog: Program<M>, term: Terminal, opts: LoopOptions = {}): Promise<void> {
  const ext = opts.extendedKeys ?? true;
  const decoder = new InputDecoder();
  const renderer = new Renderer(term);
  const abort = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let drawQueued = false;
  let finished!: () => void;
  const done = new Promise<void>((r) => (finished = r));
  let escTimer: ReturnType<typeof setTimeout> | null = null;

  const draw = () => {
    drawQueued = false;
    if (prog.done()) return;
    renderer.draw(prog.render());
  };
  const queueDraw = () => {
    if (drawQueued) return;
    drawQueued = true;
    setTimeout(draw, 0);
  };
  const dispatch = (msg: M | null | undefined | void) => {
    if (msg === null || msg === undefined || prog.done()) return;
    let cmds: Array<() => Promise<M | null | undefined | void>>;
    try {
      cmds = prog.update(msg);
    } catch (e) {
      fail(e);
      return;
    }
    opts.onUpdate?.();
    for (const c of cmds) {
      const p = c().then(
        (m) => dispatch(m),
        (e) => fail(e),
      );
      pending.add(p);
      p.finally(() => pending.delete(p));
    }
    if (prog.done()) finished();
    else queueDraw();
  };
  let failure: unknown = null;
  const fail = (e: unknown) => {
    failure ??= e;
    finished();
  };

  term.enterRaw();
  term.write(ENTER_SEQ(ext));
  const unsub: Array<() => void> = [];
  try {
    const sz = term.size() ?? { cols: 80, rows: 24 };
    dispatch(prog.resize(sz.cols, sz.rows));
    dispatch(prog.init());
    unsub.push(
      term.onResize(() => {
        const s = term.size();
        if (!s) return;
        renderer.invalidate();
        dispatch(prog.resize(s.cols, s.rows));
        queueDraw();
      }),
    );
    for (const sig of opts.signals ?? ["SIGHUP", "SIGTERM", "SIGINT"]) {
      const h = () => dispatch(prog.signal(sig));
      process.on(sig, h);
      unsub.push(() => process.off(sig, h));
    }
    const tick = setInterval(() => dispatch(prog.tick()), opts.tickMs ?? 1000);
    unsub.push(() => clearInterval(tick));
    // input
    (async () => {
      for (;;) {
        let bytes: Uint8Array | null;
        try {
          bytes = await term.read(abort.signal);
        } catch (e) {
          if (abort.signal.aborted) return;
          fail(e);
          return;
        }
        if (bytes === null) {
          // end of input: the terminal is gone, treat it as a hangup
          dispatch(prog.signal("SIGHUP"));
          return;
        }
        if (escTimer) {
          clearTimeout(escTimer);
          escTimer = null;
        }
        for (const m of decoder.feed(bytes)) dispatch(prog.input(m));
        if (decoder.pending()) {
          escTimer = setTimeout(() => {
            escTimer = null;
            for (const m of decoder.flush()) dispatch(prog.input(m));
          }, opts.escMs ?? 40);
        }
      }
    })();
    draw();
    if (!prog.done()) await done;
  } finally {
    abort.abort();
    if (escTimer) clearTimeout(escTimer);
    for (const u of unsub) u();
    term.write(LEAVE_SEQ(ext));
    term.restore();
  }
  if (failure) throw failure;
}

// ---------------------------------------------------------------------------
// /dev/tty

import { Tty, openTty } from "../tty/tty.ts";

/** The terminal over /dev/tty (src/tty), or null when there is none. */
export function openTerminal(): (Terminal & { tty: Tty; close(): void }) | null {
  const tty = openTty();
  if (!tty) return null;
  const reader = tty.reader();
  return {
    tty,
    write: (s) => tty.writeRaw(s),
    size: () => tty.windowSize(),
    onResize: (cb) => tty.onResize(() => cb()),
    read: (abort) => reader.read(4096, abort),
    enterRaw: () => tty.enterRawMode(),
    restore: () => tty.restoreMode(),
    close: () => {
      reader.close();
      tty.close();
    },
  };
}
