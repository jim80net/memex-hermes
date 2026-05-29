# memex-hermes — Usage

`memex-hermes` is the [Hermes Agent](https://hermes-agent.nousresearch.com/) adapter for the `memex` family of semantic skill/memory/rule routers. It plugs Hermes into the same `memex` corpus that powers [`memex-claude`](https://github.com/jim80net/memex-claude) and [`memex-openclaw`](https://github.com/jim80net/memex-openclaw) — so a fact remembered in one harness reaches the others via git sync. The shared engine is [`@jim80net/memex-core`](https://github.com/jim80net/memex-core); the on-disk cache format, telemetry schema, sync-repo layout, and project-ID canonicalization are byte-identical across all three adapters by design.

This document covers what memex-hermes does at runtime, how to install and configure it, how to use the bundled skills and tools, and how to troubleshoot common problems. For architectural rationale see [`docs/specs/2026-05-25-memex-hermes-adapter-design.md`](docs/specs/2026-05-25-memex-hermes-adapter-design.md).

`$HERMES_HOME` defaults to `~/.hermes` but is configurable; every path below resolves from it. None of the runtime code hardcodes `~/.hermes/`.

---

## Install

Hermes v0.14.0 discovers memory providers by scanning two directories — bundled `plugins/memory/<name>/` and user `$HERMES_HOME/plugins/<name>/` (`plugins/memory/__init__.py:1-20,41-98`) — and activates exactly the one named by the `memory.provider` key in `$HERMES_HOME/config.yaml` (`agent_init.py:999-1005`). The generic `hermes_agent.plugins` pip entry-point PluginManager explicitly skips `memory/` (`hermes_cli/plugins.py:819-829`) and its `PluginContext` has no `register_memory_provider` (`hermes_cli/plugins.py:1073-1078`). Therefore:

- A pip entry-point alone does NOT register or activate a memory provider.
- A directory under `$HERMES_HOME/plugins/memex/` with an `__init__.py` (containing `MemoryProvider` or `register_memory_provider` within its first 8192 bytes — the discovery heuristic at `plugins/memory/__init__.py:51-64`) IS sufficient for discovery.
- Selection between discovered providers happens via the `memory.provider` config key.
- The `MemoryManager` accepts the built-in provider plus exactly ONE external provider (`agent/memory_manager.py:265-280`); a second external provider is rejected with a warning.

### Option A: PyPI

```bash
pip install memex-hermes
python -m memex_hermes.install       # materializes $HERMES_HOME/plugins/memex/
```

`python -m memex_hermes.install` copies (or symlinks) the provider package files into `$HERMES_HOME/plugins/memex/` and prints the `memory.provider: memex` instruction. After running, edit `$HERMES_HOME/config.yaml`:

```yaml
memory:
  provider: memex
```

The next `hermes` session activates memex. The bundled `bin/memex` wrapper downloads the platform-appropriate prebuilt binary on first invocation, SHA256-verifies against `checksums.txt` shipped in the release, and installs it under `$HERMES_HOME/cache/memex/bin/memex`. Subsequent runs exec the cached binary directly.

### Option B: Manual clone

```bash
git clone https://github.com/jim80net/memex-hermes "$HERMES_HOME/plugins/memex"
"$HERMES_HOME/plugins/memex/bin/install.sh"
```

Then set `memory.provider: memex` in `$HERMES_HOME/config.yaml`.

### Single-external-provider constraint

memex coexists with Hermes' built-in memory provider (the one that reads/writes `$HERMES_HOME/memories/MEMORY.md` and `USER.md`) but conflicts with other external providers. If you have `honcho`, `mem0`, `hindsight`, `retaindb`, `supermemory`, or another `MemoryProvider` configured as `memory.provider`, switching to memex deactivates them — only one external provider may be active at a time.

### Uninstall

```bash
# Stop activation
# In $HERMES_HOME/config.yaml, remove or change the memory.provider line.

# Remove the provider directory
rm -rf "$HERMES_HOME/plugins/memex"

# (Optional) uninstall the pip package
pip uninstall memex-hermes
```

The cache (`$HERMES_HOME/cache/memex/`) and the sync repo (`~/.local/share/memex-hermes/`) are NOT auto-removed — your indexed corpus and any local git history survive uninstall. Delete them manually if you want a fully clean reset:

```bash
rm -rf "$HERMES_HOME/cache/memex"
rm -rf ~/.local/share/memex-hermes
```

Uninstalled-but-still-configured (`memory.provider: memex` set but `$HERMES_HOME/plugins/memex/` removed) fails closed: `load_memory_provider("memex")` returns `None` and Hermes proceeds with the built-in provider only.

---

## Configuration

memex's own settings live in `$HERMES_HOME/memex.json` — separate from Hermes' `config.yaml`. The file is optional; absent file uses defaults.

### Full default configuration

```jsonc
{
  "enabled": true,
  "embeddingModel": "Xenova/all-MiniLM-L6-v2",
  "cacheTimeMs": 300000,
  "skillDirs": [],
  "memoryDirs": [],
  "sync": {
    "enabled": false,
    "repo": "",
    "autoPull": true,
    "autoCommitPush": true,
    "suppressSessionIds": true,
    "pushRetries": 3,
    "projectMappings": {}
  },
  "prefetch": {
    "topK": 3,
    "threshold": 0.5,
    "maxInjectedChars": 8000,
    "types": ["skill", "memory", "workflow", "session-learning", "rule"]
  },
  "tools": {
    "memex_search":   { "enabled": true,  "defaultLimit": 5, "threshold": 0.4 },
    "memex_remember": { "enabled": true,  "defaultScope": "project" },
    "memex_recall":   { "enabled": true }
  },
  "sessionEnd": {
    "extractLearnings": true,
    "extractionModel": ""
  },
  "mirrorHermesMemory": true
}
```

### Top-level fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch — disables all routing when `false` |
| `embeddingModel` | string | `"Xenova/all-MiniLM-L6-v2"` | HuggingFace model for embeddings (downloaded on first use to `$HERMES_HOME/cache/memex/models/`) |
| `cacheTimeMs` | number | `300000` | How long (ms) before the skill index is rebuilt |
| `skillDirs` | string[] | `[]` | Additional directories to scan for skills, beyond `$HERMES_HOME/skills/` and `<cwd>/.hermes/skills/` |
| `memoryDirs` | string[] | `[]` | Additional memory directories to scan (e.g., shared/ pattern from openclaw) |
| `mirrorHermesMemory` | boolean | `true` | Wire `on_memory_write` + the `sync-turn` mtime-watcher to mirror `MEMORY.md` / `USER.md` into the sync repo |

> **No `ruleDirs` field.** Rules in memex-hermes live in `$HERMES_HOME/skills/<name>/SKILL.md` with `type: rule` in the frontmatter — there is no separate rules directory (project decision C5; see [`docs/specs/...design.md`](docs/specs/2026-05-25-memex-hermes-adapter-design.md)).

### `prefetch`

Runs on every Hermes turn via `Hermes.prefetch`. Matches the user prompt against skills, memories, and rules.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `topK` | number | `3` | Maximum number of matches to inject |
| `threshold` | number | `0.5` | Minimum cosine similarity score (0-1) |
| `maxInjectedChars` | number | `8000` | Character budget for injected content |
| `types` | string[] | `["skill", "memory", "workflow", "session-learning", "rule"]` | Which entry types to match |

### `tools`

Per-tool overrides for the three memex tools (see [Tools](#tools) below).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `memex_search.enabled` | boolean | `true` | Expose the tool to the agent |
| `memex_search.defaultLimit` | number | `5` | Default `limit` arg when not specified by the agent |
| `memex_search.threshold` | number | `0.4` | Default similarity threshold |
| `memex_remember.enabled` | boolean | `true` | Expose the tool |
| `memex_remember.defaultScope` | string | `"project"` | Default write scope (`"project"` or `"global"`) |
| `memex_recall.enabled` | boolean | `true` | Expose the tool |

### `sessionEnd`

Runs at `Hermes.session-end`. Extracts learnings from the session into memex skills.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `extractLearnings` | boolean | `true` | Extract session learnings into memory entries |
| `extractionModel` | string | `""` | Model identifier for extraction. **v1 requires explicit configuration** (per openspec systems-review finding G17); the "use Hermes' active model" fallback path is deferred to v1.x. Empty string disables extraction. |

### `sync`

Cross-machine sync via a private git repo. See [Cross-platform sync](#cross-platform-sync) below.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable/disable sync |
| `repo` | string | `""` | Git URL of the sync repo |
| `autoPull` | boolean | `true` | Pull from remote on session start (`Hermes.init`) |
| `autoCommitPush` | boolean | `true` | Commit and push changes on `sync_turn` / `on_memory_write` / `session-end` |
| `suppressSessionIds` | boolean | `true` | Never push `_session/<id>` project entries to remote (project decision C12 — sessions without a meaningful cwd are local-cache-only) |
| `pushRetries` | number | `3` | Retries with `git pull --rebase + git push` on non-fast-forward rejection (exponential backoff 200/400/800 ms) |
| `projectMappings` | object | `{}` | Manual overrides: local path -> canonical project ID |

---

## Tools

memex registers three tools that the Hermes agent can call directly. Schemas are returned by `MemexProvider.get_tool_schemas()` at session start.

### `memex_search`

Explicit semantic search when the agent wants to look something up deliberately. Where `prefetch()` does implicit injection, `memex_search` lets the agent dig further when the implicit pull missed.

**Args:**

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `query` | string | yes | Free-text query |
| `limit` | integer | no (default 5) | Maximum number of results |
| `types` | string[] | no | Restrict to specific entry types (`skill`, `memory`, `rule`, `workflow`, `session-learning`) |

**Returns:**

```json
{
  "results": [
    {"name": "...", "type": "...", "score": 0.0, "location": "...", "snippet": "..."}
  ]
}
```

### `memex_remember`

Persist a fact or preference directly into the memex corpus. Distinct from Hermes' built-in `remember` tool — Hermes' tool writes to `$HERMES_HOME/memories/MEMORY.md` (which memex mirrors via `on_memory_write`); `memex_remember` writes directly into the per-project memory dir under `$HERMES_HOME/cache/memex/projects/<id>/memory/` (and the sync repo gets it on next push). The agent picks based on whether the fact should live in always-injected front-of-context (`remember`) or semantic back-of-context (`memex_remember`).

**Args:**

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `content` | string | yes | The text to remember |
| `scope` | string | no (default `"project"`) | `"project"` or `"global"` |
| `type` | string | no (default `"memory"`) | `"memory"` or `"rule"` |

**Returns:**

```json
{"written": "/absolute/path/to/file.md", "synced": true}
```

`synced: false` means the entry was written locally but sync push was suppressed (e.g., the project ID is `_session/<id>` per `suppressSessionIds`) or the push failed and will retry on the next session.

### `memex_recall`

Pull a specific entry by name.

**Args:**

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `name` | string | yes | The kebab-case name of the entry to read |

**Returns:**

```json
{"content": "...", "frontmatter": {"name": "...", "type": "...", ...}}
```

---

## Hermes built-in memory interop

Hermes ships a built-in `remember` tool and built-in `MemoryProvider` that read/write `$HERMES_HOME/memories/MEMORY.md` and `USER.md`. These are auto-injected at the head of every Hermes turn — they are the always-on, front-of-context layer.

memex coexists with that layer rather than replacing it. Two mirror paths bridge it into the memex sync repo:

### Primary mirror: `on_memory_write` (callback path)

Verified against Hermes v0.14.0 source (see [`spike/SPIKE-COMPLETE.md`](spike/SPIKE-COMPLETE.md) Q1): the built-in tool calls `MemoryManager.on_memory_write` (`agent/tool_executor.py:642`, `agent/agent_runtime_helpers.py:1546`), which fans out to every non-builtin provider (`agent/memory_manager.py:537-565`). When the agent uses `remember` with `action: "add"` or `action: "replace"`, `MemexProvider.on_memory_write(action, target, content, metadata)` fires, and the binary handles the mirror write + commit via `Hermes.memory-write`.

**Important guard:** the built-in tool gates the bridge on `function_args.get("action") in {"add", "replace"}` (`agent/tool_executor.py:640`, `agent/agent_runtime_helpers.py:1544`). A `remove` action performed by the built-in tool does NOT fire `on_memory_write`. That gap is closed by the secondary mirror.

### Secondary mirror: `sync_turn` mtime-watcher (mandatory)

The `Hermes.sync-turn` handler stats `$HERMES_HOME/memories/{MEMORY,USER}.md` on every turn and compares mtimes against the values cached at `$HERMES_HOME/cache/memex/memory-mtimes.json`. Any change triggers a re-mirror of the full file content into the sync repo. This catches:

- `remove` actions from the built-in tool (which never fire `on_memory_write`)
- Out-of-band writes — direct disk edits, external tools, manual `vim` sessions
- Any other path that bypasses the callback

Both paths ship. One stat call per turn is the only steady-state overhead.

### Agent-context write suppression

`initialize()` receives `agent_context` ∈ `{"primary", "subagent", "cron", "flush"}` (`agent/memory_provider.py:67-81`; CLI defaults to `"primary"` per `agent_init.py:1013`). For non-primary contexts (subagent runs, cron jobs, flush operations), the provider suppresses `sync_turn` / `on_memory_write` / `on_session_end` writes — read paths stay active so the subagent/cron job gets the same skills the primary session would, but their conversational turns don't poison the primary session's trace or sync repo. (Per openspec systems-review finding R5.)

`on_memory_write` honors the same convention via `metadata.execution_context` provenance: writes tagged non-primary are also suppressed.

---

## Cross-platform sync

Set the same `sync.repo` git URL on `memex-hermes`, `memex-claude`, and `memex-openclaw` and they share a corpus: skills authored in one harness appear in the others; memories written in one appear in the others; learnings extracted in one appear in the others.

### Setup

1. Create a private git repo (e.g., `github.com/you/memex-corpus`)
2. Enable sync in `$HERMES_HOME/memex.json`:

```json
{
  "sync": {
    "enabled": true,
    "repo": "git@github.com:you/memex-corpus.git"
  }
}
```

3. Set the **same URL** in `~/.claude/memex.json` for memex-claude and in the openclaw equivalent. Same URL, three adapters, one corpus.

### How it works

- **Session start (`Hermes.init`)**: pulls latest changes from the remote (`git pull --rebase`)
- **Per turn (`Hermes.sync-turn`)**: appends telemetry, mtime-checks built-in memory files, optionally commits + pushes
- **Memory write (`Hermes.memory-write`)**: mirrors the built-in MEMORY.md/USER.md change and commits
- **Session end (`Hermes.session-end`)**: extracts learnings (if `sessionEnd.extractLearnings` is true), writes them as `session-learning` entries, commits and pushes
- **Conflict resolution**: rebase pull; auto-resolve markdown conflicts at the file level (last-write-wins per stanza for memory; line-merge for rules; reject conflict and surface for skills)
- **Push race recovery**: on non-fast-forward rejection, retry `git pull --rebase + git push` up to `sync.pushRetries` times with exponential backoff (200/400/800 ms). After exhausting retries, the local commit stays in the branch and a warning surfaces via the Hermes logger; the next session's `Hermes.init` pull catches up.

### Sync repo structure

```
~/.local/share/memex-hermes/
|-- .git/
|-- skills/                                     # synced global skills (including rules with type: rule)
|   `-- my-skill/SKILL.md
`-- projects/
    |-- github.com/you/my-project/              # git-identified projects
    |   `-- memory/*.md
    `-- _local/                                 # non-git projects
        `-- -home-you-some-project/
            `-- memory/*.md
```

Note: there is no separate `rules/` directory — rules ride alongside skills with `type: rule` in their frontmatter (project decision C5).

### Project identity

Memories are stored per-project. The router resolves project identity using a cascade:

1. **Manual mapping** — `sync.projectMappings` in `memex.json` (explicit override)
2. **Git remote URL** — normalized to `host/owner/repo` (handles SSH + HTTPS, strips `.git`)
3. **Encoded cwd** — falls back to `_local/<encoded-cwd>` for non-git directories
4. **Session-scoped** — falls back to `_session/<session_id>` for Hermes sessions that lack a meaningful cwd (e.g., chat-only sessions)

`_session/*` IDs are local-cache-only. With `sync.suppressSessionIds: true` (the default), they are never pushed to the remote sync repo regardless of `sync.enabled` and `autoCommitPush` (project decision C12). To promote a session-scoped entry to a syncable project, call `memex_remember` explicitly with `scope: "project"` or `scope: "global"`.

All three matchable paths are lowercased by default to keep different-machine clones of the same git project mapping to the same canonical sync location. Set `sync.caseSensitive: true` to preserve the original casing.

---

## Bundled skills

Four lifecycle skills ship with the plugin under `$HERMES_HOME/plugins/memex/skills/` and are visible to memex's index via the `skillDirs` scan. Each is a SKILL.md with YAML frontmatter; Hermes surfaces them through its skills CLI/UI uniformly with any other skill on disk.

### `/sleep` — Organize knowledge

Migrates entries in `$HERMES_HOME/memories/MEMORY.md` (and project-level instruction files) into semantically-searchable skills. Performs the classification and migration directly — no external API calls. Run after accumulating entries to keep the always-on context lean. Also performs query evolution based on `queryHits` and `observations` telemetry in `$HERMES_HOME/cache/memex/memex-telemetry.json` — weak queries that rarely match are refined or replaced.

### `/deep-sleep` — Learn from sessions

Analyzes past Hermes session transcripts (from `$HERMES_HOME/sessions/session_<sid>.json` JSON snapshots when `sessions.write_json_snapshots` is enabled, falling back to read-only queries against `$HERMES_HOME/state.db` otherwise) to extract recurring patterns, preferences, and corrections. Creates new memory-skills from what it finds. Run periodically to capture learnings that weren't explicitly saved.

### `/doctor` — Diagnose problems

Walks the verified Hermes activation checklist:
1. Provider directory exists at `$HERMES_HOME/plugins/memex/`
2. `memory.provider: memex` is set in `$HERMES_HOME/config.yaml`
3. Binary present at `$HERMES_HOME/cache/memex/bin/memex` with ONNX libs alongside
4. `memex.json` parses
5. Scan paths contain skills/memories/rules
6. Model cache and skill index health
7. End-to-end envelope test through the binary

Stop at the first failure; each step has a fix.

### `/handoff` — Continuation plans

Creates a comprehensive handoff document at `<cwd>/.hermes/handoffs/<YYYYMMDD>-<title>.md` so a fresh Hermes session can resume the current work without losing context. Captures objective, completed work, current state, remaining work with full per-item context, failed approaches, gotchas, and explicit "to resume" instructions including the Hermes session ID for `hermes --resume`.

---

## Creating skills

Skills live in `$HERMES_HOME/skills/<name>/SKILL.md` (global) or `<cwd>/.hermes/skills/<name>/SKILL.md` (project-local).

### Regular skill

```yaml
---
name: my-skill
description: "What this skill does"
queries:
  - "when would someone need this"
  - "another example query"
  - "third example"
boost: 0.05  # optional: nudge similarity score for entries near the threshold
---
The actual skill content that gets injected.
```

### Memory-skill

A short preference or fact with minimal body:

```yaml
---
name: prefer-pnpm
description: Always use pnpm instead of npm for package management
type: memory
queries:
  - "install dependencies"
  - "run npm install"
  - "which package manager"
---
Use `pnpm` instead of `npm` for all operations:
- `pnpm install`, `pnpm add <pkg>`, `pnpm run <script>`
```

### Rule

```yaml
---
name: no-force-push
description: "Never force-push to main or master branches"
type: rule
queries:
  - "git push"
  - "force push"
  - "push to main"
one-liner: "Never force-push to main/master."
---
Never run `git push --force` (or `--force-with-lease`) against `main`, `master`,
or any protected branch. Use a feature branch + PR + squash merge instead.
```

Rules with `one-liner` get graduated disclosure: the full body on first match in a session, the one-liner on subsequent matches in the same session.

---

## Troubleshooting

For the full diagnostic checklist, run `/doctor`. Quick reference for common symptoms:

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Provider absent from Hermes startup | Directory missing at `$HERMES_HOME/plugins/memex/` | `python -m memex_hermes.install` |
| Provider visible to `hermes plugins list` but inactive | `memory.provider` not set to `memex` | Edit `$HERMES_HOME/config.yaml` |
| Provider visible but another external wins | `MemoryManager` allows only ONE external provider | Choose; only one external can be active |
| Binary missing at `$HERMES_HOME/cache/memex/bin/memex` | First-run download not triggered | Invoke `$HERMES_HOME/plugins/memex/bin/memex` once — the wrapper downloads + SHA256-verifies |
| Subprocess timeouts | Cold start past 10s budget (or larger budget for `Hermes.session-end`) | Check binary cold-start time; consider warmer cache; check `prefetch.maxInjectedChars` isn't huge |
| `{}` empty matches on every prompt | No skills/memories in scan paths | Create entries under `$HERMES_HOME/skills/` |
| `{}` empty matches | Threshold too high | Lower `prefetch.threshold` in `memex.json` |
| Sync push failures (non-fast-forward) | Concurrent adapter pushed first | Automatic: `sync.pushRetries` rebase loop runs 3 times with backoff |
| Sync push failures (auth) | SSH key or token missing | Test manually: `git -C ~/.local/share/memex-hermes push` |
| Sync repo never populated for a session | `_session/*` project ID (no real cwd) | Use `memex_remember` with `scope: "project"` to promote; or launch Hermes from inside a real project directory |
| `MEMORY.md` edits not mirroring | `Hermes.memory-write` AND mtime-watcher both should be running | Verify with `/doctor` step 5; remember that `remove` actions arrive only via the mtime-watcher per `SPIKE-COMPLETE.md` Q1 |

For deeper diagnosis, run `/doctor`, then check the Hermes logs (default `$HERMES_HOME/logs/`) for lines prefixed `memex:`.

---

## References

- Architecture and design rationale: [`docs/specs/2026-05-25-memex-hermes-adapter-design.md`](docs/specs/2026-05-25-memex-hermes-adapter-design.md)
- Verified Hermes v0.14.0 contract: [`spike/SPIKE-COMPLETE.md`](spike/SPIKE-COMPLETE.md)
- OpenSpec change: [`openspec/changes/bootstrap-memex-hermes-adapter/`](openspec/changes/bootstrap-memex-hermes-adapter/)
- Shared engine: [`@jim80net/memex-core`](https://github.com/jim80net/memex-core)
- Sibling adapters: [`memex-claude`](https://github.com/jim80net/memex-claude), [`memex-openclaw`](https://github.com/jim80net/memex-openclaw)
