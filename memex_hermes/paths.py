"""Hermes-side path resolution for the memex adapter.

Every Hermes path derives from a single runtime ``HERMES_HOME`` value. This
module owns the resolution priority, the on-disk layout, and the parsing of
``config.yaml`` ``external_dirs``. It performs pure path arithmetic and YAML
reads only: it does NOT embed, index, sync, or invoke git (that is engine
work owned by ``@jim80net/memex-core`` behind the binary).
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

import yaml

logger = logging.getLogger("memex_hermes.paths")

# Environment variable names. The Hermes framework reads HERMES_HOME; we also
# honor it as the lowest-priority resolution source per the spec.
ENV_HERMES_HOME: Final = "HERMES_HOME"
ENV_PROJECT_PLUGINS: Final = "HERMES_ENABLE_PROJECT_PLUGINS"

# Default sync repo root. Kept Hermes-scoped so it never collides with
# ~/.claude/cache or any sibling adapter's cache (spec: cache/sync isolation).
_DEFAULT_SYNC_REPO_SUBPATH: Final = (".local", "share", "memex-hermes")

_TRUTHY: Final = frozenset({"1", "true", "yes", "on"})


@dataclass(frozen=True)
class HermesPaths:
    """Resolved Hermes layout rooted at a single ``hermes_home``.

    All members are absolute ``Path`` objects derived from ``home``. Nothing
    here is created on disk; these are the canonical locations the binary and
    the provider read from and write to.
    """

    home: Path

    @property
    def skills_dir(self) -> Path:
        return self.home / "skills"

    @property
    def memories_dir(self) -> Path:
        return self.home / "memories"

    @property
    def memory_md(self) -> Path:
        return self.memories_dir / "MEMORY.md"

    @property
    def user_md(self) -> Path:
        return self.memories_dir / "USER.md"

    @property
    def cache_root(self) -> Path:
        """memex cache root — telemetry, sessions, models, registry live here."""
        return self.home / "cache" / "memex"

    @property
    def memory_mtimes_file(self) -> Path:
        """Cache file for the sync_turn mtime-watcher (design §8.4)."""
        return self.cache_root / "memory-mtimes.json"

    @property
    def memex_json(self) -> Path:
        return self.home / "memex.json"

    @property
    def config_yaml(self) -> Path:
        return self.home / "config.yaml"

    def sync_repo_dir(self, sync_repo_override: str | None = None) -> Path:
        """Resolve the local sync repo root.

        ``sync_repo_override`` is the ``sync.repo`` config field when it names
        a local path. An empty/None override falls back to the documented
        default ``~/.local/share/memex-hermes/``. A value that looks like a
        git URL (the common ``sync.repo`` use) is NOT a local path and is
        ignored here — the engine clones it under the default root.
        """
        if sync_repo_override and _is_local_path(sync_repo_override):
            return _expand(sync_repo_override)
        return Path.home().joinpath(*_DEFAULT_SYNC_REPO_SUBPATH)

    def project_local_skills_dir(self, cwd: Path) -> Path:
        """``<cwd>/.hermes/skills`` — only scanned when project plugins enabled."""
        return cwd / ".hermes" / "skills"

    def scan_skill_dirs(
        self,
        cwd: Path | None = None,
        *,
        project_plugins_enabled: bool | None = None,
    ) -> list[Path]:
        """Ordered, de-duplicated skill scan roots.

        Order: global ``$HERMES_HOME/skills`` first, then ``external_dirs``
        from ``config.yaml``, then the project-local dir IFF project plugins
        are enabled (env ``HERMES_ENABLE_PROJECT_PLUGINS`` truthy) and a
        ``cwd`` is supplied.

        ``project_plugins_enabled`` overrides the env probe; pass it for
        deterministic tests. ``None`` (default) reads the environment.
        """
        if project_plugins_enabled is None:
            project_plugins_enabled = project_plugins_are_enabled()

        dirs: list[Path] = [self.skills_dir]
        dirs.extend(parse_external_dirs(self.home))
        if cwd is not None and project_plugins_enabled:
            dirs.append(self.project_local_skills_dir(cwd))

        seen: set[Path] = set()
        unique: list[Path] = []
        for d in dirs:
            if d not in seen:
                seen.add(d)
                unique.append(d)
        return unique


def resolve_hermes_home(
    initialize_kwargs: Mapping[str, Any] | None = None,
    save_config_arg: str | None = None,
) -> Path:
    """Resolve ``hermes_home`` in spec priority order.

    Priority (highest first):
      1. ``hermes_home`` in ``initialize_kwargs`` (framework auto-injects it
         into ``initialize(**kwargs)`` — ``agent/memory_manager.py:599-601``).
      2. The ``hermes_home`` argument recorded by ``save_config(values, hermes_home)``.
      3. The ``HERMES_HOME`` environment variable.

    ``~`` and ``${VAR}`` are expanded. Never hardcodes the default Hermes
    home directory: if no source supplies a value, this raises rather than
    inventing the default, because in the live runtime the framework always
    injects the value and a missing one signals a wiring bug we must surface,
    not paper over.

    INTENTIONAL ASYMMETRY with the TS ``resolveHermesHome``
    (``src/core/hermes-paths.ts``), which WARNS and falls back to the default
    Hermes home instead of raising. The provider must surface a wiring bug (it
    raises); the binary is also a standalone CLI that someone may run directly
    without the provider, so it degrades to the default rather than
    hard-failing — but it warns so the fallback is never silent. Do NOT "align"
    these by making the binary raise: that would break standalone invocation.
    """
    candidate = _kwargs_home(initialize_kwargs)
    if candidate is None and save_config_arg:
        candidate = save_config_arg
    if candidate is None:
        env_home = os.environ.get(ENV_HERMES_HOME)
        if env_home:
            candidate = env_home
    if candidate is None:
        raise ValueError(
            "HERMES_HOME could not be resolved from initialize kwargs, "
            "save_config argument, or the HERMES_HOME environment variable"
        )
    return _expand(candidate)


def parse_external_dirs(hermes_home: Path) -> list[Path]:
    """Read ``external_dirs`` from ``$HERMES_HOME/config.yaml``.

    Returns expanded absolute paths (``~`` and ``${VAR}`` resolved). The
    verified Hermes contract declares ``external_dirs`` at the top level
    (path-resolution spec scenario); a ``skills.external_dirs`` nesting is
    also accepted defensively since the spec phrases it as "under the
    appropriate section" without pinning one.

    Missing file -> ``[]`` silently. Malformed YAML (or an unexpected shape)
    -> a logged warning and ``[]`` so the scan proceeds with the global dir
    only.
    """
    config_yaml = hermes_home / "config.yaml"
    if not config_yaml.is_file():
        return []

    try:
        raw = yaml.safe_load(config_yaml.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        logger.warning("Failed to parse %s: %s; using global skills dir only", config_yaml, exc)
        return []
    except OSError as exc:
        logger.warning("Failed to read %s: %s; using global skills dir only", config_yaml, exc)
        return []

    if raw is None:
        return []
    if not isinstance(raw, Mapping):
        logger.warning(
            "Unexpected top-level shape in %s (expected a mapping); "
            "using global skills dir only",
            config_yaml,
        )
        return []

    entries = _extract_external_dir_entries(raw, config_yaml)
    return [_expand(e) for e in entries]


def project_plugins_are_enabled() -> bool:
    """Whether ``HERMES_ENABLE_PROJECT_PLUGINS`` is set to a truthy value."""
    value = os.environ.get(ENV_PROJECT_PLUGINS)
    if value is None:
        return False
    return value.strip().lower() in _TRUTHY


def _kwargs_home(initialize_kwargs: Mapping[str, Any] | None) -> str | None:
    if not initialize_kwargs:
        return None
    value = initialize_kwargs.get("hermes_home")
    # The kwarg crosses the Hermes ABC boundary as Any; narrow to str here.
    if isinstance(value, str) and value:
        return value
    if value is not None and not isinstance(value, str):
        logger.warning("Ignoring non-string hermes_home kwarg of type %s", type(value).__name__)
    return None


def _extract_external_dir_entries(raw: Mapping[str, Any], source: Path) -> list[str]:
    candidates: list[Any] = []
    top = raw.get("external_dirs")
    if top is not None:
        candidates.append(top)
    skills_section = raw.get("skills")
    if isinstance(skills_section, Mapping):
        nested = skills_section.get("external_dirs")
        if nested is not None:
            candidates.append(nested)

    out: list[str] = []
    for candidate in candidates:
        if isinstance(candidate, str):
            out.append(candidate)
        elif isinstance(candidate, Sequence):
            for item in candidate:
                if isinstance(item, str):
                    out.append(item)
                else:
                    logger.warning(
                        "Ignoring non-string external_dirs entry %r in %s", item, source
                    )
        else:
            logger.warning(
                "Ignoring external_dirs of unexpected type %s in %s",
                type(candidate).__name__,
                source,
            )
    return out


def _expand(value: str) -> Path:
    """Expand ``${VAR}`` / ``$VAR`` then ``~`` and resolve to an absolute Path."""
    expanded = os.path.expanduser(os.path.expandvars(value))
    return Path(expanded)


def _is_local_path(value: str) -> bool:
    """Heuristic: a ``sync.repo`` value is a local path (not a git URL).

    Git remotes are ``scheme://host/...``, ``git@host:...``, or ``host:path``
    scp-form. Anything beginning with ``/``, ``~``, ``.``, or ``$`` is local.
    """
    if value.startswith(("/", "~", ".", "$")):
        return True
    if "://" in value:
        return False
    # scp-style git remote: user@host:path or host:path with no leading slash.
    if ":" in value and "/" not in value.split(":", 1)[0]:
        return False
    return False
