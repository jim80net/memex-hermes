# hermes-sync-bridge Specification

## Purpose
TBD - created by archiving change bootstrap-memex-hermes-adapter. Update Purpose after archive.
## Requirements
### Requirement: Hermes built-in memory writes propagate to the shared sync repo

A write performed by Hermes' built-in `remember` tool (or any other mechanism that modifies `$HERMES_HOME/memories/{MEMORY,USER}.md`) SHALL be mirrored into the local sync repo and committed. The `on_memory_write` `target` value is `"memory"` or `"user"` (NOT a filename) and SHALL be mapped to `MEMORY.md` / `USER.md` respectively, mirrored at `<sync_repo>/projects/<project-id>/memory/MEMORY.md` (or `USER.md`). The system SHALL implement BOTH mirror paths — the `on_memory_write` callback handler AND the mtime-watcher inside `Hermes.sync-turn`. Per the source verification in `spike/SPIKE-COMPLETE.md`, the `on_memory_write` callback **is the primary path for `add`/`replace`** (it is confirmed to fire for built-in writes at `agent/tool_executor.py:642`). The built-in memory tool gates the callback on `action in {"add","replace"}` (`agent/tool_executor.py:640`, `agent/agent_runtime_helpers.py:1544`), so a built-in **`remove` does NOT fire `on_memory_write`** — the mtime-watcher is the path that captures removals (and out-of-band writes) by re-mirroring the full current file content. The mtime-watcher is therefore mandatory, not optional. (Per G19 from the openspec systems-review; primary path resolved per R1/Q1.)

#### Scenario: Built-in remove is captured by the mtime path, not the callback
- **GIVEN** `sync.enabled = true`, a non-session project ID, and a mirrored `MEMORY.md`
- **WHEN** the built-in memory tool performs a `remove` (which does not fire `on_memory_write`)
- **THEN** the next `Hermes.sync-turn` detects the `MEMORY.md` mtime change
- **AND** re-mirrors the full current file content (reflecting the removal) and commits

#### Scenario: MEMORY.md edit reaches the sync repo
- **GIVEN** `sync.enabled = true` and a non-session project ID
- **WHEN** Hermes' built-in `remember` tool writes new content to `$HERMES_HOME/memories/MEMORY.md`
- **THEN** within one turn (or on `on_memory_write` fire, whichever is sooner), the file `<sync_repo>/projects/<id>/memory/MEMORY.md` matches the new content
- **AND** a git commit is created
- **AND** an attempted push is dispatched

#### Scenario: USER.md edit is mirrored too
- **WHEN** Hermes writes to `$HERMES_HOME/memories/USER.md`
- **THEN** the mirror behavior in the preceding scenario applies to USER.md

#### Scenario: Built-in writes are not mirrored when mirrorHermesMemory is false
- **GIVEN** config `mirrorHermesMemory = false`
- **WHEN** Hermes writes to `MEMORY.md` or `USER.md`
- **THEN** no mirror is performed
- **AND** no commit is made

### Requirement: Session-fallback project IDs never push to the remote sync repo

When the current project ID is in the `_session/*` namespace (i.e., Hermes did not provide a cwd-based identity), the adapter SHALL suppress git push for entries scoped to that ID, regardless of `sync.enabled` and `sync.autoCommitPush`. Local cache writes still occur; only the remote push is suppressed.

#### Scenario: Session ID inhibits push despite autoCommitPush
- **GIVEN** `sync.enabled = true`, `sync.autoCommitPush = true`, and project ID `_session/abc-123`
- **WHEN** `memex_remember` writes a new entry under that project ID
- **THEN** the entry is written to the local cache
- **AND** no `git push` is executed for that entry's commit
- **AND** an informational log line is emitted explaining the suppression

#### Scenario: Promotion to a named project via memex_remember
- **WHEN** the agent calls `memex_remember` with `{"content": "X", "scope": "project", "projectName": "explicit-name"}`
- **THEN** the entry is written under `<sync_repo>/projects/explicit-name/memory/`
- **AND** push proceeds normally
- **AND** the entry is not associated with the `_session/*` ID

### Requirement: Non-primary execution contexts do not mirror or push

In addition to the `_session/*` suppression above, the mirror/sync path SHALL suppress writes originating from non-primary execution contexts. The signal is twofold: the `agent_context` captured at `initialize` (`"subagent"`, `"cron"`, `"flush"`) AND the per-write `metadata` provenance on `on_memory_write` (e.g. `execution_context`, `write_origin`). When either indicates a non-primary context, the write SHALL be dropped before commit (`agent/memory_provider.py:67-81`). This prevents cron system prompts and subagent scratch writes from corrupting the user's synced representation.

#### Scenario: Cron-context memory write is dropped
- **GIVEN** the session was initialized with `agent_context="cron"` (or `on_memory_write` metadata carries `execution_context="cron"`)
- **WHEN** `on_memory_write` fires
- **THEN** no mirror file is written and no commit/push occurs
- **AND** an informational log line explains the context-based suppression

#### Scenario: Primary-context write proceeds
- **GIVEN** `agent_context="primary"` and primary `metadata` provenance
- **WHEN** `on_memory_write` fires for a non-session project ID with `sync.enabled = true`
- **THEN** the mirror is written, committed, and a push is dispatched

### Requirement: Project ID canonicalization matches the other adapters

The project ID SHALL be derived as: (1) if `cwd` is inside a git repo with `origin` remote, use `<host>/<owner>/<repo>` from the parsed remote URL; (2) else if `cwd` is set but not a git repo, use `_local/<encoded-cwd>`; (3) else fall back to `_session/<session_id>`. The encoding rules and remote-URL parsing SHALL match the implementation in `@jim80net/memex-core`.

#### Scenario: Git remote drives the project ID
- **GIVEN** `cwd=/repo` whose `origin` remote URL is `git@github.com:foo/bar.git`
- **WHEN** the binary resolves the project ID for that cwd
- **THEN** the ID is `github.com/foo/bar`

#### Scenario: Non-git directory uses _local
- **GIVEN** `cwd=/some/dir` not in a git repo
- **WHEN** the binary resolves the project ID
- **THEN** the ID is `_local/<percent-encoded /some/dir>`

#### Scenario: Missing cwd uses _session
- **GIVEN** no `cwd` is supplied with the JSON HookInput
- **WHEN** the binary resolves the project ID
- **THEN** the ID is `_session/<session_id>`

### Requirement: Sync push race recovery uses rebase-retry with bounded backoff

When `git push` is rejected as non-fast-forward, the engine SHALL retry up to `sync.pushRetries` times (default 3) using `git pull --rebase` + `git push` with exponential backoff (200 ms, 400 ms, 800 ms). On exhaustion, the local commit SHALL remain on the branch and a warning SHALL surface via the Hermes logger; the local sync repo SHALL NOT be reset.

#### Scenario: Successful retry after a non-fast-forward rejection
- **GIVEN** a remote that accepts the second push after a rebase
- **WHEN** the first push is rejected non-fast-forward
- **THEN** the engine performs `git pull --rebase`, waits 200 ms, and pushes again
- **AND** the second push succeeds
- **AND** no warning is emitted

#### Scenario: Three rejections leave the commit local and log a warning
- **GIVEN** a remote that rejects every push attempt
- **WHEN** the push fails three consecutive times after rebase
- **THEN** the local commit remains on the branch
- **AND** a warning identifying the failure is emitted
- **AND** the engine does NOT reset, force-push, or discard the local commit

### Requirement: Sync pull on session start auto-resolves markdown conflicts

`initialize()` SHALL trigger a `git pull --rebase` of the sync repo (when `sync.autoPull = true`). When the pull surfaces file-level conflicts on markdown content, the engine SHALL apply the documented memex-core conflict policy: per-stanza last-write-wins for memory; line-merge for rules; reject and surface for skills.

#### Scenario: Memory file conflict resolves per-stanza
- **WHEN** two adapters wrote different paragraphs of the same memory file and the pull encounters a conflict
- **THEN** the resulting file contains both paragraphs in stable order
- **AND** the rebase completes without manual intervention

#### Scenario: Skill conflict surfaces a warning instead of auto-resolving
- **WHEN** two adapters wrote different content to the same `SKILL.md` and the pull encounters a conflict
- **THEN** the conflict is not auto-resolved
- **AND** a warning surfaces via the Hermes logger identifying the conflicting file
- **AND** the local file remains unchanged

### Requirement: Concurrent multi-session cache writes are serialized via file locks

Every write to `memex-cache.json`, `memex-telemetry.json`, session files under `cache/sessions/`, the project registry, and the memory-mtime tracker SHALL be wrapped in `withFileLock()` from `memex-core/src/file-lock.ts` (mkdir-atomic with 5 s timeout, 30 s stale recovery).

#### Scenario: Two concurrent binaries do not corrupt the cache
- **WHEN** two Hermes sessions run concurrently on the same host and both write to the cache within milliseconds of each other
- **THEN** after both invocations complete, the cache file parses as valid JSON
- **AND** both sessions' contributions are present

#### Scenario: Stale lock is recovered
- **GIVEN** a lock directory exists with mtime older than 30 seconds
- **WHEN** a binary attempts to acquire the lock
- **THEN** the binary forcibly removes the stale lock and proceeds

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

#### Scenario: Heading-less mirrored prose is a pinned boundary
- **GIVEN** a heading-less, frontmatter-less memory file (the real `~/.hermes/memories/USER.md` shape, mirrored verbatim)
- **WHEN** it is parsed via `parseMemoryFile`
- **THEN** it yields zero indexable entries — the suite pins this current behavior (mirrored USER.md prose is not surfaced by the memex layer; consistent across adapters, so byte-compat holds) and links the open design question on whether it should be surfaced

#### Scenario: Independent transformers bump fails the alignment guard
- **GIVEN** the committed cross-adapter reference (resolved transformers version + declared ranges)
- **WHEN** the installed transformers version, or memex-hermes's declared range, diverges from the reference (or from the installed memex-core's range)
- **THEN** the version-pin alignment test fails, surfacing the drift before it ships

#### Scenario: The compiled binary writes the shared format (e2e)
- **GIVEN** `MEMEX_E2E=1` with a built binary
- **WHEN** `memex_remember` is driven on the binary
- **THEN** the written file's frontmatter key layout matches the committed golden (`name`/`description`/`type`), parses back to the payload, and ends in a single newline — proving the compiled artifact emits the shared cross-adapter format
- **AND** this holds even when the embedding backend is unavailable (the write path degrades gracefully); the binary's READ/search path, which requires the embedding backend, is covered deterministically at the vitest tier against the same bundled parser rather than via an environment-fragile binary-search gate

