## MODIFIED Requirements

### Requirement: memex_remember writes a memory or rule entry and reports sync state

`memex_remember` SHALL accept `{"content": str, "scope"?: "project"|"global", "type"?: "memory"|"rule"}` (defaults: `scope=project`, `type=memory`). The handler SHALL write a new markdown file with the given content and appropriate frontmatter, then — when sync is enabled with a configured repo — SHALL commit the entry into the sync repo and attempt a push gated on `autoCommitPush` and a non-`_session/*` project id (rebase-retry, never force or reset). It SHALL return `{"written": "<absolute path>", "synced": <bool>}`.

The `synced` field is a **confirmation, not a prediction**: it SHALL be `true` only when the entry was committed AND pushed to the remote on this call — i.e. `sync.enabled=true` AND a repo is configured AND the project id is not in the `_session/*` namespace AND `autoCommitPush=true` AND the push succeeded. In every other case (`sync` disabled, no repo, session scope, `autoCommitPush=false`, or a push failure) `synced` SHALL be `false`, with the entry still written (and, where applicable, committed) locally.

#### Scenario: Project-scoped write lands in the project memory dir
- **GIVEN** a non-session project ID (e.g., from a git remote)
- **WHEN** the agent calls `memex_remember` with `{"content": "X", "scope": "project"}`
- **THEN** a new memory file is created under the project memory dir of that project ID
- **AND** the response `written` path matches the created file

#### Scenario: Eligible write commits and pushes; the entry reaches the remote
- **GIVEN** `sync.enabled=true`, a configured repo, `autoCommitPush=true`, and a non-session project ID
- **WHEN** the agent calls `memex_remember` with `{"content": "Y"}`
- **THEN** the entry is committed and pushed to the remote
- **AND** a fresh clone of the remote contains the written entry file
- **AND** the response `synced` field is `true`

#### Scenario: autoCommitPush disabled commits locally but does not sync
- **GIVEN** `sync.enabled=true`, a configured repo, `autoCommitPush=false`, and a non-session project ID
- **WHEN** the agent calls `memex_remember` with `{"content": "Y"}`
- **THEN** the entry is committed to the local sync repo
- **AND** no push occurs and the remote does not contain the entry
- **AND** the response `synced` field is `false`

#### Scenario: Session-scoped writes do not sync to remote
- **GIVEN** the current project ID is `_session/<uuid>` (no cwd-based or explicit project ID)
- **WHEN** the agent calls `memex_remember` with `{"content": "Z"}`
- **THEN** the file is written to the local cache
- **AND** the response `synced` field is `false`
- **AND** no git push occurs
