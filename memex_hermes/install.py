"""Provider-directory materialize step.

Per `hermes-plugin-packaging` Requirement R1: the Hermes memory-provider
loader scans `$HERMES_HOME/plugins/<name>/` for a sibling `__init__.py`
that contains the string ``MemoryProvider`` or ``register_memory_provider``
in its first 8192 bytes. The pip-install entry-point alone does NOT
activate a memory provider; the user must run this materialize step
once, then set ``memory.provider: memex`` in ``$HERMES_HOME/config.yaml``.

What this script does:

1. Resolves ``$HERMES_HOME`` from ``--hermes-home`` argv, the
   ``HERMES_HOME`` env var, or ``MEMEX_HERMES_HOME`` (in that order).
2. Locates the installed ``memex_hermes`` package on disk via
   ``importlib.resources``.
3. Copies the provider-side Python files plus ``plugin.yaml`` into
   ``$HERMES_HOME/plugins/memex/``.
4. Prints the next-step instruction to set ``memory.provider: memex``.

Idempotent — re-running is safe. ``--force`` overwrites an existing
install; ``--dry-run`` lists the actions without touching disk. Exits
non-zero on any error so CI / shell pipelines fail loudly.
"""

from __future__ import annotations

import argparse
import logging
import os
import shutil
import sys
from collections.abc import Sequence
from importlib import resources
from pathlib import Path
from typing import Final

logger = logging.getLogger("memex_hermes.install")

# Files that must land under ``$HERMES_HOME/plugins/memex/`` for the
# Hermes memory-provider discovery to pick up the provider. The
# materialized ``__init__.py`` is the file the discovery heuristic
# probes for the literal substrings ``MemoryProvider`` /
# ``register_memory_provider`` (both present in our package).
_PROVIDER_MODULE_FILES: Final[tuple[str, ...]] = (
    "__init__.py",
    "paths.py",
    "config.py",
    "runner.py",
    "tools.py",
    "provider.py",
    "envelope.py",
    "_hermes_stub.py",
)

# plugin.yaml lives at the repo root and is shipped via hatch's
# ``include`` clause. The Hermes memory-provider discovery reads ONLY
# the ``description`` field from a sibling ``plugin.yaml``; we ship it
# so the description surfaces in ``hermes memory`` listings.
_PLUGIN_MANIFEST_FILENAME: Final = "plugin.yaml"

# The directory name under ``$HERMES_HOME/plugins/`` MUST match the
# value used in ``memory.provider: <name>`` config. Fixed here.
_PROVIDER_DIR_NAME: Final = "memex"


def main(argv: Sequence[str] | None = None) -> int:
    """Console-script entry point. Returns a process exit code."""
    parser = _build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(message)s",
        stream=sys.stderr,
    )

    try:
        hermes_home = _resolve_hermes_home(args.hermes_home)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    target_dir = hermes_home / "plugins" / _PROVIDER_DIR_NAME
    actions = _plan_actions(target_dir, force=args.force)

    if args.dry_run:
        _print_dry_run(target_dir, actions)
        _print_followup(target_dir, dry_run=True)
        return 0

    try:
        _execute_actions(target_dir, actions)
    except OSError as exc:
        print(f"error: failed to materialize provider directory: {exc}", file=sys.stderr)
        return 1

    _print_followup(target_dir, dry_run=False)
    return 0


# ---- argument parsing & resolution ----------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="memex-hermes-install",
        description=(
            "Materialize the memex provider directory under "
            "$HERMES_HOME/plugins/memex/ so the Hermes memory-provider "
            "directory-scan discovers it. Required after `pip install "
            "memex-hermes`."
        ),
    )
    parser.add_argument(
        "--hermes-home",
        type=str,
        default=None,
        help=(
            "Target Hermes home directory. Defaults to $HERMES_HOME or "
            "$MEMEX_HERMES_HOME if either is set."
        ),
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing files at the target path.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the actions that would be performed without touching disk.",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Print debug-level diagnostics.",
    )
    return parser


def _resolve_hermes_home(override: str | None) -> Path:
    candidate = override
    if candidate is None:
        candidate = os.environ.get("HERMES_HOME")
    if candidate is None:
        candidate = os.environ.get("MEMEX_HERMES_HOME")
    if candidate is None:
        raise ValueError(
            "HERMES_HOME is not set. Pass --hermes-home /path/to/hermes "
            "or export HERMES_HOME before running."
        )
    expanded = os.path.expanduser(os.path.expandvars(candidate))
    return Path(expanded).resolve()


# ---- planning -------------------------------------------------------------


class _Action:
    """One materialize action: copy source to dest, marked write or skip."""

    __slots__ = ("source_name", "dest", "kind")

    def __init__(self, source_name: str, dest: Path, kind: str) -> None:
        self.source_name: str = source_name
        self.dest: Path = dest
        # ``kind`` is one of: ``write`` (new), ``overwrite`` (force),
        # ``skip`` (idempotent — already up to date).
        self.kind: str = kind


def _plan_actions(target_dir: Path, *, force: bool) -> list[_Action]:
    actions: list[_Action] = []
    sources = list(_PROVIDER_MODULE_FILES) + [_PLUGIN_MANIFEST_FILENAME]
    for source_name in sources:
        dest = target_dir / source_name
        if not dest.exists():
            actions.append(_Action(source_name, dest, "write"))
        elif force:
            actions.append(_Action(source_name, dest, "overwrite"))
        else:
            actions.append(_Action(source_name, dest, "skip"))
    return actions


# ---- execution ------------------------------------------------------------


def _execute_actions(target_dir: Path, actions: Sequence[_Action]) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    package_root = _package_root()
    plugin_yaml_root = _plugin_yaml_root(package_root)

    for action in actions:
        if action.kind == "skip":
            logger.debug("skip %s (exists; pass --force to overwrite)", action.dest)
            continue

        source = _resolve_source(action.source_name, package_root, plugin_yaml_root)
        _copy_resource(source, action.dest)
        logger.info("%s %s", action.kind, action.dest)


def _print_dry_run(target_dir: Path, actions: Sequence[_Action]) -> None:
    print(f"would create directory: {target_dir}")
    for action in actions:
        if action.kind == "skip":
            print(f"would skip (exists): {action.dest}")
        elif action.kind == "overwrite":
            print(f"would overwrite: {action.dest}")
        else:
            print(f"would write: {action.dest}")


def _print_followup(target_dir: Path, *, dry_run: bool) -> None:
    prefix = "[dry-run] " if dry_run else ""
    config_yaml = target_dir.parent.parent / "config.yaml"
    print(
        f"\n{prefix}Next step: edit {config_yaml} and set:\n"
        f"\n    memory:\n      provider: memex\n\n"
        f"{prefix}Then restart your Hermes session. Only ONE external memory "
        f"provider may be active at a time; ensure no other provider "
        f"(honcho/mem0/retaindb/etc.) is configured as memory.provider."
    )


# ---- resource resolution --------------------------------------------------


def _package_root() -> Path:
    """Locate the installed ``memex_hermes`` package directory.

    Works for both editable installs and regular wheels because the
    package is always extracted to a real filesystem directory by pip.
    """
    files = resources.files("memex_hermes")
    return Path(str(files))


def _plugin_yaml_root(package_root: Path) -> Path:
    """Locate the bundled ``plugin.yaml``.

    Wheel layout: hatchling's ``force-include`` clause places the file
    inside the package directory as ``memex_hermes/plugin.yaml`` so it
    is reachable via ``importlib.resources`` and survives any
    site-packages relocation.

    Editable install layout: the source file lives at the repo root
    (``<repo>/plugin.yaml``), which is the parent of the package dir.

    Probe both locations in priority order.
    """
    # Wheel install: shipped inside the package via force-include.
    candidate = package_root / _PLUGIN_MANIFEST_FILENAME
    if candidate.is_file():
        return candidate
    # Editable install: file at the repo root.
    candidate = package_root.parent / _PLUGIN_MANIFEST_FILENAME
    if candidate.is_file():
        return candidate
    raise FileNotFoundError(
        f"could not locate {_PLUGIN_MANIFEST_FILENAME} alongside the "
        f"installed memex_hermes package (looked inside {package_root} "
        f"and {package_root.parent})"
    )


def _resolve_source(
    source_name: str,
    package_root: Path,
    plugin_yaml_root: Path,
) -> Path:
    if source_name == _PLUGIN_MANIFEST_FILENAME:
        return plugin_yaml_root
    return package_root / source_name


def _copy_resource(source: Path, dest: Path) -> None:
    """Copy a source file to a destination path, preserving mtime/mode."""
    shutil.copy2(source, dest)


if __name__ == "__main__":
    raise SystemExit(main())
