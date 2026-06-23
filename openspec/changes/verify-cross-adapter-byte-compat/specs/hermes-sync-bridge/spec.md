## ADDED Requirements

### Requirement: Cross-adapter on-disk format is byte-compatible and verified

The memory-file format memex-hermes writes SHALL be byte-compatible with the
shared `@jim80net/memex-core` read path (`parseFrontmatter` / `parseMemoryFile`)
that every adapter uses, so that a memory authored under any adapter is read
back identically under any other. memex-hermes SHALL synthesize that format
through a single shared formatter (`src/core/memory-format.ts`) used by every
write path (`memex_remember`, session-end learnings), rather than duplicating
the frontmatter shape per hook.

To keep the embedding cache (`memex-cache.json`) and the embedding vector space
compatible across adapters, memex-hermes SHALL pin `@huggingface/transformers`
and `@jim80net/memex-core` to ranges aligned with the peer adapters
(`memex-claude` / `memex-openclaw`). The cache's `embeddingModel` string is
necessary but NOT sufficient: an independent `@huggingface/transformers` bump
silently drifts the vector space under the same model name, and an independent
`@jim80net/memex-core` major/minor bump can change the cache schema
(`CACHE_VERSION`). Both SHALL be guarded by a version-pin alignment test that
fails loudly on divergence.

These guarantees SHALL be verified by a committed golden fixture (a canonical
memory file in the shared format) exercised in three directions — read, write,
and round-trip — plus the version-pin alignment test. Verification SHALL be
self-contained: it SHALL NOT require a live `memex-claude` installation; the
golden fixture is the peer-adapter stand-in.

#### Scenario: Peer-written memory file reads back identically
- **GIVEN** the committed golden memory file in the shared memex-core frontmatter format
- **WHEN** it is parsed via memex-core's public `parseMemoryFile`
- **THEN** the resulting entry's `name`, `description`, `queries`, and `body` match the documented expected values exactly

#### Scenario: memex-hermes write conforms to the shared format
- **GIVEN** a fixed memory entry input (name, description, type, body)
- **WHEN** memex-hermes's shared formatter renders it
- **THEN** the produced bytes equal the committed golden body
- **AND** feeding that output back through `parseMemoryFile` yields the same entry (round-trip)

#### Scenario: Independent transformers bump fails the alignment guard
- **GIVEN** the committed cross-adapter reference ranges for `@huggingface/transformers` and `@jim80net/memex-core`
- **WHEN** memex-hermes's declared range for either diverges from the reference (or from the installed memex-core's transformers range)
- **THEN** the version-pin alignment test fails, surfacing the drift before it ships

#### Scenario: The compiled binary reads a peer-written memory file
- **GIVEN** the golden memory file staged in a project memory dir inside a scratch sync repo, and `MEMEX_E2E=1` with a built binary
- **WHEN** the binary's read path (prefetch/search) runs against a query the golden entry should match
- **THEN** the binary surfaces the golden entry, proving the compiled artifact (bundled memex-core + transformers) consumes the shared format end-to-end
