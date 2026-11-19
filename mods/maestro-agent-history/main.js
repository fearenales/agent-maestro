// Back and forward through the agents you looked at, like a browser's history.
// Lives in the status bar: its buttons, and the keys bound to
// "maestro-agent-history.back" / "maestro-agent-history.forward", step through the visits.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, focused, run, theme, keys, window, checking, nextCommand, shared, setShared } from "herdr";

const LIMIT = 100;  // visits kept

// When each agent tab last had the focus, for the Tasks switcher's "last viewed" order.
// Same shared key and format the tasks mod uses: { "tab:<id>": ms }, newest 400 kept.
const VIEWED = "maestro.viewed";
function markViewed(key) {
  const v = { ...(shared(VIEWED) ?? {}), [key]: Date.now() };
  setShared(VIEWED, Object.fromEntries(Object.entries(v).sort((a, b) => b[1] - a[1]).slice(0, 400)));
}

// An agent's title without the status glyph it starts with.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").trim();

// The key bound to a command, as macOS writes it ("⌘["), or "".
function shortcut(action) {
  const mac = window()?.platform === "macos";
  const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+" };
  const b = keys().find((k) => k.section === "global" && k.action === action);
  return b ? b.keys.split("-").map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("") : "";
}

export default class AgentHistory extends View {
  init(_props, cx) {
    this.visits = []; this.at = -1; this.going = null; this.seen = null; this.unsaved = null;
    if (checking()) return;
    // Rendering only notes the new focus; saving it here keeps shared state out of render.
    cx.timer.every(1000, () => {
      const address = this.unsaved;
      this.unsaved = null;
      const tab = address && agents().find((a) => a.address === address)?.tab;
      if (tab) markViewed(`tab:${tab}`);
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "back") this.step(-1, cx);
        else if (command === "forward") this.step(1, cx);
      }
    });
  }

  // Records the focused agent: a new visit drops the forward history, as in a browser.
  record() {
    const address = focused()?.agent ?? null;
    if (address && address !== this.seen) { this.seen = address; this.unsaved = address; }
    if (!address || address === this.visits[this.at]) return;
    if (address === this.going) { this.going = null; return; }
    this.visits = [...this.visits.slice(0, this.at + 1).filter((a) => a !== address), address].slice(-LIMIT);
    this.at = this.visits.length - 1;
  }

  // The nearest visit in that direction whose agent is still open.
  target(direction) {
    const open = new Set(agents().map((a) => a.address));
    for (let i = this.at + direction; i >= 0 && i < this.visits.length; i += direction) {
      if (open.has(this.visits[i])) return i;
    }
    return -1;
  }

  step(direction, cx) {
    const i = this.target(direction);
    if (i < 0) return;
    this.at = i; this.going = this.visits[i];
    run("agent.focus", { terminal: this.visits[i] });
    cx.notify();
  }

  render() {
    this.record();
    const t = theme(), list = agents();
    const name = (i) => {
      const a = list.find((x) => x.address === this.visits[i]);
      return a ? clean(a.title) || a.space_name : "";
    };
    const button = (id, icon, direction, label, action) => {
      const i = this.target(direction), on = i >= 0, key = shortcut(action);
      return div().id(id).size(20).flex().items_center().justify_center().rounded(5)
        .text_color(on ? t.muted : t.border)
        .when(on, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(`${label}: ${name(i)}${key ? `  ${key}` : ""}`)
          .on_click((_e, cx) => this.step(direction, cx)))
        .child(svg(`mods/maestro-agent-history/${icon}.svg`).size(13));
    };
    return h_flex().size_full().pl(8).gap(2).items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .child(button("history-back", "chevron-left", -1, "Back", "maestro-agent-history.back"))
      .child(button("history-forward", "chevron-right", 1, "Forward", "maestro-agent-history.forward"));
  }
}
