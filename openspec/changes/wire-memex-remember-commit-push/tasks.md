# Tasks — wire-memex-remember-commit-push

## 1. Shared commit+push helper
- [ ] 1.1 Add `commitAndMaybePush({syncRepoDir, addPaths, message, projectId, sync, logger})` → `{committed, pushed}` to `src/core/sync-helpers.ts`. Policy: gate on `sync.enabled && sync.repo`; `initSyncRepo` → `git add addPaths` → `git commit`; tolerate "nothing to commit"; push only when `committed && autoCommitPush && !isSessionProjectId(projectId)` (treat `projectId===null` as non-session) via `pushWithRetry`.
- [ ] 1.2 Unit tests for the helper (`test/ts/sync-helpers` or co-located): commit+push to a bare remote; session id suppresses push; autoCommitPush=false → committed not pushed; disabled/no-repo → no commit; nothing-to-commit tolerated.

## 2. Refactor session-end to the helper (no behavior change)
- [ ] 2.1 Replace `session-end.ts`'s inline `initSyncRepo`/add/commit/push block with a `commitAndMaybePush` call (addPaths = `[projects/<id>/memory]`).
- [ ] 2.2 `pnpm test` — session-end's existing push tests stay green (regression gate).

## 3. Wire handleToolRemember
- [ ] 3.1 After writing the file, compute its repo-relative path and call `commitAndMaybePush`; set `synced = result.pushed`.
- [ ] 3.2 Update the tool-schema description + the handler docstring so `synced` = "committed and pushed to the shared remote" (no longer eligibility).

## 4. Reconcile + add tests
- [ ] 4.1 Move the `synced=true` contract cases (`tool-dispatch.test.ts`, `session-suppression.test.ts`) to a real bare remote (`setupBareRemoteAndClone`, `config.sync.repo = remoteDir`, `autoCommitPush:true`). Keep the `synced=false` cases (assert no push).
- [ ] 4.2 Round-trip test: `memex_remember` → clone the bare remote → assert the `memex-remember-*.md` entry is present with the payload.
- [ ] 4.3 Negatives: `autoCommitPush:false` → committed, `synced:false`, entry NOT on remote; push-failure (unreachable repo) → `synced:false`, entry retained locally.

## 5. Spec + close-out
- [ ] 5.1 `openspec validate wire-memex-remember-commit-push --strict` passes.
- [ ] 5.2 Review trio (systems-review + open-code-review + STORM) on design+spec, then on the implementation diff — iterate clean.
- [ ] 5.3 `pnpm test` + `pytest test/python` + `pnpm typecheck` + `pnpm lint` green.
- [ ] 5.4 Open PR to `jim80net/memex-hermes` referencing #6; surface to hydra-ops; NO self-merge.
