## ADDED Requirements

### Requirement: Provider subclasses Hermes' MemoryProvider ABC

The system SHALL provide a Python class `MemexProvider` in `memex_hermes/provider.py` that subclasses `agent.memory_provider.MemoryProvider` and implements every method the Hermes runtime invokes on a memory provider.

#### Scenario: Provider registers via plugin entry point
- **WHEN** Hermes loads installed plugins and calls `register(ctx)` on the `memex_hermes` package
- **THEN** the package calls `ctx.register_memory_provider(MemexProvider())` exactly once
- **AND** `MemexProvider` is recognized by Hermes as an instance of `MemoryProvider`

#### Scenario: Provider exposes the name "memex"
- **WHEN** Hermes reads `provider.name`
- **THEN** the value is the string `"memex"`

### Requirement: Provider runs every binary invocation off the agent event loop

The provider SHALL NOT block the calling event loop while a subprocess is in flight. Awaited methods (`prefetch`, `is_available`, `system_prompt_block`, `handle_tool_call`) MUST dispatch the subprocess via `asyncio.to_thread()` or an equivalent off-loop mechanism. Fire-and-forget methods (`sync_turn`, `queue_prefetch`, `on_memory_write`) MUST enqueue work onto a daemon thread with a bounded queue.

#### Scenario: sync_turn returns within 5 ms even when the subprocess takes longer
- **WHEN** the binary subprocess invoked by `sync_turn(user, assistant)` is artificially slowed to 500 ms
- **THEN** `provider.sync_turn(...)` returns control to the caller in under 5 ms
- **AND** the subprocess completes asynchronously on the daemon thread

#### Scenario: prefetch suspends the calling task but does not block the event loop
- **WHEN** an asyncio task awaits `provider.prefetch(query)` and the binary takes 100 ms to respond
- **THEN** other tasks scheduled on the same event loop continue to run during those 100 ms

#### Scenario: Daemon-thread queue overflow drops the oldest entry and logs
- **WHEN** more `sync_turn` invocations are enqueued than the bounded queue capacity within a short window
- **THEN** the oldest pending entry is dropped to make room
- **AND** a warning identifying the dropped action is emitted via the Hermes logger

### Requirement: system_prompt_block returns a static, session-lifetime string

The output of `provider.system_prompt_block()` SHALL be stable for the lifetime of a session and SHALL NOT include per-turn dynamic content. All per-turn dynamic context injection SHALL flow through `prefetch(query)`.

#### Scenario: system_prompt_block called twice in one session returns identical content
- **WHEN** Hermes calls `provider.system_prompt_block()` at session start and again later in the same session
- **THEN** both calls return byte-identical strings

#### Scenario: system_prompt_block content describes available memex tools and sync state
- **WHEN** `provider.system_prompt_block()` is called at session start
- **THEN** the returned string describes the `memex_search` / `memex_remember` / `memex_recall` tools
- **AND** if sync is enabled, the string identifies the sync repo path and last-pull timestamp

### Requirement: initialize captures session_id and the runtime HERMES_HOME

`initialize(session_id, **kwargs)` SHALL persist `session_id` and the runtime `hermes_home` value (sourced from `kwargs`, `save_config`-recorded state, or the `HERMES_HOME` environment variable in that order) for use by every subsequent binary invocation in the session.

#### Scenario: Subsequent invocations propagate the captured HERMES_HOME
- **GIVEN** `HERMES_HOME=/data/hermes` at process start
- **WHEN** `initialize("sess-1")` is called
- **AND** then `prefetch("query")` is called
- **THEN** the subprocess invocation for `prefetch` receives `MEMEX_HERMES_HOME=/data/hermes` in its environment

### Requirement: save_config writes to the hermes_home argument

`save_config(values, hermes_home)` SHALL write the JSON-serialized `values` dict to `<hermes_home>/memex.json` using the argument-provided path, NEVER to a hardcoded `~/.hermes/memex.json`.

#### Scenario: save_config respects a non-default hermes_home
- **WHEN** `provider.save_config({"enabled": false}, "/data/hermes")` is called
- **THEN** the file `/data/hermes/memex.json` is created or updated with the serialized values
- **AND** no file is written to `~/.hermes/memex.json` (unless that happens to equal the argument path)

### Requirement: Provider degrades gracefully when the binary is unavailable

When the `memex` binary is missing, crashes, returns invalid JSON, or exceeds its per-method timeout, the provider SHALL log via the Hermes logger and return a safe default (empty string for `prefetch`, `False` for `is_available`, `None` for fire-and-forget methods, an error JSON for `handle_tool_call`) WITHOUT raising an exception that would crash the Hermes session.

#### Scenario: Missing binary
- **WHEN** the `memex` binary does not exist at the expected install path
- **THEN** `is_available()` returns `False`
- **AND** `prefetch("query")` returns `""`
- **AND** an install-hint log line is emitted at most once per session

#### Scenario: Subprocess crashes mid-call
- **WHEN** the binary exits with a non-zero status during a `prefetch` call
- **THEN** `prefetch` returns `""`
- **AND** the stderr from the subprocess is logged via the Hermes logger
- **AND** no exception propagates to the caller

#### Scenario: Subprocess timeout
- **WHEN** the `prefetch` subprocess does not return within the configured timeout (default 10 s)
- **THEN** the subprocess is canceled
- **AND** `prefetch` returns `""`
- **AND** a timeout-warning log line is emitted

### Requirement: All Python code passes mypy --strict

All Python code under `memex_hermes/` SHALL pass `mypy --strict`. The package SHALL NOT use bare `dict` or `dict[k,v]` as parameter or return types in its own code; structured kwarg/JSON shapes SHALL use `TypedDict` and data crossing the subprocess boundary SHALL use Pydantic `BaseModel`. `Any` is permitted only as the input type at Hermes ABC boundaries (whose runtime shapes are partially undocumented), and SHALL be narrowed via a typed adapter as soon as the value enters our code. The `spike/` directory is exempt as research code; this exemption is documented in `CLAUDE.md` and `CONTRIBUTING.md`.

#### Scenario: mypy --strict passes on the package
- **WHEN** `mypy --strict memex_hermes/` runs
- **THEN** the exit code is 0
- **AND** no errors are reported

#### Scenario: Boundary inputs are narrowed before propagating
- **WHEN** a `MemoryProvider` lifecycle method accepts `Any`-typed input from Hermes
- **THEN** the value is validated and converted into a `TypedDict` or Pydantic model before being passed to internal helpers or to the binary runner
- **AND** no internal helper signature accepts `Any` for that value

### Requirement: Python layer never re-implements engine functionality

The Python package `memex_hermes` SHALL NOT contain its own implementations of embedding, indexing, cache management, telemetry, sync, or any other functionality owned by `@jim80net/memex-core`. All such operations SHALL route through subprocess invocations of the `memex` binary. Helper modules (envelope construction, path resolution, schema dicts) are permitted; engine logic is not. (Per G1 from the openspec systems-review.)

#### Scenario: Python source contains no embedding imports
- **WHEN** the package source under `memex_hermes/` is scanned for imports of `transformers`, `onnxruntime`, `sentence_transformers`, or any vector-math library used for embedding
- **THEN** no such imports are found
- **AND** test fixtures under `test/` and the verification spike under `spike/` are excluded from this scan

#### Scenario: Python source contains no direct git invocation
- **WHEN** the package source under `memex_hermes/` is scanned for subprocess calls whose argv starts with `git`
- **THEN** none are found
- **AND** the only subprocess invocations are of the `memex` binary itself

### Requirement: Lifecycle methods dispatch to the correct engine events

Each Hermes-invoked provider lifecycle method SHALL dispatch to the corresponding `Hermes.*` event when it invokes the binary: `initialize`→`Hermes.init`, `system_prompt_block`→`Hermes.system-prompt`, `prefetch`→`Hermes.prefetch`, `queue_prefetch`→`Hermes.queue-prefetch`, `sync_turn`→`Hermes.sync-turn`, `on_session_end`→`Hermes.session-end`, `on_pre_compress`→`Hermes.pre-compress`, `on_memory_write`→`Hermes.memory-write`, `shutdown`→`Hermes.shutdown`, `is_available`→`Hermes.health`, `handle_tool_call("memex_search", ...)`→`Hermes.tool-search`, `handle_tool_call("memex_remember", ...)`→`Hermes.tool-remember`, `handle_tool_call("memex_recall", ...)`→`Hermes.tool-recall`. `name`, `get_tool_schemas`, `get_config_schema`, and `save_config` do not invoke the binary. (Per G3 from the openspec systems-review.)

#### Scenario: Each provider method invokes the documented event
- **GIVEN** the runner is replaced with a stub that records every `hook_event_name` it receives
- **WHEN** each listed method is invoked once with representative arguments
- **THEN** the recorded `hook_event_name` per call matches the documented mapping
- **AND** `name`, `get_tool_schemas`, `get_config_schema`, `save_config` produce no recorded entries

### Requirement: shutdown drains in-flight write operations within bound

`shutdown()` SHALL wait for in-flight daemon-thread write operations (`sync_turn`, `on_memory_write`, `queue_prefetch`) to complete, bounded by 5 seconds. Operations still pending after the bound SHALL be canceled and a warning emitted via the Hermes logger. (Per G3 from the openspec systems-review.)

#### Scenario: shutdown waits for a pending mirror write
- **GIVEN** an `on_memory_write` daemon-thread invocation is in flight and configured to take 200 ms to complete
- **WHEN** `provider.shutdown()` is called immediately after dispatching the write
- **THEN** `shutdown()` returns only after the write completes
- **AND** total elapsed time is ≥ 200 ms and ≤ 5 seconds

#### Scenario: shutdown cancels work that exceeds the bound
- **GIVEN** a daemon-thread invocation is in flight and configured to take 10 seconds
- **WHEN** `provider.shutdown()` is called
- **THEN** `shutdown()` returns after approximately 5 seconds
- **AND** a warning identifying the canceled action is emitted via the Hermes logger

### Requirement: A pre-implementation verification spike resolves on_memory_write semantics

Before the `MemexProvider` class is implemented, a one-file `MemoryProvider` subclass SHALL be built that traces every callback invocation, and run against Hermes interactively exercising the built-in `remember` tool, a normal turn, a session end, and a compression. The findings (which callbacks fire with which payloads) SHALL be recorded in the design doc and pick the primary mirror path for `on_memory_write` versus the mtime-watcher fallback.

#### Scenario: Spike outcome is recorded in the design doc
- **WHEN** the verification spike completes
- **THEN** `docs/specs/2026-05-25-memex-hermes-adapter-design.md` §8.4 is updated to identify which of the two specced paths is primary
- **AND** the chosen path is the one implemented first

(Maintenance policy — the spike SHALL be re-run on Hermes major or minor version upgrades; this is captured in `CONTRIBUTING.md` as a process gate rather than a runtime Scenario, per G9 from the openspec systems-review.)
