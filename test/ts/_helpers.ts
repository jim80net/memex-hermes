// Shared test helpers — fake index/embedding provider plus a tmpdir-based
// paths factory so handler tests never touch a real ~/.hermes or
// ~/.local/share/memex-hermes.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  EmbeddingProvider,
  IndexedSkill,
  ScanDirs,
  SkillIndex,
  SkillSearchResult,
} from "@jim80net/memex-core";
import type { HermesPaths } from "../../src/core/hermes-paths.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export async function makeTmpRoot(prefix = "hermes-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export function makeFakePaths(root?: string): HermesPaths {
  const home = root ?? join(tmpdir(), "hermes-fake-home");
  const cache = join(home, "cache", "memex");
  return {
    hermesHome: home,
    skillsDir: join(home, "skills"),
    memoriesDir: join(home, "memories"),
    memoryFilePath: join(home, "memories", "MEMORY.md"),
    userFilePath: join(home, "memories", "USER.md"),
    configPath: join(home, "memex.json"),
    hermesConfigPath: join(home, "config.yaml"),
    memoryMtimesPath: join(cache, "memory-mtimes.json"),
    cacheDir: cache,
    modelsDir: join(cache, "models"),
    sessionsDir: join(cache, "sessions"),
    projectsDir: join(cache, "projects"),
    telemetryPath: join(cache, "memex-telemetry.json"),
    registryPath: join(cache, "memex-projects.json"),
    tracesDir: join(cache, "memex-traces"),
    syncRepoDir: join(home, "sync-repo"),
    globalSkillsDir: join(home, "skills"),
    globalRulesDir: join(home, "skills"),
  };
}

// ---------------------------------------------------------------------------
// Fake embedding provider (deterministic per-string output)
// ---------------------------------------------------------------------------

export class FakeEmbeddingProvider implements EmbeddingProvider {
  public calls: string[][] = [];

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    return texts.map((t) => hashEmbedding(t));
  }
}

function hashEmbedding(text: string): number[] {
  // 8-dim deterministic vector; values in [0,1).
  const vec = new Array(8).fill(0);
  let h = 0x12345678;
  for (let i = 0; i < text.length; i++) {
    h = (h ^ text.charCodeAt(i)) * 0x01000193;
  }
  for (let i = 0; i < 8; i++) {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    vec[i] = (h % 1000) / 1000;
  }
  // Normalize.
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

// ---------------------------------------------------------------------------
// Fake SkillIndex with a controllable result set
// ---------------------------------------------------------------------------

export class FakeSkillIndex {
  public skillCount: number;
  public results: SkillSearchResult[];
  public bodies: Map<string, string>;
  public lastSearch: { query: string; topK: number; threshold: number; types?: string[] } | null =
    null;

  constructor(results: SkillSearchResult[] = [], bodies: Map<string, string> = new Map()) {
    this.results = results;
    this.bodies = bodies;
    this.skillCount = results.length;
  }

  async build(_dirs: ScanDirs): Promise<void> {
    return;
  }

  needsRebuild(): boolean {
    return false;
  }

  async search(
    query: string,
    topK: number,
    threshold: number,
    types?: string[],
  ): Promise<SkillSearchResult[]> {
    this.lastSearch = { query, topK, threshold, types };
    let pool = this.results;
    if (types && types.length > 0) {
      const allowed = new Set(types);
      pool = pool.filter((r) => allowed.has(r.skill.type));
    }
    return pool.filter((r) => r.score >= threshold).slice(0, topK);
  }

  async readSkillContent(location: string): Promise<string> {
    const body = this.bodies.get(location);
    if (body === undefined) {
      throw new Error(`no body for ${location}`);
    }
    return body;
  }
}

export function makeSkill(args: {
  name: string;
  type?: IndexedSkill["type"];
  location?: string;
  description?: string;
  oneLiner?: string;
}): IndexedSkill {
  const location = args.location ?? `/fake/${args.name}/SKILL.md`;
  return {
    name: args.name,
    description: args.description ?? `desc ${args.name}`,
    location,
    type: args.type ?? "skill",
    embeddings: [hashEmbedding(args.name)],
    queries: [args.name],
    oneLiner: args.oneLiner,
  };
}

export function makeFakeIndexAndProvider(): {
  index: SkillIndex;
  provider: EmbeddingProvider;
} {
  return {
    index: new FakeSkillIndex() as unknown as SkillIndex,
    provider: new FakeEmbeddingProvider(),
  };
}

// ---------------------------------------------------------------------------
// Git helpers (test-only — fake remotes via bare repos)
// ---------------------------------------------------------------------------

export interface FakeGitSetup {
  syncRepoDir: string;
  remoteDir: string;
}

export async function setupBareRemoteAndClone(root: string): Promise<FakeGitSetup> {
  const remoteDir = join(root, "remote.git");
  const syncRepoDir = join(root, "sync");
  await mkdir(remoteDir, { recursive: true });
  await execFileAsync("git", ["init", "--bare", "-b", "main"], { cwd: remoteDir });

  await mkdir(syncRepoDir, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: syncRepoDir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: syncRepoDir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: syncRepoDir });
  await execFileAsync("git", ["remote", "add", "origin", remoteDir], { cwd: syncRepoDir });

  // Seed the repo with an empty commit so the branch exists.
  await writeFile(join(syncRepoDir, ".gitkeep"), "", "utf-8");
  await execFileAsync("git", ["add", ".gitkeep"], { cwd: syncRepoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: syncRepoDir });
  await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: syncRepoDir });

  return { syncRepoDir, remoteDir };
}
