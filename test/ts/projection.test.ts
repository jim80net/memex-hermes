import { lstat, mkdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type HermesConfig } from "../../src/core/config.ts";
import { getHermesPaths } from "../../src/core/hermes-paths.ts";
import {
  buildHermesProjectionTargets,
  hermesOriginRootOverride,
  isProjectionProfileSet,
  runHermesProjection,
  skillsProjectionActive,
} from "../../src/core/projection.ts";
import { assembleHermesScanDirs } from "../../src/core/scan-roots.ts";
import { makeTmpRoot } from "./_helpers.ts";

describe("projection profile gate", () => {
  it("is off when sync.enabled is false (default)", () => {
    expect(isProjectionProfileSet(DEFAULT_CONFIG)).toBe(false);
    expect(skillsProjectionActive(DEFAULT_CONFIG)).toBe(false);
  });

  it("is on when sync.enabled is true", () => {
    const config: HermesConfig = {
      ...DEFAULT_CONFIG,
      sync: { ...DEFAULT_CONFIG.sync, enabled: true },
    };
    expect(isProjectionProfileSet(config)).toBe(true);
    expect(skillsProjectionActive(config)).toBe(true);
  });
});

describe("hermesOriginRootOverride", () => {
  it("prefers sync.repoDir over local-path repo", () => {
    const config: HermesConfig = {
      ...DEFAULT_CONFIG,
      sync: {
        ...DEFAULT_CONFIG.sync,
        enabled: true,
        repoDir: "/explicit/origin",
        repo: "/local/repo",
      },
    };
    expect(hermesOriginRootOverride(config)).toBe("/explicit/origin");
  });

  it("uses local-path sync.repo when repoDir unset", () => {
    const config: HermesConfig = {
      ...DEFAULT_CONFIG,
      sync: { ...DEFAULT_CONFIG.sync, enabled: true, repo: "~/my-origin" },
    };
    expect(hermesOriginRootOverride(config)).toBe("~/my-origin");
  });

  it("ignores git URL sync.repo (no forced C6)", () => {
    const config: HermesConfig = {
      ...DEFAULT_CONFIG,
      sync: {
        ...DEFAULT_CONFIG.sync,
        enabled: true,
        repo: "git@github.com:example/corpus.git",
      },
    };
    expect(hermesOriginRootOverride(config)).toBeUndefined();
  });
});

describe("buildHermesProjectionTargets", () => {
  it("targets user skills only by default (no rules dir)", () => {
    const paths = getHermesPaths("/tmp/hermes-home");
    const targets = buildHermesProjectionTargets(paths, "/tmp/project");
    expect(targets).toHaveLength(1);
    expect(targets[0]!.id).toBe("hermes-user-skills");
    expect(targets[0]!.targetDir).toBe(paths.skillsDir);
    expect(targets[0]!.originRelDir).toBe("skills");
    expect(targets[0]!.entryKind).toBe("skill-dirs");
    expect(targets[0]!.targetDir.endsWith("/rules")).toBe(false);
  });
});

describe("runHermesProjection", () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTmpRoot();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("no-ops when profile not set", async () => {
    const hermesHome = join(root, "hermes");
    const paths = getHermesPaths(hermesHome);
    const report = await runHermesProjection({
      config: DEFAULT_CONFIG,
      paths,
      homeDir: root,
    });
    expect(report.profileSet).toBe(false);
    expect(report.plan).toBeNull();
  });

  it("creates skill-dir symlink into origin and is idempotent", async () => {
    const hermesHome = join(root, "hermes");
    const originRoot = join(root, "origin");
    const skillName = "dogfood-skill";
    const originSkill = join(originRoot, "skills", skillName);
    await mkdir(originSkill, { recursive: true });
    await writeFile(join(originSkill, "SKILL.md"), "---\nname: dogfood\n---\nbody\n");

    const paths = getHermesPaths(hermesHome);
    const config: HermesConfig = {
      ...DEFAULT_CONFIG,
      sync: { ...DEFAULT_CONFIG.sync, enabled: true, repoDir: originRoot },
    };

    const first = await runHermesProjection({ config, paths, homeDir: root });
    expect(first.profileSet).toBe(true);
    expect(first.apply?.linked).toBe(1);
    expect(first.apply?.conflicts).toHaveLength(0);

    const linkPath = join(paths.skillsDir, skillName);
    const st = await lstat(linkPath);
    expect(st.isSymbolicLink()).toBe(true);
    const target = await realpath(linkPath);
    expect(target).toBe(await realpath(originSkill));
    expect(await readlink(linkPath)).toBe(originSkill);

    const second = await runHermesProjection({ config, paths, homeDir: root });
    expect(second.apply?.skipped).toBeGreaterThanOrEqual(1);
    expect(second.apply?.conflicts).toHaveLength(0);
  });

  it("fail-closed: does not clobber a real skill directory", async () => {
    const hermesHome = join(root, "hermes");
    const originRoot = join(root, "origin");
    const skillName = "local-skill";
    const originSkill = join(originRoot, "skills", skillName);
    await mkdir(originSkill, { recursive: true });
    await writeFile(join(originSkill, "SKILL.md"), "---\nname: origin\n---\n");

    const paths = getHermesPaths(hermesHome);
    const localSkill = join(paths.skillsDir, skillName);
    await mkdir(localSkill, { recursive: true });
    await writeFile(join(localSkill, "SKILL.md"), "---\nname: local\n---\nkeep\n");

    const config: HermesConfig = {
      ...DEFAULT_CONFIG,
      sync: { ...DEFAULT_CONFIG.sync, enabled: true, repoDir: originRoot },
    };

    const report = await runHermesProjection({ config, paths, homeDir: root });
    expect(report.apply?.conflicts.length).toBeGreaterThanOrEqual(1);
    const conflict = report.apply!.conflicts.find((c) => c.targetPath === localSkill);
    expect(conflict).toBeDefined();
    expect(conflict!.reason).toBe("real-dir");

    const st = await lstat(localSkill);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isDirectory()).toBe(true);
  });

  it("dry-run plans without linking", async () => {
    const hermesHome = join(root, "hermes");
    const originRoot = join(root, "origin");
    await mkdir(join(originRoot, "skills", "x"), { recursive: true });
    await writeFile(join(originRoot, "skills", "x", "SKILL.md"), "---\nname: x\n---\n");

    const paths = getHermesPaths(hermesHome);
    const config: HermesConfig = {
      ...DEFAULT_CONFIG,
      sync: { ...DEFAULT_CONFIG.sync, enabled: true, repoDir: originRoot },
    };

    const report = await runHermesProjection({
      config,
      paths,
      homeDir: root,
      dryRun: true,
    });
    expect(report.apply).toBeNull();
    expect(report.plan?.links.length).toBe(1);
    await expect(lstat(join(paths.skillsDir, "x"))).rejects.toThrow();
  });
});

describe("assembleHermesScanDirs — no double-index when projected", () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTmpRoot();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("when projection active (sync.enabled), does not append raw checkout skills", async () => {
    const hermesHome = join(root, "hermes");
    const paths = getHermesPaths(hermesHome);
    const config: HermesConfig = {
      ...DEFAULT_CONFIG,
      sync: { ...DEFAULT_CONFIG.sync, enabled: true },
    };
    const scan = await assembleHermesScanDirs(config, paths, "");
    expect(scan.skillDirs).toContain(paths.globalSkillsDir);
    expect(scan.skillDirs).not.toContain(join(paths.syncRepoDir, "skills"));
    expect(scan.ruleDirs).toEqual([]);
  });

  it("when sync off, does not append checkout skills either", async () => {
    const hermesHome = join(root, "hermes");
    const paths = getHermesPaths(hermesHome);
    const scan = await assembleHermesScanDirs(DEFAULT_CONFIG, paths, "");
    expect(scan.skillDirs).not.toContain(join(paths.syncRepoDir, "skills"));
  });
});
