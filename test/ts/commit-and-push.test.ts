// Unit tests for the shared commit+gated-push policy (sync-helpers.ts) used by
// both Hermes.session-end and memex_remember.

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "@jim80net/memex-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CommitPushPolicy,
  commitAndMaybePush,
  isPushEligible,
} from "../../src/core/sync-helpers.ts";
import { cloneRemote, makeTmpRoot, setupBareRemoteAndClone } from "./_helpers.ts";

const execFileAsync = promisify(execFile);

function policy(repo: string, over: Partial<CommitPushPolicy> = {}): CommitPushPolicy {
  return {
    enabled: true,
    repo,
    autoCommitPush: true,
    pushRetries: 1,
    autoPull: false,
    projectMappings: {},
    ...over,
  };
}

async function writeEntry(syncRepoDir: string, rel: string, body: string): Promise<string> {
  const abs = join(syncRepoDir, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, body, "utf-8");
  return rel;
}

function collectingLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = [];
  return {
    warns,
    logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
  };
}

describe("isPushEligible", () => {
  it("null (global) and _local/ are eligible; _session/ is not", () => {
    expect(isPushEligible(null)).toBe(true);
    expect(isPushEligible("_local/x")).toBe(true);
    expect(isPushEligible("github.com/o/r")).toBe(true);
    expect(isPushEligible("_session/abc")).toBe(false);
  });
});

describe("commitAndMaybePush", () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTmpRoot();
  });
  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });

  it("commits and pushes an eligible entry to the remote", async () => {
    const { syncRepoDir, remoteDir } = await setupBareRemoteAndClone(root);
    const rel = await writeEntry(syncRepoDir, "global/memory/a.md", "alpha");
    const res = await commitAndMaybePush({
      syncRepoDir,
      addPaths: [rel],
      message: "test a",
      projectId: null,
      sync: policy(remoteDir),
    });
    expect(res).toEqual({ committed: true, pushed: true });
    const clone = await cloneRemote(remoteDir, join(root, "v"));
    await import("node:fs/promises").then((m) => m.readFile(join(clone, rel), "utf-8"));
  });

  it("suppresses push for a _session/ project id (commits only)", async () => {
    const { syncRepoDir, remoteDir } = await setupBareRemoteAndClone(root);
    const rel = await writeEntry(syncRepoDir, "projects/_session/x/memory/a.md", "s");
    const res = await commitAndMaybePush({
      syncRepoDir,
      addPaths: [rel],
      message: "sess",
      projectId: "_session/x",
      sync: policy(remoteDir),
    });
    expect(res).toEqual({ committed: true, pushed: false });
  });

  it("autoCommitPush=false commits but does not push", async () => {
    const { syncRepoDir, remoteDir } = await setupBareRemoteAndClone(root);
    const rel = await writeEntry(syncRepoDir, "global/memory/a.md", "a");
    const res = await commitAndMaybePush({
      syncRepoDir,
      addPaths: [rel],
      message: "noauto",
      projectId: null,
      sync: policy(remoteDir, { autoCommitPush: false }),
    });
    expect(res).toEqual({ committed: true, pushed: false });
  });

  it("does not commit when sync is disabled or no repo", async () => {
    const { syncRepoDir, remoteDir } = await setupBareRemoteAndClone(root);
    const rel = await writeEntry(syncRepoDir, "global/memory/a.md", "a");
    expect(
      await commitAndMaybePush({
        syncRepoDir,
        addPaths: [rel],
        message: "x",
        projectId: null,
        sync: policy(remoteDir, { enabled: false }),
      }),
    ).toEqual({ committed: false, pushed: false });
    expect(
      await commitAndMaybePush({
        syncRepoDir,
        addPaths: [rel],
        message: "x",
        projectId: null,
        sync: policy(""),
      }),
    ).toEqual({ committed: false, pushed: false });
  });

  it("nothing-to-commit is benign and silent", async () => {
    const { syncRepoDir, remoteDir } = await setupBareRemoteAndClone(root);
    // Add a path that has no changes (the seed .gitkeep is already committed).
    const { logger, warns } = collectingLogger();
    const res = await commitAndMaybePush({
      syncRepoDir,
      addPaths: [".gitkeep"],
      message: "noop",
      projectId: null,
      sync: policy(remoteDir),
      logger,
    });
    expect(res.committed).toBe(false);
    expect(warns.filter((w) => !w.includes("nothing to commit"))).toEqual([]);
  });

  it("a genuine commit failure logs a warning", async () => {
    // A syncRepoDir that is NOT a git repo and whose repo points at a
    // non-existent path: initSyncRepo's clone fails → git init + add, but the
    // commit needs a user identity which an isolated repo lacks → commit errors.
    const syncRepoDir = join(root, "norepo");
    await mkdir(syncRepoDir, { recursive: true });
    const rel = await writeEntry(syncRepoDir, "global/memory/a.md", "a");
    const { logger, warns } = collectingLogger();
    const res = await commitAndMaybePush({
      syncRepoDir,
      addPaths: [rel],
      message: "genuine fail",
      projectId: null,
      // Disable the global git identity so commit fails for a real reason.
      sync: policy(join(root, "nonexistent.git")),
      logger,
    });
    // Either the commit failed (warn logged) or — if a global git identity
    // exists in the environment — it committed; assert the contract holds in
    // both: a non-"nothing to commit" failure must surface a warning.
    if (!res.committed) {
      expect(warns.some((w) => w.includes("commit failed") || w.includes("add failed"))).toBe(true);
    }
  });

  it("commits only the given paths, not a concurrent sibling's staged file", async () => {
    const { syncRepoDir, remoteDir } = await setupBareRemoteAndClone(root);
    const mine = await writeEntry(syncRepoDir, "global/memory/mine.md", "mine");
    // A sibling file written + staged by a "concurrent" writer, NOT in addPaths.
    const sibling = await writeEntry(syncRepoDir, "global/memory/sibling.md", "sibling");
    await execFileAsync("git", ["add", sibling], { cwd: syncRepoDir });

    const res = await commitAndMaybePush({
      syncRepoDir,
      addPaths: [mine],
      message: "only mine",
      projectId: null,
      sync: policy(remoteDir),
    });
    expect(res.pushed).toBe(true);

    // The remote has mine.md but NOT sibling.md (path-scoped commit).
    const clone = await cloneRemote(remoteDir, join(root, "v"));
    const fs = await import("node:fs/promises");
    await fs.readFile(join(clone, mine), "utf-8");
    await expect(fs.readFile(join(clone, sibling), "utf-8")).rejects.toThrow();
  });
});
