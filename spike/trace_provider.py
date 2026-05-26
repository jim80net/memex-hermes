"""
Pre-implementation verification spike for memex-hermes.

NOTE ON TYPING: This file uses `Any` throughout, which violates the project's
mypy --strict rule (~/.claude/rules/strict-typing-python.md). The exemption is
deliberate and documented in CLAUDE.md: the spike's entire purpose is to
discover the runtime argument shapes of Hermes' MemoryProvider ABC, which the
public docs leave partially undefined. Once SPIKE-COMPLETE.md captures the
observed shapes, memex_hermes/provider.py will encode them as TypedDicts and
use strict types throughout.

Goal: discover which Hermes MemoryProvider callbacks actually fire under
normal operation, with what argument shapes. The Hermes docs describe the
ABC's surface in broad strokes but leave several semantics ambiguous —
notably: does on_memory_write fire when Hermes' built-in `remember` tool
writes to MEMORY.md, or only for provider-owned writes?

This trace provider does nothing except print every callback invocation
to a log file. Run it against a live Hermes session, exercise the built-in
remember tool, a normal turn, a session end, and a compression — then read
the log and update docs/specs/2026-05-25-memex-hermes-adapter-design.md §8.4
with what you observed.

Install:

    mkdir -p "$HERMES_HOME/plugins/memex-trace"
    cp spike/trace_provider.py "$HERMES_HOME/plugins/memex-trace/__init__.py"
    cat > "$HERMES_HOME/plugins/memex-trace/plugin.yaml" <<EOF
    name: memex-trace
    version: 0.0.0-spike
    description: Verification spike — traces MemoryProvider callbacks
    provides_memory_providers: [memex-trace]
    EOF
    hermes plugins enable memex-trace

Then run hermes interactively and exercise:

    1. A normal text turn ("hello")
    2. The built-in remember tool ("remember that I prefer dark mode")
    3. End the session
    4. (Optional) Force a compression if Hermes supports it

Log file path: $HERMES_HOME/cache/memex-trace.log

Then commit spike/SPIKE-COMPLETE.md summarizing:
    - Which callbacks fired in each scenario
    - The exact argument shapes (especially on_memory_write's action / target / content fields)
    - Whether on_memory_write fired for the built-in `remember` tool write
    - Any deviations from the v2 design assumptions
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any


try:
    # Hermes-provided ABC. Path may differ in future versions.
    from agent.memory_provider import MemoryProvider  # type: ignore[import-not-found]
except ImportError as _err:  # pragma: no cover — spike-only
    raise SystemExit(
        f"trace_provider.py requires Hermes Agent to be installed "
        f"(could not import agent.memory_provider): {_err}"
    )


_LOG_LOCK = threading.Lock()
_LOG_PATH = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))) / "cache" / "memex-trace.log"


def _log(event: str, **kwargs: Any) -> None:
    """Append a structured trace record. Thread-safe; never raises."""
    record = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "thread": threading.current_thread().name,
        "event": event,
        "kwargs": _safe(kwargs),
    }
    try:
        _LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with _LOG_LOCK:
            with _LOG_PATH.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record) + "\n")
    except Exception:
        # Spike must not crash Hermes if logging fails — just print and move on.
        print(f"[memex-trace] log write failed for event={event}")


def _safe(obj: Any) -> Any:
    """Best-effort JSON-serializable rendering of arbitrary Hermes payloads."""
    try:
        json.dumps(obj)
        return obj
    except (TypeError, ValueError):
        if isinstance(obj, dict):
            return {str(k): _safe(v) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [_safe(v) for v in obj]
        return repr(obj)


class TraceProvider(MemoryProvider):  # type: ignore[misc]
    """Records every callback Hermes invokes. Does not store or return anything."""

    @property
    def name(self) -> str:
        return "memex-trace"

    def is_available(self) -> bool:
        _log("is_available")
        return True

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        _log("initialize", session_id=session_id, kwargs=kwargs, env_keys=sorted(k for k in os.environ if "HERMES" in k))

    def system_prompt_block(self) -> str:
        _log("system_prompt_block")
        return "[memex-trace spike active — this block is static]"

    def prefetch(self, query: str) -> str:
        _log("prefetch", query_len=len(query), query_preview=query[:80])
        return ""

    def queue_prefetch(self, query: str) -> None:
        _log("queue_prefetch", query_len=len(query), query_preview=query[:80])

    def sync_turn(self, user: Any, assistant: Any) -> None:
        _log("sync_turn", user_type=type(user).__name__, assistant_type=type(assistant).__name__)

    def on_session_end(self, messages: Any) -> None:
        _log("on_session_end", message_count=_safe_len(messages))

    def on_pre_compress(self, messages: Any) -> None:
        _log("on_pre_compress", message_count=_safe_len(messages))

    def on_memory_write(self, action: Any, target: Any, content: Any) -> None:
        # THE critical callback: does this fire when Hermes' built-in `remember`
        # tool writes to MEMORY.md? The answer drives the spec's primary mirror path.
        _log(
            "on_memory_write",
            action=_safe(action),
            target=_safe(target),
            content_type=type(content).__name__,
            content_len=_safe_len(content),
            content_preview=str(content)[:200] if content is not None else None,
        )

    def shutdown(self) -> None:
        _log("shutdown")

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        _log("get_tool_schemas")
        return []

    def handle_tool_call(self, name: str, args: dict[str, Any]) -> Any:
        _log("handle_tool_call", name=name, args=_safe(args))
        return json.dumps({"ok": True, "spike": "no-op"})

    def get_config_schema(self) -> dict[str, Any]:
        _log("get_config_schema")
        return {"type": "object", "properties": {}}

    def save_config(self, values: dict[str, Any], hermes_home: str) -> None:
        # Critical for verifying the F6 fix: hermes_home IS passed in.
        _log("save_config", values=_safe(values), hermes_home=hermes_home)


def _safe_len(obj: Any) -> int | None:
    try:
        return len(obj)
    except TypeError:
        return None


def register(ctx: Any) -> None:
    """Hermes plugin entry point."""
    ctx.register_memory_provider(TraceProvider())
    _log("register", ctx_attrs=sorted(a for a in dir(ctx) if not a.startswith("_")))
