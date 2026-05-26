## 1. Repository scaffolding

- [x] 1.1 Add `pyproject.toml` with `memex-hermes` package metadata, Python ≥ 3.10, dev dependencies (pytest, pyyaml, jsonschema), and `[project.entry-points."hermes_agent.plugins"]` entry `memex = "memex_hermes"` (NOTE per R1: this entry-point is inventory-only for `hermes plugins list`; it does NOT activate a memory provider — activation requires the provider dir at `$HERMES_HOME/plugins/memex/` + `memory.provider: memex` config. See §9.6.)
- [x] 1.2 Add `package.json` with `@jim80net/memex-core` as a published dependency, TypeScript devDeps (tsc, vitest, biome), and scripts `build`, `test`, `typecheck`
- [x] 1.3 Add `tsconfig.json` (extending the same shape used in `memex-claude` / `memex-openclaw`)
- [x] 1.4 Add `biome.json` config matching `memex-openclaw`
- [x] 1.5 Add `vitest.config.ts` and `pytest.ini` (pytest config inlined in `pyproject.toml`'s `[tool.pytest.ini_options]`)
- [x] 1.6 Add `plugin.yaml` declaring `name: memex`, `version`, `description`, `provides_hooks`, and provider metadata per Hermes' Build-a-Hermes-Plugin guide
- [x] 1.7 Add `LICENSE` (MIT, matching the family), `CONTRIBUTING.md` (dev setup), and `README.md` (user-facing intro mirroring `memex-claude` tone)
- [x] 1.8 Add `CLAUDE.md` documenting the project's architecture, conventions, and the dual Python/TypeScript layering for AI dev assistance

## 2. Pre-implementation verification spike (D9 / F7 / F11) — **GATES §3-§8** — CLEARED (source-grounded 2026-05-26)

Resolved by reading the Hermes v0.14.0 source directly (an editable install was available on the resume host); source is the gold standard over the docs-based v2 assumptions. The runtime trace is now an optional confirmation. See `spike/SPIKE-COMPLETE.md`.

- [x] 2.1 Write `spike/trace_provider.py` — a one-file `MemoryProvider` subclass that prints every callback invocation with its name and full argument list (corrected to the real ABC: keyword-only `session_id`, `metadata` on `on_memory_write`, `str` return on `on_pre_compress`, `list` return on `get_config_schema`, new `on_turn_start`/`on_session_switch`/`on_delegation` hooks; registration via `memory.provider` config key)
- [x] 2.2 Install path corrected: memory providers load via the `plugins/memory` dir-scan of `$HERMES_HOME/plugins/<name>/` + `memory.provider` config key, NOT `hermes plugins enable`. Runtime run is optional (`spike/README.md`); the contract is settled from source.
- [x] 2.3 Callback firing semantics captured from source: built-in `remember` → `MemoryManager.on_memory_write` → external providers (`agent/tool_executor.py:642`; `agent/memory_manager.py:537-565`). `sync_turn` gets raw strings + keyword `session_id`. New hooks enumerated.
- [x] 2.4 Return-type expectations captured by reading `agent/memory_provider.py`: `get_tool_schemas() -> List[Dict]`, `handle_tool_call(tool_name, args, **kwargs) -> str`, `get_config_schema() -> List[Dict]`, `on_pre_compress() -> str`.
- [x] 2.5 `docs/specs/2026-05-25-memex-hermes-adapter-design.md` §8.4 updated: `on_memory_write` is primary (confirmed to fire), mtime-watcher secondary; R1–R7 summarized. §9 install + C3 corrected.
- [x] 2.6 Contract divergences R1–R7 filed back into the openspec change: amended `hermes-plugin-packaging`, `hermes-memory-provider`, `hermes-engine-events`, `hermes-sync-bridge`, `hermes-path-resolution`, `proposal.md`, `design.md`. Re-validated. systems-review on the diff pending (§14-style gate at this checkpoint).
- [x] 2.7 `spike/SPIKE-COMPLETE.md` committed summarizing findings; this file's presence is the gate for §3 onward. (Per G12 from the openspec systems-review.)

## 3. TypeScript engine extension — paths and configuration

**Blocked by: §2. Do not start §3 until `spike/SPIKE-COMPLETE.md` exists.**

## 3. TypeScript engine extension — paths and configuration

- [ ] 3.1 Implement `src/core/hermes-paths.ts` reading `MEMEX_HERMES_HOME` env var and resolving the documented paths (`skills/`, `memories/`, `cache/memex/`, `memex.json`, `config.yaml`)
- [ ] 3.2 Implement `src/core/config.ts` that loads `$MEMEX_HERMES_HOME/memex.json`, merges with defaults, and exposes the `prefetch`, `tools`, `sync`, `sessionEnd`, `mirrorHermesMemory` config sections matching the design §7 schema
- [ ] 3.3 Implement `src/core/session.ts` (file-based session-tracker mirroring `memex-claude/src/core/session.ts`)
- [ ] 3.4 Implement YAML parsing helper for `$HERMES_HOME/config.yaml` `external_dirs` extraction with `~` and `${VAR}` expansion

## 4. TypeScript engine extension — Hermes.* event handlers

**Blocked by: §2.**

- [ ] 4.1 Extend `src/main.ts` `switch (input.hook_event_name)` with `Hermes.health`, `Hermes.init`, `Hermes.shutdown`, `Hermes.queue-prefetch`, `Hermes.pre-compress`, and `Hermes.session-switch` (re-scopes the session/project-ID tracker; per R4)
- [ ] 4.2 Implement `src/hooks/prefetch.ts` (`Hermes.prefetch`) reusing `memex-claude`'s user-prompt disclosure logic via memex-core APIs
- [ ] 4.3 Implement `src/hooks/sync-turn.ts` (`Hermes.sync-turn`) with telemetry append + memory mtime tracker
- [ ] 4.4 Implement `src/hooks/session-end.ts` (`Hermes.session-end`) extracting learnings via an **explicitly configured** `extractionModel` (with API key/base URL in config). The "use Hermes' active model" fallback path is deferred to v1.x; v1 requires explicit configuration. (Per G17 from the openspec systems-review.)
- [ ] 4.5 Implement `src/hooks/pre-compress.ts` (`Hermes.pre-compress`)
- [ ] 4.6 Implement `src/hooks/memory-write.ts` (`Hermes.memory-write`) writing the mirror file and committing
- [ ] 4.7 Implement `src/hooks/system-prompt.ts` (`Hermes.system-prompt`) returning static session-lifetime content (tool inventory + sync state)
- [ ] 4.8 Implement `src/hooks/tool.ts` dispatching `Hermes.tool-search`, `Hermes.tool-remember`, `Hermes.tool-recall`
- [ ] 4.9 Wire all writes (cache, telemetry, sessions, registry, mtime tracker) through `withFileLock()` from memex-core
- [ ] 4.10 Wire git push retry-with-rebase (`sync.pushRetries`, default 3, exponential backoff 200/400/800 ms). **Implementation lives in this repo's `src/hooks/` wrapping memex-core's existing push primitive; do NOT modify memex-core for v1.** (Per G14.)
- [ ] 4.11 Wire `_session/*` project-ID push suppression (D7). **Implementation lives in this repo's `src/hooks/sync-turn.ts` (and related call sites); do NOT modify memex-core for v1.** (Per G15.)
- [ ] 4.12 Implement both mirror paths for MEMORY.md/USER.md edits: the `Hermes.memory-write` handler (callback path, primary for `add`/`replace`) AND the mtime-watcher inside `Hermes.sync-turn` (mandatory path — captures built-in `remove`, which does NOT fire the callback, plus out-of-band writes, by re-mirroring full file content). Source-resolved per §2.5; both ship. (Per G19.)

## 5. TypeScript engine extension — tests

- [ ] 5.1 Vitest tests for `src/hooks/prefetch.ts` covering rule first-match-then-reminder, threshold filtering, top-K capping
- [ ] 5.2 Vitest tests for `src/hooks/sync-turn.ts` covering mtime detection (changed and unchanged paths)
- [ ] 5.3 Vitest tests for `src/hooks/memory-write.ts` covering successful mirror + commit and failure logging
- [ ] 5.4 Vitest tests for `_session/*` push suppression (D7)
- [ ] 5.5 Vitest tests for tool dispatch: `Hermes.tool-search` / `tool-remember` / `tool-recall` return shapes
- [ ] 5.6 Concurrency test spawning two binaries writing to the same cache JSON; assert no corruption and at most 3 push retries (F8/F9)
- [ ] 5.7 Type-check passes with `tsc --noEmit`; lint passes with `biome check src/`
- [ ] 5.8 Vitest test for `Hermes.session-switch` re-scoping the session/project-ID tracker (R4) and for `Hermes.memory-write` honoring non-primary `metadata.execution_context` suppression (R5)

## 6. Python plugin — paths and configuration

**Blocked by: §2.**

- [ ] 6.1 Implement `memex_hermes/paths.py` resolving `$HERMES_HOME` from env or `save_config` argument; parsing `config.yaml` for `external_dirs`; refusing to hardcode `~/.hermes/`
- [ ] 6.2 Implement `memex_hermes/config.py` loading `$HERMES_HOME/memex.json`, merging defaults, producing a JSON Schema for `get_config_schema()`
- [ ] 6.3 Implement `memex_hermes/runner.py` with two surfaces: `await_subprocess(event_name, payload)` (via `asyncio.to_thread`) and `fire_and_forget(event_name, payload)` (via a daemon thread + bounded queue). **Depends on §4 envelope decisions being settled; defer if §4.1 is in flight.** (Per G16.)
- [ ] 6.4 Implement timeout, exit-code, and JSON-parse error handling that returns safe defaults (empty string for prefetch, False for is_available, error JSON for tool calls)

## 7. Python plugin — MemexProvider

**Blocked by: §2 (and §6 for runner.py).**

- [ ] 7.1 Implement `memex_hermes/__init__.py` with `register(ctx)` calling `ctx.register_memory_provider(MemexProvider())`. The file's first 8192 bytes MUST contain `MemoryProvider` or `register_memory_provider` for the discovery heuristic (`plugins/memory/__init__.py:51-64`). At install time this file lands at `$HERMES_HOME/plugins/memex/__init__.py` (see §9.6).
- [ ] 7.2a Implement provider **lifecycle**: `name`, `is_available`, `initialize` (capture `session_id`, `hermes_home`, and `agent_context`; tolerate extra kwargs), `system_prompt_block` (static-cached after first call), `shutdown` (with bounded drain per the `hermes-memory-provider` shutdown Requirement)
- [ ] 7.2b Implement provider **runtime dispatch** with verified signatures: `prefetch(query, *, session_id="")`, `queue_prefetch(query, *, session_id="")`, `sync_turn(user_content, assistant_content, *, session_id="")` (non-blocking via daemon thread), `handle_tool_call(tool_name, args, **kwargs)` (with all three tool routes), `get_tool_schemas`
- [ ] 7.2c Implement provider **write & end-of-life**: `on_session_end`, `on_pre_compress` (returns `str`), `on_memory_write(action, target, content, metadata=None)` (forward `metadata`; map `target` "memory"/"user" → MEMORY.md/USER.md), `get_config_schema` (returns `list`), `save_config(values, hermes_home)` (using the `hermes_home` argument, never hardcoded)
- [ ] 7.2d Implement **optional hooks** (R4): `on_session_switch` (refresh cached `session_id`/project scope; flush per-session buffers when `reset=True`) → `Hermes.session-switch`; `on_turn_start` and `on_delegation` as no-op/log-only (must not raise, must not invoke the binary in v1)
- [ ] 7.2e Implement **agent_context write suppression** (R5): when `agent_context` is `subagent`/`cron`/`flush` (or `on_memory_write` metadata provenance indicates non-primary), suppress `sync_turn`/`on_memory_write`/`on_session_end` writes; keep read paths active
- [ ] 7.3 Implement `memex_hermes/tools.py` with the three tool schemas (`memex_search` / `memex_remember` / `memex_recall`) and their dispatch into `Hermes.tool-*` events
- [ ] 7.4 Ensure every binary invocation passes `MEMEX_HERMES_HOME` as an env var
- [ ] 7.5 Ensure no method propagates an exception that would crash the Hermes session

## 8. Python plugin — tests

**Blocked by: §2.**

- [ ] 8.1 pytest tests for `provider.py` with `runner` mocked to assert correct JSON envelopes per method
- [ ] 8.2 pytest tests for `paths.py` with tmp `$HERMES_HOME` fixtures (custom dir, malformed yaml, missing config.yaml)
- [ ] 8.2.1 pytest tests for `paths.py` enforcing the no-hardcoded-`~/.hermes/` invariant (grep test plus runtime assertion under a redirected HERMES_HOME)
- [ ] 8.3 pytest tests for `config.py` round-tripping the merge against defaults and validating the JSON Schema
- [ ] 8.4 pytest tests for `tools.py` validating tool-schema shape conforms to `name/description/parameters` dict
- [ ] 8.5 pytest test for non-blocking `sync_turn`: assert calling task suspends for < 5 ms even when the subprocess is mocked to sleep 500 ms
- [ ] 8.6 pytest test for daemon-thread queue overflow: drop oldest entry and log
- [ ] 8.7 pytest test for `shutdown` drain: pending daemon work completes within 5s bound; over-bound work is canceled with a warning (per the `hermes-memory-provider` shutdown Requirement)
- [ ] 8.8 pytest test for **method → event dispatch invariant**: parametrized test asserting each provider method invokes the documented `hook_event_name` with a stub runner; methods that should not invoke the binary (`name`, `get_tool_schemas`, `get_config_schema`, `save_config`) produce no recorded calls. (Per G3.)
- [ ] 8.9 pytest test for **no-Python-engine invariant**: grep-style CI rule asserting `memex_hermes/` (excluding `test/` and `spike/`) contains no imports of `transformers`, `onnxruntime`, `sentence_transformers`, and no subprocess argv starting with `git`. (Per G1.)
- [ ] 8.11 pytest test for **ABC signature conformance** (R3/R6): assert `MemexProvider` accepts the manager's keyword-style calls (`prefetch(q, session_id=...)`, `sync_turn(u, a, session_id=...)`, `on_memory_write(a, t, c, metadata={...})`) without `TypeError`; assert `on_pre_compress` returns `str` and `get_config_schema` returns `list`.
- [ ] 8.12 pytest test for **optional hooks** (R4): `on_session_switch` re-scopes session/project; `reset=True` flushes buffers; `on_turn_start`/`on_delegation` are no-ops that never raise and never invoke the binary.
- [ ] 8.13 pytest test for **agent_context suppression** (R5): `agent_context` in {`subagent`,`cron`,`flush`} suppresses `sync_turn`/`on_memory_write` writes; `primary` writes normally.
- [ ] 8.10 Type-check passes via `mypy --strict memex_hermes/`. Per `~/.claude/rules/strict-typing-python.md`: no bare `dict`; use `TypedDict` for kwargs/JSON shapes and Pydantic `BaseModel` for boundary data; `Any` only at Hermes ABC inputs, narrowed via typed adapter immediately. `spike/` is exempt.

## 9. Distribution — binary download and packaging

- [ ] 9.1 Implement `bin/memex` Python entry script that locates the cached binary, downloads it on first run, verifies SHA256, and execs it
- [ ] 9.2 Add `bin/install.sh` for the manual-clone install path (mirrors `memex-claude/bin/install.sh`)
- [ ] 9.3 Bundle `checksums.txt` in the wheel keyed by `(platform, arch)` for each supported binary release
- [ ] 9.4 Wire `pyproject.toml` to include `bin/`, `skills/`, `plugin.yaml`, and `memex_hermes/` in the distribution
- [ ] 9.5 Document the pinned upstream `memex-claude` binary release version in `pyproject.toml` (or a sibling `binary_release.json`)
- [ ] 9.6 Implement the **provider-dir materialize step** (R1): a console-script / `python -m memex_hermes.install` that copies or symlinks the provider package into `$HERMES_HOME/plugins/memex/` (so the dir-scan discovery finds it) and prints the `memory.provider: memex` config instruction. Pip install alone does NOT activate the provider.

## 10. Bundled skills

- [ ] 10.1 Port `skills/sleep/SKILL.md` from `memex-claude` and adapt MEMORY.md references for Hermes
- [ ] 10.2 Port `skills/deep-sleep/SKILL.md` and adapt
- [ ] 10.3 Port `skills/doctor/SKILL.md` and adapt for the Hermes install paths and binary location
- [ ] 10.4 Port `skills/handoff/SKILL.md` and adapt for Hermes session terminology

## 11. Integration tests

- [ ] 11.1 Build a dockerized Hermes + memex-hermes integration harness in `test/e2e/` gated behind `MEMEX_E2E=1`
- [ ] 11.2 E2E: skill authored under `$HERMES_HOME/skills/foo/SKILL.md` is matched and surfaced for a relevant prompt
- [ ] 11.3 E2E: `memex_remember` from a Hermes session is visible to a `memex-claude` session against the same sync repo within one sync cycle
- [ ] 11.4 E2E: built-in `remember` tool write to `MEMORY.md` is mirrored to the sync repo via the primary path chosen in 2.5
- [ ] 11.5 E2E: clean-machine first-run downloads the ONNX model and completes `prefetch` within 10 seconds
- [ ] 11.6 E2E: binary failure (renamed away) does not crash the Hermes session
- [ ] 11.7 E2E: `HERMES_HOME=/tmp/custom` is honored end-to-end (no writes outside that root)

## 12. CI and release plumbing

- [ ] 12.1 GitHub Actions workflow: install pnpm + pip deps, run `pnpm typecheck`, `pnpm test`, `pytest`, `biome check`
- [ ] 12.2 GitHub Actions workflow: integration smoke (one E2E scenario) on Linux runner
- [ ] 12.3 Release-please config for the Python package version (mirrors `memex-claude` setup); PyPI publish on tag
- [ ] 12.4 Per-PR cubic review enabled (already configured at repo level)

## 13. Documentation

- [ ] 13.1 README.md: explain what memex-hermes is, install paths, quickstart, link to `docs/specs/2026-05-25-memex-hermes-adapter-design.md`
- [ ] 13.2 CONTRIBUTING.md: explain the dual Python/TypeScript layering and how to run the verification spike. **Include a "Maintenance" section requiring re-run of the spike on Hermes major/minor upgrades and update of `spike/<version>-trace.log`.** (Per G9 from the openspec systems-review — this is process, not a runtime Scenario.)
- [ ] 13.3 USAGE.md (parallels `memex-claude/USAGE.md`): full config reference, sync setup, bundled skill usage, troubleshooting
- [ ] 13.4 Update `docs/specs/...design.md` post-spike with verified findings

## 14. Verification gates (per the user's standard development flow)

- [ ] 14.1 Run `/systems-review` on the implementation diff before opening the PR; iterate to clean
- [ ] 14.2 Open the PR via `gh pr create`; reference this openspec change in the body
- [ ] 14.3 Address cubic's automated review feedback
- [ ] 14.4 Ensure all CI checks are green (typecheck, tests, lint, smoke E2E)
- [ ] 14.5 Wait for explicit user authorization before merging (per the never-auto-merge-prs rule)
- [ ] 14.6 After merge: archive this openspec change via `/opsx:archive` and run `wrap-things-up`
