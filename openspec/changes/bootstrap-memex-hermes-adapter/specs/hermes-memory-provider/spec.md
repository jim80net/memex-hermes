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

### Requirement: A pre-implementation verification spike resolves on_memory_write semantics

Before the `MemexProvider` class is implemented, a one-file `MemoryProvider` subclass SHALL be built that traces every callback invocation, and run against Hermes interactively exercising the built-in `remember` tool, a normal turn, a session end, and a compression. The findings (which callbacks fire with which payloads) SHALL be recorded in the design doc and pick the primary mirror path for `on_memory_write` versus the mtime-watcher fallback.

#### Scenario: Spike outcome is recorded in the design doc
- **WHEN** the verification spike completes
- **THEN** `docs/specs/2026-05-25-memex-hermes-adapter-design.md` §8.4 is updated to identify which of the two specced paths is primary
- **AND** the chosen path is the one implemented first

#### Scenario: Spike re-runs on every Hermes upgrade
- **WHEN** the Hermes runtime is upgraded to a new minor or major version
- **THEN** the verification spike is re-run before that version is supported
- **AND** the design doc is updated if the contract changed
