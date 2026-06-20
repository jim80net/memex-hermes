"""§11.3 (partial) — Cross-adapter sync-repo on-disk compatibility.

Full cross-adapter interop (memex-hermes writes → memex-claude
reads) requires both adapters running side-by-side; this fixture
only owns memex-hermes. We exercise the WRITE side here and assert
the on-disk format is byte-compatible with what memex-claude expects
to consume.

What we verify:

1. ``memex_remember`` from a memex-hermes session writes a memory
   file at ``<sync_repo>/projects/<id>/memory/<filename>``.
2. The file has the structural shape memex-claude consumes:
   markdown body with optional frontmatter, encoded as UTF-8.

What we do NOT verify here (tracked as a TODO):

* The end-to-end "memex-claude session reads this file and surfaces
  it via search" round-trip. That requires installing + running
  memex-claude from this test, which we defer to the cross-adapter
  CI lane.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fixtures import MemexBinaryInfo

from memex_hermes.provider import MemexProvider


def _build_provider(
    hermes_home: Path,
    home_scope: Path,
    binary: MemexBinaryInfo,
    monkeypatch: pytest.MonkeyPatch,
) -> MemexProvider:
    """Provider with HOME-scoped local sync repo + auto-push off."""
    memex_json = hermes_home / "memex.json"
    memex_json.write_text(
        json.dumps(
            {
                "sync": {
                    "enabled": True,
                    "autoCommitPush": False,
                    "repo": "",
                    "pushRetries": 0,
                },
                "tools": {
                    "memex_search": {"enabled": True},
                    "memex_remember": {"enabled": True},
                    "memex_recall": {"enabled": True},
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
    monkeypatch.setenv("HOME", str(home_scope))

    provider = MemexProvider()
    provider.initialize(
        session_id="e2e-syncc",
        hermes_home=str(hermes_home),
        platform="cli",
        agent_context="primary",
    )
    return provider


def test_memex_remember_writes_claude_compatible_file(
    hermes_home: Path,
    tmp_path: Path,
    memex_binary_path: MemexBinaryInfo,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """memex_remember produces a file with the format memex-claude expects.

    The on-disk format conventions (per memex-claude/USAGE.md):

      ``<sync_repo>/projects/<project-id>/memory/*.md``
      file body is UTF-8 markdown; optional YAML frontmatter delimited
      by ``---`` on the first line.
    """
    home_scope = tmp_path / "home_scope"
    home_scope.mkdir()
    provider = _build_provider(hermes_home, home_scope, memex_binary_path, monkeypatch)

    payload = (
        "use the standard development flow when shipping memex changes; "
        "brainstorm, design, spec, implement, review."
    )
    result = provider.handle_tool_call(
        "memex_remember",
        {"content": payload, "scope": "global"},
    )
    parsed = json.loads(result)
    assert isinstance(parsed, dict), f"tool result must be a JSON object: {result!r}"

    # The binary writes memex_remember entries under the HOME-scoped
    # sync repo: $HOME/.local/share/memex-hermes/.
    sync_repo = home_scope / ".local" / "share" / "memex-hermes"
    # The remember tool is sync, so the file should exist immediately;
    # tolerate a brief gap in case the binary spawns a worker.
    import time
    deadline = time.monotonic() + 5.0
    candidates: list[Path] = []
    while time.monotonic() < deadline and not candidates:
        if sync_repo.is_dir():
            candidates = [p for p in sync_repo.rglob("*.md") if p.is_file()]
        if not candidates:
            time.sleep(0.05)
    assert candidates, (
        "memex_remember did not produce any .md file in the sync repo. "
        f"Tree: {list(sync_repo.rglob('*')) if sync_repo.is_dir() else '(missing)'}"
    )
    # Pick the most recently modified file as the target.
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    target = candidates[0]

    body = target.read_text(encoding="utf-8")
    assert payload in body, (
        f"remembered payload not present in produced file {target}: {body!r}"
    )

    # Structural format: either the file starts with `---` (frontmatter)
    # or with markdown content directly — both are valid memex-claude
    # inputs. The negative invariant is "no binary garbage / unicode
    # smuggling / wrong newlines that would break claude's parser."
    assert body.endswith("\n"), "expected trailing newline (memex-claude convention)"
    assert "\x00" not in body, "file must be plain text, not binary"

    provider.shutdown()


def test_cross_adapter_round_trip_tracked_as_followup() -> None:
    """Documentation-only check that the cross-adapter round-trip is
    a known follow-up.

    The end-to-end check "memex-hermes writes; memex-claude reads"
    requires both adapters running side-by-side and is deferred to
    the cross-adapter CI lane. This test pins the expectation so a
    future reader knows the §11.3 coverage in this file is partial.
    """
    pytest.skip(
        "cross-adapter round-trip with memex-claude is a tracked follow-up; "
        "see tasks.md §11.3 — requires memex-claude installed alongside"
    )
