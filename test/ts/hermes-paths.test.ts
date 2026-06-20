import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySyncRepoOverride,
  getHermesPaths,
  getProjectMemoryDir,
  getProjectSkillsDir,
  type HermesPaths,
  projectPluginsEnabled,
  resolveHermesHome,
  resolveSyncRepoDir,
} from "../../src/core/hermes-paths.ts";

const ENV_KEYS = ["MEMEX_HERMES_HOME", "HERMES_ENABLE_PROJECT_PLUGINS"] as const;

describe("resolveHermesHome", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("prefers the explicit argument over the env var", () => {
    process.env.MEMEX_HERMES_HOME = "/from/env";
    expect(resolveHermesHome("/from/arg")).toBe("/from/arg");
  });

  it("falls back to MEMEX_HERMES_HOME when no argument is given", () => {
    process.env.MEMEX_HERMES_HOME = "/data/hermes";
    expect(resolveHermesHome()).toBe("/data/hermes");
  });

  it("falls back to ~/.hermes only when neither arg nor env is set", () => {
    expect(resolveHermesHome()).toBe(join(homedir(), ".hermes"));
  });

  // P3-5 — the fallback must be NON-SILENT (the Python side raises; the binary
  // warns + defaults so a standalone run works but a mis-wired provider call is
  // still visible in stderr).
  it("emits a stderr warning on fallback, and none when a home is provided", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      // No arg, no env → fallback → warning.
      resolveHermesHome();
      expect(writes.some((w) => w.includes("HERMES_HOME unresolved"))).toBe(true);

      // Explicit argument → resolved → no new warning.
      const before = writes.length;
      resolveHermesHome("/data/hermes");
      expect(writes.length).toBe(before);

      // Env var set → resolved → no new warning.
      process.env.MEMEX_HERMES_HOME = "/env/hermes";
      const before2 = writes.length;
      resolveHermesHome();
      expect(writes.length).toBe(before2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("getHermesPaths — custom HERMES_HOME honored end-to-end", () => {
  it("roots skills, memories, and config under the custom home", () => {
    const p = getHermesPaths("/data/hermes");
    expect(p.hermesHome).toBe("/data/hermes");
    expect(p.skillsDir).toBe("/data/hermes/skills");
    expect(p.memoriesDir).toBe("/data/hermes/memories");
    expect(p.memoryFilePath).toBe("/data/hermes/memories/MEMORY.md");
    expect(p.userFilePath).toBe("/data/hermes/memories/USER.md");
    expect(p.configPath).toBe("/data/hermes/memex.json");
    expect(p.hermesConfigPath).toBe("/data/hermes/config.yaml");
  });

  it("roots cache, telemetry, sessions, models, registry, traces under $HERMES_HOME/cache/memex", () => {
    const p = getHermesPaths("/data/hermes");
    const cacheRoot = "/data/hermes/cache/memex";
    expect(p.cacheDir).toBe(cacheRoot);
    expect(p.modelsDir.startsWith(cacheRoot + sep)).toBe(true);
    expect(p.sessionsDir.startsWith(cacheRoot + sep)).toBe(true);
    expect(p.projectsDir.startsWith(cacheRoot + sep)).toBe(true);
    expect(p.telemetryPath.startsWith(cacheRoot + sep)).toBe(true);
    expect(p.registryPath.startsWith(cacheRoot + sep)).toBe(true);
    expect(p.tracesDir.startsWith(cacheRoot + sep)).toBe(true);
    expect(p.memoryMtimesPath.startsWith(cacheRoot + sep)).toBe(true);
  });

  it("never resolves a path under ~/.hermes when a custom home is set", () => {
    const real = join(homedir(), ".hermes");
    const p = getHermesPaths("/data/hermes");
    for (const value of Object.values(p)) {
      expect(value.startsWith(real)).toBe(false);
    }
  });
});

describe("getHermesPaths — rules use the skills directory (C5)", () => {
  it("points globalRulesDir at the skills dir, not a rules/ dir", () => {
    const p = getHermesPaths("/data/hermes");
    expect(p.globalRulesDir).toBe(p.skillsDir);
    expect(p.globalRulesDir).toBe("/data/hermes/skills");
  });

  it("declares no path that ends in a rules/ directory", () => {
    const p = getHermesPaths("/data/hermes");
    for (const value of Object.values(p)) {
      expect(value.endsWith(`${sep}rules`)).toBe(false);
    }
  });
});

describe("getHermesPaths — sync repo default (C6)", () => {
  it("defaults the sync repo to ~/.local/share/memex-hermes", () => {
    const p = getHermesPaths("/data/hermes");
    expect(p.syncRepoDir).toBe(join(homedir(), ".local", "share", "memex-hermes"));
  });
});

describe("resolveSyncRepoDir — sync.repo override", () => {
  it("uses the documented default when no override is given", () => {
    expect(resolveSyncRepoDir()).toBe(join(homedir(), ".local", "share", "memex-hermes"));
  });

  it("uses the documented default when override is empty", () => {
    expect(resolveSyncRepoDir("")).toBe(join(homedir(), ".local", "share", "memex-hermes"));
  });

  it("honors a local-path override", () => {
    expect(resolveSyncRepoDir("/srv/sync/memex")).toBe("/srv/sync/memex");
  });

  it("ignores a git-URL override (remote does not change local checkout dir)", () => {
    expect(resolveSyncRepoDir("git@github.com:jim80net/memex-sync.git")).toBe(
      join(homedir(), ".local", "share", "memex-hermes"),
    );
  });
});

// P2-4 — the TS sync.repo classification + expansion must match the Python
// `_is_local_path` / `_expand` (paths.py), or a `$HOME/repo` override resolves
// to a local checkout on one side and the default on the other. These cases are
// mirrored field-for-field by test/python/test_paths.py::test_sync_repo_path_*
// to pin the cross-language contract.
describe("resolveSyncRepoDir — local-path classification + expansion (P2-4, mirrors Python)", () => {
  const ENV = ["HOME", "MY_ROOT"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.HOME = "/home/tester";
    process.env.MY_ROOT = "/srv/custom";
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const DEFAULT = () => join(homedir(), ".local", "share", "memex-hermes");

  it("$HOME/repo → expanded local path", () => {
    expect(resolveSyncRepoDir("$HOME/repo")).toBe("/home/tester/repo");
  });

  it("braced env-var placeholder → expanded local path", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} placeholder is the test input
    expect(resolveSyncRepoDir("${MY_ROOT}/x")).toBe("/srv/custom/x");
  });

  it("~/repo → expanded under homedir", () => {
    expect(resolveSyncRepoDir("~/repo")).toBe(join(homedir(), "repo"));
  });

  it("/abs → unchanged local path", () => {
    expect(resolveSyncRepoDir("/abs")).toBe("/abs");
  });

  it("./rel → unchanged local path", () => {
    expect(resolveSyncRepoDir("./rel")).toBe("./rel");
  });

  it("git@github.com:o/r.git → URL, falls back to default", () => {
    expect(resolveSyncRepoDir("git@github.com:o/r.git")).toBe(DEFAULT());
  });

  it("https://github.com/o/r.git → URL, falls back to default", () => {
    expect(resolveSyncRepoDir("https://github.com/o/r.git")).toBe(DEFAULT());
  });
});

describe("getProjectMemoryDir", () => {
  it("encodes the cwd under the projects dir", () => {
    const projectsDir = "/data/hermes/cache/memex/projects";
    const dir = getProjectMemoryDir("/home/jim/work", projectsDir);
    expect(dir).toBe(join(projectsDir, "-home-jim-work", "memory"));
  });
});

describe("projectPluginsEnabled — gated on HERMES_ENABLE_PROJECT_PLUGINS", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.HERMES_ENABLE_PROJECT_PLUGINS;
    delete process.env.HERMES_ENABLE_PROJECT_PLUGINS;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.HERMES_ENABLE_PROJECT_PLUGINS;
    else process.env.HERMES_ENABLE_PROJECT_PLUGINS = saved;
  });

  it("is false when unset", () => {
    expect(projectPluginsEnabled()).toBe(false);
  });

  it("is false for falsey-ish values", () => {
    for (const v of ["", "0", "false", "no", "off", "nope"]) {
      process.env.HERMES_ENABLE_PROJECT_PLUGINS = v;
      expect(projectPluginsEnabled()).toBe(false);
    }
  });

  it("is true for truthy values (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "Yes", "on"]) {
      process.env.HERMES_ENABLE_PROJECT_PLUGINS = v;
      expect(projectPluginsEnabled()).toBe(true);
    }
  });

  it("derives the project-local skills dir from cwd", () => {
    expect(getProjectSkillsDir("/cwd")).toBe(join("/cwd", ".hermes", "skills"));
  });
});

describe("getHermesPaths — no real ~/.hermes is touched under a redirected home", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "hermes-paths-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("keeps every path under the supplied home", () => {
    const home = join(tmp, "hermes");
    const p = getHermesPaths(home);
    expect(p.skillsDir.startsWith(home)).toBe(true);
    expect(p.cacheDir.startsWith(home)).toBe(true);
    expect(p.configPath.startsWith(home)).toBe(true);
  });
});

// Regression: the runtime dispatch must wire applySyncRepoOverride. An earlier
// build had resolveSyncRepoDir defined but never called from main.ts, so the
// sync.repo config field was silently ignored. The §11 E2E suite caught this.
// These cases protect the wiring at the helper boundary.
describe("applySyncRepoOverride", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "applySyncRepoOverride-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function baseWithSync(repo: string): HermesPaths {
    // Derive a real baseline from getHermesPaths and override only the field
    // under test. Keeps the fixture in sync with the type without enumerating
    // every field by hand.
    return { ...getHermesPaths("/h"), syncRepoDir: repo };
  }

  it("returns the base object unchanged when syncConfig is undefined", () => {
    const base = baseWithSync("/default/sync");
    expect(applySyncRepoOverride(base, undefined)).toBe(base);
  });

  it("returns the base object unchanged when sync.repo is empty", () => {
    const base = baseWithSync("/default/sync");
    expect(applySyncRepoOverride(base, { repo: "" })).toBe(base);
  });

  it("returns the base object unchanged when sync.repo is a git URL", () => {
    const base = baseWithSync("/default/sync");
    const ssh = applySyncRepoOverride(base, { repo: "git@github.com:owner/repo.git" });
    const https = applySyncRepoOverride(base, { repo: "https://github.com/owner/repo.git" });
    expect(ssh.syncRepoDir).toBe("/default/sync");
    expect(https.syncRepoDir).toBe("/default/sync");
  });

  it("overrides syncRepoDir when sync.repo is a local filesystem path", () => {
    const base = baseWithSync("/default/sync");
    const out = applySyncRepoOverride(base, { repo: tmp });
    expect(out.syncRepoDir).toBe(tmp);
    // Non-sync fields are preserved verbatim
    expect(out.skillsDir).toBe(base.skillsDir);
    expect(out.cacheDir).toBe(base.cacheDir);
    expect(out.configPath).toBe(base.configPath);
  });

  it("returns the base object unchanged when the override resolves to the existing value", () => {
    const base = baseWithSync(tmp);
    const out = applySyncRepoOverride(base, { repo: tmp });
    expect(out).toBe(base);
  });
});
