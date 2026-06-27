from __future__ import annotations

import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from hermes_client import HermesClient, HermesError

# GUI-launched apps (Electron from Finder/Cursor) inherit a minimal PATH that
# usually omits user/homebrew bin dirs where `hermes` lives. Search these too.
EXTRA_BIN_DIRS = [
    os.path.expanduser("~/.local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    os.path.expanduser("~/bin"),
    "/usr/bin",
]


@dataclass
class HermesProcessManager:
    client: HermesClient
    process: subprocess.Popen | None = None
    hermes_bin: str = "hermes"
    log_path: Path | None = None

    def status(self) -> dict:
        try:
            health = self.client.health()
            return {
                "reachable": True,
                "health": health,
                "started_by_app": self.process is not None and self.process.poll() is None,
            }
        except HermesError as exc:
            return {
                "reachable": False,
                "error": str(exc),
                "started_by_app": self.process is not None and self.process.poll() is None,
            }

    def _resolve_binary(self) -> str | None:
        # 1) Explicit override.
        override = os.environ.get("HERMES_BIN")
        if override and Path(override).exists():
            return override

        # 2) Whatever is already on PATH.
        found = shutil.which(self.hermes_bin)
        if found:
            return found

        # 3) Common install locations missing from a GUI PATH.
        for directory in EXTRA_BIN_DIRS:
            candidate = Path(directory) / "hermes"
            if candidate.exists():
                return str(candidate)
        return None

    def _build_env(self) -> dict[str, str]:
        env = os.environ.copy()
        env.setdefault("API_SERVER_ENABLED", "true")
        env.setdefault("API_SERVER_KEY", self.client.api_key)

        # Ensure the child has a usable PATH even when launched from a GUI app.
        path_parts = env.get("PATH", "").split(os.pathsep)
        for directory in EXTRA_BIN_DIRS:
            if directory and directory not in path_parts:
                path_parts.append(directory)
        env["PATH"] = os.pathsep.join(p for p in path_parts if p)
        return env

    def ensure_running(self, timeout_seconds: float = 40.0) -> dict:
        current = self.status()
        if current["reachable"]:
            return current

        # Already launched and still booting? Just wait on it.
        if self.process is not None and self.process.poll() is None:
            return self._wait_for_health(timeout_seconds)

        hermes_path = self._resolve_binary()
        if not hermes_path:
            raise HermesError(
                "Could not find the `hermes` binary. Set HERMES_BIN in .env to its full path "
                "(for example /Users/you/.local/bin/hermes)."
            )

        log_dir = Path(__file__).resolve().parent / "runtime"
        log_dir.mkdir(exist_ok=True)
        self.log_path = log_dir / "hermes-gateway.log"
        log_file = open(self.log_path, "w", encoding="utf-8")

        # Stream output to a log file (not a PIPE) so a full pipe buffer can never
        # block the long-running gateway process.
        self.process = subprocess.Popen(
            [hermes_path, "gateway"],
            stdout=log_file,
            stderr=subprocess.STDOUT,
            env=self._build_env(),
            cwd=os.path.expanduser("~"),
        )

        return self._wait_for_health(timeout_seconds)

    def _wait_for_health(self, timeout_seconds: float) -> dict:
        deadline = time.time() + timeout_seconds
        last_error = "Hermes did not become ready in time."
        while time.time() < deadline:
            # If the process died, surface the log tail immediately.
            if self.process is not None and self.process.poll() is not None:
                tail = self._log_tail()
                if "already running" in tail.lower() or "launchd" in tail.lower():
                    raise HermesError(
                        "A supervised Hermes gateway is already running, but its HTTP API "
                        "server is off. Enable it once with:\n"
                        "  echo 'API_SERVER_ENABLED=true' >> ~/.hermes/.env\n"
                        f"  echo 'API_SERVER_KEY={self.client.api_key}' >> ~/.hermes/.env\n"
                        "  hermes gateway restart"
                    )
                raise HermesError(
                    f"Hermes gateway exited (code {self.process.returncode}). {tail}"
                )
            try:
                health = self.client.health()
                return {
                    "reachable": True,
                    "health": health,
                    "started_by_app": True,
                    "pid": self.process.pid if self.process else None,
                }
            except HermesError as exc:
                last_error = str(exc)
                time.sleep(0.5)

        raise HermesError(f"{last_error} {self._log_tail()}")

    def _log_tail(self, lines: int = 8) -> str:
        if not self.log_path or not self.log_path.exists():
            return ""
        try:
            content = self.log_path.read_text(encoding="utf-8", errors="replace").strip().splitlines()
            tail = " | ".join(content[-lines:])
            return f"Log: {tail}" if tail else ""
        except OSError:
            return ""

    def stop_if_owned(self) -> None:
        if not self.process or self.process.poll() is not None:
            return

        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
