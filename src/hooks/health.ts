// Hermes.health — cheap reachability probe for Hermes' "is this provider
// alive?" check. We do NOT exercise the embedding model on the network here;
// we only verify the config loads and the sync repo dir (when sync is on) is
// reachable. The actual embedding warm-up belongs to queue-prefetch.
// G3: when projection profile is set, also probe shared origin (cheap lstat);
// full projection audit stays in the doctor skill.

import { access } from "node:fs/promises";
import type { Logger } from "@jim80net/memex-core";
import type { HermesConfig } from "../core/config.ts";
import type { HermesHealthOutput } from "../core/envelope.ts";
import { isProjectionProfileSet, resolveHermesOrigin } from "../core/projection.ts";

export async function handleHealth(
  config: HermesConfig,
  syncRepoDir: string,
  logger?: Logger,
): Promise<HermesHealthOutput> {
  if (!config.enabled) {
    return { ready: false, reason: "memex-hermes disabled in config" };
  }

  if (typeof config.embeddingModel !== "string" || config.embeddingModel.length === 0) {
    return { ready: false, reason: "embeddingModel not configured" };
  }

  if (config.sync.enabled && config.sync.repo.length > 0) {
    try {
      await access(syncRepoDir);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger?.warn(`memex-hermes[health]: sync repo unreachable at ${syncRepoDir}: ${reason}`);
      // Reachability is informational at this level; sync.autoPull on init
      // is where the actual clone happens. Health stays true.
    }
  }

  if (isProjectionProfileSet(config)) {
    try {
      const origin = await resolveHermesOrigin(config);
      if (!origin.exists) {
        logger?.warn(
          `memex-hermes[health]: shared origin not yet present at ${origin.root} (source=${origin.source}); run a session init to project skills`,
        );
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger?.warn(`memex-hermes[health]: origin resolve failed: ${reason}`);
    }
  }

  return { ready: true };
}
