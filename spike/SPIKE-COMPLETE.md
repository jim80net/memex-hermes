# SPIKE-COMPLETE — MemoryProvider contract verification

**Date:** 2026-05-26
**Hermes Agent version:** v0.14.0 (2026.5.16), Python 3.11.15
**Method:** Source grounding (primary) + runtime confirmation (optional, see §C)
**Source tree:** `/home/jim/.hermes/hermes-agent/` (editable install; `agent` package on the
venv import path `/home/jim/.hermes/hermes-agent/venv/bin/python`)

---

## Why this spike was resolved from source, not a runtime trace

The verification spike (openspec §2, design §8.4) exists because Hermes' **public docs**
left several `MemoryProvider` semantics ambiguous — most importantly whether
`on_memory_write` fires when the built-in `remember` tool writes to `MEMORY.md`.

When this session resumed on the Hermes-equipped host, the host turned out to carry an
**editable install of Hermes**, which means the actual `MemoryProvider` ABC source, its
caller (`MemoryManager`), the plugin loader, and the activation site are all on disk. Per
`~/.claude/rules/verify-before-acting.md`, **source code is the gold standard** — strictly
more authoritative than a runtime trace for contract *shapes* and *dispatch wiring*, because
the trace only observes the callbacks that happen to fire in one exercised session, whereas
the source enumerates every callback, signature, and dispatch guard unconditionally.

The original runtime trace (`spike/trace_provider.py`) would in fact have been **partially
silent and partially broken** against this version:

- Its `prefetch(self, query)` / `sync_turn(self, user, assistant)` lacked the keyword-only
  `session_id` parameter the real ABC declares, so the manager's
  `provider.prefetch(query, session_id=...)` / `provider.sync_turn(..., session_id=...)`
  calls would have raised `TypeError`, been swallowed by the manager's per-provider
  `try/except`, and logged only at DEBUG — i.e., those callbacks would have appeared to
  "never fire" when in fact the trace provider was rejecting them.
- Its registration runbook (`hermes plugins enable` + `provides_memory_providers`) does not
  register a memory provider at all on this version (see **R1**).

So the trace as written would have produced **misleading negative results**. Reading source
both resolved every question definitively and caught the trace's own bugs. The corrected
trace provider is retained for an optional runtime confirmation (§C) of the three items
source cannot fully settle.

---

## The 7 questions — answered from source

### Q1. Does `on_memory_write` fire when the built-in `remember` tool writes? → **YES.**

The built-in memory write path calls the manager's `on_memory_write`, which fans out to
every **non-builtin** provider:

- Trigger call sites: `agent/tool_executor.py:642` and `agent/agent_runtime_helpers.py:1546`
  — both `agent._memory_manager.on_memory_write(...)`.
- Dispatch: `agent/memory_manager.py:537-565` iterates providers, **skips the `builtin`
  provider** (it is the source of the write, `:549-550`), and calls each external
  provider's `on_memory_write`.

**Important guard — the built-in tool bridges only `add` and `replace`, NOT `remove`.** Both
call sites gate the bridge on `function_args.get("action") in {"add", "replace"}`
(`agent/tool_executor.py:640`, `agent/agent_runtime_helpers.py:1544`). A `remove` performed by
the built-in memory tool **never fires `on_memory_write`**; it reaches the mirror only via the
`Hermes.sync-turn` mtime-watcher, which re-mirrors the full current file content (so deletions
are captured correctly by content replacement, not by a delete-delta). This is a concrete
reason BOTH mirror paths must ship.

**Decision:** `on_memory_write` is the **primary** mirror path for `add`/`replace` (design
§8.4 / G19). The `Hermes.sync-turn` mtime-watcher is the **secondary** path — mandatory, not
optional — covering `remove` and out-of-band writes (direct disk edits, external tools). Both
ship, per G19.

### Q2. What are `action`, `target`, `content` (and is there more)? → **plus a 4th `metadata` arg.**

`agent/memory_provider.py:262-279`:

- `action: str` ∈ `{"add", "replace", "remove"}` per the ABC, but the built-in tool only
  bridges `add`/`replace` (see Q1 guard); `remove` arrives only via the mtime path.
- `target: str` ∈ `{"memory", "user"}` (defaults to `"memory"`, `agent/tool_executor.py:630`);
  our mirror maps `memory`→`MEMORY.md`, `user`→`USER.md`.
- `content: str`
- **`metadata: Optional[Dict[str, Any]] = None`** — provenance. Documented common keys:
  `write_origin`, `execution_context`, `session_id`, `parent_session_id`, `platform`,
  `tool_name`.

The manager is **signature-adaptive** (`agent/memory_manager.py:511-535`): it inspects the
provider's `on_memory_write` signature and passes `metadata` as keyword, positionally, or
omits it (legacy 3-arg) accordingly. A 3-arg provider still works, but we lose provenance.
**See R3.**

### Q3. What kwargs does `initialize` receive? → many; `hermes_home` + `platform` always.

ABC contract (`agent/memory_provider.py:60-81`): `initialize(session_id: str, **kwargs)`.
kwargs **always** include `hermes_home` (str) and `platform` (str); **may** include
`agent_context`, `agent_identity`, `agent_workspace`, `parent_session_id`, `user_id`.

Concrete CLI activation kwargs (`agent/agent_init.py:1009-1048`):
`session_id`, `platform` (default `"cli"`), `hermes_home`, **`agent_context="primary"`**,
and optionally `session_title`, `user_id`, `user_name`, `chat_id`, `chat_name`, `chat_type`,
`thread_id`, `gateway_session_key`, `agent_identity` (profile), `agent_workspace="hermes"`.

`hermes_home` is **auto-injected by the framework** even if a caller omits it
(`agent/memory_manager.py:599-601`). **See R5, R7.**

### Q4. Is `system_prompt_block()` called once or N times per session?

Called via `MemoryManager.build_system_prompt()` (`agent/memory_manager.py:318-335`) during
**system-prompt assembly** (`agent/system_prompt.build_system_prompt`, forwarded from
`run_agent.py:2176-2179`). This is the cached prompt-prefix path, consistent with the design's
D5 (static, session-lifetime) assumption. Exact invocation count across resume/compression
is the one item left for runtime confirmation (§C) — but the contract requirement (return
stable content) is unchanged and already specced.

### Q5. What types does `sync_turn` receive? → **raw strings**, plus keyword-only `session_id`.

`agent/memory_provider.py:114-119`:
`sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "")`.
Both content args are **`str`** (not message dicts). Dispatched at
`agent/memory_manager.py:371-380` as `sync_all(user_content, assistant_content, session_id=...)`,
called from `run_agent.py:2011`. **See R6.**

### Q6. Any unexpected callbacks? → **THREE optional hooks the v2 design omitted.**

`agent/memory_provider.py`:

- `on_turn_start(turn_number: int, message: str, **kwargs)` (`:144-151`) — per-turn tick;
  kwargs may include `remaining_tokens`, `model`, `platform`, `tool_count`.
- `on_session_switch(new_session_id, *, parent_session_id="", reset=False, **kwargs)`
  (`:163-200`) — fires on `/resume`, `/branch`, `/reset`, `/new`, **and context compression**;
  any path that reassigns `session_id` without tearing the provider down.
- `on_delegation(task, result, *, child_session_id="", **kwargs)` (`:214-225`) — parent-side
  observation when a subagent completes.

All have no-op defaults, so omitting them is *safe*, but `on_session_switch` is **load-bearing
for sync correctness**: a provider that caches per-session state in `initialize()` (we will —
the captured `session_id` and project-ID) must refresh it here or post-switch writes land in
the wrong session's record. **See R4.**

### Q7. Does `save_config(values, hermes_home)` receive `hermes_home` as a real argument? → **YES.**

`agent/memory_provider.py:245-260`: `save_config(self, values: Dict[str, Any], hermes_home: str)`.
`hermes_home` is a required positional. Confirms F6. **See R7.**

---

## R1–R7 — divergences from the v2 design, with spec impact

| # | Divergence | v2 design / handoff assumed | Source (file:line) | Spec files amended |
|---|---|---|---|---|
| **R1** | **Memory-provider registration & activation** | pip `[project.entry-points."hermes_agent.plugins"]` + `hermes plugins enable memex` + `plugin.yaml: provides_memory_providers` | Discovery is a **dir scan** of bundled `plugins/memory/<name>/` then user `$HERMES_HOME/plugins/<name>/` (`plugins/memory/__init__.py:1-20,41-98`); the in-`__init__.py` entry is `register(ctx)` calling `ctx.register_memory_provider(...)` **or** a top-level `MemoryProvider` subclass (`:264-285`); the active provider is selected by the **`memory.provider` config key** (`agent_init.py:999-1005`). The generic entry-point `PluginManager` **explicitly skips `memory/`** (`hermes_cli/plugins.py:819-829`) and **has no `register_memory_provider`** on its `PluginContext` (`hermes_cli/plugins.py:1073-1078`). **The pip entry-point does NOT register a memory provider.** | `hermes-plugin-packaging`, `hermes-memory-provider` |
| **R2** | **One external provider at a time** | not captured | `MemoryManager.add_provider` rejects a 2nd non-builtin provider with a warning (`agent/memory_manager.py:265-280`); only `memory.provider` selects which one. memex **cannot coexist** with honcho/mem0/hindsight/etc. | `hermes-memory-provider`, `hermes-plugin-packaging` |
| **R3** | `on_memory_write` arity + provenance | `(action, target, content)` | `(action, target, content, metadata=None)` (`agent/memory_provider.py:262-279`); manager is signature-adaptive (`:511-535`) | `hermes-memory-provider`, `hermes-engine-events`, `hermes-sync-bridge` |
| **R4** | **3 optional hooks missing** | — | `on_turn_start` (`:144`), `on_session_switch` (`:163`), `on_delegation` (`:214`). `on_session_switch` is required for sync correctness. | `hermes-memory-provider`, `hermes-engine-events` |
| **R5** | `initialize` kwargs + write suppression | `session_id, hermes_home, platform` | also `agent_context` ∈ `{primary, subagent, cron, flush}` with explicit guidance **"skip writes for non-primary contexts"** (`agent/memory_provider.py:67-81`); CLI sets `agent_context="primary"` (`agent_init.py:1013`) | `hermes-memory-provider`, `hermes-sync-bridge` |
| **R6** | `prefetch` / `queue_prefetch` / `sync_turn` signatures | `(query)` / `(query)` / `(user, assistant)` | each has a keyword-only `session_id: str = ""` (`agent/memory_provider.py:92,106,114`) | `hermes-memory-provider` |
| **R7** | `hermes_home` propagation | adapter must source it | framework **auto-injects** `hermes_home` into `initialize` kwargs (`agent/memory_manager.py:599-601`); `save_config` passes it positionally (`:245`) | `hermes-path-resolution` (clarification) |

### R1 detail — the working install shape

memex-hermes must ship as a **directory** placed at `$HERMES_HOME/plugins/memex/` containing
an `__init__.py` whose first 8192 bytes contain the string `MemoryProvider` or
`register_memory_provider` (the discovery heuristic, `plugins/memory/__init__.py:51-64`), and
the user must set `memory.provider: memex` in `$HERMES_HOME/config.yaml`. A bare
`pip install` that only registers the `hermes_agent.plugins` entry-point is **necessary but
not sufficient** — the entry-point feeds `hermes plugins list` inventory only; runtime
memory-provider activation never consults it. The packaging story therefore must **materialize
the provider directory** under `$HERMES_HOME/plugins/` (postinstall copy/symlink or an
explicit installer step), not rely on the entry-point alone.

The in-file `register(ctx)` shape from the v2 design **is still correct** — `load_memory_provider`
calls `register(ctx)` with a collector whose `register_memory_provider` captures our instance
(`plugins/memory/__init__.py:264-272,288-296`), falling back to auto-instantiating a
`MemoryProvider` subclass (`:274-283`).

---

## C. Optional runtime confirmation (not blocking)

Source has settled the contract. A live run would only add belt-and-suspenders confirmation of:

1. Exact `metadata` dict keys populated for a real built-in `remember` write (Q2).
2. `system_prompt_block()` invocation count across a session incl. resume/compress (Q4).
3. Which optional hooks fire in a vanilla CLI session (Q6) — expect `on_turn_start`,
   `sync_turn`, `initialize`, `system_prompt_block`, `shutdown`; `on_session_switch` only on
   `/resume|/branch|/reset|/new`/compression.

To run it, use the **corrected** `spike/trace_provider.py` and `spike/README.md` (registration
fixed per R1). This is the user's hands-on step (CLAUDE.md gates §2.2–§2.7 as interactive) and
is **optional** given the source grounding above.

---

## Gate status

§2 is cleared on the strength of source verification. The R1–R7 deltas are filed back into the
openspec change (§2.6) before §3+ implementation begins, per the C9/G12 gate.
