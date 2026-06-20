"""P1-1 — default binary resolution reaches a runnable binary (no override).

Regression for the P1-1 defect: ``HermesRunner._resolve_binary()`` defaulted
to ``$HERMES_HOME/cache/memex/bin/memex`` — a path nothing in the install
flow populates — so every binary call silently degraded to a no-op even on a
correct install. Every other E2E test sets ``MEMEX_HERMES_BINARY`` and thus
dodged the defect.

This test places the real binary at the §9 cache layout and verifies that,
with NO ``MEMEX_HERMES_BINARY`` override, the runner resolves to it and
actually executes it: the health call returns a real mapping and no
install-hint warning is logged.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

import pytest
from fixtures import MemexBinaryInfo

from memex_hermes.envelope import HERMES_HEALTH
from memex_hermes.runner import HermesRunner


def _populate_cache_bin(hermes_home: Path, binary: Path) -> Path:
    """Place the binary + its sibling shared libs into the §9 cache layout.

    Returns the cache binary path. A bun-compiled binary loads a sibling
    ONNX runtime shared library, so siblings are copied too — the runner
    execs the resolved path directly (no wrapper LD-path hack), matching
    how the existing override-based E2E tests run it.
    """
    cache_bin_dir = hermes_home / "cache" / "memex" / "bin"
    cache_bin_dir.mkdir(parents=True, exist_ok=True)
    dest = cache_bin_dir / "memex"
    if binary.resolve() != dest.resolve():
        shutil.copy2(binary, dest)
        dest.chmod(0o755)
        for sib in binary.parent.iterdir():
            if sib.is_file() and (".so" in sib.name or sib.suffix in {".dylib", ".dll"}):
                shutil.copy2(sib, cache_bin_dir / sib.name)
    return dest


def test_default_resolution_runs_binary_without_override(
    hermes_home: Path,
    memex_binary_path: MemexBinaryInfo,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    cache_binary = _populate_cache_bin(hermes_home, memex_binary_path.path)
    # Crucially: NO MEMEX_HERMES_BINARY override — exercise the default path.
    monkeypatch.delenv("MEMEX_HERMES_BINARY", raising=False)

    runner = HermesRunner(hermes_home)
    assert runner._resolve_binary() == cache_binary, (
        "with no override and a cache binary present, resolution must use it"
    )

    caplog.set_level(logging.WARNING, logger="memex_hermes.runner")
    result = runner.run_subprocess_sync(HERMES_HEALTH, {})
    runner.shutdown()

    assert isinstance(result, dict), "the binary must actually run and return a mapping"
    hints = [r for r in caplog.records if "binary not found" in r.getMessage()]
    assert not hints, "default resolution must NOT fall through to the missing-binary path"
