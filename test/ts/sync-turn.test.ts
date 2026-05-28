// Hermes.sync-turn — mtime watcher behavior (hermes-engine-events R3,
// hermes-sync-bridge R1). Tests use a real local git repo (no remote) so we
// exercise the mirror+commit path without engaging the push step.

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type HermesConfig } from "../../src/core/config.ts";
import { handleSyncTurn } from "../../src/hooks/sync-turn.ts";
import { resetState } from "../../src/state.ts";
import { makeFakePaths, makeTmpRoot } from "./_helpers.ts";

const execFileAsync = promisify(execFile);

async function initLocalRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, ".gitkeep"), "");
  await execFileAsync("git", ["add", ".gitkeep"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
}

describe("handleSyncTurn — mtime watcher", () => {
  let root: string;
  let config: HermesConfig;
  let paths: ReturnType<typeof makeFakePaths>;

  beforeEach(async () => {
    resetState();
    root = await makeTmpRoot();
    paths = makeFakePaths(root);
    await initLocalRepo(paths.syncRepoDir);
    await mkdir(paths.memoriesDir, { recursive: true });
    await mkdir(paths.cacheDir, { recursive: true });
    config = { ...DEFAULT_CONFIG, mirrorHermesMemory: true };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("unchanged mtimes are a no-op (no commit produced)", async () => {
    // Files don't exist yet — sync-turn should return {ok:true} without mirroring.
    const result = await handleSyncTurn(
      { user_content: "hi", assistant_content: "hello" },
      root,
      config,
      paths,
    );
    expect(result).toEqual({ ok: true });
  });

  it("mtime change on MEMORY.md triggers a mirror + commit", async () => {
    await writeFile(paths.memoryFilePath, "memory v1\n", "utf-8");

    const result = await handleSyncTurn(
      { user_content: "u", assistant_content: "a", session_id: "s1" },
      root,
      config,
      paths,
    );
    expect(result.ok).toBe(true);
    expect(result.mirrored).toContain("memory");

    // Mirror file landed under projects/<id>/memory/MEMORY.md
    const memDir = join(paths.syncRepoDir, "projects");
    const projectId = await firstProjectId(memDir);
    const mirrored = join(memDir, projectId, "memory", "MEMORY.md");
    expect((await readFile(mirrored, "utf-8")).trim()).toBe("memory v1");
  });

  it("USER.md edits are mirrored too", async () => {
    await writeFile(paths.userFilePath, "user file content", "utf-8");
    const result = await handleSyncTurn(
      { user_content: "u", assistant_content: "a", session_id: "s-user" },
      root,
      config,
      paths,
    );
    expect(result.mirrored).toContain("user");
  });

  it("mtime persistence: a subsequent call with unchanged file does not re-mirror", async () => {
    await writeFile(paths.memoryFilePath, "memory v1\n", "utf-8");
    const first = await handleSyncTurn(
      { user_content: "u", assistant_content: "a", session_id: "s2" },
      root,
      config,
      paths,
    );
    expect(first.mirrored).toContain("memory");

    const second = await handleSyncTurn(
      { user_content: "u2", assistant_content: "a2", session_id: "s2" },
      root,
      config,
      paths,
    );
    expect(second.mirrored).toBeUndefined();
  });

  it("re-mirrors when mtime advances", async () => {
    await writeFile(paths.memoryFilePath, "memory v1\n", "utf-8");
    await handleSyncTurn(
      { user_content: "u", assistant_content: "a", session_id: "s3" },
      root,
      config,
      paths,
    );

    // Bump mtime by writing new content.
    const futureSec = (await stat(paths.memoryFilePath)).mtimeMs / 1000 + 10;
    await writeFile(paths.memoryFilePath, "memory v2\n", "utf-8");
    await utimes(paths.memoryFilePath, futureSec, futureSec);
    const second = await handleSyncTurn(
      { user_content: "u", assistant_content: "a", session_id: "s3" },
      root,
      config,
      paths,
    );
    expect(second.mirrored).toContain("memory");
  });

  it("mirrorHermesMemory=false short-circuits the watcher", async () => {
    await writeFile(paths.memoryFilePath, "memory should NOT mirror", "utf-8");
    const result = await handleSyncTurn(
      { user_content: "u", assistant_content: "a", session_id: "s4" },
      root,
      { ...config, mirrorHermesMemory: false },
      paths,
    );
    expect(result.mirrored).toBeUndefined();
  });
});

async function firstProjectId(projectsDir: string): Promise<string> {
  // Walk one level deep — _local/<encoded> or host/owner/repo.
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(projectsDir);
  if (entries.length === 0) throw new Error("no project dirs");
  if (entries[0] === "_local") {
    const sub = await readdir(join(projectsDir, "_local"));
    return `_local/${sub[0]}`;
  }
  if (entries[0] === "_session") {
    const sub = await readdir(join(projectsDir, "_session"));
    return `_session/${sub[0]}`;
  }
  // host/owner/repo
  const host = entries[0];
  const owners = await readdir(join(projectsDir, host));
  const repos = await readdir(join(projectsDir, host, owners[0]));
  return `${host}/${owners[0]}/${repos[0]}`;
}
