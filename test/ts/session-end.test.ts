// P2-3 — session-end learnings.
//
//   1. YAML-frontmatter sanitization: an LLM-provided name/description carrying
//      a colon, double-quote, and newline must still produce PARSEABLE
//      frontmatter (formatLearningFile).
//   2. Push: committed learnings must reach the remote (the next sync-turn's
//      mtime-watcher only watches MEMORY.md/USER.md, so without an explicit
//      push they never sync). Push fires for a normal project and is SKIPPED
//      for `_session/*` project IDs.

import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type HermesConfig } from "../../src/core/config.ts";
import { formatLearningFile, handleSessionEnd } from "../../src/hooks/session-end.ts";
import { captureInit, resetState } from "../../src/state.ts";
import { makeFakePaths, makeTmpRoot, setupBareRemoteAndClone } from "./_helpers.ts";

const execFileAsync = promisify(execFile);

// ---- 1. YAML sanitization --------------------------------------------------

describe("formatLearningFile — YAML frontmatter is sanitized (P2-3 / OCR L1)", () => {
  it("a name/description with colon, quote, and newline yields parseable frontmatter", () => {
    const out = formatLearningFile({
      name: 'danger: a "quoted"\nname',
      description: 'has: a colon, a "quote", and\na newline',
      body: "the body\nwith lines",
    });

    // Frontmatter is the block between the first two `---` fences.
    const m = out.match(/^---\n([\s\S]*?)\n---\n/);
    expect(m).not.toBeNull();
    const fm = (m as RegExpMatchArray)[1];
    const lines = fm.split("\n");

    // Exactly three keys, each a single line — no value bled onto a new line.
    const nameLine = lines.find((l) => l.startsWith("name:")) ?? "";
    const descLine = lines.find((l) => l.startsWith("description:")) ?? "";
    const typeLine = lines.find((l) => l.startsWith("type:")) ?? "";
    expect(nameLine).not.toBe("");
    expect(descLine).not.toBe("");
    expect(typeLine).toBe("type: session-learning");

    // Values are double-quoted scalars; the embedded `"` is escaped and the
    // colon lives safely inside the quotes (no second mapping key created).
    expect(nameLine).toMatch(/^name: ".*"$/);
    expect(descLine).toMatch(/^description: ".*"$/);
    expect(descLine).toContain('\\"quote\\"');
    // The newline is collapsed — only one line per key.
    expect(out.split("\n").filter((l) => l.startsWith("name:")).length).toBe(1);
    expect(out.split("\n").filter((l) => l.startsWith("description:")).length).toBe(1);

    // The body is preserved verbatim after the closing fence.
    expect(out).toContain("the body\nwith lines");
  });
});

// ---- 2. Push behavior ------------------------------------------------------

const ENV_KEYS = ["MEMEX_HERMES_LLM_API_KEY", "OPENAI_API_KEY", "MEMEX_HERMES_LLM_BASE_URL"];

describe("handleSessionEnd — commits are pushed to the remote (P2-3)", () => {
  let root: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    resetState();
    root = await makeTmpRoot();
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // Make extraction return exactly one learning without a real LLM.
    process.env.MEMEX_HERMES_LLM_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      learnings: [
                        { name: "lesson-one", description: "a lesson", body: "body text" },
                      ],
                    }),
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(root, { recursive: true, force: true });
  });

  function syncConfig(repo: string): HermesConfig {
    return {
      ...DEFAULT_CONFIG,
      sessionEnd: {
        ...DEFAULT_CONFIG.sessionEnd,
        extractLearnings: true,
        extractionModel: "test-model",
      },
      sync: {
        ...DEFAULT_CONFIG.sync,
        enabled: true,
        autoCommitPush: true,
        // Point at the real bare remote so initSyncRepo keeps origin intact.
        repo,
      },
    };
  }

  async function remoteHead(remoteDir: string): Promise<string> {
    const { stdout } = await execFileAsync("git", ["log", "-1", "--name-only", "--format="], {
      cwd: remoteDir,
    });
    return stdout;
  }

  it("pushes session-learning files to the remote for a normal project", async () => {
    const { syncRepoDir, remoteDir } = await setupBareRemoteAndClone(root);
    const paths = { ...makeFakePaths(root), syncRepoDir };
    captureInit({ agentContext: "primary", sessionId: "s-end", hermesHome: paths.hermesHome });

    const out = await handleSessionEnd(
      { messages: [{ role: "user", content: "hello" }] },
      root, // real cwd → a normal (non-session) project id
      syncConfig(remoteDir),
      paths,
    );
    expect(out.written).toBe(1);

    // The learning file reached the bare remote's HEAD commit.
    const head = await remoteHead(remoteDir);
    expect(head).toContain("session-learning-");
  });

  it("does NOT push for a _session/* project id (cwd missing)", async () => {
    const { syncRepoDir, remoteDir } = await setupBareRemoteAndClone(root);
    const paths = { ...makeFakePaths(root), syncRepoDir };
    captureInit({ agentContext: "primary", sessionId: "s-only", hermesHome: paths.hermesHome });

    const out = await handleSessionEnd(
      { messages: [{ role: "user", content: "hi" }] },
      "", // no cwd → _session/<id> project id → push suppressed
      syncConfig(remoteDir),
      paths,
    );
    expect(out.written).toBe(1);

    // Remote HEAD is still the seed commit — the learning was committed locally
    // but never pushed.
    const head = await remoteHead(remoteDir);
    expect(head).not.toContain("session-learning-");
  });
});
