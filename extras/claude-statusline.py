#!/usr/bin/env python3
"""Claude Code status line for Agent Maestro.

Saves what Claude Code reports to ~/.claude/herdr/<session>.json (and latest.json
for the account-wide usage limits). The layout's pane header and status bar read
those files to show each agent's model, context and cost, and the 5h/7d limits.

Inside Herdr (its terminals set HC_TERMINAL_ID) the line itself stays empty unless
there is a warning, since Herdr already shows everything else. Elsewhere it prints
a short summary.

Install: copy to ~/.claude/statusline.py and add to ~/.claude/settings.json:
  "statusLine": { "type": "command", "command": "python3 ~/.claude/statusline.py", "refreshInterval": 30 }
Already have a status line? Copy snapshot() into it and call it with the parsed input.
"""
import json
import os
import re
import sys
import time

SNAPSHOTS = os.path.expanduser("~/.claude/herdr")
IN_HERDR = bool(os.environ.get("HC_TERMINAL_ID"))


def snapshot(d):
    """One file per session, plus latest.json; written atomically."""
    sid = d.get("session_id")
    if not sid or not re.fullmatch(r"[0-9a-fA-F-]{36}", sid):
        return
    try:
        os.makedirs(SNAPSHOTS, exist_ok=True)
        data = json.dumps({**d, "written_at": int(time.time() * 1000)})
        for name in (sid, "latest"):
            tmp = os.path.join(SNAPSHOTS, f".{name}.{os.getpid()}.tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(data)
            os.replace(tmp, os.path.join(SNAPSHOTS, f"{name}.json"))
    except OSError:
        pass


def main():
    d = json.loads(sys.stdin.read())
    snapshot(d)
    pct = int((d.get("context_window") or {}).get("used_percentage") or 0)
    warnings = []
    if pct >= 80:
        warnings.append("compacts soon")
    if (d.get("prompt_cache") or {}).get("warm") is False:
        warnings.append("cache cold")
    if IN_HERDR:
        print(" · ".join(warnings))
        return
    model = (d.get("model") or {}).get("display_name") or ""
    cost = (d.get("cost") or {}).get("total_cost_usd")
    parts = [p for p in (d.get("session_name"), model, f"{pct}%", f"${cost:.2f}" if isinstance(cost, (int, float)) else "") if p]
    print(" · ".join(parts + warnings))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 - a status line must never break the prompt
        print(f"statusline: {type(e).__name__}")
