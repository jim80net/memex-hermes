// Hermes.sync-turn — runs once per (user, assistant) turn. Three jobs:
//
//   1. Append the turn to the session trace via TraceAccumulator.
//   2. Record telemetry attribution for any entries injected by the prior
//      prefetch (we deferred that record until now because we needed to know
//      the model actually saw the injection).
//   3. The mtime-watcher (G19 / hermes-sync-bridge R1): stat
//      $HERMES_HOME/memories/{MEMORY,USER}.md, compare to the recorded
//      mtimes, mirror any changed file into the sync repo. This is the
//      mandatory path that captures built-in `remove` (which does NOT fire
//      on_memory_write, per tool_executor.py:640) and out-of-band edits.

import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "@jim80net/memex-core";
import { loadTelemetry, recordMatch, saveTelemetry, withFileLock } from "@jim80net/memex-core";
import type { HermesConfig } from "../core/config.ts";
import type {
  HermesMemoryTarget,
  HermesSyncTurnArgs,
  HermesSyncTurnOutput,
} from "../core/envelope.ts";
import type { HermesPaths } from "../core/hermes-paths.ts";
import { loadMemoryMtimes, saveMemoryMtimes } from "../core/memory-mtimes.ts";
import { takePersistedPrefetchInjections } from "../core/prefetch-injections.ts";
import { getState, type PrefetchInjection, takePrefetchInjections } from "../state.ts";
import { mirrorAndCommit } from "./_mirror.ts";

export async function handleSyncTurn(
  args: HermesSyncTurnArgs | undefined,
  cwd: string,
  config: HermesConfig,
  paths: HermesPaths,
  logger?: Logger,
): Promise<HermesSyncTurnOutput> {
  const state = getState();
  const sid = args?.session_id ?? state.sessionId;

  await flushPrefetchTelemetry(sid, paths, logger);

  const mirrored = await runMtimeWatcher(cwd, sid, config, paths, logger);

  return mirrored.length > 0 ? { ok: true, mirrored } : { ok: true };
}

// ---------------------------------------------------------------------------
// Private — telemetry
// ---------------------------------------------------------------------------

async function flushPrefetchTelemetry(
  sessionId: string,
  paths: HermesPaths,
  logger?: Logger,
): Promise<void> {
  if (sessionId.length === 0) return;

  // The disk handoff is the production source: prefetch ran in a separate
  // subprocess, so its in-process buffer never survives to here. The persisted
  // set is take-once (loaded + deleted) so a later turn can't double-count.
  // We always drain the in-process buffer too — to clear it in single-process
  // test harnesses — but the persisted set takes precedence when present so
  // those harnesses (which set BOTH) attribute each injection exactly once.
  let injections: PrefetchInjection[];
  try {
    injections = await takePersistedPrefetchInjections(sessionId, paths.cacheDir);
  } catch (err) {
    logger?.warn(`memex-hermes[sync-turn]: injection load failed: ${errMsg(err)}`);
    injections = [];
  }
  const inProcess = takePrefetchInjections();
  if (injections.length === 0) injections = inProcess;
  if (injections.length === 0) return;

  const telemetryPath = paths.telemetryPath;
  try {
    await mkdir(dirname(telemetryPath), { recursive: true });
    await withFileLock(telemetryPath, async () => {
      const telemetry = await loadTelemetry(telemetryPath);
      for (const { location, bestQueryIndex } of injections) {
        recordMatch(telemetry, location, sessionId, bestQueryIndex);
      }
      await saveTelemetry(telemetryPath, telemetry);
    });
  } catch (err) {
    logger?.warn(`memex-hermes[sync-turn]: telemetry save failed: ${errMsg(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Private — mtime watcher (G19 mandatory path)
// ---------------------------------------------------------------------------

async function runMtimeWatcher(
  cwd: string,
  sessionId: string,
  config: HermesConfig,
  paths: HermesPaths,
  logger?: Logger,
): Promise<HermesMemoryTarget[]> {
  if (!config.mirrorHermesMemory) return [];

  const trackedFiles: Array<{ target: HermesMemoryTarget; path: string }> = [
    { target: "memory", path: paths.memoryFilePath },
    { target: "user", path: paths.userFilePath },
  ];

  const persisted = await loadMemoryMtimes(paths.memoryMtimesPath);
  const mirrored: HermesMemoryTarget[] = [];
  let dirty = false;

  for (const { target, path } of trackedFiles) {
    let currentMtime: number;
    let content: string;
    try {
      const s = await stat(path);
      currentMtime = s.mtimeMs;
      content = await readFile(path, "utf-8");
    } catch {
      // File doesn't exist — skip (built-in remove may have unlinked it, but
      // Hermes recreates it; until it exists there's nothing to mirror).
      continue;
    }

    const previous = persisted.mtimes[path];
    if (previous === currentMtime) continue;

    try {
      await mirrorAndCommit(
        { target, content, cwd, sessionId, reason: "sync-turn mtime" },
        config,
        paths.syncRepoDir,
        logger,
      );
      mirrored.push(target);
    } catch (err) {
      logger?.warn(`memex-hermes[sync-turn]: mirror ${target} failed: ${errMsg(err)}`);
      continue;
    }
    persisted.mtimes[path] = currentMtime;
    dirty = true;
  }

  if (dirty) {
    try {
      await saveMemoryMtimes(paths.memoryMtimesPath, persisted);
    } catch (err) {
      logger?.warn(`memex-hermes[sync-turn]: mtime persist failed: ${errMsg(err)}`);
    }
  }
  return mirrored;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
