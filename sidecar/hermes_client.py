from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


class HermesError(RuntimeError):
    pass


@dataclass
class HermesClient:
    base_url: str = "http://127.0.0.1:8642"
    api_key: str = "iris-local-dev"
    timeout: float = 10.0

    def _url(self, path: str) -> str:
        if not path.startswith("/"):
            path = f"/{path}"
        return f"{self.base_url.rstrip('/')}{path}"

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            self._url(path),
            data=data,
            headers=self._headers(),
            method=method,
        )

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise HermesError(f"Hermes HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise HermesError(f"Hermes is not reachable: {exc.reason}") from exc

        if not raw:
            return {}
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise HermesError(f"Hermes returned non-JSON response: {raw[:200]}") from exc

    def health(self) -> dict[str, Any]:
        return self.request("GET", "/health")

    def capabilities(self) -> dict[str, Any]:
        return self.request("GET", "/v1/capabilities")

    def start_run(
        self,
        task: str,
        session_id: str = "iris-voice",
        instructions: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "input": task,
            "session_id": session_id,
        }
        if instructions:
            body["instructions"] = instructions
        return self.request("POST", "/v1/runs", body)

    def get_run(self, run_id: str) -> dict[str, Any]:
        return self.request("GET", f"/v1/runs/{run_id}")

    def stop_run(self, run_id: str) -> dict[str, Any]:
        return self.request("POST", f"/v1/runs/{run_id}/stop", {})

    def approve_run(self, run_id: str, choice: str) -> dict[str, Any]:
        return self.request("POST", f"/v1/runs/{run_id}/approval", {"choice": choice})
