# Claude Code Instructions

## Project

memex adapter for [Hermes Agent](https://hermes-agent.nousresearch.com/) by NousResearch. Sibling to [`memex-claude`](https://github.com/jim80net/memex-claude) and [`memex-openclaw`](https://github.com/jim80net/memex-openclaw). All three share the engine **library** [`@jim80net/memex-core`](https://github.com/jim80net/memex-core); each adapter ships its own bun-compiled binary.

**Cross-platform sync is the load-bearing requirement.** The on-disk cache format, telemetry schema, sync-repo layout, and project-ID canonicalization MUST stay byte-identical across all three adapters. This dictates many architectural choices documented below.

## Architecture (two source trees)

- **`memex_hermes/`** — Python package. Subclasses Hermes' `MemoryProvider` ABC. Thin shim: translates lifecycle method calls into JSON `HermesHookInput` envelopes for the `memex-hermes` binary. Runs all subprocess work off the agent's event loop (`asyncio.to_thread` for awaited calls, daemon-thread + bounded queue for fire-and-forget).
- **`src/`** — TypeScript. Implements the `Hermes.*` cases of the `hook_event_name` switch (`src/main.ts`), one handler per event in `src/hooks/`. Compiled via `bun build --compile` into this repo's OWN `memex-hermes` binary (released from `jim80net/memex-hermes`), importing `@jim80net/memex-core` as a library dep.

The Python ↔ binary boundary is a typed JSON envelope encoded in **`src/core/envelope.ts`** (TypeScript) and **`memex_hermes/envelope.py`** (Python TypedDicts). The two are mirrors of each other; drift is a contract bug caught by the type-checker on both sides.

## Key invariants

| Invariant | Where enforced |
|---|---|
| Python layer never re-implements memex-core | `test/python/test_no_engine_imports.py` (grep test) + `hermes-memory-provider` spec Requirement |
| All subprocess invocations dispatched off the Hermes event loop | `runner.py` (`asyncio.to_thread` + bounded daemon thread); `test_runner.py` + §8.5 5-ms non-blocking sync_turn test |
| `system_prompt_block()` returns static, session-lifetime content | Cached after first call in `provider.py`; `test_provider.py` |
| `HERMES_HOME` derived from initialize kwargs → save_config arg → env; never hardcoded | `paths.py`; `test_paths.py` no-hardcoded-literal grep |
| Sessions without a meaningful cwd (`_session/*` project IDs) never push to remote sync | `src/core/sync-helpers.ts:isSessionProjectId`, applied in `src/hooks/_mirror.ts` |
| Both mirror paths fire: `on_memory_write` callback (primary for add/replace) AND `sync_turn` mtime-watcher (mandatory — catches `remove` + out-of-band writes) | `src/hooks/{memory-write,sync-turn}.ts`; verified by `test/e2e/test_memory_mirror.py` |
| Writes suppressed for non-primary `agent_context` (subagent/cron/flush) and for non-primary `metadata.execution_context` | Two layers: Python provider (`provider.py:_writes_suppressed`) drops at the runner boundary; TS engine (`src/hooks/memory-write.ts`) defense-in-depth |
| Provider activation: directory at `$HERMES_HOME/plugins/memex/` + `memory.provider: memex` config — NOT the pip entry-point | `memex_hermes/install.py` materializes the dir; spec verified against Hermes v0.14.0 source |
| Only one external memory provider active at a time | Enforced by Hermes `MemoryManager.add_provider`; documented in USAGE.md |

## Critical references

- **Capability specs** (the permanent contract — Requirements + Scenarios for every behavior): `openspec/specs/{hermes-memory-provider,hermes-engine-events,hermes-path-resolution,hermes-sync-bridge,hermes-plugin-packaging,memex-tool-surface}/spec.md`
- **Archived bootstrap change** (proposal, design with D1–D10 decisions, tasks, the R1–R7 spike findings inventory): `openspec/changes/archive/bootstrap-memex-hermes-adapter/`
- **User docs**: `README.md` (intro + quickstart), `USAGE.md` (full config + tool + sync reference), `CONTRIBUTING.md` (dev setup + maintenance policy on Hermes upgrades).

## Development

```bash
# Python
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
pytest test/python           # unit tests (153+)
mypy --strict memex_hermes   # strict type-check
ruff check memex_hermes test/python

# TypeScript
pnpm install
pnpm test                    # vitest, 129+ tests
pnpm typecheck               # tsc --noEmit, strict
pnpm lint                    # biome check

# Build the binary
pnpm build                   # → dist/<platform>/memex-hermes + ONNX libs

# E2E (gated)
MEMEX_E2E=1 MEMEX_HERMES_BINARY=dist/<platform>/memex-hermes \
  pytest test/e2e -c test/e2e/pytest.ini
```

## Conventions

- No emojis in source files unless explicitly requested.
- Comments are rare and only for the non-obvious WHY. Identifiers carry the WHAT.
- Imports on top, types next, public methods, private methods last (Python and TypeScript both).
- Never auto-merge PRs (`gh pr merge` is blocked by hook). Wait for explicit user authorization.
- Never re-implement memex-core in Python. Helpers for envelope construction, schema dicts, and Hermes-side path resolution are fine; engine logic is not.
- When the Hermes contract is uncertain, source-grounding from `/home/<user>/.hermes/hermes-agent/` (when an editable install is available) is the gold standard — supersedes runtime tracing per `~/.claude/rules/verify-before-acting.md`.

## Strict Python typing (mypy --strict)

All Python code under `memex_hermes/` MUST pass `mypy --strict`. Notable rules (full text: `~/.claude/rules/strict-typing-python.md`):

1. Never `dict[]` or bare `dict` — use `TypedDict` (for kwargs/JSON shapes) or Pydantic `BaseModel` (for validated boundary data).
2. All function signatures fully typed (params + return). All class attributes typed.
3. Use `Sequence` / `Mapping` / `Collection` from `collections.abc` over concrete `list` / `dict` in parameter types.
4. `Any` is permitted ONLY when interfacing with untyped third-party APIs (e.g., Hermes' `MemoryProvider` ABC, whose runtime shapes carry kwargs of arbitrary types). Wrap `Any` in a typed adapter as soon as it crosses into our code.

## Maintenance: source-diff on Hermes upgrades

When the upstream Hermes Agent is upgraded across a minor or major version, the `MemoryProvider` ABC contract may shift. The cheapest, most authoritative check is a **source diff** against the verified Hermes v0.14.0 baseline (captured in the R1–R7 inventory under `openspec/changes/archive/bootstrap-memex-hermes-adapter/`):

1. On the upgraded host, read `agent/memory_provider.py`, `agent/memory_manager.py`, `plugins/memory/__init__.py`, and `agent/agent_init.py` from the live Hermes install.
2. Diff their signatures and dispatch wiring against the R1–R7 baseline.
3. Any change → file an OpenSpec change capturing the deltas; re-run `/systems-review` and the impacted tests.
4. The runtime trace pattern from the original spike is still available as a belt-and-suspenders confirmation; details in `CONTRIBUTING.md`.
