"""ABC signature conformance (R3 / R6).

The Hermes MemoryManager invokes provider methods via keyword args
(``agent/memory_manager.py:348-380``). A provider that declares
positional-only parameters would raise ``TypeError`` and the manager
would silently swallow the failure. These tests assert the provider's
signatures accept the manager's keyword-style calls verbatim.
"""

from __future__ import annotations

from pathlib import Path

from stub_runner import StubRunner

from memex_hermes.provider import MemexProvider


def _init(tmp_path: Path) -> tuple[MemexProvider, StubRunner]:
    home = tmp_path / "hermes"
    home.mkdir(parents=True, exist_ok=True)
    p = MemexProvider()
    p.initialize("sess-A", hermes_home=str(home), platform="cli", agent_context="primary")
    stub = StubRunner()
    p._runner = stub  # type: ignore[assignment]
    return p, stub


def test_prefetch_keyword_call_accepted(tmp_path: Path) -> None:
    p, _ = _init(tmp_path)
    # Manager calls provider.prefetch(query, session_id=...).
    p.prefetch("q", session_id="s")


def test_queue_prefetch_keyword_call_accepted(tmp_path: Path) -> None:
    p, _ = _init(tmp_path)
    p.queue_prefetch("q", session_id="s")


def test_sync_turn_keyword_call_accepted(tmp_path: Path) -> None:
    p, _ = _init(tmp_path)
    p.sync_turn("u", "a", session_id="s")


def test_on_memory_write_keyword_metadata(tmp_path: Path) -> None:
    p, _ = _init(tmp_path)
    p.on_memory_write("add", "memory", "x", metadata={"write_origin": "remember"})


def test_handle_tool_call_extra_kwargs_accepted(tmp_path: Path) -> None:
    p, _ = _init(tmp_path)
    # Manager may pass extras (`**kwargs`); the provider must accept them.
    p.handle_tool_call("memex_search", {"query": "x"}, manager_extra="y")


def test_on_pre_compress_returns_str(tmp_path: Path) -> None:
    p, _ = _init(tmp_path)
    out = p.on_pre_compress([])
    assert isinstance(out, str)


def test_get_config_schema_returns_list(tmp_path: Path) -> None:
    p, _ = _init(tmp_path)
    out = p.get_config_schema()
    assert isinstance(out, list)


def test_save_config_with_hermes_home_arg(tmp_path: Path) -> None:
    p = MemexProvider()
    p.save_config({"enabled": False}, str(tmp_path / "custom"))
    target = tmp_path / "custom" / "memex.json"
    assert target.is_file()


def test_on_session_switch_keyword_call_accepted(tmp_path: Path) -> None:
    p, _ = _init(tmp_path)
    p.on_session_switch("sess-B", parent_session_id="sess-A", reset=False)


def test_on_session_switch_accepts_unknown_kwargs(tmp_path: Path) -> None:
    p, _ = _init(tmp_path)
    p.on_session_switch("sess-B", parent_session_id="sess-A", reset=False, novel="x")
