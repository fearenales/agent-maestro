import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, home, readTextFile, checking } from "herdr";

// What Claude Code last reported: ~/.claude/statusline.py writes latest.json with the account-wide limits.
const SNAPSHOTS = `${home()}/.claude/herdr`;

async function snapshot(name) {
  try { return JSON.parse(await readTextFile(`${SNAPSHOTS}/${name}.json`) ?? "null"); } catch { return null; }
}

// Blue, then yellow from 70%, magenta from 90%: never colour alone, the number is always shown.
const ramp = (t, pct) => pct >= 90 ? t.ansi5 : pct >= 70 ? t.ansi3 : t.ansi4;

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.limits = null;
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  // The account's usage limits.
  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const limits = (await snapshot("latest"))?.rate_limits ?? null;
        if (JSON.stringify(limits) !== JSON.stringify(this.limits)) { this.limits = limits; cx.notify(); }
      } finally { this.loading = false; }
    });
  }

  // "5h 4%", with the time left until it resets once it starts to matter.
  limit(t, label, w) {
    const pct = Math.round(w.used_percentage), left = (w.resets_at ?? 0) * 1000 - Date.now();
    const mins = Math.round(left / 60000), reset = left > 0 ? (mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m` : `${mins}m`) : null;
    return h_flex().id(`limit-${label}`).gap(4).items_center().text_color(ramp(t, pct))
      .tooltip(`${label === "5h" ? "5-hour" : "7-day"} usage limit${reset ? `, resets in ${reset}` : ""}`)
      .child(`${label} ${pct}%`)
      .when(pct >= 70 && Boolean(reset), (el) => el.child(div().text_color(t.dim).child(`→ ${reset}`)));
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .when(typeof this.limits?.five_hour?.used_percentage === "number", el => el.child(this.limit(t, "5h", this.limits.five_hour)))
      .when(typeof this.limits?.seven_day?.used_percentage === "number", el => el.child(this.limit(t, "7d", this.limits.seven_day)))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
