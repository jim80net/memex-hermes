"""MemexProvider — the Hermes ``MemoryProvider`` subclass.

Every Hermes-invoked lifecycle method either:

1. Returns a static cached value (``name``, ``system_prompt_block`` after
   first call, ``get_tool_schemas``, ``get_config_schema``).
2. Performs pure-Python work (``save_config``).
3. Dispatches an event to the ``memex-hermes`` binary via
   ``HermesRunner`` — synchronously via ``run_subprocess_sync`` when
   the caller needs the result, or fire-and-forget for writes that
   must not block.

Signatures match the verified Hermes v0.14.0 ABC
(``spike/SPIKE-COMPLETE.md``). Per R5, write paths are suppressed when
the ``agent_context`` reported at initialize is anything other than
``"primary"`` (``subagent`` / ``cron`` / ``flush``); read paths
(``prefetch``, ``system_prompt_block``, search/recall tool calls)
remain active.

This module is the boundary at which Hermes ``Any``-typed inputs cross
into our code; every entry-point validates and narrows the input
before calling internal helpers.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Final

from memex_hermes.config import (
    DEFAULT_MEMEX_CONFIG,
    MemexConfig,
    build_config_schema,
    load_memex_config,
)
from memex_hermes.envelope import (
    HERMES_HEALTH,
    HERMES_INIT,
    HERMES_MEMORY_WRITE,
    HERMES_PRE_COMPRESS,
    HERMES_PREFETCH,
    HERMES_QUEUE_PREFETCH,
    HERMES_SESSION_END,
    HERMES_SESSION_SWITCH,
    HERMES_SHUTDOWN,
    HERMES_SYNC_TURN,
    HERMES_SYSTEM_PROMPT,
    HERMES_TOOL_RECALL,
    HERMES_TOOL_REMEMBER,
    HERMES_TOOL_SEARCH,
    HermesEventName,
)
from memex_hermes.paths import HermesPaths, resolve_hermes_home
from memex_hermes.runner import HermesRunner
from memex_hermes.tools import get_tool_schemas

try:  # pragma: no cover — exercised only on Hermes-equipped hosts.
    # fmt: off
    from agent.memory_provider import MemoryProvider as _RealMemoryProvider  # type: ignore[import-not-found,unused-ignore]  # noqa: E501,I001
    # fmt: on
    MemoryProvider: type = _RealMemoryProvider
except ImportError:
    from memex_hermes._hermes_stub import MemoryProvider as MemoryProvider  # noqa: F401

logger = logging.getLogger("memex_hermes.provider")

_PRIMARY_CONTEXT: Final[str] = "primary"
_NON_PRIMARY_CONTEXTS: Final[frozenset[str]] = frozenset({"subagent", "cron", "flush"})

# ---- Tool dispatch table (G3 invariant) ------------------------------------
# Every tool name → the Hermes.* event the runner is told to dispatch.
_TOOL_EVENT_MAP: Final[Mapping[str, HermesEventName]] = {
    "memex_search": HERMES_TOOL_SEARCH,
    "memex_remember": HERMES_TOOL_REMEMBER,
    "memex_recall": HERMES_TOOL_RECALL,
}

# memex_remember is a WRITE tool: an explicit agent tool-call must honor the R5
# suppression gate (non-primary agent_context) exactly like sync_turn /
# on_memory_write. memex_search / memex_recall are reads and stay active in
# every context.
_WRITE_TOOLS: Final[frozenset[str]] = frozenset({"memex_remember"})


class MemexProvider(MemoryProvider):  # type: ignore[misc]
    """memex adapter for Hermes' memory-provider plugin contract."""

    # Explicit attribute annotations — strict typing requirement.
    _session_id: str
    _hermes_home: Path | None
    _agent_context: str
    _config: MemexConfig
    _runner: HermesRunner | None
    _system_prompt_cache: str | None

    def __init__(self) -> None:
        self._session_id = ""
        self._hermes_home = None
        self._agent_context = _PRIMARY_CONTEXT
        self._config = DEFAULT_MEMEX_CONFIG
        self._runner = None
        self._system_prompt_cache = None

    # ---- Identity -------------------------------------------------------

    @property
    def name(self) -> str:
        return "memex"

    # ---- Lifecycle ------------------------------------------------------

    def is_available(self) -> bool:
        """Health check via Hermes.health.

        Returns False on subprocess failure; never raises.
        """
        runner = self._runner_or_none()
        if runner is None:
            return False
        result = runner.run_subprocess_sync(
            HERMES_HEALTH,
            {},
            session_id=self._session_id or None,
        )
        ready = result.get("ready") if isinstance(result, Mapping) else None
        return bool(ready)

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        """Capture session_id + hermes_home + agent_context.

        Tolerates any unknown kwargs (per R5 / Hermes' forward-compat
        convention). Resolves hermes_home defensively in the order
        kwargs → save_config arg → env.
        """
        self._session_id = session_id
        try:
            home_path = resolve_hermes_home(initialize_kwargs=kwargs)
        except ValueError:
            # initialize must never raise; if home can't be resolved,
            # we degrade. The framework normally injects it.
            logger.warning(
                "initialize: could not resolve hermes_home; binary calls will degrade"
            )
            home_path = None

        if home_path is not None:
            self._hermes_home = home_path
            self._config = load_memex_config(HermesPaths(home=home_path).memex_json)
            self._runner = HermesRunner(home_path)

        ctx_raw = kwargs.get("agent_context", _PRIMARY_CONTEXT)
        self._agent_context = ctx_raw if isinstance(ctx_raw, str) else _PRIMARY_CONTEXT

        # Prime the system-prompt cache via the binary once. If the
        # binary is unavailable we cache the empty string so subsequent
        # calls remain stable per the static-content Requirement.
        self._system_prompt_cache = self._build_system_prompt_block()

        runner = self._runner
        if runner is not None:
            runner.run_subprocess_sync(
                HERMES_INIT,
                {"hermes_home": str(home_path), "agent_context": self._agent_context},
                session_id=session_id,
            )

    def system_prompt_block(self) -> str:
        """Return cached static block. Per D5: stable for the session."""
        if self._system_prompt_cache is None:
            self._system_prompt_cache = self._build_system_prompt_block()
        return self._system_prompt_cache

    def shutdown(self) -> None:
        """Bounded drain of the FAF queue (5s). Per the shutdown Requirement."""
        runner = self._runner
        if runner is None:
            return
        runner.fire_and_forget(HERMES_SHUTDOWN, {}, session_id=self._session_id or None)
        runner.shutdown(timeout_s=5.0)

    # ---- Read path (prefetch / system_prompt / tools/search/recall) -----

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        runner = self._runner_or_none()
        if runner is None:
            return ""
        result = runner.run_subprocess_sync(
            HERMES_PREFETCH,
            {"query": query, "session_id": session_id or self._session_id},
            session_id=session_id or self._session_id or None,
        )
        ctx = result.get("additionalContext") if isinstance(result, Mapping) else None
        return ctx if isinstance(ctx, str) else ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        runner = self._runner_or_none()
        if runner is None:
            return
        runner.fire_and_forget(
            HERMES_QUEUE_PREFETCH,
            {
                "query": query,
                "session_id": session_id or self._session_id,
                "agent_context": self._agent_context,
            },
            session_id=session_id or self._session_id or None,
        )

    # ---- Write path (suppressed when non-primary) -----------------------

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
    ) -> None:
        if self._writes_suppressed(reason_args={"call": "sync_turn"}):
            return
        runner = self._runner_or_none()
        if runner is None:
            return
        runner.fire_and_forget(
            HERMES_SYNC_TURN,
            {
                "user_content": user_content,
                "assistant_content": assistant_content,
                "session_id": session_id or self._session_id,
                "agent_context": self._agent_context,
            },
            session_id=session_id or self._session_id or None,
        )

    def on_session_end(self, messages: Sequence[Mapping[str, Any]]) -> None:
        if self._writes_suppressed(reason_args={"call": "on_session_end"}):
            return
        runner = self._runner_or_none()
        if runner is None:
            return
        # Run synchronously: this is end-of-life, so blocking is acceptable.
        # The runner enforces the per-event (30s) timeout.
        runner.run_subprocess_sync(
            HERMES_SESSION_END,
            {"messages": list(messages)},
            session_id=self._session_id or None,
        )

    def on_pre_compress(self, messages: Sequence[Mapping[str, Any]]) -> str:
        runner = self._runner_or_none()
        if runner is None:
            return ""
        result = runner.run_subprocess_sync(
            HERMES_PRE_COMPRESS,
            {"messages": list(messages)},
            session_id=self._session_id or None,
        )
        summary = result.get("summary") if isinstance(result, Mapping) else None
        return summary if isinstance(summary, str) else ""

    def on_memory_write(
        self,
        action: str,
        target: str,
        content: str,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        # The metadata may carry an execution_context provenance signal
        # — treat any non-primary value the same as agent_context.
        if self._writes_suppressed(metadata=metadata, reason_args={"call": "on_memory_write"}):
            return
        runner = self._runner_or_none()
        if runner is None:
            return
        args: dict[str, Any] = {
            "action": action,
            "target": target,
            "content": content,
            "agent_context": self._agent_context,
        }
        if metadata is not None:
            args["metadata"] = dict(metadata)
        runner.fire_and_forget(
            HERMES_MEMORY_WRITE,
            args,
            session_id=self._session_id or None,
        )

    # ---- Optional hooks (R4) --------------------------------------------

    def on_session_switch(
        self,
        new_session_id: str,
        *,
        parent_session_id: str = "",
        reset: bool = False,
        **kwargs: Any,
    ) -> None:
        # Refresh cached scope BEFORE notifying the binary so subsequent
        # FAF writes scheduled while the binary processes the switch are
        # already tagged with the new session.
        self._session_id = new_session_id
        runner = self._runner_or_none()
        if runner is None:
            return
        if reset:
            # Drain accumulated per-session buffers by cleanly stopping
            # the runner's worker thread within a 2s bound. The runner is
            # left REUSABLE: the fire_and_forget below — and every later
            # write — re-arms a fresh worker. See HermesRunner.shutdown.
            runner.shutdown(timeout_s=2.0)
        runner.fire_and_forget(
            HERMES_SESSION_SWITCH,
            {
                "new_session_id": new_session_id,
                "parent_session_id": parent_session_id,
                "reset": reset,
            },
            session_id=new_session_id or None,
        )

    def on_turn_start(self, turn_number: int, message: str, **kwargs: Any) -> None:
        # No-op in v1. MUST NOT raise and MUST NOT invoke the binary.
        return None

    def on_delegation(
        self,
        task: str,
        result: str,
        *,
        child_session_id: str = "",
        **kwargs: Any,
    ) -> None:
        # No-op in v1. MUST NOT raise and MUST NOT invoke the binary.
        return None

    # ---- Tools ----------------------------------------------------------

    def handle_tool_call(
        self,
        tool_name: str,
        args: Mapping[str, Any],
        **kwargs: Any,
    ) -> str:
        event = _TOOL_EVENT_MAP.get(tool_name)
        if event is None:
            return json.dumps(
                {"error": "unknown_tool", "tool_name": tool_name},
                separators=(",", ":"),
            )
        # R5: a write tool invoked from a non-primary context is suppressed
        # before it reaches the binary — the tool-call path is otherwise a hole
        # in the write-suppression invariant (the binary's tool-remember handler
        # has no agent_context gate). Reads (search/recall) are never suppressed.
        if tool_name in _WRITE_TOOLS and self._writes_suppressed(
            reason_args={"tool": tool_name}
        ):
            return json.dumps(
                {"suppressed": "non_primary_context", "tool_name": tool_name},
                separators=(",", ":"),
            )
        runner = self._runner_or_none()
        if runner is None:
            return json.dumps(
                {"error": "binary_unavailable", "tool_name": tool_name},
                separators=(",", ":"),
            )
        result = runner.run_subprocess_sync(
            event,
            dict(args),
            session_id=self._session_id or None,
        )
        # The Hermes ABC declares handle_tool_call returns ``str`` (JSON).
        return json.dumps(dict(result), separators=(",", ":"))

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        return get_tool_schemas(self._config)

    # ---- Config ---------------------------------------------------------

    def get_config_schema(self) -> list[dict[str, Any]]:
        # The Hermes ABC returns a *list of fields* (per-field config UI
        # walkthrough). build_config_schema produces a JSON Schema object;
        # adapt that into the per-field list shape Hermes expects.
        schema = build_config_schema()
        properties = schema.get("properties", {})
        fields: list[dict[str, Any]] = []
        if isinstance(properties, Mapping):
            for key, prop in properties.items():
                if not isinstance(prop, Mapping):
                    continue
                field: dict[str, Any] = {
                    "key": str(key),
                    "description": str(prop.get("description", "")) or f"memex {key} configuration",
                }
                if "default" in prop:
                    field["default"] = prop["default"]
                if "type" in prop:
                    field["type"] = prop["type"]
                fields.append(field)
        return fields

    def save_config(self, values: Mapping[str, Any], hermes_home: str) -> None:
        # The hermes_home argument is the truth: never substitute a default.
        target = Path(hermes_home) / "memex.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(dict(values), indent=2, sort_keys=True), encoding="utf-8")

    # ---- Internal helpers ----------------------------------------------

    def _runner_or_none(self) -> HermesRunner | None:
        return self._runner

    def _writes_suppressed(
        self,
        *,
        metadata: Mapping[str, Any] | None = None,
        reason_args: Mapping[str, Any] | None = None,
    ) -> bool:
        # agent_context captured at initialize is the primary gate.
        if self._agent_context in _NON_PRIMARY_CONTEXTS:
            logger.info(
                "memex: suppressing write for agent_context=%s (%s)",
                self._agent_context,
                dict(reason_args) if reason_args else {},
            )
            return True
        # The on_memory_write metadata may carry an execution_context
        # provenance signal that overrides initialize-time context.
        if metadata is not None:
            exec_ctx = metadata.get("execution_context")
            if isinstance(exec_ctx, str) and exec_ctx in _NON_PRIMARY_CONTEXTS:
                logger.info(
                    "memex: suppressing write for metadata.execution_context=%s",
                    exec_ctx,
                )
                return True
        return False

    def _build_system_prompt_block(self) -> str:
        runner = self._runner
        if runner is None:
            return ""
        result = runner.run_subprocess_sync(
            HERMES_SYSTEM_PROMPT,
            {},
            session_id=self._session_id or None,
        )
        block = result.get("block") if isinstance(result, Mapping) else None
        return block if isinstance(block, str) else ""
