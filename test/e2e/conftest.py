"""Pytest configuration for the end-to-end integration suite.

Responsibilities:

* Add ``test/e2e`` to ``sys.path`` so ``fixtures`` and ``helpers``
  modules can be imported with flat names.
* Auto-mark every test in this directory with ``@pytest.mark.e2e``.
* Skip the entire suite (collection-time) when ``MEMEX_E2E`` is not
  set to a truthy value, so contributors running ``pytest`` casually
  do not start Hermes subprocesses or download embedding models.

The skip is implemented at ``pytest_collection_modifyitems`` time so
that ``pytest test/e2e -v`` lists every test as SKIPPED with a
descriptive reason — rather than silently collecting nothing.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parent.parent

# Make the e2e helpers importable from any test module by flat name.
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

# Make the memex_hermes package importable when pytest is invoked
# from outside a venv that has it editable-installed. This is a
# belt-and-suspenders fallback; the recommended path is the venv.
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))


_TRUTHY = frozenset({"1", "true", "yes", "on"})


def _e2e_enabled() -> bool:
    value = os.environ.get("MEMEX_E2E", "").strip().lower()
    return value in _TRUTHY


def _cold_run_enabled() -> bool:
    value = os.environ.get("MEMEX_E2E_COLD", "").strip().lower()
    return value in _TRUTHY


def pytest_configure(config: pytest.Config) -> None:
    """Register the ``e2e`` and ``e2e_cold`` markers.

    Even though pytest.ini also declares ``e2e``, declaring it here
    keeps ``pytest --markers`` accurate when someone invokes pytest
    with a non-default ini.
    """
    config.addinivalue_line(
        "markers",
        "e2e: end-to-end integration test against a real Hermes home + memex binary",
    )
    config.addinivalue_line(
        "markers",
        "e2e_cold: cold-cache scenario (clears the ONNX model cache before running)",
    )


def pytest_collection_modifyitems(
    config: pytest.Config, items: list[pytest.Item]
) -> None:
    """Auto-mark every collected item with ``@pytest.mark.e2e`` and
    skip the suite when ``MEMEX_E2E`` is not set."""
    enabled = _e2e_enabled()
    cold_enabled = _cold_run_enabled()
    skip_suite = pytest.mark.skip(
        reason="e2e suite disabled (set MEMEX_E2E=1 to enable)"
    )
    skip_cold = pytest.mark.skip(
        reason="cold-cache scenario disabled (set MEMEX_E2E_COLD=1 to enable)"
    )

    for item in items:
        item.add_marker(pytest.mark.e2e)
        if not enabled:
            item.add_marker(skip_suite)
            continue
        if "e2e_cold" in item.keywords and not cold_enabled:
            item.add_marker(skip_cold)


# ---- Re-exported fixtures from fixtures.py ---------------------------------
# Importing the fixtures module here makes its @pytest.fixture
# definitions automatically available to every test module without
# requiring per-module imports.

from fixtures import (  # noqa: E402,F401  (intentional side-effect import)
    e2e_enabled,
    hermes_home,
    hermes_session,
    materialize_memex,
    memex_binary_path,
    set_memory_provider,
    sync_repo_dir,
)
