"""Agent-context write suppression (R5).

When ``agent_context`` is ``subagent`` / ``cron`` / ``flush``, the
provider must suppress sync_turn / on_memory_write / on_session_end
WITHOUT invoking the runner and must log the reason.
"""

from __future__ import annotations

import logging
from pathlib import Path

import pytest
from stub_runner import StubRunner

from memex_hermes.provider import MemexProvider


def _provider_with_context(tmp_path: Path, agent_context: str) -> tuple[MemexProvider, StubRunner]:
    home = tmp_path / "hermes"
    home.mkdir(parents=True, exist_ok=True)
    p = MemexProvider()
    p.initialize("sess-A", hermes_home=str(home), platform="cli", agent_context=agent_context)
    stub = StubRunner()
    p._runner = stub  # type: ignore[assignment]
    return p, stub


@pytest.mark.parametrize("context", ["subagent", "cron", "flush"])
def test_sync_turn_suppressed_for_non_primary(
    tmp_path: Path, context: str, caplog: pytest.LogCaptureFixture
) -> None:
    p, stub = _provider_with_context(tmp_path, context)
    with caplog.at_level(logging.INFO, logger="memex_hermes.provider"):
        p.sync_turn("u", "a")
    assert stub.calls == [], f"sync_turn must be suppressed for {context}"
    assert any("suppressing write" in r.message for r in caplog.records)


@pytest.mark.parametrize("context", ["subagent", "cron", "flush"])
def test_on_memory_write_suppressed_for_non_primary(tmp_path: Path, context: str) -> None:
    p, stub = _provider_with_context(tmp_path, context)
    p.on_memory_write("add", "memory", "x")
    assert stub.calls == []


@pytest.mark.parametrize("context", ["subagent", "cron", "flush"])
def test_on_session_end_suppressed_for_non_primary(tmp_path: Path, context: str) -> None:
    p, stub = _provider_with_context(tmp_path, context)
    p.on_session_end([{"role": "user", "content": "x"}])
    assert stub.calls == []


def test_primary_context_writes_normally(tmp_path: Path) -> None:
    p, stub = _provider_with_context(tmp_path, "primary")
    p.sync_turn("u", "a")
    p.on_memory_write("add", "memory", "x")
    p.on_session_end([{"role": "user", "content": "x"}])
    event_names = [c.event_name for c in stub.calls]
    assert "Hermes.sync-turn" in event_names
    assert "Hermes.memory-write" in event_names
    assert "Hermes.session-end" in event_names


def test_read_paths_remain_active_for_subagent(tmp_path: Path) -> None:
    p, stub = _provider_with_context(tmp_path, "subagent")
    p.prefetch("q", session_id="s")
    p.handle_tool_call("memex_search", {"query": "x"})
    p.handle_tool_call("memex_recall", {"name": "x"})
    event_names = [c.event_name for c in stub.calls]
    assert "Hermes.prefetch" in event_names
    assert "Hermes.tool-search" in event_names
    assert "Hermes.tool-recall" in event_names


@pytest.mark.parametrize("context", ["subagent", "cron", "flush"])
def test_remember_tool_call_suppressed_for_non_primary(tmp_path: Path, context: str) -> None:
    # memex_remember is a WRITE tool: an explicit tool-call from a non-primary
    # context must be suppressed before reaching the binary (the binary's
    # tool-remember handler has no agent_context gate), closing the R5 hole.
    p, stub = _provider_with_context(tmp_path, context)
    result = p.handle_tool_call("memex_remember", {"content": "x"})
    assert stub.calls == [], f"memex_remember must be suppressed for {context}"
    assert "suppressed" in result


def test_remember_tool_call_active_for_primary(tmp_path: Path) -> None:
    p, stub = _provider_with_context(tmp_path, "primary")
    p.handle_tool_call("memex_remember", {"content": "x"})
    assert any(c.event_name == "Hermes.tool-remember" for c in stub.calls)


def test_metadata_execution_context_can_override(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    p, stub = _provider_with_context(tmp_path, "primary")
    # Even though initialize said "primary", metadata can override.
    with caplog.at_level(logging.INFO, logger="memex_hermes.provider"):
        p.on_memory_write(
            "add", "memory", "x", metadata={"execution_context": "subagent"}
        )
    assert stub.calls == []
    assert any("execution_context=subagent" in r.message for r in caplog.records)
