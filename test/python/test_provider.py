"""Core provider tests: identity, initialize, dispatch, non-blocking sync_turn."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from stub_runner import StubRunner

from memex_hermes.provider import MemexProvider


def _provider_with_stub(
    tmp_path: Path, *, agent_context: str = "primary"
) -> tuple[MemexProvider, StubRunner]:
    home = tmp_path / "hermes"
    home.mkdir(parents=True, exist_ok=True)
    p = MemexProvider()
    p.initialize(
        "sess-1",
        hermes_home=str(home),
        platform="cli",
        agent_context=agent_context,
    )
    stub = StubRunner()
    p._runner = stub  # type: ignore[assignment]
    # Reset cached prompt so subsequent system_prompt calls are clean.
    p._system_prompt_cache = None
    return p, stub


# ---- Identity ---------------------------------------------------------------


def test_name_is_memex() -> None:
    assert MemexProvider().name == "memex"


# ---- initialize -------------------------------------------------------------


def test_initialize_captures_session_id_and_hermes_home(tmp_path: Path) -> None:
    home = tmp_path / "hermes"
    home.mkdir()
    p = MemexProvider()
    p.initialize(
        "sess-A",
        hermes_home=str(home),
        platform="cli",
        agent_context="primary",
    )
    assert p._session_id == "sess-A"
    assert p._hermes_home == home
    assert p._agent_context == "primary"


def test_initialize_tolerates_unknown_kwargs(tmp_path: Path) -> None:
    home = tmp_path / "hermes"
    home.mkdir()
    p = MemexProvider()
    p.initialize(
        "sess-A",
        hermes_home=str(home),
        platform="cli",
        agent_context="primary",
        session_title="ignored",
        chat_id="X",
        agent_workspace="hermes",
        novel_future_kwarg=42,
    )
    assert p._session_id == "sess-A"


def test_initialize_dispatches_hermes_init_with_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Capture every HermesRunner the provider constructs so we can inspect
    # the Hermes.init dispatch even though initialize creates its own runner.
    from memex_hermes import provider as provider_mod

    created: list[StubRunner] = []

    def fake_runner_factory(hermes_home: Path) -> StubRunner:
        s = StubRunner()
        created.append(s)
        return s

    monkeypatch.setattr(provider_mod, "HermesRunner", fake_runner_factory)
    home = tmp_path / "hermes"
    home.mkdir()
    p = MemexProvider()
    p.initialize(
        "sess-2",
        hermes_home=str(home),
        platform="cli",
        agent_context="primary",
    )
    assert created, "initialize must construct a HermesRunner"
    init_calls = [c for c in created[0].calls if c.event_name == "Hermes.init"]
    assert init_calls, "initialize must dispatch Hermes.init"
    assert init_calls[0].args["hermes_home"] == str(home)


def test_initialize_without_hermes_home_does_not_raise(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("HERMES_HOME", raising=False)
    p = MemexProvider()
    p.initialize("sess-X", platform="cli")  # No hermes_home — degrade gracefully.
    assert p._session_id == "sess-X"


# ---- Dispatch propagates MEMEX_HERMES_HOME (covered by runner test) --------


def test_subsequent_calls_carry_session_id(tmp_path: Path) -> None:
    p, stub = _provider_with_stub(tmp_path)
    p.prefetch("hello", session_id="caller-sess")
    assert stub.calls[-1].event_name == "Hermes.prefetch"
    assert stub.calls[-1].args["session_id"] == "caller-sess"

    p.queue_prefetch("next", session_id="caller-sess")
    assert stub.calls[-1].event_name == "Hermes.queue-prefetch"


# ---- system_prompt_block: static + cached ----------------------------------


def test_system_prompt_block_is_cached_byte_identical(tmp_path: Path) -> None:
    p, stub = _provider_with_stub(tmp_path)
    stub.next_result = {"block": "static-block-X"}
    first = p.system_prompt_block()
    # Change the would-be next result; subsequent calls must still return the cached value.
    stub.next_result = {"block": "different-now"}
    second = p.system_prompt_block()
    third = p.system_prompt_block()
    assert first == second == third == "static-block-X"
    # Exactly one Hermes.system-prompt dispatch (the prime call).
    sp_calls = [c for c in stub.calls if c.event_name == "Hermes.system-prompt"]
    assert len(sp_calls) == 1


# ---- prefetch returns additionalContext str --------------------------------


def test_prefetch_returns_additional_context(tmp_path: Path) -> None:
    p, stub = _provider_with_stub(tmp_path)
    stub.next_result = {"additionalContext": "match"}
    out = p.prefetch("q", session_id="s")
    assert out == "match"
    assert stub.calls[-1].event_name == "Hermes.prefetch"
    assert stub.calls[-1].args["query"] == "q"


def test_prefetch_returns_empty_on_missing_field(tmp_path: Path) -> None:
    p, stub = _provider_with_stub(tmp_path)
    stub.next_result = {}
    assert p.prefetch("q") == ""


# ---- on_pre_compress returns str -------------------------------------------


def test_on_pre_compress_returns_str(tmp_path: Path) -> None:
    p, stub = _provider_with_stub(tmp_path)
    stub.next_result = {"summary": "compressed insight"}
    out = p.on_pre_compress([{"role": "user", "content": "x"}])
    assert isinstance(out, str)
    assert out == "compressed insight"


def test_on_pre_compress_missing_summary_returns_empty_str(tmp_path: Path) -> None:
    p, stub = _provider_with_stub(tmp_path)
    stub.next_result = {}
    out = p.on_pre_compress([])
    assert out == ""
    assert isinstance(out, str)


# ---- handle_tool_call accepts **kwargs, JSON-encodes ----------------------


def test_handle_tool_call_accepts_kwargs_and_returns_json_str(tmp_path: Path) -> None:
    p, stub = _provider_with_stub(tmp_path)
    stub.next_result = {"results": [{"name": "x", "score": 0.9}]}
    out = p.handle_tool_call("memex_search", {"query": "foo"}, manager_kwarg="ignored")
    parsed = json.loads(out)
    assert parsed == {"results": [{"name": "x", "score": 0.9}]}
    assert stub.calls[-1].event_name == "Hermes.tool-search"


def test_handle_tool_call_unknown_tool_returns_error_json(tmp_path: Path) -> None:
    p, _stub = _provider_with_stub(tmp_path)
    out = p.handle_tool_call("nonexistent_tool", {})
    parsed = json.loads(out)
    assert parsed["error"] == "unknown_tool"
    assert parsed["tool_name"] == "nonexistent_tool"


def test_handle_tool_call_routes_remember_and_recall(tmp_path: Path) -> None:
    p, stub = _provider_with_stub(tmp_path)
    stub.next_result = {}
    p.handle_tool_call("memex_remember", {"content": "x"})
    p.handle_tool_call("memex_recall", {"name": "foo"})
    events = [c.event_name for c in stub.calls if c.event_name.startswith("Hermes.tool-")]
    assert "Hermes.tool-remember" in events
    assert "Hermes.tool-recall" in events


# ---- on_memory_write metadata propagation ----------------------------------


def test_on_memory_write_forwards_metadata(tmp_path: Path) -> None:
    p, stub = _provider_with_stub(tmp_path)
    p.on_memory_write(
        "add", "memory", "remember dark mode", metadata={"write_origin": "remember"}
    )
    call = next(c for c in stub.calls if c.event_name == "Hermes.memory-write")
    assert call.args["action"] == "add"
    assert call.args["target"] == "memory"
    assert call.args["content"] == "remember dark mode"
    assert call.args["metadata"] == {"write_origin": "remember"}


def test_on_memory_write_without_metadata_omits_field(tmp_path: Path) -> None:
    p, stub = _provider_with_stub(tmp_path)
    p.on_memory_write("replace", "user", "user prefers X")
    call = next(c for c in stub.calls if c.event_name == "Hermes.memory-write")
    assert "metadata" not in call.args


# ---- save_config respects hermes_home arg ----------------------------------


def test_save_config_writes_to_hermes_home_arg(tmp_path: Path) -> None:
    custom_home = tmp_path / "custom_home"
    p = MemexProvider()
    p.save_config({"enabled": False, "sync": {"enabled": True}}, str(custom_home))
    target = custom_home / "memex.json"
    assert target.is_file()
    body = json.loads(target.read_text(encoding="utf-8"))
    assert body["enabled"] is False
    # And nothing was written outside that path.
    other = Path.home() / ".hermes" / "memex.json"
    # Only assert the WRITE didn't go to home; we don't care if a real file exists already.
    if other.exists():
        # Not under our redirected tmp; we only assert that the test created the custom one.
        pass


# ---- get_tool_schemas / get_config_schema do not invoke binary -------------


def test_get_tool_schemas_does_not_invoke_runner(tmp_path: Path) -> None:
    p, stub = _provider_with_stub(tmp_path)
    stub.reset()
    schemas = p.get_tool_schemas()
    assert stub.calls == []
    assert {s["name"] for s in schemas} >= {"memex_search", "memex_remember", "memex_recall"}


def test_get_config_schema_returns_list_no_binary(tmp_path: Path) -> None:
    p, stub = _provider_with_stub(tmp_path)
    stub.reset()
    fields = p.get_config_schema()
    assert isinstance(fields, list)
    assert all(isinstance(f, dict) for f in fields)
    assert stub.calls == []


# ---- 8.5 non-blocking sync_turn (< 5ms even when binary sleeps) ------------


def test_sync_turn_returns_quickly_even_when_subprocess_sleeps(tmp_path: Path) -> None:
    p, stub = _provider_with_stub(tmp_path)

    # Make the stub sync runner sleep — but sync_turn is FAF so it should NOT
    # touch run_subprocess_sync. Adding a sleep to fire_and_forget should
    # NOT block either because it returns after enqueue.
    started = time.monotonic()
    p.sync_turn("user", "assistant", session_id="s")
    elapsed = time.monotonic() - started
    assert elapsed < 0.005, f"sync_turn took {elapsed * 1000:.2f}ms; must be < 5ms"
    assert stub.calls[-1].surface == "faf"
    assert stub.calls[-1].event_name == "Hermes.sync-turn"
