"""Shared fixtures for the end-to-end suite.

Every fixture here is gated on ``MEMEX_E2E=1`` (the conftest.py
suite-level skip catches the unset case before fixtures even run);
fixtures that require an additional precondition (a built binary,
a Hermes venv, model cache state) skip individually with a clear
reason.

Design notes:

* No global state. Every fixture is scoped to the test function so
  parallel test invocations don't share a HERMES_HOME.
* No subprocess shortcuts. ``materialize_memex`` invokes
  ``python -m memex_hermes.install`` exactly as a user would; the
  binary fixture points to a real file on disk; the Hermes session
  fixture (when used) drives a real ``MemoryManager`` from Hermes'
  venv via an inline script.
* ``Any`` is used only for the JSON loads of subprocess stdout,
  which is by definition unstructured at the type level.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import textwrap
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

import pytest

_REPO_ROOT: Final[Path] = Path(__file__).resolve().parent.parent.parent
# The Hermes venv python. Default derives from $HOME (works on any host where
# Hermes is installed at the standard location); override with HERMES_VENV_PYTHON
# for a non-standard install. (Avoids a hardcoded deanonymizing home path.)
_HERMES_VENV_PYTHON: Final[Path] = Path(
    os.environ.get(
        "HERMES_VENV_PYTHON",
        str(Path.home() / ".hermes" / "hermes-agent" / "venv" / "bin" / "python"),
    )
)


# ---------------------------------------------------------------------------
# Public fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def e2e_enabled() -> bool:
    """Whether the e2e suite was explicitly enabled.

    The conftest already skips the whole suite when ``MEMEX_E2E`` is
    unset, but individual tests can read this if they want to surface
    a different message in a sub-case.
    """
    return os.environ.get("MEMEX_E2E", "").strip().lower() in {"1", "true", "yes", "on"}


@pytest.fixture
def hermes_home(tmp_path: Path) -> Path:
    """Fresh scratch ``$HERMES_HOME`` with the layout the provider expects.

    Creates the directory shape the provider reads from / writes to:

        $HERMES_HOME/
        ├── skills/          (user adds SKILL.md fixtures here)
        ├── memories/        (MEMORY.md / USER.md live here)
        ├── plugins/         (materialize_memex populates plugins/memex/)
        ├── cache/memex/     (provider state + the binary lives under bin/)
        └── (config.yaml written by set_memory_provider on demand)
    """
    home = tmp_path / "hermes_home"
    (home / "skills").mkdir(parents=True)
    (home / "memories").mkdir(parents=True)
    (home / "plugins").mkdir(parents=True)
    (home / "cache" / "memex" / "bin").mkdir(parents=True)
    return home


@pytest.fixture
def sync_repo_dir(tmp_path: Path) -> Path:
    """Local sync-repo root for tests that write through the mirror path.

    Lives under tmp_path so it is auto-cleaned after the test runs.
    Tests that exercise push retry / remote semantics should not use
    this — those are out-of-scope for v1 e2e (documented as a v2
    follow-up in §11 of tasks.md).
    """
    repo = tmp_path / "sync_repo"
    repo.mkdir()
    # Initialize as a git repo so the mirror's `git add` / `git commit`
    # paths exercise. The mirror handler does this itself via
    # initSyncRepo when missing, but we set up a known starting state.
    subprocess.run(
        ["git", "init", "-q", "-b", "main", str(repo)],
        check=True,
        cwd=str(repo),
    )
    subprocess.run(
        ["git", "config", "user.email", "e2e@memex-hermes.test"],
        check=True,
        cwd=str(repo),
    )
    subprocess.run(
        ["git", "config", "user.name", "memex-hermes e2e"],
        check=True,
        cwd=str(repo),
    )
    # Empty initial commit so HEAD is valid.
    subprocess.run(
        ["git", "commit", "-q", "--allow-empty", "-m", "init"],
        check=True,
        cwd=str(repo),
    )
    return repo


@pytest.fixture
def materialize_memex(hermes_home: Path) -> Path:
    """Run ``python -m memex_hermes.install --hermes-home <home>``.

    Returns the materialized provider directory
    (``$HERMES_HOME/plugins/memex``). Exercises the install script
    exactly as a user would — no shortcuts.
    """
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "memex_hermes.install",
            "--hermes-home",
            str(hermes_home),
            "--force",
        ],
        capture_output=True,
        text=True,
        cwd=str(_REPO_ROOT),
    )
    if result.returncode != 0:
        pytest.fail(
            "memex_hermes.install failed:\n"
            f"stdout={result.stdout}\nstderr={result.stderr}"
        )
    provider_dir = hermes_home / "plugins" / "memex"
    assert (provider_dir / "__init__.py").is_file(), (
        f"install did not produce __init__.py in {provider_dir}"
    )
    return provider_dir


@pytest.fixture
def set_memory_provider(hermes_home: Path) -> Path:
    """Write ``memory: { provider: memex }`` to ``$HERMES_HOME/config.yaml``.

    Returns the config.yaml path. The activation key (R1) is what
    selects which discovered provider Hermes loads — required for
    any test that drives the Hermes runtime.
    """
    config = hermes_home / "config.yaml"
    config.write_text(
        textwrap.dedent(
            """\
            memory:
              provider: memex
            """
        ),
        encoding="utf-8",
    )
    return config


@dataclass(frozen=True)
class MemexBinaryInfo:
    """Resolved memex binary path + how we got it (for diagnostics)."""

    path: Path
    source: str  # one of: "env_override" | "hermes_home_cache"


@pytest.fixture
def memex_binary_path(hermes_home: Path) -> MemexBinaryInfo:
    """Resolve the memex binary on disk; skip the test if absent.

    Priority:
      1. ``MEMEX_HERMES_BINARY`` env var (operator override).
      2. ``$HERMES_HOME/cache/memex/bin/memex`` (the §9 dist layout).

    The provider's runner resolves these in the same order, then adds a
    final fallback to the shipped ``bin/memex`` wrapper packaged with the
    wheel (`memex_hermes/runner.py:_resolve_binary`); this fixture only
    needs a concrete binary to run against, so it stops at the cache path.
    """
    override = os.environ.get("MEMEX_HERMES_BINARY")
    if override:
        path = Path(override)
        if not path.is_file():
            pytest.skip(
                f"MEMEX_HERMES_BINARY={override!r} does not exist; "
                "build the binary first (pnpm build) or unset the var"
            )
        return MemexBinaryInfo(path=path, source="env_override")

    default = hermes_home / "cache" / "memex" / "bin" / "memex"
    if not default.is_file():
        pytest.skip(
            f"memex binary not found at {default}; "
            "build it via `pnpm build` and copy into $HERMES_HOME/cache/memex/bin/, "
            "or set MEMEX_HERMES_BINARY=/path/to/memex"
        )
    return MemexBinaryInfo(path=default, source="hermes_home_cache")


@dataclass(frozen=True)
class HermesSession:
    """One-shot driver for the Hermes ``MemoryManager``.

    ``call`` runs a small Python script inside the Hermes venv that
    constructs a MemoryManager, registers the materialized memex
    provider, then invokes a single method on it. Output is the
    method's return value (JSON-encoded) for the caller to assert on.
    """

    hermes_home: Path
    provider_dir: Path

    def call(
        self,
        method: str,
        *,
        args: Mapping[str, Any] | None = None,
        timeout_s: float = 30.0,
    ) -> Any:
        """Drive a single MemoryManager method and return its result.

        ``method`` may be one of:
          - ``"prefetch"`` — calls ``manager.prefetch_all(query)``
          - ``"sync_turn"`` — calls ``manager.sync_all(u, a)``
          - ``"on_memory_write"`` — calls
            ``manager.on_memory_write(action, target, content, metadata)``
          - ``"system_prompt"`` — calls ``manager.build_system_prompt()``
          - ``"shutdown"`` — calls ``manager.shutdown_all()``

        Raises ``pytest.fail`` on a non-zero subprocess exit so the
        test sees the upstream error rather than a cryptic None.
        """
        if not _HERMES_VENV_PYTHON.is_file():
            pytest.skip(
                f"Hermes venv python not found at {_HERMES_VENV_PYTHON}; "
                "this test requires Hermes installed (set HERMES_VENV_PYTHON to "
                "override the default ~/.hermes/hermes-agent/venv path)"
            )
        script = _build_session_script(
            method=method,
            args=args or {},
            hermes_home=self.hermes_home,
            provider_dir=self.provider_dir,
            repo_root=_REPO_ROOT,
        )
        proc = subprocess.run(
            [str(_HERMES_VENV_PYTHON), "-c", script],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            env=_hermes_env(self.hermes_home),
        )
        if proc.returncode != 0:
            pytest.fail(
                "Hermes session subprocess failed:\n"
                f"stdout={proc.stdout}\nstderr={proc.stderr}"
            )
        # The session script writes a single JSON object to stdout's
        # last non-empty line; ignore framework log noise above it.
        last = ""
        for line in proc.stdout.splitlines():
            stripped = line.strip()
            if stripped:
                last = stripped
        if not last:
            return None
        try:
            return json.loads(last)
        except json.JSONDecodeError:
            return last


@pytest.fixture
def hermes_session(
    hermes_home: Path,
    materialize_memex: Path,
    set_memory_provider: Path,
) -> HermesSession:
    """End-to-end session driver: materialized provider + activation config.

    Use this fixture for tests that want to exercise the full Hermes
    plugin-discovery → memory-manager → provider call chain. Tests
    that only care about the Python provider surface (most of the
    e2e suite) should call ``MemexProvider`` directly to avoid the
    Hermes-venv subprocess overhead.
    """
    _ = set_memory_provider  # silence unused-arg lint; fixture must run.
    return HermesSession(hermes_home=hermes_home, provider_dir=materialize_memex)


# ---------------------------------------------------------------------------
# Helpers (not fixtures; importable by test modules for fine-grained control)
# ---------------------------------------------------------------------------


def write_skill(
    skill_dir: Path,
    name: str,
    *,
    description: str,
    queries: list[str] | None = None,
    body: str = "",
) -> Path:
    """Author a SKILL.md fixture under ``skill_dir/<name>/``.

    Uses the frontmatter shape memex-core expects (``name`` /
    ``description`` / optional ``queries`` list). The body is the
    full skill content the provider returns on a match.
    """
    target = skill_dir / name
    target.mkdir(parents=True, exist_ok=True)
    skill_file = target / "SKILL.md"
    parts: list[str] = ["---", f"name: {name}", f"description: {description}"]
    if queries:
        parts.append("queries:")
        for q in queries:
            parts.append(f"  - {q}")
    parts.append("---")
    parts.append("")
    parts.append(body or description)
    skill_file.write_text("\n".join(parts) + "\n", encoding="utf-8")
    return skill_file


def clear_model_cache(hermes_home: Path) -> None:
    """Remove any cached ONNX model under $HERMES_HOME/cache/memex/.

    Used by the cold-run scenario (11.5). The exact subpath depends on
    the binary's model-cache layout (memex-core owns it); we wipe the
    whole memex cache except the bin/ directory so the next prefetch
    forces a full download.
    """
    cache = hermes_home / "cache" / "memex"
    if not cache.is_dir():
        return
    for child in cache.iterdir():
        if child.name == "bin":
            continue
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()


# ---------------------------------------------------------------------------
# Private — session-subprocess script construction
# ---------------------------------------------------------------------------


def _hermes_env(hermes_home: Path) -> Mapping[str, str]:
    env = dict(os.environ)
    env["HERMES_HOME"] = str(hermes_home)
    env["MEMEX_HERMES_HOME"] = str(hermes_home)
    return env


def _build_session_script(
    *,
    method: str,
    args: Mapping[str, Any],
    hermes_home: Path,
    provider_dir: Path,
    repo_root: Path,
) -> str:
    """Construct the inline Python script run inside Hermes' venv.

    The script:
    1. Prepends the memex-hermes repo root to sys.path so the
       materialized ``__init__.py`` can ``import memex_hermes.*``.
    2. Imports the Hermes MemoryManager + provider loader.
    3. Loads the memex provider via ``load_memory_provider("memex")``
       — the same path Hermes runtime takes.
    4. Registers it with a fresh MemoryManager.
    5. Invokes the requested method.
    6. Writes the result as a single JSON line to stdout.
    """
    # We embed the arguments via JSON to avoid Python literal escaping
    # quirks. The script decodes them back inside the subprocess.
    args_json = json.dumps(dict(args))
    repo_root_str = str(repo_root)
    hermes_home_str = str(hermes_home)
    _ = provider_dir  # discovered by loader from hermes_home; no direct use.

    return textwrap.dedent(
        f"""\
        import json, sys, os
        sys.path.insert(0, {repo_root_str!r})
        os.environ["HERMES_HOME"] = {hermes_home_str!r}
        os.environ["MEMEX_HERMES_HOME"] = {hermes_home_str!r}

        # Avoid noisy Hermes-side logging on stdout (we parse the last
        # line as JSON); route logs to stderr instead.
        import logging
        logging.basicConfig(level=logging.WARNING, stream=sys.stderr)

        from plugins.memory import load_memory_provider
        from agent.memory_manager import MemoryManager

        provider = load_memory_provider("memex")
        if provider is None:
            print(json.dumps({{"error": "provider not loaded"}}))
            sys.exit(1)

        manager = MemoryManager()
        manager.add_provider(provider)
        provider.initialize(
            session_id="e2e-session",
            hermes_home={hermes_home_str!r},
            platform="cli",
            agent_context="primary",
        )

        args = json.loads({args_json!r})
        method = {method!r}
        result = None
        if method == "prefetch":
            result = manager.prefetch_all(args["query"], session_id="e2e-session")
        elif method == "sync_turn":
            manager.sync_all(
                args["user_content"],
                args["assistant_content"],
                session_id="e2e-session",
            )
            result = {{"ok": True}}
        elif method == "on_memory_write":
            manager.on_memory_write(
                args["action"],
                args["target"],
                args["content"],
                metadata=args.get("metadata"),
            )
            result = {{"ok": True}}
        elif method == "system_prompt":
            result = manager.build_system_prompt()
        elif method == "shutdown":
            for p in manager.providers:
                try:
                    p.shutdown()
                except Exception as exc:
                    pass
            result = {{"ok": True}}
        else:
            print(json.dumps({{"error": f"unknown method {{method}}"}}))
            sys.exit(2)

        print(json.dumps(result))
        """
    )
