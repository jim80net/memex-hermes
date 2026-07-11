import { readFile } from "node:fs/promises";
import type { Logger, MemexCoreConfig, SkillType, SyncConfig } from "@jim80net/memex-core";
import { DEFAULT_CORE_CONFIG, resolveCoreConfig } from "@jim80net/memex-core";
import { getHermesPaths } from "./hermes-paths.ts";

// ---------------------------------------------------------------------------
// Types (extend the core config with Hermes-specific sections — design §7)
// ---------------------------------------------------------------------------

/**
 * Hermes sync config. Extends core SyncConfig with the two cross-platform-sync
 * safety knobs from design §7: `suppressSessionIds` (C12 — `_session/*` IDs
 * never push to remote) and `pushRetries` (F9 — rebase-and-retry on
 * non-fast-forward).
 */
export type HermesSyncConfig = SyncConfig & {
  autoPull: boolean;
  autoCommitPush: boolean;
  suppressSessionIds: boolean;
  pushRetries: number;
  /**
   * Optional shared-origin root override for G3 projection (same role as
   * memex-grok `sync.repoDir`). When unset, local-path `sync.repo` may supply
   * the root; otherwise core `resolveOriginRoot` walks product defaults.
   * Does not replace C6 write/push checkout (`paths.syncRepoDir`) unless the
   * operator also points the checkout there via a local-path `sync.repo`.
   */
  repoDir?: string;
};

export type PrefetchConfig = {
  topK: number;
  threshold: number;
  maxInjectedChars: number;
  types: SkillType[];
};

export type ToolConfig = {
  memex_search: { enabled: boolean; defaultLimit: number; threshold: number };
  memex_remember: { enabled: boolean; defaultScope: "project" | "global" };
  memex_recall: { enabled: boolean };
};

export type SessionEndConfig = {
  extractLearnings: boolean;
  extractionModel: string;
};

/**
 * The full Hermes adapter config. Core fields (enabled, embeddingModel,
 * cacheTimeMs, skillDirs, memoryDirs, ...) are inherited from MemexCoreConfig
 * and resolved via memex-core's resolveCoreConfig so they stay byte-identical
 * with the other adapters. Hermes-specific sections layer on top.
 *
 * Note: no `ruleDirs` — rules live in the skills dir with `type: rule`
 * frontmatter (design C5).
 */
export type HermesConfig = MemexCoreConfig & {
  sync: HermesSyncConfig;
  prefetch: PrefetchConfig;
  tools: ToolConfig;
  sessionEnd: SessionEndConfig;
  mirrorHermesMemory: boolean;
};

// ---------------------------------------------------------------------------
// Default
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: HermesConfig = {
  ...DEFAULT_CORE_CONFIG,
  sync: {
    enabled: false,
    repo: "",
    autoPull: true,
    autoCommitPush: true,
    suppressSessionIds: true,
    pushRetries: 3,
    projectMappings: {},
  },
  prefetch: {
    topK: 3,
    threshold: 0.5,
    maxInjectedChars: 8000,
    types: ["skill", "memory", "workflow", "session-learning", "rule"],
  },
  tools: {
    memex_search: { enabled: true, defaultLimit: 5, threshold: 0.4 },
    memex_remember: { enabled: true, defaultScope: "project" },
    memex_recall: { enabled: true },
  },
  sessionEnd: {
    extractLearnings: true,
    extractionModel: "",
  },
  mirrorHermesMemory: true,
};

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Load `$HERMES_HOME/memex.json` and deep-merge it onto the defaults. Core
 * fields are resolved through memex-core's resolveCoreConfig so type
 * validation is shared across adapters; Hermes-specific sections are merged
 * here. A missing or malformed memex.json is tolerated: the defaults are
 * returned and (for malformed) a warning is logged.
 */
export async function loadConfig(hermesHome?: string, logger?: Logger): Promise<HermesConfig> {
  const { configPath } = getHermesPaths(hermesHome);
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    return cloneDefault();
  }

  let user: Partial<HermesConfig>;
  try {
    user = JSON.parse(raw) as Partial<HermesConfig>;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger?.warn(`memex-hermes: malformed memex.json at ${configPath}: ${reason}; using defaults`);
    return cloneDefault();
  }

  return mergeConfig(user);
}

/**
 * Merge a partial user config onto the defaults. Exported for unit testing the
 * merge semantics without touching disk.
 */
export function mergeConfig(user: Partial<HermesConfig>): HermesConfig {
  const core = resolveCoreConfig(user);
  const base = cloneDefault();

  const merged: HermesConfig = {
    ...base,
    ...core,
    sync: base.sync,
    prefetch: base.prefetch,
    tools: base.tools,
    sessionEnd: base.sessionEnd,
    mirrorHermesMemory: base.mirrorHermesMemory,
  };

  if (user.sync) merged.sync = { ...base.sync, ...user.sync };

  if (user.prefetch) {
    merged.prefetch = {
      ...base.prefetch,
      ...user.prefetch,
      types: Array.isArray(user.prefetch.types) ? user.prefetch.types : base.prefetch.types,
    };
  }

  if (user.tools) {
    merged.tools = {
      memex_search: { ...base.tools.memex_search, ...user.tools.memex_search },
      memex_remember: { ...base.tools.memex_remember, ...user.tools.memex_remember },
      memex_recall: { ...base.tools.memex_recall, ...user.tools.memex_recall },
    };
  }

  if (user.sessionEnd) merged.sessionEnd = { ...base.sessionEnd, ...user.sessionEnd };

  if (typeof user.mirrorHermesMemory === "boolean") {
    merged.mirrorHermesMemory = user.mirrorHermesMemory;
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

function cloneDefault(): HermesConfig {
  return {
    ...DEFAULT_CONFIG,
    sync: { ...DEFAULT_CONFIG.sync, projectMappings: { ...DEFAULT_CONFIG.sync.projectMappings } },
    prefetch: { ...DEFAULT_CONFIG.prefetch, types: [...DEFAULT_CONFIG.prefetch.types] },
    tools: {
      memex_search: { ...DEFAULT_CONFIG.tools.memex_search },
      memex_remember: { ...DEFAULT_CONFIG.tools.memex_remember },
      memex_recall: { ...DEFAULT_CONFIG.tools.memex_recall },
    },
    sessionEnd: { ...DEFAULT_CONFIG.sessionEnd },
    types: [...DEFAULT_CONFIG.types],
    skillDirs: [...DEFAULT_CONFIG.skillDirs],
    memoryDirs: [...DEFAULT_CONFIG.memoryDirs],
  };
}
