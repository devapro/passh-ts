// The built-in entry form (spec §5.6, tui.md §11): used by the TUI (`e`, and `a` after the
// path) and by `passh edit` without --editor (standalone, §11.7). Pure state: keys and
// pastes change it, `view` draws it; saving and cancelling are reported to the caller.

import { T, TN, errorf, renderError } from "../i18n/index.ts";
import { parseTagList } from "../paths/index.ts";
import { hasLoneSurrogate } from "../util/unicode.ts";
import type { EntryValues } from "./backend.ts";
import { generatePassword } from "../gen/index.ts";
import { LineInput, MASK, TextArea, pasteMultiLine, pasteOneLine } from "./input.ts";
import type { InputMsg, KeyMsg } from "./keys.ts";
import { S, padLine, truncLine, v, width, wrap, wrapItems, type Line } from "./text.ts";

/** The reveal duration (S5, tui.md §2). */
export const REVEAL_MS = 10_000;

const FIELDS = ["password", "username", "url", "tags", "notes"] as const;
export type FormField = (typeof FIELDS)[number];

/** The form's values as text (tags as typed, joined with ", "). */
export interface FormText {
  password: string;
  username: string;
  url: string;
  tags: string;
  notes: string;
}

export interface FormInit {
  /** Title, e.g. "edit work/github" (already escaped by the caller? no: raw, escaped here). */
  title: string;
  /** The entry's values when the form opened (the base of the save rule, §11.5). */
  original: EntryValues;
  /** The values the inputs start with (default: the original's). */
  initial?: FormText;
  /** A recreated form ("not saved yet", tui.md §8.2): asks before dropping kept input. */
  recreated?: boolean;
  /** Custom field keys, listed on the `fields` line (not editable). */
  fieldKeys: string[];
}

export type FormOutcome =
  | { kind: "none" }
  | { kind: "save"; values: EntryValues }
  /** Cancelled: `discarded` is set when a discard question was answered with Esc/Ctrl-C. */
  | { kind: "cancel"; question: "none" | "changes" | "unsaved" };

type Msg = { text: string; style: "info" | "error" | "warn" };

export function formText(e: EntryValues): FormText {
  return { password: e.password, username: e.username, url: e.url, tags: e.tags.join(", "), notes: e.notes };
}

export class EntryForm {
  title: string;
  readonly original: EntryValues;
  private readonly originalText: FormText;
  /** The values when the form first opened (the base of "Discard the changes?"). */
  readonly opened: FormText;
  readonly recreated: boolean;
  readonly fieldKeys: string[];
  readonly inputs: Record<Exclude<FormField, "notes">, LineInput>;
  readonly notes: TextArea;
  focus: FormField = "password";
  revealUntil: number | null = null;
  /** The open discard question, if any. */
  asking: null | "changes" | "unsaved" = null;
  message: Msg | null = null;
  errors: Partial<Record<FormField, string>> = {};
  /** Last layout size, for vertical movement in the notes. */
  private notesW = 40;
  private notesH = 5;

  constructor(init: FormInit) {
    this.title = init.title;
    this.original = init.original;
    this.originalText = formText(init.original);
    const start = init.initial ?? this.originalText;
    this.opened = { ...start };
    this.recreated = init.recreated ?? false;
    this.fieldKeys = init.fieldKeys;
    this.inputs = {
      password: new LineInput(start.password, true),
      username: new LineInput(start.username),
      url: new LineInput(start.url),
      tags: new LineInput(start.tags),
    };
    this.notes = new TextArea(start.notes);
  }

  values(): FormText {
    return {
      password: this.inputs.password.value,
      username: this.inputs.username.value,
      url: this.inputs.url.value,
      tags: this.inputs.tags.value,
      notes: this.notes.value,
    };
  }

  /** Whether any value differs from when the form first opened. */
  changedSinceOpened(): boolean {
    const v = this.values();
    return FIELDS.some((f) => v[f] !== this.opened[f]);
  }

  /** Whether a field's input differs from the original entry's value (the save rule). */
  fieldChanged(f: FormField): boolean {
    return this.values()[f] !== this.originalText[f];
  }

  revealed(now: number): boolean {
    return this.revealUntil !== null && now < this.revealUntil;
  }

  /** Hides the password (lock of the reveal, or the form closing). */
  hide(): void {
    this.revealUntil = null;
    this.inputs.password.masked = true;
    this.inputs.password.pos = this.inputs.password.cs.length;
  }

  /** Called every second: hides an expired reveal. */
  tick(now: number): void {
    if (this.revealUntil !== null && now >= this.revealUntil) this.hide();
  }

  /** Wipes the inputs (lock, discard). */
  wipe(): void {
    for (const i of Object.values(this.inputs)) i.wipe();
    this.notes.set("");
  }

  setMessage(text: string, style: Msg["style"] = "info"): void {
    this.message = { text, style };
  }

  private moveFocus(d: number): void {
    const i = FIELDS.indexOf(this.focus);
    this.focus = FIELDS[(i + d + FIELDS.length) % FIELDS.length]!;
  }

  /** Handles a key or a paste. `now` is the monotonic clock in ms. */
  update(msg: InputMsg, now: number, _standalone = false): FormOutcome {
    if (this.asking) {
      // the discard question: Esc/Ctrl-C discard; any other key or a paste is consumed
      if (msg.type === "key" && (msg.key === "esc" || msg.key === "ctrl+c")) {
        const q = this.asking;
        this.asking = null;
        return { kind: "cancel", question: q };
      }
      this.asking = null;
      this.message = null;
      return { kind: "none" };
    }
    if (msg.type === "paste") {
      this.paste(msg.bytes);
      return { kind: "none" };
    }
    const k = msg;
    switch (k.key) {
      case "ctrl+s":
      case "alt+enter":
        return this.save();
      case "esc":
      case "ctrl+c":
        if (this.changedSinceOpened()) {
          this.asking = "changes";
          return { kind: "none" };
        }
        if (this.recreated) {
          this.asking = "unsaved";
          return { kind: "none" };
        }
        return { kind: "cancel", question: "none" };
      case "tab":
        this.moveFocus(1);
        return { kind: "none" };
      case "shift+tab":
        this.moveFocus(-1);
        return { kind: "none" };
      case "ctrl+r":
        if (this.revealed(now)) {
          this.hide();
          this.message = null;
        } else {
          this.revealUntil = now + REVEAL_MS;
          this.inputs.password.masked = false;
          this.setMessage(T("Password shown; it hides again in 10 s (ctrl+r hides it now)."));
        }
        return { kind: "none" };
      case "ctrl+g": {
        const p = this.inputs.password;
        p.wipe();
        p.insert(generatePassword(24));
        delete this.errors.password;
        this.setMessage(this.revealed(now) ? T("Generated a new password (24 characters); it is shown.") : T("Generated a new password (24 characters); ctrl+r shows it."));
        return { kind: "none" };
      }
    }
    if (this.focus === "notes") {
      const r = this.notes.handleKey(k, this.notesW, this.notesH);
      if (r === "ignored" && (k.key === "up" || k.key === "ctrl+p")) this.moveFocus(-1);
      if (r === "changed") delete this.errors.notes;
      return { kind: "none" };
    }
    // single-line fields
    switch (k.key) {
      case "enter":
      case "down":
      case "ctrl+n":
        this.moveFocus(1);
        return { kind: "none" };
      case "up":
      case "ctrl+p":
        this.moveFocus(-1);
        return { kind: "none" };
      case "ctrl+j":
      case "ctrl+m":
        return { kind: "none" }; // typed line breaks are dropped (§11.4)
    }
    const r = this.inputs[this.focus].handleKey(k);
    if (r === "changed") delete this.errors[this.focus];
    return { kind: "none" };
  }

  private paste(bytes: Uint8Array): void {
    if (this.focus === "notes") {
      const p = pasteMultiLine(bytes);
      if (!p.ok) {
        this.errors.notes = T("paste refused: the text isn't valid UTF-8");
        return;
      }
      this.notes.insert(p.text);
      delete this.errors.notes;
      return;
    }
    const p = pasteOneLine(bytes);
    if (!p.ok) {
      this.errors[this.focus] =
        p.reason === "lines" ? T("paste refused: %s is a single line and the text has line breaks", this.focus) : T("paste refused: the text isn't valid UTF-8");
      return;
    }
    this.inputs[this.focus].insert(p.text);
    delete this.errors[this.focus];
  }

  /** Ctrl-S: the save rule and validation of §11.5. */
  private save(): FormOutcome {
    const cur = this.values();
    const out: EntryValues = {
      password: this.fieldChanged("password") ? cur.password : this.original.password,
      username: this.fieldChanged("username") ? cur.username : this.original.username,
      url: this.fieldChanged("url") ? cur.url : this.original.url,
      tags: this.original.tags,
      notes: this.fieldChanged("notes") ? cur.notes : this.original.notes,
    };
    if (this.fieldChanged("tags")) {
      try {
        out.tags = parseTagList(cur.tags);
      } catch (e) {
        this.errors.tags = renderError(e);
        this.focus = "tags";
        return { kind: "none" };
      }
    }
    // The entry check (§4.2/§4.4 rules): single-line values, valid UTF-8.
    for (const f of ["password", "username", "url"] as const) {
      if (/[\r\n]/.test(out[f])) {
        this.setMessage(renderError(errorf("invalid entry: %s must be a single line", f)), "error");
        return { kind: "none" };
      }
      if (hasLoneSurrogate(out[f])) {
        this.setMessage(renderError(errorf("invalid entry: %s is not valid UTF-8", f)), "error");
        return { kind: "none" };
      }
    }
    if (hasLoneSurrogate(out.notes)) {
      this.setMessage(renderError(errorf("invalid entry: notes are not valid UTF-8")), "error");
      return { kind: "none" };
    }
    return { kind: "save", values: out };
  }

  /** The key help line's items (§11.1). */
  private helpItems(now: number): string[] {
    const items = [T("ctrl+s save"), T("esc cancel"), T("tab next")];
    if (this.focus === "notes") items.push(T("enter new line"));
    items.push(this.revealed(now) ? T("ctrl+r hide password") : T("ctrl+r show password"));
    items.push(T("ctrl+g generate"));
    return items;
  }

  /**
   * Draws the form in w × h cells. `extra` lines (the TUI's own status) are drawn under it
   * and count in h.
   */
  view(w: number, h: number, now: number, extra: Line[] = []): Line[] {
    const valueW = Math.max(8, w - 12);
    const help = wrapItems(this.helpItems(now), " · ", w).map((l) => [{ t: l, s: S.faint }]);
    const status: Line[] = [];
    if (this.asking === "changes") status.push(...wrap(T("Discard the changes? esc: discard · any other key: keep editing"), w).map((l) => [{ t: l, s: S.yellow }]));
    else if (this.asking === "unsaved")
      status.push(...wrap(T("Discard the changes that weren't saved? esc: discard · any other key: keep editing"), w).map((l) => [{ t: l, s: S.yellow }]));
    else if (this.message) {
      const st = this.message.style === "error" ? S.red : this.message.style === "warn" ? S.yellow : 0;
      status.push(...this.message.text.split("\n").flatMap((l) => wrap(l, w)).map((l) => [{ t: l, s: st }]));
    }
    const big = h >= 16;
    const title: Line[] = wrap(v(this.title), w).map((l) => [{ t: l, s: S.bold }]);
    // the fields line
    const fieldsLines: Line[] = [];
    if (this.fieldKeys.length > 0) {
      const text = this.fieldKeys.map((k) => v(k)).join(", ") + " " + T("(kept as they are; edit them with --editor)");
      let wrapped = wrap(text, valueW);
      if (wrapped.length > 3) {
        wrapped = wrapped.slice(0, 3);
        wrapped[2] = truncLine([{ t: wrapped[2]! + " …", s: 0 }], valueW).map((s) => s.t).join("");
        if (!wrapped[2]!.endsWith("…")) wrapped[2] = wrapped[2]! + "…";
      }
      wrapped.forEach((l, i) => fieldsLines.push([...this.label(i === 0 ? "fields" : "", false, false), { t: l, s: S.faint }]));
    }
    const singleLines: Line[] = [];
    const revealed = this.revealed(now);
    for (const f of ["password", "username", "url", "tags"] as const) {
      const focused = this.focus === f;
      const err = this.errors[f];
      const lab = this.label(f, this.focus === f, !!err);
      let val: Line;
      const inp = this.inputs[f];
      if (f === "password") {
        if (revealed) val = inp.view(valueW, focused);
        else if (inp.cs.length === 0) val = focused ? [{ t: " ", s: S.reverse }, { t: T("(empty)"), s: S.faint }] : [{ t: T("(empty)"), s: S.faint }];
        else val = inp.view(valueW, focused, { showMasked: true });
        if (this.fieldChanged("password")) val = [...val, { t: "  " + T("changed"), s: S.faint }];
      } else val = inp.view(valueW, focused);
      singleLines.push([...lab, ...truncLine(val, valueW)]);
      if (err) singleLines.push(...wrap(err, valueW).map((l) => [{ t: " ".repeat(12), s: 0 }, { t: l, s: S.red }]));
    }
    const notesErr = this.errors.notes ? wrap(this.errors.notes, valueW).map((l) => [{ t: " ".repeat(12), s: 0 }, { t: l, s: S.red }] as Line) : [];
    const fixed = title.length + (big ? 2 : 0) + singleLines.length + notesErr.length + fieldsLines.length + status.length + help.length + extra.length;
    const notesH = Math.max(1, h - fixed);
    const notesW = Math.max(1, valueW - 2);
    this.notesW = notesW;
    this.notesH = notesH;
    const notesLines = this.notes.view(notesW, notesH, this.focus === "notes");
    const out: Line[] = [...title];
    if (big) out.push([]);
    out.push(...singleLines);
    notesLines.forEach((nl, i) => {
      const lab = i === 0 ? this.label("notes", this.focus === "notes", !!this.errors.notes) : [{ t: " ".repeat(12), s: 0 }];
      out.push([...lab, { t: "│ ", s: S.faint }, ...nl]);
    });
    out.push(...notesErr);
    out.push(...fieldsLines);
    if (big) out.push([]);
    out.push(...status, ...extra, ...help);
    return out.slice(0, Math.max(h, 1)).map((l) => padLine(truncLine(l, w), w));
  }

  /** `› ` focus marker and the label right-aligned in 8 cells, then 2 spaces. */
  private label(name: string, focused: boolean, error: boolean): Line {
    const st = error ? S.red : focused ? S.cyan | S.bold : S.faint;
    const pad = Math.max(0, 8 - width(name));
    return [
      { t: focused ? "›" : " ", s: error ? S.red : S.cyan },
      { t: " " + " ".repeat(pad), s: 0 },
      { t: name, s: st },
      { t: "  ", s: 0 },
    ];
  }
}

/** The mask, re-exported for views. */
export { MASK };

/** "(N entries)" helper used by views of the form's caller. */
export function entriesCount(n: number): string {
  return TN(n, "%d entry", "%d entries", n);
}
