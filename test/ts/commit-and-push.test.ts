// Unit tests for the shared commit+gated-push policy (sync-helpers.ts) used by
// both Hermes.session-end and memex_remember.

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    expect(await readFile(join(clone, rel), "utf-8")).toContain("alpha");
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

  it("a genuine (non-benign) git failure logs a warning", async () => {
    // Deterministic genuine failure (env-independent): hold the index lock so
    // `git add`/`git commit` fail for a real reason — NOT the benign
    // "nothing to commit" family — which must surface a warning.
    const { syncRepoDir, remoteDir } = await setupBareRemoteAndClone(root);
    const rel = await writeEntry(syncRepoDir, "global/memory/a.md", "a");
    await writeFile(join(syncRepoDir, ".git", "index.lock"), "", "utf-8");
    const { logger, warns } = collectingLogger();

    const res = await commitAndMaybePush({
      syncRepoDir,
      addPaths: [rel],
      message: "genuine fail",
      projectId: null,
      sync: policy(remoteDir),
      logger,
    });
    expect(res).toEqual({ committed: false, pushed: false });
    expect(warns.some((w) => w.includes("failed"))).toBe(true);
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
    expect(await readFile(join(clone, mine), "utf-8")).toContain("mine");
    await expect(readFile(join(clone, sibling), "utf-8")).rejects.toThrow();
  });
});
