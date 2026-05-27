## Why

The `memex` family of semantic skill/memory/rule routers ships adapters for Claude Code (`memex-claude`) and OpenClaw (`memex-openclaw`), but not for [Hermes Agent](https://hermes-agent.nousresearch.com/) (NousResearch). Hermes users today have no way to participate in the cross-platform memex sync repo, which means knowledge authored in one harness cannot reach another. This change bootstraps a Hermes adapter that integrates as a first-class `MemoryProvider` and shares the same on-disk format, telemetry schema, and git sync repo layout as the existing adapters — making cross-harness memory sync work in both directions.

## What Changes

- Add a new repository `memex-hermes` housing a Python package (`memex_hermes`) that subclasses Hermes' `MemoryProvider` ABC and a TypeScript engine extension (`src/`) that adds `Hermes.*` events to the shared `memex` binary's dispatch table.
- Reuse the existing prebuilt `memex` binary (the `bun build --compile` artifact shipped by `memex-claude`) via subprocess; do **not** re-implement the engine in Python.
- All Hermes-side lifecycle methods (`prefetch`, `queue_prefetch`, `sync_turn`, `on_session_end`, `on_pre_compress`, `on_memory_write`, `system_prompt_block`, `handle_tool_call`, `initialize`, `is_available`, `save_config`, `shutdown`) translate to JSON `HookInput` envelopes sent on the binary's stdin, with `hook_event_name` discriminating the action.
- Subprocess invocations run off Hermes' async event loop (`asyncio.to_thread` or daemon threads) to honor the documented `sync_turn() MUST be non-blocking` contract.
- Bridge Hermes' built-in `MEMORY.md` / `USER.md` writes into the memex sync repo via `on_memory_write` (the **primary** path, confirmed to fire for built-in `remember` writes by source verification — see `spike/SPIKE-COMPLETE.md`) with an mtime-watcher fallback inside `sync_turn` for out-of-band writes.
- Suppress sync pushes for `_session/<id>` fallback project IDs AND for non-primary `agent_context` values (`subagent`/`cron`/`flush`) to prevent the sync repo from accumulating throwaway or representation-corrupting writes.
- Introduce three agent-callable tools — `memex_search`, `memex_remember`, `memex_recall` — namespaced with the `memex_` prefix to peer with `honcho_*`, `mem0_*`, etc.
- Honor `HERMES_HOME` end-to-end: paths derive from the runtime value Hermes auto-injects into `initialize(**kwargs)` and passes to `save_config(values, hermes_home)`, never from a hardcoded `~/.hermes/`.
- Distribute the provider as a directory at `$HERMES_HOME/plugins/memex/` (manual install or a pip-install-plus-materialize step), activated via the `memory.provider: memex` config key; the `hermes_agent.plugins` entry-point is inventory-only and does NOT by itself activate a memory provider (verified — see `spike/SPIKE-COMPLETE.md` R1). Only one external memory provider may be active at a time. The bundled `bin/memex` wrapper downloads the right prebuilt binary on first run with SHA256 verification.

## Capabilities

### New Capabilities

- `hermes-memory-provider`: The Python `MemoryProvider` subclass that implements every Hermes lifecycle method by dispatching to the shared `memex` binary off the event loop. Covers method-by-method semantics, return-shape contracts, the verification-spike gate for `on_memory_write`, and the `HERMES_HOME` propagation rule.
- `hermes-engine-events`: The new `Hermes.*` cases added to the engine binary's `hook_event_name` switch in `src/main.ts`, including `Hermes.prefetch`, `Hermes.sync-turn`, `Hermes.session-end`, `Hermes.pre-compress`, `Hermes.memory-write`, `Hermes.system-prompt`, `Hermes.init`, `Hermes.health`, `Hermes.shutdown`, and the three `Hermes.tool-*` events. Covers the JSON envelope shape per event.
- `hermes-path-resolution`: The path-derivation layer (Python `paths.py` + TypeScript `src/core/hermes-paths.ts`) that maps `HERMES_HOME` into scan directories (skills, memories, external_dirs from `config.yaml`), cache root, sync repo root, and project-memory roots — without hardcoding `~/.hermes/`.
- `memex-tool-surface`: The three agent-callable tools (`memex_search`, `memex_remember`, `memex_recall`) with their schemas, argument/return shapes, namespace policy, and dispatch into `Hermes.tool-*` engine events.
- `hermes-sync-bridge`: The write-mirror semantics that propagate `MEMORY.md` / `USER.md` writes into the shared sync repo, the `_session/*` ID suppression rule, project-ID canonicalization for Hermes sessions, and cross-adapter git push-retry recovery.
- `hermes-plugin-packaging`: The provider-directory install (manual + pip-materialize) and `memory.provider` config-key activation, the single-external-provider constraint, the `bin/memex` first-run download wrapper, SHA256 verification, and the role of the `plugin.yaml` manifest (description metadata only, for memory providers).

### Modified Capabilities

(none — this is a greenfield repo; no existing specs to modify)

## Impact

- **New code surface (this repo):** `memex_hermes/` Python package; `src/` TypeScript engine extensions; `bin/` install wrappers; `plugin.yaml`; bundled `skills/`; `test/` with both pytest and vitest harnesses; `pyproject.toml` and `package.json`.
- **Upstream `@jim80net/memex-core` impact:** No changes required for v1; the engine extensions (`Hermes.*` events) live in this repo's `src/` and call into `memex-core` as a library. The plan is to upstream `src/core/hermes-paths.ts` and the `Hermes.*` switch cases into `memex-core` once stable (same evolution pattern memex-claude followed). No breaking changes to `memex-core` types or APIs.
- **Cross-adapter compatibility:** Sync repo layout, embedding cache format, telemetry schema, and project-ID canonicalization all remain byte-identical to `memex-claude` and `memex-openclaw`. Existing sync repos work unchanged.
- **Hermes runtime impact:** None — we subclass a public ABC. No patches to Hermes itself.
- **Distribution:** New PyPI package `memex-hermes`; reuses the existing GitHub release artifacts from `memex-claude` for the binary download.
- **Risks acknowledged in the design (`docs/specs/2026-05-25-memex-hermes-adapter-design.md`):** subprocess per-turn cold-start (200 ms budget; daemon-mode fallback if exceeded); `on_memory_write` firing semantics unverified (mtime-watcher fallback specced); cross-adapter git push races (rebase-retry loop specced).
