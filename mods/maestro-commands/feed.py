"""Print, as JSON, the latest shell commands (and their output) run by the Claude Code agents in the given terminals.

usage: feed.py <limit> <terminal address>...
"""
import glob
import json
import os
import re
import subprocess
import sys
from datetime import datetime

HOME = os.path.expanduser("~")
TAIL_BYTES = 16 * 1024 * 1024  # how far back each transcript is read
LIVE_BYTES = 256 * 1024  # how far back a running command's output is read
RESULT_ID = re.compile(rb'"tool_use_id":"([^"]+)"')
OUTPUT_FILE = re.compile(r"Output is being written to: (\S+\.output)")
NOTICE = re.compile(r"<tool-use-id>([^<]+)</tool-use-id>.*?<status>([^<]+)</status>", re.S)
MAX_LINES = 400  # per output
MAX_CHARS = 40000  # per output


def session_of(address):
    """The Claude Code session running in the foreground of a terminal, or None."""
    try:
        out = subprocess.run(["hc", "get", address, "--json"], capture_output=True, text=True, timeout=5).stdout
        pid = (json.loads(out).get("foreground") or {}).get("pid")
        with open(f"{HOME}/.claude/sessions/{pid}.json") as f:
            return json.load(f).get("sessionId")
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def transcripts(session):
    """The session's transcript, then those of its sub-agents."""
    for path in glob.glob(f"{HOME}/.claude/projects/*/{glob.escape(session)}.jsonl"):
        yield path, False
        for sub in glob.glob(f"{glob.escape(path[:-6])}/subagents/*.jsonl"):
            yield sub, True


def millis(stamp):
    try:
        return int(datetime.fromisoformat((stamp or "").replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return 0


def clip(text, tail=False):
    """The first lines of a finished output, or the last ones of a stream, and how many lines were left out."""
    lines = text.rstrip("\n").split("\n")
    hidden = max(0, len(lines) - MAX_LINES)
    text = "\n".join(lines[-MAX_LINES:] if tail else lines[:MAX_LINES])
    if len(text) > MAX_CHARS:
        text, hidden = (text[-MAX_CHARS:] if tail else text[:MAX_CHARS]), max(hidden, 1)
    return text, hidden


def stream(path):
    """What a running command has written so far, or None once its output file is gone."""
    try:
        with open(path, "rb") as f:
            size = f.seek(0, os.SEEK_END)
            f.seek(max(0, size - LIVE_BYTES))
            return clip(f.read().decode(errors="replace"), tail=True)
    except OSError:
        return None


def follow(session, calls):
    """Fills running commands with their live output: Claude Code writes it to <session>/tasks/<task>.output."""
    mine = [c for c in calls.values() if c["session"] == session and c["running"]]
    for call in (c for c in mine if c["file"]):
        live = stream(call["file"])
        if live is None:
            call["running"] = False  # ended without a notice (killed, or the session restarted)
        else:
            call["output"], call["hidden"] = live
            call["live"] = True
    # A foreground command's file is not named in the transcript: pair them by start time.
    claimed = {c["file"] for c in calls.values() if c["file"]}
    files = []
    for path in glob.glob(f"/private/tmp/claude-{os.getuid()}/*/{glob.escape(session)}/tasks/*.output"):
        if path not in claimed:
            try:
                files.append((os.stat(path).st_birthtime * 1000, path))
            except OSError:
                pass
    files.sort()
    for call in sorted((c for c in mine if not c["file"]), key=lambda c: c["at"]):
        match = next((f for f in files if f[0] >= call["at"] - 2000), None)
        if match:
            files.remove(match)
            live = stream(match[1])
            if live is not None:
                call["output"], call["hidden"] = live
                call["live"] = True


def read(path, address, session, sub, calls):
    with open(path, "rb") as f:
        size = f.seek(0, os.SEEK_END)
        f.seek(max(0, size - TAIL_BYTES))
        if size > TAIL_BYTES:
            f.readline()  # drop the cut line
        for raw in f:
            # Most lines are not shell calls, and some are huge (images): parse only the ones that matter.
            if (b'"name":"Bash"' not in raw and b"<task-notification>" not in raw
                    and not any(i.decode() in calls for i in RESULT_ID.findall(raw))):
                continue
            try:
                entry = json.loads(raw)
            except ValueError:
                continue
            at = millis(entry.get("timestamp"))
            # A background command ends with a notice, not a result.
            if entry.get("type") == "queue-operation" and isinstance(entry.get("content"), str):
                for use, status in NOTICE.findall(entry["content"]):
                    call = calls.get(use)
                    if call and call["background"] and call["running"]:
                        final = stream(call["file"]) if call["file"] else None
                        if final is not None:
                            call["output"], call["hidden"] = final
                        call.update(running=False, live=False, error=status != "completed", ended=at)
                continue
            for block in (entry.get("message") or {}).get("content") or []:
                if not isinstance(block, dict):
                    continue
                # A call can be recorded more than once: the first record is the one its result follows.
                if block.get("type") == "tool_use" and block.get("name") == "Bash" and block.get("id") not in calls:
                    inp = block.get("input") or {}
                    calls[block.get("id")] = {
                        "id": block.get("id"), "terminal": address, "session": session, "sub": sub, "at": at,
                        "command": inp.get("command", ""), "description": inp.get("description", ""),
                        "running": True, "error": False, "output": "", "hidden": 0, "ended": None,
                        "background": False, "live": False, "file": None,
                    }
                elif block.get("type") == "tool_result" and block.get("tool_use_id") in calls:
                    content = block.get("content")
                    if isinstance(content, list):
                        content = "\n".join(c.get("text", "") for c in content if isinstance(c, dict))
                    call = calls[block["tool_use_id"]]
                    result = entry.get("toolUseResult")
                    if isinstance(result, dict) and result.get("backgroundTaskId"):
                        # Sent to the background: it keeps running and writing to its file.
                        where = OUTPUT_FILE.search(content or "")
                        call.update(background=True, file=where.group(1) if where else None)
                        continue
                    call["output"], call["hidden"] = clip(content or "")
                    call.update(running=False, error=bool(block.get("is_error")), ended=at)


def main():
    limit, calls, agents = int(sys.argv[1]), {}, []
    for address in sys.argv[2:]:
        session = session_of(address)
        if not session:
            continue
        agents.append(address)
        for path, sub in transcripts(session):
            try:
                read(path, address, session, sub, calls)
            except OSError:
                pass
        follow(session, calls)
    entries = sorted(calls.values(), key=lambda c: c["at"])[-limit:]
    json.dump({"agents": agents, "entries": entries}, sys.stdout)


main()
