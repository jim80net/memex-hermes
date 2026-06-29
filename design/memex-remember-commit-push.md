# Design — Wire `memex_remember` commit/push; make `synced` a confirmation (issue #6)

**Status:** proposed
**Issue:** [#6](https://github.com/jim80net/memex-hermes/issues/6) — `memex_remember` writes the entry but never commits/pushes it (`synced` is a prediction)
**Author:** memex flotilla XO · **Date:** 2026-06-29

## 1. Problem

`handleToolRemember` (`src/hooks/tool-remember.ts`) writes the memory file into
the sync-repo working tree but performs **no `git add/commit/push`**. The
`Hermes.sync-turn` mtime-watcher only tracks `MEMORY.md`/`USER.md`, so
`memex-remember-*.md` files are committed by **no path** and never reach the
remote. The returned `synced` field is computed as
`sync.enabled && repo && !isSessionProjectId(projectId)` — an **eligibility
prediction**, not a confirmation that the entry propagated.

**Impact:** an explicit `memex_remember` persists locally (usable for same-host
index recall) but does **not** propagate cross-adapter — which is the tool's
headline purpose, and the foundation for the operator's cross-harness
memory-portability direction. No data loss; silent non-propagation. This is the
same bug class P2-3 already fixed for `session-end` learnings (which now commits
+ pushes).

This is the load-bearing prerequisite for cross-harness portability: a memory a
desk records under one harness must actually reach the shared repo to be
readable under another.

## 2. Approach

Route `memex_remember` through the **same commit + gated-push path session-end
now uses**, and make `synced` reflect the **actual outcome**.

### 2.1 Extract the shared commit+push policy (`sync-helpers.ts`)

Three writers now need "commit a written file into the sync repo, then push if
eligible": `session-end` (inline today), `memex_remember` (this change), and —
structurally — `_mirror` (kept as-is; it carries the `MEMORY.md`/`USER.md`
target-mapping flavor and is out of scope). Give the shared policy one home:

```ts
// sync-helpers.ts
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

Behavior (exactly session-end's policy, generalized):
1. If `!sync.enabled || !sync.repo` → `{committed:false, pushed:false}` (write-only; no commit).
2. `initSyncRepo(sync, syncRepoDir)` → `git add <addPaths>` → `git commit -m message`.
   A benign "nothing to commit" → `{committed:false, pushed:false}` (no throw).
3. Push **only** when `committed && sync.autoCommitPush && !isSessionProjectId(projectId)`
   — `pushWithRetry` (rebase-retry, no force, no reset) on the detected branch.
   `pushed = result.pushed`. (`projectId === null` is treated as non-session.)

Refactor `session-end.ts` to call it (de-dups its inline block; gated by its
existing push tests as the regression net).

### 2.2 Wire `handleToolRemember`

After writing the file (unchanged path/format logic), compute the repo-relative
path of the written file and call `commitAndMaybePush`. Set
**`synced = result.pushed`** — i.e. `synced` is true **iff the entry was
committed AND pushed to the remote on this call**. Update the tool-schema
description + docstring so `synced` means "committed and pushed to the shared
remote," not an eligibility guess.

`projectId` for the gate: `global` scope → `null` (push-eligible); `session`
scope / session-fallback → `_session/*` (push suppressed); `project`/named →
the resolved id.

### 2.3 `synced` semantics (the honest contract)

`synced === true` ⟺ `enabled && repo && !session && autoCommitPush && push succeeded`.
`synced === false` in every other case, each honest:
- sync disabled / no repo → not committed.
- session scope or `_session/*` fallback → committed locally, push **suppressed** (D7/C12).
- `autoCommitPush:false` → committed locally, not auto-pushed.
- push failed (remote down) → committed locally (retained for a later push), not pushed **this call**.

The return shape stays `{written, synced}` — no new field; `synced` simply stops
over-claiming. (The previously-returned eligibility is dropped because it misled.)

## 3. Test reconciliation

The existing contract tests pin `synced` as **eligibility** using a **fake,
unreachable** remote (`repo:"git@example.com:foo/bar.git"`) and assert
`synced=true` with no git op. Under the new semantics those become `synced=false`
(push to a fake URL fails). Reconcile:

- **`synced=false` cases stay** (sync-disabled, session scope, `_session/*`
  regardless of `autoCommitPush`) — still false, now for the right reason.
- **`synced=true` cases move to a real bare remote** via `setupBareRemoteAndClone`
  (`repo = remoteDir`, `autoCommitPush:true`). NOTE: `initSyncRepo` rewrites
  `origin` to `config.repo` (memex-core `sync.ts:78`), so the test MUST set
  `config.sync.repo = remoteDir` (the bare-remote path), not a fake URL.
- **New round-trip test:** `memex_remember` → commit → push → clone the bare
  remote into a second dir → assert the `memex-remember-*.md` file is present
  with the payload. This positively proves cross-adapter propagation — the gap
  #4's e2e round-trip is gated/skipped on.
- **New negative tests:** `autoCommitPush:false` → committed locally,
  `synced:false`, file NOT on the remote; push-failure (bad/unreachable remote)
  → `synced:false`, file retained in the local working tree.

## 4. Spec delta

MODIFY `memex-tool-surface` → "memex_remember writes a memory or rule entry and
reports sync state": redefine `synced` as **committed-and-pushed confirmation**
(true only when `sync.enabled` AND a repo is configured AND the project id is not
`_session/*` AND `autoCommitPush` AND the push succeeds); the handler SHALL
commit the entry and attempt a gated push (not merely write it). Scenarios:
remote round-trip (synced=true, file on remote), session suppression
(synced=false, no push), autoCommitPush-off (committed, synced=false).

## 5. Out of scope
- `_mirror.ts` refactor (different target-mapping flavor; higher blast radius).
- The spec's `type:"memory"|"rule"` arg for `memex_remember` (the handler only
  writes `type: memory`; a pre-existing spec/code drift — file separately, do
  not bundle).
- `#3` prefetch-latency, `#5` double-mirror, `#8` symlink residual (separate lanes).

## 6. Verification
- `pnpm test` (vitest) green incl. new round-trip + negative tests; `pnpm typecheck` + `pnpm lint` clean.
- `pytest test/python` unchanged green (the Python provider just forwards the envelope).
- session-end's existing push tests stay green (regression gate for the extraction).
- `openspec validate wire-memex-remember-commit-push --strict` clean.
