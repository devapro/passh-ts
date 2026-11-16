// The TUI's state and update function (tui.md §1–§10). `update` takes one message (a key, a
// paste, a tick, a resize, a signal or the result of a background job), changes the state
// and returns the background jobs to start; it never blocks and never does I/O. The view is
// in view.ts; the program loop that feeds messages and runs jobs is in runtime.ts.

import { T, TN, renderError } from "../i18n/index.ts";
import type { Entry, VaultData } from "../model/types.ts";
import { parsePath, parseTagList, foldersOf } from "../paths/index.ts";
import { HOUR, MIN, SEC, formatGoDuration } from "../util/duration.ts";
import { SignalError } from "../errors.ts";
import { escapeLine } from "../sanitize/index.ts";
import {
  cloneEntry,
  sameEntry,
  type AddExtra,
  type CopyResult,
  type EntryValues,
  type PrintPage,
  type PrintScope,
  type ReloadResult,
  type RollbackQuestion,
  type SaveResult,
  type TuiBackend,
  type UnlockResult,
  type VaultSession,
} from "./backend.ts";
import {
  countIn,
  countWithTags,
  folderOfRow,
  folderRows,
  firstSelectable,
  indexOf,
  lastSelectable,
  moveBy,
  resolveCursor,
  searchRows,
  selectable,
  tagRows,
  type Cursor,
  type Row,
} from "./browse.ts";
import { EntryForm, REVEAL_MS, formText, type FormText } from "./form.ts";
import { LineInput, pasteOneLine } from "./input.ts";
import { blockLength, bodyHeight as viewBodyHeight } from "./view.ts";
import type { InputMsg, KeyMsg } from "./keys.ts";

// ---------------------------------------------------------------------------
// Constants (tui.md §2)

export const TICK_MS = 1000;
export const POLL_MS = 2000;
export const STATUS_MS = 8000;
export const LOCK_BOUND_MS = 5000;
export const COPY_BOUND_MS = 15_000;
export const AGENT_CHECK_MS = 2000;
export const WIDE = 80;

// ---------------------------------------------------------------------------
// Messages and commands

export interface Clock {
  /** Monotonic milliseconds. */
  mono(): number;
  /** Wall-clock milliseconds since the epoch. */
  wall(): number;
}

export const systemClock: Clock = { mono: () => performance.now(), wall: () => Date.now() };

export type SignalName = "SIGHUP" | "SIGTERM" | "SIGINT";

export type Msg =
  | InputMsg
  | { type: "resize"; cols: number; rows: number }
  | { type: "tick" }
  | { type: "signal"; sig: SignalName }
  | { type: "start" }
  | { type: "unlock-result"; job: number; source: "agent" | "passphrase"; result: UnlockResult }
  | { type: "rollback-accepted"; job: number; warnings: string[]; error?: unknown }
  | { type: "save-result"; job: number; result: SaveResult }
  | { type: "check-result"; job: number; changed?: boolean; error?: unknown }
  | { type: "reload-result"; job: number; result: ReloadResult }
  | { type: "copy-result"; job: number; result: CopyResult }
  | { type: "clear-done"; job: number; outcome: "cleared" | "superseded" | { error: unknown } }
  | { type: "lock-done"; job: number; report: LockReport }
  | { type: "agent-status"; job: number; running: boolean }
  | { type: "print-started"; job: number; page?: PrintPage; error?: unknown }
  | { type: "print-stopped"; job: number }
  | { type: "url-copied"; job: number; result: CopyResult };

/** A background job: runs outside update, its result comes back as a message. */
export type Cmd = () => Promise<Msg | null | undefined | void>;

// ---------------------------------------------------------------------------
// State

export type StatusStyle = "info" | "error" | "warn";

export type Status =
  | { k: "msg"; text: string; style: StatusStyle; sticky: boolean; since: number }
  | { k: "copy"; job: number; field: "password" | "username"; clearAt: number; clearing: boolean };

export interface LockReport {
  saveReport: string | null;
  saveOk: boolean;
  cleared: boolean;
  clearError: unknown;
  agentStopped: boolean;
  agentError: unknown;
}

interface Job {
  id: number;
  ctl: AbortController;
}

export type PromptKind = "add" | "move" | "tags" | "print";

export interface Prompt {
  kind: PromptKind;
  label: string;
  input: LineInput;
  error: string | null;
  /** The entry a move or tags prompt applies to, and its path when the prompt opened. */
  entryId?: string;
  path?: string;
  /** The print request a PRINT prompt starts. */
  print?: { scope: PrintScope; fields: string[] };
}

export type Confirm = { kind: "delete"; entryId: string; path: string } | { kind: "rollback"; warning: string; answer: (yes: boolean, signal: AbortSignal) => Promise<ReloadResult> };

/** What a form belongs to (tui.md §8.2). */
export interface FormCtx {
  mode: "add" | "edit";
  /** add: the path; edit: the entry's path when the form opened. */
  path: string;
  /** edit: the entry when the form opened. */
  entry: Entry | null;
  /** A recreated add keeps the deleted entry's custom fields and unknown keys. */
  extra: AddExtra | null;
}

export interface PrintSetup {
  scopes: Array<{ scope: PrintScope; label: string; count: number }>;
  scope: number;
  fields: { password: boolean; username: boolean; url: boolean; fields: boolean };
  /** Cursor over the scope rows, then the four field rows. */
  cursor: number;
}

export interface PrintDialog {
  page: PrintPage;
  url: number;
  scroll: number;
  note: string | null;
  stopping: boolean;
  stopped: null | { served: boolean; outcome: string };
}

export type Overlay =
  | { kind: "help"; scroll: number }
  | { kind: "prompt"; prompt: Prompt }
  | { kind: "confirm"; confirm: Confirm }
  | { kind: "print-setup"; setup: PrintSetup }
  | { kind: "print-dialog"; dialog: PrintDialog }
  | { kind: "form"; form: EntryForm; ctx: FormCtx };

type SaveOp =
  | { kind: "add"; path: string; form: EntryForm; ctx: FormCtx }
  | { kind: "edit"; id: string; path: string; form: EntryForm; ctx: FormCtx }
  | { kind: "move"; id: string; src: string; dst: string; prompt: Prompt }
  | { kind: "tags"; id: string; path: string; prompt: Prompt }
  | { kind: "delete"; id: string; path: string };

type Kept = { kind: "form"; form: EntryForm; ctx: FormCtx } | { kind: "prompt"; prompt: Prompt };

export class Main {
  data: VaultData;
  view: "folders" | "tags" = "folders";
  search: { query: LineInput; typing: boolean } | null = null;
  expanded = new Set<string>();
  tagSel: string[] = [];
  cursors: Record<"folders" | "tags" | "search", Cursor> = {
    folders: { key: "", index: 0 },
    tags: { key: "", index: 0 },
    search: { key: "", index: 0 },
  };
  detail: { id: string; scroll: number } | null = null;
  /** First visible row of each list (the list scrolls to keep the cursor visible). */
  offsets: Record<"folders" | "tags" | "search", number> = { folders: 0, tags: 0, search: 0 };
  reveal: { id: string; until: number } | null = null;
  overlay: Overlay | null = null;
  status: Status | null = null;
  banner = false;
  checkFailedShown = false;
  kept: Kept | null = null;

  constructor(data: VaultData) {
    this.data = data;
  }
}

export interface LockScreen {
  mode: "field" | "busy" | "rollback" | "damaged";
  input: LineInput;
  busy: string;
  messages: Array<{ text: string; style: StatusStyle }>;
  /** After `L` or the idle lock: an agent still runs (tui.md §4.2). */
  agentHint: boolean;
  afterLock: boolean;
  rollback: { session: VaultSession; question: RollbackQuestion; warnings: string[] } | null;
}

export interface ExitPlan {
  /** Exit status for a normal end; ignored when `error` is set. */
  code: number;
  /** The error the TUI ends with (the CLI prints it and exits with its status). */
  error?: unknown;
  /** Lines for stderr after the TUI has left the screen (without the `passh: ` prefix). */
  lines: string[];
  /** Quitting waits for a pending clipboard clear with a countdown (tui.md §1.2). */
  waitClear: boolean;
  /** The signal that ended the TUI, if any. */
  signal?: SignalName;
}

interface RunningSave {
  id: number;
  ctl: AbortController;
  op: SaveOp;
  promise: Promise<SaveResult>;
}

// ---------------------------------------------------------------------------

export interface AppOptions {
  clock?: Clock;
  cols?: number;
  rows?: number;
}

export class App {
  readonly backend: TuiBackend;
  readonly clock: Clock;
  cols: number;
  rows: number;
  screen: "lock" | "main" | "bye" = "lock";
  lock: LockScreen;
  main: Main | null = null;
  session: VaultSession | null = null;
  exit: ExitPlan | null = null;

  private seq = 0;
  private unlockJob: Job | null = null;
  private save: RunningSave | null = null;
  private reloadJob: Job | null = null;
  private checkJob: number | null = null;
  private lastCheck = 0;
  /** Bumped by every save, so a check that started before it is ignored. */
  private saveGen = 0;
  private copyJob: { id: number; ctl: AbortController; promise: Promise<unknown> } | null = null;
  private latestCopy = 0;
  private lockJob: { id: number; reason: LockReason; sig?: SignalName } | null = null;
  private printJob: Job | null = null;
  private printPage: PrintPage | null = null;
  private pendingSignal: SignalName | null = null;
  /** Last key press or paste (tui.md §10.1). */
  lastKey: { mono: number; wall: number };

  constructor(backend: TuiBackend, opts: AppOptions = {}) {
    this.backend = backend;
    this.clock = opts.clock ?? systemClock;
    this.cols = opts.cols ?? 80;
    this.rows = opts.rows ?? 24;
    this.lock = newLockScreen();
    this.lastKey = { mono: this.clock.mono(), wall: this.clock.wall() };
  }

  now(): number {
    return this.clock.mono();
  }

  private job(): Job {
    return { id: ++this.seq, ctl: new AbortController() };
  }

  // -------------------------------------------------------------------------
  // update

  update(msg: Msg): Cmd[] {
    if (this.screen === "bye") {
      // a key that arrives after the end is closed at once
      if (msg.type === "unlock-result" && msg.result.kind === "unlocked") msg.result.session.close();
      if (msg.type === "print-started" && msg.page) void msg.page.stop().catch(() => {});
      return [];
    }
    switch (msg.type) {
      case "start":
        return this.startAgentUnlock(false);
      case "resize":
        this.cols = msg.cols;
        this.rows = msg.rows;
        return this.afterMain([]);
      case "tick":
        return this.tick();
      case "signal":
        return this.onSignal(msg.sig);
      case "key":
      case "paste":
        this.lastKey = { mono: this.clock.mono(), wall: this.clock.wall() };
        if (this.screen === "lock") return this.lockInput(msg);
        return this.afterMain(this.mainInput(msg));
      case "unlock-result":
        return this.onUnlock(msg.job, msg.source, msg.result);
      case "rollback-accepted":
        return this.onRollbackAccepted(msg.job, msg.warnings, msg.error);
      case "save-result":
        return this.afterMain(this.onSave(msg.job, msg.result));
      case "check-result":
        return this.onCheck(msg.job, msg.changed, msg.error);
      case "reload-result":
        return this.afterMain(this.onReload(msg.job, msg.result));
      case "copy-result":
        return this.onCopy(msg.job, msg.result);
      case "clear-done":
        return this.onClearDone(msg.job, msg.outcome);
      case "lock-done":
        return this.onLockDone(msg.job, msg.report);
      case "agent-status":
        if (this.screen === "lock" && msg.job === this.seqAgentStatus && this.lock.mode === "field") this.lock.agentHint = msg.running;
        return [];
      case "print-started":
        return this.onPrintStarted(msg.job, msg.page, msg.error);
      case "print-stopped":
        return this.onPrintStopped(msg.job);
      case "url-copied":
        return this.onUrlCopied(msg.job, msg.result);
    }
  }

  /** Keeps the list cursor visible after anything that may move it. */
  private afterMain(cmds: Cmd[]): Cmd[] {
    if (this.screen === "main" && this.main && !this.main.overlay) this.ensureVisible();
    return cmds;
  }

  // -------------------------------------------------------------------------
  // Lock screen (tui.md §4)

  private seqAgentStatus = 0;

  private startAgentUnlock(afterLock: boolean): Cmd[] {
    const j = this.job();
    this.unlockJob = j;
    this.lock.mode = "busy";
    this.lock.busy = T("asking the agent…");
    if (afterLock) this.lock.messages = [];
    return [
      async () => {
        let result: UnlockResult;
        try {
          result = await this.backend.unlockWithAgent(j.ctl.signal);
        } catch (e) {
          result = { kind: "agent-failed", error: e };
        }
        return { type: "unlock-result", job: j.id, source: "agent", result };
      },
    ];
  }

  private startPassphraseUnlock(): Cmd[] {
    const j = this.job();
    this.unlockJob = j;
    // The typed bytes are taken and the field wiped at once (§4.2).
    const bytes = new TextEncoder().encode(this.lock.input.value);
    this.lock.input.wipe();
    this.lock.mode = "busy";
    this.lock.busy = T("unlocking… (this takes a few seconds on small devices)");
    this.lock.messages = [];
    return [
      async () => {
        let result: UnlockResult;
        try {
          result = await this.backend.unlockWithPassphrase(bytes, j.ctl.signal);
        } catch (e) {
          result = { kind: "error", error: e };
        } finally {
          bytes.fill(0);
        }
        return { type: "unlock-result", job: j.id, source: "passphrase", result };
      },
    ];
  }

  private lockInput(msg: InputMsg): Cmd[] {
    const L = this.lock;
    const k = msg.type === "key" ? msg : null;
    switch (L.mode) {
      case "busy":
        if (k && (k.key === "ctrl+c" || k.key === "ctrl+d")) return this.quitFromLock();
        return [];
      case "damaged":
        if (!k) return [];
        if (k.key === "enter") {
          L.messages = [];
          return this.startAgentUnlock(false);
        }
        if (k.key === "esc" || k.key === "q") return this.quitFromLock();
        if (k.key === "ctrl+c" || k.key === "ctrl+d") return this.quitFromLock();
        return [];
      case "rollback": {
        if (!k) return [];
        const rb = L.rollback!;
        if (k.key === "y" || k.key === "Y") {
          const j = this.job();
          this.unlockJob = j;
          L.mode = "busy";
          L.busy = T("unlocking… (this takes a few seconds on small devices)");
          return [
            async () => {
              try {
                return { type: "rollback-accepted", job: j.id, warnings: await rb.question.accept() };
              } catch (e) {
                return { type: "rollback-accepted", job: j.id, warnings: [], error: e };
              }
            },
          ];
        }
        if (k.key === "n" || k.key === "N" || k.key === "esc" || k.key === "enter") {
          rb.session.close();
          L.rollback = null;
          this.finish({ code: 1, error: rb.question.declined, lines: [], waitClear: false });
          return [];
        }
        if (k.key === "ctrl+c") {
          // quit: the session ends like a lock on exit
          this.session = rb.session;
          L.rollback = null;
          return this.startLock("exit");
        }
        return [];
      }
      case "field": {
        if (msg.type === "paste") {
          const p = pasteOneLine(msg.bytes);
          if (!p.ok) {
            L.messages = [{ text: p.reason === "lines" ? T("Paste refused: the passphrase is one line.") : T("Paste refused: the text isn't valid UTF-8."), style: "error" }];
            return [];
          }
          L.input.insert(p.text);
          return [];
        }
        const key = k!;
        if (key.key === "ctrl+c" || key.key === "ctrl+d") return this.quitFromLock();
        if (key.key === "esc") {
          if (L.input.cs.length === 0) return this.quitFromLock();
          L.input.wipe();
          return [];
        }
        if (key.key === "enter") {
          if (L.input.cs.length > 0) return this.startPassphraseUnlock();
          if (L.afterLock && L.agentHint) return this.startAgentUnlock(true);
          L.messages = [{ text: T("Type the passphrase, then Enter."), style: "info" }];
          return [];
        }
        // Typed text: keys reported as text without Ctrl or Alt (§4.2); TAB adds nothing.
        if (key.text) {
          L.input.insert(key.text);
          return [];
        }
        L.input.handleKey(key);
        return [];
      }
    }
  }

  private quitFromLock(): Cmd[] {
    this.unlockJob?.ctl.abort();
    this.unlockJob = null;
    if (this.lockJob) {
      // a lock is running: exit when it is done
      this.lockJob.reason = this.lockJob.reason === "signal" ? "signal" : "exit-after";
      return [];
    }
    this.finish({ code: 0, lines: [], waitClear: true });
    return [];
  }

  private onUnlock(job: number, source: "agent" | "passphrase", r: UnlockResult): Cmd[] {
    if (!this.unlockJob || job !== this.unlockJob.id || this.screen !== "lock") {
      if (r.kind === "unlocked") r.session.close();
      return [];
    }
    this.unlockJob = null;
    const L = this.lock;
    L.mode = "field";
    const msg = (text: string, style: StatusStyle = "error") => (L.messages = [{ text, style }]);
    switch (r.kind) {
      case "unlocked":
        if (r.rollback) {
          L.mode = "rollback";
          L.rollback = { session: r.session, question: r.rollback, warnings: r.warnings };
          return [];
        }
        return this.enterMain(r.session, r.warnings);
      case "no-agent":
        if (source === "agent" && L.afterLock) {
          L.agentHint = false;
          msg(T("Type the passphrase, then Enter."), "info");
        }
        return [];
      case "wrong-passphrase":
        msg(T("Wrong passphrase, or the key block is damaged. Try again."));
        return [];
      case "damaged":
        L.mode = "damaged";
        msg(renderError(r.error));
        return [];
      case "agent-other-key-block":
        msg(T("The agent was unlocked for another key block (the passphrase was changed?): enter the passphrase."));
        return [];
      case "agent-failed":
        msg(T("The agent didn't give the key (%s): enter the passphrase.", renderError(r.error)));
        return [];
      case "work-factor":
        msg(
          T(
            "The vault file's key block asks for more scrypt work than passh ever uses: the file is damaged or wasn't made by passh. Restore a backup (passh backups lists them), then unlock again.",
          ),
        );
        return [];
      case "error":
        msg(renderError(r.error));
        return [];
    }
  }

  private onRollbackAccepted(job: number, warnings: string[], error: unknown): Cmd[] {
    if (!this.unlockJob || job !== this.unlockJob.id) return [];
    this.unlockJob = null;
    const rb = this.lock.rollback;
    if (!rb) return [];
    this.lock.rollback = null;
    if (error !== undefined) {
      // SPEC-GAP: the open failed after "yes" (e.g. the file went away): its error, and the
      // passphrase field again.
      rb.session.close();
      this.lock.mode = "field";
      this.lock.messages = [{ text: renderError(error), style: "error" }];
      return [];
    }
    return this.enterMain(rb.session, [...rb.warnings, ...warnings]);
  }

  private enterMain(session: VaultSession, warnings: string[]): Cmd[] {
    this.session = session;
    const data = session.data();
    this.main = new Main(data);
    this.screen = "main";
    this.lock = newLockScreen();
    this.lastKey = { mono: this.clock.mono(), wall: this.clock.wall() };
    this.lastCheck = this.clock.mono();
    const n = data.entries.length;
    this.setStatus(TN(n, "Unlocked: %d entry, revision %d.", "Unlocked: %d entries, revision %d.", n, data.revision), "info", false, warnings);
    if (this.pendingSignal) return this.onSignal(this.pendingSignal);
    return [];
  }

  // -------------------------------------------------------------------------
  // Status

  setStatus(text: string, style: StatusStyle = "info", sticky = false, warnings: string[] = []): void {
    const m = this.main;
    if (!m) return;
    for (const w of warnings) text += "\n" + T("Warning: %s", w);
    m.status = { k: "msg", text, style, sticky, since: this.clock.mono() };
  }

  private error(text: string, sticky = true): void {
    this.setStatus(text, "error", sticky);
  }

  // -------------------------------------------------------------------------
  // Lists

  /** The current list: search results, Folders or Tags. */
  list(): { name: "folders" | "tags" | "search"; rows: Row[] } {
    const m = this.main!;
    const ix = indexOf(m.data);
    if (m.search) return { name: "search", rows: searchRows(ix, m.search.query.value, T("No matches.")) };
    if (m.view === "tags")
      return {
        name: "tags",
        rows: tagRows(ix, m.tagSel, {
          none: T("No tags yet: t edits an entry's tags."),
          hint: T("Space selects tags; the entries that have all of them show here."),
          heading: (n, tags) => TN(n, "── %d entry with %s ──", "── %d entries with %s ──", n, tags),
        }),
      };
    const rows = folderRows(ix, m.expanded);
    if (rows.length === 0) return { name: "folders", rows: [{ kind: "note", key: "", depth: 0, text: T("No entries yet: a adds one.") }] };
    return { name: "folders", rows };
  }

  /** The cursor's row index in the current list (-1: none). */
  cursorIndex(l = this.list()): number {
    return resolveCursor(l.rows, this.main!.cursors[l.name]);
  }

  private setCursor(l: { name: "folders" | "tags" | "search"; rows: Row[] }, i: number): void {
    const m = this.main!;
    const r = l.rows[i];
    m.cursors[l.name] = { key: r && selectable(r) ? r.key : "", index: Math.max(0, i) };
  }

  /** The selected entry (§3.3): the open detail's, else the one under the cursor. */
  selectedEntry(): Entry | null {
    const m = this.main;
    if (!m) return null;
    const ix = indexOf(m.data);
    if (m.detail) return ix.byId.get(m.detail.id) ?? null;
    const l = this.list();
    const r = l.rows[this.cursorIndex(l)];
    return r?.kind === "entry" ? r.entry! : null;
  }

  isWide(): boolean {
    return this.cols >= WIDE;
  }

  /** Body height of the main screen (§5.1), used for page moves and scrolling. */
  bodyHeight(): number {
    return this.main ? viewBodyHeight(this, this.main) : 1;
  }

  /** Width of a full-width block (help, detail). */
  private blockWidth(): number {
    return this.isWide() ? this.cols - 4 : this.cols - 1;
  }

  /** The largest scroll offset of the open full-width block. */
  private maxScroll(): number {
    const m = this.main!;
    return Math.max(0, blockLength(this, m, this.blockWidth()) - this.bodyHeight());
  }

  /** Keeps the cursor of the current list inside the visible rows. */
  private ensureVisible(): void {
    const m = this.main;
    if (!m) return;
    const l = this.list();
    const ci = this.cursorIndex(l);
    const h = this.bodyHeight();
    let off = m.offsets[l.name];
    if (ci >= 0) {
      if (ci < off) off = ci;
      if (ci >= off + h) off = ci - h + 1;
    }
    m.offsets[l.name] = Math.max(0, Math.min(off, Math.max(0, l.rows.length - h)));
  }

  /** Hides a reveal that doesn't belong to the selected entry any more (§6.3). */
  private syncReveal(): void {
    const m = this.main;
    if (!m || !m.reveal) return;
    const sel = this.selectedEntry();
    if (!sel || sel.id !== m.reveal.id) m.reveal = null;
  }

  revealedFor(id: string): boolean {
    const m = this.main;
    return !!m && !!m.reveal && m.reveal.id === id && this.clock.mono() < m.reveal.until;
  }

  // -------------------------------------------------------------------------
  // Main screen input (routing of §3.2)

  private mainInput(msg: InputMsg): Cmd[] {
    const m = this.main!;
    const k = msg.type === "key" ? msg : null;
    const ov = m.overlay;
    // 1. L locks unless a text field has the keys.
    const textField = ov?.kind === "form" || ov?.kind === "prompt" || (m.search?.typing && !ov);
    if (k && k.key === "L" && !textField) return this.startLock("key");
    // 2. Form
    if (ov?.kind === "form") return this.formInput(ov.form, ov.ctx, msg);
    // 3. Print dialog
    if (ov?.kind === "print-dialog") return this.dialogInput(ov.dialog, msg);
    // 4. Confirm
    if (ov?.kind === "confirm") return this.confirmInput(ov.confirm, msg);
    // 5. Prompt
    if (ov?.kind === "prompt") return this.promptInput(ov.prompt, msg);
    // 6. Print setup
    if (ov?.kind === "print-setup") return this.setupInput(ov.setup, msg);
    // 7. Help
    if (ov?.kind === "help") {
      if (!k) return [];
      if (k.key === "up" || k.key === "k") ov.scroll = Math.max(0, Math.min(ov.scroll, this.maxScroll()) - 1);
      else if (k.key === "down" || k.key === "j") ov.scroll = Math.min(ov.scroll + 1, this.maxScroll());
      else if (k.key === "ctrl+c") return this.quit();
      else m.overlay = null;
      return [];
    }
    // 8. Search typing
    if (m.search?.typing) return this.searchInput(msg);
    if (!k) return [];
    // 9. Global keys
    const g = this.globalKey(k);
    if (g) return g;
    // 10. Detail
    if (m.detail) {
      this.detailKey(k);
      return [];
    }
    // 11. List
    this.listKey(k);
    return [];
  }

  private globalKey(k: KeyMsg): Cmd[] | null {
    const m = this.main!;
    switch (k.key) {
      case "q":
      case "ctrl+c":
        return this.quit();
      case "?":
        m.overlay = { kind: "help", scroll: 0 };
        return [];
      case "R":
        return this.startReload();
      case "/":
        this.closeDetail();
        if (m.search) m.search.typing = true;
        else {
          m.search = { query: new LineInput(""), typing: true };
          m.cursors.search = { key: "", index: 0 };
        }
        return [];
      case "tab":
        this.closeDetail();
        this.closeSearch();
        m.view = m.view === "folders" ? "tags" : "folders";
        this.syncReveal();
        return [];
      case "P":
        return this.openPrintSetup();
      case "a":
        return this.openAdd();
      case "c":
      case "u":
        return this.copySelected(k.key === "c" ? "password" : "username");
      case "r":
        return this.toggleReveal();
      case "e":
        return this.openEdit();
      case "t":
        return this.openTags();
      case "m":
        return this.openMove();
      case "d":
        return this.openDelete();
      default:
        return null;
    }
  }

  private closeDetail(): void {
    const m = this.main!;
    if (!m.detail) return;
    const id = m.detail.id;
    m.detail = null;
    m.reveal = null;
    // back to the list, cursor on that entry
    const l = this.list();
    const i = l.rows.findIndex((r) => r.key === "e:" + id);
    if (i >= 0) this.setCursor(l, i);
  }

  private closeSearch(): void {
    const m = this.main!;
    if (!m.search) return;
    m.search.query.wipe();
    m.search = null;
    this.syncReveal();
  }

  private openDetail(e: Entry): void {
    const m = this.main!;
    if (m.reveal && m.reveal.id !== e.id) m.reveal = null;
    m.detail = { id: e.id, scroll: 0 };
  }

  private detailKey(k: KeyMsg): void {
    const m = this.main!;
    const d = m.detail!;
    const page = Math.max(1, this.bodyHeight() - 1);
    const max = this.maxScroll();
    d.scroll = Math.min(d.scroll, max);
    switch (k.key) {
      case "esc":
      case "left":
      case "h":
      case "backspace":
        this.closeDetail();
        return;
      case "up":
      case "k":
        d.scroll = Math.max(0, d.scroll - 1);
        return;
      case "down":
      case "j":
        d.scroll = Math.min(max, d.scroll + 1);
        return;
      case "pgup":
        d.scroll = Math.max(0, d.scroll - page);
        return;
      case "pgdown":
      case "space":
        d.scroll = Math.min(max, d.scroll + page);
        return;
      case "home":
      case "g":
        d.scroll = 0;
        return;
    }
  }

  private listKey(k: KeyMsg): void {
    const m = this.main!;
    const l = this.list();
    const i = this.cursorIndex(l);
    const row = l.rows[i];
    const move = (j: number) => {
      if (j < 0) return;
      this.setCursor(l, j);
      this.syncReveal();
    };
    switch (k.key) {
      case "up":
      case "k":
      case "ctrl+p":
        move(moveBy(l.rows, i, -1));
        return;
      case "down":
      case "j":
      case "ctrl+n":
        move(moveBy(l.rows, i, 1));
        return;
      case "pgup":
        move(moveBy(l.rows, i, -Math.max(1, this.bodyHeight() - 1)));
        return;
      case "pgdown":
        move(moveBy(l.rows, i, Math.max(1, this.bodyHeight() - 1)));
        return;
      case "home":
      case "g":
        move(firstSelectable(l.rows));
        return;
      case "end":
      case "G":
        move(lastSelectable(l.rows));
        return;
      case "enter":
      case "space":
      case "right":
      case "l": {
        if (!row || !selectable(row)) return;
        if (row.kind === "folder") {
          const open = m.expanded.has(row.folder!);
          if (k.key === "right" || k.key === "l") {
            if (!open) m.expanded.add(row.folder!);
            else {
              const nl = this.list();
              const ni = nl.rows.findIndex((r) => r.key === row.key);
              if (ni >= 0 && ni + 1 < nl.rows.length && nl.rows[ni + 1]!.depth > row.depth) move(ni + 1);
              return;
            }
          } else if (open) m.expanded.delete(row.folder!);
          else m.expanded.add(row.folder!);
          this.setCursor(l, i);
          return;
        }
        if (row.kind === "tag") {
          const t = row.tag!;
          m.tagSel = m.tagSel.includes(t) ? m.tagSel.filter((x) => x !== t) : [...m.tagSel, t];
          this.setCursor(l, i);
          return;
        }
        if (row.kind === "entry" && k.key !== "space") this.openDetail(row.entry!);
        return;
      }
      case "left":
      case "h": {
        if (l.name !== "folders" || !row) return;
        if (row.kind === "folder" && m.expanded.has(row.folder!)) {
          m.expanded.delete(row.folder!);
          return;
        }
        const path = row.kind === "folder" ? row.folder! : row.kind === "entry" ? row.entry!.path : "";
        const slash = path.lastIndexOf("/");
        if (slash < 0) return;
        const parent = path.slice(0, slash);
        const pi = l.rows.findIndex((r) => r.key === "f:" + parent);
        if (pi >= 0) move(pi);
        return;
      }
      case "esc":
        if (l.name === "search") {
          this.closeSearch();
          return;
        }
        if (m.view === "tags" && m.tagSel.length > 0) m.tagSel = [];
        return;
      default:
        return;
    }
  }

  private searchInput(msg: InputMsg): Cmd[] {
    const m = this.main!;
    const s = m.search!;
    if (msg.type === "paste") {
      const p = pasteOneLine(msg.bytes);
      if (!p.ok) {
        this.error(T("Paste refused: one line only."), false);
        return [];
      }
      s.query.insert(p.text);
      m.cursors.search = { key: "", index: 0 };
      this.syncReveal();
      return [];
    }
    const k = msg;
    const l = this.list();
    switch (k.key) {
      case "up":
      case "ctrl+p":
        this.setCursor(l, moveBy(l.rows, this.cursorIndex(l), -1));
        this.syncReveal();
        return [];
      case "down":
      case "ctrl+n":
        this.setCursor(l, moveBy(l.rows, this.cursorIndex(l), 1));
        this.syncReveal();
        return [];
      case "enter":
        if (l.rows.some((r) => r.kind === "entry")) s.typing = false;
        else this.closeSearch();
        return [];
      case "esc":
      // SPEC-GAP (audit #19): Ctrl-C while typing closes the search like Esc (the proposed
      // fix) instead of quitting.
      case "ctrl+c":
        this.closeSearch();
        return [];
      case "tab":
        this.closeSearch();
        m.view = m.view === "folders" ? "tags" : "folders";
        this.syncReveal();
        return [];
    }
    const r = s.query.handleKey(k);
    if (r === "changed") {
      m.cursors.search = { key: "", index: 0 };
      this.syncReveal();
    }
    return [];
  }

  // -------------------------------------------------------------------------
  // Reveal and copy (§6.3, §7.1)

  private toggleReveal(): Cmd[] {
    const m = this.main!;
    const e = this.selectedEntry();
    if (!e) {
      this.setStatus(T("Select an entry first."));
      return [];
    }
    if (m.reveal && m.reveal.id === e.id) {
      m.reveal = null;
      return [];
    }
    m.reveal = { id: e.id, until: this.clock.mono() + REVEAL_MS };
    // In the narrow list, r also opens the entry's detail (§6.3).
    if (!this.isWide() && !m.detail) this.openDetail(e);
    return [];
  }

  private copySelected(field: "password" | "username"): Cmd[] {
    const e = this.selectedEntry();
    if (!e) {
      this.setStatus(T("Select an entry first."));
      return [];
    }
    const value = field === "password" ? e.password : e.username;
    if (value === "") {
      this.setStatus(field === "password" ? T("%s has no password.", vpath(e.path)) : T("%s has no username.", vpath(e.path)));
      return [];
    }
    const j = this.job();
    this.latestCopy = j.id;
    this.copyField = { job: j.id, field };
    this.setStatus(T("Copying…"), "info", true);
    const promise = withTimeout(this.backend.copy(value, field, e.path, j.ctl.signal), COPY_BOUND_MS, () => j.ctl.abort()).catch(
      (err): CopyResult => ({ kind: "failed", error: err }),
    );
    this.copyJob = { id: j.id, ctl: j.ctl, promise };
    return [async () => ({ type: "copy-result", job: j.id, result: await promise })];
  }

  private copyField: { job: number; field: "password" | "username" } = { job: 0, field: "password" };

  private onCopy(job: number, r: CopyResult): Cmd[] {
    if (this.copyJob?.id === job) this.copyJob = null;
    const m = this.main;
    if (!m || job !== this.latestCopy) {
      if (r.kind === "copied") r.cleared.catch(() => {});
      return [];
    }
    if (r.kind === "no-clipboard") {
      this.error(renderError(r.error));
      return [];
    }
    if (r.kind === "failed") {
      this.error(T("Not copied: %s", renderError(r.error)));
      return [];
    }
    const field = this.copyField.job === job ? this.copyField.field : "password";
    m.status = { k: "copy", job, field, clearAt: r.clearAt, clearing: false };
    return [
      async () => {
        try {
          const outcome = await r.cleared;
          return { type: "clear-done", job, outcome };
        } catch (e) {
          return { type: "clear-done", job, outcome: { error: e } };
        }
      },
    ];
  }

  private onClearDone(job: number, outcome: "cleared" | "superseded" | { error: unknown }): Cmd[] {
    const m = this.main;
    if (!m || job !== this.latestCopy || outcome === "superseded") return [];
    const showing = m.status?.k === "copy" && m.status.job === job;
    if (outcome === "cleared") {
      if (showing) this.setStatus(T("Clipboard cleared."));
    } else {
      this.setStatus(T("Clearing the clipboard failed: %s", renderError(outcome.error)), "error", true);
    }
    return [];
  }

  // -------------------------------------------------------------------------
  // Changes: refusals (§7.10)

  /** Refuses a change while busy or changed on disk; returns true when refused. */
  private refuseChange(): boolean {
    const m = this.main!;
    if (this.save) {
      this.error(T("Busy: wait for the save to finish."), false);
      return true;
    }
    if (this.reloadJob) {
      this.error(T("Busy: wait for the reload to finish."), false);
      return true;
    }
    if (m.banner) {
      this.error(T("The vault changed on disk: R reloads it. Changes are blocked until then."));
      return true;
    }
    return false;
  }

  private openAdd(): Cmd[] {
    const m = this.main!;
    if (this.refuseChange()) return [];
    let prefix = "";
    if (!m.detail) {
      const l = this.list();
      const f = folderOfRow(l.rows[this.cursorIndex(l)]);
      if (f) prefix = f + "/";
    } else {
      const e = this.selectedEntry();
      if (e) {
        const f = e.path.lastIndexOf("/");
        if (f >= 0) prefix = e.path.slice(0, f + 1);
      }
    }
    m.overlay = { kind: "prompt", prompt: { kind: "add", label: T("New entry's path: "), input: new LineInput(prefix), error: null } };
    return [];
  }

  private openEdit(): Cmd[] {
    const m = this.main!;
    if (this.refuseChange()) return [];
    const e = this.selectedEntry();
    if (!e) {
      this.setStatus(T("Select an entry first."));
      return [];
    }
    const form = new EntryForm({ title: T("edit %s", e.path), original: valuesOf(e), fieldKeys: e.fields.map((f) => f.key) });
    m.reveal = null;
    m.status = null;
    m.overlay = { kind: "form", form, ctx: { mode: "edit", path: e.path, entry: cloneEntry(e), extra: null } };
    return [];
  }

  private openTags(): Cmd[] {
    const m = this.main!;
    if (this.refuseChange()) return [];
    const e = this.selectedEntry();
    if (!e) {
      this.setStatus(T("Select an entry first."));
      return [];
    }
    m.overlay = { kind: "prompt", prompt: { kind: "tags", label: T("Tags (comma-separated): "), input: new LineInput(e.tags.join(", ")), error: null, entryId: e.id, path: e.path } };
    return [];
  }

  private openMove(): Cmd[] {
    const m = this.main!;
    if (this.refuseChange()) return [];
    const e = this.selectedEntry();
    if (!e) {
      this.setStatus(T("Select an entry first."));
      return [];
    }
    m.overlay = { kind: "prompt", prompt: { kind: "move", label: T("Move to: "), input: new LineInput(e.path), error: null, entryId: e.id, path: e.path } };
    return [];
  }

  private openDelete(): Cmd[] {
    const m = this.main!;
    if (this.refuseChange()) return [];
    const e = this.selectedEntry();
    if (!e) {
      this.setStatus(T("Select an entry first."));
      return [];
    }
    m.overlay = { kind: "confirm", confirm: { kind: "delete", entryId: e.id, path: e.path } };
    return [];
  }

  // -------------------------------------------------------------------------
  // Prompts (§3.2 step 5, §7.2–§7.5, §7.8)

  private promptInput(p: Prompt, msg: InputMsg): Cmd[] {
    const m = this.main!;
    if (msg.type === "paste") {
      const r = pasteOneLine(msg.bytes);
      if (!r.ok) {
        p.error = r.reason === "lines" ? T("Paste refused: one line only.") : T("Paste refused: the text isn't valid UTF-8.");
        return [];
      }
      p.input.insert(r.text);
      p.error = null;
      return [];
    }
    const k = msg;
    if (k.key === "esc" || k.key === "ctrl+c") {
      // Cancelled: the input is wiped; no message (the earlier one shows again, as in the
      // reference).
      p.input.wipe();
      m.overlay = null;
      return [];
    }
    if (k.key === "enter") return this.submitPrompt(p);
    if (k.key === "ctrl+j" || k.key === "ctrl+m") return [];
    if (p.input.handleKey(k) === "changed") p.error = null;
    return [];
  }

  private submitPrompt(p: Prompt): Cmd[] {
    const m = this.main!;
    const ix = indexOf(m.data);
    const text = p.input.value;
    switch (p.kind) {
      case "add": {
        let path: string;
        try {
          path = parsePath(text);
        } catch (e) {
          p.error = renderError(e);
          return [];
        }
        if (ix.sorted.some((e) => e.path === path)) {
          p.error = T("%s already exists: e edits it.", vpath(path));
          return [];
        }
        p.input.wipe();
        const form = new EntryForm({ title: T("add %s", path), original: emptyValues(), fieldKeys: [] });
        m.reveal = null;
        m.status = null;
        m.overlay = { kind: "form", form, ctx: { mode: "add", path, entry: null, extra: null } };
        return [];
      }
      case "move": {
        const e = ix.byId.get(p.entryId!);
        if (!e) {
          // SPEC-GAP (tui.md §8.2): a kept prompt whose entry was deleted on disk: the
          // entry's not-found error under the prompt.
          p.error = T("%s: not found", vpath(p.path ?? ""));
          return [];
        }
        let dst: string;
        try {
          dst = parsePath(text);
        } catch (err) {
          p.error = renderError(err);
          return [];
        }
        if (dst === e.path) {
          m.overlay = null;
          return [];
        }
        if (this.refuseChangeInPrompt(p)) return [];
        m.overlay = null;
        return this.startSave({ kind: "move", id: e.id, src: e.path, dst, prompt: p }, (s, sig) => s.move(e.id, dst, sig));
      }
      case "tags": {
        const e = ix.byId.get(p.entryId!);
        if (!e) {
          // SPEC-GAP (tui.md §8.2): a kept prompt whose entry was deleted on disk: the
          // entry's not-found error under the prompt.
          p.error = T("%s: not found", vpath(p.path ?? ""));
          return [];
        }
        let list: string[];
        try {
          list = parseTagList(text);
        } catch (err) {
          p.error = renderError(err);
          return [];
        }
        const add = list.filter((t) => !e.tags.includes(t));
        const remove = e.tags.filter((t) => !list.includes(t));
        if (add.length === 0 && remove.length === 0) {
          m.overlay = null;
          p.input.wipe();
          this.setStatus(T("No changes."));
          return [];
        }
        if (this.refuseChangeInPrompt(p)) return [];
        m.overlay = null;
        return this.startSave({ kind: "tags", id: e.id, path: e.path, prompt: p }, (s, sig) => s.tag(e.id, add, remove, sig));
      }
      case "print": {
        m.overlay = null;
        const ok = text === "PRINT";
        p.input.wipe();
        if (!ok) {
          this.setStatus(T("Not confirmed: the print page wasn't started."));
          return [];
        }
        return this.startPrint(p.print!.scope, p.print!.fields);
      }
    }
  }

  /** A kept prompt reopened after a reload may meet a new "changed" state: keep it again. */
  private refuseChangeInPrompt(p: Prompt): boolean {
    const m = this.main!;
    if (this.save) {
      p.error = T("Busy: wait for the save to finish.");
      return true;
    }
    if (this.reloadJob) {
      p.error = T("Busy: wait for the reload to finish.");
      return true;
    }
    if (m.banner) {
      m.overlay = null;
      m.kept = { kind: "prompt", prompt: p };
      this.error(T("Not saved: the vault changed on disk. R reloads it; your input is kept."));
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Confirm questions (§7.6, §9)

  private confirmInput(c: Confirm, msg: InputMsg): Cmd[] {
    const m = this.main!;
    const k = msg.type === "key" ? msg : null;
    if (c.kind === "delete") {
      m.overlay = null;
      if (k && (k.key === "y" || k.key === "Y")) {
        if (this.refuseChange()) return [];
        return this.startSave({ kind: "delete", id: c.entryId, path: c.path }, (s, sig) => s.remove(c.entryId, sig));
      }
      this.setStatus(T("Not deleted."));
      return [];
    }
    // the reload's rollback question
    if (k && k.key === "ctrl+c") return this.quit();
    m.overlay = null;
    const yes = !!k && (k.key === "y" || k.key === "Y");
    const j = this.reloadJob;
    if (!j) return [];
    this.setStatus(T("Reloading…"), "info", true);
    return [
      async () => {
        let result: ReloadResult;
        try {
          result = await c.answer(yes, j.ctl.signal);
        } catch (e) {
          result = { kind: "failed", error: e };
        }
        return { type: "reload-result", job: j.id, result };
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Form (§11, §7.2, §7.3)

  private formInput(form: EntryForm, ctx: FormCtx, msg: InputMsg): Cmd[] {
    const m = this.main!;
    const out = form.update(msg, this.clock.mono(), false);
    if (out.kind === "none") return [];
    if (out.kind === "cancel") {
      form.wipe();
      m.overlay = null;
      this.setStatus(out.question === "unsaved" ? T("Changes discarded.") : T("Cancelled."));
      return [];
    }
    // save
    if (this.save) {
      form.setMessage(T("Busy: wait for the save to finish."), "error");
      return [];
    }
    if (this.reloadJob) {
      form.setMessage(T("Busy: wait for the reload to finish."), "error");
      return [];
    }
    form.hide();
    form.message = null;
    m.overlay = null;
    if (m.banner) {
      // Saving is refused while the file changed on disk: keep the input (§8.2).
      m.kept = { kind: "form", form, ctx };
      this.error(T("Not saved: the vault changed on disk. R reloads it; your input is kept."));
      return [];
    }
    const values = out.values;
    if (ctx.mode === "add") return this.startSave({ kind: "add", path: ctx.path, form, ctx }, (s, sig) => s.add(ctx.path, values, ctx.extra, sig));
    const id = ctx.entry!.id;
    return this.startSave({ kind: "edit", id, path: ctx.path, form, ctx }, (s, sig) => s.edit(id, values, sig));
  }

  // -------------------------------------------------------------------------
  // Saves (§7.7)

  private startSave(op: SaveOp, run: (s: VaultSession, signal: AbortSignal) => Promise<SaveResult>): Cmd[] {
    const j = this.job();
    this.saveGen++;
    const session = this.session!;
    const promise = (async () => {
      try {
        return await run(session, j.ctl.signal);
      } catch (e) {
        return { kind: "failed", error: e } as SaveResult;
      }
    })();
    this.save = { id: j.id, ctl: j.ctl, op, promise };
    this.setStatus(T("Saving…"), "info", true);
    return [async () => ({ type: "save-result", job: j.id, result: await promise })];
  }

  private onSave(job: number, r: SaveResult): Cmd[] {
    const s = this.save;
    if (!s || s.id !== job) return [];
    this.save = null;
    this.saveGen++;
    const m = this.main;
    if (!m) return [];
    const op = s.op;
    switch (r.kind) {
      case "saved": {
        m.data = r.data;
        this.afterDataChange();
        if (op.kind === "delete") {
          if (m.detail?.id === op.id) {
            m.detail = null;
            m.reveal = null;
          }
        } else this.cursorTo(r.id);
        if (op.kind === "add" || op.kind === "edit") op.form.wipe();
        if (op.kind === "move" || op.kind === "tags") op.prompt.input.wipe();
        this.setStatus(saveMessage(op), "info", false, r.warnings);
        return [];
      }
      case "unchanged":
        if (op.kind === "add" || op.kind === "edit") op.form.wipe();
        this.setStatus(T("No changes."));
        return [];
      case "changed":
        m.banner = true;
        if (op.kind === "delete") {
          this.error(T("Not deleted: the vault changed on disk. R reloads it; then delete again."));
          return [];
        }
        m.kept = op.kind === "add" || op.kind === "edit" ? { kind: "form", form: op.form, ctx: op.ctx } : { kind: "prompt", prompt: op.prompt };
        this.error(T("Not saved: the vault changed on disk. R reloads it; your input is kept."));
        return [];
      case "cancelled":
        return [];
      case "failed": {
        const err = renderError(r.error);
        if (op.kind === "add" || op.kind === "edit") {
          m.status = null;
          op.form.setMessage(T("Not saved: %s", err), "error");
          if (!m.overlay) m.overlay = { kind: "form", form: op.form, ctx: op.ctx };
          return [];
        }
        if (op.kind === "move" || op.kind === "tags") {
          m.status = null;
          op.prompt.error = err;
          if (!m.overlay) m.overlay = { kind: "prompt", prompt: op.prompt };
          return [];
        }
        this.error(T("Not deleted: %s", err));
        return [];
      }
    }
  }

  /** After a save the cursor goes to the saved entry, opening its folders (§5.5). */
  private cursorTo(id: string): void {
    const m = this.main!;
    const e = indexOf(m.data).byId.get(id);
    if (!e) return;
    if (m.view === "folders" && !m.search) for (const f of foldersOf(e.path)) m.expanded.add(f);
    const name = m.search ? "search" : m.view;
    m.cursors[name] = { key: "e:" + id, index: m.cursors[name].index };
    if (m.view === "folders" && m.search) {
      for (const f of foldersOf(e.path)) m.expanded.add(f);
      m.cursors.folders = { key: "e:" + id, index: m.cursors.folders.index };
    }
  }

  /** Data replaced: drop selected tags that are gone, resolve cursors (§5.3, §5.5). */
  private afterDataChange(): void {
    const m = this.main!;
    const ix = indexOf(m.data);
    const tags = new Set<string>();
    for (const e of ix.sorted) for (const t of e.tags) tags.add(t);
    m.tagSel = m.tagSel.filter((t) => tags.has(t));
    for (const f of [...m.expanded]) if (!ix.folders.has(f)) m.expanded.delete(f);
    if (m.detail && !ix.byId.has(m.detail.id)) m.detail = null;
    if (m.reveal && !ix.byId.has(m.reveal.id)) m.reveal = null;
  }

  // -------------------------------------------------------------------------
  // Changed on disk and reload (§8)

  private startCheck(): Cmd[] {
    const id = ++this.seq;
    this.checkJob = id;
    this.lastCheck = this.clock.mono();
    const session = this.session!;
    const gen = this.saveGen;
    const ctl = new AbortController();
    return [
      async () => {
        try {
          const changed = await session.checkChanged(ctl.signal);
          if (gen !== this.saveGen) return { type: "check-result", job: id };
          return { type: "check-result", job: id, changed };
        } catch (e) {
          return { type: "check-result", job: id, error: e };
        }
      },
    ];
  }

  private onCheck(job: number, changed: boolean | undefined, error: unknown): Cmd[] {
    if (job !== this.checkJob) return [];
    this.checkJob = null;
    this.lastCheck = this.clock.mono();
    const m = this.main;
    if (!m) return [];
    if (error !== undefined) {
      if (!m.checkFailedShown) {
        m.checkFailedShown = true;
        this.setStatus(T("Checking the vault file failed: %s", renderError(error)), "error", false);
      }
      return [];
    }
    m.checkFailedShown = false;
    if (changed) m.banner = true;
    return [];
  }

  private startReload(): Cmd[] {
    if (this.save) {
      this.error(T("Busy: wait for the save to finish."), false);
      return [];
    }
    if (this.reloadJob) {
      this.error(T("Busy: wait for the reload to finish."), false);
      return [];
    }
    const j = this.job();
    this.reloadJob = j;
    this.checkJob = null;
    this.setStatus(T("Reloading…"), "info", true);
    const session = this.session!;
    return [
      async () => {
        let result: ReloadResult;
        try {
          result = await session.reload(j.ctl.signal);
        } catch (e) {
          result = { kind: "failed", error: e };
        }
        return { type: "reload-result", job: j.id, result };
      },
    ];
  }

  isReloading(): boolean {
    return this.reloadJob !== null;
  }

  isSaving(): boolean {
    return this.save !== null;
  }

  private onReload(job: number, r: ReloadResult): Cmd[] {
    if (!this.reloadJob || this.reloadJob.id !== job) return [];
    const m = this.main;
    if (!m) return [];
    switch (r.kind) {
      case "rollback":
        m.overlay = { kind: "confirm", confirm: { kind: "rollback", warning: r.warning, answer: r.answer } };
        m.status = null;
        return [];
      case "rekeyed":
        this.reloadJob = null;
        this.error(T("Reload failed: the vault was rekeyed elsewhere: lock (L) and unlock with its current passphrase"));
        return [];
      case "failed":
        this.reloadJob = null;
        this.error(T("Reload failed: %s", renderError(r.error)));
        return [];
      case "reloaded": {
        this.reloadJob = null;
        m.data = r.data;
        m.banner = false;
        m.checkFailedShown = false;
        this.lastCheck = this.clock.mono();
        this.afterDataChange();
        const n = r.data.entries.length;
        this.setStatus(TN(n, "Reloaded: revision %d, %d entry.", "Reloaded: revision %d, %d entries.", r.data.revision, n), "info", false, r.warnings);
        this.restoreKept();
        return [];
      }
    }
  }

  /** After a successful reload the kept input comes back (§8.2). */
  private restoreKept(): void {
    const m = this.main!;
    const kept = m.kept;
    m.kept = null;
    if (!kept) return;
    if (m.overlay) {
      // something else is open (shouldn't happen): drop the kept input
      if (kept.kind === "form") kept.form.wipe();
      else kept.prompt.input.wipe();
      return;
    }
    if (kept.kind === "prompt") {
      m.overlay = { kind: "prompt", prompt: kept.prompt };
      return;
    }
    const { form, ctx } = kept;
    // the form's own message says what happened
    m.status = null;
    const back = T("Reloaded: your input is back; ctrl+s saves it.");
    if (ctx.mode === "add") {
      m.overlay = { kind: "form", form, ctx };
      // SPEC-GAP (audit #17): shown in the normal style (the proposed fix), not as an error.
      form.setMessage(back, "info");
      return;
    }
    const old = ctx.entry!;
    const now = indexOf(m.data).byId.get(old.id);
    if (now && sameEntry(now, old)) {
      m.overlay = { kind: "form", form, ctx };
      form.setMessage(back, "info");
      return;
    }
    const user = form.values();
    if (!now) {
      // deleted on disk: an add form with the user's values
      const nf = new EntryForm({
        title: T("add %s (not saved yet)", old.path),
        original: emptyValues(),
        initial: user,
        recreated: true,
        fieldKeys: old.fields.map((f) => f.key),
      });
      form.wipe();
      m.overlay = { kind: "form", form: nf, ctx: { mode: "add", path: old.path, entry: null, extra: { fields: old.fields, unknown: old.unknown } } };
      nf.setMessage(T("%s was deleted on disk: saving adds it again.", vpath(old.path)), "info");
      return;
    }
    // changed on disk: the user's changed values over the reloaded entry
    const fresh = formText(valuesOf(now));
    const merged: FormText = { ...fresh };
    for (const f of ["password", "username", "url", "tags", "notes"] as const) if (form.fieldChanged(f)) merged[f] = user[f];
    const nf = new EntryForm({ title: T("edit %s (not saved yet)", now.path), original: valuesOf(now), initial: merged, recreated: true, fieldKeys: now.fields.map((f) => f.key) });
    form.wipe();
    m.overlay = { kind: "form", form: nf, ctx: { mode: "edit", path: now.path, entry: cloneEntry(now), extra: null } };
    nf.setMessage(T("Reloaded: your input is back; ctrl+s saves it. It changed on disk too; the other values are the new ones."), "info");
  }

  // -------------------------------------------------------------------------
  // Print setup, prompt and dialog (§7.8, §7.9)

  private openPrintSetup(): Cmd[] {
    const m = this.main!;
    if (!this.backend.config.printWebEnabled) {
      this.error(T("The print page is off: set enabled = true in the [print_web] table of the config file (print_web.enabled)."));
      return [];
    }
    if (this.save) {
      this.error(T("Busy: wait for the save to finish."), false);
      return [];
    }
    if (this.reloadJob) {
      this.error(T("Busy: wait for the reload to finish."), false);
      return [];
    }
    if (this.printJob) {
      this.error(T("Busy: wait for the print page to start."), false);
      return [];
    }
    const ix = indexOf(m.data);
    const scopes: PrintSetup["scopes"] = [];
    const all = ix.sorted.length;
    scopes.push({ scope: { kind: "all" }, label: TN(all, "all entries (%d entry)", "all entries (%d entries)", all), count: all });
    let def = 0;
    const l = this.list();
    const row = m.detail ? undefined : l.rows[this.cursorIndex(l)];
    let folder = folderOfRow(row);
    if (m.detail) {
      const e = this.selectedEntry();
      if (e && e.path.includes("/")) folder = e.path.slice(0, e.path.lastIndexOf("/"));
    }
    if (folder) {
      const n = countIn(ix, folder);
      scopes.push({ scope: { kind: "folder", folder }, label: TN(n, "folder %s/ (%d entry)", "folder %s/ (%d entries)", vpath(folder), n), count: n });
      if (m.view === "folders") def = scopes.length - 1;
    }
    if (m.tagSel.length > 0) {
      const tags = [...m.tagSel].sort();
      const n = countWithTags(ix, tags);
      scopes.push({ scope: { kind: "tags", tags }, label: TN(n, "tags %s (%d entry)", "tags %s (%d entries)", tags.map(vpath).join(" + "), n), count: n });
      if (m.view === "tags") def = scopes.length - 1;
    }
    m.reveal = null;
    m.overlay = { kind: "print-setup", setup: { scopes, scope: def, fields: { password: true, username: true, url: true, fields: false }, cursor: def } };
    return [];
  }

  private setupInput(s: PrintSetup, msg: InputMsg): Cmd[] {
    const m = this.main!;
    if (msg.type !== "key") return [];
    const n = s.scopes.length + 4;
    switch (msg.key) {
      case "up":
      case "k":
        s.cursor = Math.max(0, s.cursor - 1);
        return [];
      case "down":
      case "j":
      case "tab":
        s.cursor = Math.min(n - 1, s.cursor + 1);
        return [];
      case "home":
      case "g":
        s.cursor = 0;
        return [];
      case "end":
      case "G":
        s.cursor = n - 1;
        return [];
      case "space":
      case "x": {
        if (s.cursor < s.scopes.length) s.scope = s.cursor;
        else {
          const f = (["password", "username", "url", "fields"] as const)[s.cursor - s.scopes.length]!;
          s.fields[f] = !s.fields[f];
        }
        return [];
      }
      case "esc":
      case "ctrl+c":
        m.overlay = null;
        this.setStatus(T("Print page cancelled."));
        return [];
      case "enter": {
        const fields = (["password", "username", "url", "fields"] as const).filter((f) => s.fields[f]);
        if (fields.length === 0) {
          this.error(T("Choose at least one field."), false);
          return [];
        }
        const sc = s.scopes[s.scope]!;
        if (sc.count === 0) {
          this.error(T("No entries to print there: choose another."), false);
          return [];
        }
        m.status = null;
        m.overlay = { kind: "prompt", prompt: { kind: "print", label: T("Type PRINT to start the print page: "), input: new LineInput(""), error: null, print: { scope: sc.scope, fields } } };
        return [];
      }
    }
    return [];
  }

  private startPrint(scope: PrintScope, fields: string[]): Cmd[] {
    const m = this.main!;
    const j = this.job();
    this.printJob = j;
    this.setStatus(T("Starting the print page…"), "info", true);
    const data = structuredClone(m.data);
    return [
      async () => {
        try {
          const page = await this.backend.startPrintPage({ scope, fields, data }, j.ctl.signal);
          return { type: "print-started", job: j.id, page };
        } catch (e) {
          return { type: "print-started", job: j.id, error: e };
        }
      },
    ];
  }

  private onPrintStarted(job: number, page: PrintPage | undefined, error: unknown): Cmd[] {
    // a page that started after its job was cancelled (a lock) is stopped at once
    const stop = (): Cmd[] => (page ? [async () => void (await page.stop().catch(() => {}))] : []);
    if (!this.printJob || this.printJob.id !== job) return stop();
    this.printJob = null;
    const m = this.main;
    if (!m) return stop();
    if (!page) {
      this.error(T("Print page: %s", renderError(error)));
      return [];
    }
    this.printPage = page;
    m.status = null;
    if (m.overlay?.kind === "form" || m.overlay?.kind === "prompt") {
      // leave the input alone; the dialog takes over
    }
    m.overlay = { kind: "print-dialog", dialog: { page, url: 0, scroll: 0, note: null, stopping: false, stopped: null } };
    return [];
  }

  private dialogInput(d: PrintDialog, msg: InputMsg): Cmd[] {
    const m = this.main!;
    if (msg.type !== "key") return [];
    if (d.stopped) {
      // any key closes
      m.overlay = null;
      this.printPage = null;
      this.setStatus(T("Print page: %s.", d.stopped.outcome), d.stopped.served ? "info" : "warn");
      return [];
    }
    const n = d.page.urls.length;
    switch (msg.key) {
      case "c": {
        const url = d.page.urls[d.url];
        if (!url) return [];
        const j = this.job();
        return [
          async () => {
            let result: CopyResult;
            try {
              result = await withTimeout(this.backend.copy(url, "url", "", j.ctl.signal), COPY_BOUND_MS, () => j.ctl.abort());
            } catch (e) {
              result = { kind: "failed", error: e };
            }
            return { type: "url-copied", job: j.id, result };
          },
        ];
      }
      case "tab":
      case "n":
        if (n > 0) d.url = (d.url + 1) % n;
        d.scroll = 0;
        return [];
      case "shift+tab":
      case "p":
        if (n > 0) d.url = (d.url - 1 + n) % n;
        d.scroll = 0;
        return [];
      case "up":
      case "k":
        d.scroll = Math.max(0, d.scroll - 1);
        return [];
      case "down":
      case "j":
        d.scroll++;
        return [];
      case "pgup":
        d.scroll = Math.max(0, d.scroll - 10);
        return [];
      case "pgdown":
      case "space":
        d.scroll += 10;
        return [];
      case "home":
      case "g":
        d.scroll = 0;
        return [];
      case "esc":
      case "ctrl+c": {
        if (d.stopping) return [];
        d.stopping = true;
        const j = this.job();
        this.printJob = null;
        const page = d.page;
        this.dialogStopJob = j.id;
        return [
          async () => {
            try {
              await page.stop();
            } catch {}
            return { type: "print-stopped", job: j.id };
          },
        ];
      }
    }
    return [];
  }

  private dialogStopJob = 0;

  private onUrlCopied(_job: number, r: CopyResult): Cmd[] {
    const m = this.main;
    if (!m || m.overlay?.kind !== "print-dialog") {
      if (r.kind === "copied") r.cleared.catch(() => {});
      return [];
    }
    const d = m.overlay.dialog;
    if (r.kind === "copied") {
      r.cleared.catch(() => {});
      d.note = T("URL copied · the clipboard clears in %s.", sentenceDuration(this.backend.config.clearAfterMs));
    } else d.note = r.kind === "no-clipboard" ? renderError(r.error) : T("Not copied: %s", renderError(r.error));
    return [];
  }

  /** The server's state, checked every second (§7.9): an in-memory query, no I/O. */
  private pollPrint(d: PrintDialog): void {
    if (d.stopped || d.stopping) return;
    const st = d.page.state();
    if (!st.running) d.stopped = { served: st.served, outcome: st.outcome };
  }

  private onPrintStopped(job: number): Cmd[] {
    if (job !== this.dialogStopJob) return [];
    const m = this.main;
    if (!m || m.overlay?.kind !== "print-dialog") return [];
    const d = m.overlay.dialog;
    const st = d.page.state();
    m.overlay = null;
    this.printPage = null;
    if (!st.running) this.setStatus(T("Print page: %s.", st.outcome), st.served ? "info" : "warn");
    else this.setStatus(T("Print page stopped."));
    return [];
  }

  // -------------------------------------------------------------------------
  // Ticks (§2, §8.1, §10.1)

  private tick(): Cmd[] {
    const now = this.clock.mono();
    if (this.screen !== "main" || !this.main) return [];
    const m = this.main;
    // Idle lock: monotonic and wall-clock differences, the larger counts (SPEC-GAP, audit #1:
    // the proposed fix, so time while the machine sleeps counts as in the agent).
    if (this.idleElapsed() >= this.backend.config.idleTtlMs) return this.startLock("idle");
    if (m.reveal && now >= m.reveal.until) m.reveal = null;
    if (m.overlay?.kind === "form") m.overlay.form.tick(now);
    const st = m.status;
    if (st?.k === "msg" && !st.sticky && now - st.since >= STATUS_MS) m.status = null;
    if (st?.k === "copy" && !st.clearing && this.clock.wall() >= st.clearAt) st.clearing = true;
    const cmds: Cmd[] = [];
    if (!m.banner && !this.save && !this.reloadJob && this.checkJob === null && now - this.lastCheck >= POLL_MS - 50) cmds.push(...this.startCheck());
    if (m.overlay?.kind === "print-dialog") this.pollPrint(m.overlay.dialog);
    return cmds;
  }

  /** Time since the last key, as the larger of the monotonic and wall-clock differences. */
  idleElapsed(): number {
    const mono = this.clock.mono() - this.lastKey.mono;
    const wall = this.clock.wall() - this.lastKey.wall;
    return Math.max(mono, wall);
  }

  idleLeft(): number {
    return Math.max(0, this.backend.config.idleTtlMs - this.idleElapsed());
  }

  // -------------------------------------------------------------------------
  // Locking and quitting (§10, §1.2)

  private quit(): Cmd[] {
    return this.startLock("exit");
  }

  private onSignal(sig: SignalName): Cmd[] {
    if (this.lockJob) {
      // a lock is running: it ends the TUI by the signal
      this.lockJob.reason = "signal";
      this.lockJob.sig = sig;
      return [];
    }
    if (this.screen === "main" || this.lock.rollback) {
      if (this.lock.rollback) {
        // a pending rollback question is dropped unanswered
        this.session = this.lock.rollback.session;
        this.lock.rollback = null;
      }
      return this.startLock("signal", sig);
    }
    if (this.unlockJob) {
      // an unlock is running: abandon it; a key that arrives later is closed in onUnlock
      this.unlockJob.ctl.abort();
      this.unlockJob = null;
    }
    this.finish({ code: 128 + sigNum(sig), error: signalError(sig), lines: [], waitClear: false, signal: sig });
    return [];
  }

  /**
   * Starts a lock (§10.2): the UI's data and input are wiped at once, running jobs are
   * cancelled, the lock screen shows "locking…"; the rest runs in the background.
   */
  startLock(reason: "key" | "idle" | "exit" | "signal", sig?: SignalName): Cmd[] {
    const m = this.main;
    const session = this.session;
    const save = this.save;
    const copy = this.copyJob;
    const page = this.printPage;
    // wipe
    if (m) wipeMain(m);
    this.main = null;
    this.session = null;
    this.printPage = null;
    this.unlockJob?.ctl.abort();
    this.unlockJob = null;
    this.reloadJob?.ctl.abort();
    this.reloadJob = null;
    this.printJob?.ctl.abort();
    this.printJob = null;
    this.checkJob = null;
    save?.ctl.abort();
    this.save = null;
    this.latestCopy = 0;
    this.lock.input.wipe();
    this.lock = newLockScreen();
    this.lock.mode = "busy";
    this.lock.busy = save ? T("locking: the change to %s is still being saved…", vpath(opPath(save.op))) : T("locking…");
    this.screen = "lock";
    const j = this.job();
    this.lockJob = { id: j.id, reason, sig };
    const backend = this.backend;
    const clear = reason !== "exit";
    return [
      async () => {
        const report: LockReport = { saveReport: null, saveOk: true, cleared: false, clearError: undefined, agentStopped: false, agentError: undefined };
        const pStop = page ? page.stop().catch(() => {}) : Promise.resolve();
        if (save) {
          const r = await save.promise;
          report.saveReport = lockSaveReport(save.op, r);
          report.saveOk = r.kind === "saved" || r.kind === "unchanged";
        }
        if (copy) await copy.promise.catch(() => {});
        try {
          session?.close();
        } catch {}
        await pStop;
        const ctl = new AbortController();
        const work = (async () => {
          // the lock job's own reason may have turned into a signal meanwhile
          const lj = this.lockJob;
          const doClear = clear || (lj?.id === j.id && lj.reason === "signal");
          if (doClear) {
            try {
              report.cleared = await backend.clearNow(ctl.signal);
            } catch (e) {
              report.clearError = e;
            }
          }
          if (backend.config.stopAgent) {
            try {
              report.agentStopped = await backend.stopAgent(ctl.signal);
            } catch (e) {
              report.agentError = e;
            }
          }
        })();
        const timedOut = await raceTimer(work.then(() => false), LOCK_BOUND_MS, true);
        if (timedOut) {
          ctl.abort();
          const err = new Error(T("timed out after %s", "5s"));
          if (!report.cleared && report.clearError === undefined && clear) report.clearError = err;
          else if (backend.config.stopAgent && !report.agentStopped && report.agentError === undefined) report.agentError = err;
        }
        return { type: "lock-done", job: j.id, report };
      },
    ];
  }

  private onLockDone(job: number, r: LockReport): Cmd[] {
    const lj = this.lockJob;
    if (!lj || lj.id !== job) return [];
    this.lockJob = null;
    const L = this.lock;
    if (lj.reason === "exit" || lj.reason === "exit-after" || lj.reason === "signal") {
      const lines: string[] = [];
      if (r.saveReport) lines.push(r.saveReport);
      if (r.clearError !== undefined) lines.push(T("Clearing the clipboard failed: %s", renderError(r.clearError)));
      if (r.agentError !== undefined) lines.push(T("Stopping the agent failed: %s", renderError(r.agentError)));
      if (lj.reason === "signal") this.finish({ code: 128 + sigNum(lj.sig!), error: signalError(lj.sig!), lines, waitClear: false, signal: lj.sig });
      else this.finish({ code: 0, lines, waitClear: true });
      return [];
    }
    L.mode = "field";
    L.afterLock = true;
    const msgs: LockScreen["messages"] = [];
    if (r.saveReport) msgs.push({ text: r.saveReport, style: r.saveOk ? "info" : "error" });
    msgs.push({
      text: lj.reason === "idle" ? T("Locked after %s without input.", sentenceDuration(this.backend.config.idleTtlMs)) : T("Locked."),
      style: "info",
    });
    if (r.cleared) msgs.push({ text: T("Clipboard cleared."), style: "info" });
    if (r.agentStopped) msgs.push({ text: T("Agent stopped."), style: "info" });
    if (r.clearError !== undefined) msgs.push({ text: T("Clearing the clipboard failed: %s.", renderError(r.clearError)), style: "error" });
    if (r.agentError !== undefined) msgs.push({ text: T("Stopping the agent failed: %s.", renderError(r.agentError)), style: "error" });
    // One message (§10.2), its sentences joined as the reference shows them; the error style
    // if any part failed.
    L.messages = [{ text: msgs.map((x) => x.text).join(" "), style: msgs.some((x) => x.style === "error") ? "error" : "info" }];
    // The agent hint (§4.2): is an agent still running?
    const id = ++this.seq;
    this.seqAgentStatus = id;
    const backend = this.backend;
    return [
      async () => {
        const ctl = new AbortController();
        let running = false;
        try {
          running = await raceTimer(backend.agentRunning(ctl.signal), AGENT_CHECK_MS, false);
        } catch {
          running = false;
        }
        ctl.abort();
        return { type: "agent-status", job: id, running };
      },
    ];
  }

  private finish(plan: ExitPlan): void {
    this.exit = plan;
    this.screen = "bye";
    this.main = null;
    this.lock.input.wipe();
  }

  /** Whether a lock job is running. */
  locking(): boolean {
    return this.lockJob !== null;
  }
}

type LockReason = "key" | "idle" | "exit" | "signal" | "exit-after";

// ---------------------------------------------------------------------------
// helpers

function newLockScreen(): LockScreen {
  return { mode: "field", input: new LineInput("", true), busy: "", messages: [], agentHint: false, afterLock: false, rollback: null };
}

function wipeMain(m: Main): void {
  const ov = m.overlay;
  if (ov?.kind === "form") ov.form.wipe();
  if (ov?.kind === "prompt") ov.prompt.input.wipe();
  if (m.kept?.kind === "form") m.kept.form.wipe();
  if (m.kept?.kind === "prompt") m.kept.prompt.input.wipe();
  m.search?.query.wipe();
  m.overlay = null;
  m.kept = null;
  m.search = null;
  m.reveal = null;
  m.detail = null;
  m.status = null;
  m.expanded.clear();
  m.tagSel = [];
  m.data = { ...m.data, entries: [], deleted: [] };
}

/** Escaped path for messages (S4 single-line). */
function vpath(p: string): string {
  return escapeLine(p);
}

export function valuesOf(e: Entry): EntryValues {
  return { password: e.password, username: e.username, url: e.url, tags: [...e.tags], notes: e.notes };
}

function emptyValues(): EntryValues {
  return { password: "", username: "", url: "", tags: [], notes: "" };
}

function opPath(op: SaveOp): string {
  return op.kind === "move" ? op.src : op.path;
}

function saveMessage(op: SaveOp): string {
  switch (op.kind) {
    case "add":
      return T("Added %s.", vpath(op.path));
    case "edit":
      return T("Saved %s.", vpath(op.path));
    case "move":
      return T("Moved %s to %s.", vpath(op.src), vpath(op.dst));
    case "tags":
      return T("Tags of %s saved.", vpath(op.path));
    case "delete":
      return T("Deleted %s.", vpath(op.path));
  }
}

/** The report of a save that was running at a lock (§7.7). */
function lockSaveReport(op: SaveOp, r: SaveResult): string {
  const p = vpath(opPath(op));
  switch (r.kind) {
    case "saved":
      return saveMessage(op);
    case "unchanged":
      return T("No changes.");
    case "cancelled":
      return T("Not saved (%s): the lock came before it was written.", p);
    case "changed":
      return T("Not saved (%s): the vault changed on disk.", p);
    case "failed":
      return T("Not saved (%s): %s", p, renderError(r.error));
  }
}

/**
 * A duration in a sentence (tui.md §2, informative): whole hours `N h`, whole minutes
 * `N min`, else Go's form rounded to seconds (`1m30s`, `30s`).
 */
export function sentenceDuration(ms: number): string {
  const secs = Math.round(ms / 1000);
  const d = BigInt(secs) * SEC;
  if (secs > 0 && d % HOUR === 0n) return T("%d h", Number(d / HOUR));
  if (secs > 0 && d % MIN === 0n) return T("%d min", Number(d / MIN));
  return formatGoDuration(d);
}

function sigNum(sig: SignalName): number {
  return sig === "SIGHUP" ? 1 : sig === "SIGINT" ? 2 : 15;
}

function signalError(sig: SignalName): SignalError {
  const name = sig === "SIGHUP" ? "hangup" : sig === "SIGINT" ? "interrupt" : "terminated";
  return new SignalError(sig, "locked and stopped: received %s", name);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolves with p's value, or with `fallback` after ms; the timer is cleared either way. */
export function raceTimer<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p.finally(() => clearTimeout(t)), new Promise<T>((r) => (t = setTimeout(() => r(fallback), ms)))]);
}

/** Races a promise against a timeout; on timeout `onTimeout` runs and the promise rejects. */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => {
      t = setTimeout(() => {
        onTimeout();
        rej(new Error(T("timed out after %s", formatGoDuration(BigInt(ms) * 1_000_000n))));
      }, ms);
    }),
  ]);
}
