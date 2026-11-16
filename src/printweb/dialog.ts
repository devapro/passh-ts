// The print page's terminal dialog for the CLI (print.md §6.9, cli.md §2.24): the URLs with
// their QR codes, the fingerprint and a countdown on /dev/tty; `c` copies the first URL,
// Esc / q / Ctrl-C stop the server, SIGINT, SIGHUP and SIGTERM cancel it.

import { T } from "../i18n/index.ts";
import type { PrintPage, PrintPageResult } from "./server.ts";

/** The part of src/tty's Tty the dialog uses. */
export interface DialogTty {
  /** Text for people: escaped (S4, multi-line form), line breaks kept. */
  print(text: string): void;
  /** Bytes as they are (control sequences). */
  writeRaw(data: string): void;
  enterRawMode(): void;
  restoreMode(): void;
  reader(): { read(max?: number, abort?: AbortSignal): Promise<Uint8Array | null>; close(): void };
}

/** The clipboard as the dialog needs it (spec §6.3, agent-session.md §A5). */
export interface DialogClipboard {
  /** Copies with the configured method and schedules the clear after `clipboard.clear_after`. */
  copy(text: string): Promise<"copied" | "failed" | "none">;
  /** Runs a clear still pending at once (the dialog bounds it to 10 s). */
  settle(): Promise<void>;
}

export interface DialogOptions {
  now?: () => number;
  /** Signals that cancel the server (default SIGINT, SIGHUP, SIGTERM). */
  signals?: readonly NodeJS.Signals[];
}

/** `M:SS` of the time left, rounded to seconds, not below 0. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The lines written before the countdown (print.md §6.9), in the language. */
export function dialogLines(page: PrintPage): string[] {
  const lines: string[] = [];
  if (page.certNotice) lines.push(page.certNotice.localize());
  for (const s of page.skipped) lines.push(T("not used: %s", s));
  page.urls.forEach((url, i) => {
    lines.push(page.terminalQr(i), url, "");
  });
  lines.push(T("certificate SHA-256  %s", page.fingerprint));
  lines.push(T("Compare it with the fingerprint your browser shows before you accept the certificate."));
  lines.push(T("c copies the URL · Esc stops"));
  return lines;
}

const CLEAR_BOUND_MS = 10_000;

/**
 * Runs the dialog until the server stops; returns its result. The terminal is in raw mode
 * from the countdown on and restored before returning.
 */
export async function runDialog(page: PrintPage, tty: DialogTty, clipboard: DialogClipboard, opts: DialogOptions = {}): Promise<PrintPageResult> {
  const now = opts.now ?? Date.now;
  tty.print(dialogLines(page).join("\n") + "\n");
  let note = "";
  const draw = () => tty.writeRaw("\r\x1b[K" + note + T("stops after one load or in %s", countdown(page.expires - now())));
  const signals = opts.signals ?? ["SIGINT", "SIGHUP", "SIGTERM"];
  const onSignal = () => page.stop();
  for (const s of signals) process.on(s, onSignal);
  tty.enterRawMode();
  const abort = new AbortController();
  const reader = tty.reader();
  let ticker: ReturnType<typeof setInterval> | undefined;
  try {
    draw();
    ticker = setInterval(draw, 1000);
    const keys = (async () => {
      for (;;) {
        let data: Uint8Array | null;
        try {
          data = await reader.read(64, abort.signal);
        } catch {
          return;
        }
        if (data === null) return;
        for (const b of data) {
          if (b === 0x63 || b === 0x43) {
            let r: "copied" | "failed" | "none";
            try {
              r = await clipboard.copy(page.urls[0]!);
            } catch {
              r = "failed";
            }
            note = r === "copied" ? T("URL copied · ") : r === "none" ? T("no clipboard · ") : T("copy failed · ");
            if (!page.result()) draw();
          } else if (b === 0x1b || b === 0x71 || b === 0x51 || b === 0x03) {
            page.stop();
          }
        }
      }
    })();
    const result = await page.done;
    abort.abort();
    await keys;
    clearInterval(ticker);
    ticker = undefined;
    tty.writeRaw("\r\x1b[K");
    let bound: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([clipboard.settle().catch(() => {}), new Promise((r) => (bound = setTimeout(r, CLEAR_BOUND_MS)))]);
    clearTimeout(bound);
    return result;
  } finally {
    if (ticker) clearInterval(ticker);
    abort.abort();
    reader.close();
    tty.restoreMode();
    for (const s of signals) process.off(s, onSignal);
  }
}
