import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, ScrollHandle, InputState, Input, TextareaState, Textarea, CalendarState } from "gpui-base";
import { spaces, focused, exec, home, readTextFile, writeTextFile, run, theme, checking, openOverlay, closeOverlay, nextCommand, agents, hc, props, shared, setShared } from "herdr";

// The list is a Markdown checklist anyone can edit; its header comment documents the schema.
const FILE = `${home()}/tasks.md`;
// Settings: change these to fit your machine.
// Where your git repositories live (top level or one folder down); "Start agent" opens a task's repository there.
const REPOS = `${home()}/workspace`;
const SCRATCH = `${home()}/tmp`;
// Jira: a "SEC-123" link opens JIRA + "SEC-123"; empty leaves Jira keys as plain text.
const JIRA = "";
// GitHub organisation: "repo#45" and "#45" (with a repository set) open its PRs and issues; empty leaves them as plain text.
const GITHUB = "";
const AGENT = ["claude"];
// Your own name: an assignee the task tiles leave out.
const ME = "";
const ICON = (name) => `mods/maestro-tasks/icons/${name}.svg`;

const STATUSES = ["inbox", "today", "this week", "doing", "waiting"];
const PRIORITIES = ["P1", "P2", "P3"];
const FIELDS = ["status", "priority", "due", "repository", "assignees", "stakeholders", "tags", "links", "session"];
const LISTS = ["assignees", "stakeholders", "tags", "links"];
const TEXTS = ["title", "due", ...LISTS];

const TASK = /^[-*] \[([ xX])\] (.*)$/;
const LINK = /\s*<!--\s*herdr:tab=(\S+)\s*-->\s*$/;
const FIELD = new RegExp(`^\\s+(${FIELDS.join("|")}):\\s*(.*)$`, "i");

const HEADER = `# Tasks

<!--
Schema, read by the Herdr Tasks panel. One task per top-level checkbox line:

  - [ ] Title                   [x] = done
    status: inbox | today | this week | doing | waiting   (empty = inbox)
    priority: P1 | P2 | P3
    due: YYYY-MM-DD
    repository: path under the repositories folder (my-repo, team/my-repo)
    assignees: comma-separated names
    stakeholders: comma-separated names
    tags: comma-separated
    links: comma-separated URLs, Jira keys (SEC-123), repo#45 or #45 (GitHub)
    session: the linked agent's Claude Code session id (kept by the panel, used to resume it)
    Any other indented line is a note.

A trailing "herdr:tab=<id>" HTML comment on the title line links the task to a Herdr tab.
-->
`;

const list = (v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const uniq = (xs) => [...new Set(xs)];
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const noon = (s) => { const d = s ? new Date(`${s}T12:00:00`) : new Date(); d.setHours(12, 0, 0, 0); return d; };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";

function parse(text) {
  const tasks = [];
  let task = null;
  (text ?? "").split(/\r?\n/).forEach((line, i) => {
    const m = TASK.exec(line);
    if (m) {
      task = { line: i, end: i, done: m[1] !== " ", title: m[2].replace(LINK, "").trim(), tab: LINK.exec(m[2])?.[1] ?? null, fields: {}, notes: [] };
      tasks.push(task);
    } else if (task && /^\s+\S/.test(line)) {
      task.end = i;
      const f = FIELD.exec(line);
      if (f) task.fields[f[1].toLowerCase()] = f[2].trim(); else task.notes.push(line.trim());
    } else task = null;
  });
  for (const t of tasks) {
    const s = (t.fields.status ?? "").toLowerCase();
    t.status = STATUSES.includes(s) ? s : "inbox";
  }
  return tasks;
}

// A task as the lines of the file.
function block(t) {
  const lines = [`- [${t.done ? "x" : " "}] ${t.title}${t.tab ? ` <!-- herdr:tab=${t.tab} -->` : ""}`];
  for (const k of FIELDS) if (t.fields[k]) lines.push(`  ${k}: ${t.fields[k]}`);
  return [...lines, ...t.notes.filter(Boolean).map((n) => `  ${n}`)];
}

// "tomorrow", "fri", "+3d", "2w", "next week" or YYYY-MM-DD as YYYY-MM-DD; "" clears; null if unknown.
function parseDue(text) {
  const s = text.trim().toLowerCase(), d = noon();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return iso(noon(s)) === s ? s : null;
  if (s === "today") return iso(d);
  if (s === "tomorrow" || s === "tmr") { d.setDate(d.getDate() + 1); return iso(d); }
  if (s === "next week") { d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return iso(d); }
  const rel = /^\+?(\d+)\s*([dwm])$/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    if (rel[2] === "m") d.setMonth(d.getMonth() + n); else d.setDate(d.getDate() + n * (rel[2] === "w" ? 7 : 1));
    return iso(d);
  }
  const day = s.length >= 3 ? DAYS.findIndex((n) => s.startsWith(n)) : -1;
  if (day >= 0) { d.setDate(d.getDate() + ((day - d.getDay() + 7) % 7 || 7)); return iso(d); }
  return null;
}

// How far off a due date is, and how urgent that looks.
function dueLabel(due, t) {
  const days = Math.round((noon(due) - noon()) / 86400000);
  if (isNaN(days)) return { text: due, color: t.dim };
  if (days < 0) return { text: `overdue ${-days}d`, color: t.ansi1 };
  if (days === 0) return { text: "today", color: t.blocked };
  if (days === 1) return { text: "tomorrow", color: t.foreground };
  const d = noon(due);
  if (days < 7) return { text: DAYS[d.getDay()][0].toUpperCase() + DAYS[d.getDay()].slice(1), color: t.muted };
  return { text: `${MONTHS[d.getMonth()]} ${d.getDate()}`, color: t.dim };
}

// A link's address and short label: URLs, Jira keys, repo#45, or #45 in the task's repository.
function resolve(ref, repo) {
  if (/^https?:\/\//.test(ref)) {
    const gh = /^https:\/\/github\.com\/[^/]+\/([^/]+)\/(?:pull|issues)\/(\d+)/.exec(ref);
    const jira = /\/browse\/([A-Z][A-Z0-9]+-\d+)/.exec(ref);
    const label = gh ? `${gh[1]}#${gh[2]}` : jira ? jira[1] : ref.replace(/^https?:\/\/(www\.)?/, "");
    return { url: ref, label: label.length > 32 ? label.slice(0, 31) + "…" : label };
  }
  if (JIRA && /^[A-Z][A-Z0-9]+-\d+$/.test(ref)) return { url: JIRA + ref, label: ref };
  const gh = /^([\w.-]+)?#(\d+)$/.exec(ref);
  // A repository field may carry its namespace folder; GitHub knows only the last part.
  const name = gh?.[1] ?? repo?.split("/").pop();
  if (GITHUB && gh && name) return { url: `${GITHUB}${name}/issues/${gh[2]}`, label: `${name}#${gh[2]}` };
  return { url: null, label: ref };
}

// The linked tab with its space, or null once it's closed.
// An agent's title without the status glyph it starts with.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").trim();

function where(id) {
  for (const space of spaces()) {
    const tab = space.tabs.find((t) => t.id === id);
    if (tab) return { space, tab };
  }
  return null;
}

const spaceName = (task) => task.title.length > 40 ? task.title.slice(0, 39) + "…" : task.title;

// Opens a space and answers the id of its tab.
async function newSpace(args) {
  const r = await exec("herdr-app", ["do", "space.new", JSON.stringify(args)]);
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch { /* reported below */ }
  if (r.code !== 0 || !out.tab) throw new Error(out.error ?? (r.stderr.trim() || "space.new failed"));
  return out.tab;
}

// The Claude Code session running in the foreground of a terminal, or null.
async function sessionOf(address) {
  try {
    const r = await hc(["get", address, "--json"]);
    const pid = JSON.parse(r.stdout).foreground?.pid;
    if (!pid) return null;
    return JSON.parse(await readTextFile(`${home()}/.claude/sessions/${pid}.json`) ?? "{}").sessionId ?? null;
  } catch { return null; }
}

// Where a session started: the first working folder its transcript records.
async function sessionFolder(id) {
  const r = await exec("sh", ["-c", 'f=$(ls "$HOME"/.claude/projects/*/"$1".jsonl 2>/dev/null | head -n 1); [ -n "$f" ] && grep -m 1 -o \'"cwd":"[^"]*"\' "$f"', "session", id]);
  try { return JSON.parse(`{${r.stdout.trim()}}`).cwd ?? null; } catch { return null; }
}

// Everything a search looks in: the task's text, fields, state and where its agent runs.
function searchable(task) {
  const at = task.tab ? where(task.tab) : null;
  return [task.title, ...task.notes, task.status, task.done ? "done" : "open",
    ...FIELDS.filter((k) => k !== "session").map((k) => task.fields[k] ?? ""),
    at ? `${at.space.name} ${at.tab.name}` : ""].join("\n").toLowerCase();
}

// When each task was last looked at, newest first: "tab:<id>" when its agent's tab had the
// focus (the agent-history mod records that), "title:<title>" when it was opened here.
const VIEWED = "maestro.viewed";
const viewedAt = (task) => {
  const v = shared(VIEWED) ?? {};
  return Math.max(task.tab ? v[`tab:${task.tab}`] ?? 0 : 0, v[`title:${task.title}`] ?? 0);
};
function markViewed(...keys) {
  const v = { ...(shared(VIEWED) ?? {}) }, now = Date.now();
  for (const k of keys) v[k] = now;
  setShared(VIEWED, Object.fromEntries(Object.entries(v).sort((a, b) => b[1] - a[1]).slice(0, 400)));
}

// Each status group's colour.
const toneOf = (t, id) => ({ inbox: t.ansi6, today: t.blocked, "this week": t.ansi4, doing: t.working, waiting: t.ansi5, done: t.ansi2, "other agents": t.dim })[id];

// A task's links by kind: [kind, icon, links, colour], for GitHub and claude.ai artifacts.
function linkKinds(task, t) {
  const resolved = list(task.fields.links).map((l) => resolve(l, task.fields.repository)).filter((r) => r.url);
  return [
    ["github", "git-branch", resolved.filter((r) => /^https:\/\/github\.com\//.test(r.url)), t.muted],
    ["artifact", "claude", resolved.filter((r) => /^https:\/\/claude\.ai\/(code\/)?artifact\//.test(r.url)), "#D97757"],
  ].filter(([, , found]) => found.length);
}

const load = (name, fallback) => { try { return JSON.parse(localStorage.getItem(name)) ?? fallback; } catch { return fallback; } };

export default class Tasks extends View {
  init(_props, cx) {
    this.text = null; this.tasks = []; this.error = null; this.repos = []; this.ed = null; this.menu = null; this.shut = 0;
    this.showDone = load("showDone", false); this.folded = load("folded", {}); this.filter = load("filter", { tag: null, who: null });
    this.input = InputState.new({ placeholder: "Add a task and press Enter" });
    this.query = "";
    this.searchBox = InputState.new({ placeholder: "Search" });
    this.searchBox.on("change", (_e, cx) => { this.query = this.searchBox.value().trim().toLowerCase(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.add(cx));
    this.handle = cx.focus_handle();
    // Opened as a popup (Cmd+K: mod.open), this mod is the task switcher.
    this.switcher = Boolean(props()?.overlay);
    if (this.switcher) {
      this.sel = 0; this.picking = false;
      this.listScroll = ScrollHandle.new();  // keeps the selected row on screen
      this.finder = InputState.new({ placeholder: "Go to a task, or type a new one" });
      this.finder.on("change", (_e, cx) => { this.sel = 0; this.listScroll.scroll_to_item(0); cx.notify(); });
      this.finder.on("submit", (_e, cx) => this.pick(this.sel, cx));
      this.finder.focus();
    }
    if (checking()) return;
    // The confirm dialog answers through a command to this mod.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "delete" && this.deleting) { this.remove(this.deleting, cx); this.deleting = null; }
        if (command === "done-close" && this.closing) {
          const { key, tab } = this.closing;
          this.closing = null;
          if (await this.update(key, (x) => { x.done = true; }, cx)) run("tab.close", { id: tab, confirmed: true });
        }
      }
    });
    this.reload(cx);
    cx.timer.every(2000, (cx) => this.reload(cx));
    if (this.switcher) cx.timer.after(100, () => this.finder.focus());
    else cx.timer.every(10000, (cx) => this.syncSessions(cx));
    cx.spawn(async (cx) => {
      // Repositories sit at the top or one namespace folder down: "infrastructure", "cf/document-service".
      const r = await exec("find", [REPOS, "-mindepth", "2", "-maxdepth", "3", "-name", ".git"]).catch(() => null);
      this.repos = (r?.stdout ?? "").split("\n").filter(Boolean)
        .map((p) => p.slice(REPOS.length + 1, -"/.git".length)).sort((a, b) => a.localeCompare(b));
      cx.notify();
    });
  }

  reload(cx) {
    if (this.busy) return;
    cx.spawn(async (cx) => {
      const text = await readTextFile(FILE).catch(() => null);
      if (this.busy || text === this.text) return;
      this.text = text; this.tasks = parse(text); cx.notify();
    });
  }

  // Changes the file's lines, one change at a time, each on the file as the one before left it;
  // a change made while the file changed elsewhere is refused and the file read again.
  // Runs as a task: an event handler's cx can't redraw once the write has been awaited.
  // Resolves whether the change was saved.
  edit(change, cx) {
    const previous = this.queue ?? Promise.resolve();
    const done = new Promise((resolve) => cx.spawn(async (cx) => {
      await previous;
      this.busy = true;
      let ok = false;
      try {
        const before = this.text;
        const lines = (before ?? HEADER).replace(/\r?\n$/, "").split(/\r?\n/);
        change(lines);
        const after = lines.join("\n") + "\n";
        await writeTextFile(FILE, after, before);
        this.text = after; this.tasks = parse(after); this.error = null; ok = true;
      } catch (e) {
        this.error = `Not saved: ${e?.message ?? e}`;
        this.text = await readTextFile(FILE).catch(() => null); this.tasks = parse(this.text);
      } finally {
        this.busy = false; cx.notify(); resolve(ok);
      }
    }));
    this.queue = done;
    return done;
  }

  // Finds a task again after the file changed: same line and title, else the title alone.
  locate(key) {
    return this.tasks.find((t) => t.line === key.line && t.title === key.title) ?? this.tasks.find((t) => t.title === key.title) ?? null;
  }

  // Rewrites one task's lines; `change` edits a copy of it.
  async update(key, change, cx) {
    let at = null, title = null;
    const ok = await this.edit((lines) => {
      const t = this.locate(key);
      if (!t) throw new Error("the task changed in the file");
      const next = { ...t, fields: { ...t.fields }, notes: [...t.notes] };
      change(next);
      at = t; title = next.title;
      lines.splice(t.line, t.end - t.line + 1, ...block(next));
    }, cx);
    // The editor follows a renamed task.
    if (ok && this.ed && this.ed.key.title === at.title) this.ed.key = { line: at.line, title };
    return ok;
  }

  add(cx) {
    const title = this.input.value().trim();
    if (!title) return;
    this.input.set_value("");
    const fields = { status: "inbox" };
    if (this.filter.tag) fields.tags = this.filter.tag;
    if (this.filter.who) fields.assignees = this.filter.who;
    const lines = block({ done: false, title, tab: null, fields, notes: [] });
    this.edit((all) => {
      const last = this.tasks[this.tasks.length - 1];
      if (last) all.splice(last.end + 1, 0, ...lines); else all.push("", ...lines);
    }, cx);
  }

  // Ticking a task whose agent is open asks to close the agent's tab too; the session stays, to resume later.
  toggleDone(task, cx) {
    const at = !task.done && task.tab ? where(task.tab) : null;
    if (!at) { this.update(task, (x) => { x.done = !x.done; }, cx); return; }
    this.closing = { key: { line: task.line, title: task.title }, tab: at.tab.id };
    const state = at.tab.status === "working" ? " The agent is still working." : at.tab.status === "blocked" ? " The agent is waiting for you." : "";
    openOverlay({
      mod: "confirm", kind: "dialog", modal: true, width: 440, height: 190,
      props: {
        title: "Mark done and close its agent?",
        detail: `Closes the tab "${at.space.name} · ${at.tab.name}".${state} You can resume the agent later from the task.`,
        command: { name: "maestro-tasks.done-close" },
      },
    });
  }

  // Makes a task for an agent that has none, linked to its tab.
  adopt(agent, cx) {
    const title = clean(agent.title) || agent.space_name;
    const lines = block({ done: false, title, tab: agent.tab, fields: { status: "doing" }, notes: [] });
    this.edit((all) => {
      const last = this.tasks[this.tasks.length - 1];
      if (last) all.splice(last.end + 1, 0, ...lines); else all.push("", ...lines);
    }, cx);
  }

  // Asks first; the confirm dialog runs "maestro-tasks.delete" on Confirm.
  askRemove(task) {
    this.deleting = { line: task.line, title: task.title };
    openOverlay({
      mod: "confirm", kind: "dialog", modal: true, width: 420, height: 170,
      props: { title: "Delete task?", detail: `"${task.title}" will be removed from ~/tasks.md.`, command: { name: "maestro-tasks.delete" } },
    });
  }

  remove(task, cx) {
    if (this.ed && this.ed.key.title === task.title) this.closeEditor();
    this.edit((lines) => {
      const t = this.locate(task);
      if (!t) throw new Error("the task changed in the file");
      lines.splice(t.line, t.end - t.line + 1);
    }, cx);
  }

  // Starts an agent on the task in a new space, in its repository or a fresh scratch folder, and links the task to it.
  // Resolves whether it did.
  start(task, cx) {
    return new Promise((done) => cx.spawn(async (cx) => {
      let ok = false;
      try {
        const repo = task.fields.repository;
        const folder = repo ? `${REPOS}/${repo}` : `${SCRATCH}/${iso(new Date())}-${slug(task.title)}`;
        const made = await exec("mkdir", ["-p", folder]);
        if (made.code !== 0) throw new Error(made.stderr.trim() || `Cannot create ${folder}`);
        const prompt = [
          "A task from my task list:", "", ...block({ ...task, tab: null, fields: { ...task.fields, session: "" } }), "",
          `The list is ${FILE} (its header comment documents the schema). Update this task there only when I ask you to.`,
        ].join("\n");
        const tab = await newSpace({ name: spaceName(task), folder, argv: AGENT, task: prompt });
        ok = await this.update(task, (t) => { t.tab = tab; t.fields.session = ""; }, cx);
      } catch (e) { this.error = String(e?.message ?? e); cx.notify(); }
      finally { done(ok); }
    }));
  }

  // Reopens a closed agent's conversation where it started, in a new space, and links the task to it.
  // Resolves whether it did.
  resume(task, cx) {
    return new Promise((done) => cx.spawn(async (cx) => {
      let ok = false;
      try {
        const id = task.fields.session;
        if (!/^[0-9a-f-]{36}$/i.test(id ?? "")) throw new Error("No agent session recorded for this task: unlink it and start a new agent");
        const folder = await sessionFolder(id);
        if (!folder) throw new Error(`No transcript found for session ${id}`);
        if ((await exec("test", ["-d", folder])).code !== 0) throw new Error(`The session's folder is gone: ${folder}`);
        const tab = await newSpace({ name: spaceName(task), folder, argv: [...AGENT, "--resume", id] });
        ok = await this.update(task, (t) => { t.tab = tab; }, cx);
      } catch (e) { this.error = String(e?.message ?? e); cx.notify(); }
      finally { done(ok); }
    }));
  }

  // Keeps each linked task's session id in step with the Claude Code session running in its tab.
  syncSessions(cx) {
    if (this.syncing) return;
    this.syncing = true;
    cx.spawn(async (cx) => {
      try {
        for (const task of this.tasks) {
          if (!task.tab) continue;
          const agent = agents().find((a) => a.tab === task.tab && a.app === "claude-code" && !a.address.includes("/"));
          const id = agent && await sessionOf(agent.address);
          if (id && id !== task.fields.session) await this.update(task, (t) => { t.fields.session = id; }, cx);
        }
      } finally { this.syncing = false; }
    });
  }

  linkFocused(task, cx) {
    const tab = focused()?.tab;
    if (!tab) { this.error = "No focused tab to link"; cx.notify(); return; }
    this.update(task, (t) => { t.tab = tab; t.fields.session = ""; }, cx);
  }

  // The inline editor: one task at a time, its text fields kept until saved.
  openEditor(task, cx) {
    if (this.ed?.key.title === task.title) { this.closeEditor(cx); return; }
    markViewed(`title:${task.title}`);
    this.closeEditor(cx);
    const inputs = {};
    const value = (k) => k === "title" ? task.title : task.fields[k] ?? "";
    for (const k of TEXTS) {
      const state = InputState.new({ value: value(k), placeholder: k === "due" ? "tomorrow, fri, +3d, 2026-11-25" : LISTS.includes(k) ? "comma-separated" : "" });
      state.on("submit", (_e, cx) => this.saveEditor(cx));
      state.on("focus", (_e, cx) => { if (this.ed) { this.ed.focus = k; cx.notify(); } });
      state.on("change", (_e, cx) => cx.notify());
      inputs[k] = state;
    }
    const notes = TextareaState.new({ value: task.notes.join("\n") });
    notes.set_auto_grow(2, 8);
    this.ed = { key: { line: task.line, title: task.title }, inputs, notes, focus: null, cal: null, repo: null };
    cx.notify();
  }

  closeEditor(cx) {
    if (!this.ed) return;
    if (cx) this.saveEditor(cx, true);
    for (const s of Object.values(this.ed.inputs)) s.release();
    this.ed.notes.release();
    this.ed.cal?.release(); this.ed.repo?.release();
    this.ed = null;
    cx?.notify();
  }

  // Writes the editor's text fields when they differ from the file. Resolves whether the file now has them.
  saveEditor(cx, closing = false) {
    const ed = this.ed, t = ed && this.locate(ed.key);
    if (!t) return Promise.resolve(false);
    const v = (k) => ed.inputs[k].value().trim();
    const due = parseDue(v("due"));
    if (due === null) { this.error = `Unknown date "${v("due")}": use tomorrow, fri, +3d, 2w or YYYY-MM-DD`; cx.notify(); return Promise.resolve(false); }
    if (!closing) ed.inputs.due.set_value(due);
    const next = { title: v("title") || t.title, due, notes: ed.notes.value().split("\n").map((s) => s.trim()).filter(Boolean) };
    for (const k of LISTS) next[k] = list(v(k)).join(", ");
    const same = next.title === t.title && next.due === (t.fields.due ?? "") && next.notes.join("\n") === t.notes.join("\n")
      && LISTS.every((k) => next[k] === list(t.fields[k]).join(", "));
    if (same) return Promise.resolve(true);
    return this.update(ed.key, (x) => {
      x.title = next.title; x.notes = next.notes; x.fields.due = next.due;
      for (const k of LISTS) x.fields[k] = next[k];
    }, cx);
  }

  // The editor's Start: saves what was typed first, so the agent gets it and the link finds the task.
  saveAndStart(cx) {
    cx.spawn(async (cx) => {
      if (!(await this.saveEditor(cx))) return;
      const t = this.ed && this.locate(this.ed.key);
      if (t) this.start(t, cx);
    });
  }

  setField(task, k, value, cx) {
    if (k === "due" && this.ed) this.ed.inputs.due.set_value(value);
    this.update(task, (t) => { t.fields[k] = value; }, cx);
  }

  // Values used anywhere in the file, for suggestions and filters.
  known(kind) {
    const keys = kind === "people" ? ["assignees", "stakeholders"] : [kind];
    return uniq(this.tasks.flatMap((t) => keys.flatMap((k) => list(t.fields[k])))).sort((a, b) => a.localeCompare(b));
  }

  toggleMenu(menu, cx) {
    // The press that closed a menu is the same one that lands on its button.
    if (Date.now() - this.shut < 250) return;
    this.menu = this.menu === menu ? null : menu;
    cx.notify();
  }

  // ---- drawing ----

  icon(t, id, name, tip, action, size = 13) {
    return div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer().tooltip(tip)
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(svg(ICON(name)).size(size));
  }

  pill(t, id, label, on, action, color) {
    return div().id(id).h(22).px(8).flex().flex_none().items_center().rounded(5).text_size(11).cursor_pointer()
      .border_1().border_color(on ? (color ?? t.accent) : t.border).bg(on ? (color ?? t.accent) + "26" : t.background)
      .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(label);
  }

  tag(t, id, label, color, action) {
    const el = div().id(id).h(18).px(6).flex().flex_none().items_center().rounded(4).bg(t.raised).text_size(10.5).text_color(color ?? t.muted);
    return action ? el.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(label) : el.child(label);
  }

  priorityColor(t, p) { return p === "P1" ? t.ansi1 : p === "P2" ? t.blocked : t.ansi4; }

  agentStatus(t, status, compact = false) {
    if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900);
    if (status === "blocked" && compact) return div().size(14).flex_none().flex().items_center().justify_center().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).child("!");
    if (status === "blocked") return div().flex_none().px(5).rounded(4).bg(t.blocked + "26").text_size(10).font_semibold().text_color(t.blocked).child("Needs you");
    if (status === "done") return div().size(7).flex_none().rounded(4).bg(t.done ?? t.ansi2);
    return div().size(7).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  }

  // The linked tab: its agent's status, its place in the tooltip; a click goes there.
  chip(task, t, i) {
    const at = where(task.tab);
    return h_flex().id(`chip-${i}`).size(22).flex_none().flex().items_center().justify_center().rounded(5).border_1().border_color(t.border)
      .text_size(11).text_color(at ? t.muted : t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(at ? `Go to ${at.space.name} · ${at.tab.name}` : task.fields.session ? "Resume agent" : "Its tab was closed")
      .on_click((_e, cx) => { cx.stop_propagation(); if (at) run("tab.select", { id: at.tab.id }); else this.resume(task, cx); })
      .child(at ? this.agentStatus(t, at.tab.status, true) : svg(ICON(task.fields.session ? "circle-dashed" : "link")).size(12).flex_none());
  }

  // An agent without a task, by its title: a click goes to it; the + makes it a task.
  otherRow(a, t) {
    const name = clean(a.title);
    const current = focused()?.tab === a.tab;
    return h_flex().id(`other-${a.tab}`).w_full().flex_none().px(12).py(6).gap(8).items_center().border_b(1).border_color(t.border).cursor_pointer()
      .when(current, (el) => el.bg(t.selected)).hover((s) => s.bg(current ? t.selected : t.hover)).tooltip(`Go to ${a.space_name} · ${a.tab_name}`)
      .on_click(() => run("tab.select", { id: a.tab }))
      .child(div().w(15).flex_none().flex().justify_center().child(this.agentStatus(t, a.status, true)))
      // Claude Code's session title names the work better than the folder-based space name.
      .child(div().min_w(0).truncate().text_size(13).child(name || a.space_name))
      .child(div().flex_1())
      .child(this.icon(t, `adopt-${a.tab}`, "plus", "Make a task for this agent", (cx) => this.adopt(a, cx)));
  }

  row(task, t) {
    const i = task.line, f = task.fields, open = this.ed?.key.title === task.title;
    // The task whose agent you're in.
    const current = Boolean(task.tab) && focused()?.tab === task.tab;
    const due = f.due ? dueLabel(f.due, t) : null;
    const people = list(f.assignees).filter((p) => p.toLowerCase() !== ME.toLowerCase()), tags = list(f.tags), links = list(f.links);
    const meta = Boolean(f.repository) || people.length + tags.length + links.length > 0;
    const kinds = linkKinds(task, t);
    return v_flex().id(`task-${i}`).w_full().flex_none().px(12).py(6).gap(5).border_b(1).border_color(t.border)
      .when(current, (el) => el.bg(t.selected))
      .when(open && !current, (el) => el.bg(t.raised))

      .child(h_flex().id(`head-${i}`).w_full().gap(8).items_center().cursor_pointer()
        .on_click((_e, cx) => this.openEditor(task, cx))
        .child(div().id(`done-${i}`).size(15).flex_none().flex().items_center().justify_center().rounded(4).border_1().cursor_pointer()
          .border_color(task.done ? t.accent : t.input).bg(task.done ? t.accent : t.background)
          .on_click((_e, cx) => { cx.stop_propagation(); this.toggleDone(task, cx); })
          .when(task.done, (el) => el.child(svg(ICON("check")).size(10).text_color(t.accent_foreground))))
        .when(Boolean(f.priority), (el) => el.child(div().flex_none().text_size(10.5).font_semibold().text_color(this.priorityColor(t, f.priority)).child(f.priority)))
        .child(div().min_w(0).truncate().text_size(13).text_color(task.done ? t.dim : t.foreground).when(task.done, (el) => el.line_through()).child(task.title))
        .child(div().flex_1())
        .when(Boolean(due) && !task.done, (el) => el.child(div().flex_none().text_size(11).text_color(due.color).child(due.text)))
        // A badge per kind of link (GitHub, artifacts); a click opens them all, the tooltip names them.
        .children(kinds.map(([kind, icon, found, color]) => div().id(`kind-${i}-${kind}`).size(22).flex_none().flex().items_center().justify_center()
          .rounded(5).border_1().border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip(found.map((r) => r.label).join("\n"))
          .on_click((_e, cx) => { cx.stop_propagation(); for (const r of found) exec("open", [r.url]).catch(() => null); })
          .child(svg(ICON(icon)).size(12).text_color(color))))
        .when(Boolean(task.tab), (el) => el.child(this.chip(task, t, i)))
        .when(!task.tab && !task.done, (el) => el.child(this.icon(t, `start-${i}`, "terminal", f.repository ? `Start an agent in ${f.repository}` : "Start an agent in a new ~/tmp folder", (cx) => this.start(task, cx)))))
      // An expanded task shows its details above the editor.
      .when(meta && open, (el) => el.child(h_flex().pl(23).gap(4).flex_wrap().items_center()
        .when(Boolean(f.repository), (el) => el.child(this.tag(t, `repo-${i}`, f.repository, t.accent)))
        .children(people.map((p, k) => this.tag(t, `who-${i}-${k}`, `@${p}`)))
        .children(tags.map((g, k) => this.tag(t, `tag-${i}-${k}`, `#${g}`)))
        .children(links.map((l, k) => {
          const r = resolve(l, f.repository);
          return this.tag(t, `ln-${i}-${k}`, r.label, t.accent, r.url ? () => exec("open", [r.url]).catch(() => null) : null);
        }))))
      .when(open, (el) => el.child(this.editor(task, t)));
  }

  label(t, text) { return div().w(84).flex_none().text_size(11).text_color(t.dim).child(text); }

  field(t, k, extra) {
    const s = this.ed.inputs[k];
    return h_flex().w_full().gap(8).items_center()
      .child(this.label(t, k === "title" ? "Title" : k[0].toUpperCase() + k.slice(1)))
      .child(Input.new(s).h(28).flex_1().px(8).rounded(6).border_1().border_color(this.ed.focus === k ? t.accent : t.input).bg(t.background).text_size(12).text_color(t.foreground))
      .when(Boolean(extra), (el) => el.child(extra));
  }

  // Known values matching the last item being typed in a list field.
  suggestions(t, k) {
    const s = this.ed.inputs[k], parts = s.value().split(",");
    const typing = parts.pop().trim().toLowerCase(), have = parts.map((p) => p.trim().toLowerCase());
    const pool = this.known(k === "tags" ? "tags" : "people")
      .filter((v) => !have.includes(v.toLowerCase()) && v.toLowerCase() !== typing && (!typing || v.toLowerCase().includes(typing))).slice(0, 8);
    if (!pool.length) return div();
    return h_flex().pl(92).gap(4).flex_wrap().children(pool.map((v, n) => this.tag(t, `sug-${k}-${n}`, v, t.foreground, (cx) => {
      s.set_value([...parts.map((p) => p.trim()).filter(Boolean), v].join(", ") + ", ");
      s.focus(); cx.notify();
    })));
  }

  calendar(t, task) {
    const cal = this.ed.cal, grid = cal.month_days()[0], month = cal.month();
    const nav = (id, label, step) => div().id(id).size(22).flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); step(); cx.notify(); }).child(label);
    return v_flex().id("calendar").ml(92).w(224).p(6).gap(2).rounded(8).border_1().border_color(t.border).bg(t.popover)
      .on_mouse_down_out((_e, cx) => { this.shut = Date.now(); if (this.ed?.cal) { this.ed.cal.release(); this.ed.cal = null; cx.notify(); } })
      .child(h_flex().items_center().child(nav("cal-prev", "‹", () => cal.prev_month()))
        .child(div().flex_1().text_center().text_size(12).child(`${MONTHS[month - 1]} ${cal.year()}`))
        .child(nav("cal-next", "›", () => cal.next_month())))
      .child(h_flex().children(grid[0].map((d) => div().w(30).text_center().text_size(10).text_color(t.dim).child(DAYS[noon(d).getDay()].slice(0, 2)))))
      .children(grid.map((week, w) => h_flex().children(week.map((d) => {
        const inMonth = Number(d.slice(5, 7)) === month, on = d === task.fields.due, today = d === cal.today();
        return div().id(`cal-${w}-${d}`).w(30).h(24).flex().items_center().justify_center().rounded(5).text_size(11.5).cursor_pointer()
          .text_color(on ? t.accent_foreground : inMonth ? t.foreground : t.dim).when(on, (el) => el.bg(t.accent))
          .when(today && !on, (el) => el.border_1().border_color(t.accent)).hover((s) => s.bg(on ? t.accent : t.hover))
          .on_click((_e, cx) => { cx.stop_propagation(); this.pickDay(task, d, cx); })
          .child(String(Number(d.slice(8))));
      }))));
  }

  toggleCalendar(task, cx) {
    // The press that closed the calendar from outside is the same one that lands here.
    if (Date.now() - this.shut < 250) return;
    const ed = this.ed;
    if (ed.cal) { ed.cal.release(); ed.cal = null; } else { ed.cal = CalendarState.new(); if (task.fields.due) ed.cal.set_value(task.fields.due); }
    cx.notify();
  }

  pickDay(task, day, cx) {
    this.ed.cal.release(); this.ed.cal = null;
    this.setField(task, "due", day, cx);
  }

  toggleRepo(task, cx) {
    // The press that closed the picker from outside is the same one that lands here.
    if (Date.now() - this.shut < 250) return;
    const ed = this.ed;
    if (ed.repo) { this.closeRepo(task, cx); return; }
    const state = ed.repo = InputState.new({ placeholder: "Filter repositories, Enter picks the first" });
    state.on("change", (_e, cx) => cx.notify());
    // Presses outside this panel never reach it: losing focus closes the picker too,
    // a moment later so a press on one of its rows still picks that row.
    state.on("blur", (_e, cx) => cx.timer.after(200, (cx) => { if (this.ed?.repo === state) this.closeRepo(task, cx); }));
    state.on("submit", (_e, cx) => { const first = this.repoMatches()[0]; if (first) this.closeRepo(task, cx, first); });
    state.focus();
    cx.notify();
  }

  repoMatches() {
    const q = this.ed.repo.value().trim().toLowerCase();
    return this.repos.filter((r) => !q || r.toLowerCase().includes(q));
  }

  // Closes the picker; with a pick, or with typed text naming exactly one repository, sets it.
  closeRepo(task, cx, pick) {
    const ed = this.ed;
    if (!ed?.repo) return;
    const q = ed.repo.value().trim().toLowerCase(), found = this.repoMatches();
    const name = pick ?? (q ? found.find((r) => r.toLowerCase() === q) ?? (found.length === 1 ? found[0] : null) : null);
    ed.repo.release(); ed.repo = null;
    cx.notify();
    if (name && name !== task.fields.repository) this.setField(task, "repository", name, cx);
  }

  repoPicker(t, task) {
    const found = this.repoMatches();
    const choose = (name, cx) => this.closeRepo(task, cx, name);
    return v_flex().id("repo-picker").ml(92).p(4).gap(1).rounded(8).border_1().border_color(t.border).bg(t.popover)
      .on_mouse_down_out((_e, cx) => { this.shut = Date.now(); this.closeRepo(task, cx); })
      .child(Input.new(this.ed.repo).h(26).mb(2).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground))
      .child(v_flex().id("repo-list").max_h(200).overflow_y_scroll()
        .children(found.map((r, n) => div().id(`repo-${r}`).h(24).px(8).flex().flex_none().items_center().rounded(5).text_size(12).cursor_pointer()
          .when(r === task.fields.repository || n === 0 && found.length < this.repos.length, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { cx.stop_propagation(); choose(r, cx); }).child(r)))
        .when(!found.length, (el) => el.child(div().p(6).text_size(11).text_color(t.dim).child(this.repos.length ? "No match" : `No folders in ${REPOS}`))));
  }

  editor(task, t) {
    const f = task.fields, i = task.line, ed = this.ed;
    const button = (id, text, primary, action) => h_flex().id(id).h(26).px(10).flex_none().items_center().rounded(6).text_size(11.5).cursor_pointer()
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.background).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.85)).on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(text);
    const row = (label, ...kids) => h_flex().w_full().gap(4).items_center().flex_wrap().child(this.label(t, label)).children(kids);
    return v_flex().id(`editor-${i}`).w_full().pl(23).pt(4).gap(6).on_click((_e, cx) => cx.stop_propagation())
      .child(this.field(t, "title"))
      .child(row("Status", ...STATUSES.map((s) => this.pill(t, `st-${i}-${s}`, s, task.status === s, (cx) => this.setField(task, "status", s, cx)))))
      .child(row("Priority", ...PRIORITIES.map((p) => this.pill(t, `pr-${i}-${p}`, p, f.priority === p, (cx) => this.setField(task, "priority", f.priority === p ? "" : p, cx), this.priorityColor(t, p)))))
      .child(this.field(t, "due", h_flex().gap(2)
        .child(this.icon(t, `cal-${i}`, "calendar", "Pick a date", (cx) => this.toggleCalendar(task, cx)))
        .when(Boolean(f.due), (el) => el.child(this.icon(t, `undue-${i}`, "x", "Clear", (cx) => this.setField(task, "due", "", cx))))))
      .when(Boolean(ed.cal), (el) => el.child(this.calendar(t, task)))
      .child(row("Repository",
        this.pill(t, `repo-pick-${i}`, f.repository || "none: new ~/tmp folder", Boolean(f.repository), (cx) => this.toggleRepo(task, cx)))
        .when(Boolean(f.repository), (el) => el.child(this.icon(t, `unrepo-${i}`, "x", "Clear", (cx) => this.setField(task, "repository", "", cx)))))
      .when(Boolean(ed.repo), (el) => el.child(this.repoPicker(t, task)))
      .child(this.field(t, "assignees"))
      .when(ed.focus === "assignees", (el) => el.child(this.suggestions(t, "assignees")))
      .child(this.field(t, "stakeholders"))
      .when(ed.focus === "stakeholders", (el) => el.child(this.suggestions(t, "stakeholders")))
      .child(this.field(t, "tags"))
      .when(ed.focus === "tags", (el) => el.child(this.suggestions(t, "tags")))
      .child(this.field(t, "links"))
      .child(h_flex().w_full().gap(8).items_start()
        .child(this.label(t, "Notes").pt(6))
        .child(Textarea.new(ed.notes).flex_1().px(8).py(4).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground)))
      .child(h_flex().w_full().pt(2).pb(4).gap(6).items_center()
        .when(Boolean(task.tab), (el) => el
          .child(button(`unlink-${i}`, "Unlink agent", false, (cx) => this.update(task, (x) => { x.tab = null; x.fields.session = ""; }, cx))))
        .when(!task.tab, (el) => el
          .child(button(`go-${i}`, "Start agent", true, (cx) => this.saveAndStart(cx)).tooltip(f.repository ? `In ${REPOS}/${f.repository}` : "In a new ~/tmp folder"))
          .child(button(`link-${i}`, "Link focused tab", false, (cx) => this.linkFocused(task, cx))))
        .child(div().flex_1())
        .child(button(`del-${i}`, "Delete", false, () => this.askRemove(task)))
        .child(button(`save-${i}`, "Save", false, (cx) => this.saveEditor(cx))));
  }

  filterMenu(t) {
    const kind = this.menu, values = this.known(kind === "tag" ? "tags" : "people");
    const choose = (v, cx) => { this.filter[kind] = v; localStorage.setItem("filter", JSON.stringify(this.filter)); this.menu = null; cx.notify(); };
    const item = (id, label, on, v) => div().id(id).h(26).px(8).flex().flex_none().items_center().rounded(5).text_size(12).cursor_pointer()
      .when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); choose(v, cx); }).child(label);
    return v_flex().id("filter-menu").absolute().top(42).right(10).w(220).max_h(320).overflow_y_scroll().p(4).gap(1).rounded(8)
      .bg(t.popover).border_1().border_color(t.border).shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_down_out((_e, cx) => { this.menu = null; this.shut = Date.now(); cx.notify(); })
      .child(item("filter-any", kind === "tag" ? "Any tag" : "Anyone", !this.filter[kind], null))
      .children(values.map((v) => item(`filter-${v}`, kind === "tag" ? `#${v}` : v, this.filter[kind] === v, v)));
  }

  // ---- task switcher (Cmd+K) ----

  // Open tasks: first those whose agent waits for you, then those whose agent just finished,
  // each by when that happened, then those whose agent is working, latest started first,
  // all newest first; then the rest, last viewed first.
  // A search keeps those holding every word.
  switchList() {
    const words = this.finder.value().trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rank = (x) => [STATUSES.indexOf(x.status), PRIORITIES.indexOf(x.fields.priority) + 1 || 9, x.line];
    const group = (tab) => ({ blocked: 0, done: 1, working: 2 })[tab?.status] ?? 3;
    return this.tasks.filter((x) => !x.done && words.every((w) => searchable(x).includes(w)))
      .map((x) => {
        const tab = x.tab ? where(x.tab)?.tab : null, g = group(tab);
        const when = g === 2 ? tab.working_since ?? tab.changed_at ?? 0 : g < 2 ? tab.changed_at ?? 0 : viewedAt(x);
        return { x, g, when, r: rank(x) };
      })
      .sort((a, b) => a.g - b.g || b.when - a.when || a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2] - b.r[2])
      .map(({ x }) => x);
  }

  // Goes to the task's agent: focuses it, resumes it, or starts one; with no match, makes the task first.
  pick(i, cx) {
    if (this.picking) return;
    const tasks = this.switchList(), title = this.finder.value().trim(), overlay = props()?.overlay;
    const task = tasks[i];
    if (!task && !(title && !tasks.length && i === 0)) return;
    if (task) {
      const at = task.tab ? where(task.tab) : null;
      markViewed(`title:${task.title}`, ...(at ? [`tab:${at.tab.id}`] : []));
      if (at) { run("tab.select", { id: at.tab.id }); closeOverlay(overlay); return; }
    }
    // Starting or resuming takes a moment: the popup stays until the agent's space exists.
    this.picking = true; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      let target = task;
      if (!target) {
        const lines = block({ done: false, title, tab: null, fields: { status: "inbox" }, notes: [] });
        await this.edit((all) => {
          const last = this.tasks[this.tasks.length - 1];
          if (last) all.splice(last.end + 1, 0, ...lines); else all.push("", ...lines);
        }, cx);
        target = this.tasks.find((x) => x.title === title && !x.done && !x.tab);
        if (target) markViewed(`title:${title}`);
      }
      const ok = Boolean(target) && await (target.tab && target.fields.session ? this.resume(target, cx) : this.start(target, cx));
      if (ok) closeOverlay(overlay); else { this.picking = false; cx.notify(); }
    });
  }

  // Moves the selection one row and keeps it on screen.
  moveSelection(step, count, cx) {
    this.sel = Math.max(0, Math.min(count - 1, this.sel + step));
    this.listScroll.scroll_to_item(this.sel);
    cx.notify();
  }

  switcherView(t) {
    const tasks = this.switchList(), title = this.finder.value().trim();
    const create = Boolean(title) && !tasks.length, count = tasks.length + (create ? 1 : 0);
    this.sel = Math.max(0, Math.min(this.sel, count - 1));
    const line = (id, i) => h_flex().id(id).h(34).flex_none().mx(6).px(10).gap(8).items_center().rounded(6).cursor_pointer()
      .when(i === this.sel, (el) => el.bg(t.selected)).hover((s) => s.bg(i === this.sel ? t.selected : t.hover))
      .on_click((_e, cx) => this.pick(i, cx));
    const taskLine = (task, i) => {
      const f = task.fields, due = f.due ? dueLabel(f.due, t) : null, at = task.tab ? where(task.tab) : null;
      const agent = at ? this.agentStatus(t, at.tab.status, true)
        : svg(ICON(task.tab && f.session ? "circle-dashed" : "terminal")).size(12).text_color(t.dim);
      return line(`sw-${task.line}`, i)
        .child(div().size(6).flex_none().rounded(3).bg(toneOf(t, task.status) ?? t.dim))
        .when(Boolean(f.priority), (el) => el.child(div().flex_none().text_size(10.5).font_semibold().text_color(this.priorityColor(t, f.priority)).child(f.priority)))
        .child(div().min_w(0).truncate().child(task.title))
        .child(div().flex_1())
        .when(Boolean(due), (el) => el.child(div().flex_none().text_size(11).text_color(due.color).child(due.text)))
        .children(linkKinds(task, t).map(([, icon, , color]) => svg(ICON(icon)).size(12).flex_none().text_color(color)))
        .child(div().w(16).flex_none().flex().justify_center().child(agent));
    };
    const enter = this.picking ? "Starting the agent…" : create ? "↵ create and start" : "↵ go to agent";
    return v_flex().id("switcher").w_full().bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key !== "down" && e.key !== "up") return;
        this.moveSelection(e.key === "down" ? 1 : -1, count, cx);
        cx.stop_propagation();
      })
      .child(h_flex().h(46).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
        .child(svg(ICON("search")).size(14).flex_none().text_color(t.dim))
        .child(Input.new(this.finder).h_full().flex_1().text_size(14).text_color(t.foreground)))
      // A popup is as tall as its content: the list gets its height from its rows, up to 12.
      .child(div().h(count ? Math.min(count, 12) * 34 + 8 : 44).flex_none().relative()
        .child(v_flex().id("switcher-list").absolute().inset_0().overflow_y_scroll().track_scroll(this.listScroll).py(4)
          .children(tasks.map(taskLine))
          .when(create, (el) => el.child(line("sw-create", 0)
            .child(svg(ICON("plus")).size(12).flex_none().text_color(t.dim))
            .child(div().min_w(0).truncate().child(`New task: ${title}`))))
          .when(!count, (el) => el.child(div().p(14).text_size(12).text_color(t.dim).child(this.text === null ? "Loading…" : "No open tasks"))))
        .child(Scrollbar.vertical("switcher-list").absolute().inset_0()))
      .child(h_flex().h(30).flex_none().px(14).gap(14).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(enter).child("↑↓ select").child("esc close")
        .when(Boolean(this.error), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.ansi1).child(this.error))));
  }

  render() {
    const t = theme();
    if (this.switcher) return this.switcherView(t);
    const fit = (x) => (!this.filter.tag || list(x.fields.tags).includes(this.filter.tag))
      && (!this.filter.who || list(x.fields.assignees).includes(this.filter.who));
    // A search matches tasks holding every word, finished ones too.
    const words = this.query.split(/\s+/).filter(Boolean);
    const found = (x) => words.every((w) => searchable(x).includes(w));
    const visible = this.tasks.filter((x) => fit(x) && found(x)), open = visible.filter((x) => !x.done), done = visible.filter((x) => x.done);
    const rank = (x) => [PRIORITIES.indexOf(x.fields.priority) + 1 || 9, x.fields.due || "9999", x.line];
    const sorted = (xs) => xs.slice().sort((a, b) => { const p = rank(a), q = rank(b); return p[0] - q[0] || p[1].localeCompare(q[1]) || p[2] - q[2]; });
    const groups = STATUSES.map((s) => [s, sorted(open.filter((x) => x.status === s))]).filter(([, xs]) => xs.length);
    if ((this.showDone || words.length) && done.length) groups.push(["done", done]);
    // Agents no open task links to, one per tab, so none is out of reach without the sidebar.
    const linked = new Set(this.tasks.filter((x) => !x.done).map((x) => x.tab).filter(Boolean)), seenTabs = new Set();
    const others = this.filter.tag || this.filter.who ? [] : agents().filter((a) => {
      if (linked.has(a.tab) || seenTabs.has(a.tab)) return false;
      seenTabs.add(a.tab);
      const text = `${a.space_name} ${a.tab_name} ${clean(a.title)}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    // Each group has its colour, as a small dot before its label.
    const section = (id, n) => h_flex().id(`group-${id}`).h(28).flex_none().px(12).gap(6).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .text_size(11).font_semibold().text_color(t.muted).cursor_pointer()
      .on_click((_e, cx) => { if (this.folded[id]) delete this.folded[id]; else this.folded[id] = true; localStorage.setItem("folded", JSON.stringify(this.folded)); cx.notify(); })
      .child(svg(`mods/files/chevron-${this.folded[id] ? "right" : "down"}.svg`).size(12).text_color(t.dim))
      .child(div().size(6).flex_none().rounded(3).bg(toneOf(t, id) ?? t.dim))
      .child(id[0].toUpperCase() + id.slice(1)).child(div().text_color(t.dim).font_normal().child(String(n)));
    const filterButton = (kind, label) => div().id(`filter-${kind}-btn`).h(22).px(8).flex().items_center().rounded(5).text_size(11).cursor_pointer()
      .bg(this.filter[kind] ? t.selected : t.background).text_color(this.filter[kind] ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => this.toggleMenu(kind, cx)).child(label);
    return v_flex().id("tasks").size_full().min_h(0).relative().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.menu) this.menu = null;
        else if (this.query) { this.searchBox.set_value(""); this.query = ""; }
        else if (this.ed?.repo) { this.ed.repo.release(); this.ed.repo = null; }
        else this.closeEditor(cx);
        cx.notify();
      })
      .child(h_flex().h(42).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .child(h_flex().id("search").h(26).flex_1().min_w(80).mr(4).px(8).gap(6).items_center().rounded(6).border_1().border_color(this.query ? t.accent : t.input).bg(t.background)
          .child(svg(ICON("search")).size(12).flex_none().text_color(t.dim))
          .child(Input.new(this.searchBox).h_full().flex_1().text_size(12).text_color(t.foreground))
          .when(Boolean(this.query), (el) => el.child(div().id("search-clear").flex_none().cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { this.searchBox.set_value(""); this.query = ""; cx.notify(); })
            .child(svg(ICON("x")).size(11)))))
        .child(filterButton("tag", this.filter.tag ? `#${this.filter.tag}` : "Tag"))
        .child(filterButton("who", this.filter.who ? `@${this.filter.who}` : "Assignee"))
        .child(div().id("show-done").h(22).px(8).flex().items_center().rounded(5).text_size(11).cursor_pointer()
          .bg(this.showDone ? t.selected : t.background).text_color(this.showDone ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.showDone = !this.showDone; localStorage.setItem("showDone", JSON.stringify(this.showDone)); cx.notify(); })
          .child(`Done ${done.length}`))
        .child(this.icon(t, "edit-file", "square-pen", "Edit tasks.md", () => exec("open", ["-t", FILE]).catch(() => null))))
      .child(h_flex().h(40).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(ICON("plus")).size(13).flex_none().text_color(t.dim))
        .child(Input.new(this.input).h_full().flex_1().text_size(13).text_color(t.foreground)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("tasks-list").absolute().inset_0().overflow_y_scroll()
          .children(groups.flatMap(([id, xs]) => [section(id, xs.length), ...(this.folded[id] && !words.length ? [] : xs.map((x) => this.row(x, t)))]))
          .when(others.length > 0, (el) => el.child(section("other agents", others.length))
            .children(this.folded["other agents"] && !words.length ? [] : others.map((a) => this.otherRow(a, t))))
          .when(!groups.length && !others.length, (el) => el.child(div().p(14).text_size(12).text_color(t.dim)
            .child(this.text === null ? `No ${FILE} yet: add a task to create it` : words.length ? "No task matches the search" : this.filter.tag || this.filter.who ? "Nothing open matches the filter" : "Nothing open"))))
        .child(Scrollbar.vertical("tasks-list").absolute().inset_0()))
      .when(Boolean(this.error), (el) => el.child(h_flex().id("tasks-error").flex_none().px(12).py(6).gap(8).items_center().border_t(1).border_color(t.border)
        .text_size(11).text_color(t.ansi1).cursor_pointer().on_click((_e, cx) => { this.error = null; cx.notify(); })
        .child(div().flex_1().min_w(0).child(this.error)).child(svg(ICON("x")).size(11).flex_none())))
      .when(Boolean(this.menu), (el) => el.child(this.filterMenu(t)));
  }
}
