"""Tool schema shape + name set."""

from __future__ import annotations

import copy

from memex_hermes.config import DEFAULT_MEMEX_CONFIG, MemexConfig
from memex_hermes.tools import TOOL_NAMES, all_tool_schemas, get_tool_schemas


def test_all_three_tools_present_by_default() -> None:
    schemas = get_tool_schemas(None)
    names = {s["name"] for s in schemas}
    assert names == {"memex_search", "memex_remember", "memex_recall"}


def test_tool_schema_shape_conforms() -> None:
    for schema in all_tool_schemas():
        assert set(schema.keys()) >= {"name", "description", "parameters"}
        assert isinstance(schema["name"], str)
        assert isinstance(schema["description"], str)
        params = schema["parameters"]
        assert isinstance(params, dict)
        assert params["type"] == "object"
        assert "properties" in params


def test_every_tool_name_starts_with_memex_prefix() -> None:
    for schema in all_tool_schemas():
        assert schema["name"].startswith("memex_")


def test_tool_names_constant() -> None:
    assert TOOL_NAMES == frozenset({"memex_search", "memex_remember", "memex_recall"})


def test_disabled_tool_is_omitted() -> None:
    cfg: MemexConfig = copy.deepcopy(DEFAULT_MEMEX_CONFIG)
    cfg["tools"]["memex_recall"]["enabled"] = False
    schemas = get_tool_schemas(cfg)
    names = {s["name"] for s in schemas}
    assert "memex_recall" not in names
    assert "memex_search" in names and "memex_remember" in names


def test_search_schema_has_query_required() -> None:
    schemas = all_tool_schemas()
    search = next(s for s in schemas if s["name"] == "memex_search")
    assert "query" in search["parameters"]["required"]


def test_remember_schema_has_content_required() -> None:
    schemas = all_tool_schemas()
    remember = next(s for s in schemas if s["name"] == "memex_remember")
    assert "content" in remember["parameters"]["required"]


def test_remember_schema_matches_binary_contract() -> None:
    """The memex_remember params must match HermesToolRememberArgs:
    content / scope / projectName — never the dead `type` param."""
    schemas = all_tool_schemas()
    remember = next(s for s in schemas if s["name"] == "memex_remember")
    props = remember["parameters"]["properties"]
    assert set(props) == {"content", "scope", "projectName"}, (
        "remember schema must advertise exactly the binary's contract fields"
    )
    assert "type" not in props, "the binary never reads a `type` param"


def test_recall_schema_has_name_required() -> None:
    schemas = all_tool_schemas()
    recall = next(s for s in schemas if s["name"] == "memex_recall")
    assert "name" in recall["parameters"]["required"]
