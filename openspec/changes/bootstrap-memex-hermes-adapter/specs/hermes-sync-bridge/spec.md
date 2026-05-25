## ADDED Requirements

### Requirement: Hermes built-in memory writes propagate to the shared sync repo

A write performed by Hermes' built-in `remember` tool (or any other mechanism that modifies `$HERMES_HOME/memories/{MEMORY,USER}.md`) SHALL be mirrored into the local sync repo at `<sync_repo>/projects/<project-id>/memory/<target>.md` and committed. The system SHALL implement BOTH mirror paths — the `on_memory_write` callback handler AND the mtime-watcher inside `Hermes.sync-turn` — regardless of which the verification spike (see `hermes-memory-provider`) selects as primary. The primary path is the one that fires under normal Hermes operation; the secondary acts as a safety net for the cases where the primary is silent (e.g., direct disk edits, out-of-band tools). (Per G19 from the openspec systems-review.)

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
