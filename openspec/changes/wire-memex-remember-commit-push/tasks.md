# Tasks — wire-memex-remember-commit-push

## 1. Shared commit+push helper
- [ ] 1.1 Add `commitAndMaybePush({syncRepoDir, addPaths, message, projectId, sync, logger})` → `{committed, pushed}` to `src/core/sync-helpers.ts`. Gate on `sync.enabled && sync.repo`; `initSyncRepo` → `git add addPaths` → `git commit`; push only when `committed && autoCommitPush && isPushEligible(projectId)` where `isPushEligible(id)= id===null || !isSessionProjectId(id)` (guard null before `isSessionProjectId`). Commit-error handling: `nothing to commit` → silent `{committed:false}`; any OTHER error → log warn + `{committed:false}` (preserve session-end's genuine-failure visibility).
- [ ] 1.2 Helper unit tests: commit+push to a bare remote (`setupBareRemoteAndClone`, repo=remoteDir); session id suppresses push; `null`/global push-eligible; `_local/<x>` push-eligible; `autoCommitPush:false` → committed-not-pushed; disabled/no-repo → no commit; nothing-to-commit silent; a GENUINE commit failure logs a warning.

## 2. Refactor session-end to the helper (no behavior change)
- [ ] 2.1 Replace `session-end.ts`'s inline init/add/commit/push block with a `commitAndMaybePush` call (`addPaths=[projects/<id>/memory]` — keeps dir-scoped commit).
- [ ] 2.2 `pnpm test` — session-end's existing bare-remote push tests (`session-end.test.ts:134-168`) stay green (regression gate).

## 3. Wire handleToolRemember + agent-facing description
- [ ] 3.1 After writing the file, compute `relative(syncRepoDir, filePath)` (single repo-relative path), call `commitAndMaybePush`; return `{written, committed: result.committed, synced: result.pushed}`. Add `committed: boolean` to `HermesToolRememberOutput` (`envelope.ts`).
- [ ] 3.2 Update the **Python** schema description `memex_hermes/tools.py:104-108` AND the TS header `tool-remember.ts:2-9` (still says "ELIGIBILITY prediction") so `synced` = "committed AND pushed to the remote this call" and `committed` = "committed locally; propagates on next push". (This IS a Python change — proposal corrected.)
- [ ] 3.3 Python test asserting `_remember_schema()["description"]` no longer contains "eligible".

## 4. Reconcile + add tests
- [ ] 4.1 Move ALL THREE `synced=true` fake-remote cases to a real bare remote (`repo=remoteDir`, `autoCommitPush:true`): `tool-dispatch.test.ts:123-138` (basic), `tool-dispatch.test.ts:165-184` (projectName promotion), `session-suppression.test.ts:88-110` (projectName bypass). Keep the `synced=false` cases; assert no push + (where applicable) `committed:true`.
- [ ] 4.2 Round-trip test: `memex_remember` → clone the bare remote → assert the `memex-remember-*.md` entry present with the payload.
- [ ] 4.3 `_local/` test: project scope + non-git cwd → `synced=true`, file on remote.
- [ ] 4.4 Negatives: `autoCommitPush:false` → `committed:true, synced:false`, entry NOT on remote; push-failure (`pushRetries:1` + unreachable/bad remote for a fast/deterministic test) → `committed:true, synced:false`, entry retained locally; then a later successful push → entry reaches the remote (recovery property).

## 5. Spec + close-out
- [ ] 5.1 `openspec validate wire-memex-remember-commit-push --strict` passes.
- [ ] 5.2 Review trio (systems-review + open-code-review + STORM) on the implementation diff — iterate clean.
- [ ] 5.3 `pnpm test` + `pytest test/python` + `pnpm typecheck` + `pnpm lint` green.
- [ ] 5.4 Open PR to `jim80net/memex-hermes` referencing #6 (+ #15/#16 discovered); surface to hydra-ops; NO self-merge.
