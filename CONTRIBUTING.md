# Contributing to memex-hermes

## Architecture overview

`memex-hermes` has **two source trees** that work together:

| Tree | Language | Lives in | Responsibility |
|---|---|---|---|
| Python plugin | Python ≥ 3.10 | `memex_hermes/` | Implements Hermes' `MemoryProvider` ABC. Translates lifecycle calls to JSON envelopes sent to the binary. Runs all subprocess work off the agent's async event loop. |
| TypeScript engine extension | TypeScript | `src/` | Implements the `Hermes.*` `hook_event_name` handlers compiled into THIS repo's own `memex-hermes` binary (`bun build --compile`, released from `jim80net/memex-hermes`). Imports `@jim80net/memex-core` as a library dep. |

The **`@jim80net/memex-core`** package is the source of truth for embedding, indexing, cache, telemetry, sync, and project-ID semantics. `memex_hermes/` MUST NOT re-implement any of those concerns. Helper modules (envelope construction, schema dicts, Hermes-side path resolution) are fine; engine logic is not. This is enforced by a CI rule (see `test/python/test_no_engine_imports.py`).

See [`docs/specs/2026-05-25-memex-hermes-adapter-design.md`](docs/specs/2026-05-25-memex-hermes-adapter-design.md) for the full design including all decisions (D1–D10) and the systems-review findings (F1–F12, G1–G19).

## Development setup

```bash
# Python side
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

# TypeScript side
pnpm install

# Run tests
pytest                  # Python
pnpm test               # TypeScript (vitest)
pnpm typecheck          # tsc --noEmit
pnpm lint               # biome
mypy memex_hermes       # Python type-check
```

## The verification spike — resolved from source (2026-05-26)

The pre-implementation verification spike was resolved by reading the Hermes v0.14.0 `MemoryProvider` source directly (an editable install was available on the resume host). Per the `verify-before-acting` rule, **source code is the gold standard** over docs and runtime tracing for contract shapes and dispatch wiring. The findings — answers to all 7 spike questions with file:line citations and seven R1–R7 divergences from the docs-based v2 design — are captured in `spike/SPIKE-COMPLETE.md` and were filed back into the openspec capability specs. `on_memory_write` is confirmed to be the primary mirror trigger for built-in `add`/`replace` writes (the built-in `memory` tool guards on `action in {"add","replace"}`, so `remove` flows through the mandatory `sync_turn` mtime-watcher).

### Maintenance: source-diff on Hermes upgrades

When the upstream Hermes Agent is upgraded across a minor or major version, the `MemoryProvider` ABC contract may shift. The cheapest, most authoritative check is a **source diff** against the verified Hermes v0.14.0 baseline encoded in R1–R7 of `spike/SPIKE-COMPLETE.md`:

1. On the upgraded host, point at the new Hermes install (default `/home/<user>/.hermes/hermes-agent/`).
2. Re-read `agent/memory_provider.py`, `agent/memory_manager.py`, `plugins/memory/__init__.py`, and `agent/agent_init.py` (the four authoritative files cited throughout `spike/SPIKE-COMPLETE.md`).
3. Diff their signatures and dispatch wiring against R1–R7. Any change → file an openspec change capturing the deltas, re-run `/systems-review` and the impacted unit/integration tests.
4. If runtime confirmation is desired (e.g., `metadata` dict keys for a real built-in write, optional-hook invocation count across a session), the corrected `spike/trace_provider.py` is still installable per `spike/README.md` against a scratch `$HERMES_HOME`.

The runtime trace is now belt-and-suspenders; the source diff is the gate.

## Working on tasks

Implementation work is structured as an OpenSpec change. See [`openspec/changes/bootstrap-memex-hermes-adapter/tasks.md`](openspec/changes/bootstrap-memex-hermes-adapter/tasks.md). Conventions:

- Tasks are grouped by source-tree concern: §3-§5 are TypeScript, §6-§8 are Python, §9-§13 are distribution/docs.
- Several groups carry an explicit `**Blocked by: §2**` marker — do not start them before the spike is cleared.
- Mark a task done by changing its `- [ ]` to `- [x]` in `tasks.md` and committing.

## Coding conventions

- **Python:** ruff for lint, **mypy in strict mode (enforced — see below)**, pytest with asyncio_mode=auto.
- **TypeScript:** biome for lint+format, strict tsconfig, vitest for tests.
- **No silent fallbacks.** Per the family-wide rule, never auto-mock or paper over an environment problem; fix the integrated environment first.
- **No emojis in source files** unless explicitly requested.
- **Comments are rare.** Only when the WHY is non-obvious (a workaround, a non-trivial invariant). Don't narrate the WHAT.

### Strict Python typing

All Python code under `memex_hermes/` MUST pass `mypy --strict`:

- **No bare `dict` or `dict[k,v]` as parameter/return types.** Use `TypedDict` for kwargs and JSON shapes; use Pydantic `BaseModel` for validated data that crosses the subprocess boundary (JSON envelopes to/from the binary, config files, tool inputs from the agent).
- **All function signatures fully typed**: parameters AND return type. No untyped `def`.
- **All class attributes typed**: use class-level annotations or Pydantic field definitions.
- **Prefer `collections.abc.{Sequence, Mapping, Collection}`** over concrete `list` / `dict` in input parameter types (covariance matters for the runner/provider boundary).
- **`Any` is allowed only at the Hermes ABC boundary** — `MemoryProvider`'s actual method signatures are partially undocumented. Where we MUST accept `Any` (e.g., the `**kwargs` to `initialize`, the `messages` to `on_session_end`, the `content` to `on_memory_write`), wrap it in a typed adapter inside the method and propagate typed values from there.

The full rule: `~/.claude/rules/strict-typing-python.md`.

**The `spike/` directory is exempt** — it's research code whose entire purpose is to discover the shapes that the strictly-typed code will later use. `spike/trace_provider.py` deliberately uses `Any` throughout. Once `spike/SPIKE-COMPLETE.md` documents the observed shapes, `memex_hermes/provider.py` encodes them as `TypedDict`s and uses strict types throughout.

## Pull requests

Follow the standard development flow:

1. Brainstorm → 2. Design spec → 3. `/systems-review` → 4. OpenSpec change → 5. `/systems-review` → 6. Plan → 7. Implement → 8. `/systems-review` on diff → 9. PR → 10. Cubic review → 11. Green CI → 12. **Wait for explicit user authorization before merging** (we never auto-merge).

## Reporting issues

[https://github.com/jim80net/memex-hermes/issues](https://github.com/jim80net/memex-hermes/issues)
