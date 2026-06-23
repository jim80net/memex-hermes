"""Cross-adapter on-disk compatibility — the COMPILED-binary (Tier 3) tier of
issue #4.

The product invariant — a memory authored under one adapter is read back
unchanged under another — is verified self-contained (no live memex-claude): a
committed golden fixture is the peer-adapter stand-in. This module owns the
WRITE direction against the real bun-compiled binary:

1. ``memex_remember`` writes a memory file under the HOME-scoped sync repo.
2. The produced file is in the SAME shared frontmatter shape as the committed
   golden (``test/fixtures/cross-adapter/golden-memory-frontmatter.md``) that the
   shared ``@jim80net/memex-core`` parser — used by every adapter — reads.

The READ direction (the shared parser reading a peer-shaped file) is proven
DETERMINISTICALLY at Tier 1 (``test/ts/cross-adapter-compat.test.ts``) against
the same parser the binary bundles, and the version-pin alignment that keeps the
embedding cache reusable is at Tier 2 (``test/ts/cross-adapter-pin-alignment.test.ts``).
The binary's own read/search path requires the embedding backend, which is not
guaranteed to resolve inside a ``bun build --compile`` artifact, so it is not
re-exercised here (it would be an environment-fragile gate); WRITE degrades
gracefully when the backend is absent, so it is the reliable binary-tier anchor.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fixtures import MemexBinaryInfo

from memex_hermes.provider import MemexProvider

# The committed cross-adapter golden fixtures live alongside the ts conformance
# suite; this e2e tier asserts the COMPILED binary writes that same shape.
_FIXTURE_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "cross-adapter"


def _frontmatter_keys(text: str) -> list[str]:
    """Ordered top-level keys of a leading ``---``-delimited frontmatter block.

    Returns ``[]`` when there is no leading frontmatter block. Used to assert the
    binary's on-disk shape matches the golden's key layout.
    """
    if not text.startswith("---\n"):
        return []
    end = text.find("\n---", 4)
    if end == -1:
        return []
    keys: list[str] = []
    for line in text[4:end].splitlines():
        if ":" in line and not line.startswith((" ", "\t", "-")):
            keys.append(line.split(":", 1)[0].strip())
    return keys


def _golden_frontmatter_keys() -> list[str]:
    golden = (_FIXTURE_DIR / "golden-memory-frontmatter.md").read_text(encoding="utf-8")
    return _frontmatter_keys(golden)


def _await_written_md(sync_repo: Path, timeout_s: float = 5.0) -> Path:
    """Return the most-recently-written ``*.md`` under ``sync_repo``.

    memex_remember is synchronous, but tolerate a brief gap in case the binary
    spawns a worker. Fails the test if nothing appears within ``timeout_s``.
    """
    import time

    deadline = time.monotonic() + timeout_s
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
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0]


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
    target = _await_written_md(sync_repo)

    body = target.read_text(encoding="utf-8")
    assert payload in body, (
        f"remembered payload not present in produced file {target}: {body!r}"
    )

    # Cross-adapter shape: the binary writes the SAME frontmatter key layout as
    # the committed golden the shared @jim80net/memex-core parser reads.
    assert _frontmatter_keys(body) == _golden_frontmatter_keys() == [
        "name",
        "description",
        "type",
    ], f"binary frontmatter shape diverged from the golden: {body!r}"
    # No binary garbage / unicode smuggling / wrong newlines that would break
    # the shared parser.
    assert body.endswith("\n"), "expected trailing newline (memex-claude convention)"
    assert "\x00" not in body, "file must be plain text, not binary"

    provider.shutdown()


def test_binary_write_round_trips_through_shared_format(
    hermes_home: Path,
    tmp_path: Path,
    memex_binary_path: MemexBinaryInfo,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The COMPILED binary's memex_remember output is the cross-adapter format.

    Self-contained round-trip (no live memex-claude): the binary writes a
    memory; we assert the produced file is in the same shared frontmatter shape
    as the committed golden
    (``test/fixtures/cross-adapter/golden-memory-frontmatter.md``) that the
    shared ``@jim80net/memex-core`` parser — used by every adapter — reads.

    The READ direction (the shared parser reading a peer-shaped file) is proven
    DETERMINISTICALLY at Tier 1 (``test/ts/cross-adapter-compat.test.ts``)
    against the same parser the binary bundles. The binary's own read/search path
    requires the embedding backend (``@huggingface/transformers``), which is not
    guaranteed to resolve inside a ``bun build --compile`` artifact — exercising
    it here would be an environment-fragile gate, so we cover READ at Tier 1 and
    WRITE (which degrades gracefully when the backend is absent) here.
    """
    home_scope = tmp_path / "home_scope"
    home_scope.mkdir()
    provider = _build_provider(hermes_home, home_scope, memex_binary_path, monkeypatch)

    payload = (
        "always trace the production runtime path end-to-end before declaring a "
        "daemon PR merge-ready: tests green is necessary, not sufficient."
    )
    result = provider.handle_tool_call(
        "memex_remember",
        {"content": payload, "scope": "global"},
    )
    parsed = json.loads(result)
    assert isinstance(parsed, dict), f"tool result must be a JSON object: {result!r}"

    sync_repo = home_scope / ".local" / "share" / "memex-hermes"
    target = _await_written_md(sync_repo)
    body = target.read_text(encoding="utf-8")

    # Round-trip shape: the binary's on-disk frontmatter matches the golden's
    # key layout exactly, and parses back to the payload + memory type.
    assert _frontmatter_keys(body) == _golden_frontmatter_keys() == [
        "name",
        "description",
        "type",
    ], f"binary frontmatter shape diverged from the golden: {body!r}"
    frontmatter = body.split("\n---", 1)[0]
    assert "type: memory" in frontmatter, f"expected memory type in frontmatter: {body!r}"
    assert payload in body, f"payload not preserved in binary output: {body!r}"
    assert body.endswith("\n") and "\x00" not in body

    provider.shutdown()
