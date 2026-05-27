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
to a log file. The contract has already been resolved from Hermes source
(see spike/SPIKE-COMPLETE.md); this file is retained for an OPTIONAL runtime
confirmation of metadata keys, system_prompt_block call count, and which
optional hooks fire in a vanilla session.

Install — memory providers are discovered by a DIRECTORY SCAN of
$HERMES_HOME/plugins/<name>/ and activated via the `memory.provider` config
key. There is NO `hermes plugins enable` step and NO `provides_memory_providers`
manifest key for memory providers; the generic entry-point PluginManager
explicitly skips memory/ (verified: hermes_cli/plugins.py:819-829,1073-1078).
Only ONE external memory provider may be active at a time, so use a SCRATCH
HERMES_HOME so this does not displace the user's real provider:

    export HERMES_HOME=/tmp/hermes-spike
    mkdir -p "$HERMES_HOME/plugins/memex-trace"
    cp spike/trace_provider.py "$HERMES_HOME/plugins/memex-trace/__init__.py"
    # Select this provider (config.yaml uses `memory:` -> `provider:`):
    mkdir -p "$HERMES_HOME"
    printf 'memory:\n  provider: memex-trace\n' >> "$HERMES_HOME/config.yaml"

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

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        _log("prefetch", query_len=len(query), query_preview=query[:80], session_id=session_id)
        return ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        _log("queue_prefetch", query_len=len(query), query_preview=query[:80], session_id=session_id)

    def sync_turn(self, user_content: Any, assistant_content: Any, *, session_id: str = "") -> None:
        _log(
            "sync_turn",
            user_type=type(user_content).__name__,
            assistant_type=type(assistant_content).__name__,
            session_id=session_id,
        )

    def on_turn_start(self, turn_number: int, message: Any, **kwargs: Any) -> None:
        _log("on_turn_start", turn_number=turn_number, message_preview=str(message)[:80], kwargs=_safe(kwargs))

    def on_session_end(self, messages: Any) -> None:
        _log("on_session_end", message_count=_safe_len(messages))

    def on_session_switch(self, new_session_id: str, *, parent_session_id: str = "", reset: bool = False, **kwargs: Any) -> None:
        _log("on_session_switch", new_session_id=new_session_id, parent_session_id=parent_session_id, reset=reset, kwargs=_safe(kwargs))

    def on_pre_compress(self, messages: Any) -> str:
        _log("on_pre_compress", message_count=_safe_len(messages))
        return ""

    def on_delegation(self, task: Any, result: Any, *, child_session_id: str = "", **kwargs: Any) -> None:
        _log("on_delegation", task_preview=str(task)[:80], result_preview=str(result)[:80], child_session_id=child_session_id, kwargs=_safe(kwargs))

    def on_memory_write(self, action: Any, target: Any, content: Any, metadata: Any = None) -> None:
        # THE critical callback: confirmed from source to fire when Hermes' built-in
        # `remember` tool writes (tool_executor.py:642). This run confirms the metadata keys.
        _log(
            "on_memory_write",
            action=_safe(action),
            target=_safe(target),
            content_type=type(content).__name__,
            content_len=_safe_len(content),
            content_preview=str(content)[:200] if content is not None else None,
            metadata=_safe(metadata),
        )

    def shutdown(self) -> None:
        _log("shutdown")

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        _log("get_tool_schemas")
        return []

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs: Any) -> Any:
        _log("handle_tool_call", tool_name=tool_name, args=_safe(args), kwargs=_safe(kwargs))
        return json.dumps({"ok": True, "spike": "no-op"})

    def get_config_schema(self) -> list[dict[str, Any]]:
        _log("get_config_schema")
        return []

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
