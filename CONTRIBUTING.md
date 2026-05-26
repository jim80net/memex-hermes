# Contributing to memex-hermes

## Architecture overview

`memex-hermes` has **two source trees** that work together:

| Tree | Language | Lives in | Responsibility |
|---|---|---|---|
| Python plugin | Python ≥ 3.10 | `memex_hermes/` | Implements Hermes' `MemoryProvider` ABC. Translates lifecycle calls to JSON envelopes sent to the binary. Runs all subprocess work off the agent's async event loop. |
| TypeScript engine extension | TypeScript | `src/` | Implements the `Hermes.*` `hook_event_name` handlers that ride on the shared `memex` binary. Bundled into the `bun build --compile` artifact released by `memex-claude`. |

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

## The verification spike

**Before any implementation work on `memex_hermes/provider.py` begins**, the pre-implementation verification spike (`openspec/changes/bootstrap-memex-hermes-adapter/tasks.md` §2) MUST complete. The spike runs `spike/trace_provider.py` against a live Hermes session to confirm which `MemoryProvider` callbacks actually fire for built-in `MEMORY.md` writes — a contract that the public Hermes docs leave ambiguous. The spike output drives whether `on_memory_write` is the primary mirror trigger or whether the mtime-watcher inside `sync_turn` is.

Findings are recorded in `docs/specs/2026-05-25-memex-hermes-adapter-design.md` §8.4 and a `spike/SPIKE-COMPLETE.md` file is committed as the visible gate.

### Maintenance: re-run the spike on Hermes upgrades

When the upstream Hermes Agent is upgraded across a minor or major version (e.g., 1.4 → 1.5, 1.x → 2.0), the `MemoryProvider` contract may change. Before declaring memex-hermes compatible with the new version:

1. Re-run `spike/trace_provider.py` against the new Hermes
2. Commit the trace output as `spike/<version>-trace.log`
3. Update `docs/specs/2026-05-25-memex-hermes-adapter-design.md` §8.4 if any contract behavior changed
4. If contract changes ripple into `openspec/changes/...`, file an openspec change capturing the deltas and re-run `/systems-review`

CI's `pre-merge-check` enforces this: PRs that bump the supported Hermes version range without a corresponding `spike/<version>-trace.log` are rejected.

## Working on tasks

Implementation work is structured as an OpenSpec change. See [`openspec/changes/bootstrap-memex-hermes-adapter/tasks.md`](openspec/changes/bootstrap-memex-hermes-adapter/tasks.md). Conventions:

- Tasks are grouped by source-tree concern: §3-§5 are TypeScript, §6-§8 are Python, §9-§13 are distribution/docs.
- Several groups carry an explicit `**Blocked by: §2**` marker — do not start them before the spike is cleared.
- Mark a task done by changing its `- [ ]` to `- [x]` in `tasks.md` and committing.

## Coding conventions

- **Python:** ruff for lint, mypy in strict mode, pytest with asyncio_mode=auto.
- **TypeScript:** biome for lint+format, strict tsconfig, vitest for tests.
- **No silent fallbacks.** Per the family-wide rule, never auto-mock or paper over an environment problem; fix the integrated environment first.
- **No emojis in source files** unless explicitly requested.
- **Comments are rare.** Only when the WHY is non-obvious (a workaround, a non-trivial invariant). Don't narrate the WHAT.

## Pull requests

Follow the standard development flow:

1. Brainstorm → 2. Design spec → 3. `/systems-review` → 4. OpenSpec change → 5. `/systems-review` → 6. Plan → 7. Implement → 8. `/systems-review` on diff → 9. PR → 10. Cubic review → 11. Green CI → 12. **Wait for explicit user authorization before merging** (we never auto-merge).

## Reporting issues

[https://github.com/jim80net/memex-hermes/issues](https://github.com/jim80net/memex-hermes/issues)
