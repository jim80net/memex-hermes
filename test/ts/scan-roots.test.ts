import { join } from "node:path";
import { decodePortableLocation, encodePortableLocation } from "@jim80net/memex-core";
import { describe, expect, it } from "vitest";
import type { HermesPaths } from "../../src/core/hermes-paths.ts";
import { buildHermesScanRoots } from "../../src/core/scan-roots.ts";

describe("buildHermesScanRoots", () => {
  const cwd = "/home/user/project";
  const hermesHome = "/home/user/.hermes";

  it("labels hermes-global, hermes-project, and sync-skills roots", () => {
    const paths = {
      hermesHome,
      skillsDir: join(hermesHome, "skills"),
      globalSkillsDir: join(hermesHome, "skills"),
      globalRulesDir: join(hermesHome, "skills"),
      syncRepoDir: "/home/user/.local/share/memex-hermes",
    } as HermesPaths;

    const scanDirs = {
      skillDirs: [
        paths.globalSkillsDir,
        join(cwd, ".hermes", "skills"),
        join(paths.syncRepoDir, "skills"),
      ],
      memoryDirs: [join(hermesHome, "cache", "memex", "projects", "abc", "memory")],
      ruleDirs: [],
    };

    const registry = buildHermesScanRoots(cwd, paths, scanDirs, true);

    const globalSkill = join(hermesHome, "skills", "weather", "SKILL.md");
    const projectSkill = join(cwd, ".hermes", "skills", "deploy", "SKILL.md");
    const syncSkill = join(paths.syncRepoDir, "skills", "weather", "SKILL.md");

    expect(encodePortableLocation(registry, globalSkill)).toBe(
      "memex://hermes-global/weather/SKILL.md",
    );
    expect(encodePortableLocation(registry, projectSkill)).toBe(
      "memex://hermes-project/deploy/SKILL.md",
    );
    expect(encodePortableLocation(registry, syncSkill)).toBe(
      "memex://sync-skills/weather/SKILL.md",
    );

    expect(decodePortableLocation(registry, "memex://hermes-global/weather/SKILL.md")).toBe(
      globalSkill,
    );
  });
});
