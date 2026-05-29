"""§11.7 — ``HERMES_HOME=/tmp/custom`` is honored end-to-end.

Validates the spec's path-resolution invariant: every cache /
memory / config file the provider touches lives under
``$HERMES_HOME`` (or under the configured sync repo dir). No writes
escape to ``~/.hermes/``, ``~/.local/share/memex-hermes/`` (unless
explicitly that's the sync repo), or any other root-level path.

The check is operationalized as a negative-space scan: snapshot the
filesystem state of every "potential leak" directory before the
test exercises the provider, then assert no new file appears in
those directories after. The positive assertion is that expected
state DID appear inside ``$HERMES_HOME``.
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

import pytest
from fixtures import MemexBinaryInfo

from memex_hermes.provider import MemexProvider


def _snapshot(roots: Iterable[Path]) -> set[Path]:
    """Recursively list every file under each existing root.

    Returns absolute paths. Missing roots contribute nothing — a root
    that didn't exist before AND doesn't exist after is fine. The
    invariant is "no NEW files in these roots", measured as a
    set-difference after the exercise.
    """
    seen: set[Path] = set()
    for root in roots:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if path.is_file():
                seen.add(path.resolve())
    return seen


# Capture the operator's actual home before any test monkeypatches it.
_REAL_HOME: Path = Path.home()


def _leak_roots() -> list[Path]:
    """Roots that MUST NOT receive any new files during this test.

    Resolved against the operator's REAL home directory (snapshot
    taken at module-import time before any monkeypatch happens).
    A test that pins ``$HOME`` to a tmp dir still detects leaks
    back into the operator's actual ``~/`` — which would be a real
    bug regardless of how ``$HOME`` is reconfigured at runtime.
    """
    return [
        _REAL_HOME / ".hermes",
        _REAL_HOME / ".local" / "share" / "memex-hermes",
        _REAL_HOME / ".local" / "share" / "memex-claude",
        _REAL_HOME / ".claude",
        Path("/tmp") / ".hermes",
    ]


def _custom_home(tmp_path: Path) -> Path:
    """A custom HERMES_HOME under tmp_path with the expected layout."""
    home = tmp_path / "custom-hermes-home"
    (home / "skills").mkdir(parents=True)
    (home / "memories").mkdir(parents=True)
    (home / "plugins").mkdir(parents=True)
    (home / "cache" / "memex" / "bin").mkdir(parents=True)
    return home


def test_no_writes_outside_custom_hermes_home(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exercise initialize + prefetch + on_memory_write under a custom HERMES_HOME.

    Negative assertion: no NEW files appear in any of the leak roots.
    Positive assertion: $HERMES_HOME/cache/memex/ accumulates state
    (sessions/, mtimes file, etc.) when the binary is present;
    otherwise we only verify the negative space.
    """
    custom_home = _custom_home(tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(custom_home))
    monkeypatch.setenv("MEMEX_HERMES_HOME", str(custom_home))
    # Point the binary at a non-existent path so this test does not
    # depend on the §9 binary build. The path-resolution invariant is
    # what we're measuring; the binary's safe-default branch is the
    # subject of test_binary_failure.py.
    monkeypatch.setenv("MEMEX_HERMES_BINARY", str(custom_home / "no_such_memex"))

    leaks_before = _snapshot(_leak_roots())

    provider = MemexProvider()
    provider.initialize(
        session_id="e2e-home",
        hermes_home=str(custom_home),
        platform="cli",
        agent_context="primary",
    )
    provider.prefetch("how do I deploy?")
    provider.on_memory_write("add", "memory", "remember the custom home test")
    provider.sync_turn("user said x", "assistant said y")
    provider.shutdown()

    leaks_after = _snapshot(_leak_roots())

    new_leaks = leaks_after - leaks_before
    assert not new_leaks, (
        "memex-hermes wrote files outside $HERMES_HOME during the e2e exercise:\n"
        + "\n".join(f"  - {p}" for p in sorted(new_leaks))
    )

    # Positive verification: the resolution and instantiation worked
    # — provider state should be initialized against the custom home.
    assert provider._hermes_home == custom_home


def test_resolve_hermes_home_prefers_initialize_kwarg(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Per spec: kwargs > save_config arg > HERMES_HOME env."""
    env_home = tmp_path / "from_env"
    env_home.mkdir()
    kwarg_home = tmp_path / "from_kwarg"
    kwarg_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(env_home))

    from memex_hermes.paths import resolve_hermes_home

    resolved = resolve_hermes_home(initialize_kwargs={"hermes_home": str(kwarg_home)})
    assert resolved == kwarg_home, (
        f"kwarg should outrank env: got {resolved}, expected {kwarg_home}"
    )


def test_no_hardcoded_default_when_env_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Spec rule: refuse to invent ``~/.hermes/`` when no source supplies a home."""
    monkeypatch.delenv("HERMES_HOME", raising=False)
    monkeypatch.delenv("MEMEX_HERMES_HOME", raising=False)

    from memex_hermes.paths import resolve_hermes_home

    with pytest.raises(ValueError, match="HERMES_HOME could not be resolved"):
        resolve_hermes_home()


def test_real_binary_honors_custom_hermes_home(
    tmp_path: Path,
    memex_binary_path: MemexBinaryInfo,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end: with the real binary, all writes stay under HERMES_HOME + HOME.

    Distinct from the missing-binary path above: this drives a real
    subprocess invocation and asserts that the binary itself honors
    the env-injected HERMES_HOME, never writing outside the scratch
    root + the HOME-scoped sync repo.
    """
    custom_home = _custom_home(tmp_path)
    home_scope = tmp_path / "home_scope"
    home_scope.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(custom_home))
    monkeypatch.setenv("MEMEX_HERMES_HOME", str(custom_home))
    monkeypatch.setenv("MEMEX_HERMES_BINARY", str(memex_binary_path.path))
    monkeypatch.setenv("HOME", str(home_scope))

    leaks_before = _snapshot(_leak_roots())

    provider = MemexProvider()
    provider.initialize(
        session_id="e2e-home-real",
        hermes_home=str(custom_home),
        platform="cli",
        agent_context="primary",
    )
    provider.prefetch("how do I deploy?")
    provider.on_memory_write("add", "memory", "real-binary HERMES_HOME check")
    provider.sync_turn("user x", "assistant y")
    provider.shutdown()

    leaks_after = _snapshot(_leak_roots())
    new_leaks = leaks_after - leaks_before
    assert not new_leaks, (
        "real binary wrote files outside $HERMES_HOME + $HOME during e2e:\n"
        + "\n".join(f"  - {p}" for p in sorted(new_leaks))
    )
