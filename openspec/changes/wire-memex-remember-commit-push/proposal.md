## Why

`memex_remember` writes its memory file into the sync-repo working tree but
never `git add/commit/push`es it, and the `Hermes.sync-turn` mtime-watcher only
tracks `MEMORY.md`/`USER.md` — so `memex-remember-*.md` entries reach the remote
via **no path**. The returned `synced` field is an *eligibility prediction*, not
a confirmation. The tool's headline purpose (cross-adapter propagation of an
explicitly-remembered entry) silently does not work, and it is the foundation
for the operator's cross-harness memory-portability direction. This is the same
bug class already fixed for `session-end` learnings.

See `design/memex-remember-commit-push.md`.

## What Changes

- Extract the commit + gated-push policy `session-end` uses into a shared
  `commitAndMaybePush` helper in `src/core/sync-helpers.ts` (`initSyncRepo` →
  `git add` → `git commit` → `pushWithRetry` gated on `autoCommitPush` &&
  `!isSessionProjectId`); refactor `session-end` to use it.
- Wire `handleToolRemember` through the helper after writing the file; set
  `synced = pushed` (committed **and** pushed this call), and update the tool
  schema description + docstring so `synced` no longer over-claims.
- Reconcile the contract tests that pinned `synced` as eligibility against a fake
  remote: move the `synced=true` cases to a real bare remote
  (`setupBareRemoteAndClone`, `repo = remoteDir`), add a bare-remote round-trip
  test (clone → assert the entry is present), and add negatives
  (`autoCommitPush:false` and push-failure both → `synced:false`, entry retained).

## Capabilities

### Modified Capabilities

- `memex-tool-surface`: redefine `memex_remember`'s `synced` from an eligibility
  prediction to a committed-and-pushed confirmation, and require the handler to
  commit + attempt a gated push (not merely write).

## Impact

- Behavior change to `memex_remember`: it now commits and (when eligible) pushes;
  `synced` reflects the real outcome. No data-loss risk — writes still land
  locally first; push is gated + rebase-retry + never force/reset.
- `session-end` is refactored to the shared helper (its existing push tests are
  the regression gate; no behavior change intended).
- No `@jim80net/memex-core` change; no Python change (the provider forwards the
  envelope verbatim).
