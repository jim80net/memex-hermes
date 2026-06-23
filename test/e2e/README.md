# End-to-end integration tests (`test/e2e/`)

Covers the seven scenarios named in [`openspec/changes/bootstrap-memex-hermes-adapter/tasks.md`](../../openspec/changes/bootstrap-memex-hermes-adapter/tasks.md) §11. The suite is gated on the `MEMEX_E2E=1` environment variable so contributors running `pytest` casually do not spin up Hermes subprocesses or download embedding models.

## What's in the suite

| File | Scenario | What it exercises |
| --- | --- | --- |
| `test_skill_match.py` | §11.2 | Authored `SKILL.md` is surfaced for a relevant prompt via `prefetch` |
| `test_sync_compat.py` | §11.3 / #4 | Compiled binary's `memex_remember` writes the shared cross-adapter frontmatter format (golden-fixture round-trip; READ proven at Tier-1 vitest) |
| `test_memory_mirror.py` | §11.4 | Both mirror paths (primary `on_memory_write` + mtime watcher) work; covers `remove` via mtime |
| `test_first_run.py` | §11.5 | Cold-cache first-run `prefetch` completes within 10s (only when `MEMEX_E2E_COLD=1`) |
| `test_binary_failure.py` | §11.6 | Provider degrades gracefully when the binary is missing; no exception escapes |
| `test_binary_resolution.py` | P1-1 | Default binary resolution (no `MEMEX_HERMES_BINARY` override) reaches and runs the cache-path binary |
| `test_hermes_home.py` | §11.7 | Custom `HERMES_HOME` is honored end-to-end; no writes escape that root |

The Hermes-runtime smoke (`hermes_session` fixture) exists in `fixtures.py` but is reserved for tests that specifically need to drive the real `MemoryManager` discovery path. Most e2e tests instantiate `MemexProvider` directly because the provider is the unit-under-test for these scenarios — the Hermes-side wiring is covered by `spike/SPIKE-COMPLETE.md` and unit tests in `test/python/`.

## Local runbook

```bash
# 1. Activate the project venv (must have `memex-hermes` installed editable + dev deps)
. .venv/bin/activate

# 2. Build the engine binary (TypeScript -> bun --compile output)
pnpm install
pnpm build

# 3. Materialize a scratch HERMES_HOME and copy the binary into it
mkdir -p /tmp/mh-e2e-home/cache/memex/bin
cp dist/*/memex-hermes /tmp/mh-e2e-home/cache/memex/bin/memex
chmod +x /tmp/mh-e2e-home/cache/memex/bin/memex

# 4. Run the suite
MEMEX_E2E=1 \
HERMES_HOME=/tmp/mh-e2e-home \
MEMEX_HERMES_BINARY=/tmp/mh-e2e-home/cache/memex/bin/memex \
  pytest test/e2e -v -c test/e2e/pytest.ini
```

Add `MEMEX_E2E_COLD=1` to additionally exercise `test_first_run.py`. That test clears the model cache before each invocation so it should not run alongside cache-sensitive tests.

## When the suite skips

| Skip reason | Fix |
| --- | --- |
| `e2e suite disabled (set MEMEX_E2E=1 to enable)` | Add `MEMEX_E2E=1` to the environment |
| `cold-cache scenario disabled (set MEMEX_E2E_COLD=1 to enable)` | Add `MEMEX_E2E_COLD=1` to additionally enable `test_first_run.py` |
| `memex binary not found at ... — build it via 'pnpm build' ...` | Build the binary and put it where the fixture expects |
| `MEMEX_HERMES_BINARY=... does not exist` | Fix the override or unset the env var |
| `Hermes venv python not found at /home/jim/.hermes/...` | Only the `hermes_session` fixture needs this; install Hermes locally or skip that test |

## Cross-adapter byte-compat (issue #4)

* **Covered, self-contained (no live `memex-claude`).** A committed golden fixture (`test/fixtures/cross-adapter/`) is the peer-adapter stand-in. `test_sync_compat.py` asserts the compiled binary WRITES the shared frontmatter shape; the READ direction (the shared `@jim80net/memex-core` parser reading a peer-shaped file) is proven deterministically at Tier 1 (`test/ts/cross-adapter-compat.test.ts`), and the version-pin alignment that keeps the embedding cache reusable is at Tier 2 (`test/ts/cross-adapter-pin-alignment.test.ts`). See `design/cross-adapter-byte-compat-golden.md`.
* The binary's own read/search of a peer file is **not** re-exercised here: it requires the embedding backend (`@huggingface/transformers`), which is not guaranteed to resolve inside a `bun build --compile` artifact, so a binary search test would be an environment-fragile gate. READ is covered at Tier 1 against the same bundled parser.

## What we do NOT cover here

* **Push retry / remote sync** semantics. The fixtures set `sync.autoCommitPush: false` so we never hit a real remote. Push retry behavior is unit-tested in `test/ts/`.
* **Hermes runtime CLI execution.** We drive the `MemoryManager` directly; we do not boot the full `hermes` CLI. The CLI is owned by NousResearch; we trust the v0.14.0 contract verified in `spike/SPIKE-COMPLETE.md`.

## Suggested pyproject.toml additions

The §9 distribution agent owns `pyproject.toml`. When the §11 + §9 work merges, add:

```toml
[tool.pytest.ini_options]
testpaths = ["test/python", "test/e2e"]
markers = [
    "e2e: end-to-end integration test against a real Hermes home + memex binary",
    "e2e_cold: cold-cache scenario (clears the ONNX model cache before running)",
]
```

so `pytest` discovers e2e tests by default (still gated by `MEMEX_E2E=1` for execution). Until then, invoke e2e explicitly with `-c test/e2e/pytest.ini`.
