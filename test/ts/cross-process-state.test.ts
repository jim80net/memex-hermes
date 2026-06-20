// P2-1 — per-session context must cross the subprocess boundary.
//
// The binary is single-shot: captureInit only runs in the separate Hermes.init
// subprocess, so every OTHER event lands in a fresh process where STATE is
// empty. dispatch() must therefore seed sessionId + agent_context from THIS
// invocation's envelope before routing, so the memory-write suppression gate
// and the sessionId stamped on mirror commits are correct on every call —
// NOT just inside the init process.

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import { HERMES_EVENTS } from "../../src/core/envelope.ts";
import { dispatch } from "../../src/main.ts";
import { getState, resetState } from "../../src/state.ts";
import { FakeEmbeddingProvider, FakeSkillIndex, makeFakePaths, makeTmpRoot } from "./_helpers.ts";

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

function fakeDeps(root: string) {
  return {
    config: { ...DEFAULT_CONFIG },
    paths: makeFakePaths(root),
    index: new FakeSkillIndex() as never,
    provider: new FakeEmbeddingProvider(),
  };
}

describe("dispatch seeds per-invocation state (P2-1)", () => {
  let root: string;
  beforeEach(async () => {
    resetState();
    root = await makeTmpRoot();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("memory-write with agent_context=subagent suppresses the write with NO prior init", async () => {
    const deps = fakeDeps(root);
    await initLocalRepo(deps.paths.syncRepoDir);

    // No Hermes.init in this process — STATE is the empty default. The gate
    // must therefore read agent_context from the envelope's args, not STATE.
    const out = (await dispatch(
      {
        hook_event_name: HERMES_EVENTS.MEMORY_WRITE,
        cwd: root,
        session_id: "s-sub",
        args: {
          action: "add",
          target: "memory",
          content: "should be suppressed",
          agent_context: "subagent",
        },
      },
      deps,
    )) as { committed: boolean; suppressed?: string };

    expect(out.committed).toBe(false);
    expect(out.suppressed).toContain("subagent");
  });

  it("memory-write with agent_context=primary commits (gate reads envelope, not stale STATE)", async () => {
    const deps = fakeDeps(root);
    await initLocalRepo(deps.paths.syncRepoDir);

    const out = (await dispatch(
      {
        hook_event_name: HERMES_EVENTS.MEMORY_WRITE,
        cwd: root,
        session_id: "s-prim",
        args: {
          action: "add",
          target: "memory",
          content: "primary write commits",
          agent_context: "primary",
        },
      },
      deps,
    )) as { committed: boolean };

    expect(out.committed).toBe(true);
  });

  it("getState().sessionId reflects the envelope session_id after a memory-write dispatch", async () => {
    const deps = fakeDeps(root);
    await initLocalRepo(deps.paths.syncRepoDir);

    await dispatch(
      {
        hook_event_name: HERMES_EVENTS.MEMORY_WRITE,
        cwd: root,
        session_id: "s-seeded",
        args: { action: "add", target: "memory", content: "x", agent_context: "primary" },
      },
      deps,
    );

    expect(getState().sessionId).toBe("s-seeded");
  });

  it("getState().sessionId reflects the envelope session_id after a sync-turn dispatch", async () => {
    const deps = fakeDeps(root);
    // sync-turn's mtime watcher needs the memories/cache dirs but no memory
    // files exist, so it's a no-op; we only assert the seed landed.
    await dispatch(
      {
        hook_event_name: HERMES_EVENTS.SYNC_TURN,
        cwd: root,
        session_id: "s-sync",
        args: { user_content: "u", assistant_content: "a" },
      },
      deps,
    );

    expect(getState().sessionId).toBe("s-sync");
  });

  it("the metadata.execution_context gate still fires even when args.agent_context is primary", async () => {
    const deps = fakeDeps(root);
    await initLocalRepo(deps.paths.syncRepoDir);

    const out = (await dispatch(
      {
        hook_event_name: HERMES_EVENTS.MEMORY_WRITE,
        cwd: root,
        session_id: "s-meta",
        args: {
          action: "replace",
          target: "memory",
          content: "meta suppressed",
          agent_context: "primary",
          metadata: { execution_context: "cron" },
        },
      },
      deps,
    )) as { committed: boolean; suppressed?: string };

    expect(out.committed).toBe(false);
    expect(out.suppressed).toContain("cron");
  });
});
