# Cross-adapter byte-compat golden fixtures (issue #4)

These fixtures are the **self-contained stand-in for a peer adapter**
(`memex-claude` / `memex-openclaw`). The product invariant — *a memory authored
under one adapter is read back unchanged under another* — is verified against
them without installing any peer (per the Hermes-teardown framing: the guarantee
must hold even after the writing adapter is gone). See
`design/cross-adapter-byte-compat-golden.md`.

The guarantee is **semantic round-trip of the parsed entry**
(`{name, description, queries, body}`), not byte-identity of the file — adapter
filenames carry a timestamp + random suffix and are never byte-equal. The on-disk
text is the corpus source of truth; the embedding cache + vectors are regenerable
derivatives.

## Files

| File | Layer | What it proves | Provenance |
|------|-------|----------------|------------|
| `golden-memory-frontmatter.md` | L1a — individual memory file (`memex_remember` / session-learning shape) | the shared memex-core parser (`parseFrontmatter` + `parseMemoryFile`) reads hermes's frontmatter write shape to the exact expected entry; the writer reproduces these bytes | **generated from the real `formatMemoryEntry`** (`src/core/memory-format.ts`) — see regeneration below |
| `golden-memory-section.md` | L1b — section-style memory file (`## heading` + `Triggers:`) | the section-fallback parser reads a multi-section memory + `Triggers:`→`queries`. This is a real memex memory format — NOT the shape of a Hermes native USER.md (that is heading-less prose; see the next row) | hand-authored to the documented section format |
| `golden-memory-prose.md` | real `~/.hermes/memories/USER.md` shape — heading-less, frontmatter-less prose | PINNED current behavior (#12): such prose yields ZERO indexable entries from `parseMemoryFile` — mirrored USER.md prose is not surfaced by the memex layer (consistent across adapters, so byte-compat holds; whether it SHOULD be surfaced is #12) | **generic** prose — the real USER.md is the operator's private memory and is not committed to this public repo |

## Consumed by

- `test/ts/cross-adapter-compat.test.ts` (Tier 1, always-on vitest) — read /
  write / round-trip conformance for the frontmatter + section goldens, the
  pinned prose-shape boundary (#12), the `type` round-trip, and the pinned `#10`
  escaping boundary.
- `test/e2e/test_sync_compat.py` (Tier 3, `MEMEX_E2E=1`) — reads only
  `golden-memory-frontmatter.md` (via the frontmatter key layout) and asserts the
  compiled binary's `memex_remember` WRITE matches that shape. (The binary's READ
  path is covered at Tier 1, not here — see the module docstring.)

## Regenerating `golden-memory-frontmatter.md`

It is the literal output of `formatMemoryEntry` for the input pinned in
`test/ts/cross-adapter-compat.test.ts` (`FRONTMATTER_INPUT`). If the canonical
format legitimately changes, regenerate with that same input and update the
expected values in the test in the same change:

```js
// Run from this directory (test/fixtures/cross-adapter/); the repo root is
// three levels up, so the import path is ../../../src/core/.
import { writeFileSync } from "node:fs";
import { formatMemoryEntry } from "../../../src/core/memory-format.ts";
// FRONTMATTER_INPUT from test/ts/cross-adapter-compat.test.ts
writeFileSync("golden-memory-frontmatter.md", formatMemoryEntry(FRONTMATTER_INPUT));
```

A change to these bytes is a change to the cross-adapter on-disk contract —
review it as such (and confirm `memex-claude` / `memex-openclaw` move in
lockstep).

## Known boundary (`#10`)

`safeYamlScalar` (writer) emits YAML double-quoted escapes; memex-core's
`parseFrontmatter` (reader) strips only the outer quotes and does not decode
escapes. So an embedded `"` or `\` in a frontmatter **scalar** (`name` /
`description`) does NOT round-trip; the **body** always does. The Tier-1 test
pins this current behavior and links `#10`; when `#10` is fixed those assertions
flip to assert fidelity.
