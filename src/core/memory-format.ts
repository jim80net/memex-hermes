// Shared memory-file format — the cross-adapter on-disk contract.
//
// The frontmatter shape memex-hermes writes is the ONE format layer the adapter
// synthesizes itself (the cache + embeddings are owned by @jim80net/memex-core,
// shared by every adapter). It is therefore the only place the cross-adapter
// byte-compat invariant can break inside this repo. Both write paths
// (`memex_remember` → tool-remember.ts, session-end learnings → session-end.ts)
// emit the identical 5-line frontmatter block; centralizing it here gives that
// contract a single named home and lets the cross-adapter conformance test
// exercise the REAL writer rather than a copy.
//
// Read side (every adapter): memex-core's `parseFrontmatter` / `parseMemoryFile`
// consume this exact shape. The conformance test in
// `test/ts/cross-adapter-compat.test.ts` proves the round-trip.

import { safeYamlScalar } from "./yaml-frontmatter.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The `type:` frontmatter values memex-hermes writes. */
export type MemoryEntryType = "memory" | "session-learning";

export interface MemoryEntryFields {
  name: string;
  description: string;
  type: MemoryEntryType;
  /**
   * The markdown body, written verbatim after the frontmatter. OPAQUE: the
   * formatter does NOT trim or otherwise normalize it. Each caller owns its own
   * body normalization (tool-remember passes `content.trim()`; session-end
   * passes the LLM body unchanged), so centralizing the frontmatter block here
   * introduces zero on-disk behavior change for either path.
   */
  body: string;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Render a memory entry as the canonical memex on-disk format:
 *
 * ```
 * ---
 * name: "<escaped>"
 * description: "<escaped>"
 * type: <type>
 * ---
 *
 * <body>
 * ```
 *
 * `name` / `description` are emitted as escaped double-quoted YAML scalars via
 * `safeYamlScalar` so a colon, quote, or newline in either cannot corrupt the
 * frontmatter. The trailing newline (the final empty array element) is part of
 * the contract — memex-claude/memex-openclaw write files ending in a newline and
 * the conformance test asserts it.
 *
 * NOTE: the `safeYamlScalar`↔`parseFrontmatter` round-trip is exact for plain
 * scalars (including embedded `:`), but embedded `"`/`\` are not decoded on read
 * — tracked in #10 and pinned by the conformance test. Bodies always round-trip.
 */
export function formatMemoryEntry(fields: MemoryEntryFields): string {
  return [
    "---",
    `name: ${safeYamlScalar(fields.name)}`,
    `description: ${safeYamlScalar(fields.description)}`,
    `type: ${fields.type}`,
    "---",
    "",
    fields.body,
    "",
  ].join("\n");
}
