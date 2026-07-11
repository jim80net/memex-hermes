/**
 * Hermes harness projection — thin adapter over memex-core origin primitives.
 *
 * Design: docs/specs/2026-07-11-file-rules-shared-origin-projection.md
 * Core: resolveOriginRoot / planProjection / applyProjection (@jim80net/memex-core@0.6+)
 *
 * C5: rules live in skills (no $HERMES_HOME/rules/). Projects origin skills/
 * as skill-dir symlinks into $HERMES_HOME/skills. Does not invent inject paths.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type ApplyProjectionResult,
  applyProjection,
  type ProjectionTarget,
  type ProjectPlan,
  planProjection,
  type ResolvedOriginRoot,
  resolveOriginRoot,
  type SyncProfile,
} from "@jim80net/memex-core";
import type { HermesConfig } from "./config.ts";
import { getProjectSkillsDir, type HermesPaths, projectPluginsEnabled } from "./hermes-paths.ts";

export type ProjectionRunOptions = {
  config: HermesConfig;
  paths: HermesPaths;
  /** Project cwd for optional project-scoped skills projection. Default "". */
  cwd?: string;
  /** When true, plan only — do not apply or mkdir origin. */
  dryRun?: boolean;
  /** Override home for resolveOriginRoot (tests). */
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Origin-relative project skills dir (e.g. projects/<id>/skills).
   * When set AND project plugins enabled, project into <cwd>/.hermes/skills.
   * Omit in v1 default to avoid double-linking origin skills/ into two harness dirs.
   */
  projectOriginRelDir?: string;
};

export type ProjectionRunReport = {
  profileSet: boolean;
  origin: ResolvedOriginRoot | null;
  plan: ProjectPlan | null;
  apply: ApplyProjectionResult | null;
  message: string;
};

/** Profile is set when adapter sync is enabled (maps to SyncProfile.enabled). */
export function isProjectionProfileSet(config: HermesConfig): boolean {
  return config.sync.enabled === true;
}

/**
 * Whether skills are expected to be projected into harness dirs (scan policy).
 * When true, assembleHermesScanDirs must not also append raw origin/checkout skills.
 */
export function skillsProjectionActive(config: HermesConfig): boolean {
  return isProjectionProfileSet(config);
}

/**
 * Build harness-neutral projection targets for Hermes user skills (rules-as-skills).
 *
 * v1: project `<cwd>/.hermes/skills` only when callers pass an explicit
 * `projectOriginRelDir` and HERMES_ENABLE_PROJECT_PLUGINS is truthy.
 */
export function buildHermesProjectionTargets(
  paths: HermesPaths,
  cwd: string,
  opts: { projectOriginRelDir?: string } = {},
): ProjectionTarget[] {
  const targets: ProjectionTarget[] = [
    {
      id: "hermes-user-skills",
      targetDir: paths.skillsDir,
      originRelDir: "skills",
      entryKind: "skill-dirs",
      initTargetDir: true,
    },
  ];
  if (opts.projectOriginRelDir && cwd.length > 0 && projectPluginsEnabled()) {
    targets.push({
      id: "hermes-project-skills",
      targetDir: getProjectSkillsDir(cwd),
      originRelDir: opts.projectOriginRelDir,
      entryKind: "skill-dirs",
      initTargetDir: true,
    });
  }
  return targets;
}

/**
 * Explicit origin root for resolveOriginRoot, if any.
 * Prefer sync.repoDir (Grok-parity override); else local-path sync.repo.
 * Do NOT force C6 paths.syncRepoDir — that would skip product ~/.memex.
 */
export function hermesOriginRootOverride(config: HermesConfig): string | undefined {
  const repoDir = config.sync.repoDir;
  if (typeof repoDir === "string" && repoDir.trim() !== "") {
    return repoDir.trim();
  }
  const repo = config.sync.repo;
  if (typeof repo === "string" && repo.trim() !== "" && isLocalPath(repo.trim())) {
    return repo.trim();
  }
  return undefined;
}

/**
 * Construct a SyncProfile from hermes config (legacy SyncConfig bridge).
 */
export function buildHermesSyncProfile(
  config: HermesConfig,
  paths: HermesPaths,
  cwd: string,
  opts: { projectOriginRelDir?: string } = {},
): SyncProfile {
  return {
    version: 1,
    enabled: config.sync.enabled,
    origin: {
      root: hermesOriginRootOverride(config),
      repo: config.sync.repo || undefined,
    },
    projections: config.sync.enabled ? buildHermesProjectionTargets(paths, cwd, opts) : [],
    onClobber: "fail-closed",
    relinkManaged: true,
    sync: {
      autoPull: config.sync.autoPull,
      autoCommitPush: config.sync.autoCommitPush,
      projectMappings: config.sync.projectMappings,
      caseSensitive: config.sync.caseSensitive,
    },
  };
}

/** Resolve live origin root via core resolver (product default ~/.memex). */
export async function resolveHermesOrigin(
  config: HermesConfig,
  opts: { homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ResolvedOriginRoot> {
  return resolveOriginRoot({
    root: hermesOriginRootOverride(config),
    homeDir: opts.homeDir,
    env: opts.env,
  });
}

/**
 * Ensure origin skills dir exists, plan + apply skill-dir projection into harness.
 * Does not pull/push (session init owns git against paths.syncRepoDir / C6).
 */
export async function runHermesProjection(
  opts: ProjectionRunOptions,
): Promise<ProjectionRunReport> {
  const { config, paths } = opts;
  const cwd = opts.cwd ?? "";
  const dryRun = opts.dryRun === true;

  if (!isProjectionProfileSet(config)) {
    return {
      profileSet: false,
      origin: null,
      plan: null,
      apply: null,
      message: "sync profile not set (sync.enabled=false); enable in memex.json to project skills",
    };
  }

  const origin = await resolveHermesOrigin(config, {
    homeDir: opts.homeDir,
    env: opts.env,
  });

  if (!dryRun) {
    await mkdir(origin.root, { recursive: true });
    await mkdir(join(origin.root, "skills"), { recursive: true });
  }

  const targets = buildHermesProjectionTargets(paths, cwd, {
    projectOriginRelDir: opts.projectOriginRelDir,
  });
  const plan = await planProjection(origin.root, targets, { relinkManaged: true });

  if (dryRun) {
    return {
      profileSet: true,
      origin,
      plan,
      apply: null,
      message: `dry-run: origin=${origin.root} source=${origin.source} links=${plan.links.length} conflicts=${plan.conflicts.length}`,
    };
  }

  const apply = await applyProjection(plan, { onClobber: "fail-closed" });
  return {
    profileSet: true,
    origin,
    plan,
    apply,
    message: `origin=${origin.root} source=${origin.source} linked=${apply.linked} skipped=${apply.skipped} conflicts=${apply.conflicts.length}`,
  };
}

// ---------------------------------------------------------------------------
// Private — mirror hermes-paths local-path heuristic without exporting it
// ---------------------------------------------------------------------------

function isLocalPath(candidate: string): boolean {
  return (
    candidate.startsWith("/") ||
    candidate.startsWith("~") ||
    candidate.startsWith(".") ||
    candidate.startsWith("$")
  );
}
