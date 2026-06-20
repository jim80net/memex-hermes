// Hermes.init — register cwd in the project registry, optionally pull the
// sync repo, and capture the per-session agent_context.

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "@jim80net/memex-core";
import {
  initSyncRepo,
  loadRegistry,
  registerProject,
  saveRegistry,
  syncPull,
  withFileLock,
} from "@jim80net/memex-core";
import type { HermesConfig } from "../core/config.ts";
import type { HermesInitArgs, HermesInitOutput } from "../core/envelope.ts";
import type { HermesPaths } from "../core/hermes-paths.ts";
import { captureInit } from "../state.ts";

export async function handleInit(
  args: HermesInitArgs | undefined,
  cwd: string,
  sessionId: string,
  config: HermesConfig,
  paths: HermesPaths,
  logger?: Logger,
): Promise<HermesInitOutput> {
  captureInit({
    agentContext: args?.agent_context ?? "primary",
    sessionId,
    hermesHome: args?.hermes_home ?? paths.hermesHome,
  });

  if (cwd.length > 0) {
    try {
      // The file lock is implemented as `mkdir <registryPath>.lock`; that
      // mkdir is non-recursive so the lock acquisition will spin for 5 s if
      // the cache dir does not yet exist. Ensure the parent dir exists up
      // front to keep the first invocation fast.
      await mkdir(dirname(paths.registryPath), { recursive: true });
      await withFileLock(paths.registryPath, async () => {
        const registry = await loadRegistry(paths.registryPath);
        registerProject(registry, cwd);
        await saveRegistry(paths.registryPath, registry);
      });
    } catch (err) {
      logger?.warn(`memex-hermes[init]: registry update failed: ${errMsg(err)}`);
    }
  }

  if (config.sync.enabled && config.sync.repo.length > 0) {
    try {
      await initSyncRepo(config.sync, paths.syncRepoDir);
    } catch (err) {
      logger?.warn(`memex-hermes[init]: sync repo init failed: ${errMsg(err)}`);
    }
    if (config.sync.autoPull) {
      try {
        const result = await syncPull(config.sync, paths.syncRepoDir);
        logger?.info(`memex-hermes[init]: sync pull — ${result}`);
      } catch (err) {
        logger?.warn(`memex-hermes[init]: sync pull failed: ${errMsg(err)}`);
      }
    }
  }

  return { ok: true };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
