"""Shutdown drain bound — pending writes complete within 5s; overlong work canceled."""

from __future__ import annotations

import logging
import time
from pathlib import Path

import pytest
from fake_binary import (
    fake_binary_paths,
    read_envelopes,
    write_fake_binary,
)

from memex_hermes.envelope import HERMES_MEMORY_WRITE
from memex_hermes.runner import HermesRunner


def test_shutdown_waits_for_pending_write(tmp_path: Path) -> None:
    binary, record = fake_binary_paths(tmp_path)
    # Sleep 200 ms inside the binary.
    write_fake_binary(binary, stdout="{}", delay_seconds=0.2, record_to=record)
    runner = HermesRunner(hermes_home=tmp_path / "hermes", binary_path=binary)
    runner.fire_and_forget(
        HERMES_MEMORY_WRITE,
        {"action": "add", "target": "memory", "content": "x"},
    )
    start = time.monotonic()
    runner.shutdown(timeout_s=5.0)
    elapsed = time.monotonic() - start
    assert 0.15 <= elapsed <= 5.0, f"shutdown took {elapsed:.2f}s; expected ~0.2s"
    # The write completed before shutdown returned.
    envelopes = read_envelopes(record)
    assert len(envelopes) == 1


def test_shutdown_cancels_overlong_work_with_warning(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    binary, _ = fake_binary_paths(tmp_path)
    # Sleep way longer than the shutdown bound. (Per-event timeout for
    # memory-write is 10s; we set shutdown bound to 0.5s so timeout
    # is the binary's, not shutdown's; the binary is still running.)
    write_fake_binary(binary, stdout="{}", delay_seconds=3.0)
    runner = HermesRunner(hermes_home=tmp_path / "hermes", binary_path=binary)
    runner.fire_and_forget(
        HERMES_MEMORY_WRITE,
        {"action": "add", "target": "memory", "content": "x"},
    )
    # Give the worker a moment to pull the job off the queue.
    time.sleep(0.05)
    start = time.monotonic()
    with caplog.at_level(logging.WARNING, logger="memex_hermes.runner"):
        runner.shutdown(timeout_s=0.5)
    elapsed = time.monotonic() - start
    # Shutdown must NOT wait for the full 3s.
    assert elapsed < 1.5, f"shutdown waited {elapsed:.2f}s past its bound"
    assert any(
        "exceeded the" in r.message and "drain bound" in r.message for r in caplog.records
    ), "expected a warning about exceeding the drain bound"
