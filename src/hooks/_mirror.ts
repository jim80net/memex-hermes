// Shared mirror primitive used by Hermes.memory-write (callback path) and
// Hermes.sync-turn (mtime-watcher path). Both paths must produce the same
// on-disk layout: `<sync_repo>/projects/<project-id>/memory/{MEMORY,USER}.md`
// (hermes-sync-bridge R1).

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Logger, SyncConfig } from "@jim80net/memex-core";
import { initSyncRepo } from "@jim80net/memex-core";
import type { HermesConfig } from "../core/config.ts";
import type { HermesMemoryTarget } from "../core/envelope.ts";
import {
  detectBranch,
  isSessionProjectId,
  pushWithRetry,
  resolveHermesProjectId,
} from "../core/sync-helpers.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MirrorRequest {
  target: HermesMemoryTarget;
  content: string;
  cwd: string;
  sessionId: string;
  reason: string;
}

export interface MirrorResult {
  committed: boolean;
  pushed: boolean;
  projectId: string;
  filePath: string;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Map the on_memory_write `target` to a concrete filename. Per
 * hermes-sync-bridge R1, the target is one of "memory" or "user" (not a
 * filename); the adapter is responsible for the .md mapping.
 */
export function targetToFilename(target: HermesMemoryTarget): string {
  switch (target) {
    case "memory":
      return "MEMORY.md";
    case "user":
      return "USER.md";
  }
}

/**
 * Write the file into the local sync repo, commit, push with retry. Suppresses
 * the push step when the project ID is in the `_session/*` namespace. Returns
 * a result describing whether the commit and push happened.
 */
export async function mirrorAndCommit(
  req: MirrorRequest,
  config: HermesConfig,
  syncRepoDir: string,
  logger?: Logger,
): Promise<MirrorResult> {
  const syncConfig: SyncConfig = config.sync;
  await initSyncRepo(syncConfig, syncRepoDir);

  const projectId = await resolveHermesProjectId(req.cwd, req.sessionId, syncConfig);
  const filename = targetToFilename(req.target);
  const projectMemoryDir = join(syncRepoDir, "projects", projectId, "memory");
  const filePath = join(projectMemoryDir, filename);

  await mkdir(projectMemoryDir, { recursive: true });
  await writeFile(filePath, req.content, "utf-8");

  const relPath = `projects/${projectId}/memory/${filename}`;
  try {
    await execFileAsync("git", ["add", relPath], { cwd: syncRepoDir, timeout: 30_000 });
  } catch (err) {
    logger?.warn(`memex-hermes[mirror]: git add failed: ${errMsg(err)}`);
    return { committed: false, pushed: false, projectId, filePath };
  }

  let committed = false;
  try {
    const message = `memex-hermes ${req.reason}: ${req.target} for ${projectId}`;
    await execFileAsync("git", ["commit", "-m", message, "--", relPath], {
      cwd: syncRepoDir,
      timeout: 30_000,
    });
    committed = true;
  } catch (err) {
    // No staged changes is a benign "nothing to commit" — git exits non-zero.
    const reason = errMsg(err);
    if (!reason.toLowerCase().includes("nothing to commit")) {
      logger?.warn(`memex-hermes[mirror]: git commit failed: ${reason}`);
    }
    return { committed: false, pushed: false, projectId, filePath };
  }

  // Suppress push for session-fallback project IDs.
  if (isSessionProjectId(projectId)) {
    logger?.info(`memex-hermes[mirror]: push suppressed for _session project id (${projectId})`);
    return { committed, pushed: false, projectId, filePath };
  }

  if (!syncConfig.enabled || !syncConfig.autoCommitPush || syncConfig.repo.length === 0) {
    return { committed, pushed: false, projectId, filePath };
  }

  const branch = await detectBranch(syncRepoDir);
  const push = await pushWithRetry(
    syncRepoDir,
    branch,
    { pushRetries: config.sync.pushRetries, baseBackoffMs: 200 },
    logger,
  );

  return { committed, pushed: push.pushed, projectId, filePath };
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
