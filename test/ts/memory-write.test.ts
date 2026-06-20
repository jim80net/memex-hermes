// Hermes.memory-write — primary callback path with suppression rules (R5,
// hermes-sync-bridge "Non-primary execution contexts do not mirror or push"
// and "Session-fallback project IDs never push to the remote sync repo").

import { execFile } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HermesConfig } from "../../src/core/config.ts";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import { handleMemoryWrite } from "../../src/hooks/memory-write.ts";
import { captureInit, resetState } from "../../src/state.ts";
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

describe("handleMemoryWrite", () => {
  let root: string;
  let paths: ReturnType<typeof makeFakePaths>;
  let config: HermesConfig;

  beforeEach(async () => {
    resetState();
    root = await makeTmpRoot();
    paths = makeFakePaths(root);
    await initLocalRepo(paths.syncRepoDir);
    config = { ...DEFAULT_CONFIG };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("successful add/replace writes the mirror file and commits", async () => {
    captureInit({
      agentContext: "primary",
      sessionId: "s-primary",
      hermesHome: paths.hermesHome,
    });
    const out = await handleMemoryWrite(
      {
        action: "add",
        target: "memory",
        content: "new memory body",
        metadata: { write_origin: "remember", session_id: "s-primary" },
      },
      root,
      config,
      paths,
    );
    expect(out.committed).toBe(true);

    // Mirror file landed somewhere under projects/_local/<encoded>/memory/MEMORY.md
    const projectsDir = join(paths.syncRepoDir, "projects");
    await access(projectsDir);
  });

  it("suppressed when state.agentContext is 'subagent'", async () => {
    captureInit({ agentContext: "subagent", sessionId: "s-sub", hermesHome: paths.hermesHome });
    const out = await handleMemoryWrite(
      { action: "add", target: "memory", content: "should not mirror" },
      root,
      config,
      paths,
    );
    expect(out.committed).toBe(false);
    expect(out.suppressed).toMatch(/non-primary/);
  });

  it("suppressed when state.agentContext is 'cron'", async () => {
    captureInit({ agentContext: "cron", sessionId: "s-cron", hermesHome: paths.hermesHome });
    const out = await handleMemoryWrite(
      { action: "add", target: "memory", content: "cron write" },
      root,
      config,
      paths,
    );
    expect(out.committed).toBe(false);
    expect(out.suppressed).toContain("cron");
  });

  it("suppressed when state.agentContext is 'flush'", async () => {
    captureInit({ agentContext: "flush", sessionId: "s-flush", hermesHome: paths.hermesHome });
    const out = await handleMemoryWrite(
      { action: "add", target: "memory", content: "flush write" },
      root,
      config,
      paths,
    );
    expect(out.committed).toBe(false);
    expect(out.suppressed).toContain("flush");
  });

  it("suppressed when metadata.execution_context is non-primary even with primary captured", async () => {
    captureInit({ agentContext: "primary", sessionId: "s-meta", hermesHome: paths.hermesHome });
    const out = await handleMemoryWrite(
      {
        action: "replace",
        target: "memory",
        content: "subagent meta write",
        metadata: { execution_context: "subagent" },
      },
      root,
      config,
      paths,
    );
    expect(out.committed).toBe(false);
    expect(out.suppressed).toContain("subagent");
  });

  it("returns suppressed when mirrorHermesMemory=false", async () => {
    captureInit({ agentContext: "primary", sessionId: "s-x", hermesHome: paths.hermesHome });
    const out = await handleMemoryWrite(
      { action: "add", target: "memory", content: "ignored" },
      root,
      { ...config, mirrorHermesMemory: false },
      paths,
    );
    expect(out.committed).toBe(false);
    expect(out.suppressed).toMatch(/disabled/);
  });

  it("'remove' action is reported as suppressed (mtime watcher handles it)", async () => {
    captureInit({ agentContext: "primary", sessionId: "s-rm", hermesHome: paths.hermesHome });
    const out = await handleMemoryWrite(
      { action: "remove", target: "memory", content: "" },
      root,
      config,
      paths,
    );
    expect(out.committed).toBe(false);
    expect(out.suppressed).toMatch(/remove/);
  });

  it("returns suppressed when args missing", async () => {
    captureInit({ agentContext: "primary", sessionId: "s-nil", hermesHome: paths.hermesHome });
    const out = await handleMemoryWrite(undefined, root, config, paths);
    expect(out.committed).toBe(false);
    expect(out.suppressed).toMatch(/missing/);
  });
});

describe("handleMemoryWrite — _session/* push suppression", () => {
  let root: string;
  let paths: ReturnType<typeof makeFakePaths>;

  beforeEach(async () => {
    resetState();
    root = await makeTmpRoot();
    paths = makeFakePaths(root);
    await initLocalRepo(paths.syncRepoDir);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("session-fallback project id (cwd missing) commits locally without pushing", async () => {
    captureInit({
      agentContext: "primary",
      sessionId: "session-no-cwd",
      hermesHome: paths.hermesHome,
    });
    // sync is enabled + autoCommitPush but no remote — push is suppressed by
    // _session/* check before any push attempt.
    const config: HermesConfig = {
      ...DEFAULT_CONFIG,
      sync: {
        ...DEFAULT_CONFIG.sync,
        enabled: true,
        autoCommitPush: true,
        repo: "https://example.invalid/repo.git",
      },
    };
    const out = await handleMemoryWrite(
      { action: "add", target: "memory", content: "session content" },
      "",
      config,
      paths,
    );
    // Commit succeeded locally — committed is true; push was skipped by the
    // _session/* gate.
    expect(out.committed).toBe(true);
  });
});
