## Context

The `memex` family currently spans two adapters: `memex-claude` (Claude Code, standalone binary invoked via JSON-stdin hooks) and `memex-openclaw` (OpenClaw, in-process TypeScript plugin). Each adapter implements the host's plugin contract while delegating embedding/index/cache/sync work to the shared engine `@jim80net/memex-core`. Cross-platform sync (knowledge authored in one harness reaching the others) is the defining property of the family and depends on byte-identical on-disk format across adapters.

Hermes Agent (NousResearch) is a Python-based agent runtime with a documented plugin system (`~/.hermes/plugins/<name>/` with `register(ctx)`) and a first-class `MemoryProvider` ABC (`agent/memory_provider.py`) that peer providers like Honcho, Mem0, RetainDB, and Hindsight integrate against. Hermes has its own built-in memory layer (`MEMORY.md` / `USER.md` auto-injected at session start) and its own skills system (`~/.hermes/skills/` with progressive disclosure). It does not currently participate in memex sync.

This change introduces a new repository, `memex-hermes`, that bridges Hermes into the memex family without re-implementing the engine. The full pre-implementation design lives at `docs/specs/2026-05-25-memex-hermes-adapter-design.md` (v2, post-systems-review with findings F1–F12 applied inline). This openspec design summarizes the architecturally-load-bearing decisions; the deltas captured under `specs/` codify the testable requirements that result from them.

## Goals / Non-Goals

**Goals:**

- Make memex available to Hermes users as a `MemoryProvider` subclass with no patches to Hermes itself.
- Preserve cross-platform sync by guaranteeing the on-disk format (cache, telemetry, sync-repo layout, project-ID canonicalization, embedding model + version) stays byte-identical to `memex-claude` and `memex-openclaw`.
- Share the same prebuilt `memex` binary artifact across adapters (`bun build --compile` output from `memex-claude`'s release pipeline).
- Honor Hermes' documented contracts: `sync_turn() MUST be non-blocking`, `system_prompt_block()` output is cached into the prompt prefix (frozen at session start), `save_config(values, hermes_home)` receives `hermes_home` as an argument.
- Bridge Hermes' built-in memory writes (`MEMORY.md` / `USER.md`) into the memex sync repo so a fact remembered in one harness reaches others.

**Non-Goals:**

- Re-implementing the embedding / index / cache / sync / telemetry engine in Python. memex-core stays the single source of truth.
- A long-lived helper daemon (`memex --serve`). Per-turn subprocess fork is acceptable for v1; daemon is a deferred follow-up (success criterion §14 of the design doc fast-tracks it if measured latency exceeds 200 ms).
- Replacing or competing with Hermes' built-in `MEMORY.md` / `USER.md`. We co-exist with it and mirror its writes.
- Remote memory backends (Honcho-style HTTP). memex is local-first; remote sync is git.
- Voice/multimodal-specific signals. v1 sees only the text representation that reaches `prefetch(query)`.

## Decisions

### D1 — Integrate as `MemoryProvider`, not as a generic `pre_llm_call` plugin

**Alternatives:** generic Hermes plugin registering a `pre_llm_call` hook (simpler; mirrors what memex-claude/openclaw do); `MemoryProvider` subclass (richer, peers with Honcho/Mem0).

**Choice:** `MemoryProvider`. memex *is* a memory layer; impersonating one is the correct contract. The Memory Provider lifecycle maps cleanly to memex-claude's hook surface (`prefetch` ↔ `UserPromptSubmit`, `sync_turn` ↔ `Stop`, `on_session_end` ↔ Stop's extract-learnings, `on_memory_write` ↔ MEMORY.md mirror, `system_prompt_block` ↔ `SessionStart` injection). We also gain provider-specific tools (`memex_search` / `memex_remember` / `memex_recall`) that the agent can call deliberately when implicit prefetch misses.

### D2 — Engine is the existing prebuilt binary, invoked via subprocess

**Alternatives:** (E1) Python plugin subprocess-spawns the existing `memex` binary; (E2) pure Python port of memex-core; (E3) long-lived `memex --serve` daemon over a Unix socket.

**Choice:** E1 for v1. E2 forks the canonical on-disk format and forces two implementations to stay in lockstep forever — the single biggest threat to cross-platform sync. E3 is faster but adds daemon lifecycle complexity. E1 reuses the canonical engine, guarantees format compatibility, and accepts a per-turn subprocess fork (~30–80 ms cold start, measured upper bound 200 ms in §14). E3 stays a deferred follow-up triggered only if the budget is exceeded.

### D3 — Engine dispatch reuses `HookInput.hook_event_name`; no new CLI flags

**Alternatives:** introduce a `--hermes-mode {prefetch,sync-turn,...}` CLI flag; or extend the JSON envelope's existing `hook_event_name` string with `Hermes.*` values.

**Choice:** Extend `hook_event_name`. `memex-core/src/types.ts:94` already defines it as a string; `memex-claude/src/main.ts` already dispatches on it. Introducing a CLI flag would fork the argument-parsing surface across adapters and force the binary to maintain two dispatch conventions forever. Single dispatch surface keeps the engine simple. (Systems-review finding F3.)

### D4 — All binary invocations run off the agent's event loop

**Alternatives:** synchronous `subprocess.run` from the `def`-method body; `asyncio.create_subprocess_exec` with `await`; `asyncio.to_thread()` wrapping; dedicated daemon thread.

**Choice:** `asyncio.to_thread()` for one-shot awaited calls (`prefetch`, `is_available`, `system_prompt_block`, `handle_tool_call`); daemon thread with bounded queue for fire-and-forget calls (`sync_turn`, `queue_prefetch`, `on_memory_write`). Hermes docs explicitly mandate `sync_turn() MUST be non-blocking`; a subprocess fork from a synchronous `def` method blocks the agent loop for the duration of the fork. (Systems-review finding F2.)

### D5 — `system_prompt_block()` returns a static, session-lifetime string

**Alternatives:** dynamic per-turn content (treat it like `prefetch`); static session-lifetime content; empty string.

**Choice:** Static, session-lifetime. Hermes' prompt-assembly docs state local memory and user profile data are "injected as frozen snapshots at session start" and explicitly cached into the prompt prefix to keep it stable for prompt caching. Dynamic content in `system_prompt_block` would burn cache on every turn. All dynamic per-turn injection happens via `prefetch()` instead. (Systems-review finding F1.)

### D6 — Rules live in `$HERMES_HOME/skills/<name>/SKILL.md` with `type: rule` frontmatter

**Alternatives:** introduce a new `$HERMES_HOME/rules/` directory; reuse `$HERMES_HOME/skills/` with frontmatter type discrimination.

**Choice:** Reuse skills directory. Hermes' Skills UI/CLI/Hub surface the `skills/` dir; inventing `rules/` would create a foreign directory that doesn't appear in `hermes skills` listings or SkillsHub. memex-core already discriminates entries by frontmatter `type:` field. Cleaner host integration with no new on-disk convention to teach users. (Systems-review finding F4.)

### D7 — `_session/<id>` fallback project IDs are local-cache-only

**Alternatives:** push them like any other project; suppress sync only when explicitly opted out; suppress sync unconditionally.

**Choice:** Unconditional sync-suppression for `_session/*` IDs (overrides `sync.enabled = true`). Hermes sessions often start from no meaningful cwd (terminal home dir for casual chat, messaging-platform-spawned sessions). Without suppression, every Hermes turn that writes memory would push a fresh throwaway directory to the shared sync repo — within a week of normal use the remote accumulates hundreds of orphan dirs. Promotion to a syncable project requires an explicit `memex_remember` call with `scope: 'project'` or `'global'`. (Systems-review finding F5.)

### D8 — `$HERMES_HOME` propagates end-to-end; never hardcode `~/.hermes/`

**Alternatives:** hardcode the default; read `HERMES_HOME` once at startup; read `HERMES_HOME` every call and also accept the `hermes_home` argument passed to `save_config(values, hermes_home)`.

**Choice:** Always derive from `HERMES_HOME` (captured during `initialize(session_id, **kwargs)`, re-confirmed in `save_config`), propagated to the binary as the `MEMEX_HERMES_HOME` env var on every invocation. Hermes documents `save_config` as receiving `hermes_home` explicitly; users running `HERMES_HOME=/data/hermes hermes` would otherwise have their writes go to the wrong place. (Systems-review finding F6.)

### D9 — Verification spike before implementation: does `on_memory_write` fire for built-in MEMORY.md edits?

**Alternatives:** assume yes; assume no; verify empirically before writing the real provider.

**Choice:** Empirical verification. Write a 30-line trace-only `MemoryProvider` subclass, register it, exercise Hermes' built-in `remember` tool, observe what fires with what payload. **Two outcomes:** (a) fires → use `on_memory_write` as primary mirror trigger; (b) doesn't fire → use mtime-watcher on `$HERMES_HOME/memories/` inside `sync_turn` as primary, with `on_memory_write` retained for provider-owned writes. Both code paths are specced; the spike picks which is primary. Avoids guessing about an unproven contract. (Systems-review finding F7.)

### D10 — Sync push race recovery: rebase-retry with bounded backoff

**Alternatives:** fail-fast on non-fast-forward; retry indefinitely; bounded rebase-retry with exponential backoff.

**Choice:** Up to 3 retries (`sync.pushRetries`, configurable) with exponential backoff (200 ms / 400 ms / 800 ms). On exhaustion, the local commit stays in the branch and a warning surfaces via the Hermes logger; the next session's `initialize()`-time pull catches up. Multiple adapters on the same host (memex-claude + memex-hermes) or distinct hosts may push concurrently; without recovery, the second push fails permanently for that turn. memex-core's existing file-level conflict policy is unchanged; this addition handles git-level non-fast-forward. (Systems-review finding F9.)

## Risks / Trade-offs

- **Subprocess cold-start per turn (~30–80 ms typical, 200 ms budget cap)** → Mitigation: success criterion in §14 caps `prefetch()` round-trip at 200 ms on warm cache; if exceeded on representative hardware, the daemon-mode (E3) follow-up is fast-tracked.
- **`on_memory_write` firing semantics for built-in MEMORY.md writes are unverified** → Mitigation: pre-implementation verification spike (D9); both code paths (callback + mtime-watcher) are implemented; spike selects primary.
- **Concurrent Hermes sessions writing the same cache** → Mitigation: every cache/telemetry/session write in the engine uses `memex-core/src/file-lock.ts` `withFileLock()` (mkdir-atomic, 5 s timeout, 30 s stale recovery).
- **Cross-adapter git push races** → Mitigation: rebase-retry loop (D10) with bounded backoff.
- **Schema for `MemoryProvider.get_tool_schemas()` / `handle_tool_call()` inferred from one snippet** → Mitigation: same verification spike (D9 / F11) confirms the real argument and return shapes against `agent/memory_provider.py` source before implementation.
- **Per-host `HERMES_HOME` mismatch when binary downloaded into a per-user dir but Hermes runs as a different user** → Mitigation: binary download cache lives under `$MEMEX_HERMES_HOME/cache/memex/bin/`, derived from the runtime `HERMES_HOME`, so it stays user-scoped.
- **`_session/<id>` cache files grow without bound on long-lived hosts that spawn many short sessions** → Mitigation: doctor skill (already exists for memex-claude) gains a `--prune-sessions` flag; deferred to a v1.x change.

## Migration Plan

This is a greenfield adapter; nothing to migrate. Three external impact points to manage:

1. **`@jim80net/memex-core`**: no changes required for v1. The `Hermes.*` switch cases live in this repo's `src/main.ts`. Once stable, `src/core/hermes-paths.ts` and the `Hermes.*` handlers will be upstreamed into `memex-core` (the same evolution path `memex-claude` took). No breaking changes to core types or APIs.
2. **GitHub release pipeline**: this repo's CI will pin to specific `memex-core` binary releases and verify their SHA256s. No new artifacts published from `memex-core`; we consume what `memex-claude`'s release pipeline already ships.
3. **PyPI registration**: `memex-hermes` is a new package name; reserve it before first release. Use `pyproject.toml` entry point `hermes_agent.plugins` per Hermes' documented plugin discovery.

Rollback: uninstall via `pip uninstall memex-hermes` or `hermes plugins disable memex` — fully reversible; no state outside `$HERMES_HOME/cache/memex/` and the optional sync repo.

## Open Questions

1. **Whether to extend `memex-core` directly with `hermes-paths.ts` or keep it in this repo's `src/`** — chosen: this repo's `src/`, upstream once stable.
2. **Whether `memex_remember` should also append to Hermes' `MEMORY.md`** for front-of-context visibility — chosen: no, agent decides via which tool it calls.
3. **Sleep schedule integration with Hermes' cron system** — deferred to v1.1; v1 documents that users run the bundled `/sleep` and `/deep-sleep` skills manually.
4. **Voice/multimodal turn handling** — deferred to v1.x; v1 sees only the text query handed to `prefetch()`.
5. **Tool namespace collision behavior** — documented (first-registered wins per Hermes plugin docs); no runtime resolution in v1.

## Reference

Full design (sections 1–14 with diagrams, layered responsibilities, scan-source tables, conflict handling, failure modes, concurrency invariants, test plan, repo layout, success criteria): `docs/specs/2026-05-25-memex-hermes-adapter-design.md`.
