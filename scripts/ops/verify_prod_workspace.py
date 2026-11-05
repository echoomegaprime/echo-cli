#!/usr/bin/env python3
"""Verify FORGE's production Echo Workspace through direct source imports.

Run as the Workspace service user:
    /usr/bin/python3 -X utf8 verify_prod_workspace.py [--send-telegram]
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any

CONFIG_PATH = Path("/home/forge/prime-prod/ws/config.json")
DATA_DIR = Path("/home/forge/prime-prod/ws/data")
SENSITIVE_KEY = re.compile(r"(?i)secret|token|password|api.?key")
SENSITIVE_ASSIGNMENT = re.compile(
    r"""(?i)["']?[\w.-]*(?:secret|token|password|api.?key)"""
    r"""[\w.-]*["']?\s*[:=]\s*"""
)
TELEGRAM_TEXT = (
    "Echo Workspace (echoomegaprime.com) on FORGE: approval notifications "
    "verified end to end (SOL mission -> SDK -> Telegram)."
)


class SkipCheck(Exception):
    """Indicate an explicitly permitted skipped check."""


class Reporter:
    """Count checks and emit single-line, secret-filtered diagnostics."""

    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0
        self.skipped = 0
        self._sensitive_values: set[str] = set()

    def _remember_sensitive(self, value: Any) -> None:
        """Remember sensitive values in case an exception echoes them."""
        if isinstance(value, dict):
            for item in value.values():
                self._remember_sensitive(item)
        elif isinstance(value, (list, tuple)):
            for item in value:
                self._remember_sensitive(item)
        elif isinstance(value, str):
            if value:
                self._sensitive_values.update(
                    (value, json.dumps(value)[1:-1], repr(value)[1:-1])
                )
        elif isinstance(value, (bool, int, float)):
            self._sensitive_values.update((str(value), json.dumps(value)))

    def sanitize(self, value: Any) -> Any:
        """Recursively drop dictionary entries with sensitive key names."""
        if isinstance(value, dict):
            cleaned = {}
            for key, item in value.items():
                if SENSITIVE_KEY.search(str(key)):
                    self._remember_sensitive(item)
                else:
                    cleaned[key] = self.sanitize(item)
            return cleaned
        if isinstance(value, (list, tuple)):
            return [self.sanitize(item) for item in value]
        return value

    def text(self, value: Any) -> str:
        """Redact known secrets and keep each diagnostic on one line."""
        message = str(value)

        # Conservatively suppress the remainder of text containing a named
        # secret assignment, including nested or multiline values.
        match = SENSITIVE_ASSIGNMENT.search(message)
        if match:
            message = message[:match.end()] + "[REDACTED]"

        for secret in sorted(self._sensitive_values, key=len, reverse=True):
            message = message.replace(secret, "[REDACTED]")

        return message.replace("\r", "\\r").replace("\n", "\\n")

    def dumps(self, value: Any) -> str:
        return self.text(json.dumps(self.sanitize(value)))

    def fail(self, name: str, error: Exception) -> None:
        self.failed += 1
        self.sanitize(error.args)
        message = self.text(error)[:300]
        print(f"[FAIL] {name} -> {type(error).__name__}: {message}")

    def run(self, name: str, check: Callable[[], str]) -> None:
        try:
            detail = self.text(check())
        except SkipCheck as error:
            self.skipped += 1
            print(f"[SKIP] {name} -> {self.text(error)}")
        except Exception as error:
            self.fail(name, error)
        else:
            self.passed += 1
            print(f"[OK] {name} -> {detail}")


def check_agent(path_value: Any, reporter: Reporter) -> str:
    path = Path(path_value)
    exists = path.exists()
    size = path.stat().st_size if exists else None
    within_limit = size is not None and size <= 64000
    detail = reporter.dumps(
        {
            "path": str(path),
            "exists": exists,
            "size_bytes": size,
            "size <= 64000": within_limit,
        }
    )
    if not exists:
        raise FileNotFoundError(detail)
    if not within_limit:
        raise ValueError(detail)
    return detail


def check_cgroup(reporter: Reporter) -> str:
    try:
        first_line = Path("/proc/self/cgroup").read_text(
            encoding="utf-8"
        ).splitlines()[0]
        cgroup_path = first_line.rsplit(":", 1)[-1]
        if not cgroup_path.startswith("/"):
            raise SkipCheck("not readable")
        directory = Path("/sys/fs/cgroup" + cgroup_path)
        values = {
            name: (directory / name).read_text(encoding="utf-8").strip()
            for name in ("memory.peak", "memory.current")
        }
    except (OSError, UnicodeError, IndexError) as error:
        raise SkipCheck("not readable") from error
    return reporter.dumps(values)


def main() -> int:
    sys.path.insert(0, "/home/forge/prime-prod/ws/src")

    reporter = Reporter()
    config: dict[str, Any] | None = None
    m: Any = None
    bridges: Any = None

    try:
        with CONFIG_PATH.open(encoding="utf-8") as handle:
            loaded = json.load(handle)
        reporter.sanitize(loaded)
        if not isinstance(loaded, dict):
            raise TypeError("config.json must contain a JSON object")

        audit_dir = Path(tempfile.mkdtemp(prefix="verify_prod_workspace-"))
        loaded["audit_path"] = str(audit_dir / "audit.jsonl")
        config = loaded
    except Exception as error:
        reporter.fail("setup", error)

    def require_config() -> dict[str, Any]:
        if config is None:
            raise RuntimeError("configuration or audit-path setup failed")
        return config

    def require_bridges() -> Any:
        if bridges is None:
            raise RuntimeError("Bridges initialization failed")
        return bridges

    def check_mission() -> str:
        nonlocal m
        from mission import Mission

        m = Mission(require_config(), DATA_DIR)
        ensured = m.ensure()
        status = reporter.sanitize(m.status())
        detail = reporter.dumps(
            {
                key: status.get(key)
                for key in ("configured", "run_id", "role", "ready", "error")
            }
        )
        if ensured is not True:
            raise RuntimeError("ensure() did not return True; " + detail)
        return detail

    def check_sdk_health() -> str:
        result = reporter.sanitize(
            require_bridges().sdk(
                "echo.monitor.health.node", "node", {"node": "forge"}
            )
        )
        return reporter.dumps({"status": result["status"]})

    def check_web_search() -> str:
        from internet import Internet

        result = Internet(require_bridges()).search(
            "Echo Prime Technologies Midland Texas"
        )
        reporter.sanitize(result)
        return reporter.dumps(
            {
                "keys": sorted(result.keys()),
                "json_length": len(json.dumps(result)),
            }
        )

    def check_connector(plugin: str, tool: str) -> str:
        value = require_bridges().call(plugin, tool, {})
        return reporter.dumps(value)[:160]

    def check_voice() -> str:
        from voice import Voice

        store = SimpleNamespace(root=DATA_DIR)
        status = reporter.sanitize(
            Voice(require_config(), require_bridges(), store).status()
        )
        return reporter.dumps(
            {
                key: status.get(key)
                for key in ("configured", "persona", "label", "model")
            }
        )

    def check_max_tool_rounds() -> str:
        value = require_config().get("max_tool_rounds")
        effective = max(1, min(4, int(value if value is not None else 3)))
        return reporter.dumps({"configured": value, "effective": effective})

    def check_telegram() -> str:
        chat_id = require_config().get("auth", {}).get("telegram_chat_id")
        if not (chat_id and "--send-telegram" in sys.argv):
            raise SkipCheck(
                "add --send-telegram to send one verification message"
            )

        result = reporter.sanitize(
            require_bridges().sdk(
                "echo.social.telegram_post",
                "telegram_post",
                {"chat_id": str(chat_id), "text": TELEGRAM_TEXT},
            )
        )
        message_id = result.get("message_id")
        if message_id is None:
            nested_result = result.get("result", {})
            if isinstance(nested_result, dict):
                message_id = nested_result.get("message_id")
        if message_id is None:
            return "message_id not present in result"
        return reporter.dumps({"message_id": message_id})

    try:
        reporter.run("mission", check_mission)

        try:
            from adapters import Bridges

            bridges = Bridges(require_config(), m)
        except Exception as error:
            reporter.fail("bridges", error)

        reporter.run("sdk health", check_sdk_health)
        reporter.run("web search", check_web_search)

        connectors = [
            ("ecf", "continuity_status"),
            ("crystal", "crystal_status"),
            ("esh", "esh_status"),
            ("personality", "echo_personality_gateway_health"),
        ]
        for plugin, tool in connectors:
            reporter.run(
                f"connector {plugin}.{tool}",
                lambda plugin=plugin, tool=tool: check_connector(plugin, tool),
            )

        reporter.run("voice", check_voice)

        try:
            agents_paths = require_config().get("agents_paths", [])
            if not isinstance(agents_paths, list):
                raise TypeError("agents_paths must be a list")
        except Exception as error:
            reporter.fail("agents", error)
        else:
            for path_value in agents_paths:
                reporter.run(
                    "agents",
                    lambda path_value=path_value: check_agent(
                        path_value, reporter
                    ),
                )

        reporter.run("max_tool_rounds", check_max_tool_rounds)
        reporter.run("telegram", check_telegram)
        reporter.run("cgroup", lambda: check_cgroup(reporter))
    finally:
        if bridges is not None:
            try:
                bridges.close()
            except Exception as error:
                reporter.fail("bridges.close", error)

    print(
        f"passed {reporter.passed} failed {reporter.failed} "
        f"skipped {reporter.skipped}"
    )
    return 0 if reporter.failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
