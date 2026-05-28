// Hermes.pre-compress — snapshot the project's memory dir into the sync repo
// before Hermes compresses session messages. The snapshot is a commit with a
// `pre-compress` marker in the message so we can reconstruct the state from
// git history if compression discards context we cared about.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "@jim80net/memex-core";
import { initSyncRepo } from "@jim80net/memex-core";
import type { HermesConfig } from "../core/config.ts";
import type { HermesPreCompressOutput } from "../core/envelope.ts";
import type { HermesPaths } from "../core/hermes-paths.ts";
import { resolveHermesProjectId } from "../core/sync-helpers.ts";
import { getState } from "../state.ts";

const execFileAsync = promisify(execFile);

export async function handlePreCompress(
  cwd: string,
  config: HermesConfig,
  paths: HermesPaths,
  logger?: Logger,
): Promise<HermesPreCompressOutput> {
  if (!config.sync.enabled || config.sync.repo.length === 0) {
    return {};
  }

  const state = getState();
  const projectId = await resolveHermesProjectId(cwd, state.sessionId, config.sync);
  const relPath = `projects/${projectId}/memory`;

  try {
    await initSyncRepo(config.sync, paths.syncRepoDir);
    await runGit(["add", relPath], paths.syncRepoDir);
    const ts = new Date().toISOString();
    await runGit(
      ["commit", "--allow-empty", "-m", `memex-hermes pre-compress snapshot at ${ts}`],
      paths.syncRepoDir,
    );
  } catch (err) {
    logger?.warn(`memex-hermes[pre-compress]: snapshot failed: ${errMsg(err)}`);
    return {};
  }

  return { summary: `snapshotted ${projectId}` };
}

async function runGit(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd, timeout: 30_000 });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
