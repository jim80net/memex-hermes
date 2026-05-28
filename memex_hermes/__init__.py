"""memex adapter for Hermes Agent.

Public surface for the path/config layer. The provider class and binary
runner are added by later implementation phases.
"""

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

__all__ = [
    "DEFAULT_MEMEX_CONFIG",
    "HermesPaths",
    "MemexConfig",
    "build_config_schema",
    "load_memex_config",
    "parse_external_dirs",
    "resolve_hermes_home",
]
