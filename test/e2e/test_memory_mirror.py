"""§11.4 — Built-in ``remember`` writes are mirrored to the sync repo.

Two mirror paths must ship per the hermes-sync-bridge spec (R1 /
G19):

1. **Primary callback path** — ``on_memory_write`` fires for
   ``action ∈ {add, replace}`` and writes through the
   ``Hermes.memory-write`` handler. The handler invokes
   ``mirrorAndCommit`` which writes to
   ``<sync_repo>/projects/<id>/memory/MEMORY.md`` (or USER.md).

2. **mtime-watcher path** — ``sync_turn`` is invoked after every
   completed turn; the binary's mtime tracker re-mirrors the full
   current content of ``$HERMES_HOME/memories/{MEMORY,USER}.md``
   when its mtime has changed since the last observed value. This
   covers ``remove`` (which never fires the callback) and any
   out-of-band edit.

This test exercises both paths against a real binary. It skips when
the binary is not built; it then writes through each path and
asserts the mirror file content matches the source.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fixtures import MemexBinaryInfo

from memex_hermes.provider import MemexProvider

_MIRROR_POLL_BUDGET_S: float = 5.0
_MIRROR_POLL_INTERVAL_S: float = 0.05


def _wait_for_mirror(target: Path, *, expected_contains: str | None = None) -> str:
    """Block until ``target`` exists (FAF dispatch is async).

    Returns the file contents. Fails the test if the file does not
    appear within the budget, with a diagnostic dump of the mirror
    directory tree.
    """
    deadline = time.monotonic() + _MIRROR_POLL_BUDGET_S
    last_err: str = ""
    while time.monotonic() < deadline:
        if target.is_file():
            content = target.read_text(encoding="utf-8")
            if expected_contains is None or expected_contains in content:
                return content
            last_err = (
                f"mirror file exists but does not contain {expected_contains!r}: "
                f"current content: {content!r}"
            )
        time.sleep(_MIRROR_POLL_INTERVAL_S)
    pytest.fail(
        f"mirror file did not appear at {target} within {_MIRROR_POLL_BUDGET_S}s. "
        f"Last error: {last_err}. Parent dir contents: "
        + str(list(target.parent.glob("*")) if target.parent.is_dir() else "(missing)")
    )


def _build_provider(
    hermes_home: Path,
    sync_repo_root: Path,
    binary: MemexBinaryInfo,
    monkeypatch: pytest.MonkeyPatch,
) -> MemexProvider:
    """Construct + initialize a provider with HOME-scoped sync repo.

    The current binary derives the local sync repo from
    ``homedir() + '.local/share/memex-hermes/'`` and does not
    consult ``sync.repo`` in memex.json for the local checkout
    location. We override ``$HOME`` to ``sync_repo_root`` so the
    binary's default lands under tmp_path and the test stays isolated.
    """
    import json

    memex_json = hermes_home / "memex.json"
    memex_json.write_text(
        json.dumps(
            {
                "sync": {
                    "enabled": True,
                    "autoCommitPush": False,  # no remote to push to in e2e
                    "repo": "",
                    "pushRetries": 0,
                },
                "mirrorHermesMemory": True,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.setenv("MEMEX_HERMES_HOME", str(hermes_home))
    monkeypatch.setenv("MEMEX_HERMES_BINARY", str(binary.path))
    # Pin $HOME so the binary's defaultSyncRepoDir lands under tmp.
    monkeypatch.setenv("HOME", str(sync_repo_root))

    provider = MemexProvider()
    provider.initialize(
        session_id="e2e-mirror",
        hermes_home=str(hermes_home),
        platform="cli",
        agent_context="primary",
    )
    return provider


def _expected_sync_root(sync_repo_root: Path) -> Path:
    """The binary's default sync repo under a HOME-scoped tmp dir."""
    return sync_repo_root / ".local" / "share" / "memex-hermes"


def test_on_memory_write_primary_path_mirrors_add(
    hermes_home: Path,
    tmp_path: Path,
    memex_binary_path: MemexBinaryInfo,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Action=add fires the on_memory_write callback → mirror file written."""
    sync_root = tmp_path / "home_scope"
    sync_root.mkdir()
    provider = _build_provider(hermes_home, sync_root, memex_binary_path, monkeypatch)

    payload = "prefer dark mode for e2e mirror test"
    provider.on_memory_write("add", "memory", payload)

    sync_repo = _expected_sync_root(sync_root)

    # The mirror file lives under projects/<id>/memory/MEMORY.md. The
    # project id resolves to _session/<sid> when the cwd has no git
    # remote configured (the e2e cwd is a pytest tmp tree). We accept
    # any project id by globbing.
    deadline = time.monotonic() + _MIRROR_POLL_BUDGET_S
    mirror_glob: list[Path] = []
    while time.monotonic() < deadline and not mirror_glob:
        if sync_repo.is_dir():
            mirror_glob = list((sync_repo / "projects").rglob("memory/MEMORY.md"))
        time.sleep(_MIRROR_POLL_INTERVAL_S)
    if not mirror_glob:
        pytest.fail(
            f"no mirror file found under {sync_repo}/projects/*/memory/MEMORY.md. "
            "Tree: "
            + str(list(sync_repo.rglob("*")) if sync_repo.is_dir() else "(missing)")
        )
    mirror = mirror_glob[0]
    content = _wait_for_mirror(mirror, expected_contains=payload)
    assert payload in content, f"mirror missing payload; got {content!r}"

    provider.shutdown()


def test_sync_turn_mtime_watcher_mirrors_direct_edit(
    hermes_home: Path,
    tmp_path: Path,
    memex_binary_path: MemexBinaryInfo,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Out-of-band edit to MEMORY.md is mirrored by the next sync_turn."""
    sync_root = tmp_path / "home_scope"
    sync_root.mkdir()
    provider = _build_provider(hermes_home, sync_root, memex_binary_path, monkeypatch)

    memory_md = hermes_home / "memories" / "MEMORY.md"
    full_content = "# memory\n\nfirst out-of-band edit for e2e\n"
    memory_md.write_text(full_content, encoding="utf-8")

    # Drive sync_turn — the binary inspects MEMORY.md's mtime against
    # its tracker cache, sees the change, and mirrors the full body.
    provider.sync_turn(
        "user: did you save my note?",
        "assistant: yes, saved.",
        session_id="e2e-mirror",
    )

    sync_repo = _expected_sync_root(sync_root)
    deadline = time.monotonic() + _MIRROR_POLL_BUDGET_S
    mirror_glob: list[Path] = []
    while time.monotonic() < deadline and not mirror_glob:
        if sync_repo.is_dir():
            mirror_glob = list((sync_repo / "projects").rglob("memory/MEMORY.md"))
        time.sleep(_MIRROR_POLL_INTERVAL_S)
    if not mirror_glob:
        pytest.fail(
            f"no mirror file found under {sync_repo}/projects/*/memory/MEMORY.md "
            "after sync_turn mtime-watcher should have fired"
        )
    mirror = mirror_glob[0]
    content = _wait_for_mirror(mirror, expected_contains="first out-of-band edit")
    assert "first out-of-band edit" in content

    provider.shutdown()


def test_sync_turn_mirrors_shrink_after_removal(
    hermes_home: Path,
    tmp_path: Path,
    memex_binary_path: MemexBinaryInfo,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Shrunk MEMORY.md (a removal) propagates via mtime path, not delta."""
    sync_root = tmp_path / "home_scope"
    sync_root.mkdir()
    provider = _build_provider(hermes_home, sync_root, memex_binary_path, monkeypatch)

    memory_md = hermes_home / "memories" / "MEMORY.md"
    # Step 1: write a multi-entry file, sync.
    full_content = "# memory\n\nentry-A\nentry-B\nentry-C\n"
    memory_md.write_text(full_content, encoding="utf-8")
    provider.sync_turn("u1", "a1", session_id="e2e-mirror")

    # Step 2: shrink (simulating a `remove` performed by the built-in
    # tool — which does NOT fire on_memory_write per the source).
    smaller = "# memory\n\nentry-A\n"
    # Ensure mtime ticks forward — some filesystems only have 1s mtime.
    time.sleep(1.05)
    memory_md.write_text(smaller, encoding="utf-8")
    provider.sync_turn("u2", "a2", session_id="e2e-mirror")

    sync_repo = _expected_sync_root(sync_root)
    deadline = time.monotonic() + _MIRROR_POLL_BUDGET_S
    mirror_glob: list[Path] = []
    while time.monotonic() < deadline and not mirror_glob:
        if sync_repo.is_dir():
            mirror_glob = list((sync_repo / "projects").rglob("memory/MEMORY.md"))
        time.sleep(_MIRROR_POLL_INTERVAL_S)
    if not mirror_glob:
        pytest.fail("expected mirror to exist after second sync_turn")
    mirror = mirror_glob[0]
    # Eventually the mirror reflects the SHRUNK content.
    deadline = time.monotonic() + _MIRROR_POLL_BUDGET_S
    final: str = ""
    while time.monotonic() < deadline:
        final = mirror.read_text(encoding="utf-8")
        if "entry-B" not in final and "entry-A" in final:
            break
        time.sleep(_MIRROR_POLL_INTERVAL_S)
    assert "entry-A" in final, f"shrunk content lost entry-A: {final!r}"
    assert "entry-B" not in final, (
        "mirror did not reflect removal — entry-B still present in: "
        f"{final!r}"
    )

    provider.shutdown()
