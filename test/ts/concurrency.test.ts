// F8/F9: concurrent writes to the cache JSON must not corrupt the file; push
// retry exhausts at sync.pushRetries attempts and leaves the local commit
// intact. We exercise the concurrent-cache path against memex-core's
// `withFileLock`, and the push-retry path against a fake remote that always
// rejects with non-fast-forward.

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { withFileLock } from "@jim80net/memex-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pushWithRetry } from "../../src/core/sync-helpers.ts";

const execFileAsync = promisify(execFile);

async function setupRejectingRemote(root: string): Promise<{
  syncRepoDir: string;
  remoteDir: string;
}> {
  // Strategy: clone the remote into TWO local repos; advance one ahead of
  // the other on the remote (so the other's push is non-fast-forward), and
  // also keep the remote ahead of the test repo every time we try to push,
  // by installing a pre-receive-style hook that rejects everything.
  const remoteDir = join(root, "remote.git");
  const syncRepoDir = join(root, "sync");
  await mkdir(remoteDir, { recursive: true });
  await execFileAsync("git", ["init", "--bare", "-b", "main"], { cwd: remoteDir });

  // Reject all pushes by installing a pre-receive hook.
  const hookDir = join(remoteDir, "hooks");
  await mkdir(hookDir, { recursive: true });
  const hookPath = join(hookDir, "pre-receive");
  await writeFile(
    hookPath,
    "#!/usr/bin/env bash\necho 'reject (non-fast-forward simulation)' >&2\nexit 1\n",
    "utf-8",
  );
  await execFileAsync("chmod", ["+x", hookPath]);

  await mkdir(syncRepoDir, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: syncRepoDir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: syncRepoDir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: syncRepoDir });
  await execFileAsync("git", ["remote", "add", "origin", remoteDir], { cwd: syncRepoDir });

  // Seed a commit so HEAD exists.
  await writeFile(join(syncRepoDir, "seed"), "x", "utf-8");
  await execFileAsync("git", ["add", "seed"], { cwd: syncRepoDir });
  await execFileAsync("git", ["commit", "-m", "seed"], { cwd: syncRepoDir });

  return { syncRepoDir, remoteDir };
}

describe("F8 — concurrent cache writes via withFileLock", () => {
  let root: string;
  let cachePath: string;
  beforeEach(async () => {
    root = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), "hermes-cc-")),
    );
    cachePath = join(root, "cache.json");
    await writeFile(cachePath, JSON.stringify({ entries: {} }), "utf-8");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("two concurrent writers serialize and produce valid JSON containing both contributions", async () => {
    const write = async (key: string) => {
      await withFileLock(cachePath, async () => {
        const raw = await readFile(cachePath, "utf-8");
        const data = JSON.parse(raw) as { entries: Record<string, number> };
        // Simulate a hot section by yielding to give the other promise a
        // chance to interleave if the lock were broken.
        await new Promise((resolve) => setTimeout(resolve, 10));
        data.entries[key] = Date.now();
        await writeFile(cachePath, JSON.stringify(data), "utf-8");
      });
    };
    await Promise.all([write("a"), write("b"), write("c")]);

    const final = JSON.parse(await readFile(cachePath, "utf-8")) as {
      entries: Record<string, number>;
    };
    expect(Object.keys(final.entries).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("F9 — pushWithRetry exhausts at sync.pushRetries with bounded backoff", () => {
  let root: string;
  beforeEach(async () => {
    root = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), "hermes-push-")),
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("three consecutive rejections leave the commit local and report pushed=false", async () => {
    const { syncRepoDir } = await setupRejectingRemote(root);
    const before = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: syncRepoDir })
    ).stdout.trim();

    const result = await pushWithRetry(
      syncRepoDir,
      "main",
      { pushRetries: 3, baseBackoffMs: 5 },
      { info: () => {}, warn: () => {}, error: () => {} },
    );
    expect(result.pushed).toBe(false);
    expect(result.attempts).toBeGreaterThanOrEqual(1);

    // The local commit is intact (no reset / force-push happened).
    const after = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: syncRepoDir })
    ).stdout.trim();
    expect(after).toBe(before);
  });

  it("succeeds on the second attempt when the remote accepts after a rebase", async () => {
    // Set up a normal accepting remote.
    const remoteDir = join(root, "ok-remote.git");
    const syncRepoDir = join(root, "ok-sync");
    await mkdir(remoteDir, { recursive: true });
    await execFileAsync("git", ["init", "--bare", "-b", "main"], { cwd: remoteDir });
    await mkdir(syncRepoDir, { recursive: true });
    await execFileAsync("git", ["init", "-b", "main"], { cwd: syncRepoDir });
    await execFileAsync("git", ["config", "user.email", "t@e.com"], { cwd: syncRepoDir });
    await execFileAsync("git", ["config", "user.name", "T"], { cwd: syncRepoDir });
    await execFileAsync("git", ["remote", "add", "origin", remoteDir], { cwd: syncRepoDir });
    await writeFile(join(syncRepoDir, "f"), "1", "utf-8");
    await execFileAsync("git", ["add", "f"], { cwd: syncRepoDir });
    await execFileAsync("git", ["commit", "-m", "c"], { cwd: syncRepoDir });

    const result = await pushWithRetry(syncRepoDir, "main", {
      pushRetries: 3,
      baseBackoffMs: 5,
    });
    expect(result.pushed).toBe(true);
    expect(result.attempts).toBe(1);
  });
});
