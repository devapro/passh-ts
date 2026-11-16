// Drawing the TUI (tui.md §4.1, §5.1, §6, §7.8–§7.9, §11.1, §12): a pure function of the
// state that returns the frame as styled lines, exactly rows × cols. The layout numbers are
// informative (tui.md §5.1); the modes (wide, narrow, too small) are normative.

import { T, TN } from "../i18n/index.ts";
import type { App, Main, PrintDialog, PrintSetup, Prompt } from "./app.ts";
import { indexOf, selectable, type Row } from "./browse.ts";
import { entryView } from "./entryview.ts";
import { MASK } from "./input.ts";
import { S, countdown, lineWidth, padLine, secondsLeft, truncLine, truncate, v, width, wrap, wrapItems, type Line } from "./text.ts";

export const MIN_W = 20;
export const MIN_H = 6;
const STATUS_CAP = 6;

const faint = (t: string): Line => [{ t, s: S.faint }];

/** The whole frame. */
export function render(app: App): Line[] {
  const W = app.cols;
  const H = app.rows;
  let lines: Line[];
  if (app.screen === "lock") lines = lockView(app);
  else if (app.screen === "main" && app.main) {
    if (W < MIN_W || H < MIN_H) lines = [[{ t: T("passh: window too small"), s: 0 }]];
    else {
      const ov = app.main.overlay;
      if (ov?.kind === "form") lines = formScreen(app, app.main);
      else if (ov?.kind === "print-dialog") lines = dialogScreen(app, ov.dialog);
      else lines = app.isWide() ? wideMain(app, app.main) : narrowMain(app, app.main);
    }
  } else lines = [];
  const out: Line[] = [];
  for (let i = 0; i < H; i++) out.push(padLine(truncLine(lines[i] ?? [], W, ""), W));
  return out;
}

// ---------------------------------------------------------------------------
// Lock screen (§4.1)

function lockView(app: App): Line[] {
  const W = Math.max(1, app.cols - 1);
  const L = app.lock;
  const out: Line[] = [];
  const pad = (l: Line): Line => [{ t: " ", s: 0 }, ...l];
  out.push(pad([{ t: "passh", s: S.bold }, { t: " " + T("— vault locked"), s: S.faint }]));
  for (const l of wrap(v(app.backend.vaultDisplay), W)) out.push(pad(faint(l)));
  out.push([]);
  switch (L.mode) {
    case "field": {
      const f: Line = [{ t: T("Passphrase") + "  ", s: 0 }];
      if (L.input.cs.length > 0) f.push({ t: MASK, s: 0 });
      f.push({ t: " ", s: S.reverse });
      out.push(pad(f));
      if (L.agentHint) for (const l of wrap(T("An agent is running for this vault: Enter with an empty passphrase unlocks with it."), W)) out.push(pad(faint(l)));
      break;
    }
    case "busy":
      for (const l of wrap(L.busy, W)) out.push(pad(faint(l)));
      break;
    case "rollback":
      for (const l of wrap(T("Warning: %s", L.rollback?.question.warning ?? ""), W)) out.push(pad([{ t: l, s: S.yellow }]));
      out.push(pad([{ t: T("Continue with this copy? y/N"), s: S.bold }]));
      break;
    case "damaged":
      break;
  }
  out.push([]);
  if (L.messages.length > 0) {
    for (const m of L.messages) {
      const st = m.style === "error" ? S.red : m.style === "warn" ? S.yellow : 0;
      for (const l of m.text.split("\n").flatMap((x) => wrap(x, W))) out.push(pad([{ t: l, s: st }]));
    }
    out.push([]);
  }
  let hints: string[];
  switch (L.mode) {
    case "field":
      hints = [T("Enter unlock"), T("Esc clear"), T("ctrl+c quit")];
      break;
    case "busy":
      hints = [T("ctrl+c quit")];
      break;
    case "rollback":
      hints = [T("y continue"), T("n stop")];
      break;
    case "damaged":
      hints = [T("Enter try again"), T("q quit")];
      break;
  }
  for (const l of wrapItems(hints, " · ", W)) out.push(pad(faint(l)));
  return out;
}

// ---------------------------------------------------------------------------
// Main screen pieces

function titleState(app: App): string {
  const cd = countdown(app.idleLeft());
  return app.isReloading() ? T("reloading… · locks in %s", cd) : T("unlocked · locks in %s", cd);
}

/** The status area (§5.1): the banner, then a prompt, a question or the message; at most 6 lines. */
export function statusLines(app: App, m: Main, w: number, inForm = false): Line[] {
  const out: Line[] = [];
  if (m.banner) {
    const text = inForm ? T("Vault changed on disk: saving is refused; your input is kept for after R.") : T("Vault changed on disk — R to reload. Saving is blocked until then.");
    for (const l of wrap(text, w)) out.push([{ t: l, s: S.yellow }]);
  }
  const ov = m.overlay;
  if (ov?.kind === "prompt") out.push(...promptLines(ov.prompt, w));
  else if (ov?.kind === "confirm") {
    const text = ov.confirm.kind === "delete" ? T("Delete %s? [y/N]", v(ov.confirm.path)) : T("Warning: %s Continue with this copy? [y/N]", ov.confirm.warning);
    for (const l of wrap(text, w)) out.push([{ t: l, s: S.yellow }]);
  } else if (m.status) {
    const st = m.status;
    let text: string;
    let style = 0;
    if (st.k === "copy") {
      const left = st.clearAt - app.clock.wall();
      if (left > 0 && !st.clearing)
        text =
          st.field === "password"
            ? T("Password copied · clears in %d s (L clears it now)", secondsLeft(left))
            : T("Username copied · clears in %d s (L clears it now)", secondsLeft(left));
      else text = T("Clearing the clipboard…");
    } else {
      text = st.text;
      style = st.style === "error" ? S.red : st.style === "warn" ? S.yellow : 0;
    }
    for (const l of text.split("\n").flatMap((x) => wrap(x, w))) out.push([{ t: l, s: style }]);
  }
  if (out.length > STATUS_CAP) {
    out.length = STATUS_CAP;
    out[STATUS_CAP - 1] = [{ t: "…", s: 0 }];
  }
  if (out.length === 0) out.push([]);
  return out;
}

function promptLines(p: Prompt, w: number): Line[] {
  const out: Line[] = [];
  const label = p.label;
  const lw = width(label);
  if (lw > w / 2) {
    for (const l of wrap(label.trimEnd(), w)) out.push([{ t: l, s: S.bold }]);
    out.push(p.input.view(w, true));
  } else out.push([{ t: label, s: S.bold }, ...p.input.view(w - lw, true)]);
  if (p.error) for (const l of p.error.split("\n").flatMap((x) => wrap(x, w))) out.push([{ t: l, s: S.red }]);
  return out;
}

type HintCtx = "default" | "detail" | "narrow-list" | "narrow-detail" | "search" | "help" | "prompt" | "confirm" | "setup";

function hintContext(app: App, m: Main): HintCtx {
  const ov = m.overlay;
  if (ov?.kind === "prompt") return "prompt";
  if (ov?.kind === "confirm") return "confirm";
  if (ov?.kind === "help") return "help";
  if (ov?.kind === "print-setup") return "setup";
  if (m.search?.typing) return "search";
  if (m.detail) return app.isWide() ? "detail" : "narrow-detail";
  return app.isWide() ? "default" : "narrow-list";
}

/** The hint bar(s) (§5.1): items joined with " · ", wrapped between items. */
export function hintLines(app: App, m: Main, w: number): Line[] {
  const ctx = hintContext(app, m);
  const H = (items: string[]) => wrapItems(items, " · ", w);
  let lines: string[];
  switch (ctx) {
    case "default": {
      const l1 = [T("c copy pw"), T("u copy user"), T("r reveal"), T("e edit"), T("a add"), T("t tags"), T("d delete")];
      const l2 = [T("Tab folders/tags"), T("/ search"), T("P print"), T("R reload"), T("L lock"), T("? help"), T("q quit")];
      const two = [...H(l1), ...H(l2)];
      const flow = H([...l1, ...l2]);
      lines = two.length > 2 && flow.length < two.length ? flow : two;
      return lines.map((l) => faint(l));
    }
    case "detail":
      lines = H([T("Esc back"), T("↑↓ scroll"), T("c copy pw"), T("u copy user"), T("r reveal"), T("e edit"), T("t tags"), T("d delete"), T("? help")]);
      break;
    case "narrow-list":
      lines = H([T("↵ open"), T("c copy"), T("/ search"), T("Tab view"), T("? help"), T("q quit")]);
      break;
    case "narrow-detail":
      lines = H([T("Esc back"), T("c copy"), T("u user"), T("r reveal"), T("e edit"), T("? help")]);
      break;
    case "search":
      lines = H([T("type to search"), T("↑↓ move"), T("Enter done"), T("Esc close")]);
      break;
    case "help":
      lines = H([T("↑↓ scroll"), T("any other key closes")]);
      break;
    case "prompt":
      lines = H([T("Enter ok"), T("Esc cancel")]);
      break;
    case "confirm":
      lines = H([T("y yes"), T("any other key: no")]);
      break;
    case "setup":
      lines = H([T("↑↓ move"), T("space choose"), T("Enter continue"), T("Esc cancel"), T("L lock")]);
      break;
  }
  return lines.slice(0, 2).map((l) => faint(l));
}

/** Body height (§5.1): window height − chrome − status lines − hint lines, at least 1. */
export function bodyHeight(app: App, m: Main): number {
  const wide = app.isWide();
  const inner = wide ? app.cols - 4 : app.cols - 1;
  const chrome = wide ? 5 : 4;
  return Math.max(1, app.rows - chrome - statusLines(app, m, inner).length - hintLines(app, m, inner).length);
}

/** Help text (§3.3): one line per key, then the two notes (wrapped at 44 cells, as the reference). */
export function helpLines(w: number): Line[] {
  const keys: Array<[string, string]> = [
    ["↑ ↓  k j", T("move")],
    ["Enter  →", T("open a folder or an entry")],
    ["←  Esc", T("close a folder; back")],
    ["Tab", T("Folders / Tags view")],
    ["Space", T("select a tag (Tags view: AND)")],
    ["/", T("fuzzy search, paths and tags")],
    ["c  u", T("copy password / username")],
    ["r", T("reveal secrets for 10 s")],
    ["e  a", T("edit / add an entry")],
    ["t", T("edit tags")],
    ["m", T("move (rename) an entry")],
    ["d", T("delete an entry (asks first)")],
    ["R", T("reload the vault from disk")],
    ["P", T("print page")],
    ["L", T("lock now (in a text field L is a letter)")],
    ["?", T("this help")],
    ["q", T("quit (locks)")],
  ];
  const out: Line[] = [[{ t: T("Keys"), s: S.bold }]];
  for (const [k, d] of keys) {
    const kw = Math.max(10, width(k) + 1);
    const dl = wrap(d, Math.max(1, w - kw));
    dl.forEach((l, i) => out.push(i === 0 ? [{ t: k, s: S.bold }, { t: " ".repeat(kw - width(k)), s: 0 }, { t: l, s: 0 }] : [{ t: " ".repeat(kw) + l, s: 0 }]));
  }
  out.push([]);
  const nw = Math.min(w, 44);
  for (const l of wrap(T("In the form: ctrl+s saves, esc cancels, ctrl+r shows the password, ctrl+g generates."), nw)) out.push([{ t: l, s: 0 }]);
  for (const l of wrap(T("Text fields (form, search, prompts): Esc first, then L. The idle lock and signals lock from anywhere."), nw)) out.push([{ t: l, s: 0 }]);
  return out;
}

/** One list row drawn in w cells (padding included); `lp`/`rp` are the paddings. */
function rowLine(r: Row, w: number, selected: boolean, lp: number, rp: number): Line {
  // Note and heading rows use the right padding too (as the reference draws them).
  if (r.kind === "note" || r.kind === "heading") rp = 0;
  const cw = Math.max(1, w - lp - rp);
  let line: Line;
  if (r.kind === "note") line = [{ t: truncate(r.text, cw), s: S.faint }];
  else if (r.kind === "heading") line = [{ t: truncate(r.text, cw), s: S.faint }];
  else {
    const indent = "  ".repeat(r.depth);
    let marker = "";
    let right = "";
    if (r.kind === "folder") {
      marker = r.open ? "▾ " : "▸ ";
      right = `(${r.count})`;
    } else if (r.kind === "tag") {
      marker = r.selected ? "[x] " : "[ ] ";
      right = `(${r.count})`;
    } else {
      marker = "  ";
      if (r.matchTag !== undefined) right = "#" + v(r.matchTag);
    }
    const rw = right ? width(right) + 1 : 0;
    const leftText = truncate(indent + marker + v(r.text), Math.max(1, cw - rw));
    const gap = Math.max(0, cw - width(leftText) - width(right));
    line = [{ t: leftText + " ".repeat(gap), s: 0 }];
    if (right) line.push({ t: right, s: r.kind === "entry" ? S.faint : 0 });
  }
  const full: Line = [{ t: " ".repeat(lp), s: 0 }, ...padLine(truncLine(line, cw), cw), { t: " ".repeat(rp), s: 0 }];
  return selected ? full.map((s) => ({ t: s.t, s: (s.s & ~S.faint) | S.reverse })) : full;
}

/** The list's visible rows (scrolled to keep the cursor visible). */
function listLines(app: App, m: Main, w: number, h: number, lp: number, rp: number): Line[] {
  const l = app.list();
  const ci = app.cursorIndex(l);
  let off = m.offsets?.[l.name] ?? 0;
  if (ci >= 0) {
    if (ci < off) off = ci;
    if (ci >= off + h) off = ci - h + 1;
  }
  off = Math.max(0, Math.min(off, Math.max(0, l.rows.length - h)));
  const out: Line[] = [];
  for (let i = off; i < l.rows.length && out.length < h; i++) out.push(rowLine(l.rows[i]!, w, i === ci && selectable(l.rows[i]), lp, rp));
  return out;
}

/** The pane (§6.1): the row under the cursor. */
function paneLines(app: App, m: Main, w: number, h: number): Line[] {
  const l = app.list();
  const r = l.rows[app.cursorIndex(l)];
  const ix = indexOf(m.data);
  if (!r || !selectable(r)) return wrap(T("Nothing selected."), w).map(faint);
  if (r.kind === "entry") {
    const e = r.entry!;
    const lines = entryView(e, w, { revealed: app.revealedFor(e.id), revealLeftMs: m.reveal ? m.reveal.until - app.now() : 0 });
    if (lines.length > h) return [...lines.slice(0, Math.max(0, h - 1)), faint(truncate(T("… Enter shows all"), w))];
    return lines;
  }
  if (r.kind === "folder") {
    const n = ix.folders.get(r.folder!)?.count ?? 0;
    return [
      ...wrap(v(r.folder!) + "/", w).map((x) => [{ t: x, s: S.bold }] as Line),
      faint(TN(n, "%d entry", "%d entries", n)),
      [],
      ...wrap(T("Enter opens it, ← closes it."), w).map(faint),
    ];
  }
  const n = r.count ?? 0;
  return [
    ...wrap(T("tag %s", v(r.tag!)), w).map((x) => [{ t: x, s: S.bold }] as Line),
    faint(TN(n, "%d entry", "%d entries", n)),
    [],
    ...wrap(T("Space selects it; entries with all selected tags are listed."), w).map(faint),
  ];
}

/** A full-width block (help, detail, print setup), or null. */
function fullBlock(app: App, m: Main, w: number, h: number): Line[] | null {
  const ov = m.overlay;
  if (ov?.kind === "help") {
    const lines = helpLines(w);
    const off = Math.max(0, Math.min(ov.scroll, lines.length - h));
    return lines.slice(off, off + h);
  }
  if (ov?.kind === "print-setup") return setupLines(ov.setup, w).slice(0, h);
  if (m.detail) {
    const e = indexOf(m.data).byId.get(m.detail.id);
    if (!e) return [];
    const lines = entryView(e, w, { revealed: app.revealedFor(e.id), revealLeftMs: m.reveal ? m.reveal.until - app.now() : 0 });
    const off = Math.max(0, Math.min(m.detail.scroll, lines.length - h));
    return lines.slice(off, off + h);
  }
  return null;
}

/** Lines of a full-width block, for scroll limits. */
export function blockLength(app: App, m: Main, w: number): number {
  const ov = m.overlay;
  if (ov?.kind === "help") return helpLines(w).length;
  if (m.detail) {
    const e = indexOf(m.data).byId.get(m.detail.id);
    return e ? entryView(e, w, { revealed: app.revealedFor(e.id), revealLeftMs: 0 }).length : 0;
  }
  return 0;
}

function tabsLine(m: Main, narrow: boolean): Line {
  const f = m.view === "folders";
  const out: Line = [];
  if (!narrow) out.push({ t: T("VIEW:") + " ", s: 0 });
  out.push(f ? { t: "[" + T("Folders") + "]", s: S.bold } : { t: " " + T("Folders") + " ", s: 0 });
  out.push({ t: " ", s: 0 });
  out.push(!f ? { t: "[" + T("Tags") + "]", s: S.bold } : { t: " " + T("Tags") + " ", s: 0 });
  return out;
}

function searchPart(m: Main, narrow: boolean): Line {
  if (m.search?.typing) return [{ t: "/ ", s: 0 }, ...m.search.query.view(30, true)];
  if (m.search) return [{ t: "/ " + truncate(v(m.search.query.value), 30), s: 0 }];
  return narrow ? [] : [{ t: T("/ search"), s: S.faint }];
}

// ---------------------------------------------------------------------------
// Wide layout (≥ 80 columns)

function wideMain(app: App, m: Main): Line[] {
  const W = app.cols;
  const I = W - 2;
  const B = S.faint;
  const out: Line[] = [];
  // title
  const title: Line = [{ t: "┌", s: B }, { t: " passh ", s: S.bold }, { t: "──", s: B }, { t: " " + titleState(app) + " ", s: 0 }];
  out.push([...title, { t: "─".repeat(Math.max(0, W - lineWidth(title) - 1)), s: B }, { t: "┐", s: B }]);
  // tabs
  const tabs: Line = [{ t: " ", s: 0 }, ...tabsLine(m, false)];
  const right = searchPart(m, false);
  const gap = Math.max(1, I - lineWidth(tabs) - lineWidth(right) - 1);
  out.push([{ t: "│", s: B }, ...padLine(truncLine([...tabs, { t: " ".repeat(gap), s: 0 }, ...right, { t: " ", s: 0 }], I, ""), I), { t: "│", s: B }]);
  const status = statusLines(app, m, I - 2);
  const hints = hintLines(app, m, I - 2);
  const bodyH = Math.max(1, app.rows - 5 - status.length - hints.length);
  const block = fullBlock(app, m, I - 2, bodyH);
  const LW = Math.min(40, Math.max(24, Math.floor((I * 35) / 100)));
  const PW = I - LW - 1;
  if (block) {
    out.push([{ t: "├" + "─".repeat(I) + "┤", s: B }]);
    for (let i = 0; i < bodyH; i++) out.push([{ t: "│", s: B }, { t: " ", s: 0 }, ...padLine(truncLine(block[i] ?? [], I - 2), I - 2), { t: " ", s: 0 }, { t: "│", s: B }]);
    out.push([{ t: "├" + "─".repeat(I) + "┤", s: B }]);
  } else {
    out.push([{ t: "├" + "─".repeat(LW) + "┬" + "─".repeat(PW) + "┤", s: B }]);
    const list = listLines(app, m, LW, bodyH, 1, 1);
    const pane = paneLines(app, m, PW - 2, bodyH);
    for (let i = 0; i < bodyH; i++) {
      out.push([
        { t: "│", s: B },
        ...padLine(list[i] ?? [], LW),
        { t: "│", s: B },
        { t: " ", s: 0 },
        ...padLine(truncLine(pane[i] ?? [], PW - 2), PW - 2),
        { t: " ", s: 0 },
        { t: "│", s: B },
      ]);
    }
    out.push([{ t: "├" + "─".repeat(LW) + "┴" + "─".repeat(PW) + "┤", s: B }]);
  }
  for (const l of [...status, ...hints]) out.push([{ t: "│", s: B }, { t: " ", s: 0 }, ...padLine(truncLine(l, I - 2), I - 2), { t: " ", s: 0 }, { t: "│", s: B }]);
  out.push([{ t: "└" + "─".repeat(I) + "┘", s: B }]);
  return out;
}

// ---------------------------------------------------------------------------
// Narrow layout (< 80 columns)

function narrowMain(app: App, m: Main): Line[] {
  const W = app.cols;
  const out: Line[] = [];
  let title = "passh · " + titleState(app);
  if (width(title) > W) title = "passh · " + T("locks in %s", countdown(app.idleLeft()));
  out.push([{ t: title, s: S.bold }]);
  const tabs = tabsLine(m, true);
  const right = searchPart(m, true);
  if (right.length) {
    const gap = Math.max(1, W - lineWidth(tabs) - lineWidth(right));
    out.push(truncLine([...tabs, { t: " ".repeat(gap), s: 0 }, ...right], W, ""));
  } else out.push(tabs);
  out.push(faint("─".repeat(W)));
  const status = statusLines(app, m, W - 1);
  const hints = hintLines(app, m, W - 1);
  const bodyH = Math.max(1, app.rows - 4 - status.length - hints.length);
  const block = fullBlock(app, m, W - 1, bodyH);
  const body = block ? block.map((l) => [{ t: " ", s: 0 }, ...l]) : listLines(app, m, W, bodyH, 1, 1);
  for (let i = 0; i < bodyH; i++) out.push(body[i] ?? []);
  out.push(faint("─".repeat(W)));
  for (const l of [...status, ...hints]) out.push([{ t: " ", s: 0 }, ...l]);
  return out;
}

// ---------------------------------------------------------------------------
// Form screen (§11.1, §11.6)

function formScreen(app: App, m: Main): Line[] {
  const ov = m.overlay;
  if (ov?.kind !== "form") return [];
  const W = app.cols;
  const extra: Line[] = [];
  if (m.banner) for (const l of wrap(T("Vault changed on disk: saving is refused; your input is kept for after R."), W)) extra.push([{ t: l, s: S.yellow }]);
  if (m.status) {
    for (const l of statusLines(app, { ...m, banner: false, overlay: null } as Main, W)) if (l.length) extra.push(l);
  }
  const out: Line[] = [[{ t: "passh · " + titleState(app), s: S.bold }]];
  out.push(...ov.form.view(W, app.rows - 1, app.now(), extra));
  return out;
}

// ---------------------------------------------------------------------------
// Print setup (§7.8) and dialog (§7.9)

function setupLines(s: PrintSetup, w: number): Line[] {
  const out: Line[] = [];
  out.push([{ t: T("Print page: what to print"), s: S.bold }], []);
  out.push([{ t: T("Entries"), s: S.bold }]);
  s.scopes.forEach((sc, i) => {
    const l: Line = [{ t: "  " + (s.scope === i ? "(•) " : "( ) ") + sc.label, s: 0 }];
    out.push(s.cursor === i ? l.map((x) => ({ t: x.t, s: x.s | S.reverse })) : truncLine(l, w));
  });
  out.push([], [{ t: T("Fields"), s: S.bold }]);
  const names: Array<[keyof PrintSetup["fields"], string]> = [
    ["password", "password"],
    ["username", "username"],
    ["url", "url"],
    ["fields", T("custom fields")],
  ];
  names.forEach(([k, label], j) => {
    const i = s.scopes.length + j;
    const l: Line = [{ t: "  " + (s.fields[k] ? "[x] " : "[ ] ") + label, s: 0 }];
    out.push(s.cursor === i ? l.map((x) => ({ t: x.t, s: x.s | S.reverse })) : l);
  });
  return out;
}

function dialogScreen(app: App, d: PrintDialog): Line[] {
  const W = app.cols;
  const H = app.rows;
  const out: Line[] = [[{ t: "passh · " + T("print page") + " · " + titleState(app), s: S.bold }]];
  if (d.stopped) {
    out.push([], [{ t: T("Print page stopped"), s: S.bold }]);
    for (const l of wrap(d.stopped.outcome, W)) out.push([{ t: l, s: d.stopped.served ? 0 : S.yellow }]);
    out.push([], ...wrap(T("Any key closes."), W).map(faint));
    return out;
  }
  const p = d.page;
  const url = p.urls[d.url] ?? "";
  const qr = url ? p.qr(url) : null;
  const qrW = qr ? Math.max(0, ...qr.map((l) => width(l))) : 0;
  const beside = qr !== null && W >= 40 + qrW + 3;
  const textW = beside ? W - qrW - 3 : W;
  const text: Line[] = [];
  text.push([{ t: T("Print page"), s: S.bold }]);
  for (const l of wrap(T("Open this address in a browser on your LAN or VPN, compare the certificate fingerprint, then print:"), textW)) text.push([{ t: l, s: 0 }]);
  for (const l of wrap(v(url), textW)) text.push([{ t: l, s: S.bold }]);
  if (p.urls.length > 1) text.push(faint(T("(%d of %d, Tab: next)", d.url + 1, p.urls.length)));
  text.push([]);
  for (const l of wrap(T("Certificate fingerprint (SHA-256); the browser must show the same:"), textW)) text.push([{ t: l, s: 0 }]);
  for (const l of wrap(p.fingerprint, textW)) text.push([{ t: l, s: S.bold }]);
  if (p.certNotice) for (const l of wrap(v(p.certNotice), textW)) text.push([{ t: l, s: S.yellow }]);
  if (p.skipped.length) for (const l of wrap(T("Not used: %s", p.skipped.map((x) => v(x)).join("; ")), textW)) text.push(faint(l));
  let content: Line[];
  if (beside && qr) {
    content = [];
    const n = Math.max(text.length, qr.length);
    for (let i = 0; i < n; i++) content.push([...padLine(text[i] ?? [], textW), { t: "   ", s: 0 }, { t: qr[i] ?? "", s: 0 }]);
  } else {
    content = [...text, []];
    if (!qr) content.push(faint(url ? T("(no QR code for this address)") : ""));
    else if (qrW > W) content.push(faint(T("(the window is too narrow for the QR code)")));
    else for (const l of qr) content.push([{ t: l, s: 0 }]);
  }
  // footer
  const footer: Line[] = [];
  const left = p.expiresAt - app.clock.wall();
  for (const l of wrap(T("Stops in %s, after the page is loaded once, or with Esc.", countdown(left)), W)) footer.push([{ t: l, s: 0 }]);
  if (d.note) for (const l of wrap(d.note, W)) footer.push([{ t: l, s: 0 }]);
  if (d.stopping) footer.push(faint(T("Stopping the print page…")));
  for (const l of wrapItems([T("c copy URL"), T("Tab next URL"), T("↑↓ scroll"), T("Esc stop")], " · ", W).slice(0, 2)) footer.push(faint(l));
  const bodyH = Math.max(1, H - 1 - footer.length);
  const off = Math.max(0, Math.min(d.scroll, content.length - bodyH));
  let visible = content.slice(off, off + bodyH);
  if (off + bodyH < content.length) visible = [...visible.slice(0, bodyH - 1), faint(T("↓ more (↓ scrolls)"))];
  while (visible.length < bodyH) visible.push([]);
  out.push(...visible, ...footer);
  return out;
}
