# Claude Code Instructions

## Project

memex adapter for [Hermes Agent](https://hermes-agent.nousresearch.com/) by NousResearch. Sibling to [`memex-claude`](https://github.com/jim80net/memex-claude) and [`memex-openclaw`](https://github.com/jim80net/memex-openclaw). All three share the engine [`@jim80net/memex-core`](https://github.com/jim80net/memex-core).

**Cross-platform sync is the load-bearing requirement.** The on-disk cache format, telemetry schema, sync-repo layout, and project-ID canonicalization MUST stay byte-identical across all three adapters. This dictates many architectural choices documented below.

## Architecture (two source trees)

- **`memex_hermes/`** — Python package. Subclasses Hermes' `MemoryProvider` ABC. Thin shim: translates lifecycle method calls into JSON `HookInput` envelopes for the binary. Runs all subprocess work off the agent's async event loop (`asyncio.to_thread` for awaited calls, daemon-thread + bounded queue for fire-and-forget).
- **`src/`** — TypeScript. Adds `Hermes.*` cases to the `hook_event_name` switch in `memex-core`'s binary entry point. Compiled into the `bun build --compile` artifact released by `memex-claude` (we share, we don't fork).

## Key invariants

| Invariant | Where enforced |
|---|---|
| Python layer never re-implements memex-core | `test/python/test_no_engine_imports.py` (grep test) + `hermes-memory-provider` spec Requirement |
| All subprocess invocations dispatched off the Hermes event loop | `provider.py` design; tested in `test_non_blocking.py` |
| `system_prompt_block()` returns static, session-lifetime content | Cached after first call in `provider.py`; tested |
| `HERMES_HOME` derived from env / `save_config` arg; never hardcoded | `paths.py`; CI grep test |
| Sessions without a meaningful cwd (`_session/*` project IDs) never push to remote sync | `src/hooks/sync-turn.ts` and `memory-write.ts` |
| Both mirror paths (`on_memory_write` + `sync_turn` mtime-watcher) are implemented | Spec Requirement; spike outcome picks primary |
| Engine dispatch uses `hook_event_name` strings (`Hermes.*`); no `--hermes-mode` CLI flag | `src/main.ts` switch extension |

## Critical references

- **Design doc** (sections 1–14, diagrams, scan-source tables, failure modes, concurrency invariants, success criteria): `docs/specs/2026-05-25-memex-hermes-adapter-design.md`
- **OpenSpec change** (proposal, design, 6 spec files with testable Requirements, 14 task groups): `openspec/changes/bootstrap-memex-hermes-adapter/`
- **Systems-review history**: v1 design → 12 findings (F1–F12) applied inline → v2 design; openspec change → 9 findings (G1–G19) applied inline.

## Development

```bash
# Python
pip install -e ".[dev]"
pytest                       # test/python/
mypy memex_hermes            # strict type-check
ruff check memex_hermes      # lint

# TypeScript
pnpm install
pnpm test                    # test/ts/ via vitest
pnpm typecheck               # tsc --noEmit
pnpm lint                    # biome
```

## The verification spike GATES implementation

Tasks §1 (scaffolding) and §2.1 (write `spike/trace_provider.py`) can run immediately. §2.2–§2.7 require interactively running Hermes Agent with the spike plugin installed; they are the user's hands-on responsibility. §3–§8 are explicitly blocked by §2 — do not start them until `spike/SPIKE-COMPLETE.md` exists.

## Conventions

- No emojis in source files unless explicitly requested.
- Comments are rare and only for the non-obvious WHY. Identifiers carry the WHAT.
- Imports on top, types next, public methods, private methods last (Python and TypeScript both).
- Never auto-merge PRs (`gh pr merge` is blocked by hook). Wait for explicit user authorization.
- Never re-implement memex-core in Python. Helpers for envelope construction are fine; engine logic is not.
- When a Hermes contract is unverified, prefer empirical verification (the spike pattern) over assumption.

## Strict Python typing (mypy --strict)

All Python code under `memex_hermes/` MUST pass `mypy --strict`. Notable rules (full text: `~/.claude/rules/strict-typing-python.md`):

1. Never `dict[]` or bare `dict` — use `TypedDict` (for kwargs/JSON shapes) or Pydantic `BaseModel` (for validated boundary data).
2. All function signatures fully typed (params + return). All class attributes typed.
3. Use `Sequence` / `Mapping` / `Collection` from `collections.abc` over concrete `list` / `dict` in parameter types.
4. `Any` is permitted ONLY when interfacing with untyped third-party APIs (e.g., Hermes' `MemoryProvider` ABC, whose runtime shapes are partially undocumented). Wrap `Any` in a typed adapter as soon as it crosses into our code.

**The `spike/` directory is exempt** from this rule — it is intentionally untyped because its entire purpose is to discover the shapes that the typed code will later use. `spike/trace_provider.py` uses `Any` throughout because the kwargs/payloads it receives ARE what we're trying to characterize.

Once `spike/SPIKE-COMPLETE.md` documents the observed shapes, `memex_hermes/provider.py` MUST encode them as `TypedDict`s (or Pydantic models for inputs that cross the subprocess boundary) and use strict types throughout.
