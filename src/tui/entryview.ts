// The entry view (tui.md §6.2): the lines the pane and the detail show for one entry.

import { T } from "../i18n/index.ts";
import type { Entry } from "../model/types.ts";
import { ZERO_TIME } from "../model/types.ts";
import { MASK } from "./input.ts";
import { S, secondsLeft, v, width, wrap, type Line } from "./text.ts";

const LABEL_W = 10;

/** A custom field is secret when its key is password or otp (any case) or its value starts with otpauth:// (any case). */
export function isSecretField(key: string, value: string): boolean {
  const k = key.toLowerCase();
  return k === "password" || k === "otp" || value.toLowerCase().startsWith("otpauth://");
}

/** "YYYY-MM-DD HH:MM" in local time. */
export function localMinute(t: number): string {
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear()).padStart(4, "0")}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface EntryViewOptions {
  /** Secrets shown in clear (S5 reveal). */
  revealed: boolean;
  /** Milliseconds left of the reveal (for "shown for N s more"). */
  revealLeftMs: number;
}

/**
 * The entry view's lines for a width (§6.2). Labels sit in a 10-cell column; under 30
 * cells, or with a label wider than 8 cells, the view is stacked (label above the value).
 */
export function entryView(e: Entry, w: number, o: EntryViewOptions): Line[] {
  const out: Line[] = [];
  const labels = ["username", "password", "url", "tags", "notes", ...e.fields.map((f) => v(f.key))];
  const stacked = w < 30 || labels.some((l) => width(l) > 8);
  const valueW = stacked ? Math.max(1, w - 2) : Math.max(1, w - LABEL_W);
  for (const l of wrap(v(e.path), w)) out.push([{ t: l, s: S.bold }]);

  const field = (label: string, value: string, style = 0, hint?: string) => {
    const lines = value === "" ? [""] : wrap(value, valueW);
    if (stacked) {
      out.push([{ t: label, s: S.cyan }]);
      for (const l of lines) out.push([{ t: "  ", s: 0 }, { t: l, s: style }]);
      return;
    }
    lines.forEach((l, i) => {
      const lab: Line = i === 0 ? [{ t: label, s: S.cyan }, { t: " ".repeat(Math.max(0, LABEL_W - width(label))), s: 0 }] : [{ t: " ".repeat(LABEL_W), s: 0 }];
      const ln: Line = [...lab, { t: l, s: style }];
      if (hint && i === lines.length - 1 && width(l) + 3 + width(hint) <= valueW) ln.push({ t: "   " + hint, s: S.faint });
      out.push(ln);
    });
  };
  const secret = (label: string, value: string, hint?: string) => {
    if (value === "") field(label, T("(none)"), S.faint);
    else if (o.revealed) field(label, v(value), 0, hint);
    else field(label, MASK, 0, hint);
  };

  if (e.username !== "") field("username", v(e.username));
  secret("password", e.password, o.revealed ? T("[c]opy [r] hide") : T("[c]opy [r]eveal"));
  if (e.url !== "") field("url", v(e.url));
  if (e.tags.length > 0) field("tags", e.tags.map((t) => v(t)).join(" · "));
  for (const f of e.fields) {
    if (isSecretField(f.key, f.value)) secret(v(f.key), f.value);
    else field(v(f.key), v(f.value));
  }
  if (e.notes !== "") {
    const noteLines = e.notes.split("\n").map((l) => v(l.replace(/\t/g, "    ")));
    const wrapped = noteLines.flatMap((l) => wrap(l, valueW));
    if (stacked) {
      out.push([{ t: "notes", s: S.cyan }]);
      for (const l of wrapped) out.push([{ t: "  " + l, s: 0 }]);
    } else {
      wrapped.forEach((l, i) => out.push([i === 0 ? { t: "notes" + " ".repeat(LABEL_W - 5), s: S.cyan } : { t: " ".repeat(LABEL_W), s: 0 }, { t: l, s: 0 }]));
    }
  }
  if (e.updatedAt !== ZERO_TIME) out.push(...wrap(T("updated %s", localMinute(e.updatedAt)), w).map((l) => [{ t: l, s: S.faint }]));
  if (o.revealed) out.push(...wrap(T("shown for %d s more (r hides)", secondsLeft(o.revealLeftMs)), w).map((l) => [{ t: l, s: S.yellow }]));
  return out;
}
