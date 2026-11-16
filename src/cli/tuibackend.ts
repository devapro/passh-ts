// The real TuiBackend (src/tui/backend.ts) over the vault, the agent, the clipboard and the
// print page: what `passh` with no arguments runs (tui.md; spec §5.1–§5.3, §6.3, §7.4).
//
// Unlocking (tui.md §4.2): the agent of the vault (a key request for the current key block),
// or the typed passphrase, which unwraps the key block exactly once. The outcomes are sorted
// into the kinds of tui.md §4.4. The rollback question of storage.md §7.4 is asked by the
// TUI: openVault's confirmOlder waits until the TUI answers.

import { readFileSync } from "node:fs";
import type { X25519Identity } from "../age/index.ts";
import { agentKey, agentStatus, stopAgentAndWait } from "../agent/index.ts";
import { chooseClipboard, Clipboard, NoClipboardError, type ClipboardMethod } from "../clipboard/index.ts";
import { realPath as resolveRealPath, stateDir, tildePath, type Config, type Env } from "../config/index.ts";
import { hasCode, renderError } from "../i18n/index.ts";
import { KeyErrorCode, unwrapKeyBlock } from "../keys/index.ts";
import { addEntry, cloneUnknowns, editEntry, editTags, findEntryById, moveEntry, removeEntry, type ChangeResult } from "../model/index.ts";
import type { VaultData } from "../model/types.ts";
import { buildPasswordSheet, parseFields, printWebSettings } from "../print/index.ts";
import { startPrintPage as startServer, type PrintPage as ServerPage } from "../printweb/index.ts";
import type { Tty } from "../tty/tty.ts";
import { nsToMs } from "../util/duration.ts";
import type { CommandIO } from "../util/io.ts";
import { errRollbackDeclined, VaultErrorCode } from "../vault/errors.ts";
import { identityKeySource } from "../vault/keysources.ts";
import { openVault } from "../vault/open.ts";
import { parseContainer } from "../vaultfile/index.ts";
import type { KeyRequest, KeySource, OpenedVault } from "../vault/types.ts";
import type {
  AddExtra,
  CopyResult,
  EntryValues,
  PendingClear,
  PrintPage,
  PrintRequest,
  PrintState,
  ReloadResult,
  RollbackQuestion,
  SaveResult,
  TuiBackend,
  TuiConfig,
  UnlockResult,
  VaultSession,
} from "../tui/backend.ts";

export interface TuiBackendOptions {
  /** /dev/tty, for OSC 52 (null: no terminal, so no OSC 52). */
  tty: Tty | null;
  /** The environment (state folder, agent socket, `~`); default process.env. */
  env?: Env;
}

/**
 * Warnings of the vault layer (ignored text around the blocks, the rollback record, old
 * backups) collected for the TUI's next status message ("Warning: …", tui.md §4.4).
 */
class CollectIO implements CommandIO {
  private items: string[] = [];
  private seen = new Set<string>();
  stdout(): void {}
  status(): void {}
  note(t: string): void {
    this.items.push(t);
  }
  warn(t: string): void {
    this.items.push(t);
  }
  warnOnce(t: string): void {
    if (this.seen.has(t)) return;
    this.seen.add(t);
    this.items.push(t);
  }
  stdoutIsTerminal(): boolean {
    return false;
  }
  stderrIsTerminal(): boolean {
    return false;
  }
  /** The warnings since the last drain. */
  drain(): string[] {
    const out = this.items;
    this.items = [];
    return out;
  }
}

/** A rollback question asked by openVault and answered later by the TUI. */
interface Asked {
  text: string;
  answer(yes: boolean): void;
}

/**
 * Runs an open whose rollback question (confirmOlder) the TUI answers: resolves with the
 * opened vault, the open's error, or the question (the open then waits for `answer`).
 */
function openWithQuestion(
  run: (confirmOlder: (text: string) => Promise<boolean>) => Promise<OpenedVault>,
): { first: Promise<{ vault: OpenedVault } | { error: unknown } | { asked: Asked }>; opening: Promise<OpenedVault> } {
  let onAsk!: (a: Asked) => void;
  const asked = new Promise<Asked>((r) => (onAsk = r));
  const confirmOlder = (text: string) =>
    new Promise<boolean>((resolve) => {
      let done = false;
      onAsk({
        text,
        answer: (yes) => {
          if (done) return;
          done = true;
          resolve(yes);
        },
      });
    });
  const opening = run(confirmOlder);
  opening.catch(() => {});
  const first = Promise.race([
    opening.then(
      (vault) => ({ vault }),
      (error: unknown) => ({ error }),
    ),
    asked.then((a) => ({ asked: a })),
  ]);
  return { first, opening };
}

/** Sorts a failed open into the kinds of tui.md §4.4. */
function failedOpen(e: unknown): UnlockResult {
  if (hasCode(e, KeyErrorCode.WrongPassphrase) || hasCode(e, KeyErrorCode.BadKeyBlock) || hasCode(e, KeyErrorCode.EmptyPassphrase)) return { kind: "wrong-passphrase" };
  if (hasCode(e, KeyErrorCode.WorkFactor)) return { kind: "work-factor", error: e };
  if (hasCode(e, VaultErrorCode.DataDamaged) || hasCode(e, KeyErrorCode.DataNotToKey) || hasCode(e, KeyErrorCode.DataDamaged)) return { kind: "damaged", error: e };
  return { kind: "error", error: e };
}

function isAbort(e: unknown): boolean {
  return (e instanceof DOMException && e.name === "AbortError") || (e instanceof Error && e.name === "AbortError");
}

export class RealTuiBackend implements TuiBackend {
  readonly config: TuiConfig;
  readonly vaultDisplay: string;
  readonly env: Env;
  private readonly clipboard: Clipboard | null = null;
  private readonly clipboardError: unknown = null;

  constructor(
    readonly cfg: Config,
    opts: TuiBackendOptions,
  ) {
    this.env = opts.env ?? process.env;
    this.config = {
      idleTtlMs: nsToMs(cfg.session.idleTTL),
      stopAgent: cfg.session.stopAgent,
      clearAfterMs: nsToMs(cfg.clipboard.clearAfter),
      printWebEnabled: cfg.printWeb.enabled,
    };
    this.vaultDisplay = tildePath(cfg.vault, this.env);
    // The clipboard method is chosen once (agent-session.md §A5); a failure is reported at
    // each copy (tui.md §7.1: a sticky error with the hint).
    try {
      const method: ClipboardMethod = chooseClipboard({ command: cfg.clipboard.command, osc52: cfg.clipboard.osc52 }, opts.tty);
      this.clipboard = new Clipboard(method, this.config.clearAfterMs);
    } catch (e) {
      this.clipboardError = e;
    }
  }

  /** The vault's real path (the agent socket is named by it); undefined if it can't be resolved. */
  private realPath(): string | undefined {
    try {
      return resolveRealPath(this.cfg.vault, { env: this.env });
    } catch {
      return undefined;
    }
  }

  /** One open with the given key source; the rollback question goes to the TUI. */
  private async open(source: KeySource, signal: AbortSignal, agentOutcome?: () => UnlockResult | undefined): Promise<UnlockResult> {
    const io = new CollectIO();
    const { first, opening } = openWithQuestion((confirmOlder) =>
      openVault(this.cfg.vault, { config: this.cfg, sources: [source], rollback: "prompt", confirmOlder, io, signal, env: this.env }),
    );
    const r = await first;
    if ("vault" in r) return { kind: "unlocked", session: new RealSession(this, r.vault, io), warnings: io.drain() };
    if ("error" in r) {
      if (hasCode(r.error, VaultErrorCode.Locked) && agentOutcome) return agentOutcome() ?? { kind: "no-agent" };
      return failedOpen(r.error);
    }
    const asked = r.asked;
    const session = new RealSession(this, null, io);
    session.pendingQuestion = asked;
    const question: RollbackQuestion = {
      warning: asked.text,
      declined: errRollbackDeclined(),
      accept: async () => {
        asked.answer(true);
        session.pendingQuestion = null;
        const v = await opening;
        if (session.closed) {
          v.close();
          throw errRollbackDeclined();
        }
        session.attach(v);
        return io.drain();
      },
    };
    // A late open (after "no", a lock or a quit) is closed at once.
    opening.then(
      (v) => {
        if (session.closed) v.close();
      },
      () => {},
    );
    return { kind: "unlocked", session, warnings: io.drain(), rollback: question };
  }

  async unlockWithAgent(signal: AbortSignal): Promise<UnlockResult> {
    let outcome: UnlockResult | undefined;
    const env = this.env;
    const source: KeySource = {
      kind: "agent",
      async getKey(req: KeyRequest): Promise<X25519Identity | undefined> {
        try {
          const r = await agentKey(req.realPath, req.keyBlockDigest, { env, signal });
          if (r.kind === "key") return r.identity;
          outcome = r.kind === "key_block_changed" ? { kind: "agent-other-key-block" } : { kind: "no-agent" };
        } catch (e) {
          if (isAbort(e) || signal.aborted) throw e;
          outcome = { kind: "agent-failed", error: e };
        }
        return undefined;
      },
    };
    return this.open(source, signal, () => outcome);
  }

  async unlockWithPassphrase(passphrase: Uint8Array, signal: AbortSignal): Promise<UnlockResult> {
    // The key block is unwrapped exactly once with the typed bytes (tui.md §4.2).
    const source: KeySource = {
      kind: "passphrase",
      getKey: (req: KeyRequest) => unwrapKeyBlock(req.keyBlock, passphrase),
    };
    return this.open(source, signal);
  }

  async agentRunning(signal: AbortSignal): Promise<boolean> {
    const real = this.realPath();
    if (!real) return false;
    try {
      return (await agentStatus(real, { env: this.env, signal })) !== undefined;
    } catch {
      return false;
    }
  }

  async stopAgent(signal: AbortSignal): Promise<boolean> {
    const real = this.realPath();
    // SPEC-GAP: an agent whose vault file is gone can't be reached (audit #2); nothing to stop.
    if (!real) return false;
    return (await stopAgentAndWait(real, { env: this.env, signal })) !== undefined;
  }

  async copy(value: string, field: "password" | "username" | "url", path: string, _signal?: AbortSignal): Promise<CopyResult> {
    if (!this.clipboard) {
      const e = this.clipboardError;
      if (e instanceof NoClipboardError) return { kind: "no-clipboard", error: field === "url" ? new NoClipboardError(e.reason) : new NoClipboardError(e.reason, { path, field }) };
      return { kind: "no-clipboard", error: e };
    }
    try {
      const pc = await this.clipboard.copy(value);
      return { kind: "copied", clearAt: pc.clearAt, cleared: pc.done };
    } catch (e) {
      return { kind: "failed", error: e };
    }
  }

  pendingClear(): PendingClear | null {
    return this.clipboard?.pending() ?? null;
  }

  async clearNow(_signal?: AbortSignal): Promise<boolean> {
    return this.clipboard ? this.clipboard.clearNow() : false;
  }

  async startPrintPage(req: PrintRequest, signal: AbortSignal): Promise<PrintPage> {
    const sc = req.scope;
    const sheet = buildPasswordSheet({
      entries: req.data.entries,
      folder: sc.kind === "folder" ? sc.folder : "",
      tags: sc.kind === "tags" ? sc.tags : [],
      fields: parseFields(req.fields.join(",")),
      printedAt: new Date(),
    });
    const page = await startServer({ sheet, settings: printWebSettings(this.cfg), stateDir: stateDir(this.env), signal });
    return new PrintPageAdapter(page);
  }
}

/** The print server as the TUI sees it (tui.md §7.9). */
class PrintPageAdapter implements PrintPage {
  readonly urls: string[];
  readonly fingerprint: string;
  readonly certNotice?: string;
  readonly skipped: string[];
  readonly expiresAt: number;
  constructor(private readonly p: ServerPage) {
    this.urls = p.urls;
    this.fingerprint = p.fingerprint;
    this.certNotice = p.certNotice ? renderError(p.certNotice) : undefined;
    this.skipped = p.skipped.map((s) => renderError(s));
    this.expiresAt = p.expires;
  }
  qr(url: string): string[] | null {
    const i = this.urls.indexOf(url);
    if (i < 0) return null;
    try {
      const text = this.p.terminalQr(i);
      return text.replace(/\n+$/, "").split("\n");
    } catch {
      return null;
    }
  }
  state(): PrintState {
    const r = this.p.result();
    if (!r) return { running: true };
    return { running: false, served: r.outcome === "served", outcome: renderError(r.message) };
  }
  async stop(): Promise<void> {
    this.p.stop();
    await this.p.done.catch(() => {});
  }
}

/** An unlocked vault for the TUI (tui.md §7.7, §8). */
class RealSession implements VaultSession {
  closed = false;
  /** An unanswered rollback question (unlock or reload): a close answers it "no". */
  pendingQuestion: Asked | null = null;

  constructor(
    readonly b: RealTuiBackend,
    private vault: OpenedVault | null,
    private readonly io: CollectIO,
  ) {}

  attach(v: OpenedVault): void {
    this.vault = v;
  }

  private v(): OpenedVault {
    if (!this.vault) throw new Error("the vault isn't open");
    return this.vault;
  }

  data(): VaultData {
    return this.v().data;
  }

  /** One change and its save (spec §4.6): model errors and save errors become SaveResults. */
  private async change(signal: AbortSignal, make: (d: VaultData) => ChangeResult): Promise<SaveResult> {
    if (signal.aborted) return { kind: "cancelled" };
    const v = this.v();
    let r: ChangeResult;
    try {
      r = make(v.data);
    } catch (e) {
      return { kind: "failed", error: e };
    }
    if (!r.changed) return { kind: "unchanged" };
    try {
      await v.save(r.data, { signal });
    } catch (e) {
      if (hasCode(e, VaultErrorCode.Changed)) return { kind: "changed" };
      if (hasCode(e, VaultErrorCode.Cancelled) || (signal.aborted && isAbort(e))) return { kind: "cancelled" };
      return { kind: "failed", error: e };
    }
    return { kind: "saved", data: v.data, id: r.entry?.id ?? "", warnings: this.io.drain() };
  }

  private byId(d: VaultData, id: string) {
    const e = findEntryById(d, id);
    // SPEC-GAP: the TUI acts by id; an id that is gone reads `entry <id>: not found`.
    if (!e) throw new Error(`entry ${id}: not found`);
    return e;
  }

  add(path: string, values: EntryValues, extra: AddExtra | null, signal: AbortSignal): Promise<SaveResult> {
    return this.change(signal, (d) => {
      const r = addEntry(d, path, { ...values, fields: extra?.fields ?? [] });
      // A recreated add keeps the unknown keys the entry had (tui.md §8.2).
      if (extra && r.entry) r.entry.unknown = cloneUnknowns(extra.unknown);
      return r;
    });
  }

  edit(id: string, values: EntryValues, signal: AbortSignal): Promise<SaveResult> {
    return this.change(signal, (d) => editEntry(d, id, { password: values.password, username: values.username, url: values.url, tags: values.tags, notes: values.notes }));
  }

  move(id: string, dst: string, signal: AbortSignal): Promise<SaveResult> {
    return this.change(signal, (d) => moveEntry(d, this.byId(d, id).path, dst));
  }

  tag(id: string, add: string[], remove: string[], signal: AbortSignal): Promise<SaveResult> {
    return this.change(signal, (d) => editTags(d, this.byId(d, id).path, add, remove));
  }

  remove(id: string, signal: AbortSignal): Promise<SaveResult> {
    return this.change(signal, (d) => {
      const r = removeEntry(d, this.byId(d, id).path);
      return { ...r, entry: r.removed };
    });
  }

  async checkChanged(): Promise<boolean> {
    return this.v().changedOnDisk();
  }

  /**
   * Reload (tui.md §8.3, storage.md §3.3): the current vault key first, so a `passwd`
   * elsewhere (a new key block for the same key) reloads fine; a key block that the current
   * key doesn't open goes to the agent; without one, "rekeyed".
   */
  async reload(signal: AbortSignal): Promise<ReloadResult> {
    const cur = this.v();
    const current = identityKeySource(cur.identity(), cur.keySource);
    const first = await this.reloadWith(current, signal);
    if (first.kind !== "failed") return first;
    // The current key doesn't open the data: a rekey elsewhere (a new vault key) if the
    // key block changed; then the agent, which helps only if it holds the new key block.
    const e = first.error;
    if (!hasCode(e, KeyErrorCode.DataNotToKey) && !hasCode(e, VaultErrorCode.DataDamaged)) return first;
    let keyBlockChanged = false;
    try {
      keyBlockChanged = await this.keyBlockDiffers();
    } catch {
      return first;
    }
    if (!keyBlockChanged) return first;
    const env = this.b.env;
    const agent: KeySource = {
      kind: "agent",
      async getKey(req: KeyRequest): Promise<X25519Identity | undefined> {
        try {
          const r = await agentKey(req.realPath, req.keyBlockDigest, { env, signal });
          return r.kind === "key" ? r.identity : undefined;
        } catch (err) {
          if (isAbort(err) || signal.aborted) throw err;
          return undefined;
        }
      },
    };
    const second = await this.reloadWith(agent, signal);
    if (second.kind === "failed" && hasCode(second.error, VaultErrorCode.Locked)) return { kind: "rekeyed" };
    return second;
  }

  /** Whether the file's key block differs from the opened one. */
  private async keyBlockDiffers(): Promise<boolean> {
    const c = parseContainer(new Uint8Array(readFileSync(this.v().realPath)));
    const a = c.keyBlock;
    const b = this.v().keyBlock;
    return a.length !== b.length || a.some((x, i) => x !== b[i]);
  }

  private async reloadWith(source: KeySource, signal: AbortSignal): Promise<ReloadResult> {
    const b = this.b;
    const { first, opening } = openWithQuestion((confirmOlder) =>
      openVault(b.cfg.vault, { config: b.cfg, sources: [source], rollback: "prompt", confirmOlder, io: this.io, signal, env: b.env }),
    );
    const r = await first;
    if ("error" in r) return { kind: "failed", error: r.error };
    if ("vault" in r) return this.swap(r.vault);
    const asked = r.asked;
    this.pendingQuestion = asked;
    return {
      kind: "rollback",
      warning: asked.text,
      answer: async (yes: boolean) => {
        asked.answer(yes);
        this.pendingQuestion = null;
        try {
          return this.swap(await opening);
        } catch (e) {
          return { kind: "failed", error: e };
        }
      },
    };
  }

  /** The reloaded vault replaces the open one (unless the session was closed meanwhile). */
  private swap(v: OpenedVault): ReloadResult {
    if (this.closed) {
      v.close();
      return { kind: "failed", error: errRollbackDeclined() };
    }
    this.vault?.close();
    this.vault = v;
    return { kind: "reloaded", data: v.data, warnings: this.io.drain() };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingQuestion?.answer(false);
    this.pendingQuestion = null;
    this.vault?.close();
  }
}

/** The real backend of `passh` (no arguments). */
export function createTuiBackend(cfg: Config, opts: TuiBackendOptions): RealTuiBackend {
  return new RealTuiBackend(cfg, opts);
}
