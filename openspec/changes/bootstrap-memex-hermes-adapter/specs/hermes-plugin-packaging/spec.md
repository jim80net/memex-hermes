## ADDED Requirements

### Requirement: Plugin is installable via pip with a Hermes entry point

The package SHALL declare a `[project.entry-points."hermes_agent.plugins"]` entry in `pyproject.toml` mapping `memex = "memex_hermes"` so Hermes discovers the plugin after `pip install memex-hermes`.

#### Scenario: pip install registers the plugin
- **GIVEN** `pyproject.toml` declares the entry point
- **WHEN** the user runs `pip install memex-hermes` followed by `hermes plugins enable memex`
- **THEN** the plugin appears in `hermes plugins list`
- **AND** Hermes' next session start invokes `register(ctx)` on the `memex_hermes` package

### Requirement: Plugin is installable via manual clone into $HERMES_HOME/plugins/

The repository SHALL also support the "clone into `$HERMES_HOME/plugins/<name>/`" install path documented by Hermes. The cloned directory SHALL contain `plugin.yaml`, `__init__.py`, and the `memex_hermes/` package such that Hermes' filesystem-based discovery picks it up without any pip install.

#### Scenario: Manual clone is recognized
- **GIVEN** a fresh `$HERMES_HOME` with no pip-installed memex plugin
- **WHEN** the user clones the repo into `$HERMES_HOME/plugins/memex/` and runs `hermes plugins enable memex`
- **THEN** the plugin appears in `hermes plugins list`
- **AND** Hermes' next session start invokes `register(ctx)`

### Requirement: bin/memex wrapper downloads the prebuilt binary on first run

A `bin/memex` script SHALL ship with the package and, on first invocation when the binary is absent, SHALL download the platform-appropriate prebuilt `memex` binary from the GitHub release that this version of the package is pinned to, verify its SHA256 against a checksum bundled with the package, and install it under `$HERMES_HOME/cache/memex/bin/memex`. Subsequent invocations SHALL exec the cached binary directly.

#### Scenario: First-run download succeeds
- **GIVEN** no binary exists at `$HERMES_HOME/cache/memex/bin/memex`
- **WHEN** the wrapper is invoked
- **THEN** the wrapper downloads the right artifact for the current `(platform, arch)` from the pinned GitHub release
- **AND** verifies the SHA256 against the bundled `checksums.txt`
- **AND** installs the binary at `$HERMES_HOME/cache/memex/bin/memex` with executable permissions
- **AND** execs the binary, forwarding stdin, stdout, stderr, and arguments

#### Scenario: SHA256 mismatch aborts the install
- **WHEN** the downloaded artifact's SHA256 does not match the bundled checksum
- **THEN** the wrapper does not install the binary
- **AND** exits with a non-zero status
- **AND** prints an error identifying the mismatch

#### Scenario: Subsequent runs use the cached binary
- **GIVEN** the binary already exists at the install path
- **WHEN** the wrapper is invoked
- **THEN** no download is attempted
- **AND** the wrapper execs the cached binary directly

### Requirement: plugin.yaml declares Hermes-required metadata

The `plugin.yaml` SHALL declare `name`, `version`, `description`, and provider/hook metadata in the shape Hermes' plugin discovery expects (per its Build-a-Hermes-Plugin guide).

#### Scenario: plugin.yaml is well-formed
- **WHEN** Hermes parses `plugin.yaml` during plugin discovery
- **THEN** the parse succeeds with no warnings
- **AND** the declared `name` equals `memex`

### Requirement: Bundled lifecycle skills ship alongside the plugin

The package SHALL ship a `skills/` directory containing at minimum the `sleep`, `deep-sleep`, `doctor`, and `handoff` skills, mirroring the bundled set in `memex-claude/skills/`. Each skill SHALL be a `SKILL.md` with the documented frontmatter and Hermes-compatible content.

#### Scenario: Bundled skills are present in the package
- **WHEN** the package is installed via pip or manual clone
- **THEN** the files `skills/{sleep,deep-sleep,doctor,handoff}/SKILL.md` exist under the install root
- **AND** each file has YAML frontmatter with at minimum `name` and `description`

#### Scenario: Bundled skills are visible to the index
- **WHEN** the binary builds the skill index with the bundled skills dir in `scanDirs.skillDirs`
- **THEN** the four bundled skills appear in match results for queries relevant to their descriptions

### Requirement: Plugin uninstall is fully reversible

Uninstalling the plugin via `pip uninstall memex-hermes` OR removing `$HERMES_HOME/plugins/memex/` SHALL leave Hermes in a state where the next session starts cleanly with no memex involvement. The plugin SHALL NOT leave background processes running, daemons, cron entries, or modifications to Hermes' own config files that survive uninstall.

#### Scenario: Pip uninstall leaves Hermes operational
- **WHEN** the user runs `pip uninstall memex-hermes`
- **THEN** the next `hermes` session starts without errors
- **AND** Hermes' built-in memory continues to operate

#### Scenario: Cache and sync repo are not deleted on uninstall
- **WHEN** the package is uninstalled
- **THEN** `$HERMES_HOME/cache/memex/` is left intact
- **AND** `~/.local/share/memex-hermes/` is left intact
- **AND** the user can fully reset by manually deleting both directories
