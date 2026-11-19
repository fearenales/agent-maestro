import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { layout, props, run, theme } from "herdr";

// The side panel, the stack this strip switches, and its pages.
const SIDE = "side", STACK = "side-body";
const TABS = [["commands", "Commands"], ["review", "Changes"], ["tasks", "Tasks"]];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class SideTabs extends View {
  // The handle beside the panel (props role "toggle"): folds it away and brings it back.
  toggle(t) {
    const hidden = Boolean(find(layout(), SIDE)?.hidden);
    return v_flex().size_full().items_center().justify_center()
      .child(div().id("side-toggle").w(10).h(44).flex().items_center().justify_center().rounded(5).cursor_pointer()
        .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(hidden ? "Show panel" : "Hide panel")
        .on_click(() => run("layout.toggle", { id: SIDE }))
        .child(svg(`mods/maestro-side-tabs/${hidden ? "left" : "right"}.svg`).size(12)));
  }

  render() {
    if (props()?.role === "toggle") return this.toggle(theme());
    const t = theme(), active = find(layout(), STACK)?.active ?? TABS[0][0];
    return h_flex().size_full().gap(3).items_center().children(TABS.map(([id, label]) =>
      h_flex().id(`side-${id}`).h(28).px(12).flex_none().items_center().rounded(7).text_size(12.8).cursor_pointer()
        .border(1).border_color(active === id ? t.border : t.canvas).bg(active === id ? t.raised : t.canvas)
        .text_color(active === id ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .on_click(() => run("layout.select", { stack: STACK, child: id }))
        .child(label)));
  }
}
