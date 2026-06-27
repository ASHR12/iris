from __future__ import annotations

import json
import sys
import time
from typing import Any


def emit(event_type: str, **payload: Any) -> None:
    """Emit one newline-delimited JSON event for the Electron parent process."""
    event = {
        "type": event_type,
        "timestamp": time.time(),
        **payload,
    }
    print(json.dumps(event, separators=(",", ":")), flush=True)


def emit_log(message: str, level: str = "info", **payload: Any) -> None:
    emit("log", level=level, message=message, **payload)


def read_commands() -> list[dict[str, Any]]:
    """Read all currently buffered stdin commands.

    The sidecar mostly runs autonomous audio tasks. Electron commands are sent as
    newline-delimited JSON, so callers can poll this helper without blocking.
    """
    commands: list[dict[str, Any]] = []
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        try:
            commands.append(json.loads(line))
        except json.JSONDecodeError:
            emit_log(f"Ignoring malformed command: {line.strip()}", level="warning")
    return commands
