"""memex adapter for Hermes Agent.

Hermes discovers memory providers via a directory scan
(``plugins/memory/__init__.py:51-64``) that requires the string
``MemoryProvider`` or ``register_memory_provider`` in the first 8192
bytes of this file. We satisfy that heuristic naturally by exposing
both ``MemexProvider`` (a ``MemoryProvider`` subclass) and
``register(ctx)`` which calls ``ctx.register_memory_provider(...)``.

The active provider is selected by the ``memory.provider`` config key
in ``$HERMES_HOME/config.yaml``. A bare ``pip install`` does NOT
activate the provider; ``$HERMES_HOME/plugins/memex/__init__.py`` must
exist (the materialize step is the postinstall ``python -m
memex_hermes.install`` script, §9.6).
"""

from __future__ import annotations

from typing import Any

from memex_hermes.config import (
    DEFAULT_MEMEX_CONFIG,
    MemexConfig,
    build_config_schema,
    load_memex_config,
)
from memex_hermes.paths import (
    HermesPaths,
    parse_external_dirs,
    resolve_hermes_home,
)
from memex_hermes.provider import MemexProvider

__all__ = [
    "DEFAULT_MEMEX_CONFIG",
    "HermesPaths",
    "MemexConfig",
    "MemexProvider",
    "build_config_schema",
    "load_memex_config",
    "parse_external_dirs",
    "register",
    "resolve_hermes_home",
]


def register(ctx: Any) -> None:
    """Hermes plugin entry point.

    Called by ``load_memory_provider("memex")`` with a collector whose
    ``register_memory_provider`` captures the provider instance. The
    ``ctx`` parameter is typed ``Any`` because it crosses the Hermes
    plugin-loader boundary; we narrow it by calling exactly one method
    on it and never store the reference.
    """
    ctx.register_memory_provider(MemexProvider())
