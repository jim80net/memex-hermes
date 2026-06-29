# memex-tool-surface Specification

## Purpose
TBD - created by archiving change bootstrap-memex-hermes-adapter. Update Purpose after archive.
## Requirements
### Requirement: Three memex_* tools are registered with Hermes

The provider SHALL expose exactly three agent-callable tools via `get_tool_schemas()`: `memex_search`, `memex_remember`, and `memex_recall`. Each tool SHALL be enableable/disableable via the `tools.<name>.enabled` config flag, defaulting to `true`.

#### Scenario: All three tools appear by default
- **WHEN** `provider.get_tool_schemas()` is called with default config
- **THEN** the returned list contains exactly three schemas with names `memex_search`, `memex_remember`, `memex_recall`

#### Scenario: A disabled tool is omitted from schemas
- **GIVEN** config `tools.memex_recall.enabled = false`
- **WHEN** `provider.get_tool_schemas()` is called
- **THEN** the returned list does not contain a schema for `memex_recall`

### Requirement: memex_search performs explicit semantic search

`memex_search` SHALL accept `{"query": str, "limit"?: int, "types"?: [str]}` and return JSON `{"results": [{"name", "type", "score", "location", "snippet"}, ...]}`. The `limit` defaults to `tools.memex_search.defaultLimit` (default 5). The `types` argument filters results to the listed entry types; when omitted, all configured types are searched. The score threshold for explicit search SHALL be `tools.memex_search.threshold` (default 0.4), independent of the prefetch threshold.

#### Scenario: Search returns top-K results above threshold
- **GIVEN** an index containing entries whose similarity to "deployment" scores 0.9, 0.6, 0.3
- **WHEN** the agent calls `memex_search` with `{"query": "deployment", "limit": 5}` and threshold 0.4
- **THEN** the response contains 2 results (scores 0.9 and 0.6) in descending order

#### Scenario: Limit caps the number of results
- **WHEN** the agent calls `memex_search` with `{"query": "foo", "limit": 2}` and 10 entries clear the threshold
- **THEN** the response contains exactly 2 results

#### Scenario: Types filter restricts the result set
- **WHEN** the agent calls `memex_search` with `{"query": "foo", "types": ["memory"]}`
- **THEN** all returned entries have `type: "memory"`

### Requirement: memex_remember writes a memory or rule entry and reports sync state

`memex_remember` SHALL accept `{"content": str, "scope"?: "project"|"global", "type"?: "memory"|"rule"}` (defaults: `scope=project`, `type=memory`). The handler SHALL write a new markdown file with the given content and appropriate frontmatter, then — when sync is enabled with a configured repo — SHALL commit the entry into the sync repo (committing only the written file) and attempt a push gated on `autoCommitPush` and a push-eligible project id (any id NOT in the `_session/*` namespace; rebase-retry, never force or reset). It SHALL return `{"written": "<absolute path>", "committed": <bool>, "synced": <bool>}`.

The `synced` field is a **confirmation, not a prediction**: it SHALL be `true` only when the entry was committed AND pushed to the remote on this call — i.e. `sync.enabled=true` AND a repo is configured AND the project id is not in the `_session/*` namespace AND `autoCommitPush=true` AND the push succeeded. The `committed` field SHALL be `true` when the entry was committed to the local sync repo (whether or not it was then pushed). A `committed=true, synced=false` result means the entry is committed locally and will propagate on the next successful push by any writer. In every other case `synced` (and, where not committed, `committed`) SHALL be `false`, with the entry always written to disk.

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

#### Scenario: Session-fallback id suppresses push even when autoCommitPush is on
- **GIVEN** the current project ID is `_session/<uuid>` AND `sync.enabled=true` AND `autoCommitPush=true` AND a configured repo
- **WHEN** the agent calls `memex_remember`
- **THEN** the entry is committed to the local sync repo
- **AND** no git push occurs and the response `synced` field is `false` (the D7/C12 session-suppression invariant)

### Requirement: memex_recall fetches a specific entry by name

`memex_recall` SHALL accept `{"name": str}` and return `{"content": "<full markdown body>", "frontmatter": <dict of parsed frontmatter>}`. When no entry with that name exists, the response is `{"error": "not_found", "name": "<name>"}`.

#### Scenario: Existing entry is returned with parsed frontmatter
- **GIVEN** an entry `my-skill` with frontmatter `{name: my-skill, type: skill, description: "X"}` exists in the index
- **WHEN** the agent calls `memex_recall` with `{"name": "my-skill"}`
- **THEN** the response contains the full SKILL.md body
- **AND** the response `frontmatter` field contains the parsed YAML

#### Scenario: Missing entry returns a structured error
- **WHEN** the agent calls `memex_recall` with `{"name": "nonexistent"}`
- **THEN** the response is `{"error": "not_found", "name": "nonexistent"}`

### Requirement: Tool names are namespaced with the memex_ prefix

All adapter-introduced tools SHALL be prefixed with `memex_` to avoid collisions with other registered memory providers (e.g., `honcho_*`, `mem0_*`, `viking_*`). The adapter SHALL NOT implement runtime collision resolution; conflicts are surfaced by Hermes' first-registered-wins policy.

#### Scenario: All tool names start with memex_
- **WHEN** `provider.get_tool_schemas()` is called
- **THEN** every returned schema has a `name` field starting with the literal prefix `memex_`

### Requirement: Tool schemas conform to the Hermes-documented dict shape

Tool schemas SHALL be Python dicts with keys `name`, `description`, and `parameters` (a JSON Schema object), matching the shape documented in Hermes' Build-a-Hermes-Plugin guide's `ctx.register_tool` examples. The shape SHALL be re-confirmed against `agent/memory_provider.py` source during the verification spike defined in the `hermes-memory-provider` capability.

#### Scenario: Schema has the documented shape
- **WHEN** `provider.get_tool_schemas()` is called
- **THEN** every returned schema is a dict with keys `name` (str), `description` (str), and `parameters` (dict with `type: "object"`, `properties`, optional `required`)

