## Why

The product invariant that makes the memex family worth shipping — *a corpus
written under one adapter is byte-identically read under another* — is, in
memex-hermes, verified only by a **negative** grep
(`test/python/test_no_engine_imports.py`) and **prose**. The positive
round-trip (`test/e2e/test_sync_compat.py::test_cross_adapter_round_trip_tracked_as_followup`)
is a `pytest.skip()` placeholder, gated behind `MEMEX_E2E=1` **and a live
`memex-claude` install** that never runs. It is the weakest-verified invariant
in the adapter, and it is now the load-bearing **memory-portability guarantee**
underwriting the operator's Hermes teardown / corpus-salvage boundary.

See `design/cross-adapter-byte-compat-golden.md` for the full root-cause
framing.

## What Changes

- **Extract a shared memory-format module** (`src/core/memory-format.ts`) from
  the duplicated frontmatter-block logic in `tool-remember.ts::formatMemory`
  and `session-end.ts::formatLearningFile`. The cross-adapter on-disk format is
  a contract and gets one named home; both hooks call the shared formatter.
- **Add committed golden fixtures** (`test/fixtures/cross-adapter/`): a canonical
  memory file in the memex-core frontmatter shape (the "written by
  memex-claude" stand-in) plus provenance/regeneration docs.
- **Add Tier-1 vitest conformance** (`test/ts/cross-adapter-compat.test.ts`):
  read (golden → `parseMemoryFile` → expected entry), write (hermes formatter →
  golden bytes), and round-trip (write → parse → identical).
- **Add Tier-2 vitest version-pin alignment guard**
  (`test/ts/cross-adapter-pin-alignment.test.ts`): memex-hermes's
  `@huggingface/transformers` and `@jim80net/memex-core` ranges must equal the
  committed cross-adapter reference AND the installed memex-core's transformers
  range — so an independent bump fails loudly instead of silently drifting the
  embedding vector space / cache schema.
- **Upgrade the Tier-3 e2e skip into a real binary round-trip** in
  `test/e2e/test_sync_compat.py`: the freshly-built binary reads the golden
  memory file (surfaces it via search/prefetch) and its `memex_remember` write
  conforms to the golden shape. Self-contained — no memex-claude install (the
  golden file is the peer stand-in).

## Capabilities

### Modified Capabilities

- `hermes-sync-bridge`: adds one requirement — the cross-adapter on-disk format
  is byte-compatible and *verified* (golden read/write/round-trip + version-pin
  alignment), replacing the prior prose-only assertion.

## Impact

- **Tests + fixtures only, plus one internal refactor.** No runtime behavior
  change: the extracted formatter produces byte-identical output to the two
  inlined copies (existing `test/python` + `test/ts` writer tests pin this).
- **CI:** Tiers 1–2 run in the existing `typescript` job (deterministic, no
  network); Tier 3 runs in the existing `integration-smoke` job (already builds
  the binary + runs `pytest test/e2e` under `MEMEX_E2E=1`).
- **No `@jim80net/memex-core` change.** Conformance is asserted via memex-core's
  public `parseMemoryFile`; the cache/embedding layers are guarded by version
  alignment, not by reaching into memex-core internals (only `.` is exported).
