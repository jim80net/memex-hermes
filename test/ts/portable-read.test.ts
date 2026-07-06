import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingProvider } from "@jim80net/memex-core";
import { DEFAULT_CORE_CONFIG, encodePortableLocation, SkillIndex } from "@jim80net/memex-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HermesPaths } from "../../src/core/hermes-paths.ts";
import { buildHermesScanRoots } from "../../src/core/scan-roots.ts";

const SKILL_BODY = "Recall via portable handle.";

describe("portable handle read path", () => {
  let root: string;
  let cwd: string;
  let hermesHome: string;
  let paths: HermesPaths;
  let cachePath: string;
  let mockEmbed: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    root = join(tmpdir(), `hermes-portable-${Date.now()}`);
    cwd = join(root, "workspace");
    hermesHome = join(root, ".hermes");
    cachePath = join(hermesHome, "cache", "memex", "memex-cache.json");
    paths = {
      hermesHome,
      skillsDir: join(hermesHome, "skills"),
      globalSkillsDir: join(hermesHome, "skills"),
      globalRulesDir: join(hermesHome, "skills"),
      syncRepoDir: join(root, "sync"),
    } as HermesPaths;

    await mkdir(join(hermesHome, "skills", "weather"), { recursive: true });
    await writeFile(
      join(hermesHome, "skills", "weather", "SKILL.md"),
      `---
name: weather
description: Weather
---
${SKILL_BODY}
`,
      "utf-8",
    );

    mockEmbed = vi.fn().mockResolvedValue([[1, 0, 0, 0]]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("readSkillContent round-trips memex:// handle from registry-wired index", async () => {
    const scanDirs = {
      skillDirs: [paths.globalSkillsDir],
      memoryDirs: [],
      ruleDirs: [],
    };
    const registry = buildHermesScanRoots(cwd, paths, scanDirs, false);
    const skillPath = join(hermesHome, "skills", "weather", "SKILL.md");
    const handle = encodePortableLocation(registry, skillPath);
    expect(handle).toBe("memex://hermes-global/weather/SKILL.md");

    const provider: EmbeddingProvider = { embed: mockEmbed };
    const index = new SkillIndex({ ...DEFAULT_CORE_CONFIG }, provider, cachePath, {
      registry,
    });
    await index.build(scanDirs);

    expect(await index.readSkillContent(handle!)).toBe(SKILL_BODY);
  });
});
