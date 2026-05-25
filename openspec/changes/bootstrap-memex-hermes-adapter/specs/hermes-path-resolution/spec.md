## ADDED Requirements

### Requirement: All Hermes paths derive from the runtime HERMES_HOME

The adapter SHALL derive every Hermes-side path from the runtime `HERMES_HOME` value (default `~/.hermes/`). The Python layer reads `HERMES_HOME` from the environment or from the `hermes_home` argument passed to `save_config(values, hermes_home)`. The TypeScript engine reads `MEMEX_HERMES_HOME` from the environment, which the Python runner sets on every subprocess invocation. No code in either layer SHALL hardcode the literal string `~/.hermes`.

#### Scenario: Custom HERMES_HOME is honored end-to-end
- **GIVEN** `HERMES_HOME=/data/hermes` is set when Hermes starts
- **WHEN** the provider performs an end-to-end action: write config, scan skills, write a memory entry, and trigger a sync push
- **THEN** all reads occur under `/data/hermes/{skills,memories,memex.json}`
- **AND** all writes occur under `/data/hermes/cache/memex/` or `/data/hermes/memex.json`
- **AND** no file is written to `~/.hermes/` (unless that path equals `/data/hermes` for the running user)

#### Scenario: Subprocess invocation receives the env var
- **WHEN** the Python runner spawns the `memex` binary
- **THEN** the subprocess environment contains `MEMEX_HERMES_HOME` set to the captured `hermes_home` value

### Requirement: External skill directories are sourced from $HERMES_HOME/config.yaml

The Python `paths.py` module SHALL read `$HERMES_HOME/config.yaml`, parse the `external_dirs` entry under the appropriate section, expand `~` and `${VAR}` references, and include the resulting paths in the binary's `scanDirs.skillDirs` argument. If `config.yaml` is missing or malformed, the adapter SHALL log a warning and proceed with the global skills dir only.

#### Scenario: external_dirs are included in the scan
- **GIVEN** `$HERMES_HOME/config.yaml` declares `external_dirs: ["~/.agents/skills", "/srv/shared/skills"]`
- **WHEN** the binary builds its skill scan list
- **THEN** the resulting `scanDirs.skillDirs` array contains the expanded paths `/home/<user>/.agents/skills` and `/srv/shared/skills`

#### Scenario: Malformed config.yaml does not crash
- **WHEN** `$HERMES_HOME/config.yaml` contains a YAML parse error
- **THEN** `paths.py` logs a warning identifying the parse error
- **AND** the scan proceeds with `$HERMES_HOME/skills/` only

#### Scenario: Missing config.yaml is silent
- **WHEN** `$HERMES_HOME/config.yaml` does not exist
- **THEN** the scan proceeds with `$HERMES_HOME/skills/` only with no warning

### Requirement: Rules use the skills directory with frontmatter type discrimination

Rules SHALL be stored under `$HERMES_HOME/skills/<name>/SKILL.md` (the same directory as skills) with the YAML frontmatter `type: rule`. The adapter SHALL NOT create or scan a `$HERMES_HOME/rules/` directory.

#### Scenario: Rule entries are indexed from the skills directory
- **GIVEN** `$HERMES_HOME/skills/my-rule/SKILL.md` has frontmatter `type: rule`
- **WHEN** the binary builds the index
- **THEN** the entry is registered with `type: rule`
- **AND** appears in match results with rule-style disclosure semantics

#### Scenario: No rules directory is created or expected
- **WHEN** the adapter initializes
- **THEN** the adapter does not create `$HERMES_HOME/rules/`
- **AND** no scan path includes `$HERMES_HOME/rules/`

### Requirement: Cache and sync paths are stable and isolated per harness

The adapter SHALL use `$HERMES_HOME/cache/memex/` as its cache root and `~/.local/share/memex-hermes/` as its sync repo root. The cache root SHALL NOT overlap with `~/.claude/cache/` or any other adapter's cache. The sync repo SHALL be configurable to a different path via the `sync.repo` config field but defaults to the documented location.

#### Scenario: Cache files land under the Hermes-scoped root
- **WHEN** the binary writes the cache, telemetry, sessions, models, or registry files
- **THEN** all files are under `$HERMES_HOME/cache/memex/`

#### Scenario: Default sync repo path matches the documented location
- **GIVEN** no `sync.repo` override
- **WHEN** `sync.enabled = true`
- **THEN** the local sync repo is initialized at `~/.local/share/memex-hermes/`

### Requirement: Project-local skill directories are scanned when enabled by Hermes

When `HERMES_ENABLE_PROJECT_PLUGINS=true` is set in the environment, the adapter SHALL include `<cwd>/.hermes/skills/*/SKILL.md` in the scan paths. When unset or false, the adapter SHALL NOT scan project-local skill directories.

#### Scenario: Project-local skills picked up when enabled
- **GIVEN** `HERMES_ENABLE_PROJECT_PLUGINS=true` and a skill file at `/cwd/.hermes/skills/foo/SKILL.md`
- **WHEN** the index is built for `cwd=/cwd`
- **THEN** the `foo` skill appears in match results

#### Scenario: Project-local skills ignored when disabled
- **GIVEN** `HERMES_ENABLE_PROJECT_PLUGINS` is unset
- **WHEN** the index is built for `cwd=/cwd`
- **THEN** files under `/cwd/.hermes/skills/` are not indexed
