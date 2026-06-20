"""Tests for memex_hermes.paths — HERMES_HOME resolution and layout."""

from __future__ import annotations

import logging
from pathlib import Path

import pytest

from memex_hermes.paths import (
    ENV_HERMES_HOME,
    ENV_PROJECT_PLUGINS,
    HermesPaths,
    parse_external_dirs,
    project_plugins_are_enabled,
    resolve_hermes_home,
)

# --- resolve_hermes_home priority order -------------------------------------


def test_env_hermes_home_is_honored(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ENV_HERMES_HOME, "/data/hermes")
    assert resolve_hermes_home() == Path("/data/hermes")


def test_kwarg_beats_save_config_and_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ENV_HERMES_HOME, "/env/hermes")
    resolved = resolve_hermes_home(
        initialize_kwargs={"hermes_home": "/kwarg/hermes"},
        save_config_arg="/saveconfig/hermes",
    )
    assert resolved == Path("/kwarg/hermes")


def test_save_config_beats_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ENV_HERMES_HOME, "/env/hermes")
    resolved = resolve_hermes_home(save_config_arg="/saveconfig/hermes")
    assert resolved == Path("/saveconfig/hermes")


def test_env_used_when_no_kwarg_or_save_config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ENV_HERMES_HOME, "/env/hermes")
    assert resolve_hermes_home(initialize_kwargs={}) == Path("/env/hermes")


def test_unresolvable_home_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(ENV_HERMES_HOME, raising=False)
    with pytest.raises(ValueError, match="HERMES_HOME could not be resolved"):
        resolve_hermes_home()


def test_tilde_and_var_expansion(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("MY_ROOT", str(tmp_path / "custom"))
    assert resolve_hermes_home(save_config_arg="~/h") == tmp_path / "h"
    assert resolve_hermes_home(save_config_arg="${MY_ROOT}/h") == tmp_path / "custom" / "h"


def test_non_string_kwarg_ignored_falls_through(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ENV_HERMES_HOME, "/env/hermes")
    resolved = resolve_hermes_home(initialize_kwargs={"hermes_home": 123})
    assert resolved == Path("/env/hermes")


# --- HermesPaths layout -----------------------------------------------------


def test_layout_derives_from_home(tmp_path: Path) -> None:
    home = tmp_path / "hermes"
    p = HermesPaths(home=home)
    assert p.skills_dir == home / "skills"
    assert p.memories_dir == home / "memories"
    assert p.memory_md == home / "memories" / "MEMORY.md"
    assert p.user_md == home / "memories" / "USER.md"
    assert p.cache_root == home / "cache" / "memex"
    assert p.memory_mtimes_file == home / "cache" / "memex" / "memory-mtimes.json"
    assert p.memex_json == home / "memex.json"
    assert p.config_yaml == home / "config.yaml"


def test_no_resolved_path_contains_hardcoded_default_home(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Redirect HERMES_HOME away from any real ~/.hermes and assert that no
    # resolved path silently falls back to the literal default.
    redirected = tmp_path / "redirected-hermes"
    monkeypatch.setenv(ENV_HERMES_HOME, str(redirected))
    monkeypatch.setenv("HOME", str(tmp_path / "fake-home"))
    p = HermesPaths(home=resolve_hermes_home())
    derived = [
        p.skills_dir,
        p.memories_dir,
        p.memory_md,
        p.user_md,
        p.cache_root,
        p.memory_mtimes_file,
        p.memex_json,
        p.config_yaml,
    ]
    for path in derived:
        assert str(path).startswith(str(redirected))
        assert ".hermes" not in str(path)


def test_sync_repo_default(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    p = HermesPaths(home=tmp_path / "hermes")
    assert p.sync_repo_dir() == tmp_path / ".local" / "share" / "memex-hermes"
    assert p.sync_repo_dir("") == tmp_path / ".local" / "share" / "memex-hermes"


def test_sync_repo_git_url_override_ignored(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    p = HermesPaths(home=tmp_path / "hermes")
    default = tmp_path / ".local" / "share" / "memex-hermes"
    assert p.sync_repo_dir("https://github.com/me/repo.git") == default
    assert p.sync_repo_dir("git@github.com:me/repo.git") == default


def test_sync_repo_local_path_override_used(tmp_path: Path) -> None:
    p = HermesPaths(home=tmp_path / "hermes")
    local = tmp_path / "elsewhere" / "repo"
    assert p.sync_repo_dir(str(local)) == local


# P2-4 — these cases are mirrored field-for-field by the TS suite
# (test/ts/hermes-paths.test.ts "resolveSyncRepoDir — local-path classification
# + expansion") to pin the cross-language contract: a `sync.repo` value must
# classify as local-vs-URL and expand to the SAME path on both sides, or the
# Python and TS checkouts diverge.
def test_sync_repo_path_classification_and_expansion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", "/home/tester")
    monkeypatch.setenv("MY_ROOT", "/srv/custom")
    p = HermesPaths(home=tmp_path / "hermes")
    default = Path("/home/tester") / ".local" / "share" / "memex-hermes"

    # Local paths expand identically to the TS expandPath.
    assert p.sync_repo_dir("$HOME/repo") == Path("/home/tester/repo")
    assert p.sync_repo_dir("${MY_ROOT}/x") == Path("/srv/custom/x")
    assert p.sync_repo_dir("~/repo") == Path("/home/tester/repo")
    assert p.sync_repo_dir("/abs") == Path("/abs")
    assert p.sync_repo_dir("./rel") == Path("./rel")

    # Git URLs are NOT local — both sides fall back to the default checkout dir.
    assert p.sync_repo_dir("git@github.com:o/r.git") == default
    assert p.sync_repo_dir("https://github.com/o/r.git") == default


# --- parse_external_dirs ----------------------------------------------------


def _write_config(home: Path, body: str) -> None:
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text(body, encoding="utf-8")


def test_external_dirs_top_level_expansion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_home = tmp_path / "user"
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setenv("SHARED", "/srv/shared/skills")
    home = tmp_path / "hermes"
    _write_config(home, 'external_dirs:\n  - "~/.agents/skills"\n  - "${SHARED}"\n')
    result = parse_external_dirs(home)
    assert result == [fake_home / ".agents" / "skills", Path("/srv/shared/skills")]


def test_external_dirs_nested_skills_section(tmp_path: Path) -> None:
    home = tmp_path / "hermes"
    _write_config(home, "skills:\n  external_dirs:\n    - /opt/team/skills\n")
    assert parse_external_dirs(home) == [Path("/opt/team/skills")]


def test_external_dirs_string_scalar(tmp_path: Path) -> None:
    home = tmp_path / "hermes"
    _write_config(home, "external_dirs: /single/dir\n")
    assert parse_external_dirs(home) == [Path("/single/dir")]


def test_missing_config_is_silent(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    home = tmp_path / "hermes"
    home.mkdir()
    with caplog.at_level(logging.WARNING, logger="memex_hermes.paths"):
        assert parse_external_dirs(home) == []
    assert caplog.records == []


def test_malformed_yaml_warns_and_returns_empty(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    home = tmp_path / "hermes"
    _write_config(home, "external_dirs: [unterminated\n")
    with caplog.at_level(logging.WARNING, logger="memex_hermes.paths"):
        assert parse_external_dirs(home) == []
    assert any("Failed to parse" in r.message for r in caplog.records)


def test_empty_config_yields_empty(tmp_path: Path) -> None:
    home = tmp_path / "hermes"
    _write_config(home, "")
    assert parse_external_dirs(home) == []


def test_non_mapping_top_level_warns(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    home = tmp_path / "hermes"
    _write_config(home, "- just\n- a\n- list\n")
    with caplog.at_level(logging.WARNING, logger="memex_hermes.paths"):
        assert parse_external_dirs(home) == []
    assert any("Unexpected top-level shape" in r.message for r in caplog.records)


def test_non_string_entries_skipped(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    home = tmp_path / "hermes"
    _write_config(home, "external_dirs:\n  - /good/dir\n  - 42\n")
    with caplog.at_level(logging.WARNING, logger="memex_hermes.paths"):
        assert parse_external_dirs(home) == [Path("/good/dir")]
    assert any("non-string external_dirs entry" in r.message for r in caplog.records)


# --- project plugins gating + scan ------------------------------------------


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on", " True "])
def test_project_plugins_enabled_truthy(
    value: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(ENV_PROJECT_PLUGINS, value)
    assert project_plugins_are_enabled() is True


@pytest.mark.parametrize("value", ["0", "false", "no", "", "off", "garbage"])
def test_project_plugins_disabled_values(
    value: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(ENV_PROJECT_PLUGINS, value)
    assert project_plugins_are_enabled() is False


def test_project_plugins_unset_is_false(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(ENV_PROJECT_PLUGINS, raising=False)
    assert project_plugins_are_enabled() is False


def test_scan_includes_project_local_when_enabled(tmp_path: Path) -> None:
    home = tmp_path / "hermes"
    home.mkdir()
    cwd = tmp_path / "proj"
    p = HermesPaths(home=home)
    dirs = p.scan_skill_dirs(cwd=cwd, project_plugins_enabled=True)
    assert p.skills_dir in dirs
    assert cwd / ".hermes" / "skills" in dirs


def test_scan_excludes_project_local_when_disabled(tmp_path: Path) -> None:
    home = tmp_path / "hermes"
    home.mkdir()
    cwd = tmp_path / "proj"
    p = HermesPaths(home=home)
    dirs = p.scan_skill_dirs(cwd=cwd, project_plugins_enabled=False)
    assert dirs == [p.skills_dir]
    assert cwd / ".hermes" / "skills" not in dirs


def test_scan_reads_env_gate_when_flag_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "hermes"
    home.mkdir()
    cwd = tmp_path / "proj"
    p = HermesPaths(home=home)
    monkeypatch.setenv(ENV_PROJECT_PLUGINS, "true")
    assert cwd / ".hermes" / "skills" in p.scan_skill_dirs(cwd=cwd)
    monkeypatch.setenv(ENV_PROJECT_PLUGINS, "0")
    assert cwd / ".hermes" / "skills" not in p.scan_skill_dirs(cwd=cwd)


def test_scan_includes_external_dirs(tmp_path: Path) -> None:
    home = tmp_path / "hermes"
    _write_config(home, "external_dirs:\n  - /srv/shared/skills\n")
    p = HermesPaths(home=home)
    dirs = p.scan_skill_dirs(project_plugins_enabled=False)
    assert dirs == [p.skills_dir, Path("/srv/shared/skills")]


def test_scan_deduplicates(tmp_path: Path) -> None:
    home = tmp_path / "hermes"
    # external_dirs duplicates the global skills dir; should appear once.
    _write_config(home, f"external_dirs:\n  - {home / 'skills'}\n")
    p = HermesPaths(home=home)
    dirs = p.scan_skill_dirs(project_plugins_enabled=False)
    assert dirs == [p.skills_dir]


def test_no_source_hardcodes_default_hermes_home() -> None:
    # Static guard for the no-hardcode invariant: no source file may embed the
    # default Hermes *home* literal "~/.hermes". The project-local "<cwd>/.hermes"
    # skills dir is a distinct, spec-mandated path and is intentionally allowed.
    src_dir = Path(__file__).resolve().parents[2] / "memex_hermes"
    for src in src_dir.glob("*.py"):
        text = src.read_text(encoding="utf-8")
        assert "~/.hermes" not in text, f"{src} contains hardcoded ~/.hermes"
