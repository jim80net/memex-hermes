"""§11.5 — Clean-machine first-run completes prefetch within 10s.

Validates the "cold cache" performance budget from the design doc.
The binary must download the ONNX model and index the available
skills within 10 seconds on a fresh machine. We can't simulate a
truly fresh machine inside pytest, but we can wipe the memex
cache subtree under ``$HERMES_HOME/cache/memex/`` (except the
binary itself) and time the first prefetch.

Gated by ``MEMEX_E2E_COLD=1`` because:

* On most dev machines the model is already cached system-wide; a
  re-download would be wasted bandwidth.
* Clearing the cache mid-CI can interact badly with concurrent test
  runs (the cache is per-HERMES_HOME so this is mostly defensive).

The conftest auto-applies the ``e2e_cold`` marker skip when the
env var is unset.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from fixtures import MemexBinaryInfo, clear_model_cache, write_skill

from memex_hermes.provider import MemexProvider

_COLD_PREFETCH_BUDGET_S: float = 10.0


@pytest.mark.e2e_cold
def test_cold_first_run_prefetch_within_budget(
    hermes_home: Path,
    tmp_path: Path,
    memex_binary_path: MemexBinaryInfo,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Wipe cache, then time the first prefetch end-to-end."""
    # Seed a small skill so the index has at least one entry to match
    # against — a 0-entry index is a degenerate case that masks the
    # cold-cache cost we want to measure.
    write_skill(
        hermes_home / "skills",
        "demo-skill",
        description="Demonstration skill for the cold-cache budget test",
        queries=["demo skill query"],
        body="# demo\n\nDemo body.\n",
    )

    memex_json = hermes_home / "memex.json"
    memex_json.write_text(
        json.dumps(
            {
                "prefetch": {
                    "enabled": True,
                    "topK": 3,
                    "threshold": 0.0,
                    "maxInjectedChars": 4096,
                },
                "sync": {
                    "enabled": False,
                    "autoCommitPush": False,
                    "repo": "",
                    "pushRetries": 0,
                },
                "mirrorHermesMemory": False,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    home_scope = tmp_path / "home_scope"
    home_scope.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.setenv("MEMEX_HERMES_HOME", str(hermes_home))
    monkeypatch.setenv("MEMEX_HERMES_BINARY", str(memex_binary_path.path))
    monkeypatch.setenv("HOME", str(home_scope))

    # Wipe state — the binary must rebuild the index and (if model
    # is also cleared system-wide) download the embedding model.
    clear_model_cache(hermes_home)

    provider = MemexProvider()
    provider.initialize(
        session_id="e2e-cold",
        hermes_home=str(hermes_home),
        platform="cli",
        agent_context="primary",
    )

    started = time.monotonic()
    context = provider.prefetch("demo skill query")
    elapsed = time.monotonic() - started

    assert elapsed < _COLD_PREFETCH_BUDGET_S, (
        f"cold first-run prefetch took {elapsed:.2f}s; "
        f"budget is {_COLD_PREFETCH_BUDGET_S}s "
        f"(context={context!r})"
    )

    provider.shutdown()
