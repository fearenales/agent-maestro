import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { agents, focused, exec, appHome, run, theme, settings, checking } from "herdr";

const LIMIT = 80;          // commands kept in the list
const PREVIEW = 12;        // output lines shown before expanding
const COMMAND_PREVIEW = 6; // command lines shown before expanding
const WIDE = 600;          // characters kept per line

// Drops an agent title's status glyph.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").trim();
// A theme colour at another alpha; theme colours may already carry one.
const fade = (color, alpha) => /^#[0-9a-f]{6}/i.test(color) ? color.slice(0, 7) + alpha : color;
const clock = (ms) => ms ? new Date(ms).toTimeString().slice(0, 8) : "";
const took = (e) => {
  if (!e.ended || !e.at) return "";
  const s = (e.ended - e.at) / 1000;
  return s < 1 ? "" : s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
};
// Text draws a tab as nothing, and one very long line is slow to lay out.
const lines = (text) => text.split("\n").map((l) => l.replace(/\t/g, "    ")).map((l) => l.length > WIDE ? l.slice(0, WIDE) + "…" : l);

export default class Commands extends View {
  init(_props, cx) {
    this.entries = []; this.claude = []; this.raw = ""; this.open = {}; this.error = null;
    this.scope = localStorage.getItem("scope") === "focused" ? "focused" : "all";
    this.cleared = Number(localStorage.getItem("cleared")) || 0;
    if (checking()) return;
    this.refresh(cx);
    // Every second while a command streams, every other second otherwise.
    this.tick = 0;
    cx.timer.every(1000, (cx) => { if (this.entries.some((e) => e.running) || this.tick++ % 2 === 0) this.refresh(cx); });
  }

  // Asks feed.py for the agents' latest commands; redraws only when they changed.
  refresh(cx) {
    if (this.loading) return;
    // Transcripts are read on this machine only.
    const addresses = agents().map((a) => a.address).filter((a) => !a.includes("/"));
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", ["-I", `${appHome()}/mods/maestro-commands/feed.py`, String(LIMIT), ...addresses], { timeout: 15000 });
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `feed.py exited ${r.code}`);
        if (r.stdout !== this.raw || this.error) {
          const feed = JSON.parse(r.stdout);
          this.raw = r.stdout; this.entries = feed.entries; this.claude = feed.agents; this.error = null;
          cx.notify();
        }
      } catch (e) {
        const message = String(e?.message ?? e);
        if (message !== this.error) { this.error = message; cx.notify(); }
      } finally { this.loading = false; }
    });
  }

  entry(e, t, mono, names) {
    const open = Boolean(this.open[e.id]);
    const command = lines(e.command), output = e.output ? lines(e.output) : [];
    const shownCommand = open ? command : command.slice(0, COMMAND_PREVIEW);
    // A stream shows its newest lines, a finished command its first.
    const tail = e.live || e.background;
    const shownOutput = open ? output : tail ? output.slice(-PREVIEW) : output.slice(0, PREVIEW);
    const more = (command.length - shownCommand.length) + (output.length - shownOutput.length);
    const foldable = more > 0 || open && (command.length > COMMAND_PREVIEW || output.length > PREVIEW);
    const line = (text, color) => div().w_full().min_w(0).text_color(color).child(text || " ");
    return v_flex().id(`cmd-${e.id}`).w_full().flex_none().px(12).py(9).gap(5).border_b(1).border_color(t.border)
      .child(h_flex().w_full().gap(7).items_center().text_size(11)
        .child(e.running
          ? svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900)
          : div().size(7).flex_none().rounded(4).bg(e.error ? t.ansi1 : t.ansi2))
        .child(div().id(`agent-${e.id}`).min_w(0).truncate().font_semibold().text_color(t.muted).cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click(() => run("pane.focus", { terminal: e.terminal }))
          .child(names[e.terminal] ?? e.terminal))
        .when(e.background, (el) => el.child(div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.dim).child("background")))
        .when(e.sub, (el) => el.child(div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.dim).child("sub-agent")))
        .child(div().flex_1())
        .when(Boolean(took(e)), (el) => el.child(div().flex_none().text_color(t.dim).child(took(e))))
        .child(div().flex_none().text_color(t.dim).child(clock(e.at))))
      .when(Boolean(e.description), (el) => el.child(div().w_full().text_size(12).text_color(t.foreground).child(e.description)))
      .child(v_flex().w_full().min_w(0).px(9).py(6).rounded(6).bg(t.raised).font_family(mono).text_size(11.5)
        .children(shownCommand.map((l, i) => line((i === 0 ? "$ " : "  ") + l, t.accent))))
      .when(shownOutput.length > 0, (el) => el.child(v_flex().w_full().min_w(0).px(9).py(6).rounded(6).font_family(mono).text_size(11.5)
        .bg(e.error ? fade(t.ansi1, "18") : t.canvas).border_1().border_color(e.error ? fade(t.ansi1, "40") : t.border)
        .children(shownOutput.map((l) => line(l, e.error ? t.ansi1 : t.muted)))))
      .when(open && e.hidden > 0, (el) => el.child(div().px(9).text_size(11).text_color(t.dim).child(tail ? `${e.hidden} earlier lines not shown` : `Output cut here (${e.hidden} more lines in the transcript)`)))
      .when(foldable, (el) => el.child(div().id(`fold-${e.id}`).px(9).text_size(11).text_color(t.dim).cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { if (open) delete this.open[e.id]; else this.open[e.id] = true; cx.notify(); })
        .child(open ? "Show less" : `Show ${more} ${tail ? "earlier" : "more"} line${more === 1 ? "" : "s"}`)));
  }

  render() {
    const t = theme(), mono = settings().font_family ?? "JetBrains Mono";
    const all = agents(), names = {};
    for (const a of all) names[a.address] = clean(a.title) || `${a.space_name} · ${a.tab_name}`;
    const target = focused()?.agent ?? all.find((a) => a.focused)?.address ?? null;
    // Newest first, so a new command shows without scrolling.
    // Clear hides what had finished by then; a command still running stays.
    const kept = this.entries.filter((e) => e.running || e.at > this.cleared);
    const shown = (this.scope === "focused" ? kept.filter((e) => e.terminal === target) : kept).slice().reverse();
    const running = shown.filter((e) => e.running).length;
    const scope = (id, label) => div().id(`scope-${id}`).h(22).px(8).flex().items_center().rounded(5).text_size(11).cursor_pointer()
      .bg(this.scope === id ? t.selected : t.background).text_color(this.scope === id ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.scope = id; localStorage.setItem("scope", id); cx.notify(); })
      .child(label);
    const empty = this.error ? `Cannot read commands: ${this.error}`
      : !this.claude.length ? "No Claude Code agents running"
      : this.scope === "focused" ? "No commands from the focused agent yet" : "No commands yet";
    return v_flex().id("commands").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(String(shown.length)))
        .when(running > 0, (el) => el.child(div().text_size(11).text_color(t.working).child(`${running} running`)))
        .child(div().flex_1())
        .child(scope("all", "All agents")).child(scope("focused", "Focused"))
        .child(div().id("clear").h(22).px(8).flex().items_center().rounded(5).border_1().border_color(t.border).text_size(11).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.cleared = Date.now(); this.open = {}; localStorage.setItem("cleared", String(this.cleared)); cx.notify(); })
          .child("Clear")))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("commands-list").absolute().inset_0().overflow_y_scroll()
          .children(shown.map((e) => this.entry(e, t, mono, names)))
          .when(!shown.length, (el) => el.child(div().p(14).text_size(12).text_color(this.error ? t.ansi1 : t.dim).child(empty))))
        .child(Scrollbar.vertical("commands-list").absolute().inset_0()));
  }
}
