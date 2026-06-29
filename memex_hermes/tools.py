"""Tool schemas for the memex_search / memex_remember / memex_recall trio.

Returned by ``MemexProvider.get_tool_schemas()`` and consumed by
Hermes' tool dispatcher. Each schema conforms to the
``{name, description, parameters}`` shape from the Build-a-Hermes-Plugin
guide; the verified ABC return type is ``list[dict[str, Any]]``
(``agent/memory_provider.py:122-129``).

Note the typing boundary: this list crosses INTO the Hermes ABC, so we
return ``list[dict[str, Any]]`` here — the one place the strict-typing
exemption applies. The contents are constructed from typed literals so
no upstream code is touched by ``Any``; only the return type matches
the ABC declaration.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Final

from memex_hermes.config import MemexConfig

# Dispatch invariant (G3): the dispatch table for handle_tool_call must
# enumerate exactly these three names. Tests parametrize over the set.
TOOL_NAMES: Final[frozenset[str]] = frozenset(
    {"memex_search", "memex_remember", "memex_recall"}
)


def get_tool_schemas(
    config: MemexConfig | None = None,
    *,
    enabled_only: bool = True,
) -> list[dict[str, Any]]:
    """Return the active tool schemas as plain dicts.

    A tool is filtered out when ``config["tools"][<name>]["enabled"]``
    is False. When ``config`` is None, all three are returned (the
    pre-init default; agnostic to user config).
    """
    schemas: list[dict[str, Any]] = [
        _search_schema(),
        _remember_schema(),
        _recall_schema(),
    ]
    if config is None or not enabled_only:
        return schemas
    tools_cfg = config["tools"]
    out: list[dict[str, Any]] = []
    if tools_cfg["memex_search"]["enabled"]:
        out.append(schemas[0])
    if tools_cfg["memex_remember"]["enabled"]:
        out.append(schemas[1])
    if tools_cfg["memex_recall"]["enabled"]:
        out.append(schemas[2])
    return out


def _search_schema() -> dict[str, Any]:
    return {
        "name": "memex_search",
        "description": (
            "Search the user's memex index of skills, memories, rules, and "
            "session learnings. Returns scored matches above the configured "
            "threshold."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Free-form natural language query.",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "description": (
                        "Max results to return. Defaults to "
                        "tools.memex_search.defaultLimit (5)."
                    ),
                },
                "types": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Optional entry-type filter (e.g. ['memory', 'skill']); "
                        "omit to search all configured types."
                    ),
                },
            },
            "required": ["query"],
        },
    }


def _remember_schema() -> dict[str, Any]:
    # Parameters MUST match the binary's HermesToolRememberArgs contract
    # (envelope.py: content, scope?, projectName?). The binary never reads a
    # `type` field, and `projectName` is the only way to reach the D7
    # "promotion to a named project" path (tool-remember.ts:78-84) — so the
    # schema advertises projectName and omits the dead `type` param.
    return {
        "name": "memex_remember",
        "description": (
            "Persist a new memory into the user's memex. Writes a markdown "
            "file with frontmatter, then commits and (when eligible) pushes it "
            "to the shared remote. The `synced` result is true only if the entry "
            "was committed AND pushed to the remote on this call; `committed` is "
            "true if it was committed locally (a committed-but-not-synced entry "
            "propagates on the next sync, so there is no need to re-call)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "Markdown body to persist.",
                },
                "scope": {
                    "type": "string",
                    "enum": ["project", "global"],
                    "description": (
                        "Where to scope the entry. Defaults to "
                        "tools.memex_remember.defaultScope (project)."
                    ),
                },
                "projectName": {
                    "type": "string",
                    "description": (
                        "Optional named project to promote this memory into; "
                        "writes under projects/<projectName>/memory/. When "
                        "omitted, the entry follows 'scope'."
                    ),
                },
            },
            "required": ["content"],
        },
    }


def _recall_schema() -> dict[str, Any]:
    return {
        "name": "memex_recall",
        "description": (
            "Fetch a specific memex entry by name. Returns the full markdown "
            "body and parsed frontmatter, or an error if not found."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Exact entry name (filename stem).",
                },
            },
            "required": ["name"],
        },
    }


# Light utility used by tests to walk the schema shape without
# hand-rolling literals.
_REQUIRED_KEYS: Final[Sequence[str]] = ("name", "description", "parameters")


def all_tool_schemas() -> list[dict[str, Any]]:
    """Return all three schemas regardless of config (testing aide)."""
    return get_tool_schemas(config=None)
