"""register(ctx) / discovery-heuristic test."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import memex_hermes
from memex_hermes.provider import MemexProvider


class _CollectorCtx:
    """Stand-in for the Hermes loader collector context."""

    def __init__(self) -> None:
        self.providers: list[MemexProvider] = []

    def register_memory_provider(self, provider: MemexProvider) -> None:
        self.providers.append(provider)


def test_register_calls_register_memory_provider_once() -> None:
    ctx = _CollectorCtx()
    memex_hermes.register(ctx)
    assert len(ctx.providers) == 1
    assert isinstance(ctx.providers[0], MemexProvider)


def test_init_file_contains_discovery_marker_in_first_8192_bytes() -> None:
    init_path = Path(memex_hermes.__file__)
    head = init_path.read_bytes()[:8192]
    assert b"MemoryProvider" in head
    assert b"register_memory_provider" in head


def test_register_attribute_exposed() -> None:
    assert hasattr(memex_hermes, "register")
    assert isinstance(memex_hermes.register, Callable)


def test_memex_provider_exposed() -> None:
    assert hasattr(memex_hermes, "MemexProvider")


# Keep Any imported (silence ruff F401).
_: Any = None
