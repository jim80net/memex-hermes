// Project-internal sync helpers. memex-core's `syncCommitAndPush` does a
// single best-effort push; the Hermes spec mandates rebase-and-retry with
// exponential backoff on non-fast-forward rejections (G14 / hermes-sync-bridge
// "Sync push race recovery uses rebase-retry with bounded backoff"), and
// suppression of remote push for `_session/*` project IDs (G15).
//
// Both behaviors live HERE rather than in memex-core because they are
// Hermes-specific policy. The no-direct-git rule from G1 applies to the
// Python layer; the TypeScript engine layer is the canonical place for git
// orchestration in this repo.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger, SyncConfig } from "@jim80net/memex-core";
import { initSyncRepo, resolveProjectId } from "@jim80net/memex-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PushRetryConfig {
  pushRetries: number;
  baseBackoffMs: number;
}

export interface PushResult {
  pushed: boolean;
  attempts: number;
  reason?: string;
}

/**
 * The sync policy `commitAndMaybePush` needs. Structurally `HermesSyncConfig`
 * (`SyncConfig` — which already carries `enabled`/`repo`/`autoCommitPush` — plus
 * the Hermes-only `pushRetries`). Kept as a local type so sync-helpers stays
 * decoupled from config.ts, and assignable to `SyncConfig` for `initSyncRepo`.
 * Callers pass `config.sync` directly.
 */
export type CommitPushPolicy = SyncConfig & { pushRetries: number };

export interface CommitAndPushResult {
  /** A commit was created in the local sync repo for the given paths. */
  committed: boolean;
  /** The commit was pushed to the remote on this call. */
  pushed: boolean;
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * `_session/<id>` IDs come from sessions without a meaningful cwd. They are
 * local-cache-only: writes land in the local sync repo but never push to the
 * remote (D7 / C12). Detection is a prefix check — the canonicalization
 * itself happens upstream in `resolveProjectId`.
 */
export function isSessionProjectId(projectId: string): boolean {
  return projectId.startsWith("_session/");
}

/**
 * Hermes-flavored project ID resolution per hermes-sync-bridge R3.
 *
 * The base memex-core resolveProjectId returns `_local/<encoded-cwd>` for a
 * cwd that isn't a git repo, but for HERMES the spec requires a `_session/`
 * fallback when no cwd was provided AT ALL. We therefore short-circuit the
 * empty-cwd case here and delegate everything else to memex-core so the
 * git-remote and project-mapping paths stay byte-identical with the other
 * adapters.
 */
export async function resolveHermesProjectId(
  cwd: string | undefined,
  sessionId: string,
  syncConfig: SyncConfig,
): Promise<string> {
  if (!cwd || cwd.length === 0) {
    return `_session/${sessionId || "unknown"}`;
  }
  return resolveProjectId(cwd, syncConfig);
}

/**
 * Push the current branch with rebase-retry. On a non-fast-forward rejection,
 * runs `git pull --rebase origin <branch>` and retries with exponential
 * backoff (200/400/800 ms by default, or `baseBackoffMs * 2^attempt`). On
 * exhaustion the local commit stays on the branch and a warning is logged.
 * The repo is NEVER reset, force-pushed, or rolled back.
 *
 * The caller is expected to have already committed the changes locally;
 * pushWithRetry only operates on the push step.
 */
export async function pushWithRetry(
  syncRepoDir: string,
  branch: string,
  config: PushRetryConfig,
  logger?: Logger,
): Promise<PushResult> {
  const maxAttempts = Math.max(1, config.pushRetries);
  let lastReason: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await runGit(["push", "origin", branch], syncRepoDir);
      return { pushed: true, attempts: attempt + 1 };
    } catch (err) {
      const reason = errorMessage(err);
      lastReason = reason;
      if (!isNonFastForward(reason)) {
        logger?.warn(`memex-hermes[sync]: push failed (non-retriable): ${reason}`);
        return { pushed: false, attempts: attempt + 1, reason };
      }
      if (attempt + 1 >= maxAttempts) break;

      const wait = config.baseBackoffMs * 2 ** attempt;
      await sleep(wait);
      try {
        await runGit(["pull", "--rebase", "origin", branch], syncRepoDir);
      } catch (rebaseErr) {
        const rebaseReason = errorMessage(rebaseErr);
        logger?.warn(`memex-hermes[sync]: rebase before retry failed: ${rebaseReason}`);
        return { pushed: false, attempts: attempt + 1, reason: rebaseReason };
      }
    }
  }

  logger?.warn(
    `memex-hermes[sync]: push exhausted ${maxAttempts} attempts; local commit retained. Last reason: ${lastReason ?? "unknown"}`,
  );
  return { pushed: false, attempts: maxAttempts, reason: lastReason };
}

/**
 * A project id is push-eligible when it is NOT a `_session/*` id. `null` (global
 * scope) and `_local/<encoded-cwd>` (a non-git cwd) are push-eligible — matching
 * the mirror and session-end push gates. `isSessionProjectId` takes a string, so
 * the `null` case is checked first.
 */
export function isPushEligible(projectId: string | null): boolean {
  return projectId === null || !isSessionProjectId(projectId);
}

/**
 * Commit the given working-tree paths into the sync repo and push with retry,
 * gated on `autoCommitPush` and a push-eligible project id. The single home for
 * the "write landed → commit → gated push" policy shared by `Hermes.session-end`
 * (learnings) and `memex_remember`.
 *
 * The commit is path-scoped (`git commit -- <paths>`) so it includes only the
 * given paths regardless of anything a concurrent writer may have staged. A
 * benign "nothing to commit" returns `{committed:false}` silently; any OTHER
 * commit failure is logged (preserving genuine-failure visibility) and also
 * returns `{committed:false}`. The repo is never reset or force-pushed.
 *
 * Returns whether a commit was created locally and whether it was pushed to the
 * remote on this call. A `{committed:true, pushed:false}` result means the entry
 * is committed locally and will ride the next successful push by any writer
 * (`pushWithRetry` pushes the branch, carrying all ahead commits).
 */
export async function commitAndMaybePush(args: {
  syncRepoDir: string;
  addPaths: string[];
  message: string;
  projectId: string | null;
  sync: CommitPushPolicy;
  logger?: Logger;
}): Promise<CommitAndPushResult> {
  const { syncRepoDir, addPaths, message, projectId, sync, logger } = args;

  if (!sync.enabled || sync.repo.length === 0 || addPaths.length === 0) {
    return { committed: false, pushed: false };
  }

  // initSyncRepo can throw (mkdir EACCES, a corrupted repo, git init failure).
  // The file is already written; a sync-init failure must NOT turn a successful
  // local write into a thrown tool error — degrade to "not committed" + a warn.
  try {
    await initSyncRepo(sync, syncRepoDir);
  } catch (err) {
    logger?.warn(`memex-hermes[sync]: initSyncRepo failed: ${errorMessage(err)}`);
    return { committed: false, pushed: false };
  }

  try {
    await runGit(["add", ...addPaths], syncRepoDir);
  } catch (err) {
    logger?.warn(`memex-hermes[sync]: git add failed: ${errorMessage(err)}`);
    return { committed: false, pushed: false };
  }

  try {
    await runGit(["commit", "-m", message, "--", ...addPaths], syncRepoDir);
  } catch (err) {
    // Classify the benign "nothing to commit" family from the FULL output
    // (git prints it to stdout); a genuine failure still logs (stderr-only).
    if (!isNothingToCommit(gitOutputText(err))) {
      logger?.warn(`memex-hermes[sync]: git commit failed: ${errorMessage(err)}`);
    }
    return { committed: false, pushed: false };
  }

  if (!sync.autoCommitPush || !isPushEligible(projectId)) {
    return { committed: true, pushed: false };
  }

  const branch = await detectBranch(syncRepoDir);
  const push = await pushWithRetry(
    syncRepoDir,
    branch,
    { pushRetries: sync.pushRetries, baseBackoffMs: 200 },
    logger,
  );
  return { committed: true, pushed: push.pushed };
}

/**
 * Resolve the current branch name of a git repo. Falls back to "main" on any
 * error or detached HEAD so the push step always has a branch to target.
 * Shared by the mirror path and the session-end push so both push the branch
 * the repo is actually on.
 */
export async function detectBranch(repoDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoDir,
      timeout: 5_000,
    });
    const branch = stdout.trim();
    return branch.length > 0 && branch !== "HEAD" ? branch : "main";
  } catch {
    return "main";
  }
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd, timeout: 30_000 });
}

function isNonFastForward(reason: string): boolean {
  const r = reason.toLowerCase();
  return (
    r.includes("non-fast-forward") ||
    r.includes("rejected") ||
    r.includes("fetch first") ||
    r.includes("updates were rejected")
  );
}

/**
 * git's "nothing to commit" family is a BENIGN outcome (no error), and git
 * prints it to STDOUT (not stderr) with several wordings depending on the
 * working-tree state — "nothing to commit, working tree clean", "nothing added
 * to commit but untracked files present", "no changes added to commit", or
 * "pathspec ... did not match" when nothing was staged. Match the family so a
 * genuine commit failure (e.g. a missing identity) is still surfaced while a
 * no-op commit stays silent.
 */
function isNothingToCommit(reason: string): boolean {
  const r = reason.toLowerCase();
  return (
    r.includes("nothing to commit") ||
    r.includes("nothing added to commit") ||
    r.includes("no changes added to commit") ||
    r.includes("did not match any file")
  );
}

/**
 * The full git output (message + stdout + stderr) for BENIGN-outcome
 * classification only. git prints the "nothing to commit" family to STDOUT, so
 * detecting it needs stdout — but this MUST NOT feed the push classifier
 * (`isNonFastForward`), which owns stderr (a hook/credential-helper line on
 * stdout containing "rejected" must never flip a push retry decision). Kept
 * separate from `errorMessage` for exactly that reason.
 */
function gitOutputText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
  return [err.message, e.stdout?.toString() ?? "", e.stderr?.toString() ?? ""].join("\n");
}

/**
 * Human-readable error text for LOGGING and the push non-fast-forward
 * classifier. Reads stderr only (the stream git uses for push rejections), so a
 * classifier fed from this never sees stdout hook/helper noise.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const withStderr = err as Error & { stderr?: string | Buffer };
    if (withStderr.stderr) {
      const s = withStderr.stderr.toString();
      if (s.length > 0) return `${err.message}\n${s}`;
    }
    return err.message;
  }
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
