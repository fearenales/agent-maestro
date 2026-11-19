import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, checking } from "herdr";

// Reads write nothing under .git, so the folder watch doesn't see its own refresh.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "core.quotepath=false"];
const DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "-M"];
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const FILE_H = 32, ROW_H = 20;
const FILE_LINES = 3000;  // diff rows kept per file
const ALL_ROWS = 40000;   // diff rows kept in all
const UNTRACKED = 100;    // new files read
const CHAR = 7;           // a code character's width, for the horizontal scroll
const TREE_W = 210, TREE_AUTO = 540;
const SCOPES = [["changes", "Changes", "file"], ["uncommitted", "Uncommitted", "file"], ["outgoing", "Outgoing", "commit"], ["incoming", "Incoming", "commit"]];
const ICON = (name) => `mods/maestro-review/icons/${name}.svg`;

// The repository is the one the focused pane works in.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
const load = (name, fallback) => { try { return JSON.parse(localStorage.getItem(name)) ?? fallback; } catch { return fallback; } };
// A theme colour at another alpha; theme colours may already carry one.
const fade = (color, alpha) => /^#[0-9a-f]{6}/i.test(color) ? color.slice(0, 7) + alpha : color;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));
const clip = (text) => text.length > 2000 ? text.slice(0, 2000) + "…" : text;

function add(file, row) {
  file.size += row.text.length;
  if (file.lines.length < FILE_LINES) file.lines.push(row); else file.more++;
}

// A unified diff as files, each with its numbered rows.
function parseDiff(text) {
  const files = [];
  let file = null, hunk = false, old = 0, next = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ") || line.startsWith("diff --cc ")) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      file = { path: m ? m[2] : line.replace(/^diff --\w+ /, ""), status: "M", add: 0, del: 0, binary: false, lines: [], more: 0, size: 0 };
      files.push(file); hunk = false;
      continue;
    }
    if (!file) continue;
    if (line.startsWith("@@")) {
      const m = /^@@+ -(\d+)(?:,\d+)? .*?\+(\d+)/.exec(line);
      if (m) { old = +m[1]; next = +m[2]; }
      hunk = true;
      add(file, { kind: "@", text: clip(line) });
    } else if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "A";
      else if (line.startsWith("deleted file mode")) file.status = "D";
      else if (line.startsWith("rename from ")) file.status = "R";
      else if (line.startsWith("rename to ")) file.path = line.slice(10);
      else if (line.startsWith("+++ b/")) file.path = line.slice(6);
      else if (line.startsWith("--- a/") && file.status === "D") file.path = line.slice(6);
      else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) file.binary = true;
    } else if (line[0] === "+") { file.add++; add(file, { kind: "+", number: next++, text: clip(untab(line.slice(1))) }); }
    else if (line[0] === "-") { file.del++; add(file, { kind: "-", number: old++, text: clip(untab(line.slice(1))) }); }
    else if (line[0] === " ") { old++; add(file, { kind: " ", number: next++, text: clip(untab(line.slice(1))) }); }
  }
  return files;
}

// A file git doesn't track yet, as all additions.
function fresh(path, text) {
  const file = { path, status: "A", add: 0, del: 0, binary: false, lines: [], more: 0, size: 0 };
  if (text === null) { file.lines.push({ kind: "note", text: "Cannot preview this file (binary, too large, or unreadable)" }); return file; }
  if (text.includes("\0")) { file.binary = true; return file; }
  const lines = text.replace(/\n$/, "").split("\n");
  file.add = lines.length;
  add(file, { kind: "@", text: `@@ -0,0 +1,${lines.length} @@` });
  lines.forEach((l, i) => add(file, { kind: "+", number: i + 1, text: clip(untab(l)) }));
  return file;
}

export default class Review extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.sizes = []; this.width = 0; this.raw = null;
    this.folded = {}; this.closed = {}; this.current = 0;
    this.counts = { changes: 0, uncommitted: 0, outgoing: 0, incoming: 0 }; this.commits = []; this.branches = [];
    this.scope = { kind: "uncommitted" }; this.picked = false; this.menu = null; this.query = ""; this.shut = 0;
    this.bases = load("bases", {}); this.reviewed = load("reviewed", {}); this.tree = load("tree", null);
    this.scroll = VirtualListScrollHandle.new();
    this.handle = cx.focus_handle();
    this.search = InputState.new({ placeholder: "Search" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value().toLowerCase(); cx.notify(); });
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(15000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.raw = null; this.error = null; this.menu = null;
      this.picked = false; this.scope = { kind: "uncommitted" }; this.watched = null; this.build();
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", [...READ, "rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.raw = null; this.build(); this.error = "Not a git repository"; return; }
        const root = top.stdout.trim();
        const git = (...args) => exec("git", [...READ, ...args], { cwd: root, on });
        const out = async (...args) => { const r = await git(...args); return r.code === 0 ? r.stdout.trim() : null; };
        const [head, sha, upstream, origin] = await Promise.all([
          out("symbolic-ref", "--short", "-q", "HEAD"), out("rev-parse", "--short", "HEAD"),
          out("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"), out("symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD")]);
        // The comparison target: the one chosen for this repository, else its default branch.
        let base = null;
        for (const name of [this.bases[root], origin, "origin/main", "origin/master", "main", "master"]) {
          if (name && name !== head && await out("rev-parse", "--verify", "-q", `${name}^{commit}`) !== null) { base = name; break; }
        }
        const fork = base && sha ? await out("merge-base", base, "HEAD") : null;
        const status = await git("status", "--porcelain=v1", "-z", "--untracked-files=all");
        if (status.code !== 0) throw new Error(status.stderr.trim());
        // A rename or copy is one entry followed by the path it came from.
        const entries = [], parts = status.stdout.split("\0").filter(Boolean);
        for (let i = 0; i < parts.length; i++) { entries.push(parts[i]); if (/[RC]/.test(parts[i].slice(0, 2))) i++; }
        const untracked = entries.filter((e) => e.startsWith("??")).map((e) => e.slice(3));
        const names = fork ? await out("diff", "--name-only", "-z", fork) : null;
        const sides = upstream ? await out("rev-list", "--left-right", "--count", "HEAD...@{u}") : null;
        const [outgoing, incoming] = sides ? sides.split(/\s+/).map(Number) : [0, 0];
        const counts = { changes: names === null ? 0 : new Set([...names.split("\0").filter(Boolean), ...untracked]).size, uncommitted: entries.length, outgoing, incoming };
        const log = sha ? await out("log", "-n", "80", "--format=%H%x1f%h%x1f%s%x1f%cr") : null;
        const commits = (log ?? "").split("\n").filter(Boolean).map((l) => { const [full, short, subject, when] = l.split("\x1f"); return { sha: full, short, subject, when }; });

        // Until a range is picked: what isn't committed, else the whole branch.
        const scope = this.picked ? this.scope : { kind: counts.uncommitted || !counts.changes ? "uncommitted" : "changes" };
        let args = null, loose = false;
        if (scope.kind === "uncommitted") { args = ["diff", ...DIFF, sha ? "HEAD" : EMPTY_TREE]; loose = true; }
        else if (scope.kind === "changes" && fork) { args = ["diff", ...DIFF, fork]; loose = true; }
        else if (scope.kind === "outgoing" && upstream) args = ["diff", ...DIFF, "@{u}...HEAD"];
        else if (scope.kind === "incoming" && upstream) args = ["diff", ...DIFF, "HEAD...@{u}"];
        else if (scope.kind === "commit") args = ["show", ...DIFF, "--format=", scope.sha];
        let text = "";
        if (args) {
          const diff = await git(...args).catch(() => null);
          if (!diff) throw new Error("This diff is too large to show");
          if (diff.code !== 0) throw new Error(diff.stderr.trim() || "git diff failed");
          text = diff.stdout;
        }
        const added = [];
        if (loose) for (const path of untracked.slice(0, UNTRACKED)) added.push([path, await readTextFile(`${root}/${path}`, { on }).catch(() => null)]);
        if (key() !== context) return;

        const raw = JSON.stringify([scope, args, text.length, added.map(([p, t]) => [p, t?.length])]) + text;
        this.root = root; this.on = on; this.head = head ?? sha; this.base = base; this.upstream = upstream;
        this.counts = counts; this.commits = commits; this.scope = scope; this.error = null;
        this.skipped = loose ? Math.max(0, untracked.length - UNTRACKED) : 0;
        if (raw !== this.raw) {
          this.raw = raw;
          this.files = [...parseDiff(text), ...added.map(([p, t]) => fresh(p, t))];
          // A reviewed file that changed since is to review again.
          const seen = this.reviewed[root] ?? {};
          for (const f of this.files) { f.mark = `${f.status}:${f.add}:${f.del}:${f.size}`; f.reviewed = seen[f.path] === f.mark; if (f.reviewed) this.folded[f.path] = true; }
          this.current = Math.min(this.current, Math.max(0, this.files.length - 1));
          this.build();
        }
        this.watch(root, cx);
      } catch (e) { if (key() === context) this.error = String(e?.message ?? e); }
      finally {
        this.loading = false; cx.notify();
        if (this.again) { this.again = false; this.refresh(cx); }
      }
    });
  }

  // Flattens the files to the rows the list draws.
  build() {
    const rows = [], sizes = [];
    let widest = 0;
    this.files.forEach((f, i) => {
      f.row = rows.length;
      rows.push({ kind: "file", file: i }); sizes.push(FILE_H);
      if (this.folded[f.path]) return;
      const note = (text) => { rows.push({ kind: "note", text }); sizes.push(ROW_H); };
      if (f.binary) return note("Binary file");
      if (!f.lines.length) return note(f.status === "R" ? "Renamed without changes" : "No text changes");
      for (const r of f.lines) {
        if (rows.length >= ALL_ROWS) return;
        rows.push(r); sizes.push(ROW_H);
        if (r.text.length > widest) widest = r.text.length;
      }
      if (f.more) note(`${f.more} more lines not shown`);
    });
    this.rows = rows; this.sizes = sizes; this.width = widest * CHAR + 80;
  }

  pick(scope, cx) {
    this.scope = scope; this.picked = true; this.menu = null; this.raw = null; this.files = []; this.current = 0; this.build();
    this.refresh(cx); cx.notify();
  }

  jump(i, cx) {
    const f = this.files[i];
    if (!f) return;
    this.current = i;
    if (this.folded[f.path] && !f.reviewed) { delete this.folded[f.path]; this.build(); }
    this.scroll.scroll_to_item(f.row, "top");
    cx.notify();
  }

  fold(f, cx) {
    if (this.folded[f.path]) delete this.folded[f.path]; else this.folded[f.path] = true;
    this.build(); cx.notify();
  }

  review(f, cx) {
    const seen = this.reviewed[this.root] ??= {};
    f.reviewed = !f.reviewed;
    if (f.reviewed) { seen[f.path] = f.mark; this.folded[f.path] = true; } else { delete seen[f.path]; delete this.folded[f.path]; }
    localStorage.setItem("reviewed", JSON.stringify(this.reviewed));
    this.build(); cx.notify();
  }

  toggle(menu, cx) {
    // The press that closed a menu is the same one that lands on its button.
    if (Date.now() - this.shut < 250) return;
    this.menu = this.menu === menu ? null : menu;
    this.query = ""; this.search.set_value("");
    if (this.menu === "base") cx.spawn(async (cx) => {
      const r = await exec("git", [...READ, "for-each-ref", "--sort=-committerdate", "--count=300", "--format=%(refname:short)", "refs/heads", "refs/remotes"], { cwd: this.root, on: this.on }).catch(() => null);
      this.branches = (r?.stdout ?? "").split("\n").filter((b) => b && b !== this.head && !b.endsWith("/HEAD") && b !== "origin");
      cx.notify();
    });
    if (this.menu === "commits" || this.menu === "base") this.search.focus();
    cx.notify();
  }

  box(t, selected) {
    return div().size(14).flex_none().flex().items_center().justify_center().rounded(4).border_1()
      .border_color(selected ? t.accent : t.input).bg(selected ? t.accent : t.background)
      .when(selected, (el) => el.child(svg(ICON("check")).size(10).text_color(t.accent_foreground)));
  }

  // A virtual list's rows take no handlers of their own: the list reports presses by row key.
  // On a file's header, a click folds it and a right-click marks it reviewed.
  press(rowKey, reviewed, cx) {
    if (!rowKey.startsWith("file:")) return;
    const i = Number(rowKey.slice(5)), f = this.files[i];
    if (!f) return;
    this.current = i;
    if (reviewed) this.review(f, cx); else this.fold(f, cx);
  }

  fileRow(f, t) {
    const parts = f.path.split("/"), name = parts.pop(), folded = Boolean(this.folded[f.path]);
    const tint = f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "R" ? t.ansi4 : t.blocked;
    return h_flex().w_full().h(FILE_H).flex_none().px(12).gap(8).items_center().bg(t.background).text_size(12).cursor_pointer()
      .child(svg(`mods/files/chevron-${folded ? "right" : "down"}.svg`).size(13).flex_none().text_color(t.dim))
      .child(this.box(t, f.reviewed))
      .child(div().w(10).flex_none().text_size(11).text_color(tint).child(f.status))
      // The counts follow the name, so they stay in view when the code is wider than the panel.
      .child(h_flex().min_w(0).when(f.reviewed, (el) => el.opacity(0.55))
        .child(div().min_w(0).truncate().text_color(t.dim).child(parts.length ? parts.join("/") + "/" : ""))
        .child(div().flex_none().font_semibold().when(f.reviewed, (el) => el.line_through()).child(name)))
      .when(f.add > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  row(r, t, mono) {
    if (r.kind === "file") return this.fileRow(this.files[r.file], t);
    const code = (el) => el.w_full().h(ROW_H).flex_none().font_family(mono).text_size(11.5);
    if (r.kind === "@") return code(div()).px(12).truncate().bg(fade(t.foreground, "0d")).text_color(t.dim).child(r.text);
    if (r.kind === "note") return div().w_full().h(ROW_H).flex_none().px(12).text_size(11).text_color(t.dim).child(r.text);
    return code(h_flex()).when(r.kind === "+", (e) => e.bg(fade(t.ansi2, "1c"))).when(r.kind === "-", (e) => e.bg(fade(t.ansi1, "1c")))
      .child(div().w(40).flex_none().pr(8).text_right().text_color(t.dim).child(String(r.number)))
      .child(div().w(12).flex_none().text_color(r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.dim).child(r.kind === " " ? "" : r.kind))
      .child(div().flex_1().min_w(0).whitespace_nowrap().child(r.text || " "));
  }

  // Folders, then files, single-child folders joined into one row.
  treeRows() {
    const root = { dirs: {}, files: [] }, rows = [];
    this.files.forEach((f, i) => {
      const parts = f.path.split("/"), name = parts.pop();
      let node = root;
      for (const p of parts) node = node.dirs[p] ??= { dirs: {}, files: [] };
      node.files.push({ name, file: i });
    });
    const walk = (node, depth, prefix) => {
      for (const name of Object.keys(node.dirs).sort()) {
        let dir = node.dirs[name], label = name, path = prefix + name;
        while (!dir.files.length && Object.keys(dir.dirs).length === 1) { const only = Object.keys(dir.dirs)[0]; label += "/" + only; path += "/" + only; dir = dir.dirs[only]; }
        rows.push({ dir: path, label, depth });
        if (!this.closed[path]) walk(dir, depth + 1, path + "/");
      }
      for (const f of node.files) rows.push({ ...f, depth });
    };
    walk(root, 0, "");
    return rows;
  }

  treeColumn(t) {
    return div().absolute().top(0).bottom(0).right(0).w(TREE_W).bg(t.chrome).border_l(1).border_color(t.border)
      .child(v_flex().id("review-tree").absolute().inset_0().overflow_y_scroll().py(6).text_size(12).children(this.treeRows().map((r) => {
        const line = h_flex().h(24).flex_none().mx(6).pr(6).pl(6 + r.depth * 12).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover));
        if (r.dir !== undefined) return line.id(`dir-${r.dir}`)
          .on_click((_e, cx) => { if (this.closed[r.dir]) delete this.closed[r.dir]; else this.closed[r.dir] = true; cx.notify(); })
          .child(svg(`mods/files/chevron-${this.closed[r.dir] ? "right" : "down"}.svg`).size(12).flex_none().text_color(t.dim))
          .child(div().min_w(0).truncate().text_color(t.muted).child(r.label));
        const f = this.files[r.file];
        const tint = f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "R" ? t.ansi4 : t.blocked;
        return line.id(`tree-${f.path}`).when(this.current === r.file, (el) => el.bg(t.selected))
          .on_click((_e, cx) => this.jump(r.file, cx))
          .child(div().id(`tree-seen-${f.path}`).flex_none().on_click((_e, cx) => { cx.stop_propagation(); this.review(f, cx); }).child(this.box(t, f.reviewed)))
          .child(div().flex_1().min_w(0).truncate().when(f.reviewed, (el) => el.line_through().text_color(t.dim)).child(r.name))
          .child(div().flex_none().text_size(11).text_color(tint).child(f.status));
      })))
      .child(Scrollbar.vertical("review-tree").absolute().inset_0());
  }

  item(t, id, label, detail, { on = false, off = false, mono = false } = {}, action) {
    return h_flex().id(id).h(28).flex_none().px(8).gap(8).items_center().rounded(6).text_size(12)
      .text_color(off ? t.dim : t.foreground).when(on, (el) => el.bg(t.selected))
      .when(!off, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); action(cx); }))
      .child(div().flex_1().min_w(0).truncate().when(mono, (el) => el.font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5)).child(label))
      .when(Boolean(detail), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(detail)));
  }

  popover(t, left, width, children) {
    return v_flex().id("review-menu").absolute().top(40).left(left).w(width).p(4).gap(1).rounded(8).bg(t.popover).border_1().border_color(t.border).shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_down_out((_e, cx) => { this.menu = null; this.shut = Date.now(); cx.notify(); })
      .children(children);
  }

  searchBox(t) {
    return div().id("review-search").h(28).flex_none().mb(3).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).cursor_text()
      .child(Input.new(this.search).h_full().flex_1().text_size(12).text_color(t.foreground));
  }

  menuView(t) {
    if (this.menu === "scope") return this.popover(t, 10, 250, [
      ...SCOPES.map(([kind, label, unit]) => {
        const on = this.scope.kind === kind, n = this.counts[kind];
        const none = kind === "changes" ? !this.base : kind !== "uncommitted" && !this.upstream;
        return this.item(t, `scope-${kind}`, label, none ? (kind === "changes" ? "no base" : "no upstream") : plural(n, unit), { on, off: none || (!n && !on) }, (cx) => this.pick({ kind }, cx));
      }),
      div().h(1).flex_none().my(3).bg(t.border),
      this.item(t, "scope-commits", "Commits", "›", { on: this.scope.kind === "commit", off: !this.commits.length }, (cx) => { this.shut = 0; this.toggle("commits", cx); }),
    ]);
    if (this.menu === "commits") {
      const found = this.commits.filter((c) => !this.query || c.subject.toLowerCase().includes(this.query) || c.sha.startsWith(this.query));
      return this.popover(t, 10, 340, [this.searchBox(t),
        v_flex().id("review-commits").max_h(320).overflow_y_scroll().gap(1).children(found.map((c) =>
          h_flex().id(`commit-${c.sha}`).h(28).flex_none().px(8).gap(8).items_center().rounded(6).text_size(12).cursor_pointer()
            .when(this.scope.sha === c.sha, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); this.pick({ kind: "commit", sha: c.sha }, cx); })
            .child(div().flex_none().font_family(settings().font_family ?? "JetBrains Mono").text_size(11).text_color(t.accent).child(c.short))
            .child(div().flex_1().min_w(0).truncate().child(c.subject))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(c.when.replace(" ago", "")))))
          .when(!found.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child("No commits")))]);
    }
    const found = this.branches.filter((b) => !this.query || b.toLowerCase().includes(this.query));
    const choose = (name, cx) => {
      if (name) this.bases[this.root] = name; else delete this.bases[this.root];
      localStorage.setItem("bases", JSON.stringify(this.bases));
      this.pick({ kind: "changes" }, cx);
    };
    return this.popover(t, 96, 288, [this.searchBox(t),
      v_flex().id("review-branches").max_h(256).overflow_y_scroll().gap(1)
        .when(!this.query, (el) => el.child(this.item(t, "base-auto", "Automatic", "default branch", { on: !this.bases[this.root] }, (cx) => choose(null, cx))))
        .children(found.map((b) => this.item(t, `base-${b}`, b, "", { on: this.base === b && Boolean(this.bases[this.root]) }, (cx) => choose(b, cx))))
        .when(!found.length && Boolean(this.query), (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child("No branches")))]);
  }

  toolbar(t, tree) {
    const stop = (_e, cx) => cx.stop_propagation();
    const text = (id, label, on, action) => h_flex().id(id).h(26).flex_none().max_w(190).px(9).gap(5).items_center().rounded(6).text_size(12).cursor_pointer()
      .text_color(t.foreground).when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", stop).on_click((_e, cx) => action(cx))
      .child(div().min_w(0).truncate().child(label)).child(svg("mods/files/chevron-down.svg").size(12).flex_none().text_color(t.dim));
    const icon = (id, name, tip, on, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().tooltip(tip)
      .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click((_e, cx) => action(cx)).child(svg(ICON(name)).size(14));
    const kind = this.scope.kind, at = this.commits.findIndex((c) => c.sha === this.scope.sha);
    const label = kind === "commit" ? "Commit" : SCOPES.find(([k]) => k === kind)[1];
    const adds = this.files.reduce((n, f) => n + f.add, 0), dels = this.files.reduce((n, f) => n + f.del, 0);
    const allFolded = this.files.length > 0 && this.files.every((f) => this.folded[f.path]);
    return h_flex().h(36).flex_none().px(10).gap(4).items_center().bg(t.chrome)
      .child(text("review-scope", label, this.menu === "scope" || this.menu === "commits", (cx) => this.toggle("scope", cx)))
      .when(kind === "changes" && Boolean(this.base), (el) => el.child(text("review-base", `vs ${this.base}`, this.menu === "base", (cx) => this.toggle("base", cx))))
      .when(kind === "commit" && at >= 0, (el) => el
        .child(icon("commit-newer", "left", "Newer commit", false, (cx) => { if (at > 0) this.pick({ kind: "commit", sha: this.commits[at - 1].sha }, cx); }))
        .child(div().flex_none().font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5).text_color(t.accent).child(this.commits[at]?.short ?? ""))
        .child(icon("commit-older", "right", "Older commit", false, (cx) => { if (at < this.commits.length - 1) this.pick({ kind: "commit", sha: this.commits[at + 1].sha }, cx); })))
      .when((kind === "outgoing" || kind === "incoming") && Boolean(this.upstream), (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.upstream)))
      .child(div().flex_1().min_w(0).px(4).truncate().text_size(11).text_color(t.dim).child(kind === "commit" && at >= 0 ? this.commits[at].subject : ""))
      .when(this.files.length > 0, (el) => el
        .child(div().flex_none().text_size(11).text_color(t.muted).child(plural(this.files.length, "file")))
        .child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${adds}`))
        .child(div().flex_none().pr(4).text_size(11).text_color(t.ansi1).child(`−${dels}`)))
      .child(icon("review-fold", allFolded ? "unfold" : "fold", allFolded ? "Unfold all" : "Fold all", false, (cx) => {
        if (allFolded) this.folded = Object.fromEntries(this.files.filter((f) => f.reviewed).map((f) => [f.path, true]));
        else for (const f of this.files) this.folded[f.path] = true;
        this.build(); cx.notify();
      }))
      .child(icon("review-refresh", "refresh", "Refresh", false, (cx) => { this.raw = null; this.refresh(cx); }))
      .child(icon("review-tree-toggle", "tree", "Files", tree, (cx) => { this.tree = !tree; localStorage.setItem("tree", JSON.stringify(this.tree)); cx.notify(); }));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), mono = settings().font_family ?? "JetBrains Mono";
    // The files column shows by itself once there is room for it.
    const tree = this.files.length > 0 && (this.tree ?? (this.w ?? 0) >= TREE_AUTO);
    const wide = Math.max(0, (this.w ?? 0) - 2 - (tree ? TREE_W : 0)), high = Math.max(0, (this.h ?? 0) - 38);
    const empty = !this.root ? (this.error ?? (this.loading ? "Loading…" : "No folder"))
      : this.error ? this.error : this.loading && !this.raw ? "Loading changes…" : "No changes";
    return v_flex().id("review").size_full().min_h(0).relative().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_size_change((size, cx) => { this.w = size.width; this.h = size.height; cx.notify(); })
      .on_key_down((e, cx) => {
        if (this.menu) { if (e.key === "escape") { this.menu = null; this.handle.focus(); cx.stop_propagation(); cx.notify(); } return; }
        if (e.key === "j") this.jump(Math.min(this.files.length - 1, this.current + 1), cx);
        else if (e.key === "k") this.jump(Math.max(0, this.current - 1), cx);
      })
      .child(this.toolbar(t, tree))
      // The diff gets its box in pixels: a virtual list draws nothing without a definite height.
      .child(div().flex_1().min_h(0).relative()
        .child(div().absolute().top(0).left(0).w(wide).h(high)
          .when(this.files.length > 0 && high > 0, (el) => el
            .child(div().id("review-x").w(wide).h(high).overflow_x_scrollbar()
              .child(div().w(Math.max(wide, this.width)).h(high).child(
                v_virtual_list("review-diff", this.rows.length, this.sizes, (i) => this.rows[i]?.kind === "file" ? `file:${this.rows[i].file}` : String(i),
                  (range) => this.rows.slice(range.start, range.end).map((r) => this.row(r, t, mono)))
                  .on_item_click((rowKey, cx) => this.press(rowKey, false, cx))
                  .on_item_secondary_click((rowKey, _e, cx) => this.press(rowKey, true, cx))
                  .track_scroll(this.scroll).w_full().h(high))))
            .child(Scrollbar.vertical("review-diff").viewport_from_layout().absolute().inset_0()))
          .when(!this.files.length, (el) => el.child(div().p(14).text_size(12).text_color(this.root && this.error ? t.ansi1 : t.dim).child(empty)))
          .when(this.skipped > 0, (el) => el.child(div().absolute().bottom(0).left(0).px(12).py(4).bg(t.background).text_size(11).text_color(t.dim).child(`${this.skipped} more new files not shown`))))
        .when(tree, (el) => el.child(this.treeColumn(t))))
      .when(Boolean(this.menu) && Boolean(this.root), (el) => el.child(this.menuView(t)));
  }
}
