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


def _wait_for_envelopes(record: Path, count: int, timeout_s: float = 5.0) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline and len(read_envelopes(record)) < count:
        time.sleep(0.02)


def test_shutdown_leaves_runner_reusable_for_faf(tmp_path: Path) -> None:
    """A fire_and_forget AFTER shutdown must restart the worker and execute.

    Regression for the reset=True session-switch path: ``shutdown`` used to
    set a process-wide stop flag and never clear it, so the worker exited
    and every later FAF enqueued into a queue no thread drained — writes
    silently lost. The runner must be reusable after a bounded drain.
    """
    binary, record = fake_binary_paths(tmp_path)
    write_fake_binary(binary, stdout="{}", record_to=record)
    runner = _runner(tmp_path, binary=binary)

    runner.fire_and_forget(
        HERMES_SYNC_TURN, {"user_content": "u0", "assistant_content": "a0"}
    )
    _wait_for_envelopes(record, 1)
    runner.shutdown(timeout_s=2.0)

    # Re-use the SAME runner instance after shutdown.
    runner.fire_and_forget(
        HERMES_SYNC_TURN, {"user_content": "u1", "assistant_content": "a1"}
    )
    _wait_for_envelopes(record, 2)
    runner.shutdown(timeout_s=2.0)

    contents = [
        e["envelope"]["args"]["user_content"]  # type: ignore[index]
        for e in read_envelopes(record)
    ]
    assert "u0" in contents
    assert "u1" in contents, "fire_and_forget after shutdown must restart the worker"


def test_repeated_shutdown_is_idempotent(tmp_path: Path) -> None:
    """Calling shutdown twice (no worker the second time) must not raise."""
    binary, record = fake_binary_paths(tmp_path)
    write_fake_binary(binary, stdout="{}", record_to=record)
    runner = _runner(tmp_path, binary=binary)
    runner.fire_and_forget(
        HERMES_SYNC_TURN, {"user_content": "u", "assistant_content": "a"}
    )
    _wait_for_envelopes(record, 1)
    runner.shutdown(timeout_s=2.0)
    runner.shutdown(timeout_s=2.0)  # no live worker — must be a clean no-op


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


def test_cache_binary_takes_precedence_when_present(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A binary at $HERMES_HOME/cache/memex/bin/memex is used when present."""
    monkeypatch.delenv(ENV_MEMEX_BINARY, raising=False)
    home = tmp_path / "hermes"
    cache_bin = home / "cache" / "memex" / "bin" / "memex"
    write_fake_binary(cache_bin, stdout="{}")
    runner = HermesRunner(hermes_home=home)
    assert runner._resolve_binary() == cache_bin


def test_default_resolves_to_packaged_wrapper_when_no_cache_binary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With no override/env/cache binary, resolution lands on the shipped
    ``bin/memex`` wrapper — a real, existing file — not a path nothing
    populates.

    Regression for P1-1: the default used to be a cache path the install
    flow never creates, so every binary call silently degraded to no-op.
    """
    monkeypatch.delenv(ENV_MEMEX_BINARY, raising=False)
    home = tmp_path / "hermes"
    home.mkdir()
    runner = HermesRunner(hermes_home=home)
    resolved = runner._resolve_binary()
    assert resolved.is_file(), (
        f"default binary resolution must land on an existing wrapper, got {resolved}"
    )
    assert resolved.name == "memex"
    assert resolved.parent.name == "bin"


# ---- Sanity: env var name and constants ------------------------------------


def test_env_var_constant_name() -> None:
    assert ENV_MEMEX_HOME == "MEMEX_HERMES_HOME"
    assert ENV_MEMEX_BINARY == "MEMEX_HERMES_BINARY"


# ---- noqa: typing ----------------------------------------------------------

# read_envelopes returns dict[str, object]; static reads index into it.
_ = Any  # keep the Any import used; ruff flags otherwise
