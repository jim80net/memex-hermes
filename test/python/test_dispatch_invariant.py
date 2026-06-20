"""§8.8 / G3 — method → hook_event_name dispatch invariant.

For each provider method that invokes the binary, verify the exact
``hook_event_name`` recorded by the stub runner matches the spec
table. Methods that should NOT invoke the binary (``name``,
``get_tool_schemas``, ``get_config_schema``, ``save_config``,
``on_turn_start``, ``on_delegation``) MUST produce no recorded entries.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest
from stub_runner import StubRunner

from memex_hermes.provider import MemexProvider


def _init(tmp_path: Path) -> tuple[MemexProvider, StubRunner]:
    home = tmp_path / "hermes"
    home.mkdir(parents=True, exist_ok=True)
    p = MemexProvider()
    p.initialize("sess-A", hermes_home=str(home), platform="cli", agent_context="primary")
    stub = StubRunner()
    p._runner = stub  # type: ignore[assignment]
    # Reset cached prompt so system_prompt_block dispatches a fresh call.
    p._system_prompt_cache = None
    stub.reset()
    return p, stub


# (method-name, invoker, expected hook_event_name)
DISPATCH_CASES: list[tuple[str, Callable[[MemexProvider], object], str]] = [
    ("is_available", lambda p: p.is_available(), "Hermes.health"),
    ("system_prompt_block", lambda p: p.system_prompt_block(), "Hermes.system-prompt"),
    ("prefetch", lambda p: p.prefetch("q"), "Hermes.prefetch"),
    ("queue_prefetch", lambda p: p.queue_prefetch("q"), "Hermes.queue-prefetch"),
    ("sync_turn", lambda p: p.sync_turn("u", "a"), "Hermes.sync-turn"),
    ("on_session_end", lambda p: p.on_session_end([]), "Hermes.session-end"),
    ("on_pre_compress", lambda p: p.on_pre_compress([]), "Hermes.pre-compress"),
    (
        "on_memory_write",
        lambda p: p.on_memory_write("add", "memory", "x", metadata={"k": "v"}),
        "Hermes.memory-write",
    ),
    (
        "on_session_switch",
        lambda p: p.on_session_switch("sess-B"),
        "Hermes.session-switch",
    ),
    (
        "handle_tool_call_search",
        lambda p: p.handle_tool_call("memex_search", {"query": "x"}),
        "Hermes.tool-search",
    ),
    (
        "handle_tool_call_remember",
        lambda p: p.handle_tool_call("memex_remember", {"content": "x"}),
        "Hermes.tool-remember",
    ),
    (
        "handle_tool_call_recall",
        lambda p: p.handle_tool_call("memex_recall", {"name": "x"}),
        "Hermes.tool-recall",
    ),
]


@pytest.mark.parametrize(
    "method_name,invoker,expected_event",
    DISPATCH_CASES,
    ids=[c[0] for c in DISPATCH_CASES],
)
def test_method_dispatches_expected_event(
    tmp_path: Path,
    method_name: str,
    invoker: Callable[[MemexProvider], object],
    expected_event: str,
) -> None:
    p, stub = _init(tmp_path)
    invoker(p)
    events = [c.event_name for c in stub.calls]
    assert expected_event in events, (
        f"{method_name} should dispatch {expected_event}; got {events}"
    )


# ---- Methods that must NOT invoke the binary ------------------------------


NO_DISPATCH_CASES: list[tuple[str, Callable[[MemexProvider], object]]] = [
    ("name", lambda p: p.name),
    ("get_tool_schemas", lambda p: p.get_tool_schemas()),
    ("get_config_schema", lambda p: p.get_config_schema()),
    ("on_turn_start", lambda p: p.on_turn_start(1, "msg")),
    ("on_delegation", lambda p: p.on_delegation("t", "r")),
]


@pytest.mark.parametrize(
    "method_name,invoker",
    NO_DISPATCH_CASES,
    ids=[c[0] for c in NO_DISPATCH_CASES],
)
def test_method_does_not_invoke_binary(
    tmp_path: Path,
    method_name: str,
    invoker: Callable[[MemexProvider], object],
) -> None:
    p, stub = _init(tmp_path)
    invoker(p)
    assert stub.calls == [], (
        f"{method_name} must not invoke the binary; got events: "
        f"{[c.event_name for c in stub.calls]}"
    )


def test_save_config_does_not_invoke_binary(tmp_path: Path) -> None:
    # save_config has no runner attached (it's typically called pre-init
    # by the CLI) — assert by construction it doesn't reach a runner.
    p, stub = _init(tmp_path)
    stub.reset()
    p.save_config({"enabled": False}, str(tmp_path / "h"))
    assert stub.calls == []
