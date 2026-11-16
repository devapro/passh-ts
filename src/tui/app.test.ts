import { describe, expect, test } from "bun:test";
import { SignalError } from "../errors.ts";
import { gate } from "./fake.ts";
import { MASK } from "./input.ts";
import { Harness } from "./testdata/harness.ts";
import { filterFrame, renderLine } from "./text.ts";

const ENTRIES = [
  { path: "work/github", id: "gh", password: "gh-pass", username: "arsenii", url: "https://github.com", tags: ["dev", "2fa"], notes: "codes" },
  { path: "work/jira", id: "jira", password: "jira-pass", tags: ["dev"] },
  { path: "bank/My Bank", id: "bank", password: "bank-pass", username: "me" },
  { path: "homelab/router", id: "router", password: "router-pass" },
  { path: "github", id: "root", password: "root-pass", tags: ["dev"] },
];

async function unlocked(opts: ConstructorParameters<typeof Harness>[0] = {}, cols = 80, rows = 24): Promise<Harness> {
  const h = new Harness({ entries: ENTRIES, ...opts }, cols, rows);
  await h.start("secret");
  expect(h.app.screen).toBe("main");
  return h;
}

/** The frame's text with wrapped lines joined (box borders removed), for "contains" checks. */
const statusText = (h: Harness) => flat(h);
function flat(h: Harness): string {
  return h
    .lines()
    .map((l) => l.replace(/^│ ?/, "").replace(/ *│$/, "").trim())
    .join(" ");
}

// ---------------------------------------------------------------------------

describe("start and the lock screen (tui.md §1.1, §4)", () => {
  test("asks the agent at start, without a key press; no agent: the field, no message", async () => {
    const h = new Harness({ entries: ENTRIES });
    h.send({ type: "start" });
    expect(h.app.lock.mode).toBe("busy");
    expect(flat(h)).toContain("asking the agent…");
    await h.settle();
    expect(h.backend.log[0]).toBe("agent-key");
    expect(h.app.lock.mode).toBe("field");
    expect(h.lines().slice(0, 6)).toEqual([" passh — vault locked", " ~/.local/share/passh/vault.passh", "", " Passphrase", "", " Enter unlock · Esc clear · ctrl+c quit"]);
  });
  test("an agent that serves the key unlocks at once", async () => {
    const h = new Harness({ entries: ENTRIES, agent: "serves" });
    await h.start();
    expect(h.app.screen).toBe("main");
    expect(flat(h)).toContain("Unlocked: 5 entries, revision 1.");
  });
  test("the passphrase shows the fixed mask; Enter unlocks; busy text while scrypt runs", async () => {
    const h = new Harness({ entries: ENTRIES });
    await h.start();
    await h.type("a");
    expect(h.lines()[3]).toBe(` Passphrase  ${MASK}`);
    await h.type("bcdefghijklmnop");
    expect(h.lines()[3]).toBe(` Passphrase  ${MASK}`);
    h.backend.unlockGate = gate();
    h.send({ type: "key", key: "enter", text: "" });
    expect(h.app.lock.input.value).toBe("");
    expect(flat(h)).toContain("unlocking… (this takes a few seconds on small devices)");
    expect(flat(h)).toContain("ctrl+c quit");
    h.backend.unlockGate.open();
    await h.settle();
    expect(h.app.lock.messages[0]?.text).toBe("Wrong passphrase, or the key block is damaged. Try again.");
    await h.type("secret");
    await h.keys("enter");
    expect(h.app.screen).toBe("main");
  });
  test("Enter on an empty field; Esc clears, then quits; Tab and Ctrl keys insert nothing", async () => {
    const h = new Harness({ entries: ENTRIES });
    await h.start();
    await h.keys("enter");
    expect(flat(h)).toContain("Type the passphrase, then Enter.");
    await h.type("x");
    await h.keys("tab", "ctrl+x", "alt+y");
    expect(h.app.lock.input.value).toBe("x");
    await h.keys("esc");
    expect(h.app.lock.input.value).toBe("");
    expect(h.app.screen).toBe("lock");
    await h.keys("esc");
    expect(h.app.screen).toBe("bye");
    expect(h.app.exit).toMatchObject({ code: 0 });
  });
  test("Ctrl-C and Ctrl-D quit", async () => {
    for (const k of ["ctrl+c", "ctrl+d"]) {
      const h = new Harness({ entries: ENTRIES });
      await h.start();
      await h.type("abc");
      await h.keys(k);
      expect(h.app.screen).toBe("bye");
    }
  });
  test("pastes: one line, a trailing line break dropped; a line break inside refused", async () => {
    const h = new Harness({ entries: ENTRIES });
    await h.start();
    await h.paste("sec\nret");
    expect(flat(h)).toContain("Paste refused: the passphrase is one line.");
    expect(h.app.lock.input.value).toBe("");
    await h.paste("secret\r\n");
    expect(h.app.lock.input.value).toBe("secret");
    await h.keys("enter");
    expect(h.app.screen).toBe("main");
  });
  test("a pasted control character is kept (the TUI field takes text, tui.md §4.2)", async () => {
    const h = new Harness({ entries: ENTRIES, passphrase: "a\tb" });
    await h.start();
    await h.paste("a\tb");
    await h.keys("enter");
    expect(h.app.screen).toBe("main");
  });
  test("busy: other keys and pastes are ignored", async () => {
    const h = new Harness({ entries: ENTRIES });
    h.backend.unlockGate = gate();
    h.send({ type: "start" });
    await h.keys("x", "enter", "esc");
    await h.paste("zz");
    expect(h.app.lock.mode).toBe("busy");
    expect(h.app.lock.input.value).toBe("");
    h.backend.unlockGate.open();
    await h.settle();
    expect(h.app.lock.mode).toBe("field");
  });
  test("damaged data: the damaged state; Enter tries again; q quits", async () => {
    const h = new Harness({ entries: ENTRIES, damaged: true });
    await h.start("secret");
    expect(h.app.lock.mode).toBe("damaged");
    expect(flat(h)).toContain("data is damaged; restore a backup");
    expect(flat(h)).toContain("Enter try again · q quit");
    expect(flat(h)).not.toContain("Passphrase");
    h.backend.damaged = false;
    await h.keys("enter");
    expect(h.app.lock.mode).toBe("field");
    expect(h.backend.log.filter((l) => l === "agent-key").length).toBe(2);
    h.backend.damaged = true;
    await h.type("secret");
    await h.keys("enter", "q");
    expect(h.app.screen).toBe("bye");
  });
  test("agent outcomes", async () => {
    const a = new Harness({ entries: ENTRIES, agent: "other-key-block" });
    await a.start();
    expect(flat(a)).toContain("The agent was unlocked for another key block (the passphrase was changed?): enter the passphrase.");
    const b = new Harness({ entries: ENTRIES, agent: "fails" });
    await b.start();
    expect(flat(b)).toContain("The agent didn't give the key (agent: reading the answer: context deadline exceeded): enter the passphrase.");
  });
});

describe("rollback question at unlock (tui.md §9)", () => {
  const warning = "this copy is older than one seen before on this machine (r40 of 2026-11-10; seen r42 of 2026-11-15). If you didn't restore it on purpose, the file may have been replaced.";
  test("y continues and records the lower revision", async () => {
    const h = new Harness({ entries: ENTRIES, rollback: warning });
    await h.start("secret");
    expect(h.app.lock.mode).toBe("rollback");
    expect(flat(h)).toContain("Warning: this copy is older");
    expect(flat(h)).toContain("Continue with this copy? y/N");
    expect(flat(h)).toContain("y continue · n stop");
    await h.keys("x");
    expect(h.app.lock.mode).toBe("rollback");
    await h.keys("Y");
    expect(h.app.screen).toBe("main");
    expect(h.backend.log).toContain("rollback-accept");
  });
  for (const k of ["n", "N", "esc", "enter"]) {
    test(`${k}: the TUI exits with the "stopped" error`, async () => {
      const h = new Harness({ entries: ENTRIES, rollback: warning });
      await h.start("secret");
      await h.keys(k);
      expect(h.app.screen).toBe("bye");
      expect((h.app.exit!.error as Error).message).toBe("stopped: this copy is older than one seen before on this machine; nothing was changed");
      expect(h.backend.sessions[0]!.closed).toBe(true);
    });
  }
  test("Ctrl-C quits", async () => {
    const h = new Harness({ entries: ENTRIES, rollback: warning });
    await h.start("secret");
    await h.keys("ctrl+c");
    expect(h.app.screen).toBe("bye");
    expect(h.app.exit!.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("main screen layout (tui.md §5.1)", () => {
  test("80 × 24", async () => {
    const h = await unlocked();
    const L = h.lines();
    expect(L.length).toBe(24);
    expect(L[0]).toBe("┌ passh ── unlocked · locks in 5:00 " + "─".repeat(43) + "┐");
    expect(L[1]).toBe("│ VIEW: [Folders]  Tags" + " ".repeat(47) + "/ search │");
    expect(L[2]).toBe("├" + "─".repeat(27) + "┬" + "─".repeat(50) + "┤");
    expect(L[3]).toBe("│ ▸ bank                (1) │ bank/                                            │");
    expect(L[4]).toBe("│ ▸ homelab             (1) │ 1 entry                                          │");
    expect(L[5]).toBe("│ ▸ work                (2) │                                                  │");
    expect(L[6]).toBe("│   github                  │ Enter opens it, ← closes it.                     │");
    expect(L[19]).toBe("├" + "─".repeat(27) + "┴" + "─".repeat(50) + "┤");
    expect(L[20]).toBe("│ Unlocked: 5 entries, revision 1." + " ".repeat(45) + "│");
    expect(L[21]).toBe("│ c copy pw · u copy user · r reveal · e edit · a add · t tags · d delete      │");
    expect(L[22]).toBe("│ Tab folders/tags · / search · P print · R reload · L lock · ? help · q quit  │");
    expect(L[23]).toBe("└" + "─".repeat(78) + "┘");
    // the selected row is drawn in reverse video
    const row = h.frame()[3]!;
    expect(row.filter((s) => s.s & 4).map((s) => s.t).join("")).toBe(" ▸ bank                (1) ");
  });
  test("120 × 40: the list is clamped to 40 cells", async () => {
    const h = await unlocked({}, 120, 40);
    const L = h.lines();
    expect(L.length).toBe(40);
    expect(L[2]).toBe("├" + "─".repeat(40) + "┬" + "─".repeat(77) + "┤");
    expect(L[3]!.startsWith("│ ▸ bank" + " ".repeat(29) + "(1) │ bank/")).toBe(true);
    expect(L[39]).toBe("└" + "─".repeat(118) + "┘");
  });
  test("narrow 40 × 20: one pane, no box", async () => {
    const h = await unlocked({}, 40, 20);
    const L = h.lines();
    expect(L[0]).toBe("passh · unlocked · locks in 5:00");
    expect(L[1]).toBe("[Folders]  Tags");
    expect(L[2]).toBe("─".repeat(40));
    expect(L[3]).toBe(" ▸ bank                             (1)");
    expect(L[6]).toBe("   github");
    expect(L[16]).toBe("─".repeat(40));
    expect(L[17]).toBe(" Unlocked: 5 entries, revision 1.");
    expect(L[18]).toBe(" ↵ open · c copy · / search · Tab view");
    expect(L[19]).toBe(" ? help · q quit");
  });
  test("narrow title shortens when too wide", async () => {
    const h = await unlocked({}, 24, 10);
    expect(h.lines()[0]).toBe("passh · locks in 5:00");
  });
  test("window too small; keys still work", async () => {
    for (const [c, r] of [
      [19, 24],
      [80, 5],
    ] as const) {
      const h = await unlocked({}, c, r);
      expect(h.lines()[0]).toBe("passh: window too small".slice(0, c));
      await h.keys("j", "enter");
      h.resize(80, 24);
      expect(flat(h)).toContain("▾ homelab");
    }
  });
  test("the countdown in the title follows the idle timer", async () => {
    const h = await unlocked();
    await h.tick(48_000);
    expect(h.lines()[0]).toContain("locks in 4:12");
    await h.keys("j");
    expect(h.lines()[0]).toContain("locks in 5:00");
  });
  test("every frame passes the final filter unchanged (no stray escapes)", async () => {
    const h = await unlocked({ entries: [{ path: "evil/\u202ex", password: "p\x1b]52;c;aGk=\x07", username: "u\x1b[2J", notes: "n\x07" }] });
    await h.keys("l", "j", "r");
    const frame = h.frame().map(renderLine);
    for (const l of frame) expect(filterFrame(l)).toBe(l);
    const t = h.text();
    expect(t).toContain("\\u202ex");
    expect(t).toContain("u\\x1b[2J");
    expect(t).toContain("p\\x1b]52;c;aGk=\\x07");
  });
});

// ---------------------------------------------------------------------------

describe("key routing (tui.md §3.2)", () => {
  test("L locks from the list, a detail and search results", async () => {
    for (const keys of [[], ["j", "j", "j", "enter"], ["/", "g", "enter"]]) {
      const h = await unlocked();
      await h.keys(...keys);
      if (keys[0] === "/") await h.keys(); // typing "g" above
      await h.keys("L");
      expect(h.app.screen).toBe("lock");
    }
  });
  test("L is a letter in the search while typing, prompts and the form", async () => {
    const h = await unlocked();
    await h.keys("/", "L");
    expect(h.app.main!.search!.query.value).toBe("L");
    await h.keys("esc", "a", "L");
    expect(h.app.main!.overlay?.kind).toBe("prompt");
    await h.keys("esc", "j", "j", "j", "e", "L");
    expect(h.app.main!.overlay?.kind).toBe("form");
    expect(h.app.screen).toBe("main");
  });
  test("q, ?, c are text while typing a search", async () => {
    const h = await unlocked();
    await h.keys("/", "q", "?", "c");
    expect(h.app.main!.search!.query.value).toBe("q?c");
    expect(h.app.screen).toBe("main");
  });
  test("help: ↑↓ scroll, any other key closes and is consumed, Ctrl-C quits", async () => {
    const h = await unlocked();
    await h.keys("?");
    expect(flat(h)).toContain("Keys");
    expect(flat(h)).toContain("↑↓ scroll · any other key closes");
    await h.keys("j", "j");
    expect(h.app.main!.overlay).toMatchObject({ kind: "help", scroll: 2 });
    await h.keys("q");
    expect(h.app.main!.overlay).toBeNull();
    expect(h.app.screen).toBe("main");
    await h.keys("?", "ctrl+c");
    expect(h.app.screen).toBe("bye");
  });
  test("entry keys on a folder: Select an entry first.", async () => {
    const h = await unlocked();
    for (const k of ["c", "u", "r", "e", "t", "m", "d"]) {
      await h.keys(k);
      expect(statusText(h)).toContain("Select an entry first.");
      expect(h.app.main!.overlay).toBeNull();
    }
  });
  test("Esc never quits the main screen", async () => {
    const h = await unlocked();
    await h.keys("esc", "esc");
    expect(h.app.screen).toBe("main");
  });
  test("global keys work from the detail on the detail's entry", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "j", "enter", "c");
    expect(h.backend.log).toContain("copy password github");
  });
});

describe("list keys (tui.md §3.5)", () => {
  const cur = (h: Harness) => {
    const l = h.app.list();
    return l.rows[h.app.cursorIndex(l)]?.text;
  };
  test("↑↓ stop at the ends; Home/End; Ctrl-N/P", async () => {
    const h = await unlocked();
    await h.keys("up");
    expect(cur(h)).toBe("bank");
    await h.keys("down", "ctrl+n", "j", "j", "j");
    expect(cur(h)).toBe("github");
    await h.keys("k", "ctrl+p");
    expect(cur(h)).toBe("homelab");
    await h.keys("G");
    expect(cur(h)).toBe("github");
    await h.keys("g");
    expect(cur(h)).toBe("bank");
    await h.keys("end", "home");
    expect(cur(h)).toBe("bank");
  });
  test("Enter opens and closes a folder; → opens, then moves into it; ← goes to the parent, then closes", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "enter");
    expect(flat(h)).toContain("▾ work");
    await h.keys("enter");
    expect(flat(h)).toContain("▸ work");
    await h.keys("l");
    expect(flat(h)).toContain("▾ work");
    expect(cur(h)).toBe("work");
    await h.keys("right");
    expect(cur(h)).toBe("github");
    await h.keys("j", "h");
    expect(cur(h)).toBe("work");
    expect(flat(h)).toContain("▾ work");
    await h.keys("left");
    expect(flat(h)).toContain("▸ work");
  });
  test("Space: a folder as Enter, an entry nothing", async () => {
    const h = await unlocked();
    await h.keys("space");
    expect(flat(h)).toContain("▾ bank");
    await h.keys("j", "space");
    expect(h.app.main!.detail).toBeNull();
    await h.keys("enter");
    expect(h.app.main!.detail).not.toBeNull();
  });
  test("PgUp/PgDn move by body height − 1", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ path: `e${String(i).padStart(2, "0")}`, password: "x" }));
    const h = await unlocked({ entries: many });
    await h.keys("pgdown");
    expect(cur(h)).toBe("e15");
    expect(h.lines()[3]).toContain("e00");
    await h.keys("j");
    expect(h.lines()[3]).toContain("e01");
    await h.keys("pgdown", "pgdown", "pgdown");
    expect(cur(h)).toBe("e49");
    await h.keys("pgup");
    expect(cur(h)).toBe("e34");
    expect(h.lines()[3]).toContain("e34");
  });
  test("Tags view: Enter/Space/→ toggle; Esc clears the selection; the selection survives Tab", async () => {
    const h = await unlocked();
    await h.keys("tab");
    expect(flat(h)).toContain("VIEW:  Folders  [Tags]");
    expect(flat(h)).toContain("[ ] 2fa");
    await h.keys("enter");
    expect(flat(h)).toContain("[x] 2fa");
    expect(flat(h)).toContain("── 1 entry with 2fa ──");
    await h.keys("j", "space");
    expect(flat(h)).toContain("── 1 entry with 2fa + dev…");
    await h.keys("tab", "tab");
    expect(flat(h)).toContain("[x] dev");
    await h.keys("esc");
    expect(flat(h)).not.toContain("[x]");
    expect(flat(h)).toContain("Space selects tags; the e…");
  });
  test("narrow: Enter opens the detail, Esc returns; r on a list entry opens it revealed", async () => {
    const h = await unlocked({}, 40, 20);
    await h.keys("j", "j", "j", "enter");
    expect(h.lines()[3]).toBe(" github");
    expect(flat(h)).toContain("Esc back · c copy · u user · r reveal");
    await h.keys("esc");
    expect(h.app.main!.detail).toBeNull();
    await h.keys("r");
    expect(h.app.main!.detail?.id).toBe("root");
    expect(flat(h)).toContain("root-pass");
    expect(flat(h)).toContain("shown for 10 s more (r hides)");
    await h.keys("esc");
    expect(h.app.main!.reveal).toBeNull();
  });
});

describe("detail (tui.md §3.4, §6)", () => {
  test("Esc, ←, h, Backspace go back with the cursor on the entry", async () => {
    for (const k of ["esc", "left", "h", "backspace"]) {
      const h = await unlocked();
      await h.keys("j", "j", "j", "enter", k);
      expect(h.app.main!.detail).toBeNull();
      expect(h.app.selectedEntry()?.id).toBe("root");
    }
  });
  test("the entry view: fields in order, custom secrets masked, notes, updated", async () => {
    const h = await unlocked({
      entries: [
        {
          path: "x/y",
          password: "pw",
          username: "u",
          url: "https://e",
          tags: ["a", "b"],
          fields: [
            { key: "pin", value: "1234" },
            { key: "OTP", value: "123" },
            { key: "seed", value: "otpauth://totp/x" },
            { key: "empty", value: "" },
          ],
          notes: "n1\n\tn2",
        },
      ],
    });
    await h.keys("l", "j", "enter");
    const t = h.lines().map((l) => l.slice(2, 78).trimEnd());
    const body = t.slice(3, 16);
    expect(body).toEqual([
      "x/y",
      "username  u",
      `password  ${MASK}   [c]opy [r]eveal`,
      "url       https://e",
      "tags      a · b",
      "pin       1234",
      `OTP       ${MASK}`,
      `seed      ${MASK}`,
      "empty",
      "notes     n1",
      "              n2",
      body[11]!,
      "",
    ]);
    expect(body[11]).toMatch(/^updated \d{4}-\d\d-\d\d \d\d:\d\d$/);
    await h.keys("r");
    const r = h.text();
    expect(r).toContain("password  pw   [c]opy [r] hide");
    expect(r).toContain("OTP       123");
    expect(r).toContain("seed      otpauth://totp/x");
  });
  test("the pane cuts a long view with … Enter shows all; the detail scrolls", async () => {
    const notes = Array.from({ length: 40 }, (_, i) => `note ${i}`).join("\n");
    const h = await unlocked({ entries: [{ path: "long", password: "p", notes }] });
    expect(flat(h)).toContain("… Enter shows all");
    await h.keys("enter");
    expect(flat(h)).toContain("note 0");
    await h.keys("pgdown", "pgdown", "pgdown");
    expect(flat(h)).toContain("note 39");
    await h.keys("g");
    expect(flat(h)).toContain("note 0");
  });
});

// ---------------------------------------------------------------------------

describe("search (tui.md §5.4)", () => {
  test("/ lists every entry; typing filters; the cursor goes to the first result", async () => {
    const h = await unlocked();
    await h.keys("/");
    expect(h.lines()[1]).toBe("│ VIEW: [Folders]  Tags" + " ".repeat(52) + "/   │");
    expect(h.app.list().rows.map((r) => r.text)).toEqual(["github", "bank/My Bank", "homelab/router", "work/github", "work/jira"].sort((a, b) => (a < b ? -1 : 1)));
    await h.keys("down", "down");
    await h.type("gh");
    expect(h.app.list().rows.map((r) => r.text)).toEqual(["github", "work/github"]);
    expect(h.app.selectedEntry()?.id).toBe("root");
    expect(flat(h)).toContain("type to search · ↑↓ move · Enter done · Esc close");
  });
  test("Enter keeps the results and gives the keys back; / resumes typing; Esc closes", async () => {
    const h = await unlocked();
    await h.keys("/");
    await h.type("jira");
    await h.keys("enter");
    expect(h.app.main!.search!.typing).toBe(false);
    expect(h.lines()[1]).toContain("/ jira │");
    await h.keys("c");
    expect(h.backend.log).toContain("copy password work/jira");
    await h.keys("/", "backspace");
    expect(h.app.main!.search!.query.value).toBe("jir");
    await h.keys("enter", "esc");
    expect(h.app.main!.search).toBeNull();
  });
  test("Enter with no results closes the search; No matches.", async () => {
    const h = await unlocked();
    await h.keys("/");
    await h.type("zzzz");
    expect(flat(h)).toContain("No matches.");
    await h.keys("enter");
    expect(h.app.main!.search).toBeNull();
  });
  test("a tag match shows #tag at the right", async () => {
    const h = await unlocked({ entries: [{ path: "zz", tags: ["mytag"] }, { path: "other" }] });
    await h.keys("/");
    await h.type("mytag");
    expect(h.lines()[3]).toContain("#mytag");
  });
  test("Tab closes it and switches the view; Ctrl-C closes it (audit #19's fix)", async () => {
    const h = await unlocked();
    await h.keys("/", "x", "tab");
    expect(h.app.main!.search).toBeNull();
    expect(h.app.main!.view).toBe("tags");
    await h.keys("/", "x", "ctrl+c");
    expect(h.app.main!.search).toBeNull();
    expect(h.app.screen).toBe("main");
  });
  test("a paste must be one line", async () => {
    const h = await unlocked();
    await h.keys("/");
    await h.paste("a\nb");
    expect(flat(h)).toContain("Paste refused: one line only.");
    await h.paste("jira\n");
    expect(h.app.main!.search!.query.value).toBe("jira");
  });
});

describe("cursor (tui.md §5.5)", () => {
  test("each list keeps its own cursor across view switches", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "tab", "j", "tab");
    expect(h.app.selectedEntry()).toBeNull();
    const l = h.app.list();
    expect(l.rows[h.app.cursorIndex(l)]!.text).toBe("work");
  });
  test("a gone item: the nearest row at the same index", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "j", "d", "y");
    expect(flat(h)).toContain("Deleted github.");
    const l = h.app.list();
    expect(l.rows[h.app.cursorIndex(l)]!.text).toBe("work");
  });
});

// ---------------------------------------------------------------------------

describe("reveal (tui.md §6.3, S5)", () => {
  test("10 s, counting down; then hidden", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "j", "r");
    expect(flat(h)).toContain("root-pass");
    expect(flat(h)).toContain("shown for 10 s more (r hides)");
    await h.tick(3000);
    expect(flat(h)).toContain("shown for 7 s more (r hides)");
    await h.tick(7000);
    expect(flat(h)).not.toContain("root-pass");
    expect(flat(h)).toContain(MASK);
  });
  test("r again hides; moving the cursor hides", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "j", "r", "r");
    expect(flat(h)).not.toContain("root-pass");
    await h.keys("r", "k", "j");
    expect(flat(h)).not.toContain("root-pass");
  });
  test("a form opening hides; a reveal belongs to one entry", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "j", "r", "e", "esc");
    expect(h.app.main!.reveal).toBeNull();
  });
});

describe("copy (tui.md §7.1)", () => {
  test("Copying…, a live countdown, Clearing…, Clipboard cleared.", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "j");
    h.send({ type: "key", key: "c", text: "c" });
    expect(flat(h)).toContain("Copying…");
    await h.settle();
    expect(h.backend.clipboard).toEqual(["root-pass"]);
    expect(flat(h)).toContain("Password copied · clears in 30 s (L clears it now)");
    expect(flat(h)).not.toContain("root-pass");
    await h.tick(9000);
    expect(flat(h)).toContain("Password copied · clears in 21 s (L clears it now)");
    await h.tick(21_000);
    expect(flat(h)).toContain("Clearing the clipboard…");
    h.backend.fireClear();
    await h.settle();
    expect(flat(h)).toContain("Clipboard cleared.");
    expect(h.backend.clipboard).toEqual(["root-pass", ""]);
  });
  test("u copies the username; an empty value copies nothing", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "j", "u");
    expect(flat(h)).toContain("github has no username.");
    expect(h.backend.clipboard).toEqual([]);
    await h.keys("k", "l", "j", "u");
    expect(flat(h)).toContain("Username copied · clears in 30 s (L clears it now)");
  });
  test("no clipboard: a sticky error with the hint", async () => {
    const h = await unlocked({ clipboard: "none" });
    await h.keys("j", "j", "j", "c");
    expect(flat(h)).toContain("no clipboard: clipboard.osc52 is off and clipboard.command is empty; copy with: passh show github --field password | pbcopy");
    await h.tick(20_000);
    expect(flat(h)).toContain("no clipboard:");
  });
  test("a failed copy: Not copied", async () => {
    const h = await unlocked({ clipboard: "fails" });
    await h.keys("j", "j", "j", "c");
    expect(flat(h)).toContain("Not copied: write /dev/tty: input/output error");
  });
  test("a later copy replaces the earlier one's schedule", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "j", "c", "k", "l", "j", "u");
    expect(flat(h)).toContain("Username copied");
    h.backend.fireClear();
    await h.settle();
    expect(flat(h)).toContain("Clipboard cleared.");
  });
  test("a failed clear is reported, never as cleared", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "j", "c");
    h.backend.clearFails = new Error("clipboard command failed");
    h.backend.fireClear();
    await h.settle();
    expect(flat(h)).toContain("Clearing the clipboard failed: clipboard command failed");
    expect(flat(h)).not.toContain("Clipboard cleared.");
  });
});

// ---------------------------------------------------------------------------

describe("add, edit, move, tags, delete (tui.md §7.2–§7.6)", () => {
  test("add: the prompt starts with the folder; path checks; the form; Added", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "a");
    expect(flat(h)).toContain("New entry's path: work/");
    await h.keys("ctrl+u");
    await h.type("work//x");
    await h.keys("enter");
    expect(flat(h)).toContain("invalid path: it has an empty segment (//)");
    await h.keys("ctrl+u");
    await h.type("work/jira");
    await h.keys("enter");
    expect(flat(h)).toContain("work/jira already exists: e edits it.");
    await h.keys("ctrl+u");
    await h.type("work/new");
    await h.keys("enter");
    expect(h.lines()[1]).toBe("add work/new");
    await h.type("pw1");
    await h.keys("tab");
    await h.type("bob");
    await h.keys("ctrl+s");
    expect(flat(h)).toContain("Added work/new.");
    expect(h.app.selectedEntry()?.path).toBe("work/new");
    expect(flat(h)).toContain("▾ work");
    expect(h.backend.disk.entries.find((e) => e.path === "work/new")).toMatchObject({ password: "pw1", username: "bob" });
  });
  test("add on an entry row: its folder; on a root entry: empty", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "l", "j", "a");
    expect(h.app.main!.overlay).toMatchObject({ kind: "prompt" });
    expect((h.app.main!.overlay as { prompt: { input: { value: string } } }).prompt.input.value).toBe("work/");
    await h.keys("esc");
    expect(h.app.main!.overlay).toBeNull();
    await h.keys("G", "a");
    expect((h.app.main!.overlay as { prompt: { input: { value: string } } }).prompt.input.value).toBe("");
  });
  test("edit: Saved, or No changes.; the TUI's status under the form", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "j", "e");
    expect(h.lines()[0]).toBe("passh · unlocked · locks in 5:00");
    expect(h.lines()[1]).toBe("edit github");
    await h.keys("ctrl+s");
    expect(flat(h)).toContain("No changes.");
    await h.keys("e", "tab", "tab");
    await h.type("https://x");
    await h.keys("ctrl+s");
    expect(flat(h)).toContain("Saved github.");
    expect(h.backend.disk.entries.find((e) => e.id === "root")!.url).toBe("https://x");
  });
  test("a cancelled form: Cancelled.", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "j", "e", "esc");
    expect(flat(h)).toContain("Cancelled.");
  });
  test("a failed save reopens the form with every value and Not saved", async () => {
    const h = await unlocked();
    h.backend.saveFails = new Error("vault is being saved by another passh process; nothing was saved: try again");
    await h.keys("j", "j", "j", "e", "tab");
    await h.type("bob");
    await h.keys("ctrl+s");
    expect(h.app.main!.overlay?.kind).toBe("form");
    expect(flat(h)).toContain("Not saved: vault is being saved by another passh process; nothing was saved: try again");
    expect(flat(h)).toContain("username  bob");
    await h.keys("esc");
    expect(flat(h)).toContain("Discard the changes?");
  });
  test("move: same path closes silently; Moved; a taken destination reopens the prompt", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "j", "m");
    expect(flat(h)).toContain("Move to: github");
    await h.keys("enter");
    expect(h.app.main!.overlay).toBeNull();
    await h.keys("m", "ctrl+u");
    await h.type("work/jira");
    await h.keys("enter");
    expect(flat(h)).toContain("work/jira: already exists");
    expect(h.app.main!.overlay?.kind).toBe("prompt");
    await h.keys("ctrl+u");
    await h.type("misc/gh");
    await h.keys("enter");
    expect(flat(h)).toContain("Moved github to misc/gh.");
    expect(h.app.selectedEntry()?.path).toBe("misc/gh");
  });
  test("tags: added ones follow in the order typed; No changes. when the set is the same", async () => {
    const h = await unlocked({ entries: [{ path: "x", id: "x", tags: ["a", "b"] }] });
    await h.keys("t");
    expect(flat(h)).toContain("Tags (comma-separated): a, b");
    await h.keys("ctrl+u");
    await h.type("b, a");
    await h.keys("enter");
    expect(flat(h)).toContain("No changes.");
    await h.keys("t", "ctrl+u");
    await h.type("c, b, a");
    await h.keys("enter");
    expect(flat(h)).toContain("Tags of x saved.");
    expect(h.backend.disk.entries[0]!.tags).toEqual(["a", "b", "c"]);
    await h.keys("t", "ctrl+u");
    await h.type("ok, ba\x01d");
    await h.keys("enter");
    expect(flat(h)).toContain('invalid tag "ba\\x01d": it contains a control character');
  });
  test("prompts: a paste with a line break is refused; Ctrl-C cancels", async () => {
    const h = await unlocked();
    await h.keys("a");
    await h.paste("a\nb");
    expect(flat(h)).toContain("Paste refused: one line only.");
    await h.keys("ctrl+c");
    expect(h.app.main!.overlay).toBeNull();
    expect(h.app.screen).toBe("main");
  });
  test("delete: y deletes; any other key: Not deleted.; the open detail closes", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "j", "d");
    expect(flat(h)).toContain("Delete github? [y/N]");
    expect(flat(h)).toContain("y yes · any other key: no");
    for (const k of ["n", "esc", "enter", "ctrl+c"]) {
      await h.keys(k);
      expect(flat(h)).toContain("Not deleted.");
      expect(h.app.screen).toBe("main");
      await h.keys("d");
    }
    await h.keys("esc", "enter", "d", "Y");
    expect(flat(h)).toContain("Deleted github.");
    expect(h.app.main!.detail).toBeNull();
    expect(h.backend.disk.deleted.map((t) => t.id)).toEqual(["root"]);
  });
  test("delete: L locks instead", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "j", "d", "L");
    expect(h.app.screen).toBe("lock");
    expect(h.backend.disk.entries.length).toBe(5);
  });
  test("one save at a time: Busy messages", async () => {
    const h = await unlocked();
    h.backend.saveGate = gate();
    await h.keys("j", "j", "j", "d", "y");
    expect(flat(h)).toContain("Saving…");
    for (const k of ["e", "a", "t", "m", "d"]) {
      await h.keys(k);
      expect(flat(h)).toContain("Busy: wait for the save to finish.");
      expect(h.app.main!.overlay).toBeNull();
    }
    await h.keys("R");
    expect(flat(h)).toContain("Busy: wait for the save to finish.");
    h.backend.saveGate.open();
    await h.settle();
    expect(flat(h)).toContain("Deleted github.");
  });
});

// ---------------------------------------------------------------------------

describe("changed on disk, kept input and reload (tui.md §8)", () => {
  test("the poll sets the banner; changes are refused; copy and browsing still work", async () => {
    const h = await unlocked();
    h.backend.editOnDisk((d) => d.entries.push({ ...d.entries[0]!, id: "n", path: "other" }));
    await h.tick(1000);
    expect(h.app.main!.banner).toBe(false);
    await h.tick(1000);
    expect(flat(h)).toContain("Vault changed on disk — R to reload. Saving is blocked until then.");
    await h.keys("j", "j", "j", "e");
    expect(flat(h)).toContain("The vault changed on disk: R reloads it. Changes are blocked until then.");
    expect(h.app.main!.overlay).toBeNull();
    await h.keys("c");
    expect(h.backend.clipboard).toEqual(["root-pass"]);
    await h.keys("R");
    expect(flat(h)).toContain("Reloaded: revision 2, 6 entries.");
    expect(flat(h)).not.toContain("Vault changed on disk");
  });
  test("the TUI's own saves don't set the banner", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "j", "d", "y");
    await h.tick(2000);
    await h.tick(2000);
    expect(h.app.main!.banner).toBe(false);
  });
  test("a failed check is shown once and doesn't block saving", async () => {
    const h = await unlocked();
    h.backend.checkFails = new Error("stat /v: permission denied");
    await h.tick(2000);
    expect(flat(h)).toContain("Checking the vault file failed: stat /v: permission denied");
    await h.tick(8000);
    expect(flat(h)).not.toContain("Checking the vault file failed");
    await h.tick(2000);
    expect(flat(h)).not.toContain("Checking the vault file failed");
    await h.keys("j", "j", "j", "d", "y");
    expect(flat(h)).toContain("Deleted github.");
  });
  test("a save refused by a change keeps the form; R brings it back", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "j", "e", "tab");
    await h.type("bob");
    h.backend.editOnDisk((d) => d.entries.push({ ...d.entries[0]!, id: "n", path: "other" }));
    await h.keys("ctrl+s");
    expect(h.app.main!.overlay).toBeNull();
    expect(flat(h)).toContain("Not saved: the vault changed on disk. R reloads it; your input is kept.");
    expect(flat(h)).toContain("Vault changed on disk — R to reload.");
    await h.keys("R");
    expect(h.app.main!.overlay?.kind).toBe("form");
    expect(flat(h)).toContain("username  bob");
    expect(flat(h)).toContain("Reloaded: your input is back; ctrl+s saves it.");
    await h.keys("ctrl+s");
    expect(flat(h)).toContain("Saved github.");
    expect(h.backend.disk.entries.find((e) => e.id === "root")!.username).toBe("bob");
  });
  test("the form open while the banner appears: Ctrl-S keeps the input", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "j", "e", "tab");
    await h.type("bob");
    h.backend.editOnDisk(() => {});
    await h.tick(2000);
    expect(flat(h)).toContain("Vault changed on disk: saving is refused; your input is kept for after R.");
    await h.keys("ctrl+s");
    expect(flat(h)).toContain("Not saved: the vault changed on disk. R reloads it; your input is kept.");
    expect(h.backend.log.filter((l) => l === "save").length).toBe(0);
  });
  test("the entry was deleted on disk: an add form, not saved yet", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "j", "e", "tab");
    await h.type("bob");
    h.backend.editOnDisk((d) => (d.entries = d.entries.filter((e) => e.id !== "root")));
    await h.keys("ctrl+s", "R");
    expect(h.lines()[1]).toBe("add github (not saved yet)");
    expect(flat(h)).toContain("github was deleted on disk: saving adds it again.");
    await h.keys("esc");
    expect(flat(h)).toContain("Discard the changes that weren't saved? esc: discard · any other key: keep editing");
    await h.keys("x");
    await h.keys("ctrl+s");
    expect(flat(h)).toContain("Added github.");
    const e = h.backend.disk.entries.find((x) => x.path === "github")!;
    expect(e.id).not.toBe("root");
    expect(e.username).toBe("bob");
    expect(e.password).toBe("root-pass");
  });
  test("the entry changed on disk: the user's changes over the new values", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "j", "e", "tab");
    await h.type("bob");
    h.backend.editOnDisk((d) => {
      const e = d.entries.find((x) => x.id === "root")!;
      e.url = "https://new";
      e.path = "moved/github";
      e.updatedAt += 5;
    });
    await h.keys("ctrl+s", "R");
    expect(h.lines()[1]).toBe("edit moved/github (not saved yet)");
    expect(flat(h)).toContain("Reloaded: your input is back; ctrl+s saves it. It changed on disk too; the other values are the new ones.");
    expect(flat(h)).toContain("username  bob");
    expect(flat(h)).toContain("url  https://new");
    await h.keys("ctrl+s");
    expect(flat(h)).toContain("Saved moved/github.");
    const e = h.backend.disk.entries.find((x) => x.id === "root")!;
    expect([e.username, e.url, e.path]).toEqual(["bob", "https://new", "moved/github"]);
  });
  test("a kept prompt is reopened and applies to the reloaded entry", async () => {
    const h = await unlocked({ entries: [{ path: "x", id: "x", tags: ["a"] }] });
    await h.keys("t", "ctrl+u");
    await h.type("a, b");
    h.backend.editOnDisk((d) => (d.entries[0]!.tags = ["a", "z"]));
    await h.keys("enter");
    expect(flat(h)).toContain("your input is kept");
    await h.keys("R");
    expect(flat(h)).toContain("Tags (comma-separated): a, b");
    await h.keys("enter");
    expect(h.backend.disk.entries[0]!.tags).toEqual(["a", "b"]);
  });
  test("a delete refused by a change keeps nothing", async () => {
    const h = await unlocked();
    h.backend.editOnDisk(() => {});
    h.backend.changedOnDisk = true;
    await h.keys("j", "j", "j", "d", "y");
    expect(flat(h)).toContain("Not deleted: the vault changed on disk. R reloads it; then delete again.");
    await h.keys("R");
    expect(h.app.main!.overlay).toBeNull();
  });
  test("reload failures", async () => {
    const h = await unlocked();
    h.backend.reloadRekeyed = true;
    await h.keys("R");
    expect(flat(h)).toContain("Reload failed: the vault was rekeyed elsewhere: lock (L) and unlock with its current passphrase");
  });
  test("the title reads reloading… and a second R is refused", async () => {
    const h = await unlocked();
    h.backend.reloadRollback = "this copy is older …";
    await h.keys("R");
    expect(flat(h)).toContain("Warning: this copy is older … Continue with this copy? [y/N]");
    expect(h.lines()[0]).toContain("reloading…");
    await h.keys("n");
    expect(flat(h)).toContain("Reload failed: stopped: this copy is older than one seen before on this machine; nothing was changed");
  });
  test("the reload's rollback question: y continues; L locks; Ctrl-C quits", async () => {
    const h = await unlocked();
    h.backend.editOnDisk(() => {});
    h.backend.reloadRollback = "older";
    await h.keys("R", "y");
    expect(flat(h)).toContain("Reloaded: revision 2, 5 entries.");
    h.backend.reloadRollback = "older";
    await h.keys("R", "L");
    expect(h.app.screen).toBe("lock");
    const g = await unlocked();
    g.backend.reloadRollback = "older";
    await g.keys("R", "ctrl+c");
    expect(g.app.screen).toBe("bye");
  });
  test("cursor, expansion and tag selection survive a reload where items still exist", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "enter", "j", "tab", "space", "tab");
    h.backend.editOnDisk(() => {});
    await h.keys("R");
    expect(flat(h)).toContain("▾ work");
    expect(h.app.selectedEntry()?.id).toBe("gh");
    await h.keys("tab");
    expect(flat(h)).toContain("[x] 2fa");
  });
});

// ---------------------------------------------------------------------------

describe("locking (tui.md §10)", () => {
  test("L: locking…, then Locked.; the order of a lock", async () => {
    const h = await unlocked({ agent: "serves" });
    await h.keys("j", "j", "j", "c");
    h.backend.log.length = 0;
    h.send({ type: "key", key: "L", text: "L" });
    expect(h.app.screen).toBe("lock");
    expect(h.app.main).toBeNull();
    expect(flat(h)).toContain("locking…");
    await h.settle();
    expect(h.backend.log).toEqual(["close", "clear-now", "agent-stop", "agent-status"]);
    expect(h.app.lock.messages).toEqual([{ text: "Locked. Clipboard cleared. Agent stopped.", style: "info" }]);
    expect(h.app.lock.agentHint).toBe(false);
  });
  test("with stop_agent off, the agent hint appears and Enter on an empty field uses it", async () => {
    const h = await unlocked({ agent: "serves", config: { stopAgent: false } });
    await h.keys("L");
    expect(h.app.lock.agentHint).toBe(true);
    expect(flat(h)).toContain("An agent is running for this vault: Enter with an empty passphrase unlocks with it.");
    await h.keys("enter");
    expect(h.app.screen).toBe("main");
  });
  test("after a lock without an agent, Enter on an empty field asks for the passphrase", async () => {
    const h = await unlocked();
    await h.keys("L", "enter");
    expect(flat(h)).toContain("Type the passphrase, then Enter.");
    expect(h.backend.log.filter((l) => l === "agent-key").length).toBe(1);
  });
  test("a lock wipes everything; nothing comes back after unlocking", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "enter", "tab", "space", "/", "g");
    await h.keys("esc", "L");
    await h.type("secret");
    await h.keys("enter");
    const m = h.app.main!;
    expect(m.view).toBe("folders");
    expect(m.expanded.size).toBe(0);
    expect(m.tagSel).toEqual([]);
    expect(m.search).toBeNull();
  });
  test("the idle lock after session.idle_ttl, counted from the last key", async () => {
    const h = await unlocked();
    await h.tick(299_000);
    expect(h.app.screen).toBe("main");
    await h.keys("j");
    await h.tick(299_000);
    expect(h.app.screen).toBe("main");
    await h.tick(1000);
    expect(h.app.screen).toBe("lock");
    await h.settle();
    expect(flat(h)).toContain("Locked after 5 min without input.");
  });
  test("the idle lock counts wall-clock time while the machine sleeps (audit #1's fix)", async () => {
    const h = await unlocked();
    h.clock.w += 400_000;
    await h.tick(1000);
    expect(h.app.screen).toBe("lock");
  });
  test("the idle lock includes forms and drops their input", async () => {
    const h = await unlocked({ config: { idleTtlMs: 90_000 } });
    await h.keys("j", "j", "j", "e", "tab");
    await h.type("bob");
    await h.tick(90_000);
    expect(h.app.screen).toBe("lock");
    await h.settle();
    expect(flat(h)).toContain("Locked after 1m30s without input.");
    expect(h.backend.log).not.toContain("save");
  });
  test("a lock during a save waits for it and reports it", async () => {
    const h = await unlocked();
    h.backend.saveGate = gate();
    await h.keys("j", "j", "j", "d", "y");
    h.send({ type: "key", key: "L", text: "L" });
    expect(flat(h)).toContain("locking: the change to github is still being saved…");
    h.backend.saveGate.open();
    await h.settle();
    // the save's signal was aborted before it ran: the lock came first
    expect(h.app.lock.messages).toEqual([{ text: "Not saved (github): the lock came before it was written. Locked.", style: "error" }]);
  });
  test("lock failures are reported in the error style", async () => {
    const h = await unlocked({ agent: "serves" });
    await h.keys("j", "j", "j", "c");
    h.backend.clearFails = new Error("boom");
    h.backend.agentStopFails = new Error("agent: refusing");
    await h.keys("L");
    expect(h.app.lock.messages).toEqual([{ text: "Locked. Clearing the clipboard failed: boom. Stopping the agent failed: agent: refusing.", style: "error" }]);
  });
});

describe("quitting and signals (tui.md §1.2)", () => {
  test("q locks with reason exit: no clipboard clear, the agent stopped; then the wait", async () => {
    const h = await unlocked({ agent: "serves" });
    await h.keys("j", "j", "j", "c");
    h.backend.log.length = 0;
    await h.keys("q");
    expect(h.app.screen).toBe("bye");
    expect(h.backend.log).toEqual(["close", "agent-stop"]);
    expect(h.app.exit).toEqual({ code: 0, lines: [], waitClear: true });
    expect(h.backend.pendingClear()).not.toBeNull();
  });
  test("a save running at quit is reported after the TUI", async () => {
    const h = await unlocked();
    h.backend.saveGate = gate();
    await h.keys("j", "j", "j", "e", "tab");
    await h.type("bob");
    await h.keys("ctrl+s");
    h.send({ type: "key", key: "q", text: "q" });
    h.backend.saveGate.open();
    await h.settle();
    expect(h.app.exit!.lines).toEqual(["Not saved (github): the lock came before it was written."]);
  });
  test("SIGTERM: lock at once, clear the clipboard, exit 143", async () => {
    const h = await unlocked();
    await h.keys("j", "j", "j", "c");
    h.backend.log.length = 0;
    h.send({ type: "signal", sig: "SIGTERM" });
    await h.settle();
    expect(h.backend.log).toEqual(["close", "clear-now", "agent-stop"]);
    const err = h.app.exit!.error as SignalError;
    expect(err).toBeInstanceOf(SignalError);
    expect(err.message).toBe("locked and stopped: received terminated");
    expect(err.exitCode).toBe(143);
  });
  test("a signal on the lock screen: exit 128 + n", async () => {
    const h = new Harness({ entries: ENTRIES });
    await h.start();
    h.send({ type: "signal", sig: "SIGHUP" });
    expect((h.app.exit!.error as SignalError).exitCode).toBe(129);
  });
  test("a signal drops a pending rollback question", async () => {
    const h = new Harness({ entries: ENTRIES, rollback: "older" });
    await h.start("secret");
    h.send({ type: "signal", sig: "SIGINT" });
    await h.settle();
    expect((h.app.exit!.error as SignalError).exitCode).toBe(130);
    expect(h.backend.sessions[0]!.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("print setup and dialog (tui.md §7.8, §7.9)", () => {
  test("off in the config", async () => {
    const h = await unlocked();
    await h.keys("P");
    expect(flat(h)).toContain("The print page is off: set enabled = true in the [print_web] table of the config file (print_web.enabled).");
  });
  test("defaults: the folder in the Folders view, the tags in the Tags view, else all", async () => {
    const h = await unlocked({ config: { printWebEnabled: true } });
    await h.keys("P");
    let t = h.text();
    expect(t).toContain("Print page: what to print");
    expect(t).toContain("(•) folder bank/ (1 entry)");
    expect(t).toContain("( ) all entries (5 entries)");
    expect(t).toContain("[x] password");
    expect(t).toContain("[ ] custom fields");
    expect(t).toContain("↑↓ move · space choose · Enter continue · Esc cancel · L lock");
    await h.keys("esc");
    expect(flat(h)).toContain("Print page cancelled.");
    await h.keys("tab", "j", "space", "P");
    t = h.text();
    expect(t).toContain("(•) tags dev (3 entries)");
    await h.keys("esc", "tab", "G", "P");
    expect(flat(h)).toContain("(•) all entries (5 entries)");
  });
  test("refusals; PRINT; the dialog; Tab; c; Esc stops", async () => {
    const h = await unlocked({ config: { printWebEnabled: true } });
    await h.keys("P", "j", "x", "j", "space", "j", "space");
    await h.keys("enter");
    expect(flat(h)).toContain("Choose at least one field.");
    await h.keys("k", "k", "x", "k", "x", "j", "j", "x", "enter");
    expect(flat(h)).toContain("Type PRINT to start the print page: ");
    await h.type("print");
    await h.keys("enter");
    expect(flat(h)).toContain("Not confirmed: the print page wasn't started.");
    await h.keys("P", "enter");
    await h.type("PRINT");
    await h.keys("enter");
    expect(h.backend.log).toContain("print folder password,username,url");
    const t = h.text();
    expect(h.lines()[0]).toBe("passh · print page · unlocked · locks in 5:00");
    expect(t).toContain("https://192.168.1.10:8443/p/kq7ZtokenTOKENtoken0");
    expect(t).toContain("(1 of 2, Tab: next)");
    expect(t).toContain("Certificate fingerprint (SHA-256); the browser must show the same:");
    expect(t).toContain("made a new certificate for the print page");
    expect(t).toContain("Not used: lo: 127.0.0.1 is a loopback address, not private");
    expect(t).toContain("Stops in 5:00, after the page is loaded once, or with Esc.");
    expect(t).toContain("c copy URL · Tab next URL · ↑↓ scroll · Esc stop");
    await h.keys("tab");
    expect(flat(h)).toContain("https://[fd12:3456::1]:8443/p/");
    expect(flat(h)).toContain("(no QR code for this address)");
    await h.keys("c");
    expect(flat(h)).toContain("URL copied · the clipboard clears in 30s.");
    expect(h.backend.clipboard[0]).toContain("fd12:3456::1");
    await h.keys("L");
    expect(h.app.screen).toBe("lock");
    expect(h.backend.printPages[0]!.stops).toBe(1);
  });
  test("the page stops by itself: the outcome; any key closes", async () => {
    const h = await unlocked({ config: { printWebEnabled: true } });
    await h.keys("P", "enter");
    await h.type("PRINT");
    await h.keys("enter");
    h.backend.printPages[0]!.serve();
    await h.tick(1000);
    expect(flat(h)).toContain("Print page stopped");
    expect(flat(h)).toContain("the page was served to 192.168.1.23");
    await h.keys("x");
    expect(flat(h)).toContain("Print page: the page was served to 192.168.1.23; if that wasn't you, start the print page again.");
  });
  test("Esc stops the server; the dialog closes when it has stopped", async () => {
    const h = await unlocked({ config: { printWebEnabled: true } });
    await h.keys("P", "enter");
    await h.type("PRINT");
    await h.keys("enter", "esc");
    expect(h.app.main!.overlay).toBeNull();
    expect(flat(h)).toContain("Print page: the print page was stopped.");
  });
  test("a failure to start: Print page: <error>", async () => {
    const h = await unlocked({ config: { printWebEnabled: true } });
    h.backend.printFails = new Error("the print page has no private address to listen on (print_web.interfaces): wg0: no such network interface");
    await h.keys("P", "enter");
    await h.type("PRINT");
    await h.keys("enter");
    expect(flat(h)).toContain("Print page: the print page has no private address");
  });
});
