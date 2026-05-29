import { homedir } from "node:os";
import { join } from "node:path";
import type { MemexPaths } from "@jim80net/memex-core";
import { encodeProjectPath } from "@jim80net/memex-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Hermes-specific path layout. Composes memex-core's MemexPaths (cache,
 * models, sessions, telemetry, registry, traces, sync repo, project memory)
 * with the Hermes-side on-disk locations: the skills dir, the two built-in
 * memory files, the memex.json config, and the Hermes config.yaml.
 *
 * Per design C5, rules live in `skillsDir/<name>/SKILL.md` with `type: rule`
 * frontmatter; there is deliberately no `rulesDir`. `globalRulesDir` is
 * required by the MemexPaths contract, so it is pointed at the skills dir
 * (the directory rules actually live in) rather than a foreign `rules/` dir
 * that the adapter must never create or scan.
 */
export type HermesPaths = MemexPaths & {
  hermesHome: string;
  skillsDir: string;
  memoriesDir: string;
  memoryFilePath: string;
  userFilePath: string;
  configPath: string;
  hermesConfigPath: string;
  memoryMtimesPath: string;
};

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Resolve the Hermes home directory. Priority: explicit argument, then the
 * MEMEX_HERMES_HOME environment variable (set by the Python runner on every
 * subprocess invocation), then the documented default `~/.hermes`.
 *
 * The literal `~/.hermes` only appears here as the final fallback; every
 * caller derives from the resolved value, never from a hardcoded string.
 */
export function resolveHermesHome(hermesHome?: string): string {
  if (hermesHome && hermesHome.length > 0) return hermesHome;
  const fromEnv = process.env.MEMEX_HERMES_HOME;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".hermes");
}

/**
 * Build the full Hermes path layout from a resolved HERMES_HOME.
 *
 * Cache root is `$HERMES_HOME/cache/memex/` (design C4) — sandboxed per
 * harness so telemetry stays attributable and never collides with
 * `~/.claude/cache/`. The sync repo defaults to `~/.local/share/memex-hermes/`
 * (design C6); use {@link resolveSyncRepoDir} to honor a `sync.repo` override.
 */
export function getHermesPaths(hermesHome?: string): HermesPaths {
  const home = resolveHermesHome(hermesHome);
  const skillsDir = join(home, "skills");
  const memoriesDir = join(home, "memories");
  const cacheDir = join(home, "cache", "memex");
  return {
    hermesHome: home,
    skillsDir,
    memoriesDir,
    memoryFilePath: join(memoriesDir, "MEMORY.md"),
    userFilePath: join(memoriesDir, "USER.md"),
    configPath: join(home, "memex.json"),
    hermesConfigPath: join(home, "config.yaml"),
    cacheDir,
    modelsDir: join(cacheDir, "models"),
    sessionsDir: join(cacheDir, "sessions"),
    projectsDir: join(cacheDir, "projects"),
    telemetryPath: join(cacheDir, "memex-telemetry.json"),
    registryPath: join(cacheDir, "memex-projects.json"),
    tracesDir: join(cacheDir, "memex-traces"),
    memoryMtimesPath: join(cacheDir, "memory-mtimes.json"),
    syncRepoDir: defaultSyncRepoDir(),
    globalSkillsDir: skillsDir,
    globalRulesDir: skillsDir,
  };
}

/**
 * Project memory directory for a given cwd within the local cache. Mirrors
 * memex-claude's encoding so the on-disk layout stays byte-identical across
 * adapters.
 */
export function getProjectMemoryDir(cwd: string, projectsDir: string): string {
  const encoded = encodeProjectPath(cwd);
  return join(projectsDir, encoded, "memory");
}

/**
 * Resolve the local sync repo directory, honoring a `sync.repo` override only
 * when it names a local filesystem path. A `sync.repo` that is a git URL
 * (remote) does not change the local checkout location, so the documented
 * default `~/.local/share/memex-hermes/` is used. Pass the override through
 * `syncRepo`; empty / URL values fall back to the default.
 */
export function resolveSyncRepoDir(syncRepo?: string): string {
  if (syncRepo && isLocalPath(syncRepo)) return syncRepo;
  return defaultSyncRepoDir();
}

/**
 * Apply a `sync.repo` config override to a base {@link HermesPaths}. Used by
 * the runtime dispatch in `main.ts` so the resolver actually fires — keeping
 * `getHermesPaths()` as a pure environment-only resolver while the override
 * lands at the call site that has access to the loaded config. Returns the
 * base object unchanged when no local-path override applies.
 */
export function applySyncRepoOverride(
  base: HermesPaths,
  syncConfig: { repo?: string } | undefined,
): HermesPaths {
  // Only LOCAL-PATH overrides move the checkout. Empty/missing/git-URL overrides
  // mean the caller did not specify a local path — leave the base unchanged so
  // a user with a non-default `paths.syncRepoDir` does not get reset to the
  // documented default by a remote-URL config (`resolveSyncRepoDir` flattens
  // both empty and URL to the default; that's correct for cold resolution but
  // would be a surprise for an override on top of a base).
  if (!syncConfig?.repo || !isLocalPath(syncConfig.repo)) return base;
  if (syncConfig.repo === base.syncRepoDir) return base;
  return { ...base, syncRepoDir: syncConfig.repo };
}

/**
 * Project-local skill directory for a cwd. Only scanned when
 * HERMES_ENABLE_PROJECT_PLUGINS is truthy (see {@link projectPluginsEnabled}).
 */
export function getProjectSkillsDir(cwd: string): string {
  return join(cwd, ".hermes", "skills");
}

/**
 * Whether Hermes has opted into scanning project-local skill directories.
 * Truthy values: "1", "true", "yes", "on" (case-insensitive). Unset or any
 * other value disables project-local scanning.
 */
export function projectPluginsEnabled(): boolean {
  const raw = process.env.HERMES_ENABLE_PROJECT_PLUGINS;
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

function defaultSyncRepoDir(): string {
  return join(homedir(), ".local", "share", "memex-hermes");
}

function isLocalPath(candidate: string): boolean {
  return candidate.startsWith("/") || candidate.startsWith("~") || candidate.startsWith(".");
}
