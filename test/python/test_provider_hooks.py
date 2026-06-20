"""Optional-hook tests (R4): on_session_switch, on_turn_start, on_delegation."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fake_binary import fake_binary_paths, read_envelopes, write_fake_binary
from stub_runner import StubRunner

from memex_hermes.provider import MemexProvider
from memex_hermes.runner import HermesRunner


def _provider_with_stub(tmp_path: Path) -> tuple[MemexProvider, StubRunner]:
    home = tmp_path / "hermes"
    home.mkdir(parents=True, exist_ok=True)
    p = MemexProvider()
    p.initialize("sess-A", hermes_home=str(home), platform="cli", agent_context="primary")
    stub = StubRunner()
    p._runner = stub  # type: ignore[assignment]
    return p, stub


def test_on_session_switch_rescopes_session_id(tmp_path: Path) -> None:
    p, stub = _provider_with_stub(tmp_path)
    p.on_session_switch("sess-B", reset=False)
    assert p._session_id == "sess-B"
    # Subsequent sync_turn must carry the new session_id.
    p.sync_turn("u", "a", session_id="")
    last = stub.calls[-1]
    assert last.event_name == "Hermes.sync-turn"
    assert last.args["session_id"] == "sess-B"


def test_on_session_switch_dispatches_event(tmp_path: Path) -> None:
    p, stub = _provider_with_stub(tmp_path)
    p.on_session_switch("sess-B", parent_session_id="sess-A", reset=False)
    sw = [c for c in stub.calls if c.event_name == "Hermes.session-switch"]
    assert sw, "session-switch must dispatch its event"
    assert sw[0].args["new_session_id"] == "sess-B"
    assert sw[0].args["parent_session_id"] == "sess-A"
    assert sw[0].args["reset"] is False


def test_on_session_switch_reset_true_flushes(tmp_path: Path) -> None:
    p, stub = _provider_with_stub(tmp_path)
    p.on_session_switch("sess-C", reset=True)
    # The stub registers shutdown; the test asserts the drain semantic.
    assert stub.shutdown_called is True


def test_reset_session_switch_does_not_kill_subsequent_writes(tmp_path: Path) -> None:
    """After a reset=True switch (which drains the worker), later writes
    must still reach the binary.

    This exercises the REAL runner — the stub's shutdown is a no-op flag,
    so it cannot catch the worker-lifecycle bug where ``shutdown`` left the
    runner permanently unable to dispatch fire-and-forget jobs.
    """
    home = tmp_path / "hermes"
    home.mkdir(parents=True, exist_ok=True)
    binary, record = fake_binary_paths(tmp_path)
    write_fake_binary(binary, stdout="{}", record_to=record)

    p = MemexProvider()
    p.initialize("sess-A", hermes_home=str(home), platform="cli", agent_context="primary")
    # Inject a real runner pointed at the fake binary (initialize built one
    # at the default path; replace it so dispatches are recorded).
    p._runner = HermesRunner(home, binary_path=binary)

    p.on_session_switch("sess-RESET", reset=True)
    p.sync_turn("u", "a")

    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        names = [e["envelope"]["hook_event_name"] for e in read_envelopes(record)]
        if "Hermes.sync-turn" in names:
            break
        time.sleep(0.02)
    p.shutdown()

    names = [e["envelope"]["hook_event_name"] for e in read_envelopes(record)]
    assert "Hermes.session-switch" in names, "the reset switch event must reach the binary"
    assert "Hermes.sync-turn" in names, (
        "a write after a reset session-switch must reach the binary "
        "(worker must be re-armed after the drain)"
    )


def test_on_turn_start_is_no_op_no_runner_call(tmp_path: Path) -> None:
    p, stub = _provider_with_stub(tmp_path)
    p.on_turn_start(3, "user message", model="x", remaining_tokens=1234)
    assert stub.calls == []


def test_on_delegation_is_no_op_no_runner_call(tmp_path: Path) -> None:
    p, stub = _provider_with_stub(tmp_path)
    p.on_delegation("subtask", "result", child_session_id="child")
    assert stub.calls == []


def test_on_turn_start_does_not_raise_without_runner() -> None:
    p = MemexProvider()
    # No initialize call → no runner. Must still not raise.
    p.on_turn_start(1, "x")


def test_on_delegation_does_not_raise_without_runner() -> None:
    p = MemexProvider()
    p.on_delegation("t", "r")


# ---- accepts forward-compat **kwargs the manager may pass -----------------


@pytest.mark.parametrize("extra", [{"model": "x"}, {"remaining_tokens": 100}, {"foo": "bar"}])
def test_on_turn_start_accepts_extra_kwargs(extra: dict[str, object]) -> None:
    p = MemexProvider()
    p.on_turn_start(1, "msg", **extra)


@pytest.mark.parametrize("extra", [{"foo": "bar"}, {"trace_id": "x"}])
def test_on_delegation_accepts_extra_kwargs(extra: dict[str, object]) -> None:
    p = MemexProvider()
    p.on_delegation("t", "r", **extra)
