// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane-usage" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, layout, hc, readTextFile, checking } from "herdr";

// What Claude Code last reported for each session: ~/.claude/statusline.py writes
// ~/.claude/herdr/<session>.json, plus latest.json for the account-wide limits.
const SNAPSHOTS = `${home()}/.claude/herdr`;
const STALE = 15 * 60 * 1000;
const sessions = new Map();  // pid -> session id

// The Claude Code session running in the foreground of a terminal, or null.
async function sessionOf(address) {
  try {
    const r = await hc(["get", address, "--json"]);
    const pid = JSON.parse(r.stdout).foreground?.pid;
    if (!pid) return null;
    if (!sessions.has(pid)) {
      const id = JSON.parse(await readTextFile(`${home()}/.claude/sessions/${pid}.json`) ?? "{}").sessionId;
      if (!id) return null;
      sessions.set(pid, id);
    }
    return sessions.get(pid);
  } catch { return null; }
}

async function snapshot(name) {
  try { return JSON.parse(await readTextFile(`${SNAPSHOTS}/${name}.json`) ?? "null"); } catch { return null; }
}

// Blue, then yellow from 70%, magenta from 90%: never colour alone, the number is always shown.
const money = (usd) => `$${usd.toFixed(2)}`;
const ramp = (t, pct) => pct >= 90 ? t.ansi5 : pct >= 70 ? t.ansi3 : t.ansi4;


// Match the first visible tab frame, including the active child of a stack.
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter(child => !child.hidden);
    children = [visible.find(child => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init(_props, cx) {
    this.hovered = false; this.usage = null;
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(5000, (cx) => this.refresh(cx));
  }

  // Reads this pane's agent's latest report; redraws only when it changed.
  refresh(cx) {
    const address = props()?.terminal;
    if (!address || address.includes("/") || this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const id = this.me()?.program?.key === "claude" ? await sessionOf(address) : null;
        const usage = id ? await snapshot(id) : null;
        if ((usage?.written_at ?? null) !== (this.usage?.written_at ?? null)) { this.usage = usage; cx.notify(); }
      } finally { this.loading = false; }
    });
  }

  // The agent's model and effort, how full its context is, and what the session has cost.
  usageView(t) {
    const u = this.usage;
    const pct = Math.round(u.context_window?.used_percentage ?? 0), usd = u.cost?.total_cost_usd;
    const model = u.model?.display_name ?? "", effort = u.effort?.level;
    const color = ramp(t, pct);
    return h_flex().id(`usage-${props()?.pane}`).flex_none().gap(8).items_center().text_size(11).text_color(t.dim)
      .when(Date.now() - (u.written_at ?? 0) > STALE, (el) => el.opacity(0.5))
      .tooltip(`${model}${effort ? ` · ${effort} effort` : ""} · context ${pct}% of ${Math.round((u.context_window?.context_window_size ?? 0) / 1000)}k${usd != null ? ` · ${money(usd)} this session` : ""}`)
      .when(Boolean(model), (el) => el.child(div().child(effort ? `${model} · ${effort}` : model)))
      .child(h_flex().gap(5).items_center()
        .child(div().w(36).h(5).rounded(3).bg(t.border).child(div().h_full().w(Math.max(2, 36 * Math.min(pct, 100) / 100)).rounded(3).bg(color)))
        .child(div().text_color(color).child(`${pct}%`)))
      .when(usd != null, (el) => el.child(div().child(money(usd))));
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/maestro-pane-usage/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const bottom = paneFrame(layout())?.header?.position === "bottom";
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .when(bottom, el => el.border_t(1))
      .when(!bottom, el => el.border_b(1))
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(Boolean(this.usage), el => el.child(this.usageView(t)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
