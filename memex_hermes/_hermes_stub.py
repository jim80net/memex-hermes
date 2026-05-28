"""Local stand-in for ``agent.memory_provider.MemoryProvider``.

When Hermes Agent is installed (editable or pip), the provider should
subclass the real ABC from ``agent.memory_provider``. In dev/CI hosts
without Hermes installed (most common), the import fails — and we still
want the package to import cleanly, the test suite to run, and
``mypy --strict`` to succeed.

This file mirrors the public surface of the real ABC **exactly** as
verified for Hermes Agent v0.14.0 (``spike/SPIKE-COMPLETE.md`` and the
on-disk source at ``/home/jim/.hermes/hermes-agent/agent/memory_provider.py``).
Signatures are copied verbatim — keyword-only ``session_id``, the
``metadata`` arg on ``on_memory_write``, the ``str`` return on
``on_pre_compress``, the ``list[dict[str, Any]]`` return on
``get_tool_schemas`` / ``get_config_schema``. Drift here is a bug:
re-run the spike on every Hermes major / minor upgrade.

Why a stub and not just ``Any``-typed protocol: the runtime subclassing
test (``isinstance(provider, MemoryProvider)``) is what Hermes uses to
recognize providers (``plugins/memory/__init__.py``). In live runtime
we MUST subclass the real ABC; the stub is the swap-in when the real
one is unavailable. The selection happens in ``provider.py`` at import
time.

`Any` appears in this file at exactly the points the real ABC uses it
— init kwargs, tool args, message lists. Those points ARE the Hermes
ABC boundary; ``provider.py`` narrows them with TypedDicts on entry.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Mapping, Sequence
from typing import Any

HERMES_VERIFIED_VERSION = "v0.14.0"


class MemoryProvider(ABC):
    """Stand-in for the real Hermes ABC, mirroring v0.14.0 exactly."""

    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    def is_available(self) -> bool: ...

    @abstractmethod
    def initialize(self, session_id: str, **kwargs: Any) -> None: ...

    def system_prompt_block(self) -> str:
        return ""

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        return ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        return None

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
    ) -> None:
        return None

    @abstractmethod
    def get_tool_schemas(self) -> list[dict[str, Any]]: ...

    def handle_tool_call(
        self,
        tool_name: str,
        args: Mapping[str, Any],
        **kwargs: Any,
    ) -> str:
        raise NotImplementedError

    def shutdown(self) -> None:
        return None

    def on_turn_start(self, turn_number: int, message: str, **kwargs: Any) -> None:
        return None

    def on_session_end(self, messages: Sequence[Mapping[str, Any]]) -> None:
        return None

    def on_session_switch(
        self,
        new_session_id: str,
        *,
        parent_session_id: str = "",
        reset: bool = False,
        **kwargs: Any,
    ) -> None:
        return None

    def on_pre_compress(self, messages: Sequence[Mapping[str, Any]]) -> str:
        return ""

    def on_delegation(
        self,
        task: str,
        result: str,
        *,
        child_session_id: str = "",
        **kwargs: Any,
    ) -> None:
        return None

    def get_config_schema(self) -> list[dict[str, Any]]:
        return []

    def save_config(self, values: Mapping[str, Any], hermes_home: str) -> None:
        return None

    def on_memory_write(
        self,
        action: str,
        target: str,
        content: str,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        return None
