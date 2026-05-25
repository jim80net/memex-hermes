## ADDED Requirements

### Requirement: Engine dispatches Hermes events via the existing hook_event_name switch

The `memex` binary's entry point (`src/main.ts`) SHALL extend its existing `switch (input.hook_event_name)` to handle every `Hermes.*` event. No new CLI flags SHALL be introduced for Hermes-mode dispatch.

#### Scenario: Binary dispatches Hermes.prefetch on a JSON HookInput
- **WHEN** the binary receives `{"hook_event_name": "Hermes.prefetch", "session_id": "s1", "query": "deploy", "cwd": "/repo"}` on stdin
- **THEN** the prefetch handler runs against the SkillIndex built for that cwd
- **AND** the handler writes a `HookOutput`-shaped JSON object to stdout

#### Scenario: Unknown Hermes.* event returns a structured error
- **WHEN** the binary receives `{"hook_event_name": "Hermes.unknown-event"}` on stdin
- **THEN** the binary writes `{"error": "unknown_event"}` (or equivalent) to stdout
- **AND** exits with a non-zero status

### Requirement: Hermes.prefetch returns formatted injection markdown

`Hermes.prefetch` SHALL embed the query, search the index using the configured top-K and threshold, format the matching entries with the documented per-type disclosure (rule full-then-reminder, memory full, skill teaser, etc.), and return the assembled markdown string in the `HookOutput.additionalContext` field (or an agreed equivalent field).

#### Scenario: Top-matching rule entry is fully disclosed on first match in session
- **GIVEN** the session has not previously matched the rule `r1`
- **WHEN** `Hermes.prefetch` returns `r1` as the top match
- **THEN** the response contains the full content of `r1`
- **AND** the session tracker records `r1` as shown

#### Scenario: Second match of the same rule in the same session is a reminder
- **GIVEN** the session has previously shown rule `r1`
- **WHEN** `Hermes.prefetch` returns `r1` as a match again
- **THEN** the response contains only the one-liner reminder for `r1`, not the full content

#### Scenario: No matches above threshold returns empty additionalContext
- **WHEN** `Hermes.prefetch` runs and no indexed entry scores above the configured threshold
- **THEN** the response is `{}` or `{"additionalContext": ""}`

### Requirement: Hermes.sync-turn appends to the session trace and detects MEMORY.md changes

`Hermes.sync-turn` SHALL append the (user, assistant) turn to the session trace file, record telemetry attribution for any entries injected in the prior `Hermes.prefetch`, AND compare current mtimes on `$HERMES_HOME/memories/{MEMORY,USER}.md` against the values recorded on the previous `Hermes.sync-turn`. When mtimes have changed, the handler SHALL mirror the file content into the sync repo (covered by `hermes-sync-bridge`).

#### Scenario: Mtime change triggers a mirror
- **GIVEN** the prior `Hermes.sync-turn` recorded mtime `T0` for `MEMORY.md`
- **WHEN** the next `Hermes.sync-turn` runs and `MEMORY.md`'s mtime is `T1 > T0`
- **THEN** the handler mirrors the current `MEMORY.md` content into the sync repo
- **AND** updates the recorded mtime to `T1`

#### Scenario: Unchanged mtime is a no-op
- **WHEN** `Hermes.sync-turn` runs and neither `MEMORY.md` nor `USER.md` has changed mtime
- **THEN** no mirror or commit happens

### Requirement: Hermes.session-end extracts learnings and writes session-learning entries

When the `sessionEnd.extractLearnings` config is true, `Hermes.session-end` SHALL extract learnings from the provided messages (via the configured `extractionModel` or Hermes' active model), write each as a `session-learning`-typed markdown file into the project memory directory, and commit them to the sync repo.

#### Scenario: Extraction produces session-learning files
- **GIVEN** `sessionEnd.extractLearnings = true`
- **WHEN** `Hermes.session-end` runs with a message list containing user/assistant turns
- **THEN** zero or more `*.md` files with `type: session-learning` frontmatter are written under the project memory dir
- **AND** each file is committed to the sync repo

#### Scenario: extractLearnings disabled is a no-op
- **GIVEN** `sessionEnd.extractLearnings = false`
- **WHEN** `Hermes.session-end` runs
- **THEN** no extraction is performed and no files are written

### Requirement: Hermes.tool-* events implement the three memex tools

`Hermes.tool-search`, `Hermes.tool-remember`, and `Hermes.tool-recall` SHALL implement the search / remember / recall semantics defined by the `memex-tool-surface` capability and return JSON results in the shapes documented there.

#### Scenario: tool-search returns top-K matching entries
- **WHEN** the binary receives `{"hook_event_name": "Hermes.tool-search", "args": {"query": "foo", "limit": 3}}`
- **THEN** the response is JSON containing a `results` array of at most 3 entries
- **AND** each entry has `name`, `type`, `score`, `location`, `snippet` fields

#### Scenario: tool-remember writes a memory entry and reports sync state
- **WHEN** the binary receives `{"hook_event_name": "Hermes.tool-remember", "args": {"content": "x", "scope": "project"}}`
- **THEN** a new memory file is written under the project memory dir
- **AND** the response is JSON `{"written": "<path>", "synced": true|false}`

### Requirement: Hermes.* events live in this repo's src/ for v1

The new `Hermes.*` event handlers SHALL live in `memex-hermes/src/` (TypeScript) and call into `@jim80net/memex-core` as a library dependency. They SHALL NOT modify `memex-core` itself for v1. The path layer for Hermes (`src/core/hermes-paths.ts`) similarly lives in this repo for v1 and is upstreamed once stable.

#### Scenario: memex-core dependency is unmodified
- **WHEN** this change ships
- **THEN** `package.json` declares `@jim80net/memex-core` as a published version dependency
- **AND** no `memex-core` source files are vendored or patched in this repo
