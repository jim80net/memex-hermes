# Tasks — verify-cross-adapter-byte-compat

## 1. Shared memory-format module (refactor — no on-disk behavior change)
- [x] 1.1 Add a byte-level regression test for `tool-remember.ts::formatMemory`'s output (none existed) and confirm `session-end.ts::formatLearningFile`'s assertion. These gate the extraction. (Covered by `test/ts/cross-adapter-compat.test.ts` write-conformance + existing `session-end.test.ts`.)
- [x] 1.2 Create `src/core/memory-format.ts` exporting `formatMemoryEntry({name, description, type, body})` — builds `---\nname/description/type\n---\n\n<body>\n` via `safeYamlScalar`. **Contract: body is OPAQUE — the formatter does NOT trim.**
- [x] 1.3 Refactor `formatMemory` to call it (`type:"memory"`, passing `content.trim()` as body — trim stays at the call site); refactor `formatLearningFile` to call it (`type:"session-learning"`, passing `learning.body` raw).
- [x] 1.4 `pnpm test` (172) + `pytest test/python` (172) green — byte-identical output for BOTH writers.

## 2. Golden fixtures
- [x] 2.1 `test/fixtures/cross-adapter/golden-memory-frontmatter.md` — L1a individual memory file; ADVERSARIAL description (embedded `:`, non-ASCII, leading/trailing space). Generated from the real `formatMemoryEntry`.
- [x] 2.2 `test/fixtures/cross-adapter/golden-memory-section.md` — L1b section/`USER.md` style (`## heading` + `Triggers:`); synthetic now, to be validated against the operator's real `~/.hermes/memories/USER.md` when openclaude-migration delivers it.
- [x] 2.3 `test/fixtures/cross-adapter/README.md` — provenance, what each proves, regeneration steps, link to #10.

## 3. Tier-1 conformance (vitest, always-on)
- [x] 3.1 `test/ts/cross-adapter-compat.test.ts` READ: parse both goldens via `parseFrontmatter` AND `parseMemoryFile` (assert array `length===1`, `[0]`); assert `{name, description, queries, body}` exact. Frontmatter golden → `queries===[]`; section golden → `queries` from `Triggers:`.
- [x] 3.2 WRITE: `formatMemoryEntry(fixedInput)` === committed golden frontmatter body byte-for-byte (assert LF + single trailing newline, no BOM).
- [x] 3.3 ROUND-TRIP: formatter output → `parseMemoryFile` → same entry.
- [x] 3.4 PINNED BOUNDARY (#10): assert embedded `"`/`\` in a scalar does NOT round-trip (current behavior), comment-linked to #10; flips to fidelity assertion when #10 lands.

## 4. Tier-2 version-pin alignment (vitest, always-on)
- [x] 4.1 `test/ts/cross-adapter-pin-alignment.test.ts`: committed `CROSS_ADAPTER_TRANSFORMERS_RANGE="^3.8.1"`, `CROSS_ADAPTER_TRANSFORMERS_RESOLVED="3.8.1"`, `CROSS_ADAPTER_MEMEX_CORE_RANGE="^0.4.0"` (provenance → memex-claude package.json, read 2026-06-23).
- [x] 4.2 Declared (documentary): hermes `package.json` transformers + memex-core ranges === references.
- [x] 4.3 Resolved (load-bearing): installed `node_modules/@huggingface/transformers/package.json`.version === `CROSS_ADAPTER_TRANSFORMERS_RESOLVED`.
- [x] 4.4 Shared-engine: read memex-core's transformers range across `dependencies`∪`optionalDependencies`∪`peerDependencies` (it's under `optionalDependencies`); assert defined AND === hermes declared range.

## 5. Tier-3 binary conformance (pytest e2e, MEMEX_E2E gate)
- [x] 5.1 Strengthen `test_memex_remember_writes_claude_compatible_file`: assert the written frontmatter STRUCTURE matches the golden key layout (`name`/`description`/`type`) + trailing newline, not just "contains payload".
- [x] 5.2 Replace `test_cross_adapter_round_trip_tracked_as_followup` skip with a DETERMINISTIC binary round-trip (`test_binary_write_round_trips_through_shared_format`): the compiled binary's `memex_remember` output matches the golden frontmatter shape + parses back to the payload. **Decision (evidence-based, revised from the design draft):** a binary *read/search* test was NOT added — empirically verified this session that the binary's read path requires the embedding backend (`@huggingface/transformers`), which does not resolve inside the `bun build --compile` artifact (the WRITE path degrades gracefully and still emits the file). A hard binary-search test would false-red; a skip would be theater. READ is covered deterministically at Tier 1 (same bundled parser). No skip remains.
- [x] 5.3 Update `test/e2e/README.md` + module docstring: cross-adapter byte-compat now covered (golden-fixture method); reconcile the stale "§11.3" cross-reference.

## 6. Spec + close-out
- [x] 6.1 `openspec validate verify-cross-adapter-byte-compat --strict` passes.
- [x] 6.2 Review trio (systems-review + open-code-review + STORM) on the implementation diff — systems-review APPROVED; OCR + STORM findings addressed (#10/#12 pinned, README/spec/design reconciled).
- [x] 6.3 Open PR to `jim80net/memex-hermes` referencing #4 (+ #10/#11/#12 discovered tech debt) → PR #13; surface to hydra-ops; NO self-merge per fleet doctrine. (CI + cubic gates pending confirmation.)
