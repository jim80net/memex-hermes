"""memex.json config loading, defaulting, and schema generation.

The config lives at ``$HERMES_HOME/memex.json`` (design §7). This module loads
it, deep-merges over a typed default, and renders a JSON Schema for the
provider's ``get_config_schema()``. It does no engine work: it parses a config
file and shapes dicts, nothing more.
"""

from __future__ import annotations

import copy
import json
import logging
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Final, Literal, TypedDict

logger = logging.getLogger("memex_hermes.config")


# --- Config shape (mirrors design §7 field-for-field) -----------------------


class SyncConfig(TypedDict):
    enabled: bool
    repo: str
    autoPull: bool
    autoCommitPush: bool
    suppressSessionIds: bool
    pushRetries: int
    projectMappings: dict[str, str]


class PrefetchConfig(TypedDict):
    topK: int
    threshold: float
    maxInjectedChars: int
    types: list[str]


class ToolSearchConfig(TypedDict):
    enabled: bool
    defaultLimit: int
    threshold: float


class ToolRememberConfig(TypedDict):
    enabled: bool
    defaultScope: Literal["project", "global"]


class ToolRecallConfig(TypedDict):
    enabled: bool


class ToolsConfig(TypedDict):
    memex_search: ToolSearchConfig
    memex_remember: ToolRememberConfig
    memex_recall: ToolRecallConfig


class SessionEndConfig(TypedDict):
    extractLearnings: bool
    extractionModel: str


class MemexConfig(TypedDict):
    enabled: bool
    embeddingModel: str
    cacheTimeMs: int
    skillDirs: list[str]
    memoryDirs: list[str]
    sync: SyncConfig
    prefetch: PrefetchConfig
    tools: ToolsConfig
    sessionEnd: SessionEndConfig
    mirrorHermesMemory: bool


# `projectMappings` keys are arbitrary user project names; the value type is a
# concrete TypedDict member so the structure stays mypy-strict while the inner
# mapping is the one place an open string->string map is the right model.
DEFAULT_MEMEX_CONFIG: Final[MemexConfig] = {
    "enabled": True,
    "embeddingModel": "Xenova/all-MiniLM-L6-v2",
    "cacheTimeMs": 300000,
    "skillDirs": [],
    "memoryDirs": [],
    "sync": {
        "enabled": False,
        "repo": "",
        "autoPull": True,
        "autoCommitPush": True,
        "suppressSessionIds": True,
        "pushRetries": 3,
        "projectMappings": {},
    },
    "prefetch": {
        "topK": 3,
        "threshold": 0.5,
        "maxInjectedChars": 8000,
        "types": ["skill", "memory", "workflow", "session-learning", "rule"],
    },
    "tools": {
        "memex_search": {"enabled": True, "defaultLimit": 5, "threshold": 0.4},
        "memex_remember": {"enabled": True, "defaultScope": "project"},
        "memex_recall": {"enabled": True},
    },
    "sessionEnd": {
        "extractLearnings": True,
        "extractionModel": "",
    },
    "mirrorHermesMemory": True,
}


# --- Public API -------------------------------------------------------------


def load_memex_config(memex_json_path: Path) -> MemexConfig:
    """Load ``memex.json`` and deep-merge it over ``DEFAULT_MEMEX_CONFIG``.

    Missing file -> defaults (no warning; an unconfigured install is normal).
    Malformed JSON or a non-object top level -> a logged warning and defaults.
    User-supplied keys are merged recursively over the defaults so a partial
    config (e.g. only ``{"sync": {"enabled": true}}``) keeps every other
    default intact. Unknown keys are preserved in the merged result so the
    binary may consume forward-compatible fields the Python layer ignores.
    """
    if not memex_json_path.is_file():
        return _clone_default()

    try:
        text = memex_json_path.read_text(encoding="utf-8")
    except OSError as exc:
        logger.warning("Failed to read %s: %s; using config defaults", memex_json_path, exc)
        return _clone_default()

    try:
        loaded: object = json.loads(text)
    except json.JSONDecodeError as exc:
        logger.warning("Failed to parse %s: %s; using config defaults", memex_json_path, exc)
        return _clone_default()

    if not isinstance(loaded, Mapping):
        logger.warning(
            "Top-level value in %s is not a JSON object; using config defaults",
            memex_json_path,
        )
        return _clone_default()

    merged = _deep_merge(_clone_default(), loaded)
    # The merge guarantees every default key is present; the structural shape
    # therefore conforms to MemexConfig (user overrides preserve types when
    # the file is well-formed). We assert the contract for the type checker.
    return merged  # type: ignore[return-value]


def build_config_schema() -> dict[str, Any]:
    """JSON Schema (draft 2020-12) describing ``memex.json`` for Hermes.

    Returned as a plain JSON-serializable structure so the provider's
    ``get_config_schema()`` can hand it straight to Hermes' config UI/CLI.
    """
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "memex-hermes configuration",
        "type": "object",
        "additionalProperties": True,
        "properties": {
            "enabled": {"type": "boolean", "default": DEFAULT_MEMEX_CONFIG["enabled"]},
            "embeddingModel": {
                "type": "string",
                "default": DEFAULT_MEMEX_CONFIG["embeddingModel"],
            },
            "cacheTimeMs": {
                "type": "integer",
                "minimum": 0,
                "default": DEFAULT_MEMEX_CONFIG["cacheTimeMs"],
            },
            "skillDirs": {"type": "array", "items": {"type": "string"}, "default": []},
            "memoryDirs": {"type": "array", "items": {"type": "string"}, "default": []},
            "sync": _sync_schema(),
            "prefetch": _prefetch_schema(),
            "tools": _tools_schema(),
            "sessionEnd": _session_end_schema(),
            "mirrorHermesMemory": {
                "type": "boolean",
                "default": DEFAULT_MEMEX_CONFIG["mirrorHermesMemory"],
            },
        },
    }


# --- Private helpers --------------------------------------------------------


def _clone_default() -> MemexConfig:
    # deepcopy so callers can mutate the result without poisoning the default.
    return copy.deepcopy(DEFAULT_MEMEX_CONFIG)


def _deep_merge(base: Mapping[str, Any], override: Mapping[str, Any]) -> dict[str, Any]:
    """Recursively merge ``override`` onto ``base``; override wins at leaves.

    Nested mappings merge key-by-key; any non-mapping value (including lists)
    replaces the base value wholesale, matching JSON-config override intent.
    """
    result: dict[str, Any] = dict(base)
    for key, value in override.items():
        existing = result.get(key)
        if isinstance(existing, Mapping) and isinstance(value, Mapping):
            result[key] = _deep_merge(existing, value)
        else:
            result[key] = value
    return result


def _sync_schema() -> dict[str, Any]:
    d = DEFAULT_MEMEX_CONFIG["sync"]
    return {
        "type": "object",
        "additionalProperties": True,
        "properties": {
            "enabled": {"type": "boolean", "default": d["enabled"]},
            "repo": {"type": "string", "default": d["repo"]},
            "autoPull": {"type": "boolean", "default": d["autoPull"]},
            "autoCommitPush": {"type": "boolean", "default": d["autoCommitPush"]},
            "suppressSessionIds": {"type": "boolean", "default": d["suppressSessionIds"]},
            "pushRetries": {"type": "integer", "minimum": 0, "default": d["pushRetries"]},
            "projectMappings": {
                "type": "object",
                "additionalProperties": {"type": "string"},
                "default": {},
            },
        },
    }


def _prefetch_schema() -> dict[str, Any]:
    d = DEFAULT_MEMEX_CONFIG["prefetch"]
    return {
        "type": "object",
        "additionalProperties": True,
        "properties": {
            "topK": {"type": "integer", "minimum": 0, "default": d["topK"]},
            "threshold": {
                "type": "number",
                "minimum": 0,
                "maximum": 1,
                "default": d["threshold"],
            },
            "maxInjectedChars": {
                "type": "integer",
                "minimum": 0,
                "default": d["maxInjectedChars"],
            },
            "types": {"type": "array", "items": {"type": "string"}, "default": list(d["types"])},
        },
    }


def _tools_schema() -> dict[str, Any]:
    search = DEFAULT_MEMEX_CONFIG["tools"]["memex_search"]
    remember = DEFAULT_MEMEX_CONFIG["tools"]["memex_remember"]
    recall = DEFAULT_MEMEX_CONFIG["tools"]["memex_recall"]
    return {
        "type": "object",
        "additionalProperties": True,
        "properties": {
            "memex_search": {
                "type": "object",
                "additionalProperties": True,
                "properties": {
                    "enabled": {"type": "boolean", "default": search["enabled"]},
                    "defaultLimit": {
                        "type": "integer",
                        "minimum": 1,
                        "default": search["defaultLimit"],
                    },
                    "threshold": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1,
                        "default": search["threshold"],
                    },
                },
            },
            "memex_remember": {
                "type": "object",
                "additionalProperties": True,
                "properties": {
                    "enabled": {"type": "boolean", "default": remember["enabled"]},
                    "defaultScope": {
                        "type": "string",
                        "enum": ["project", "global"],
                        "default": remember["defaultScope"],
                    },
                },
            },
            "memex_recall": {
                "type": "object",
                "additionalProperties": True,
                "properties": {
                    "enabled": {"type": "boolean", "default": recall["enabled"]},
                },
            },
        },
    }


def _session_end_schema() -> dict[str, Any]:
    d = DEFAULT_MEMEX_CONFIG["sessionEnd"]
    return {
        "type": "object",
        "additionalProperties": True,
        "properties": {
            "extractLearnings": {"type": "boolean", "default": d["extractLearnings"]},
            "extractionModel": {"type": "string", "default": d["extractionModel"]},
        },
    }
