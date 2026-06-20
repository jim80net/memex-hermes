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
import { resolveProjectId } from "@jim80net/memex-core";

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
