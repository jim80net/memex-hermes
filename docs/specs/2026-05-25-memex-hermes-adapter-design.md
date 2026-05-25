# memex-hermes — Adapter Design

**Status:** Draft v2 (post-systems-review)
**Date:** 2026-05-25
**Author:** jim80net (drafted via brainstorming session)
**Related:** [`@jim80net/memex-core`](https://github.com/jim80net/memex-core), [`memex-claude`](https://github.com/jim80net/memex-claude), [`memex-openclaw`](https://github.com/jim80net/memex-openclaw)
**Review history:** v1 → systems-review → v2 with findings F1–F12 applied inline (system_prompt_block as static, off-loop subprocess execution, single `hook_event_name` dispatch, rules-via-frontmatter not new dir, `_session/*` sync-suppression, `$HERMES_HOME` propagation, `on_memory_write` verification spike + mtime fallback, file-locking, push-retry, perf budgets).

## 1. Goal

Build a memex adapter for the [Hermes Agent](https://hermes-agent.nousresearch.com/) runtime by NousResearch, in the same family as `memex-claude` (Claude Code) and `memex-openclaw` (OpenClaw). The adapter:

1. Lets a Hermes user benefit from the same semantic skill/memory/rule injection that `memex-claude` users have.
2. Shares the **same on-disk format, telemetry schema, and sync repo layout** as the other adapters, so memories and skills authored in one harness propagate to the others via the `memex` sync repo.

Cross-platform sync is the load-bearing requirement. Every architectural choice that follows defers to that.

## 2. Non-goals (v1)

- Re-implementing the embedding/index engine in Python. The engine lives in `@jim80net/memex-core` and stays there.
- Replacing or competing with Hermes' built-in `MEMORY.md` / `USER.md`. We **co-exist** with it and **mirror** its writes into the memex corpus.
- Long-lived daemon / IPC mode (`memex --serve`). Subprocess per turn is acceptable for v1; daemon is a follow-up.
- Honcho/Mem0-style remote backends. memex is local-first; remote sync is git, not API.
- Voice mode, ACP, browser, vision, or any other Hermes capability beyond the memory pathway.

## 3. Constraints & decisions

| # | Decision | Rationale |
|---|---|---|
| C1 | Integrate as a Hermes **`MemoryProvider`** subclass (not a generic `pre_llm_call` plugin) | First-class contract; gets prefetch/sync_turn/on_session_end/on_memory_write for free; peers with Honcho/Mem0/RetainDB |
| C2 | Engine = **subprocess to the existing `bun build --compile` `memex` binary** | Reuses 100% of memex-core; on-disk format guaranteed byte-identical to other adapters; same artifact downloaded by the same installer pattern |
| C3 | Python plugin distributed via **pip entry point** (`hermes_agent.plugins`) AND copy-into-`~/.hermes/plugins/` | Mirrors the two install paths Hermes documents |
| C4 | Cache root = **`~/.hermes/cache/memex/`**, not `~/.claude/cache/` | Sandboxed per-harness; telemetry stays attributable; sync bridges them at the git layer, not the cache layer |
| C5 | **Rules land in `$HERMES_HOME/skills/<name>/SKILL.md` with `type: rule` in frontmatter** — no new on-disk directory | Hermes' Skills UI/CLI/Hub already surfaces this dir; inventing `$HERMES_HOME/rules/` would create a foreign directory that doesn't appear in `hermes skills` / SkillsHub. memex-core already differentiates entries by frontmatter `type:` field. (Reversed from v0 draft per systems-review F4.) |
| C6 | Sync repo path = **`~/.local/share/memex-hermes/`** | Parallels `~/.local/share/memex-claude/`; same git repo URL can be configured for both adapters |
| C9 | **All path resolution derives from `$HERMES_HOME`** (default `~/.hermes/`), captured during `initialize()` and confirmed in `save_config(values, hermes_home)` | The `MemoryProvider.save_config` signature passes `hermes_home` explicitly; hardcoding `~/.hermes/` breaks for users who set `HERMES_HOME=/data/hermes`. (Per systems-review F6.) |
| C10 | **All binary invocations run off the agent's event loop** via `asyncio.to_thread(...)` (one-shot) or a daemon thread with bounded queue (`sync_turn`, `on_memory_write`) | Hermes docs explicitly mandate `sync_turn() MUST be non-blocking`. A subprocess fork from a `def` method on the async loop blocks; routing through a thread satisfies the contract. (Per systems-review F2.) |
| C11 | **Engine dispatch reuses `HookInput.hook_event_name`** (e.g., `"Hermes.prefetch"`); no new `--hermes-mode` CLI flag | `memex-core/src/types.ts:94` already defines `hook_event_name: string`; extending the existing switch keeps one dispatch surface across all adapters. (Per systems-review F3.) |
| C12 | **Session-scoped project IDs (`_session/<id>`) are local-cache-only**; sync is suppressed for them regardless of `sync.enabled` | Without this, Hermes sessions that lack a meaningful cwd would push throwaway directories to the shared sync repo on every turn. Promotion to a named project requires an explicit `memex_remember` call with `scope: 'project'` or `'global'`. (Per systems-review F5.) |
| C7 | Treat `~/.hermes/memories/MEMORY.md` and `USER.md` as **indexed memory entries**, not opaque blobs | Hermes still auto-injects them at session start; we additionally surface them via semantic match when relevant — and mirror writes to the sync repo |
| C8 | The Python plugin **never touches the embedding/cache files directly** — all reads/writes go through the binary | Prevents format drift between the Python layer and memex-core |

## 4. Architecture

```
┌─────────────────────────────────── Hermes Agent (Python) ───────────────────────────────────┐
│                                                                                              │
│  Plugin discovery → register(ctx) → ctx.register_memory_provider(MemexProvider())            │
│                                                                                              │
│  Agent loop                                                                                  │
│     │                                                                                        │
│     ├──► prefetch(query)              ──┐                                                    │
│     ├──► queue_prefetch(query)          │                                                    │
│     ├──► sync_turn(user, assistant)     │   ALL invocations dispatched off the event loop    │
│     ├──► on_session_end(messages)       ├──►  MemexProvider (Python)                         │
│     ├──► on_memory_write(action, …)     │       │   asyncio.to_thread / daemon thread        │
│     ├──► system_prompt_block()  *cached │       │  builds JSON HookInput envelope            │
│     └──► handle_tool_call(name, args) ──┘       ▼                                            │
│                                              subprocess: memex   (stdin JSON, stdout JSON)   │
│                                              dispatch on input.hook_event_name = "Hermes.*"  │
└─────────────────────────────────────────────────│────────────────────────────────────────────┘
                                                  │ JSON stdin / JSON stdout
                                                  ▼
                  ┌────────────────────────────────────────────────────────┐
                  │  memex binary  (bun build --compile, shared artifact)  │
                  │                                                        │
                  │  @jim80net/memex-core:                                 │
                  │    SkillIndex • LocalEmbeddingProvider                 │
                  │    cache • telemetry • traces • sync • session         │
                  │                                                        │
                  │  + src/core/hermes-paths.ts  (new)                     │
                  │  + src/hooks/hermes-*.ts     (new, mirrors claude/)    │
                  └────────────────────────────────────────────────────────┘
                              │                            │
                              ▼                            ▼
                      ~/.hermes/cache/memex/        ~/.local/share/memex-hermes/  (git)
```

### 4.1 Layered responsibilities

| Layer | Lives in | Responsibility |
|---|---|---|
| **Hermes contract surface** | `memex_hermes/provider.py` | Subclass `MemoryProvider`; translate Hermes lifecycle calls into JSON requests to the binary; format responses for Hermes consumption |
| **Subprocess runner** | `memex_hermes/runner.py` | Always invoked via `asyncio.to_thread()` or a daemon thread (per C10). Spawns the binary with `MEMEX_HERMES_HOME` env (per C9) and pipes a JSON `HookInput` on stdin (per C11). Surfaces stderr to the Hermes logger |
| **Hermes path resolution** | `memex_hermes/paths.py` | Read `$HERMES_HOME/config.yaml` for `external_dirs` (uses `pyyaml`); resolve project-local skill dirs; expose to runner via the `MEMEX_HERMES_HOME` env var. Never hardcodes `~/.hermes/` |
| **User config** | `memex_hermes/config.py` | Load `$HERMES_HOME/memex.json` (parallels `~/.claude/memex.json`); defaults; merge user overrides; produce a JSON-Schema for `get_config_schema()` |
| **Tool surface** | `memex_hermes/tools.py` | Tool schemas + handlers for `memex_search` / `memex_remember` / `memex_recall` |
| **Distribution** | `bin/memex` (Python entry script), `bin/install.sh` | First-run binary download (mirrors `memex-claude/bin/install.sh`); SHA256 verification |
| **Engine events (new)** | `memex-core` (or this repo's `src/`) | Extends the existing `hook_event_name` switch in `src/main.ts` with `Hermes.prefetch`, `Hermes.queue-prefetch`, `Hermes.sync-turn`, `Hermes.session-end`, `Hermes.pre-compress`, `Hermes.memory-write`, `Hermes.system-prompt`, `Hermes.tool-search`, `Hermes.tool-remember`, `Hermes.tool-recall`, `Hermes.init`, `Hermes.health`, `Hermes.shutdown`. **One dispatch surface across all adapters.** |
| **Engine path layer (new)** | `src/core/hermes-paths.ts` (new in this repo, mirrors `claude/paths.ts`) | Resolves `$MEMEX_HERMES_HOME/{skills,memories,cache/memex}` from the env var the Python runner sets |
| **Concurrency safety** | inherited from `memex-core/src/file-lock.ts` | All cache/telemetry/session writes use `withFileLock()` (mkdir-atomic, 5s timeout, 30s stale recovery). Multi-session safety is an engine-level invariant. (Per systems-review F8.) |

### 4.2 Why a Python plugin at all (vs. shipping just the binary)

Hermes' plugin discovery is Python-native (`__init__.py` + `register(ctx)`). The `MemoryProvider` ABC is imported from `agent/memory_provider.py`. There's no documented JSON-stdin contract analogous to Claude Code's hooks. The Python shim is unavoidable; we keep it as thin as possible.

## 5. Hermes `MemoryProvider` method mapping

| Hermes method | Sync/async | When called | memex action | `hook_event_name` | Returns to Hermes |
|---|---|---|---|---|---|
| `name` (property) | sync, no I/O | any | constant `"memex"` | — | `"memex"` |
| `is_available()` | sync | startup | check binary exists, runnable, model cache reachable; runs binary via `asyncio.to_thread` | `Hermes.health` | `bool` |
| `initialize(session_id, **kwargs)` | sync, awaited | session start | capture `session_id` + `hermes_home` (from kwargs or env); warm cache (one embed call); record session in registry | `Hermes.init` | `None` |
| `system_prompt_block()` | sync, **called once at session start; output cached in prompt prefix** | session start | render a **static, session-lifetime** block: memex tool inventory + "sync repo present at X, last pulled Y". **No dynamic per-turn content** — that goes through `prefetch()`. (Per systems-review F1.) | `Hermes.system-prompt` | `str` |
| `prefetch(query)` | sync, awaited per-turn (run in thread per C10) | per-turn, before LLM call | embed query → search index → format prependable context with rule/memory/skill-teaser disclosure | `Hermes.prefetch` | `str` (markdown to prepend to next turn) |
| `queue_prefetch(query)` | sync, fire-and-forget (daemon thread per C10) | per-turn, after response | warm model + cache for next prefetch | `Hermes.queue-prefetch` | `None` |
| `sync_turn(user, assistant)` | sync, **MUST be non-blocking** (daemon thread per C10) | per-turn, after response | append turn to session trace; record telemetry for last-turn injection; detect mtime changes in `$HERMES_HOME/memories/` and mirror them (fallback for F7 if `on_memory_write` doesn't fire) | `Hermes.sync-turn` | `None` |
| `on_session_end(messages)` | sync | session end | extract learnings (if enabled) → write `session-learning` markdown files → commit to sync repo | `Hermes.session-end` | `None` |
| `on_pre_compress(messages)` | sync | before compression | snapshot current project memory to sync repo before compression discards it | `Hermes.pre-compress` | `None` |
| `on_memory_write(action, target, content)` | sync, daemon thread | when Hermes built-in memory writes | mirror MEMORY.md/USER.md write into `~/.local/share/memex-hermes/projects/<id>/memory/<target>.md`; commit. **Behavior verified during F7 spike; falls back to mtime-watcher in `sync_turn` if not fired.** | `Hermes.memory-write` | `None` |
| `shutdown()` | sync | session end | flush telemetry; wait for in-flight git push (bounded, ≤5s) | `Hermes.shutdown` | `None` |
| `get_tool_schemas()` | sync, pure Python | startup | return list of tool schemas (from `tools.py`, no binary call). **Schema dict shape conforms to `ctx.register_tool` example from Build-a-Hermes-Plugin guide; F11 spike will verify against `agent/memory_provider.py`.** | — | `list[dict]` |
| `handle_tool_call(name, args)` | sync, awaited | when agent calls a `memex_*` tool | dispatch to the right `Hermes.tool-*` event | `Hermes.tool-search` / `tool-remember` / `tool-recall` | `str` (JSON) |
| `get_config_schema()` | sync, pure Python | startup | return JSON Schema (from `config.py`) | — | `dict` |
| `save_config(values, hermes_home)` | sync | config UI/CLI write | write `<hermes_home>/memex.json` — **use the `hermes_home` argument, never hardcode `~/.hermes/`** (per C9) | — | `None` |

**Engine dispatch.** Each binary invocation reads a single JSON `HookInput` from stdin and writes a single `HookOutput` JSON object to stdout (see `memex-core/src/types.ts:94-106`). The `hook_event_name` field selects the handler. The existing `src/main.ts` `switch (input.hook_event_name)` is extended with the `Hermes.*` cases listed above — **no new CLI flags, no parallel dispatch surface** (per C11).

**Pre-implementation verification spike (F7 + F11).** Before writing the `MemexProvider` class, build a 30-line print-debug plugin that subclasses `MemoryProvider` and prints every callback's name + args. Run `hermes` interactively, exercise: built-in `remember` tool, normal turn, session end, compression. Record what fires, what doesn't, and the exact argument shapes. **Findings get folded back into this spec before implementation begins.**

## 6. Tool surface

Three provider-specific tools, exposed to the agent via `get_tool_schemas()`:

| Tool | Purpose | Args | Returns |
|---|---|---|---|
| `memex_search` | Explicit semantic search when the agent wants to look something up deliberately (cf. `honcho_search`, `mem0_search`) | `{"query": str, "limit"?: int=5, "types"?: [str]}` | `{"results": [{"name", "type", "score", "location", "snippet"}]}` |
| `memex_remember` | Persist a fact/preference into project memory (cf. `viking_remember`) | `{"content": str, "scope"?: "project"\|"global"="project", "type"?: "memory"\|"rule"="memory"}` | `{"written": str (path), "synced": bool}` |
| `memex_recall` | Pull a specific entry by name (cf. `hindsight_recall`) | `{"name": str}` | `{"content": str, "frontmatter": dict}` |

`memex_search` is what makes memex visible to the agent. `prefetch()` does the implicit injection; `memex_search` lets the agent dig further when the implicit pull missed.

`memex_remember` is the write path the agent uses. It's distinct from Hermes' built-in `remember` tool — Hermes' tool writes to `~/.hermes/memories/MEMORY.md` (which we mirror via `on_memory_write`). `memex_remember` writes directly into the memex corpus (sync repo gets it on next push) and skips MEMORY.md entirely. The agent picks which based on whether the fact should live in the always-injected front-of-context (`remember`) or the semantic back-of-context (`memex_remember`).

## 7. User config schema

Lives at `$HERMES_HOME/memex.json` (default `~/.hermes/memex.json`). Parallels `~/.claude/memex.json` field-for-field where the concepts overlap; Hermes-specific where they don't.

```jsonc
{
  "enabled": true,
  "embeddingModel": "Xenova/all-MiniLM-L6-v2",
  "cacheTimeMs": 300000,
  "skillDirs": [],                       // extra dirs beyond $HERMES_HOME/skills and external_dirs
  "memoryDirs": [],                      // extra memory dirs (e.g., shared/ pattern from openclaw)
  // ruleDirs intentionally absent — rules live in $HERMES_HOME/skills/ with type: rule (C5)
  "sync": {
    "enabled": false,
    "repo": "",                          // git URL; same URL as memex-claude → cross-platform sync
    "autoPull": true,                    // on initialize()
    "autoCommitPush": true,              // on sync_turn / on_memory_write / on_session_end
    "suppressSessionIds": true,          // never push _session/<id> entries to remote (C12)
    "pushRetries": 3,                    // retries with rebase on non-fast-forward (F9)
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
    "extractionModel": ""                // empty → use Hermes' active model via its API; non-empty → direct call
  },
  "mirrorHermesMemory": true              // wire on_memory_write to mirror MEMORY.md/USER.md into the sync repo
}
```

`get_config_schema()` returns a JSON-Schema rendering of the above so Hermes' config UI / CLI can validate it.

## 8. Write-mirror & cross-platform sync semantics

This is the load-bearing feature.

### 8.1 The two write directions

```
Hermes built-in memory write                       memex agent tool write
  (agent uses Hermes' `remember`)                   (agent uses `memex_remember`)
              │                                              │
              ▼                                              ▼
  ~/.hermes/memories/MEMORY.md                  ~/.local/share/memex-hermes/projects/<id>/memory/<topic>.md
              │                                              │
   on_memory_write fires                                     │
              │                                              │
              ▼                                              │
   provider.on_memory_write(…)                               │
              │                                              │
              ▼                                              │
   binary writes a mirror file to                            │
   ~/.local/share/memex-hermes/projects/<id>/memory/MEMORY.md
              │                                              │
              └──────────────┬───────────────────────────────┘
                             ▼
                  git commit + push (autoCommitPush)
                             │
                             ▼
         remote git repo (shared with memex-claude / memex-openclaw)
                             │
                             ▼
             other adapters pull on their next SessionStart
```

### 8.2 Project ID canonicalization

A turn happens in some `cwd`. The project ID is derived the same way `memex-core` already does it:

- git project → `host/owner/repo` (from `git remote get-url origin`)
- non-git project → `_local/<encoded-path>`

Hermes doesn't really have a "current workspace" the way Claude Code does — agent sessions are conversational, not directory-scoped. So:

- If the agent was started from a directory inside a git repo, use that. (Hermes sessions are spawned from a `cwd`.)
- Otherwise, use the session id as the project ID under `_session/<session_id>` — **this entry is local-cache-only; sync push is suppressed for `_session/*` IDs even with `sync.enabled = true` and `autoCommitPush = true` (C12).** Promotion to a named, syncable project requires an explicit `memex_remember` call with `scope: 'project'` (which prompts for a project name) or `scope: 'global'`.

### 8.3 Conflict handling

Inherits memex-core's git conflict policy: rebase pull, auto-resolve markdown conflicts at the file level (last-write-wins per stanza for memory; line-merge for rules; reject conflict and surface for skills).

**Cross-adapter push race recovery (F9).** When multiple adapters push to the same remote concurrently, the second push gets rejected (non-fast-forward). On rejection, the engine retries `git pull --rebase` + `git push` up to `sync.pushRetries` (default 3) times with exponential backoff (200 ms, 400 ms, 800 ms). After exhausting retries, the local commit stays in the branch and a warning surfaces via the Hermes logger; the next session's `initialize()`-time pull catches up. If memex-core does not yet implement this retry loop, an upstream issue is filed and tracked against this spec.

### 8.4 `on_memory_write` verification gate (F7)

The MEMORY.md mirror path in §8.1 depends on Hermes firing `on_memory_write` when its built-in `remember` tool writes to MEMORY.md. The Hermes docs strongly suggest this but do not prove it. **Before implementation, a one-file verification spike runs:**

```python
# spike/verify_on_memory_write.py
from agent.memory_provider import MemoryProvider

class TraceProvider(MemoryProvider):
    name = "trace"
    def is_available(self): return True
    def initialize(self, session_id, **kw): print(f"init {session_id} kw={kw}")
    def on_memory_write(self, action, target, content):
        print(f"FIRED: action={action} target={target} content_len={len(content)}")
    # ... stubs for other required methods
```

Run `hermes plugins enable trace`, exercise the built-in `remember` tool, observe whether `FIRED:` prints. **Two outcomes:**

- **Fires for built-in writes:** proceed as designed. `on_memory_write` is the mirror trigger.
- **Does not fire (only fires for provider-owned writes):** fall back to the **mtime-watcher fallback already wired into `sync_turn()`** (§5). On every `sync_turn` call we compare mtimes on `$HERMES_HOME/memories/{MEMORY,USER}.md` against the values we recorded on the previous `sync_turn` (cached in `$HERMES_HOME/cache/memex/memory-mtimes.json`); any change triggers a mirror + commit. This is a simple, reliable fallback that costs one `stat` call per turn.

Both code paths are implemented; the verification spike picks which is primary. This avoids guessing about an unproven contract.

## 9. Distribution & install

Two paths, mirroring Hermes' documented options:

**A. Pip-installable package** (recommended for distribution):
```toml
# pyproject.toml
[project.entry-points."hermes_agent.plugins"]
memex = "memex_hermes"
```
```bash
pip install memex-hermes
hermes plugins enable memex
```
On first `register()` call, the bundled `bin/memex` wrapper downloads the right prebuilt binary for the platform into `~/.hermes/cache/memex/bin/`. SHA256 verified against `checksums.txt` shipped in the GitHub release.

**B. Manual clone into `~/.hermes/plugins/`** (for developers):
```bash
git clone https://github.com/jim80net/memex-hermes ~/.hermes/plugins/memex
~/.hermes/plugins/memex/bin/install.sh    # downloads binary
hermes plugins enable memex
```

The binary download wrapper is reused unchanged from `memex-claude/bin/install.sh` — both projects share the same upstream `memex` binary releases.

## 10. Failure modes & error handling

| Failure | Detection | Response |
|---|---|---|
| Binary missing | `is_available()` returns False; `runner` raises FileNotFoundError | Log via Hermes logger; print install hint; `prefetch()` returns `""`; provider effectively no-ops without crashing the agent |
| Binary crashes (non-zero exit) | runner reads exit code | Log stderr; return empty result; do not retry within same turn |
| Binary returns invalid JSON | runner json.loads fails | Log raw output; return empty result |
| Subprocess timeout (default 10s for prefetch, 30s for session-end) | runner uses `asyncio.wait_for` | Cancel subprocess; log; return empty |
| Embedding model download fails on first run | binary returns `{"error": "model_download_failed"}` | One-shot fall back to dummy zero-vector embeddings? **No** — better to surface clearly: provider becomes unavailable until model is present. User runs `memex doctor` (existing skill) to repair |
| Git sync fetch/push fails | binary logs and returns `{"warning": "..."}` | Surface as a Hermes log warning; never blocks the turn |
| `~/.hermes/config.yaml` malformed (can't read `external_dirs`) | YAML parse error in `paths.py` | Skip `external_dirs`; log; continue with global dir only |

Per the user's rule "never automatically mock; always fix the integrated environment first" — no silent fallbacks that mask configuration errors. Every failure mode either surfaces clearly or no-ops with a log.

## 10.1 Concurrency invariants

| Invariant | Mechanism |
|---|---|
| Concurrent Hermes sessions on the same host never corrupt the cache | `memex-core/src/file-lock.ts` `withFileLock()` wraps every write to `memex-cache.json`, `memex-telemetry.json`, session files, project registry. Mkdir-atomic lock with 5s timeout, 30s stale recovery. (F8.) |
| Concurrent adapters on the same machine pushing to the same sync repo | `sync.pushRetries` with rebase per §8.3. (F9.) |
| `sync_turn()` and `on_memory_write()` never block the agent's event loop | Daemon thread with bounded work queue; queue overflow drops the oldest pending sync and logs. (C10, F2.) |
| Binary cold-start time stays under the per-turn budget | Success criterion in §14 caps `prefetch()` round-trip at 200 ms on warm cache; if exceeded on representative hardware, the daemon-mode follow-up (currently a non-goal) gets fast-tracked. (F10.) |

## 11. Testing strategy

| Layer | Test type | Tools |
|---|---|---|
| `memex_hermes/provider.py` | Unit: mock `runner` to assert correct JSON envelopes per method | pytest + unittest.mock |
| `memex_hermes/paths.py` | Unit: tmp `~/.hermes/config.yaml` fixtures; verify external_dirs / env expansion | pytest |
| `memex_hermes/config.py` | Unit: round-trip merge against defaults; schema validation | pytest + jsonschema |
| `memex_hermes/tools.py` | Unit: schema validation; handler dispatch | pytest |
| Binary `--hermes-mode` modes | Unit (TS): existing vitest harness; mirror `test/hooks/` patterns | vitest |
| End-to-end | Integration: real Hermes install in a docker container, real prebuilt binary, asserts injection appears in the LLM prompt | docker-compose + scripted Hermes session |
| Cross-platform sync | Integration: run `memex-claude` and `memex-hermes` against the same git repo; write from one, read from the other | scripted multi-container |

E2E lives in `test/e2e/` and is opt-in (gated behind `MEMEX_E2E=1`) because it requires the Hermes binary and a real embedding model download.

**Three additional tests covering systems-review findings:**

1. **F2 non-blocking test.** Mock `runner` to sleep 500 ms. Call `provider.sync_turn(...)` from an asyncio task; assert the calling task is suspended for < 5 ms (proving the subprocess work happens off-loop).
2. **F7 `on_memory_write` empirical test.** The verification spike (§8.4) is also a regression test: re-run on every Hermes upgrade to detect contract changes.
3. **F8/F9 concurrency tests.** Spawn two binaries concurrently, both writing to the same `memex-cache.json` and pushing to the same sync repo. Assert: (a) cache JSON parses cleanly after both finish; (b) push retry loop runs at most 3 times; (c) all writes appear on remote.

## 12. Repo layout

```
memex-hermes/
├── README.md                            ← user-facing intro (mirrors memex-claude tone)
├── CLAUDE.md                            ← AI dev guide (per Jim's convention)
├── CONTRIBUTING.md                      ← dev setup
├── LICENSE                              ← MIT
├── pyproject.toml                       ← Python pkg metadata + entry point
├── package.json                         ← Node side (TS engine extensions)
├── tsconfig.json
├── biome.json                           ← linter (matches openclaw)
├── vitest.config.ts                     ← TS tests
├── pytest.ini                           ← Python tests
├── plugin.yaml                          ← Hermes manifest (for manual-clone install)
├── bin/
│   ├── memex                            ← Python entry wrapper that exec's the downloaded binary
│   ├── install.sh                       ← borrowed/forked from memex-claude
│   └── checksums.txt                    ← CI-generated for releases
├── memex_hermes/                        ← Python package
│   ├── __init__.py                      ← contains `register(ctx)` AND ABC subclass
│   ├── provider.py                      ← MemexProvider(MemoryProvider)
│   ├── runner.py                        ← subprocess wrapper
│   ├── paths.py                         ← Hermes path resolution
│   ├── config.py                        ← config loader + schema
│   └── tools.py                         ← tool schemas + handlers
├── src/                                 ← TS — new hermes-specific extensions to the engine
│   ├── main.ts                          ← entry: dispatch on --hermes-mode
│   ├── core/
│   │   ├── hermes-paths.ts              ← parallels claude/paths.ts
│   │   ├── config.ts                    ← parallels claude/config.ts (reads ~/.hermes/memex.json)
│   │   └── session.ts                   ← file-based session, reused pattern
│   └── hooks/
│       ├── prefetch.ts                  ← analog of claude/hooks/user-prompt.ts
│       ├── sync-turn.ts
│       ├── session-end.ts               ← analog of claude/hooks/stop.ts
│       ├── memory-write.ts              ← mirror MEMORY.md to sync repo
│       ├── system-prompt.ts
│       └── tool.ts                      ← memex_search / memex_remember / memex_recall handlers
├── skills/                              ← bundled skills (parallels memex-claude/skills/)
│   ├── sleep/SKILL.md
│   ├── deep-sleep/SKILL.md
│   ├── doctor/SKILL.md
│   └── handoff/SKILL.md
├── test/
│   ├── python/                          ← pytest
│   └── ts/                              ← vitest
├── docs/
│   └── specs/
│       └── 2026-05-25-memex-hermes-adapter-design.md   ← this file
└── openspec/                            ← (will be created by /opsx:propose)
```

## 13. Open questions

1. **Whether to extend `memex-core` directly with `hermes-paths.ts` or keep it in this repo's `src/`.** Recommendation: this repo's `src/`, then merge upstream once stable (same evolution path memex-claude took).
2. **Whether `memex_remember` should also append to Hermes' `MEMORY.md`** for visibility in the auto-injected front-of-context. Default: no — agent decides explicitly via which tool it calls.
3. **Sleep schedule.** memex-claude has `bin/sleep-schedule.sh` driving a cron. Hermes has its own cron system (per docs `/automation/cron-jobs`) — we should integrate via that, not a parallel system. Out of scope for v1; spec it as a v1.1 follow-up.
4. **Voice/multimodal turns.** Hermes supports voice and vision. We only see the text representation that hits `prefetch(query)`. v1 ignores the modality; v1.x can consider richer signals.
5. **Tool namespace collision.** `memex_search` / `memex_remember` / `memex_recall` are namespaced with the `memex_` prefix; collisions with other registered memory providers are not handled (first-registered wins per Hermes plugin docs). Documented for users.

## 14. Success criteria for v1

- [ ] `pip install memex-hermes` followed by `hermes plugins enable memex` produces a working install with no extra steps.
- [ ] A skill authored in `$HERMES_HOME/skills/foo/SKILL.md` is matched and surfaced by Hermes when the user types a relevant query.
- [ ] A memory written via `memex_remember` from a Hermes session is visible to a `memex-claude` session running against the same sync repo within one sync cycle.
- [ ] A memory written via Hermes' built-in `remember` tool (to `MEMORY.md`) is mirrored to the sync repo on the next `on_memory_write` event OR (fallback) on the next `sync_turn` mtime-watcher pass.
- [ ] On a clean machine with no model cache, first invocation downloads the ONNX model and completes prefetch within 10 seconds.
- [ ] **Steady-state `prefetch()` round-trip < 200 ms on warm cache** (subprocess fork + embed + search). If exceeded, the `memex --serve` daemon-mode follow-up is fast-tracked. (F10.)
- [ ] **`sync_turn()` returns within 5 ms** of the Hermes agent loop's invocation (work happens off-loop in a daemon thread). (F2.)
- [ ] Failure of the binary (missing, crashed, timeout) never crashes a Hermes session.
- [ ] Same prebuilt binary artifact runs for both `memex-hermes` and `memex-claude` (we share, not fork, the upstream release).
- [ ] Verification spike from §8.4 has run and informed the chosen `on_memory_write` strategy (primary path vs. mtime-fallback).
- [ ] **No `_session/*` IDs appear in the remote sync repo** after a week of normal multi-session usage. (C12.)
- [ ] Two concurrent Hermes sessions on the same host complete a turn each without cache JSON corruption. (F8.)
- [ ] `$HERMES_HOME` set to a non-default value is honored end-to-end (config write, scan dirs, cache, sync repo identification). (C9, F6.)
