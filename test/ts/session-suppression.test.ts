// D7 / hermes-sync-bridge "Session-fallback project IDs never push to the
// remote sync repo" + "Promotion to a named project via memex_remember".

import { execFile } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HermesConfig } from "../../src/core/config.ts";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import { isSessionProjectId, resolveHermesProjectId } from "../../src/core/sync-helpers.ts";
import { handleToolRemember } from "../../src/hooks/tool-remember.ts";
import { captureInit, resetState } from "../../src/state.ts";
import { makeFakePaths, makeTmpRoot, setupBareRemoteAndClone } from "./_helpers.ts";

const execFileAsync = promisify(execFile);

describe("isSessionProjectId", () => {
  it("matches the _session/ prefix", () => {
    expect(isSessionProjectId("_session/abc")).toBe(true);
  });
  it("does not match _local or normal project IDs", () => {
    expect(isSessionProjectId("_local/foo")).toBe(false);
    expect(isSessionProjectId("github.com/foo/bar")).toBe(false);
  });
});

describe("resolveHermesProjectId — _session fallback when cwd is missing", () => {
  it("returns _session/<session_id> when cwd is empty", async () => {
    const id = await resolveHermesProjectId("", "abc-123", DEFAULT_CONFIG.sync);
    expect(id).toBe("_session/abc-123");
  });

  it("returns _session/unknown when neither cwd nor sessionId is given", async () => {
    const id = await resolveHermesProjectId(undefined, "", DEFAULT_CONFIG.sync);
    expect(id).toBe("_session/unknown");
  });

  it("delegates to memex-core for non-empty cwd (git repo case)", async () => {
    const root = await makeTmpRoot();
    try {
      await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
      await execFileAsync(
        "git",
        ["remote", "add", "origin", "git@github.com:jim80net/memex-hermes.git"],
        { cwd: root },
      );
      const id = await resolveHermesProjectId(root, "any", DEFAULT_CONFIG.sync);
      expect(id).toBe("github.com/jim80net/memex-hermes");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("memex_remember promotion / suppression (D7)", () => {
  let root: string;
  let paths: ReturnType<typeof makeFakePaths>;

  beforeEach(async () => {
    resetState();
    root = await makeTmpRoot();
    paths = makeFakePaths(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("scope=session writes under _session/<id> and reports synced=false", async () => {
    captureInit({
      agentContext: "primary",
      sessionId: "sess-xyz",
      hermesHome: paths.hermesHome,
    });
    const config: HermesConfig = {
      ...DEFAULT_CONFIG,
      sync: {
        ...DEFAULT_CONFIG.sync,
        enabled: true,
        repo: "git@example.com:foo/bar.git",
      },
    };
    const out = await handleToolRemember({ content: "Z", scope: "session" }, root, config, paths);
    expect(out.written).toContain(`_session${sep}sess-xyz`);
    expect(out.synced).toBe(false);
  });

  it("explicit projectName bypasses the session id and reports synced=true", async () => {
    captureInit({
      agentContext: "primary",
      sessionId: "sess-xyz",
      hermesHome: paths.hermesHome,
    });
    // synced now means "committed AND pushed", so this needs a real remote.
    const { syncRepoDir, remoteDir } = await setupBareRemoteAndClone(root);
    paths.syncRepoDir = syncRepoDir;
    const config: HermesConfig = {
      ...DEFAULT_CONFIG,
      sync: { ...DEFAULT_CONFIG.sync, enabled: true, repo: remoteDir },
    };
    const out = await handleToolRemember(
      { content: "X", scope: "project", projectName: "named-proj" },
      "",
      config,
      paths,
    );
    expect(out.written).toContain("named-proj");
    expect(out.written).not.toContain("_session");
    expect(out.committed).toBe(true);
    expect(out.synced).toBe(true);
  });

  it("local-cache write still happens when sync is disabled (no push, file exists)", async () => {
    captureInit({
      agentContext: "primary",
      sessionId: "s",
      hermesHome: paths.hermesHome,
    });
    const out = await handleToolRemember(
      { content: "local only", scope: "project" },
      root,
      DEFAULT_CONFIG,
      paths,
    );
    // File exists at the reported path.
    await access(out.written);
    expect(out.synced).toBe(false);
  });

  // _session/* + sync.enabled + autoCommitPush: the path lands in the local
  // repo but no push is attempted. We cover the no-push behavior at the
  // mirror level via memory-write.test.ts; here we just confirm tool-level
  // synced=false reporting.
  it("session-fallback project IDs report synced=false regardless of autoCommitPush", async () => {
    captureInit({
      agentContext: "primary",
      sessionId: "uuid-9",
      hermesHome: paths.hermesHome,
    });
    const config: HermesConfig = {
      ...DEFAULT_CONFIG,
      sync: {
        ...DEFAULT_CONFIG.sync,
        enabled: true,
        autoCommitPush: true,
        repo: "git@example.com:foo/bar.git",
      },
    };
    // initialize a placeholder repo so writeFile doesn't fail later.
    await mkdir(paths.syncRepoDir, { recursive: true });
    await writeFile(join(paths.syncRepoDir, ".gitkeep"), "");

    const out = await handleToolRemember({ content: "session-bound" }, "", config, paths);
    expect(out.synced).toBe(false);
  });
});
