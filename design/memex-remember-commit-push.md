# Design — Wire `memex_remember` commit/push; make `synced` a confirmation (issue #6)

**Status:** proposed (rev 2 — folds in the design-gate review trio: systems-review + open-code-review + STORM)
**Issue:** [#6](https://github.com/jim80net/memex-hermes/issues/6)
**Author:** memex flotilla XO · **Date:** 2026-06-29

## 1. Problem

`handleToolRemember` (`src/hooks/tool-remember.ts`) writes the memory file into
the sync-repo working tree but performs **no `git add/commit/push`**. The
`Hermes.sync-turn` mtime-watcher only tracks `MEMORY.md`/`USER.md`, so
`memex-remember-*.md` is committed by **no path** and never reaches the remote.
The returned `synced` field is computed as
`sync.enabled && repo && !isSessionProjectId(projectId)` — an **eligibility
prediction**, not a confirmation. The agent-facing tool-schema description
(`memex_hermes/tools.py:104-108`) likewise advertises `synced` as "eligible to
sync."

**Impact:** an explicit `memex_remember` persists locally (usable for same-host
index recall) but does **not** propagate cross-adapter — the tool's headline
purpose and the foundation for the operator's cross-harness memory-portability
direction. No data loss; silent non-propagation. Same bug class P2-3 already
fixed for `session-end` learnings.

## 2. Approach

Route `memex_remember` through the **same commit + gated-push policy
`session-end` uses**, extracted into a shared helper, and report the **actual
outcome** with a small tri-state return.

### 2.1 Shared commit+push policy (`sync-helpers.ts`)

```ts
export interface CommitAndPushResult { committed: boolean; pushed: boolean; }

export async function commitAndMaybePush(args: {
  syncRepoDir: string;
  addPaths: string[];           // repo-relative paths to `git add`
  message: string;
  projectId: string | null;     // null = global scope → non-session, push-eligible
  sync: { enabled: boolean; repo: string; autoCommitPush: boolean; pushRetries: number };
  logger?: Logger;
}): Promise<CommitAndPushResult>;
```

Policy (exactly `session-end`'s, generalized — `session-end.ts:95-132`):
1. If `!sync.enabled || !sync.repo` → `{committed:false, pushed:false}` (write-only).
2. `initSyncRepo(sync, syncRepoDir)` → `git add <addPaths>` → `git commit -m message`.
   - On commit error: if the message matches `nothing to commit` → return
     `{committed:false, pushed:false}` **silently** (benign); **otherwise log a
     warning** and return `{committed:false}` — preserving `session-end`'s
     genuine-failure visibility (it does NOT silently swallow real commit
     failures today, so the extraction must not downgrade that).
3. Push **only** when `committed && sync.autoCommitPush && isPushEligible(projectId)`,
   where `isPushEligible(id) = id === null || !isSessionProjectId(id)`. (`isSessionProjectId`
   takes a string and would throw on `null`, so the `null`/global case is guarded
   first.) `pushWithRetry` (rebase-retry, no force, no reset) on `detectBranch`.
   `pushed = result.pushed`.

`initSyncRepo` clones-or-inits and fixes the `origin` URL; it does **not** pull
(`syncPull` is separate). A per-write push therefore relies on `pushWithRetry`'s
`git pull --rebase` to recover from a non-fast-forward under a busy remote.

Refactor `session-end.ts` to call it (`addPaths = [projects/<id>/memory]` — keeps
its directory-scoped commit; gated by its existing bare-remote push tests at
`session-end.test.ts:134-168` as the regression net).

### 2.2 Wire `handleToolRemember`

After writing the file (unchanged path/format logic), compute the file's
**repo-relative** path (`relative(syncRepoDir, filePath)` — the current `filePath`
is absolute) and pass it as the single `addPaths` entry — so tool-remember commits
**only its own file**, never sweeping a concurrently-written sibling. Call
`commitAndMaybePush`; return `{written, committed, synced}` where
`committed = result.committed` and `synced = result.pushed`.

Update the **Python** schema description (`tools.py:104-108`) and the TS file
header (`tool-remember.ts:2-9`, which still says "ELIGIBILITY prediction") so the
agent-facing contract reads: `synced` = committed **and** pushed to the remote
this call; `committed` = committed to the local sync repo (propagates on the next
push if not yet `synced`). (This **is** a Python change — the proposal/impact are
corrected accordingly; the binary envelope is unchanged.)

`projectId` for the gate (all four real shapes):
- `global` scope → `null` → push-eligible.
- `session` scope / no-cwd fallback → `_session/<id>` → push **suppressed** (D7/C12).
- `project` scope, git cwd → `<host>/<owner>/<repo>` → push-eligible.
- `project` scope, **non-git cwd** → `_local/<encoded-cwd>` → push-eligible
  (consistent with `_mirror.ts:108` and `session-end.ts:119`, which already push
  `_local/` ids; `isSessionProjectId("_local/…") === false`). Pinned by a test.

### 2.3 The return contract (tri-state, the issue's "split eligibility vs confirmed")

`{written, committed, synced}` — `written` unchanged (absolute path); two honest
booleans that let the agent distinguish a **transient** miss from a **terminal**
one (the bug the old single `synced` bool hid):

| `committed` | `synced` | meaning | agent action |
|---|---|---|---|
| true | true | committed AND pushed to remote this call | done |
| true | false | committed locally; push suppressed/off/failed — **rides the next successful push from any writer** | nothing — do NOT re-call |
| false | false | not committed (sync disabled / no repo) — only in the working tree | nothing |

This adds one additive field (non-breaking — existing readers of `written`/`synced`
keep working) and directly mitigates the duplication amplifier (#16): an agent
told `committed:true, synced:false` knows the entry is coming and won't re-call
`memex_remember` (which, with random-suffix filenames, would write a duplicate).

`synced === true` ⟺ `enabled && repo && push-eligible && autoCommitPush && push succeeded`.

**Recovery (precise):** a committed-but-unpushed entry is **not** re-pushed by any
dedicated timer. `pushWithRetry` runs `git push origin <branch>`, which pushes
**all** ahead commits — so the stranded commit propagates on the **next successful
push by any writer** (`session-end`, the mtime-mirror, or a later `memex_remember`).
Verified by a dedicated test (push-failure → later success → entry on remote).

## 3. Test reconciliation

The existing contract tests pin `synced` as eligibility using a **fake,
unreachable** remote (`repo:"git@example.com:foo/bar.git"`) and assert
`synced=true` with no git op. Under the new semantics those flip to `synced=false`.

- **`synced=false` cases stay** (sync-disabled, session scope, `_session/*`
  regardless of `autoCommitPush`) — now false for the right reason; assert no push.
- **All three `synced=true` cases move to a real bare remote** via
  `setupBareRemoteAndClone` (`config.sync.repo = remoteDir` — `initSyncRepo`
  rewrites `origin` to `config.repo`, so it MUST equal the bare-remote path;
  `autoCommitPush:true`):
  - `tool-dispatch.test.ts:123-138` (basic eligible),
  - `tool-dispatch.test.ts:165-184` (**explicit `projectName` promotion**),
  - `session-suppression.test.ts:88-110` (`projectName` bypass).
- **New round-trip test:** `memex_remember` → clone the bare remote into a second
  dir → assert the `memex-remember-*.md` file is present with the payload (the
  cross-adapter propagation #4's e2e is gated/skipped on).
- **New `_local/` test:** project scope + non-git cwd → `synced=true`, file on remote.
- **New negatives:** `autoCommitPush:false` → `committed:true, synced:false`, file
  NOT on remote; push-failure (`pushRetries:1` + an unreachable/bad remote so the
  backoff is bounded and the test is fast/deterministic) → `committed:true,
  synced:false`, file retained locally; then a later successful push → file reaches
  the remote (the recovery property).
- **Helper unit tests:** commit+push to a bare remote; session-id suppresses push;
  `null`/global is push-eligible; `autoCommitPush:false` → committed-not-pushed;
  disabled/no-repo → no commit; nothing-to-commit silent; a **genuine** commit
  failure still logs a warning.
- **Python:** assert `_remember_schema()["description"]` no longer contains
  "eligible" (doc-drift regression guard).

## 4. Spec delta

MODIFY `memex-tool-surface` → "memex_remember writes a memory or rule entry and
reports sync state": the handler SHALL commit + attempt a gated push (not merely
write); the return is `{"written", "committed", "synced"}`; `synced` is a
committed-and-pushed confirmation (the precise conjunction above). Scenarios:
eligible round-trip (synced=true, file on remote), `autoCommitPush=false`
(committed=true, synced=false, not on remote), session scope (synced=false, no
push), and session-fallback with `autoCommitPush=true` (still synced=false — the
D7/C12 invariant).

## 5. Out of scope (filed where it's real tech debt)
- **Git-tree concurrency serialization** (`_mirror` + `session-end` + the new path
  share one tree with no lock) → **#15**. git's `index.lock` prevents corruption;
  the worst case is a false-negative `synced` + a retained-then-piggybacked entry.
- **Content-idempotent `memex_remember` filenames** (random-suffix → duplicates on
  re-record) → **#16**. The new `committed` field mitigates the *retry* driver.
- **Fold `_mirror.ts` into the shared `commitAndMaybePush`** — `mirrorAndCommit`
  is structurally the same primitive (different commit-message + target→filename
  flavor). Deferred (blast radius); noted on #15 as the natural pairing.
- **Per-write vs batch push granularity** — cross-harness reads happen at the peer
  harness's session-start pull, so per-write push buys little latency at some
  contention cost; the issue directs per-write (matching `_mirror`), and
  `pushWithRetry`'s rebase bounds the contention. Per-write stands for #6.
- The spec's `type:"memory"|"rule"` and the `scope` enum drift vs the handler —
  pre-existing; file separately, do not bundle.

## 6. Verification
- `pnpm test` (vitest) green incl. round-trip + `_local` + negatives + helper units;
  `pnpm typecheck` + `pnpm lint` clean.
- `pytest test/python` green incl. the schema-description assertion.
- `session-end`'s existing bare-remote push tests stay green (extraction regression gate).
- `openspec validate wire-memex-remember-commit-push --strict` clean.
