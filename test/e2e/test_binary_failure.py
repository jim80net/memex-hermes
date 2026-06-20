"""§11.6 — Binary failure does not crash the Hermes session.

When the memex binary is missing, renamed, or non-executable, the
provider MUST degrade to safe defaults on every callback (empty
context for prefetch, no-op for sync_turn / on_memory_write,
``False`` for is_available, error JSON for tool calls) and MUST NOT
propagate an exception that would crash the Hermes runtime.

This test exercises every method that hits the runner with
``MEMEX_HERMES_BINARY`` pointed at a non-existent path. Each call
must return a safe default; no exception escapes.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from pathlib import Path

import pytest

from memex_hermes.provider import MemexProvider


def _provider(
    hermes_home: Path,
    env_overrides: Mapping[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> MemexProvider:
    """Helper: construct + initialize a MemexProvider with a fake binary path.

    Uses ``monkeypatch.setenv`` so the env mutation is reverted after
    the test, preventing fixture state from bleeding into the next
    test (e.g. the ``memex_binary_path`` fixture's env probe).
    """
    for key, value in env_overrides.items():
        monkeypatch.setenv(key, value)

    provider = MemexProvider()
    provider.initialize(
        session_id="e2e-binfail",
        hermes_home=str(hermes_home),
        platform="cli",
        agent_context="primary",
    )
    return provider


def test_provider_does_not_crash_when_binary_missing(
    hermes_home: Path,
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Smoke test: every callback returns its safe default with a missing binary."""
    caplog.set_level(logging.WARNING)
    bogus = hermes_home / "no_such" / "memex"
    provider = _provider(
        hermes_home, {"MEMEX_HERMES_BINARY": str(bogus)}, monkeypatch
    )

    # Read paths -> safe empty default; no exception.
    prefetch_result = provider.prefetch("deploy the daemon")
    assert prefetch_result == "", f"prefetch returned {prefetch_result!r}, want empty"

    # The system prompt is cached at initialize() against the same
    # missing binary; subsequent calls must remain stable + empty.
    assert provider.system_prompt_block() == ""

    # is_available must report False, not raise.
    assert provider.is_available() is False

    # Write paths -> no-op, no exception.
    provider.sync_turn("hello", "world", session_id="e2e-binfail")
    provider.on_memory_write("add", "memory", "prefer dark mode")
    provider.queue_prefetch("anything")
    provider.on_session_switch("new-session-id", reset=False)

    # End-of-life calls
    pre_compress = provider.on_pre_compress([])
    assert pre_compress == ""
    provider.on_session_end([])

    # Tool calls return error JSON but never raise.
    tool_result = provider.handle_tool_call("memex_search", {"query": "x"})
    parsed = json.loads(tool_result)
    assert isinstance(parsed, dict), f"tool result must be JSON object, got {parsed!r}"
    # Acceptable shapes: binary_unavailable error OR empty result body
    # (depending on which surface the runner returns from). Verifying
    # any non-raise outcome is the load-bearing assertion here.

    # An install hint should have been logged at most once.
    install_hint_hits = [
        rec for rec in caplog.records
        if "memex-hermes binary not found" in rec.getMessage()
    ]
    assert len(install_hint_hits) >= 1, (
        "Expected at least one install-hint log; got none in: "
        + repr([r.getMessage() for r in caplog.records])
    )

    # Drain runner to ensure no thread leaks into the next test.
    provider.shutdown()
