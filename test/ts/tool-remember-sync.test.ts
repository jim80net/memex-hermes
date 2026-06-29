// memex_remember commit/push wiring (#6) — the entry must actually reach the
// remote (the tool's headline cross-adapter purpose), and `synced` must be a
// committed-AND-pushed confirmation, not an eligibility prediction.

import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "@jim80net/memex-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HermesConfig } from "../../src/core/config.ts";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import { handleToolRemember } from "../../src/hooks/tool-remember.ts";
import { captureInit, resetState } from "../../src/state.ts";
import { cloneRemote, makeFakePaths, makeTmpRoot, setupBareRemoteAndClone } from "./_helpers.ts";

async function listMd(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);
  } catch {
    return [];
  }
}

function syncConfig(repo: string, autoCommitPush: boolean, pushRetries = 3): HermesConfig {
  return {
    ...DEFAULT_CONFIG,
    sync: { ...DEFAULT_CONFIG.sync, enabled: true, repo, autoCommitPush, pushRetries },
  };
}

describe("memex_remember commit/push (#6)", () => {
  let root: string;
  let paths: ReturnType<typeof makeFakePaths>;

  beforeEach(async () => {
    resetState();
    root = await makeTmpRoot();
    paths = makeFakePaths(root);
    captureInit({ agentContext: "primary", sessionId: "s-6", hermesHome: paths.hermesHome });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trip: an eligible write reaches the remote (a fresh clone sees it)", async () => {
    const { syncRepoDir, remoteDir } = await setupBareRemoteAndClone(root);
    paths.syncRepoDir = syncRepoDir;
    const payload = "portable memory: trace the runtime path before merge-ready";

    const out = await handleToolRemember(
      { content: payload, scope: "global" },
      root,
      syncConfig(remoteDir, true),
      paths,
    );
    expect(out.committed).toBe(true);
    expect(out.synced).toBe(true);

    // Another adapter's view: clone the remote and confirm the entry is there.
    const clone = await cloneRemote(remoteDir, join(root, "verify"));
    const memDir = join(clone, "global", "memory");
    const files = await listMd(memDir);
    expect(files.length).toBe(1);
    const raw = await readFile(join(memDir, files[0]), "utf-8");
    // Portability is about parseable ENTRIES, not just bytes: the file another
    // adapter pulls must parse back to the shared frontmatter shape.
    const { meta, body } = parseFrontmatter(raw);
    expect(meta.type).toBe("memory");
    expect(typeof meta.name).toBe("string");
    expect(body).toContain(payload);
  });

  it("project scope on a non-git cwd resolves _local/ and is push-eligible", async () => {
    const { syncRepoDir, remoteDir } = await setupBareRemoteAndClone(root);
    paths.syncRepoDir = syncRepoDir;
    const nonGitCwd = join(root, "not-a-repo");
    await mkdir(nonGitCwd, { recursive: true });

    const out = await handleToolRemember(
      { content: "local-scoped fact", scope: "project" },
      nonGitCwd,
      syncConfig(remoteDir, true),
      paths,
    );
    expect(out.written).toContain("_local");
    expect(out.committed).toBe(true);
    expect(out.synced).toBe(true); // _local is NOT _session → push-eligible
  });

  it("autoCommitPush=false commits locally but does not push", async () => {
    const { syncRepoDir, remoteDir } = await setupBareRemoteAndClone(root);
    paths.syncRepoDir = syncRepoDir;

    const out = await handleToolRemember(
      { content: "committed not pushed", scope: "global" },
      root,
      syncConfig(remoteDir, false),
      paths,
    );
    expect(out.committed).toBe(true);
    expect(out.synced).toBe(false);

    // The remote must NOT have the entry (only the seed .gitkeep commit).
    const clone = await cloneRemote(remoteDir, join(root, "verify"));
    expect(await listMd(join(clone, "global", "memory"))).toEqual([]);
  });

  it("sync disabled: written but not committed or synced", async () => {
    const out = await handleToolRemember(
      { content: "local only" },
      root,
      DEFAULT_CONFIG, // sync disabled by default
      paths,
    );
    expect(out.committed).toBe(false);
    expect(out.synced).toBe(false);
    await readFile(out.written, "utf-8"); // file still exists on disk
  });

  it("push failure retains the commit locally; a later successful push carries it to the remote", async () => {
    const { syncRepoDir, remoteDir } = await setupBareRemoteAndClone(root);
    paths.syncRepoDir = syncRepoDir;
    const badRepo = join(root, "nonexistent.git"); // not a real repo → push fails fast

    // First write: push targets the bad remote → committed locally, not synced.
    const first = await handleToolRemember(
      { content: "first entry", scope: "global" },
      root,
      syncConfig(badRepo, true, 1),
      paths,
    );
    expect(first.committed).toBe(true);
    expect(first.synced).toBe(false);

    // Recovery: a later write against the real remote pushes BOTH ahead commits.
    const second = await handleToolRemember(
      { content: "second entry", scope: "global" },
      root,
      syncConfig(remoteDir, true),
      paths,
    );
    expect(second.synced).toBe(true);

    const clone = await cloneRemote(remoteDir, join(root, "verify"));
    const memDir = join(clone, "global", "memory");
    const bodies = await Promise.all(
      (await listMd(memDir)).map((f) => readFile(join(memDir, f), "utf-8")),
    );
    const joined = bodies.join("\n---\n");
    expect(joined).toContain("first entry"); // the stranded entry rode the next push
    expect(joined).toContain("second entry");
  });
});
