"""Step progress for comfy-monitor, one JSON object per line on stdout.

The mod has no websocket, so it starts this script with `$.process.spawn` and
reads its lines. Two sources, because ComfyUI sends `progress` only to the
client that queued the prompt:

- the websocket `/ws`, joined under a fresh client id (never another
  client's, which would take its messages away), for what ComfyUI
  broadcasts: progress of prompts queued without a client id
- the log comfy-cli writes for a background ComfyUI, whose tqdm bars
  (` 50%|#####     | 3/6 [...]`) give every prompt's sampler steps

Lines written:
  {"type": "bridge", "ws": bool, "log": str | null}
  {"type": "progress", "value": int, "max": int, "source": "ws" | "log", "node"?, "prompt_id"?}
  {"type": "executing", "node": str | null, "prompt_id"?}
  {"type": "executed", "seconds": float}   from the log's "Prompt executed in"

Runs until the mod ends it; standard library plus websocket-client.
"""

import argparse
import configparser
import json
import os
import re
import sys
import threading
import time
import uuid

try:
    import websocket  # websocket-client
except ImportError:  # the log alone still works
    websocket = None

BAR = re.compile(r"(\d+)%\|[^|]*\|\s*(\d+)/(\d+)\s*\[")
EXECUTED = re.compile(r"Prompt executed in ([\d.]+) seconds")
ANSI = re.compile(r"\x1b\[[0-9;]*m")

lock = threading.Lock()
state = {"ws": False, "log": None}


def emit(obj):
    with lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def emit_bridge():
    emit({"type": "bridge", "ws": state["ws"], "log": state["log"]})


def comfy_cli_log():
    """background_log from comfy-cli's config.ini, where `comfy launch --background` writes."""
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/.config")
    parser = configparser.ConfigParser()
    try:
        parser.read(os.path.join(base, "comfy-cli", "config.ini"), encoding="utf-8")
        return parser["DEFAULT"].get("background_log") or None
    except Exception:
        return None


def ws_loop(url):
    while True:
        try:
            conn = websocket.create_connection(f"{url}?clientId=comfy-monitor-{uuid.uuid4().hex}", timeout=10)
            conn.settimeout(None)
            state["ws"] = True
            emit_bridge()
            while True:
                raw = conn.recv()
                if not isinstance(raw, str):
                    continue  # binary preview frames
                msg = json.loads(raw)
                kind, data = msg.get("type"), msg.get("data") or {}
                if kind == "progress":
                    emit({"type": "progress", "value": data.get("value", 0), "max": data.get("max", 0),
                          "source": "ws", "node": data.get("node"), "prompt_id": data.get("prompt_id")})
                elif kind == "executing":
                    emit({"type": "executing", "node": data.get("node"), "prompt_id": data.get("prompt_id")})
        except Exception:
            if state["ws"]:
                state["ws"] = False
                emit_bridge()
            time.sleep(5)


def log_loop(path, poll):
    pos = None
    last = None
    while True:
        try:
            size = os.path.getsize(path)
            if pos is None or size < pos:  # start at the end; a new log starts over
                pos = size if pos is None else 0
            if size > pos:
                with open(path, "rb") as f:
                    f.seek(pos)
                    chunk = f.read(size - pos)
                pos = size
                text = ANSI.sub("", chunk.decode("utf-8", "replace"))
                for piece in re.split(r"[\r\n]+", text):
                    bar = BAR.search(piece)
                    if bar:
                        value, total = int(bar.group(2)), int(bar.group(3))
                        if (value, total) != last:
                            last = (value, total)
                            emit({"type": "progress", "value": value, "max": total, "source": "log"})
                        continue
                    done = EXECUTED.search(piece)
                    if done:
                        last = None
                        emit({"type": "executed", "seconds": float(done.group(1))})
        except OSError:
            pos = None
        time.sleep(poll)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8188")
    ap.add_argument("--log", default="", help="log to follow; empty reads comfy-cli's config")
    ap.add_argument("--poll", type=float, default=0.5)
    args = ap.parse_args()

    state["log"] = args.log or comfy_cli_log()
    emit_bridge()

    if websocket is not None:
        ws_url = re.sub(r"^http", "ws", args.url.rstrip("/")) + "/ws"
        threading.Thread(target=ws_loop, args=(ws_url,), daemon=True).start()

    if state["log"]:
        log_loop(state["log"], args.poll)
    else:
        while True:
            time.sleep(3600)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
