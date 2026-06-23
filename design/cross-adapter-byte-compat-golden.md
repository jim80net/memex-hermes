# Design — Cross-adapter byte-compatibility golden fixture (issue #4)

**Status:** proposed
**Issue:** [#4](https://github.com/jim80net/memex-hermes/issues/4) — Add cross-adapter byte-compat golden fixture (E2E §11.3 round-trip)
**Author:** memex flotilla XO
**Date:** 2026-06-23

## 1. Problem

The load-bearing product invariant — *the on-disk corpus memex-hermes writes is
byte-identical with what `memex-claude` / `memex-openclaw` write and read* — is
today verified only by:

- a **negative** grep (`test/python/test_no_engine_imports.py`: "no embedding
  imports, no `git` subprocess in the Python layer"), and
- **prose** assertions in `test/e2e/test_sync_compat.py` +
  `hermes-sync-bridge` spec language.

There is no **positive** round-trip proving a real file written in the shared
format is read back identically across adapters. The intended test
(`test_sync_compat.py::test_cross_adapter_round_trip_tracked_as_followup`) is a
`pytest.skip()` placeholder, and the §11.3 task is `[ ]`, gated behind
`MEMEX_E2E=1` **and a live `memex-claude` install** — which never runs.

This is the weakest-verified invariant in the adapter. It is now also
operator-load-bearing: it is the **memory-portability guarantee** underwriting
the Hermes teardown / corpus-salvage boundary (a corpus written under one
adapter must survive being read under another).

## 2. Root-cause framing — where the format actually lives

The on-disk format is **not** owned by memex-hermes. It is owned by the shared
`@jim80net/memex-core` library that *every* adapter links as a dependency.
memex-core owns three distinct format layers:

| # | Layer | Owner (read) | Owner (write) | Drift risk in memex-hermes |
|---|-------|--------------|---------------|----------------------------|
| **L1** | Memory-file frontmatter (`---\nname/description/type\n---\n\n<body>`) | memex-core `parseFrontmatter` / `parseMemoryFile` (`skill-index.ts`) | **adapter-local** — hermes synthesizes it in `tool-remember.ts::formatMemory` and `session-end.ts::formatLearningFile` | **HIGH** — this is the one place hermes writes the format itself |
| **L2** | `memex-cache.json` (`CACHE_VERSION=2`, compact JSON) | memex-core `loadCache` | memex-core `saveCache` | **LOW** — hermes never writes the cache directly; `SkillIndex` does. Compat is by construction, *given the same memex-core version* |
| **L3** | Embedding vectors stored in L2 | memex-core `LocalEmbeddingProvider` via `@huggingface/transformers` | same | **SILENT** — same `embeddingModel` string but a different transformers version → different vectors. `loadCache` accepts the drifted cache (version + model match), so the drift is invisible |

The byte-compat invariant therefore decomposes into three sub-invariants:

- **I1 (correctness-critical):** hermes's memory-file **write** shape must parse
  cleanly through memex-core's **read** path. If hermes emits frontmatter
  memex-core can't parse, the peer adapter silently drops that memory → real
  corpus loss. This is the *only* layer hermes can break on its own.
- **I2 (format version):** the `memex-cache.json` schema is identical across
  adapters **iff they link the same `@jim80net/memex-core` major/minor**.
  `CACHE_VERSION` bumps on schema change, and `loadCache` discards a cache whose
  `version` differs — so the failure mode of an L2 skew is *cold re-embed*
  (slow), not corruption. The guard is **version alignment**, not a format test.
- **I3 (embedding space):** the cache stores vectors. Two adapters that link
  **different `@huggingface/transformers` versions** produce different vectors
  for the same text under the *same* `embeddingModel` string. `loadCache` cannot
  detect this (version + model match), so a cache written by claude and read by
  hermes would carry subtly wrong vectors → silent ranking degradation. The
  guard is **transformers-version alignment**, not a format test.

### Empirically-confirmed current state (read this session, 2026-06-23)

From the committed lockfiles (`pnpm-lock.yaml`) of both repos:

- `memex-hermes`: `@huggingface/transformers@3.8.1`, `@jim80net/memex-core@0.4.0`
- `memex-claude`: `@huggingface/transformers@3.8.1`, `@jim80net/memex-core@0.4.0`
- `@jim80net/memex-core@0.4.0` itself depends on `@huggingface/transformers: 3.8.1`

All three are aligned today. The guard exists to make a *future* independent bump
**fail loudly** instead of silently drifting the corpus.

## 3. Approach — three tiers, self-contained, no live memex-claude

The original §11.3 design required running memex-claude in CI. We reframe it: a
**committed golden fixture** is the stand-in for "what memex-claude writes." The
golden file *is* the cross-adapter contract artifact; conformance is proven
against it without installing the peer.

### Tier 1 — Memory-file format conformance (vitest, always-on)  ← the load-bearing test

Runs in the `typescript` CI job on every PR. Deterministic; no binary, no model
download.

**Fixtures** (committed under `test/fixtures/cross-adapter/`):
- `golden-memory.md` — a canonical individual memory file in the exact
  memex-core frontmatter shape (the "written by memex-claude" artifact).
- `README.md` — provenance + regeneration instructions.

**Read conformance:** parse `golden-memory.md` via memex-core's **public**
`parseMemoryFile` → assert the resulting entry's `{name, description, queries,
body}` exactly match expected values. Proves hermes (which reads via this exact
function) consumes a peer-written file identically.

**Write conformance + round-trip:** call hermes's memory-file writer with fixed
inputs → assert the produced bytes **equal the committed golden body**, then
feed that output back through `parseMemoryFile` → assert the same entry. This
closes the loop: *hermes writes → memex-core reads → identical*.

To test the **real** writer (not a copy), extract the duplicated 5-line
frontmatter-block logic — currently copy-pasted between
`tool-remember.ts::formatMemory` and `session-end.ts::formatLearningFile` — into
a single shared module `src/core/memory-format.ts`. The cross-adapter on-disk
format is a *contract*; it deserves one named home, not duplication across two
hooks. Both hooks then call the shared formatter. This is the foundational
redesign the format demands and is a prerequisite for honestly testing "the
writer."

### Tier 2 — Version-pin alignment guard (vitest, always-on)

`test/ts/cross-adapter-pin-alignment.test.ts`. Guards I2 + I3.

- **Cross-adapter reference (I3):** a committed constant
  `CROSS_ADAPTER_TRANSFORMERS_RANGE = "^3.8.1"` (sourced from memex-claude's
  `package.json`, provenance-commented). Assert memex-hermes's declared
  `@huggingface/transformers` range equals it. A doc note instructs: bump in
  lockstep with memex-claude.
- **Shared-engine consistency (I3, non-stale):** read the **installed**
  `node_modules/@jim80net/memex-core/package.json` (a real hermes dependency —
  self-contained) and assert memex-hermes's `@huggingface/transformers` range
  equals memex-core's declared range. This catches the real silent drift: if
  memex-core bumps transformers in a release and hermes's direct pin doesn't
  follow, the bundled vector space could diverge from what the embedding code
  was written against.
- **Cache-format alignment (I2):** a committed constant
  `CROSS_ADAPTER_MEMEX_CORE_RANGE = "^0.4.0"`; assert memex-hermes's declared
  `@jim80net/memex-core` range equals it (same memex-core ⇒ same `CACHE_VERSION`
  ⇒ same cache schema).

The committed-reference arm encodes the *cross-adapter* contract value
(self-contained, the issue's explicit ask); the installed-core arm makes it
**non-stale** by tying to a real dependency that moves when the engine moves.

### Tier 3 — Binary round-trip (pytest e2e, `MEMEX_E2E` gate)  ← higher-fidelity

Upgrade `test_sync_compat.py::test_cross_adapter_round_trip_tracked_as_followup`
from a `skip` into a **real** round-trip against the freshly-built binary. This
runs in the existing `integration-smoke` CI job, which already builds the
linux-x64 binary and runs `pytest test/e2e` under `MEMEX_E2E=1`. No memex-claude
install — the golden file is the peer stand-in.

- **Read direction:** stage `golden-memory.md` into a project memory dir inside a
  scratch sync repo; drive the binary's `prefetch` (or `memex_search`) path with
  a query the golden entry should match; assert the binary surfaces it. Proves
  the **compiled artifact** (bundled memex-core + transformers + real embeddings)
  reads a peer-written file end-to-end.
- **Write direction:** drive `memex_remember` on the binary; assert the written
  file's frontmatter structurally matches the golden shape (delimiters, key
  order, `type:`, trailing newline). This extends the existing
  `test_memex_remember_writes_claude_compatible_file` with an explicit
  golden-shape assertion rather than a loose "contains payload" check.

The golden body's *content* is deterministic; the only non-deterministic parts
the binary adds are in the **filename** (timestamp + random suffix), not the body
— so a body-level golden comparison is stable.

## 4. Spec delta

Add one requirement to the `hermes-sync-bridge` capability:

> **Requirement: Cross-adapter on-disk format is byte-compatible and verified**
> The memory-file format memex-hermes writes SHALL be byte-compatible with the
> shared `@jim80net/memex-core` read path used by every adapter, and the adapter
> SHALL pin `@huggingface/transformers` and `@jim80net/memex-core` to ranges
> aligned with the peer adapters. Verified by a committed golden fixture
> (read + write + round-trip) and a version-pin alignment guard.

Scenarios: (a) golden read conformance, (b) golden write conformance +
round-trip, (c) transformers-version alignment fails loudly on independent bump,
(d) binary reads a peer-written memory file (e2e).

## 5. Out of scope

- A live two-adapter CI lane running real memex-claude. The golden fixture is the
  deliberate self-contained substitute (per the operator's Hermes-teardown
  framing: the guarantee must hold *without* the peer being installed).
- Numerical embedding-vector equality across adapters (would require running both
  engines). The Tier-2 version-pin guard is the proxy: identical transformers +
  model ⇒ identical vectors. Documented as the rationale.
- Deep `loadCache`/`saveCache` round-trip from the hermes repo: those symbols are
  not in memex-core's public `exports` map (only `.` is exported), and the cache
  consumption logic is memex-core's own test responsibility. L2 compat is guarded
  by the version pin (Tier 2), not by reaching into memex-core internals.

## 6. Verification plan

- `pnpm test` (vitest) — Tiers 1 + 2 green, deterministic, no network.
- `pnpm typecheck` + `pnpm lint` — clean (new module + tests).
- `pytest test/python` — unchanged green (writer extraction must not regress
  `tool-remember` / `session-end` behavior; existing tests cover both).
- `MEMEX_E2E=1 … pytest test/e2e -c test/e2e/pytest.ini` with a built binary —
  Tier 3 round-trip passes (also exercised by CI `integration-smoke`).
- Manual: corrupt the golden body by one byte → Tier 1 write-conformance fails;
  edit hermes's transformers pin → Tier 2 fails. (Confirms the guards bite.)
