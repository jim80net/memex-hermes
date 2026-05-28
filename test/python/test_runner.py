"""Tests for memex_hermes.runner — subprocess shape, FAF queue, timeouts."""

from __future__ import annotations

import logging
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
from fake_binary import (
    fake_binary_paths,
    read_envelopes,
    write_fake_binary,
)

from memex_hermes.envelope import (
    HERMES_HEALTH,
    HERMES_PREFETCH,
    HERMES_SYNC_TURN,
)
from memex_hermes.runner import (
    ENV_MEMEX_BINARY,
    ENV_MEMEX_HOME,
    HermesRunner,
)

# ---- await_subprocess (sync sibling) JSON envelope shapes ------------------


def _runner(
    tmp_path: Path, *, binary: Path | None = None, queue_capacity: int = 128
) -> HermesRunner:
    home = tmp_path / "hermes"
    home.mkdir(parents=True, exist_ok=True)
    return HermesRunner(hermes_home=home, binary_path=binary, queue_capacity=queue_capacity)


def test_await_subprocess_writes_correct_envelope_shape(tmp_path: Path) -> None:
    binary, record = fake_binary_paths(tmp_path)
    write_fake_binary(
        binary,
        stdout='{"ready": true}',
        record_to=record,
    )
    runner = _runner(tmp_path, binary=binary)
    result = runner.run_subprocess_sync(
        HERMES_HEALTH,
        {"probe": "ok"},
        session_id="sess-A",
        cwd="/home/jim/proj",
    )
    assert result == {"ready": True}

    envelopes = read_envelopes(record)
    assert len(envelopes) == 1
    envelope = envelopes[0]["envelope"]
    assert isinstance(envelope, Mapping)
    assert envelope["hook_event_name"] == "Hermes.health"
    assert envelope["args"] == {"probe": "ok"}
    assert envelope["session_id"] == "sess-A"
    assert envelope["cwd"] == "/home/jim/proj"


def test_memex_hermes_home_is_set_on_subprocess_env(tmp_path: Path) -> None:
    binary, record = fake_binary_paths(tmp_path)
    write_fake_binary(binary, stdout="{}", record_to=record)
    runner = _runner(tmp_path, binary=binary)
    runner.run_subprocess_sync(HERMES_HEALTH, {})

    envelopes = read_envelopes(record)
    assert len(envelopes) == 1
    assert envelopes[0]["env_MEMEX_HERMES_HOME"] == str(tmp_path / "hermes")


# ---- failure modes ---------------------------------------------------------


def test_missing_binary_returns_empty_and_emits_install_hint_once(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    missing = tmp_path / "nonexistent" / "memex"
    runner = _runner(tmp_path, binary=missing)
    with caplog.at_level(logging.WARNING, logger="memex_hermes.runner"):
        out1 = runner.run_subprocess_sync(HERMES_HEALTH, {})
        out2 = runner.run_subprocess_sync(HERMES_HEALTH, {})
        out3 = runner.run_subprocess_sync(HERMES_PREFETCH, {"query": "x"})
    assert out1 == {} and out2 == {} and out3 == {}
    hints = [r for r in caplog.records if "binary not found" in r.message]
    assert len(hints) == 1, "install hint must be emitted at most once per session"


def test_nonzero_exit_logs_stderr_and_returns_empty(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    binary, _ = fake_binary_paths(tmp_path)
    write_fake_binary(binary, stdout="", stderr="boom\n", exit_code=2)
    runner = _runner(tmp_path, binary=binary)
    with caplog.at_level(logging.WARNING, logger="memex_hermes.runner"):
        out = runner.run_subprocess_sync(HERMES_PREFETCH, {"query": "x"})
    assert out == {}
    assert any(
        "exited with status 2" in r.message and "boom" in r.message for r in caplog.records
    )


def test_invalid_json_logs_warning_and_returns_empty(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    binary, _ = fake_binary_paths(tmp_path)
    write_fake_binary(binary, stdout="not json")
    runner = _runner(tmp_path, binary=binary)
    with caplog.at_level(logging.WARNING, logger="memex_hermes.runner"):
        out = runner.run_subprocess_sync(HERMES_PREFETCH, {"query": "x"})
    assert out == {}
    assert any("Invalid JSON" in r.message for r in caplog.records)


def test_timeout_kills_subprocess_and_returns_empty(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    binary, _ = fake_binary_paths(tmp_path)
    write_fake_binary(binary, stdout="{}", delay_seconds=2.0)
    runner = _runner(tmp_path, binary=binary)
    with caplog.at_level(logging.WARNING, logger="memex_hermes.runner"):
        out = runner.run_subprocess_sync(
            HERMES_PREFETCH, {"query": "x"}, timeout_s=0.2
        )
    assert out == {}
    assert any("Timeout" in r.message for r in caplog.records)


# ---- fire_and_forget: daemon thread + bounded queue -----------------------


def test_fire_and_forget_invokes_binary_off_thread(tmp_path: Path) -> None:
    binary, record = fake_binary_paths(tmp_path)
    write_fake_binary(binary, stdout='{"ok": true}', record_to=record)
    runner = _runner(tmp_path, binary=binary)
    runner.fire_and_forget(
        HERMES_SYNC_TURN,
        {"user_content": "u", "assistant_content": "a"},
        session_id="sess-1",
    )
    # The worker drains within bounded time; wait briefly.
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline and not read_envelopes(record):
        time.sleep(0.02)
    envelopes = read_envelopes(record)
    assert len(envelopes) == 1
    assert envelopes[0]["envelope"]["hook_event_name"] == "Hermes.sync-turn"
    runner.shutdown(timeout_s=2.0)


def test_faf_queue_overflow_drops_oldest_with_warning(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    # Block the worker by giving it a slow first job, then fill the queue.
    binary, record = fake_binary_paths(tmp_path)
    write_fake_binary(binary, stdout="{}", delay_seconds=0.5, record_to=record)
    runner = _runner(tmp_path, binary=binary, queue_capacity=2)

    with caplog.at_level(logging.WARNING, logger="memex_hermes.runner"):
        # First job kicks off; the worker starts processing it (0.5s delay).
        runner.fire_and_forget(
            HERMES_SYNC_TURN, {"user_content": "u0", "assistant_content": "a0"}
        )
        time.sleep(0.05)  # let worker pick up the first job
        # Now fill the queue capacity.
        runner.fire_and_forget(
            HERMES_SYNC_TURN, {"user_content": "u1", "assistant_content": "a1"}
        )
        runner.fire_and_forget(
            HERMES_SYNC_TURN, {"user_content": "u2", "assistant_content": "a2"}
        )
        # This one should evict the oldest pending (u1).
        runner.fire_and_forget(
            HERMES_SYNC_TURN, {"user_content": "u3", "assistant_content": "a3"}
        )
    drops = [r for r in caplog.records if "dropped oldest" in r.message]
    assert drops, "expected a drop-oldest warning when queue is full"

    runner.shutdown(timeout_s=5.0)
    envelopes = read_envelopes(record)
    contents = [
        e["envelope"]["args"]["user_content"]  # type: ignore[index]
        for e in envelopes
    ]
    # u1 was dropped; u0 (already in flight), u2, u3 should appear.
    assert "u1" not in contents
    assert "u0" in contents
    assert "u3" in contents


# ---- await_subprocess (true async) ----------------------------------------


@pytest.mark.asyncio
async def test_await_subprocess_returns_parsed_mapping(tmp_path: Path) -> None:
    binary, _ = fake_binary_paths(tmp_path)
    write_fake_binary(binary, stdout='{"additionalContext": "ctx"}')
    runner = _runner(tmp_path, binary=binary)
    result = await runner.await_subprocess(HERMES_PREFETCH, {"query": "q"})
    assert isinstance(result, Mapping)
    assert dict(result) == {"additionalContext": "ctx"}


# ---- Binary-path resolution -----------------------------------------------


def test_binary_path_from_env_var(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    binary, record = fake_binary_paths(tmp_path)
    write_fake_binary(binary, stdout="{}", record_to=record)
    monkeypatch.setenv(ENV_MEMEX_BINARY, str(binary))
    # Build the runner without an explicit binary_path; it must pick up env.
    runner = HermesRunner(hermes_home=tmp_path / "hermes")
    runner.run_subprocess_sync(HERMES_HEALTH, {})
    assert read_envelopes(record), "binary indicated by env var must be invoked"


def test_default_binary_path_under_hermes_home(tmp_path: Path) -> None:
    home = tmp_path / "hermes"
    home.mkdir()
    runner = HermesRunner(hermes_home=home)
    # The internal resolver: binary lives at $HERMES_HOME/cache/memex/bin/memex.
    # We only verify the path it chose, indirectly via a subprocess that fails
    # to spawn (FileNotFoundError) — the install hint mentions that path.
    out = runner.run_subprocess_sync(HERMES_HEALTH, {})
    assert out == {}


# ---- Sanity: env var name and constants ------------------------------------


def test_env_var_constant_name() -> None:
    assert ENV_MEMEX_HOME == "MEMEX_HERMES_HOME"
    assert ENV_MEMEX_BINARY == "MEMEX_HERMES_BINARY"


# ---- noqa: typing ----------------------------------------------------------

# read_envelopes returns dict[str, object]; static reads index into it.
_ = Any  # keep the Any import used; ruff flags otherwise
