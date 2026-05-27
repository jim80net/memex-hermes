## ADDED Requirements

### Requirement: Memory-provider activation requires a provider directory plus the memory.provider config key

Hermes discovers memory providers by scanning two directories — bundled `plugins/memory/<name>/` and user `$HERMES_HOME/plugins/<name>/` — and activates exactly the one named by the `memory.provider` key in `$HERMES_HOME/config.yaml`. (Verified against `plugins/memory/__init__.py:1-20,41-98` and `agent/agent_init.py:999-1005`.) The generic `hermes_agent.plugins` entry-point PluginManager explicitly skips `memory/` (`hermes_cli/plugins.py:819-829`) and its PluginContext has no `register_memory_provider` (`hermes_cli/plugins.py:1073-1078`); therefore a pip entry-point alone does NOT register or activate a memory provider. The system SHALL ship a provider directory at `$HERMES_HOME/plugins/memex/` containing an `__init__.py` that either (a) defines a `register(ctx)` function calling `ctx.register_memory_provider(MemexProvider())`, or (b) exposes a top-level `MemexProvider` subclass of `agent.memory_provider.MemoryProvider` for auto-instantiation. The `__init__.py` source SHALL contain the literal substring `MemoryProvider` or `register_memory_provider` within its first 8192 bytes so the discovery heuristic (`plugins/memory/__init__.py:51-64`) recognizes it.

#### Scenario: Provider directory plus config key activates memex
- **GIVEN** a directory `$HERMES_HOME/plugins/memex/__init__.py` implementing the provider
- **AND** `$HERMES_HOME/config.yaml` sets `memory.provider: memex`
- **WHEN** a Hermes session starts and `is_available()` returns `True`
- **THEN** `MemexProvider` is loaded by `load_memory_provider("memex")` and registered with the `MemoryManager`
- **AND** the provider's lifecycle methods are invoked for that session

#### Scenario: Entry-point without a provider directory does not activate the provider
- **GIVEN** `memex-hermes` is pip-installed and declares a `hermes_agent.plugins` entry-point
- **AND** no directory exists at `$HERMES_HOME/plugins/memex/`
- **WHEN** a Hermes session starts with `memory.provider: memex`
- **THEN** `load_memory_provider("memex")` returns `None` (the entry-point is not consulted for memory-provider activation)
- **AND** no memex lifecycle methods are invoked

### Requirement: Pip install materializes the provider directory under $HERMES_HOME/plugins/

Because the entry-point alone cannot activate a memory provider, the pip install path SHALL materialize the provider directory at `$HERMES_HOME/plugins/memex/` (via an explicit installer command, console-script, or postinstall step that copies or symlinks the packaged provider files), and SHALL document setting `memory.provider: memex`. The `hermes_agent.plugins` entry-point MAY still be declared so the plugin surfaces in `hermes plugins list`, but the spec SHALL NOT claim that pip install alone yields an active provider.

#### Scenario: Installer step produces an activatable provider
- **WHEN** the user runs `pip install memex-hermes` followed by the documented installer step (e.g. `memex-hermes install` or `python -m memex_hermes.install`)
- **THEN** `$HERMES_HOME/plugins/memex/__init__.py` exists
- **AND** after setting `memory.provider: memex`, the next Hermes session activates the provider

### Requirement: Plugin is installable via manual clone into $HERMES_HOME/plugins/

The repository SHALL support a manual install: place the provider directory at `$HERMES_HOME/plugins/memex/` containing `__init__.py` (and any helper modules) such that the memory-provider directory scan picks it up without any pip install. Activation is via `memory.provider: memex` in `config.yaml`, NOT via `hermes plugins enable`.

#### Scenario: Manual clone is recognized
- **GIVEN** a fresh `$HERMES_HOME` with no pip-installed memex plugin
- **WHEN** the user places the provider files at `$HERMES_HOME/plugins/memex/` and sets `memory.provider: memex` in `config.yaml`
- **THEN** `discover_memory_providers()` includes `memex` and `load_memory_provider("memex")` returns a `MemexProvider` instance
- **AND** Hermes' next session start invokes `register(ctx)` (or auto-instantiates the subclass)

### Requirement: memex coexists as the single active external memory provider

The `MemoryManager` accepts the built-in provider plus exactly ONE external provider; a second external provider is rejected with a warning (`agent/memory_manager.py:265-280`). The system SHALL document that activating `memex` requires that no other external memory provider (honcho, mem0, hindsight, retaindb, supermemory, etc.) is set as `memory.provider`, and the adapter SHALL NOT attempt to register itself when another external provider is already active.

#### Scenario: memex is the configured provider
- **GIVEN** `memory.provider: memex` and no other external provider configured
- **WHEN** the session starts
- **THEN** `memex` is the active external provider alongside the built-in provider

#### Scenario: Documentation states the single-provider constraint
- **WHEN** the user reads the install docs
- **THEN** the docs state that only one external memory provider can be active and that `memory.provider` selects it

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

### Requirement: plugin.yaml supplies the human-readable description

For memory providers, the memory-provider discovery reads ONLY the `description` field from a sibling `plugin.yaml` (`plugins/memory/__init__.py:135-142`); the provider's identity comes from the directory name and `provider.name`, and activation comes from the `memory.provider` config key — NOT from `plugin.yaml`. The bundled `plugin.yaml` SHALL declare `name: memex`, `version`, and `description` for surfacing in `hermes memory` / `hermes plugins` listings, but the spec SHALL NOT depend on `plugin.yaml` for memory-provider registration or activation.

#### Scenario: plugin.yaml description surfaces in discovery
- **WHEN** `discover_memory_providers()` runs with the provider directory present
- **THEN** the `description` from `plugin.yaml` is returned alongside the provider name
- **AND** a missing or malformed `plugin.yaml` does NOT prevent the provider from loading (description falls back to empty)

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

Uninstalling the plugin via `pip uninstall memex-hermes` OR removing `$HERMES_HOME/plugins/memex/` SHALL leave Hermes in a state where the next session starts cleanly with no memex involvement. Because activation is gated on the `memory.provider` config key, an uninstalled-but-still-configured provider SHALL fail closed: `load_memory_provider("memex")` returns `None` and Hermes proceeds with the built-in provider only (the uninstall docs SHALL instruct clearing `memory.provider`). The plugin SHALL NOT leave background processes running, daemons, cron entries, or modifications to Hermes' own config files that survive uninstall.

#### Scenario: Pip uninstall leaves Hermes operational
- **WHEN** the user runs `pip uninstall memex-hermes`
- **THEN** the next `hermes` session starts without errors
- **AND** Hermes' built-in memory continues to operate

#### Scenario: Cache and sync repo are not deleted on uninstall
- **WHEN** the package is uninstalled
- **THEN** `$HERMES_HOME/cache/memex/` is left intact
- **AND** `~/.local/share/memex-hermes/` is left intact
- **AND** the user can fully reset by manually deleting both directories
