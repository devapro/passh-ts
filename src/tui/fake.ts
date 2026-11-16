// An in-memory TuiBackend for tests and the PTY driver: a vault "on disk" and the session's
// copy of it, an agent, a clipboard and a print page, each with knobs to make it fail or
// wait. Not used by passh itself.

import { T, errorf } from "../i18n/index.ts";
import type { Entry, VaultData } from "../model/types.ts";
import { ZERO_TIME } from "../model/types.ts";
import { parsePath } from "../paths/index.ts";
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
} from "./backend.ts";

export interface FakeEntry {
  path: string;
  createdAt?: number;
  password?: string;
  username?: string;
  url?: string;
  tags?: string[];
  notes?: string;
  fields?: Array<{ key: string; value: string }>;
  id?: string;
  updatedAt?: number;
}

let idSeq = 0;

export function makeEntry(f: FakeEntry): Entry {
  return {
    id: f.id ?? `id-${++idSeq}`,
    path: f.path,
    password: f.password ?? "",
    username: f.username ?? "",
    url: f.url ?? "",
    tags: f.tags ?? [],
    fields: (f.fields ?? []).map((x) => ({ key: x.key, value: x.value, unknown: new Map() })),
    notes: f.notes ?? "",
    createdAt: 1_700_000_000,
    updatedAt: f.updatedAt ?? 1_700_000_000,
    unknown: new Map(),
  };
}

export function makeData(entries: FakeEntry[], revision = 1n): VaultData {
  return { format: "passh-vault-data", version: 1, vaultId: "vault-1", revision, savedAt: ZERO_TIME, entries: entries.map(makeEntry), deleted: [], unknown: new Map() };
}

function cloneData(d: VaultData): VaultData {
  return structuredClone(d);
}

/** A promise with its resolve function. */
export interface Gate {
  promise: Promise<void>;
  open(): void;
}

export function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

export interface FakeOptions {
  passphrase?: string;
  entries?: FakeEntry[];
  config?: Partial<TuiConfig>;
  /** The agent: none runs, serves the key, holds another key block, or fails. */
  agent?: "none" | "serves" | "other-key-block" | "fails";
  /** The data block is damaged (a key opens the key block but not the data). */
  damaged?: boolean;
  /** Unlock finds an older copy: the rollback warning. */
  rollback?: string;
  /** The clipboard: works, is missing, or fails to copy. */
  clipboard?: "ok" | "none" | "fails";
  /** Wall clock for the clipboard's due times (default Date.now). */
  wall?: () => number;
  /** Runs clears with real timers (the PTY driver); tests fire them by hand. */
  realTimers?: boolean;
  /** Called with each value the clipboard sets ("" clears), e.g. to write OSC 52. */
  onClipboard?: (value: string) => void;
}

export class FakeBackend implements TuiBackend {
  readonly config: TuiConfig;
  vaultDisplay = "~/.local/share/passh/vault.passh";
  passphrase: string;
  /** The vault file's content. */
  disk: VaultData;
  /** The file changed since the session opened or saved it. */
  changedOnDisk = false;
  agent: NonNullable<FakeOptions["agent"]>;
  agentAlive: boolean;
  damaged: boolean;
  rollback: string | null;
  reloadRollback: string | null = null;
  reloadRekeyed = false;
  checkFails: Error | null = null;
  clipboardMode: NonNullable<FakeOptions["clipboard"]>;
  /** Every value the clipboard was set to ("" for a clear), in order. */
  clipboard: string[] = [];
  /** Calls, in order (for asserting sequences). */
  log: string[] = [];
  sessions: FakeSession[] = [];
  /** If set, every save waits for it before it runs. */
  saveGate: Gate | null = null;
  /** If set, unlocks wait for it. */
  unlockGate: Gate | null = null;
  saveFails: Error | null = null;
  printPages: FakePrintPage[] = [];
  printFails: Error | null = null;
  private pending: { clearAt: number; done: Promise<"cleared" | "superseded">; resolve: (v: "cleared" | "superseded") => void; reject: (e: unknown) => void; timer?: ReturnType<typeof setTimeout> } | null = null;
  clearFails: Error | null = null;
  agentStopFails: Error | null = null;
  private readonly wall: () => number;
  private readonly realTimers: boolean;
  private readonly onClipboard?: (v: string) => void;

  constructor(o: FakeOptions = {}) {
    this.config = { idleTtlMs: 300_000, stopAgent: true, clearAfterMs: 30_000, printWebEnabled: false, ...o.config };
    this.passphrase = o.passphrase ?? "secret";
    this.disk = makeData(o.entries ?? []);
    this.agent = o.agent ?? "none";
    this.agentAlive = this.agent !== "none";
    this.damaged = o.damaged ?? false;
    this.rollback = o.rollback ?? null;
    this.clipboardMode = o.clipboard ?? "ok";
    this.wall = o.wall ?? (() => Date.now());
    this.realTimers = o.realTimers ?? false;
    this.onClipboard = o.onClipboard;
  }

  private open(): UnlockResult {
    if (this.damaged) return { kind: "damaged", error: errorf("%s: data is damaged; restore a backup\nno automatic backups of this vault were found; use another copy (passh verify --full <copy>)", "/v.passh") };
    const s = new FakeSession(this);
    this.sessions.push(s);
    const warn = this.rollback;
    if (warn) {
      const q: RollbackQuestion = {
        warning: warn,
        accept: async () => {
          this.log.push("rollback-accept");
          this.rollback = null;
          return [];
        },
        declined: errorf("stopped: this copy is older than one seen before on this machine; nothing was changed"),
      };
      return { kind: "unlocked", session: s, warnings: [], rollback: q };
    }
    return { kind: "unlocked", session: s, warnings: [] };
  }

  async unlockWithAgent(signal: AbortSignal): Promise<UnlockResult> {
    this.log.push("agent-key");
    if (this.unlockGate) await this.unlockGate.promise;
    if (signal.aborted) return { kind: "error", error: new Error("aborted") };
    if (!this.agentAlive) return { kind: "no-agent" };
    switch (this.agent) {
      case "other-key-block":
        return { kind: "agent-other-key-block" };
      case "fails":
        return { kind: "agent-failed", error: errorf("agent: reading the answer: context deadline exceeded") };
      default:
        return this.open();
    }
  }

  async unlockWithPassphrase(p: Uint8Array, signal: AbortSignal): Promise<UnlockResult> {
    const typed = new TextDecoder().decode(p);
    this.log.push("passphrase");
    if (this.unlockGate) await this.unlockGate.promise;
    if (signal.aborted) return { kind: "error", error: new Error("aborted") };
    if (typed !== this.passphrase) return { kind: "wrong-passphrase" };
    return this.open();
  }

  async agentRunning(): Promise<boolean> {
    this.log.push("agent-status");
    return this.agentAlive;
  }

  async stopAgent(): Promise<boolean> {
    this.log.push("agent-stop");
    if (this.agentStopFails) throw this.agentStopFails;
    const was = this.agentAlive;
    this.agentAlive = false;
    return was;
  }

  private setClipboard(v: string): void {
    this.clipboard.push(v);
    this.onClipboard?.(v);
  }

  async copy(value: string, field: "password" | "username" | "url", path: string): Promise<CopyResult> {
    this.log.push(`copy ${field} ${path}`);
    if (this.clipboardMode === "none")
      return { kind: "no-clipboard", error: errorf("no clipboard: %s; copy with: passh show %s --field %s | pbcopy", "clipboard.osc52 is off and clipboard.command is empty", path, field) };
    if (this.clipboardMode === "fails") return { kind: "failed", error: new Error("write /dev/tty: input/output error") };
    // a newer copy replaces the older schedule
    if (this.pending) {
      if (this.pending.timer) clearTimeout(this.pending.timer);
      this.pending.resolve("superseded");
      this.pending = null;
    }
    this.setClipboard(value);
    const clearAt = this.wall() + this.config.clearAfterMs;
    let resolve!: (v: "cleared" | "superseded") => void;
    let reject!: (e: unknown) => void;
    const done = new Promise<"cleared" | "superseded">((res, rej) => {
      resolve = res;
      reject = rej;
    });
    done.catch(() => {});
    this.pending = { clearAt, done, resolve, reject };
    if (this.realTimers) this.pending.timer = setTimeout(() => this.fireClear(), this.config.clearAfterMs);
    return { kind: "copied", clearAt, cleared: done };
  }

  /** Runs the scheduled clear now (tests). */
  fireClear(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    if (p.timer) clearTimeout(p.timer);
    if (this.clearFails) {
      p.reject(this.clearFails);
      return;
    }
    this.setClipboard("");
    p.resolve("cleared");
  }

  pendingClear(): PendingClear | null {
    return this.pending ? { clearAt: this.pending.clearAt, done: this.pending.done } : null;
  }

  async clearNow(): Promise<boolean> {
    this.log.push("clear-now");
    const p = this.pending;
    if (!p) return false;
    if (this.clearFails) throw this.clearFails;
    this.pending = null;
    if (p.timer) clearTimeout(p.timer);
    this.setClipboard("");
    p.resolve("superseded");
    return true;
  }

  async startPrintPage(req: PrintRequest): Promise<PrintPage> {
    this.log.push(`print ${req.scope.kind} ${req.fields.join(",")}`);
    if (this.printFails) throw this.printFails;
    const page = new FakePrintPage(this.wall() + 300_000);
    this.printPages.push(page);
    return page;
  }

  /** Changes the vault "on disk" (another passh, a sync tool). */
  editOnDisk(fn: (d: VaultData) => void): void {
    const d = cloneData(this.disk);
    fn(d);
    d.revision += 1n;
    this.disk = d;
    this.changedOnDisk = true;
  }
}

export class FakeSession implements VaultSession {
  private cur: VaultData;
  closed = false;
  constructor(readonly b: FakeBackend) {
    this.cur = cloneData(b.disk);
  }

  data(): VaultData {
    return this.cur;
  }

  private async save(id: string, change: (d: VaultData) => SaveResult | null, signal: AbortSignal): Promise<SaveResult> {
    const b = this.b;
    if (b.saveGate) await b.saveGate.promise;
    if (signal.aborted) return { kind: "cancelled" };
    if (this.closed) return { kind: "failed", error: new Error("the vault is closed") };
    if (b.changedOnDisk) return { kind: "changed" };
    if (b.saveFails) return { kind: "failed", error: b.saveFails };
    const d = cloneData(this.cur);
    const early = change(d);
    if (early) return early;
    d.revision += 1n;
    this.cur = d;
    b.disk = cloneData(d);
    b.log.push("save");
    return { kind: "saved", data: d, id, warnings: [] };
  }

  add(path: string, values: EntryValues, extra: AddExtra | null, signal: AbortSignal): Promise<SaveResult> {
    const id = `new-${++idSeq}`;
    return this.save(
      id,
      (d) => {
        let p: string;
        try {
          p = parsePath(path);
        } catch (e) {
          return { kind: "failed", error: e };
        }
        if (d.entries.some((e) => e.path === p)) return { kind: "failed", error: errorf("%s: already exists", p) };
        const e = makeEntry({ path: p, id, ...values });
        if (extra) {
          e.fields = extra.fields;
          e.unknown = extra.unknown;
        }
        d.entries.push(e);
        return null;
      },
      signal,
    );
  }

  edit(id: string, v: EntryValues, signal: AbortSignal): Promise<SaveResult> {
    return this.save(
      id,
      (d) => {
        const e = d.entries.find((x) => x.id === id);
        if (!e) return { kind: "failed", error: errorf("entry %s: not found", id) };
        if (e.password === v.password && e.username === v.username && e.url === v.url && e.notes === v.notes && e.tags.join("\0") === v.tags.join("\0")) return { kind: "unchanged" };
        Object.assign(e, { password: v.password, username: v.username, url: v.url, notes: v.notes, tags: [...v.tags], updatedAt: e.updatedAt + 60 });
        return null;
      },
      signal,
    );
  }

  move(id: string, dst: string, signal: AbortSignal): Promise<SaveResult> {
    return this.save(
      id,
      (d) => {
        const e = d.entries.find((x) => x.id === id);
        if (!e) return { kind: "failed", error: errorf("entry %s: not found", id) };
        if (d.entries.some((x) => x.path === dst)) return { kind: "failed", error: errorf("%s: already exists", dst) };
        e.path = dst;
        return null;
      },
      signal,
    );
  }

  tag(id: string, add: string[], remove: string[], signal: AbortSignal): Promise<SaveResult> {
    return this.save(
      id,
      (d) => {
        const e = d.entries.find((x) => x.id === id);
        if (!e) return { kind: "failed", error: errorf("entry %s: not found", id) };
        let tags = [...e.tags];
        for (const t of add) if (!tags.includes(t)) tags.push(t);
        tags = tags.filter((t) => !remove.includes(t));
        if (tags.join("\0") === e.tags.join("\0")) return { kind: "unchanged" };
        e.tags = tags;
        return null;
      },
      signal,
    );
  }

  remove(id: string, signal: AbortSignal): Promise<SaveResult> {
    return this.save(
      id,
      (d) => {
        const i = d.entries.findIndex((x) => x.id === id);
        if (i < 0) return { kind: "failed", error: errorf("entry %s: not found", id) };
        d.entries.splice(i, 1);
        d.deleted.push({ id, deletedAt: 1_700_000_100, unknown: new Map() });
        return null;
      },
      signal,
    );
  }

  async checkChanged(): Promise<boolean> {
    if (this.b.checkFails) throw this.b.checkFails;
    return this.b.changedOnDisk;
  }

  async reload(signal: AbortSignal): Promise<ReloadResult> {
    const b = this.b;
    b.log.push("reload");
    if (b.reloadRekeyed) return { kind: "rekeyed" };
    const finish = (): ReloadResult => {
      this.cur = cloneData(b.disk);
      b.changedOnDisk = false;
      return { kind: "reloaded", data: this.cur, warnings: [] };
    };
    if (b.reloadRollback) {
      const warning = b.reloadRollback;
      return {
        kind: "rollback",
        warning,
        answer: async (yes) => {
          if (signal.aborted) return { kind: "failed", error: new Error("aborted") };
          if (!yes) return { kind: "failed", error: errorf("stopped: this copy is older than one seen before on this machine; nothing was changed") };
          b.reloadRollback = null;
          return finish();
        },
      };
    }
    return finish();
  }

  close(): void {
    this.closed = true;
    this.cur = { ...this.cur, entries: [] };
    this.b.log.push("close");
  }
}

export class FakePrintPage implements PrintPage {
  urls = ["https://192.168.1.10:8443/p/kq7ZtokenTOKENtoken0", "https://[fd12:3456::1]:8443/p/kq7ZtokenTOKENtoken0"];
  fingerprint = "4F:A1:" + Array.from({ length: 30 }, () => "00").join(":");
  certNotice = "made a new certificate for the print page (first use); browsers will warn about it: compare the fingerprint";
  skipped = ["lo: 127.0.0.1 is a loopback address, not private"];
  st: PrintState = { running: true };
  stops = 0;
  constructor(readonly expiresAt: number) {}
  qr(url: string): string[] | null {
    if (url.includes("[")) return null;
    return Array.from({ length: 5 }, (_, i) => (i % 2 ? "█▀▄ ▀█▄ █" : "▄█▀ █▄▀ ▄"));
  }
  state(): PrintState {
    return this.st;
  }
  async stop(): Promise<void> {
    this.stops++;
    if (this.st.running) this.st = { running: false, served: false, outcome: T("the print page was stopped") };
  }
  /** The page was loaded by a browser. */
  serve(client = "192.168.1.23"): void {
    this.st = { running: false, served: true, outcome: T("the page was served to %s; if that wasn't you, start the print page again", client) };
  }
}
