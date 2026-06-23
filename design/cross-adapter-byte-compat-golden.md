# Design — Cross-adapter byte-compatibility golden fixture (issue #4)

**Status:** proposed (rev 2 — incorporates the design-gate review trio:
systems-review + open-code-review + STORM, all findings below)
**Issue:** [#4](https://github.com/jim80net/memex-hermes/issues/4)
**Author:** memex flotilla XO · **Date:** 2026-06-23

## 1. Problem

The product invariant that makes the memex family worth shipping — *a memory
authored under one adapter is read back unchanged under another* — is, in
memex-hermes, verified only by a **negative** grep
(`test/python/test_no_engine_imports.py`) and **prose**. The positive round-trip
(`test/e2e/test_sync_compat.py::test_cross_adapter_round_trip_tracked_as_followup`)
is a `pytest.skip()` placeholder gated behind `MEMEX_E2E=1` **and a live
`memex-claude` install** that never runs. It is the weakest-verified invariant
in the adapter, and it is now the load-bearing **memory-portability guarantee**
underwriting the operator's Hermes teardown / corpus-salvage boundary.

## 2. What the guarantee actually is (corrected framing)

The review trio established two corrections that reshape the design:

**(a) The guarantee is SEMANTIC round-trip of a parsed entry, NOT byte-identity
of a file.** memex-hermes filenames carry a timestamp + random suffix
(`tool-remember.ts`), so two adapters' files are *never* byte-identical. The
real, testable guarantee is: *the `{name, description, queries, body}` an adapter
parses from a file equals what the writing adapter intended*, where the reader is
the **shared** `@jim80net/memex-core` parser every adapter uses. We say
"byte-compatible" only for the literally-true claim: hermes's written file BODY +
frontmatter shape match a committed golden byte-for-byte.

**(b) The on-disk text is the source of truth; the cache + vectors are
regenerable derivatives.** `loadCache` discards the cache on any `version` /
`embeddingModel` mismatch and re-embeds from the `.md` files
(`memex-core/cache.ts`, `skill-index.ts`). Therefore the **corpus-survival**
guarantee rests entirely on **L1 (the memory-file text)** being readable by the
shared parser. The cache (L2) and embedding vectors (L3) are a warm-cache
optimization: an adapter with a mismatched engine simply re-embeds. This focuses
the rigor where it belongs (L1) and downgrades the version-pin guard (below) from
a "corpus survives" guard to a "warm-cache reuse + ranking stability" guard.

### Format layers and where memex-hermes can break them

| # | Layer | Read owner | Write owner | Corpus-critical? | hermes drift risk |
|---|-------|-----------|-------------|------------------|-------------------|
| **L1a** | Frontmatter memory file (`---\nname/description/type\n---\n\n<body>`) | memex-core `parseFrontmatter` / `parseMemoryFile` | **adapter-local** — hermes `formatMemory` / `formatLearningFile` | **YES** | **HIGH** — only layer hermes writes itself |
| **L1b** | Section-style memory file (`## heading` + `Triggers:`) | memex-core `parseMemoryFile` section fallback | (memex-format memory files) | **YES** | LOW — the *read* path must parse it |
| **L1c** | Heading-less prose (real mirrored `USER.md`) | memex-core `parseMemoryFile` → `[]` (not indexed) | passthrough mirror of Hermes's `USER.md` (`_mirror.ts`, verbatim) | open (#12) | LOW (verbatim) — but currently NOT surfaced by the memex layer |
| **L2** | `memex-cache.json` (`CACHE_VERSION=2`) | memex-core `loadCache` | memex-core `saveCache` (via `SkillIndex`) | NO (regenerable) | LOW |
| **L3** | Embedding vectors in L2 | memex-core `LocalEmbeddingProvider` (`@huggingface/transformers`) | same | NO (regenerable) | SILENT (version skew → different vectors → ranking drift) |

memex-claude has **no** frontmatter-synthesizing writer of its own (its memories
are authored as `.md` files and read through the same shared parser). So the
cross-adapter invariant reduces to: **hermes writes → the shared memex-core
parser reads correctly**. That is exactly what Tier 1 proves.

### Empirically-confirmed state (read this session, 2026-06-23)

- Both `memex-hermes` and `memex-claude` lockfiles resolve
  `@huggingface/transformers@3.8.1` and `@jim80net/memex-core@0.4.0`;
  `memex-core@0.4.0` declares `@huggingface/transformers: ^3.8.1` under
  **`optionalDependencies`** (not `dependencies`).
- Writer↔reader round-trip probe (hermes `safeYamlScalar` → memex-core
  `parseFrontmatter`/`parseMemoryFile`): **colon, unicode, trailing-space
  round-trip correctly; embedded `"` and `\` do NOT** (they retain
  backslash-escape artifacts). Bodies always round-trip. This is the
  `safeYamlScalar`↔`parseFrontmatter` contract gap — filed as **#10**, pinned
  (not silently shipped) by this fixture. It is *consistent* across adapters (the
  shared parser yields the same value everywhere), so it is a fidelity boundary,
  not a cross-adapter inconsistency.

## 3. Approach — three tiers, self-contained, no live memex-claude

A **committed golden fixture** is the stand-in for "what a peer adapter writes."

### Tier 1 — Memory-file conformance (vitest, always-on)  ← the load-bearing test

Runs in the `typescript` CI job. Deterministic; no binary, no model download.

**Fixtures** under `test/fixtures/cross-adapter/`:
- `golden-memory-frontmatter.md` — canonical individual memory file (L1a),
  **adversarial**: description carries a `:`, a non-ASCII char, and a
  leading/trailing space (the cases that MUST round-trip).
- `golden-memory-section.md` — section-style file (L1b), `## heading` +
  `Triggers:` (a real memex memory format). NOTE (verified this session): the
  real `~/.hermes/memories/USER.md` is heading-less, frontmatter-less prose, NOT
  this section shape — so this golden exercises the section parser path, not
  "the USER.md shape."
- `golden-memory-prose.md` — the real heading-less USER.md shape (generic prose;
  the operator's actual USER.md is private and not committed to this public
  repo). PINNED: `parseMemoryFile` yields `[]` for it — mirrored USER.md prose is
  not surfaced by the memex layer (consistent across adapters → byte-compat
  holds; whether it SHOULD be surfaced is tracked in **#12**).
- `README.md` — provenance, what each fixture proves, regeneration steps.

**Read conformance:** parse each golden via BOTH the function hermes actually
calls on its recall path (`parseFrontmatter`, `tool-recall.ts:60`) AND the
scan/index function (`parseMemoryFile`, which takes a `filePath` arg and returns
an **array** — assert `length === 1`, index `[0]`). Assert the parsed
`{name, description, queries, body}` exactly match expected (note: hermes-written
files carry no `queries:`, so `queries === []` — the section golden exercises the
`Triggers:` → `queries` path so the list parser is covered).

**Write conformance + round-trip:** call hermes's shared formatter with fixed
input → assert the produced bytes equal the committed golden frontmatter body,
then feed it back through `parseMemoryFile` → assert the same entry.

**Pinned escaping boundary (#10):** an explicit test asserting the *known*
behavior — embedded `"`/`\` in a frontmatter scalar does NOT round-trip — with a
comment linking #10. This documents the boundary instead of hiding it behind a
clean fixture; when #10 is fixed, this test flips to asserting fidelity.

**Shared formatter extraction (prerequisite, no behavior change):** extract the
duplicated 5-line frontmatter block into `src/core/memory-format.ts` exporting
`formatMemoryEntry({name, description, type, body})`. **Contract: the formatter
treats `body` as OPAQUE — it does NOT trim.** This preserves both current call
sites exactly: `tool-remember.ts` keeps its `content.trim()` at the call site;
`session-end.ts` keeps passing `learning.body` raw. (The two writers differ today
— `formatMemory` trims, `formatLearningFile` does not — so a trimming formatter
would silently change one of them.) Byte-level regression tests for BOTH writers
gate the extraction (none exists today for `formatMemory`'s body).

### Tier 2 — Version-pin alignment guard (vitest, always-on)

`test/ts/cross-adapter-pin-alignment.test.ts`. Guards L3 ranking-stability + L2
schema (warm-cache, per §2(b) — not corpus survival).

Committed references (provenance-commented → memex-claude, read 2026-06-23):
`CROSS_ADAPTER_TRANSFORMERS_RANGE = "^3.8.1"`,
`CROSS_ADAPTER_TRANSFORMERS_RESOLVED = "3.8.1"`,
`CROSS_ADAPTER_MEMEX_CORE_RANGE = "^0.4.0"`.

- **Declared range (documentary):** hermes `package.json`
  `@huggingface/transformers` and `@jim80net/memex-core` ranges === the
  committed ranges.
- **Resolved version (load-bearing):** read the INSTALLED
  `node_modules/@huggingface/transformers/package.json` `.version` and assert it
  === `CROSS_ADAPTER_TRANSFORMERS_RESOLVED`. This is the version actually bundled
  into the binary — a caret range can resolve to a different version, so the
  resolved check is what catches the silent vector-space drift; the range check
  is only documentary.
- **Shared-engine consistency:** read memex-core's `@huggingface/transformers`
  range from the INSTALLED `node_modules/@jim80net/memex-core/package.json`,
  reading across `dependencies` ∪ `optionalDependencies` ∪ `peerDependencies`
  (it lives under `optionalDependencies`); assert it is defined (absence is
  itself drift) and equals hermes's declared range.

A doc note: bump in lockstep with memex-claude + memex-core.

### Tier 3 — Binary conformance (pytest e2e, `MEMEX_E2E` gate)

Replaces the `test_cross_adapter_round_trip_tracked_as_followup` skip. Runs in
the existing `integration-smoke` job (builds the linux-x64 binary, runs
`pytest test/e2e` under `MEMEX_E2E=1`). No memex-claude — the golden file is the
peer stand-in.

- **Write direction (deterministic, hard):** drive `memex_remember` on the built
  binary; assert the written file's frontmatter key layout matches the golden
  (`name`/`description`/`type`) + trailing newline + parses back to the payload.
  Extends the existing `test_memex_remember_writes_claude_compatible_file` from
  "contains payload" to an explicit golden-shape assertion, plus a dedicated
  round-trip test. This path **degrades gracefully when the embedding backend is
  absent** (verified: the binary logs the index-build failure and still dispatches
  + writes the file), so it is the reliable binary-tier anchor.
- **Read direction — covered at Tier 1, NOT re-exercised on the binary
  (evidence-based decision).** The original draft proposed a hard binary
  prefetch/search test. Empirically (verified this session): the binary's
  read/search path requires `@huggingface/transformers`, which does **not** resolve
  inside the `bun build --compile` artifact in this environment (`health` returns
  `ready:true` but index-build fails) — and `test_skill_match.py` already documents
  this as an environment condition it skips on. A hard binary-search test would
  therefore false-red wherever the backend is unavailable; a skip-on-empty would be
  the verification theater the review rightly flagged. So the READ direction is
  covered DETERMINISTICALLY at Tier 1 (vitest) against the **same memex-core parser
  the binary bundles**, and no skippable/fragile binary read test is added — the
  skip placeholder is removed, not replaced with another skip.

## 4. Spec delta

One requirement added to `hermes-sync-bridge` (see the change's spec delta),
worded to §2's corrected framing: semantic round-trip of the parsed entry,
adapter-local L1 writer conforms to the shared reader, version-pin alignment for
warm-cache/ranking stability, verified self-contained via a golden fixture.

## 5. Out of scope (explicit)

- **A live two-adapter CI lane.** The golden fixture is the deliberate
  self-contained substitute (matches the Hermes-teardown framing: the guarantee
  must hold without the peer installed).
- **Numerical embedding-vector equality across adapters** (needs both engines
  running). Proxied by the Tier-2 resolved-version pin; and per §2(b) it is not
  corpus-critical anyway (vectors regenerate from text).
- **Fixing the #10 escaping contract** (writer/reader scalar grammar) — a
  memex-core-ecosystem decision; this fixture *pins* the boundary and links it.
- **Fixing the #11 conflict-policy spec/code mismatch** — pre-existing,
  git-sync-conflict domain, needs memex-core coordination.
- **Other memex-core-written on-disk artifacts** — `memex-telemetry.json`
  (`version:1`), the project registry (`version:1`), session files, execution
  traces. These are written by memex-core (not adapter-local), version-gated, and
  either regenerable or runtime-only; their cross-adapter compatibility rides on
  the same `@jim80net/memex-core` version the Tier-2 guard pins. Named here so the
  coverage decision is auditable; no separate fixture warranted.
- **Filesystem-level concerns** — CRLF/BOM and filename case-folding across OSes.
  hermes writes LF + a single trailing newline + ASCII-safe filenames; the golden
  body comparison asserts LF + single trailing newline. Cross-OS filename
  case-collision (the `caseSensitive` project-id flag) is a sync-layer concern,
  not a memory-file-format concern — out of scope, named.

## 6. Verification plan

- `pnpm test` (vitest) — Tiers 1 + 2 green, deterministic, no network.
- `pnpm typecheck` + `pnpm lint` — clean.
- `pytest test/python` — unchanged green (the writer extraction must not regress
  `tool-remember` / `session-end`; new byte-level tests are the regression gate).
- `MEMEX_E2E=1 … pytest test/e2e -c test/e2e/pytest.ini` with a built binary —
  Tier 3 passes (also in CI `integration-smoke`).
- Adversarial manual checks: corrupt the golden body one byte → Tier-1 write
  conformance fails; edit hermes's transformers pin → Tier-2 fails; the #10
  boundary test flips when #10 is fixed. (Confirms the guards bite.)
