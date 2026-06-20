"""Tests for memex_hermes.install — provider directory materialize.

Verifies R1 of the ``hermes-plugin-packaging`` capability spec: pip
install alone does NOT activate the provider. The materialize step
(``memex-hermes-install`` console script / ``python -m
memex_hermes.install``) MUST copy the provider files into
``$HERMES_HOME/plugins/memex/`` and the materialized ``__init__.py``
MUST satisfy the Hermes memory-provider discovery heuristic — the
literal substrings ``MemoryProvider`` AND ``register_memory_provider``
within the first 8192 bytes.

These tests do not touch the network and do not require the binary;
``install.py`` is pure-Python file-copy logic.
"""

from __future__ import annotations

import io
from collections.abc import Sequence
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from memex_hermes.install import main

# Provider module files that must land under $HERMES_HOME/plugins/memex/
# Mirrors install._PROVIDER_MODULE_FILES; duplicated here so the test
# asserts the expectation independently of the implementation tuple.
_EXPECTED_MODULE_FILES: tuple[str, ...] = (
    "__init__.py",
    "paths.py",
    "config.py",
    "runner.py",
    "tools.py",
    "provider.py",
    "envelope.py",
    "_hermes_stub.py",
)

_EXPECTED_MANIFEST: str = "plugin.yaml"

# Hermes discovery heuristic: the provider's __init__.py must contain
# one of these literal substrings within the first 8192 bytes.
_HEURISTIC_LITERALS: tuple[str, ...] = (
    "MemoryProvider",
    "register_memory_provider",
)


# --- helpers ----------------------------------------------------------------


def _run_install(argv: Sequence[str]) -> tuple[int, str]:
    """Invoke install.main with ``argv`` and capture stdout."""
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = main(list(argv))
    return rc, buf.getvalue()


def _provider_dir(hermes_home: Path) -> Path:
    return hermes_home / "plugins" / "memex"


# --- dry-run ----------------------------------------------------------------


def test_dry_run_prints_actions_without_touching_disk(
    tmp_path: Path,
) -> None:
    hermes_home = tmp_path / "hermes"
    hermes_home.mkdir()

    rc, out = _run_install(["--hermes-home", str(hermes_home), "--dry-run"])

    assert rc == 0
    target = _provider_dir(hermes_home)
    assert not target.exists(), "dry-run must not create the provider directory"
    assert "would create directory" in out
    for filename in _EXPECTED_MODULE_FILES:
        assert f"would write: {target / filename}" in out
    assert f"would write: {target / _EXPECTED_MANIFEST}" in out
    assert "[dry-run]" in out


# --- default install --------------------------------------------------------


def test_default_install_copies_all_required_files(tmp_path: Path) -> None:
    hermes_home = tmp_path / "hermes"
    hermes_home.mkdir()

    rc, out = _run_install(["--hermes-home", str(hermes_home)])

    assert rc == 0
    target = _provider_dir(hermes_home)
    assert target.is_dir()

    for filename in _EXPECTED_MODULE_FILES:
        assert (target / filename).is_file(), f"missing materialized file: {filename}"
    assert (target / _EXPECTED_MANIFEST).is_file()

    # The user-facing next-step instruction must be printed so the
    # user knows to set memory.provider: memex.
    assert "memory.provider" in out or "provider: memex" in out


def test_materialized_init_satisfies_discovery_heuristic(tmp_path: Path) -> None:
    hermes_home = tmp_path / "hermes"
    hermes_home.mkdir()

    rc, _ = _run_install(["--hermes-home", str(hermes_home)])
    assert rc == 0

    init_py = _provider_dir(hermes_home) / "__init__.py"
    head = init_py.read_bytes()[:8192].decode("utf-8", errors="replace")

    # Per the spec (R1), the heuristic in
    # plugins/memory/__init__.py:51-64 looks for either literal. Our
    # canonical __init__.py contains BOTH; assert both as a defensive
    # belt-and-suspenders check.
    for literal in _HEURISTIC_LITERALS:
        assert literal in head, (
            f"materialized __init__.py missing the {literal!r} substring; "
            f"Hermes discovery will not recognize this provider"
        )


# --- idempotence ------------------------------------------------------------


def test_rerun_is_idempotent_without_force(tmp_path: Path) -> None:
    hermes_home = tmp_path / "hermes"
    hermes_home.mkdir()

    rc1, _ = _run_install(["--hermes-home", str(hermes_home)])
    assert rc1 == 0

    # Mutate a materialized file so we can prove the second run leaves
    # it untouched (idempotent ≠ refreshing — without --force we must
    # not clobber user changes).
    init_py = _provider_dir(hermes_home) / "__init__.py"
    sentinel = "# user-edit-sentinel\n"
    init_py.write_text(sentinel + init_py.read_text())

    rc2, _ = _run_install(["--hermes-home", str(hermes_home)])
    assert rc2 == 0
    assert init_py.read_text().startswith(sentinel)


def test_force_overwrites_existing_files(tmp_path: Path) -> None:
    hermes_home = tmp_path / "hermes"
    hermes_home.mkdir()

    rc1, _ = _run_install(["--hermes-home", str(hermes_home)])
    assert rc1 == 0

    init_py = _provider_dir(hermes_home) / "__init__.py"
    sentinel = "# user-edit-sentinel\n"
    init_py.write_text(sentinel + init_py.read_text())

    rc2, _ = _run_install(["--hermes-home", str(hermes_home), "--force"])
    assert rc2 == 0
    assert not init_py.read_text().startswith(sentinel), (
        "--force must overwrite the materialized file"
    )
    # And the discovery heuristic must still hold after overwrite.
    head = init_py.read_bytes()[:8192].decode("utf-8", errors="replace")
    for literal in _HEURISTIC_LITERALS:
        assert literal in head


# --- env-var resolution -----------------------------------------------------


def test_env_var_used_when_no_flag(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hermes_home = tmp_path / "env-hermes"
    hermes_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.delenv("MEMEX_HERMES_HOME", raising=False)

    rc, _ = _run_install([])

    assert rc == 0
    assert (_provider_dir(hermes_home) / "__init__.py").is_file()


def test_memex_hermes_home_used_when_hermes_home_unset(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hermes_home = tmp_path / "mh-hermes"
    hermes_home.mkdir()
    monkeypatch.delenv("HERMES_HOME", raising=False)
    monkeypatch.setenv("MEMEX_HERMES_HOME", str(hermes_home))

    rc, _ = _run_install([])

    assert rc == 0
    assert (_provider_dir(hermes_home) / "__init__.py").is_file()


def test_missing_hermes_home_returns_error(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.delenv("HERMES_HOME", raising=False)
    monkeypatch.delenv("MEMEX_HERMES_HOME", raising=False)

    rc = main([])

    assert rc != 0
    captured = capsys.readouterr()
    assert "HERMES_HOME" in captured.err


# --- console-script wiring smoke ---------------------------------------------


def test_console_script_module_entrypoint_runs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Sanity: running via ``python -m memex_hermes.install`` works.

    We invoke main() directly with argv to avoid spawning subprocesses
    in the test; the entry point in pyproject.toml points at the same
    function, so this is the same code path Pip exercises.
    """
    hermes_home = tmp_path / "hermes"
    hermes_home.mkdir()

    rc, _ = _run_install(["--hermes-home", str(hermes_home), "--dry-run"])
    assert rc == 0

    # Sanity: the module exposes ``main`` as a callable so the
    # ``[project.scripts]`` entry-point resolves.
    from memex_hermes import install as install_mod

    assert callable(install_mod.main)


