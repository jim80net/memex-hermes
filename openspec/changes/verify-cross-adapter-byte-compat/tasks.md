# Tasks — verify-cross-adapter-byte-compat

## 1. Shared memory-format module (refactor — no behavior change)
- [ ] 1.1 Create `src/core/memory-format.ts` exporting `formatMemoryEntry({name, description, type, body})` that builds the canonical 5-line frontmatter block (`---\nname/description/type\n---\n\n<body>\n`) using `safeYamlScalar` for `name`/`description`.
- [ ] 1.2 Refactor `tool-remember.ts::formatMemory` to call the shared formatter (`type: "memory"`); keep title/description/slug derivation in the hook.
- [ ] 1.3 Refactor `session-end.ts::formatLearningFile` to call the shared formatter (`type: "session-learning"`).
- [ ] 1.4 `pnpm test` + `pytest test/python` green — prove byte-identical output (existing writer tests are the regression gate).

## 2. Golden fixtures
- [ ] 2.1 Add `test/fixtures/cross-adapter/golden-memory.md` — canonical individual memory file (frontmatter `name`/`description`/`type: memory` + body) in the exact memex-core shape.
- [ ] 2.2 Add `test/fixtures/cross-adapter/README.md` — provenance (memex-core `parseMemoryFile` + memex-hermes formatter), what each fixture proves, regeneration steps.

## 3. Tier-1 conformance (vitest, always-on)
- [ ] 3.1 `test/ts/cross-adapter-compat.test.ts`: READ — `parseMemoryFile(golden)` yields the expected `{name, description, queries, body}`.
- [ ] 3.2 WRITE — `formatMemoryEntry(fixedInput)` equals the committed golden body byte-for-byte.
- [ ] 3.3 ROUND-TRIP — feed the formatter output through `parseMemoryFile`; assert the same entry. (Also assert `safeYamlScalar` escaping survives a `:`/`"` in description.)

## 4. Tier-2 version-pin alignment (vitest, always-on)
- [ ] 4.1 `test/ts/cross-adapter-pin-alignment.test.ts`: committed `CROSS_ADAPTER_TRANSFORMERS_RANGE = "^3.8.1"` + `CROSS_ADAPTER_MEMEX_CORE_RANGE = "^0.4.0"` (provenance comment → memex-claude package.json, read 2026-06-23).
- [ ] 4.2 Assert memex-hermes `package.json` `@huggingface/transformers` range === reference; `@jim80net/memex-core` range === reference.
- [ ] 4.3 Assert memex-hermes transformers range === installed `node_modules/@jim80net/memex-core/package.json` transformers range (non-stale shared-engine arm).

## 5. Tier-3 binary round-trip (pytest e2e, MEMEX_E2E gate)
- [ ] 5.1 Replace `test_cross_adapter_round_trip_tracked_as_followup` skip with a real test: stage `golden-memory.md` into a scratch sync-repo project memory dir; drive the binary read path (prefetch/search); assert the golden entry surfaces.
- [ ] 5.2 Extend the write check: `memex_remember` output frontmatter structurally matches the golden shape (delimiters, key order, `type:`, trailing newline).
- [ ] 5.3 Update `test/e2e/README.md` — move cross-adapter round-trip from "what we do NOT cover" to covered (golden-fixture method).

## 6. Spec + close-out
- [ ] 6.1 `openspec validate verify-cross-adapter-byte-compat --strict` passes.
- [ ] 6.2 Review trio (systems-review + open-code-review + STORM) on design+spec, then on the implementation diff — iterate clean.
- [ ] 6.3 Open PR to `jim80net/memex-hermes` referencing #4; surface to hydra-ops; NO self-merge.
