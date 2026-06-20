"""Tests for memex_hermes.config — memex.json loading, merge, and schema."""

from __future__ import annotations

import json
import logging
from pathlib import Path

import jsonschema
import pytest

from memex_hermes.config import (
    DEFAULT_MEMEX_CONFIG,
    build_config_schema,
    load_memex_config,
)


def _write_memex_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


# --- defaults / missing / malformed -----------------------------------------


def test_missing_file_returns_defaults_silently(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger="memex_hermes.config"):
        cfg = load_memex_config(tmp_path / "memex.json")
    assert cfg == DEFAULT_MEMEX_CONFIG
    assert caplog.records == []


def test_returned_default_is_a_copy_not_aliased(tmp_path: Path) -> None:
    cfg = load_memex_config(tmp_path / "memex.json")
    cfg["sync"]["enabled"] = True
    cfg["prefetch"]["types"].append("mutated")
    # The module-level default must be untouched.
    assert DEFAULT_MEMEX_CONFIG["sync"]["enabled"] is False
    assert "mutated" not in DEFAULT_MEMEX_CONFIG["prefetch"]["types"]


def test_malformed_json_warns_and_defaults(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path = tmp_path / "memex.json"
    path.write_text("{not valid json", encoding="utf-8")
    with caplog.at_level(logging.WARNING, logger="memex_hermes.config"):
        cfg = load_memex_config(path)
    assert cfg == DEFAULT_MEMEX_CONFIG
    assert any("Failed to parse" in r.message for r in caplog.records)


def test_non_object_top_level_warns_and_defaults(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path = tmp_path / "memex.json"
    _write_memex_json(path, [1, 2, 3])
    with caplog.at_level(logging.WARNING, logger="memex_hermes.config"):
        cfg = load_memex_config(path)
    assert cfg == DEFAULT_MEMEX_CONFIG
    assert any("not a JSON object" in r.message for r in caplog.records)


# --- deep merge --------------------------------------------------------------


def test_partial_override_keeps_other_defaults(tmp_path: Path) -> None:
    path = tmp_path / "memex.json"
    _write_memex_json(path, {"sync": {"enabled": True}})
    cfg = load_memex_config(path)
    assert cfg["sync"]["enabled"] is True
    # Sibling sync keys preserved from default.
    assert cfg["sync"]["autoPull"] is DEFAULT_MEMEX_CONFIG["sync"]["autoPull"]
    assert cfg["sync"]["pushRetries"] == DEFAULT_MEMEX_CONFIG["sync"]["pushRetries"]
    # Unrelated sections untouched.
    assert cfg["prefetch"] == DEFAULT_MEMEX_CONFIG["prefetch"]
    assert cfg["enabled"] == DEFAULT_MEMEX_CONFIG["enabled"]


def test_nested_tool_override(tmp_path: Path) -> None:
    path = tmp_path / "memex.json"
    _write_memex_json(path, {"tools": {"memex_search": {"defaultLimit": 25}}})
    cfg = load_memex_config(path)
    assert cfg["tools"]["memex_search"]["defaultLimit"] == 25
    assert cfg["tools"]["memex_search"]["enabled"] is True
    assert cfg["tools"]["memex_recall"]["enabled"] is True


def test_list_value_replaced_wholesale(tmp_path: Path) -> None:
    path = tmp_path / "memex.json"
    _write_memex_json(path, {"prefetch": {"types": ["skill"]}})
    cfg = load_memex_config(path)
    assert cfg["prefetch"]["types"] == ["skill"]


def test_unknown_keys_preserved(tmp_path: Path) -> None:
    path = tmp_path / "memex.json"
    _write_memex_json(path, {"futureField": 99, "sync": {"newSyncOpt": "x"}})
    cfg = load_memex_config(path)
    assert cfg["futureField"] == 99  # type: ignore[typeddict-item]
    assert cfg["sync"]["newSyncOpt"] == "x"  # type: ignore[typeddict-item]


def test_full_round_trip(tmp_path: Path) -> None:
    path = tmp_path / "memex.json"
    _write_memex_json(path, dict(DEFAULT_MEMEX_CONFIG))
    cfg = load_memex_config(path)
    assert cfg == DEFAULT_MEMEX_CONFIG


# --- schema ------------------------------------------------------------------


def test_schema_is_valid_draft_2020_12() -> None:
    schema = build_config_schema()
    # Raises SchemaError if the schema itself is malformed.
    jsonschema.Draft202012Validator.check_schema(schema)


def test_default_config_validates_against_schema() -> None:
    schema = build_config_schema()
    jsonschema.validate(instance=dict(DEFAULT_MEMEX_CONFIG), schema=schema)


def test_schema_rejects_wrong_types() -> None:
    schema = build_config_schema()
    bad = dict(DEFAULT_MEMEX_CONFIG)
    bad["enabled"] = "not-a-bool"  # type: ignore[typeddict-item]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=bad, schema=schema)


def test_schema_rejects_invalid_scope_enum() -> None:
    schema = build_config_schema()
    instance = json.loads(json.dumps(dict(DEFAULT_MEMEX_CONFIG)))
    instance["tools"]["memex_remember"]["defaultScope"] = "team"
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=instance, schema=schema)


def test_schema_is_json_serializable() -> None:
    # get_config_schema() hands this straight to Hermes; it must serialize.
    json.dumps(build_config_schema())
