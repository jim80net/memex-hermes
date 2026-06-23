## ADDED Requirements

### Requirement: Cross-adapter memory-file format is verified by a golden fixture

A memory entry authored under memex-hermes SHALL be readable, unchanged, by the
shared `@jim80net/memex-core` parser (`parseFrontmatter` / `parseMemoryFile`)
that every adapter uses. The guarantee is **semantic round-trip of the parsed
entry** (`name`, `description`, `queries`, `body`) — NOT byte-identity of the
file, since memex-hermes filenames carry a timestamp + random suffix and are
never byte-equal across writers. The on-disk memory-file text is the source of
truth for the corpus; the embedding cache (`memex-cache.json`) and embedding
vectors are regenerable derivatives (`loadCache` discards on `version` /
`embeddingModel` mismatch and re-embeds from the text), so corpus survival rests
on the memory-file text being readable, not on cache reuse.

memex-hermes SHALL synthesize the frontmatter format through a single shared
formatter (`src/core/memory-format.ts`) used by every write path
(`memex_remember`, session-end learnings); the formatter SHALL treat the body as
opaque (callers own any trimming) so extraction introduces no on-disk behavior
change.

To keep the embedding cache reusable and the embedding ranking stable across
adapters (a warm-cache optimization, not a corpus-survival requirement),
memex-hermes SHALL pin `@huggingface/transformers` and `@jim80net/memex-core` to
versions aligned with the peer adapters, guarded by a test that asserts the
INSTALLED (resolved) transformers version — not merely the declared caret range —
matches the cross-adapter reference, and that memex-hermes's declared transformers
range matches the installed memex-core's declared range.

Verification SHALL be self-contained — it SHALL NOT require a live `memex-claude`
installation; a committed golden fixture is the peer-adapter stand-in.

#### Scenario: Peer-shaped memory file parses to the expected entry
- **GIVEN** the committed golden memory files (frontmatter style and section/`USER.md` style)
- **WHEN** each is parsed via memex-core's `parseFrontmatter` (the recall read path) and `parseMemoryFile` (the scan/index path, which returns an array)
- **THEN** the resulting single entry's `name`, `description`, `queries`, and `body` match the documented expected values exactly

#### Scenario: memex-hermes write round-trips through the shared reader
- **GIVEN** a fixed memory entry input (name, description, type, body)
- **WHEN** memex-hermes's shared formatter renders it
- **THEN** the produced bytes equal the committed golden frontmatter body
- **AND** feeding that output back through `parseMemoryFile` yields the same parsed entry

#### Scenario: Frontmatter-scalar escaping boundary is pinned, not hidden
- **GIVEN** a frontmatter `name`/`description` containing an embedded `"` or `\`
- **WHEN** it is written via the shared formatter and read back via the shared parser
- **THEN** the test asserts the CURRENT (non-round-tripping) behavior and links the tracking issue, so the boundary is documented and flips to a fidelity assertion when the contract is fixed

#### Scenario: Independent transformers bump fails the alignment guard
- **GIVEN** the committed cross-adapter reference (resolved transformers version + declared ranges)
- **WHEN** the installed transformers version, or memex-hermes's declared range, diverges from the reference (or from the installed memex-core's range)
- **THEN** the version-pin alignment test fails, surfacing the drift before it ships

#### Scenario: The compiled binary writes the shared format (e2e)
- **GIVEN** `MEMEX_E2E=1` with a built binary
- **WHEN** `memex_remember` is driven on the binary
- **THEN** the written file's frontmatter key layout matches the committed golden (`name`/`description`/`type`), parses back to the payload, and ends in a single newline — proving the compiled artifact emits the shared cross-adapter format
- **AND** this holds even when the embedding backend is unavailable (the write path degrades gracefully); the binary's READ/search path, which requires the embedding backend, is covered deterministically at the vitest tier against the same bundled parser rather than via an environment-fragile binary-search gate
