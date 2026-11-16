// A test harness for the TUI model: a fake clock, a fake backend, and helpers that send
// keys, run the background jobs to completion and render frames as text.

import { App, type Clock, type Cmd, type Msg } from "../app.ts";
import { FakeBackend, type FakeOptions } from "../fake.ts";
import { charKey, key, type InputMsg } from "../keys.ts";
import { lineText, type Line } from "../text.ts";
import { render } from "../view.ts";

export class FakeClock implements Clock {
  m = 10_000;
  w = 1_800_000_000_000;
  mono(): number {
    return this.m;
  }
  wall(): number {
    return this.w;
  }
  advance(ms: number): void {
    this.m += ms;
    this.w += ms;
  }
}

export class Harness {
  readonly clock = new FakeClock();
  readonly backend: FakeBackend;
  readonly app: App;
  private pending = new Set<Promise<void>>();

  constructor(opts: FakeOptions = {}, cols = 80, rows = 24) {
    this.backend = new FakeBackend({ wall: () => this.clock.wall(), ...opts });
    this.app = new App(this.backend, { clock: this.clock, cols, rows });
  }

  /** Sends a message and starts the jobs it returns. */
  send(msg: Msg): void {
    this.run(this.app.update(msg));
  }

  private done = 0;

  private run(cmds: Cmd[]): void {
    for (const c of cmds) {
      const p: Promise<void> = c().then((m) => {
        this.done++;
        if (m) this.run(this.app.update(m));
      });
      this.pending.add(p);
      p.finally(() => this.pending.delete(p));
    }
  }

  /**
   * Lets the jobs run until nothing more happens for a few turns of the event loop. Jobs
   * that wait for something outside (a gate, a scheduled clipboard clear) stay pending.
   */
  async settle(): Promise<void> {
    let idle = 0;
    for (let i = 0; i < 500 && idle < 3; i++) {
      const before = this.done;
      await new Promise((r) => setImmediate(r));
      idle = this.done === before ? idle + 1 : 0;
    }
  }

  /** Sends keys: names like "enter", "ctrl+s", or single characters; then settles. */
  async keys(...names: string[]): Promise<void> {
    for (const n of names) {
      this.send(n.length === 1 || [...n].length === 1 ? charKey(n) : key(n));
      await this.settle();
    }
  }

  /** Types text, one character at a time. */
  async type(text: string): Promise<void> {
    for (const c of text) {
      this.send(charKey(c));
      await this.settle();
    }
  }

  async paste(text: string | Uint8Array): Promise<void> {
    const msg: InputMsg = { type: "paste", bytes: typeof text === "string" ? new TextEncoder().encode(text) : text };
    this.send(msg);
    await this.settle();
  }

  /** Advances the clock and sends a tick. */
  async tick(ms = 1000): Promise<void> {
    this.clock.advance(ms);
    this.send({ type: "tick" });
    await this.settle();
  }

  resize(cols: number, rows: number): void {
    this.send({ type: "resize", cols, rows });
  }

  /** Starts the TUI (the agent request) and, if given, unlocks with the passphrase. */
  async start(passphrase?: string): Promise<void> {
    this.send({ type: "start" });
    await this.settle();
    if (passphrase !== undefined && this.app.screen === "lock") {
      await this.type(passphrase);
      await this.keys("enter");
    }
  }

  frame(): Line[] {
    return render(this.app);
  }

  /** The frame as text lines, trailing blanks removed. */
  lines(): string[] {
    return this.frame().map((l) => lineText(l).replace(/\s+$/, ""));
  }

  text(): string {
    return this.lines().join("\n");
  }
}
