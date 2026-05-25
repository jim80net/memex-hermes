## 1. Repository scaffolding

- [ ] 1.1 Add `pyproject.toml` with `memex-hermes` package metadata, Python ≥ 3.10, dev dependencies (pytest, pyyaml, jsonschema), and `[project.entry-points."hermes_agent.plugins"]` entry `memex = "memex_hermes"`
- [ ] 1.2 Add `package.json` with `@jim80net/memex-core` as a published dependency, TypeScript devDeps (tsc, vitest, biome), and scripts `build`, `test`, `typecheck`
- [ ] 1.3 Add `tsconfig.json` (extending the same shape used in `memex-claude` / `memex-openclaw`)
- [ ] 1.4 Add `biome.json` config matching `memex-openclaw`
- [ ] 1.5 Add `vitest.config.ts` and `pytest.ini`
- [ ] 1.6 Add `plugin.yaml` declaring `name: memex`, `version`, `description`, `provides_hooks`, and provider metadata per Hermes' Build-a-Hermes-Plugin guide
- [ ] 1.7 Add `LICENSE` (MIT, matching the family), `CONTRIBUTING.md` (dev setup), and `README.md` (user-facing intro mirroring `memex-claude` tone)
- [ ] 1.8 Add `CLAUDE.md` documenting the project's architecture, conventions, and the dual Python/TypeScript layering for AI dev assistance

## 2. Pre-implementation verification spike (D9 / F7 / F11)

- [ ] 2.1 Write `spike/trace_provider.py` — a one-file `MemoryProvider` subclass that prints every callback invocation with its name and full argument list
- [ ] 2.2 Install the spike as a Hermes plugin in a scratch `$HERMES_HOME` and enable it
- [ ] 2.3 Exercise the built-in `remember` tool, a normal turn, a session end, and a compression; capture which callbacks fire with which payloads
- [ ] 2.4 Capture the exact return-type expectations for `get_tool_schemas()` and `handle_tool_call()` by inspecting `agent/memory_provider.py` (read the Python source if open; otherwise infer from trace output)
- [ ] 2.5 Update `docs/specs/2026-05-25-memex-hermes-adapter-design.md` §8.4 with the chosen primary path (`on_memory_write` vs mtime-watcher) and any contract refinements
- [ ] 2.6 If any contract diverges from the v2 design assumptions, file deltas back into the openspec change (update affected `specs/*/spec.md` and re-run systems-review)

## 3. TypeScript engine extension — paths and configuration

- [ ] 3.1 Implement `src/core/hermes-paths.ts` reading `MEMEX_HERMES_HOME` env var and resolving the documented paths (`skills/`, `memories/`, `cache/memex/`, `memex.json`, `config.yaml`)
- [ ] 3.2 Implement `src/core/config.ts` that loads `$MEMEX_HERMES_HOME/memex.json`, merges with defaults, and exposes the `prefetch`, `tools`, `sync`, `sessionEnd`, `mirrorHermesMemory` config sections matching the design §7 schema
- [ ] 3.3 Implement `src/core/session.ts` (file-based session-tracker mirroring `memex-claude/src/core/session.ts`)
- [ ] 3.4 Implement YAML parsing helper for `$HERMES_HOME/config.yaml` `external_dirs` extraction with `~` and `${VAR}` expansion

## 4. TypeScript engine extension — Hermes.* event handlers

- [ ] 4.1 Extend `src/main.ts` `switch (input.hook_event_name)` with `Hermes.health`, `Hermes.init`, `Hermes.shutdown`
- [ ] 4.2 Implement `src/hooks/prefetch.ts` (`Hermes.prefetch`) reusing `memex-claude`'s user-prompt disclosure logic via memex-core APIs
- [ ] 4.3 Implement `src/hooks/sync-turn.ts` (`Hermes.sync-turn`) with telemetry append + memory mtime tracker
- [ ] 4.4 Implement `src/hooks/session-end.ts` (`Hermes.session-end`) extracting learnings via the configured model
- [ ] 4.5 Implement `src/hooks/pre-compress.ts` (`Hermes.pre-compress`)
- [ ] 4.6 Implement `src/hooks/memory-write.ts` (`Hermes.memory-write`) writing the mirror file and committing
- [ ] 4.7 Implement `src/hooks/system-prompt.ts` (`Hermes.system-prompt`) returning static session-lifetime content (tool inventory + sync state)
- [ ] 4.8 Implement `src/hooks/tool.ts` dispatching `Hermes.tool-search`, `Hermes.tool-remember`, `Hermes.tool-recall`
- [ ] 4.9 Wire all writes (cache, telemetry, sessions, registry, mtime tracker) through `withFileLock()` from memex-core
- [ ] 4.10 Wire git push retry-with-rebase (`sync.pushRetries`, default 3, exponential backoff 200/400/800 ms)
- [ ] 4.11 Wire `_session/*` project-ID push suppression (D7)

## 5. TypeScript engine extension — tests

- [ ] 5.1 Vitest tests for `src/hooks/prefetch.ts` covering rule first-match-then-reminder, threshold filtering, top-K capping
- [ ] 5.2 Vitest tests for `src/hooks/sync-turn.ts` covering mtime detection (changed and unchanged paths)
- [ ] 5.3 Vitest tests for `src/hooks/memory-write.ts` covering successful mirror + commit and failure logging
- [ ] 5.4 Vitest tests for `_session/*` push suppression (D7)
- [ ] 5.5 Vitest tests for tool dispatch: `Hermes.tool-search` / `tool-remember` / `tool-recall` return shapes
- [ ] 5.6 Concurrency test spawning two binaries writing to the same cache JSON; assert no corruption and at most 3 push retries (F8/F9)
- [ ] 5.7 Type-check passes with `tsc --noEmit`; lint passes with `biome check src/`

## 6. Python plugin — paths and configuration

- [ ] 6.1 Implement `memex_hermes/paths.py` resolving `$HERMES_HOME` from env or `save_config` argument; parsing `config.yaml` for `external_dirs`; refusing to hardcode `~/.hermes/`
- [ ] 6.2 Implement `memex_hermes/config.py` loading `$HERMES_HOME/memex.json`, merging defaults, producing a JSON Schema for `get_config_schema()`
- [ ] 6.3 Implement `memex_hermes/runner.py` with two surfaces: `await_subprocess(event_name, payload)` (via `asyncio.to_thread`) and `fire_and_forget(event_name, payload)` (via a daemon thread + bounded queue)
- [ ] 6.4 Implement timeout, exit-code, and JSON-parse error handling that returns safe defaults (empty string for prefetch, False for is_available, error JSON for tool calls)

## 7. Python plugin — MemexProvider

- [ ] 7.1 Implement `memex_hermes/__init__.py` with `register(ctx)` calling `ctx.register_memory_provider(MemexProvider())`
- [ ] 7.2 Implement `memex_hermes/provider.py` `MemexProvider(MemoryProvider)` with: `name`, `is_available`, `initialize`, `system_prompt_block` (static, cached after first call), `prefetch`, `queue_prefetch`, `sync_turn`, `on_session_end`, `on_pre_compress`, `on_memory_write`, `shutdown`, `get_tool_schemas`, `handle_tool_call`, `get_config_schema`, `save_config`
- [ ] 7.3 Implement `memex_hermes/tools.py` with the three tool schemas (`memex_search` / `memex_remember` / `memex_recall`) and their dispatch into `Hermes.tool-*` events
- [ ] 7.4 Ensure `save_config(values, hermes_home)` writes to `<hermes_home>/memex.json` using the argument, not a hardcoded path
- [ ] 7.5 Ensure every binary invocation passes `MEMEX_HERMES_HOME` as an env var
- [ ] 7.6 Ensure no method propagates an exception that would crash the Hermes session

## 8. Python plugin — tests

- [ ] 8.1 pytest tests for `provider.py` with `runner` mocked to assert correct JSON envelopes per method
- [ ] 8.2 pytest tests for `paths.py` with tmp `$HERMES_HOME` fixtures (custom dir, malformed yaml, missing config.yaml)
- [ ] 8.2.1 pytest tests for `paths.py` enforcing the no-hardcoded-`~/.hermes/` invariant (grep test plus runtime assertion under a redirected HERMES_HOME)
- [ ] 8.3 pytest tests for `config.py` round-tripping the merge against defaults and validating the JSON Schema
- [ ] 8.4 pytest tests for `tools.py` validating tool-schema shape conforms to `name/description/parameters` dict
- [ ] 8.5 pytest test for non-blocking `sync_turn`: assert calling task suspends for < 5 ms even when the subprocess is mocked to sleep 500 ms
- [ ] 8.6 pytest test for daemon-thread queue overflow: drop oldest entry and log
- [ ] 8.7 Type-check passes via `mypy memex_hermes/` (strict mode where feasible)

## 9. Distribution — binary download and packaging

- [ ] 9.1 Implement `bin/memex` Python entry script that locates the cached binary, downloads it on first run, verifies SHA256, and execs it
- [ ] 9.2 Add `bin/install.sh` for the manual-clone install path (mirrors `memex-claude/bin/install.sh`)
- [ ] 9.3 Bundle `checksums.txt` in the wheel keyed by `(platform, arch)` for each supported binary release
- [ ] 9.4 Wire `pyproject.toml` to include `bin/`, `skills/`, `plugin.yaml`, and `memex_hermes/` in the distribution
- [ ] 9.5 Document the pinned upstream `memex-claude` binary release version in `pyproject.toml` (or a sibling `binary_release.json`)

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
- [ ] 13.2 CONTRIBUTING.md: explain the dual Python/TypeScript layering and how to run the verification spike
- [ ] 13.3 USAGE.md (parallels `memex-claude/USAGE.md`): full config reference, sync setup, bundled skill usage, troubleshooting
- [ ] 13.4 Update `docs/specs/...design.md` post-spike with verified findings

## 14. Verification gates (per the user's standard development flow)

- [ ] 14.1 Run `/systems-review` on the implementation diff before opening the PR; iterate to clean
- [ ] 14.2 Open the PR via `gh pr create`; reference this openspec change in the body
- [ ] 14.3 Address cubic's automated review feedback
- [ ] 14.4 Ensure all CI checks are green (typecheck, tests, lint, smoke E2E)
- [ ] 14.5 Wait for explicit user authorization before merging (per the never-auto-merge-prs rule)
- [ ] 14.6 After merge: archive this openspec change via `/opsx:archive` and run `wrap-things-up`
