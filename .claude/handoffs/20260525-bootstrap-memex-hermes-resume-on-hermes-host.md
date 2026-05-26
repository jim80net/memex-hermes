# Handoff: bootstrap memex-hermes — resume on a host with Hermes Agent installed

**Date:** 2026-05-25
**Branch:** `main`
**Working directory:** `/home/jim/workspace/github.com/jim80net/memex-hermes`
**Repo state:** clean working tree, 4 commits, **no remote configured yet**
**OpenSpec progress:** 9 / 90 tasks complete; paused at the verification spike

---

## Objective

Bootstrap **`memex-hermes`** — a memex adapter for [Hermes Agent](https://hermes-agent.nousresearch.com/) (NousResearch) — as a peer to the existing `memex-claude` and `memex-openclaw` adapters. The defining property of the memex family is **cross-platform sync**: knowledge authored in one harness must propagate to the others via a shared git sync repo with byte-identical on-disk format.

The chosen architecture (locked in this session, codified as openspec change `bootstrap-memex-hermes-adapter`):

- **C2 + E1**: Python `MemoryProvider` subclass that subprocess-spawns the **existing prebuilt `memex` binary** shipped by `memex-claude` (same `bun build --compile` artifact).
- **Why share the binary?** Re-implementing memex-core in Python would fork the canonical on-disk format and threaten sync compatibility forever. Sharing the engine guarantees format compatibility by construction.
- **Why MemoryProvider (not a generic pre_llm_call plugin)?** memex *is* a memory layer; the first-class contract gives us prefetch / sync_turn / on_session_end / on_memory_write / system_prompt_block / tool registration, all peering with Honcho/Mem0/RetainDB/Hindsight.

This session got us from empty directory → fully-specced + scaffolded repo + spike trace provider. **The next milestone is running the spike against a live Hermes session** to verify three contract assumptions before writing real implementation code (`on_memory_write` firing semantics, `initialize`/`save_config` kwarg shapes, tool-schema dict shape).

This dev box (`/home/jim/workspace/github.com/jim80net/memex-hermes` on Linux WSL2) does not have Hermes Agent installed. The next session needs to be on a host that does.

---

## Session Summary

Started from `/home/jim/workspace/github.com/jim80net/memex-hermes/` which was completely empty. Walked the standard development flow:

1. Brainstormed the adapter shape (C1/C2 contract choice, E1/E2/E3 engine choice) → user picked **C2 + E1**.
2. Read Hermes docs (memory-providers, plugins, build-a-hermes-plugin, hooks, skills, memory, llms.txt index, prompt-assembly, developer-guide/memory-provider-plugin) to recover the actual MemoryProvider contract.
3. Walked the user through architectural sections one at a time (paths & on-disk layout) — they then said "skip ahead: /systems-review then opsx:propose then /systems-review."
4. Wrote the long-form design doc to `docs/specs/2026-05-25-memex-hermes-adapter-design.md` (395 lines), invoked `/systems-review` skill, got back 12 findings (F1–F12). Applied all 12 inline → v2 design.
5. Ran `openspec new change "bootstrap-memex-hermes-adapter"` and generated all 4 artifacts (proposal, design, 6 capability spec files, tasks) using `openspec instructions <artifact> --json` for each. All artifacts validated via `openspec validate`.
6. Invoked `/systems-review` again on the openspec artifacts. Got back 9 findings (G1–G19), mostly LOW/MEDIUM — none critical. Applied them all inline.
7. User said "go ahead and run opsx:apply." Executed §1 (8 scaffolding files) and §2.1 (spike trace_provider.py + spike/README.md). **Hit the explicit gate at §2.2** which requires running Hermes interactively. Committed and paused.
8. User: "we ought to migrate to a machine that has hermes installed. please prepare to do so writing and saving all artifacts." → this handoff.

---

## Completed Work

### Commit 1: `c111d9c` — `chore: bootstrap memex-hermes repo with v2 design spec`

**What:** Initial git init + design doc + opsx scaffolding (config.yaml only, change not yet created).

**Files:**
- `docs/specs/2026-05-25-memex-hermes-adapter-design.md` (395 lines) — full v2 design with all 14 sections; reflects systems-review F1–F12 applied inline
- `openspec/config.yaml` — opsx project config (empty rules; placeholder)
- `.claude/`, `.opencode/` — opsx slash commands and skills (auto-scaffolded by opsx CLI)

**Why:** Foundation. The 395-line design is the canonical reference for every later decision. F1–F12 baked in (system_prompt_block static, subprocess off-loop, hook_event_name dispatch, rules-via-frontmatter not new dir, _session/* sync-suppression, HERMES_HOME end-to-end, on_memory_write verification gate + mtime fallback, file-locking, push-retry, perf budgets).

### Commit 2: `28a30f5` — `spec: openspec change bootstrap-memex-hermes-adapter`

**What:** All 4 openspec artifacts generated. Validates clean via `openspec validate "bootstrap-memex-hermes-adapter"`.

**Files added:**
- `openspec/changes/bootstrap-memex-hermes-adapter/proposal.md` (39 lines) — Why, What Changes, 6 capabilities, Impact
- `openspec/changes/bootstrap-memex-hermes-adapter/design.md` (119 lines) — Context, Goals/Non-Goals, 10 decisions (D1–D10) with alternatives, risks, migration, open questions
- `openspec/changes/bootstrap-memex-hermes-adapter/specs/hermes-memory-provider/spec.md` (137 lines)
- `openspec/changes/bootstrap-memex-hermes-adapter/specs/hermes-engine-events/spec.md` (127 lines)
- `openspec/changes/bootstrap-memex-hermes-adapter/specs/hermes-path-resolution/spec.md` (76 lines)
- `openspec/changes/bootstrap-memex-hermes-adapter/specs/hermes-plugin-packaging/spec.md` (82 lines)
- `openspec/changes/bootstrap-memex-hermes-adapter/specs/hermes-sync-bridge/spec.md` (105 lines)
- `openspec/changes/bootstrap-memex-hermes-adapter/specs/memex-tool-surface/spec.md` (83 lines)
- `openspec/changes/bootstrap-memex-hermes-adapter/tasks.md` (143 lines) — 14 task groups, originally 70 checkboxes (now 90 after G1/G2/G3/G18 amendments)

### Commit 3: `a3c1e59` — `spec: apply systems-review v2 findings to openspec change`

**What:** Round-2 systems-review of the openspec artifacts found 9 gaps (G1–G19). All MEDIUMs and LOWs. Applied inline.

**Spec amendments:**
- **G1**: Added `hermes-memory-provider` Requirement "Python layer never re-implements engine functionality" with two Scenarios (no embedding imports, no direct git subprocess).
- **G2**: Added `hermes-engine-events` Requirement "Lifecycle and write events return well-formed responses" with Scenarios for `Hermes.health`, `init`, `system-prompt`, `memory-write`, `queue-prefetch`, `pre-compress`, `shutdown`.
- **G3**: Added `hermes-memory-provider` Requirements for method→event dispatch invariant AND bounded `shutdown()` drain (≤5s).
- **G9**: Removed "spike re-runs on Hermes upgrade" as runtime Scenario; folded into CONTRIBUTING.md Maintenance section.
- **G19**: Clarified `hermes-sync-bridge` that BOTH mirror paths (callback + mtime-watcher) ship; spike picks primary only.

**Task amendments:**
- **G12**: Added explicit `**Blocked by: §2.**` headers to §3, §4, §6, §7, §8. Added §2.7 to create `spike/SPIKE-COMPLETE.md` as the visible gate.
- **G14/G15**: §4.10 (push retry) and §4.11 (`_session/*` suppression) now state "implementation lives in this repo's `src/`; do NOT modify memex-core for v1."
- **G17**: §4.4 (`Hermes.session-end` extraction) changed from "Hermes' active model" to **explicit `extractionModel` config**. Deferred-active-model path → v1.x.
- **G16**: §6.3 marked dependent on §4 envelope decisions.
- **G18**: §7.2 split into 7.2a (lifecycle) / 7.2b (runtime dispatch) / 7.2c (write & end-of-life).
- New tests: §8.7 (shutdown drain), §8.8 (dispatch invariant), §8.9 (no-Python-engine grep).
- §13.2 expanded to require the spike-rerun process gate.

All 4 artifacts re-validated cleanly.

### Commit 4: `4d06b27` — `feat: scaffold repo and trace provider for verification spike`

**What:** Tasks §1.1–§1.8 (all 8 scaffolding files) and §2.1 (spike trace provider).

**Files added:**

| File | Purpose | Notes |
|---|---|---|
| `pyproject.toml` | PEP 621 metadata + hatchling build + `[project.entry-points."hermes_agent.plugins"]` entry `memex = "memex_hermes"`; pytest/mypy/ruff config inlined | `[tool.memex-hermes.binary] upstream-release = "memex-claude@v1.5.0"` is the placeholder pin for which binary to download |
| `package.json` | Private (not published to npm); TypeScript devDeps; consumes `@jim80net/memex-core@^0.3.1` | Engine extension is bundled into the binary, not published separately |
| `tsconfig.json` | Mirrors `memex-claude/tsconfig.json` — ES2022, strict, bundler resolution | |
| `biome.json` | Lint/format config from `memex-openclaw` | |
| `vitest.config.ts` | Tests under `test/ts/**`; excludes `test/python`, `test/e2e` | |
| `plugin.yaml` | Hermes manifest. `provides_memory_providers: [memex]`. `provides_tools: [memex_search, memex_remember, memex_recall]` | |
| `LICENSE` | MIT, 2026 Jim Park (mirrors memex-claude) | |
| `README.md` | User-facing intro with install paths (PyPI / manual / source), how-it-works diagram, config example, cross-platform-sync explainer | |
| `CONTRIBUTING.md` | Dev setup, two-source-tree explainer, the spike + maintenance policy | |
| `CLAUDE.md` | AI dev guide. Lists 7 key invariants (no-Python-engine, off-loop, static system_prompt_block, HERMES_HOME end-to-end, _session/* no-sync, both mirror paths, hook_event_name dispatch). References design doc + openspec change. | |
| `.gitignore` | Node + Python + spike trace logs | |
| `spike/trace_provider.py` | Self-contained `MemoryProvider` subclass that logs every callback to `$HERMES_HOME/cache/memex-trace.log`. **Imports `from agent.memory_provider import MemoryProvider`** and raises `SystemExit` with a clear error if Hermes isn't installed | This is **§2.1**, ready to run on the Hermes host |
| `spike/README.md` | Step-by-step instructions for installing the spike, running Hermes, and capturing the 7 critical findings | The runbook the next session follows |
| `memex_hermes/`, `test/python/`, `test/ts/`, `spike/` | Empty skeleton dirs | Created via `mkdir -p` |

Tasks §1.1–§1.8 and §2.1 marked `- [x]` in `openspec/changes/bootstrap-memex-hermes-adapter/tasks.md`.

### Key Decisions (all locked, all in openspec design.md as D1–D10)

| # | Decision | Rationale | Alternatives Rejected |
|---|---|---|---|
| **D1** | Integrate as `MemoryProvider` (not generic `pre_llm_call` plugin) | First-class contract; peers with Honcho/Mem0/RetainDB; richer lifecycle | Generic plugin hook (simpler but less idiomatic) |
| **D2** | Engine = subprocess to existing prebuilt `memex` binary | Guarantees byte-identical on-disk format with other adapters | Pure-Python port (forks format); long-lived daemon (deferred to v1.x) |
| **D3** | Reuse `HookInput.hook_event_name` string; no new `--hermes-mode` CLI flag | `memex-core/src/types.ts:94` already defines it; single dispatch surface | `--hermes-mode` flag (forks argument parsing) |
| **D4** | All subprocess invocations run off agent's event loop | Hermes docs mandate `sync_turn() MUST be non-blocking` | sync subprocess.run from `def` method (blocks loop) |
| **D5** | `system_prompt_block()` returns static, session-lifetime content | Hermes' Layer 5/6 prompt-prefix is cached; dynamic content would burn cache | Dynamic per-turn (treat like prefetch) |
| **D6** | Rules in `$HERMES_HOME/skills/<name>/SKILL.md` with `type: rule` frontmatter | Hermes Skills UI/CLI surfaces this dir; new `rules/` would be invisible | New `$HERMES_HOME/rules/` directory |
| **D7** | `_session/<id>` fallback project IDs are local-cache-only (no sync push) | Without suppression, every Hermes turn would push throwaway dirs to remote | Push them like any other project |
| **D8** | `$HERMES_HOME` propagates end-to-end; never hardcode `~/.hermes/` | `save_config(values, hermes_home)` explicitly passes hermes_home | Hardcode the default |
| **D9** | Empirical verification spike before implementation | `on_memory_write` firing semantics for built-in MEMORY.md unverified by public docs | Assume yes/no without verifying |
| **D10** | Sync push race recovery: rebase-retry with bounded backoff (3 retries, 200/400/800 ms) | Cross-adapter concurrent pushes will collide | Fail-fast; retry indefinitely |

### Investigations & Research

**What** | **Finding** | **Where**
---|---|---
Hermes plugin contract | Python `register(ctx)` in `__init__.py`; plugin.yaml manifest; lives in `$HERMES_HOME/plugins/<name>/` or pip-installed via `[project.entry-points."hermes_agent.plugins"]` | webfetch of `/docs/user-guide/features/plugins` and `/docs/guides/build-a-hermes-plugin`
MemoryProvider ABC surface | 15 methods: `name`, `is_available`, `initialize(session_id, **kwargs)`, `get_tool_schemas`, `handle_tool_call(name, args)`, `get_config_schema`, `save_config(values, hermes_home)`, `system_prompt_block`, `prefetch(query)`, `queue_prefetch(query)`, `sync_turn(user, assistant)`, `on_session_end(messages)`, `on_pre_compress(messages)`, `on_memory_write(action, target, content)`, `shutdown` | webfetch of `/docs/developer-guide/memory-provider-plugin`
Hermes built-in memory | `$HERMES_HOME/memories/{MEMORY.md,USER.md}` — frozen-snapshotted into Layer 5/6 of cached system prompt at session start | webfetch of `/docs/user-guide/features/memory` + `/docs/developer-guide/prompt-assembly`
Hermes skills | `$HERMES_HOME/skills/<name>/SKILL.md`; YAML frontmatter; progressive disclosure via `skills_list()` / `skill_view(name)`; `external_dirs` in `$HERMES_HOME/config.yaml` | webfetch of `/docs/user-guide/features/skills`
memex-core HookInput shape | `{ hook_event_name: string; session_id?: string; transcript_path?: string; cwd?: string; prompt?: string; tool_name?: string; tool_input?: Record<string,unknown> }` | `/home/jim/workspace/github.com/jim80net/memex-core/src/types.ts:94-102`
memex-core file-lock | `mkdir`-based atomic lock with 5 s timeout, 30 s stale recovery. Used for cache/telemetry/session writes | `/home/jim/workspace/github.com/jim80net/memex-core/src/file-lock.ts`
Sibling adapter patterns | memex-claude = standalone binary + JSON-stdin hooks; memex-openclaw = in-process TS plugin with `api.on('before_prompt_build', ...)` | `/home/jim/workspace/github.com/jim80net/memex-claude/src/`, `/home/jim/workspace/github.com/jim80net/memex-openclaw/src/`

---

## Current State

### Git
```
$ git branch --show-current
main

$ git log --oneline
4d06b27 feat: scaffold repo and trace provider for verification spike
a3c1e59 spec: apply systems-review v2 findings to openspec change
28a30f5 spec: openspec change bootstrap-memex-hermes-adapter
c111d9c chore: bootstrap memex-hermes repo with v2 design spec

$ git status --short
(clean working tree)

$ git remote -v
(no remote configured)
```

### OpenSpec
```
$ openspec status --change "bootstrap-memex-hermes-adapter"
Change: bootstrap-memex-hermes-adapter
Schema: spec-driven
Progress: 4/4 artifacts complete  [x] proposal  [x] design  [x] specs  [x] tasks

$ openspec instructions apply --change "bootstrap-memex-hermes-adapter" --json | jq .progress
{
  "complete": 9,
  "remaining": 81
}

$ openspec validate "bootstrap-memex-hermes-adapter"
Change 'bootstrap-memex-hermes-adapter' is valid
```

### Repo layout (top-level + key dirs)
```
memex-hermes/
├── .claude/                 ← opsx commands & skills (do not edit)
├── .gitignore
├── .opencode/               ← opsx for OpenCode (parallel copy of .claude/)
├── CLAUDE.md                ← AI dev guide; documents 7 invariants
├── CONTRIBUTING.md
├── LICENSE                  ← MIT
├── README.md
├── biome.json
├── docs/specs/2026-05-25-memex-hermes-adapter-design.md  ← 395-line v2 design (the canonical reference)
├── memex_hermes/            ← Python package (empty skeleton; first code lands in §6-§7)
├── openspec/
│   ├── config.yaml
│   └── changes/bootstrap-memex-hermes-adapter/
│       ├── proposal.md
│       ├── design.md
│       ├── tasks.md         ← 90 checkboxes; 9 [x], 81 [ ]
│       └── specs/{hermes-memory-provider, hermes-engine-events, hermes-path-resolution, memex-tool-surface, hermes-sync-bridge, hermes-plugin-packaging}/spec.md
├── package.json             ← TypeScript side, private
├── plugin.yaml              ← Hermes manifest
├── pyproject.toml           ← PEP 621
├── spike/
│   ├── README.md            ← step-by-step spike runbook
│   └── trace_provider.py    ← the §2.1 deliverable
├── src/                     ← (does not yet exist; will be created in §3 onward)
├── test/{python,ts}/        ← empty skeletons
├── tsconfig.json
└── vitest.config.ts
```

### What does NOT exist yet
- No git remote — this repo lives only on this dev box. Migration requires either pushing to a remote or rsync.
- No `src/` directory — TypeScript engine extension is fully un-implemented (blocked by §2).
- No code in `memex_hermes/` — Python plugin is fully un-implemented (blocked by §2).
- No `bin/memex` wrapper — distribution path is un-implemented (§9, not blocked by §2 but practically waits for it).
- No bundled `skills/` directory — porting from memex-claude (§10) is not blocked by §2 but practically waits.
- No CI workflows.
- The github.com/jim80net/memex-hermes repo **does not exist on GitHub** (verified via `gh repo view`).

---

## Remaining Work

### 0. **MIGRATE THE REPO TO THE HERMES-EQUIPPED HOST** [BLOCKER]

**What:** Get all 4 commits and the working tree onto a host that has Hermes Agent installed.

**Two options:**

**Option A (recommended) — push to a new GitHub repo:**

```bash
# On THIS machine:
gh repo create jim80net/memex-hermes --private --source=. --remote=origin
git push -u origin main

# On the Hermes host:
git clone git@github.com:jim80net/memex-hermes.git
cd memex-hermes
```

This also unblocks the cross-platform-sync goal long term and gives you a place for PRs.

**Option B — rsync/scp the directory:**

```bash
# On THIS machine:
rsync -avz --exclude='.git/objects/pack' --exclude='node_modules' --exclude='__pycache__' \
  /home/jim/workspace/github.com/jim80net/memex-hermes/ \
  <hermes-host>:~/workspace/github.com/jim80net/memex-hermes/

# Then on the Hermes host, verify:
git -C ~/workspace/github.com/jim80net/memex-hermes log --oneline
```

**Verify:** `git log --oneline` shows the 4 commits above; `git status` shows clean tree; `openspec validate "bootstrap-memex-hermes-adapter"` succeeds.

---

### 1. Run the verification spike [§2.2 → §2.7 of openspec tasks]

**What:** Run `spike/trace_provider.py` against a live Hermes session and capture which `MemoryProvider` callbacks fire with what argument shapes. The spike output drives §8.4 of the design doc and selects the primary mirror path for `on_memory_write` vs the mtime-watcher fallback.

**Where:** `spike/trace_provider.py` (already written); `spike/README.md` (runbook).

**Why it matters:** Hermes' public docs leave several `MemoryProvider` semantics ambiguous. Implementing the real provider without empirical verification risks building on incorrect assumptions. **§3 through §8 of the implementation are explicitly `**Blocked by: §2**` (per G12 amendment) — do not start implementation before the spike clears.**

**Suggested approach — follow `spike/README.md` exactly:**

```bash
cd /path/to/memex-hermes  # the freshly migrated repo

export HERMES_HOME=/tmp/hermes-spike     # SCRATCH dir; do NOT use your real ~/.hermes
mkdir -p "$HERMES_HOME/plugins/memex-trace"

cp spike/trace_provider.py "$HERMES_HOME/plugins/memex-trace/__init__.py"

cat > "$HERMES_HOME/plugins/memex-trace/plugin.yaml" <<'YAML'
name: memex-trace
version: 0.0.0-spike
description: Verification spike — traces MemoryProvider callbacks
provides_memory_providers: [memex-trace]
YAML

hermes plugins enable memex-trace
hermes                                    # start an interactive session

# In the Hermes session, exercise (in this order):
#   1. A plain text turn — type "hello", get a response
#   2. The built-in remember tool — type "remember that I prefer dark mode"
#   3. Read-back — type "what do you know about my preferences?"
#   4. End the session — /exit (or whatever Hermes' exit command is)
#   5. (Optional) Force a compression if Hermes supports it

# Then inspect:
cat "$HERMES_HOME/cache/memex-trace.log"
```

**Pitfalls:**
- The trace provider has `from agent.memory_provider import MemoryProvider` at module top. If Hermes is installed via pip but the `agent.memory_provider` module path differs in this version, the import will fail with a clear `SystemExit`. **Fix in-place** by updating the import in `spike/trace_provider.py` to the actual path, commit the fix as part of §2.6 (contract divergence), and re-run.
- Use a SCRATCH `HERMES_HOME` (`/tmp/hermes-spike`). Do NOT use the user's real `~/.hermes/` — the spike registers a no-op memory provider that returns empty strings; it would degrade the user's real Hermes UX while enabled.
- After the spike, **`hermes plugins disable memex-trace`** to remove it.

**Verify:** `spike/SPIKE-COMPLETE.md` exists and answers the 7 questions in `spike/README.md`. Specifically:
1. Did `on_memory_write` fire when the built-in `remember` tool ran? (yes/no — drives D9/G19 primary path)
2. What were `action`, `target`, `content` set to?
3. What kwargs did `initialize` receive?
4. Was `system_prompt_block()` called once or N times per session?
5. What types did `sync_turn(user, assistant)` receive (raw strings vs message dicts)?
6. Did any unexpected callback fire?
7. Confirm `save_config(values, hermes_home)` got `hermes_home` as a real argument (F6 verification).

Then mark §2.2–§2.7 done in `openspec/changes/bootstrap-memex-hermes-adapter/tasks.md` (`- [ ]` → `- [x]`) and commit `spike/SPIKE-COMPLETE.md` (§2.7 is the explicit gate).

**If contract diverges from v2 design assumptions:** §2.6 says file the deltas back into the openspec change. Update affected `specs/*/spec.md`, re-validate, optionally re-run `/systems-review` on the diff. Don't skip this — the entire C9/G12 gate exists specifically to catch divergences before implementation locks them in.

---

### 2. TypeScript engine extension — paths & config [§3]

**Blocked by:** §2 complete (`spike/SPIKE-COMPLETE.md` exists).
**Files to create:** `src/core/hermes-paths.ts`, `src/core/config.ts`, `src/core/session.ts`, plus a YAML parsing helper.
**Reference implementations:** `/home/jim/workspace/github.com/jim80net/memex-claude/src/core/{paths.ts, config.ts, session.ts}` — port these and adapt for Hermes' path layout.
**Spec contract:** `openspec/changes/bootstrap-memex-hermes-adapter/specs/hermes-path-resolution/spec.md`.

---

### 3. TypeScript engine extension — Hermes.* event handlers [§4]

**Blocked by:** §2.
**Files to create:** `src/main.ts` (entry; extends `hook_event_name` switch), `src/hooks/{prefetch, sync-turn, session-end, pre-compress, memory-write, system-prompt, tool}.ts`, plus push-retry and `_session/*` suppression wiring.
**Reference:** `/home/jim/workspace/github.com/jim80net/memex-claude/src/hooks/` for hook patterns.
**Spec contract:** `openspec/changes/bootstrap-memex-hermes-adapter/specs/hermes-engine-events/spec.md` + `hermes-sync-bridge/spec.md`.
**Gotchas:**
- §4.4 — `extractionModel` MUST be explicitly configured in v1 (G17 amendment); no auto-discover-Hermes-active-model.
- §4.10 / §4.11 — implementation lives in THIS repo's `src/hooks/`, NOT in memex-core (G14/G15).
- §4.12 — implement BOTH mirror paths (callback + mtime-watcher) regardless of which is primary (G19).

---

### 4. TypeScript tests [§5]

**Blocked by:** §4.
**Files to create:** `test/ts/{prefetch, sync-turn, memory-write, session-suppression, tool-dispatch, concurrency}.test.ts`.

---

### 5. Python plugin — paths, config, runner [§6]

**Blocked by:** §2 (envelope shape) and §4 (envelope settled).
**Files to create:** `memex_hermes/{paths.py, config.py, runner.py}`.
**Spec contract:** `hermes-path-resolution/spec.md` + `hermes-memory-provider/spec.md`.
**Gotcha:** `runner.py` MUST surface two APIs: `await_subprocess(event_name, payload)` via `asyncio.to_thread` for awaited calls; `fire_and_forget(event_name, payload)` via daemon thread + bounded queue for non-blocking calls (D4/C10).

---

### 6. Python plugin — MemexProvider [§7]

**Blocked by:** §2, §6.
**Files to create:** `memex_hermes/{__init__.py, provider.py, tools.py}`.
**Spec contract:** all four of hermes-memory-provider, memex-tool-surface, hermes-sync-bridge, hermes-engine-events.
**§7.2 was split into 7.2a/b/c per G18.**

---

### 7. Python tests [§8]

**Blocked by:** §7.
**New tests added per G1/G3:** §8.7 shutdown drain; §8.8 method→event dispatch invariant; §8.9 no-Python-engine grep.

---

### 8. Distribution, bundled skills, integration tests, CI, docs [§9–§13]

**Mostly** independent of §2; can start in parallel once you have time.
- §9 (`bin/memex` wrapper + install.sh + checksums) — references `memex-claude/bin/install.sh`.
- §10 (port `sleep/deep-sleep/doctor/handoff` skills from `memex-claude/skills/`).
- §11 (E2E tests in `test/e2e/`, gated `MEMEX_E2E=1`).
- §12 (GitHub Actions for pytest + vitest + biome + integration smoke).
- §13 (USAGE.md and post-spike design updates).

---

### 9. Verification gates per Jim's standard development flow [§14]

**Blocked by:** all of the above.
- `/systems-review` on the implementation diff before PR.
- `gh pr create` referencing the openspec change.
- Cubic review iteration.
- All CI green.
- **Wait for explicit user authorization before merging — `gh pr merge` is hook-blocked, per `~/.claude/rules/never-auto-merge-prs.md`.**
- After merge: `/opsx:archive` the change; run `wrap-things-up`.

---

## Failed Approaches & Dead Ends

(None this session — the design held on the first pass through systems-review, just needed refinement. Save this slot for things to actually avoid.)

**Pitfalls discovered but NOT yet stumbled into** (worth keeping in mind):

| Pitfall | Why it's tempting | Why to avoid |
|---|---|---|
| Reimplementing memex-core in Python "for speed" | Subprocess fork is ~30-80 ms per call | Forks the canonical on-disk format → kills cross-platform sync. **Forbidden by G1 Requirement and CI grep test.** |
| Hardcoding `~/.hermes/` anywhere | Default everyone uses | Breaks for users with `HERMES_HOME=/data/hermes`. **Forbidden by D8 and the no-hardcoded grep test in §8.2.1.** |
| Putting dynamic per-turn content in `system_prompt_block()` | Looks like a natural injection point | The output is cached into the prompt prefix at session start; dynamic content burns cache. **Forbidden by D5.** Use `prefetch()` instead. |
| Treating `sync_turn` as if it can block | Synchronous Python `def` body looks blocking-by-default | Hermes docs explicitly mandate `sync_turn() MUST be non-blocking`. Always route through `fire_and_forget()` daemon thread. **Test §8.5 enforces it.** |
| Pushing `_session/*` IDs to remote | They're real projects, why not? | Within a week of normal use, the remote accumulates hundreds of throwaway dirs from sessions started without a meaningful cwd. **Forbidden by D7 / C12.** |
| Inventing `~/.hermes/rules/` | Parity with the sync repo layout | Hermes UI doesn't surface this dir; it would look like contamination. **Forbidden by D6.** Rules use `skills/` with `type: rule` frontmatter. |

---

## Gotchas & Environment Notes

- **No git remote yet.** This repo's 4 commits exist only on this dev box. **First task on the Hermes host is choosing migration mechanism (gh repo create vs rsync).** See Remaining Work item 0.
- **GitHub repo `jim80net/memex-hermes` does NOT exist.** Verified via `gh repo view jim80net/memex-hermes` → "Could not resolve to a Repository." Either create it with `gh repo create --private` or sync via filesystem.
- **`openspec` CLI version 1.3.1** is installed at `/home/jim/.nvm/versions/node/v24.15.0/bin/openspec`. If the Hermes host has a different version, validate `openspec validate "bootstrap-memex-hermes-adapter"` still passes after migration.
- **opsx scaffolding lives in `.claude/` and `.opencode/`.** These were auto-created by `openspec new change` during this session. They are committed and should travel with the repo.
- **Hermes `HERMES_HOME` default is `~/.hermes/`** per docs. The spike uses `/tmp/hermes-spike` to avoid polluting the user's real install — do NOT run the spike against the user's real `~/.hermes/` directly.
- **The trace provider's import `from agent.memory_provider import MemoryProvider`** assumes the module path Hermes documents. If a real install puts the ABC at a different path (e.g., `hermes_agent.memory_provider`), update `spike/trace_provider.py` line 47 in place and add a note to `spike/SPIKE-COMPLETE.md` under "contract divergences."
- **`hermes-claude` binary release pinning** — `pyproject.toml` has `[tool.memex-hermes.binary] upstream-release = "memex-claude@v1.5.0"` as a placeholder. Real first release needs the actual `memex-claude` release tag to download.
- **No remote means no PR yet.** Steps in §14 (PR + cubic + CI) all wait until a remote exists.
- **Per `~/.claude/rules/never-auto-merge-prs.md`:** `gh pr merge` is hook-blocked. When the time comes to merge, report the state to the user and wait for them to do it.
- **Per `~/.claude/rules/proceed-when-obvious.md`:** don't ask rhetorical "shall I X?" — proceed on obvious next steps.
- **WSL2-specific:** if the Hermes host is also WSL2, watch for the same `bun build --compile` glibc compatibility issues that affect `rtk` (`~/.claude/skills/rtk-musl-wsl.md`). The prebuilt `memex` binary may need the musl variant.

---

## To Resume

1. **Migrate the repo** (item 0 in Remaining Work). Recommended:
   ```bash
   # On this box (one time):
   gh repo create jim80net/memex-hermes --private --source=. --remote=origin
   git push -u origin main

   # On the Hermes host:
   git clone git@github.com:jim80net/memex-hermes.git
   cd memex-hermes
   ```
2. **Start a fresh Claude session on the Hermes host** in the cloned repo dir.
3. **Hand over with the takeover command:**
   ```
   /memex-claude:takeover .claude/handoffs/20260525-bootstrap-memex-hermes-resume-on-hermes-host.md
   ```
4. The takeover session should immediately:
   - Verify `openspec status --change "bootstrap-memex-hermes-adapter"` shows progress 9/90, 4/4 artifacts complete.
   - Run the verification spike per `spike/README.md`.
   - Write findings to `spike/SPIKE-COMPLETE.md`, mark §2.2–§2.7 done, commit.
   - If any contract diverged from v2 assumptions, file deltas back into the openspec change before continuing.
   - Then resume `/opsx:apply` from §3 onward.

---

## Reference Index

| Document | Lines | Purpose |
|---|---|---|
| `docs/specs/2026-05-25-memex-hermes-adapter-design.md` | 395 | The full v2 design — the canonical "why and how" reference |
| `openspec/changes/bootstrap-memex-hermes-adapter/proposal.md` | 39 | What's changing and why; 6 capabilities; impact |
| `openspec/changes/bootstrap-memex-hermes-adapter/design.md` | 119 | 10 architectural decisions (D1–D10) with alternatives + rationale |
| `openspec/changes/bootstrap-memex-hermes-adapter/tasks.md` | 143 | 90 trackable checkboxes across 14 task groups |
| `openspec/changes/bootstrap-memex-hermes-adapter/specs/hermes-memory-provider/spec.md` | 137 | The provider contract; includes G1/G3 amendments |
| `openspec/changes/bootstrap-memex-hermes-adapter/specs/hermes-engine-events/spec.md` | 127 | `Hermes.*` event handlers; includes G2 amendment |
| `openspec/changes/bootstrap-memex-hermes-adapter/specs/hermes-path-resolution/spec.md` | 76 | `$HERMES_HOME` propagation + scan dirs |
| `openspec/changes/bootstrap-memex-hermes-adapter/specs/memex-tool-surface/spec.md` | 83 | `memex_search` / `memex_remember` / `memex_recall` |
| `openspec/changes/bootstrap-memex-hermes-adapter/specs/hermes-sync-bridge/spec.md` | 105 | Mirror semantics; includes G19 amendment |
| `openspec/changes/bootstrap-memex-hermes-adapter/specs/hermes-plugin-packaging/spec.md` | 82 | Pip + manual install paths; bin/memex wrapper contract |
| `CLAUDE.md` | — | 7 key invariants (the must-reads for any AI agent working on this) |
| `CONTRIBUTING.md` | — | Dev setup + the spike + Maintenance section |
| `spike/README.md` | — | Step-by-step runbook for the verification spike |
| `spike/trace_provider.py` | — | The verification spike itself (§2.1 deliverable) |

**Sibling repo references** (read-only, for porting patterns):
- `/home/jim/workspace/github.com/jim80net/memex-claude/` — Node.js + bun-compiled binary; JSON-stdin hook pattern
- `/home/jim/workspace/github.com/jim80net/memex-openclaw/` — in-process TS plugin; `api.on('before_prompt_build', ...)` pattern
- `/home/jim/workspace/github.com/jim80net/memex-core/` — the shared engine; `src/types.ts:94` defines `HookInput`; `src/file-lock.ts` defines `withFileLock`
