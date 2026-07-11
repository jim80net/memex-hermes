import type { ScanDirs, ScanRootRegistry } from "@jim80net/memex-core";
import {
  buildScanRoots,
  findMatchingProjectMemoryDirs,
  getSyncScanDirs,
} from "@jim80net/memex-core";
import type { HermesConfig } from "./config.ts";
import { parseExternalDirs } from "./hermes-config-yaml.ts";
import {
  getProjectMemoryDir,
  getProjectSkillsDir,
  type HermesPaths,
  projectPluginsEnabled,
} from "./hermes-paths.ts";
import { skillsProjectionActive } from "./projection.ts";

/** Assemble scan directories — mirrors src/main.ts wiring. */
export async function assembleHermesScanDirs(
  config: HermesConfig,
  paths: HermesPaths,
  cwd: string,
): Promise<ScanDirs> {
  const skillDirs: string[] = [paths.globalSkillsDir];
  if (cwd.length > 0 && projectPluginsEnabled()) {
    skillDirs.push(getProjectSkillsDir(cwd));
  }
  skillDirs.push(...config.skillDirs);
  skillDirs.push(...parseExternalDirs(paths.hermesHome));

  const memoryDirs: string[] = [];
  if (cwd.length > 0) {
    memoryDirs.push(getProjectMemoryDir(cwd, paths.projectsDir));
  }
  memoryDirs.push(...config.memoryDirs);

  const scanDirs: ScanDirs = { skillDirs, memoryDirs, ruleDirs: [] };

  if (config.sync.enabled) {
    // G3: when skills projection is active, harness $HERMES_HOME/skills holds
    // symlinks into origin — do not also append raw checkout skills/ (one blob
    // → one index entry). Memory dirs from sync still append (not projected).
    if (!skillsProjectionActive(config)) {
      const syncDirs = getSyncScanDirs(paths.syncRepoDir);
      scanDirs.skillDirs.push(syncDirs.skillsDir);
    }
    if (cwd.length > 0) {
      const syncMem = await findMatchingProjectMemoryDirs(cwd, paths.syncRepoDir, config.sync);
      scanDirs.memoryDirs.push(...syncMem);
    }
  }

  return scanDirs;
}

/** Labeled scan roots for portable memex:// handles (harness: hermes). */
export function buildHermesScanRoots(
  cwd: string,
  paths: HermesPaths,
  scanDirs: ScanDirs,
  syncEnabled: boolean,
): ScanRootRegistry {
  return buildScanRoots(
    {
      cwd,
      syncRepoDir: paths.syncRepoDir,
      syncEnabled,
      globalSkillsDirs: [paths.globalSkillsDir],
      globalRulesDirs: [paths.globalRulesDir],
      projectSkillsDir: getProjectSkillsDir(cwd),
      projectRulesDir: paths.globalRulesDir,
      harness: "hermes",
    },
    scanDirs,
  );
}
