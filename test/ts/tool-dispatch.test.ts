// Tool dispatch — memex-tool-surface shapes. tool-search/tool-remember/
// tool-recall return shapes match the spec, defaults are applied, threshold
// and limit honored.

import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HermesConfig } from "../../src/core/config.ts";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import { handleToolRecall } from "../../src/hooks/tool-recall.ts";
import { handleToolRemember } from "../../src/hooks/tool-remember.ts";
import { handleToolSearch } from "../../src/hooks/tool-search.ts";
import { captureInit, resetState } from "../../src/state.ts";
import {
  FakeSkillIndex,
  makeFakePaths,
  makeSkill,
  makeTmpRoot,
  setupBareRemoteAndClone,
} from "./_helpers.ts";

describe("handleToolSearch", () => {
  it("returns top-K results above threshold, each with name/type/score/location", async () => {
    const idx = new FakeSkillIndex([
      { skill: makeSkill({ name: "deploy", type: "skill" }), score: 0.9, bestQueryIndex: 0 },
      { skill: makeSkill({ name: "deploy-old", type: "memory" }), score: 0.6, bestQueryIndex: 0 },
      { skill: makeSkill({ name: "low", type: "skill" }), score: 0.3, bestQueryIndex: 0 },
    ]);
    const out = await handleToolSearch(
      { query: "deployment", limit: 5 },
      idx as never,
      DEFAULT_CONFIG,
    );
    expect(out.results.length).toBe(2);
    for (const r of out.results) {
      expect(typeof r.name).toBe("string");
      expect(typeof r.type).toBe("string");
      expect(typeof r.score).toBe("number");
      expect(typeof r.location).toBe("string");
    }
  });

  it("respects the limit parameter", async () => {
    const idx = new FakeSkillIndex(
      Array.from({ length: 10 }, (_, i) => ({
        skill: makeSkill({ name: `r${i}` }),
        score: 0.9 - i * 0.01,
        bestQueryIndex: 0,
      })),
    );
    const out = await handleToolSearch({ query: "foo", limit: 2 }, idx as never, DEFAULT_CONFIG);
    expect(out.results.length).toBe(2);
  });

  it("uses defaultLimit when limit is omitted", async () => {
    const idx = new FakeSkillIndex(
      Array.from({ length: 10 }, (_, i) => ({
        skill: makeSkill({ name: `r${i}` }),
        score: 0.9,
        bestQueryIndex: 0,
      })),
    );
    const out = await handleToolSearch({ query: "foo" }, idx as never, DEFAULT_CONFIG);
    expect(out.results.length).toBe(DEFAULT_CONFIG.tools.memex_search.defaultLimit);
  });

  it("forwards the types filter to the index search", async () => {
    const idx = new FakeSkillIndex([
      { skill: makeSkill({ name: "m", type: "memory" }), score: 0.9, bestQueryIndex: 0 },
    ]);
    await handleToolSearch({ query: "foo", types: ["memory"] }, idx as never, DEFAULT_CONFIG);
    expect(idx.lastSearch?.types).toEqual(["memory"]);
  });

  it("uses the dedicated tools.memex_search.threshold, not prefetch threshold", async () => {
    const idx = new FakeSkillIndex();
    const config: HermesConfig = {
      ...DEFAULT_CONFIG,
      tools: {
        ...DEFAULT_CONFIG.tools,
        memex_search: { enabled: true, defaultLimit: 5, threshold: 0.7 },
      },
      prefetch: { ...DEFAULT_CONFIG.prefetch, threshold: 0.1 },
    };
    await handleToolSearch({ query: "x" }, idx as never, config);
    expect(idx.lastSearch?.threshold).toBe(0.7);
  });

  it("empty query yields empty results", async () => {
    const idx = new FakeSkillIndex();
    const out = await handleToolSearch({ query: "  " }, idx as never, DEFAULT_CONFIG);
    expect(out.results).toEqual([]);
  });
});

describe("handleToolRemember", () => {
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

  it("writes a memory entry under the project memory dir and reports synced=false when sync disabled", async () => {
    captureInit({
      agentContext: "primary",
      sessionId: "s-rem",
      hermesHome: paths.hermesHome,
    });
    const out = await handleToolRemember(
      { content: "# remember this body" },
      root,
      DEFAULT_CONFIG,
      paths,
    );
    expect(out.written.endsWith(".md")).toBe(true);
    expect(out.synced).toBe(false);

    const body = await readFile(out.written, "utf-8");
    expect(body).toContain("type: memory");
    expect(body).toContain("remember this body");
  });

  it("reports committed+synced=true when sync.enabled and project id is not _session/*", async () => {
    captureInit({
      agentContext: "primary",
      sessionId: "s-sync",
      hermesHome: paths.hermesHome,
    });
    // synced now means "committed AND pushed", so this needs a real remote.
    const { syncRepoDir, remoteDir } = await setupBareRemoteAndClone(root);
    paths.syncRepoDir = syncRepoDir;
    const config: HermesConfig = {
      ...DEFAULT_CONFIG,
      sync: { ...DEFAULT_CONFIG.sync, enabled: true, repo: remoteDir },
    };
    const out = await handleToolRemember({ content: "x", scope: "global" }, root, config, paths);
    expect(out.committed).toBe(true);
    expect(out.synced).toBe(true);
  });

  it("session-scoped writes report synced=false", async () => {
    captureInit({
      agentContext: "primary",
      sessionId: "uuid-1",
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
    const out = await handleToolRemember(
      { content: "session-scoped data", scope: "session" },
      "",
      config,
      paths,
    );
    expect(out.synced).toBe(false);
    expect(out.written).toContain("_session");
  });

  it("explicit projectName promotes the write into the named project (no _session/*)", async () => {
    captureInit({
      agentContext: "primary",
      sessionId: "fresh",
      hermesHome: paths.hermesHome,
    });
    const { syncRepoDir, remoteDir } = await setupBareRemoteAndClone(root);
    paths.syncRepoDir = syncRepoDir;
    const config: HermesConfig = {
      ...DEFAULT_CONFIG,
      sync: { ...DEFAULT_CONFIG.sync, enabled: true, repo: remoteDir },
    };
    const out = await handleToolRemember(
      { content: "owned", scope: "project", projectName: "explicit-proj" },
      "",
      config,
      paths,
    );
    expect(out.written).toContain("explicit-proj");
    expect(out.written).not.toContain("_session");
    expect(out.synced).toBe(true);
  });

  it("global-scope write lands under the global memory dir", async () => {
    captureInit({
      agentContext: "primary",
      sessionId: "s",
      hermesHome: paths.hermesHome,
    });
    const out = await handleToolRemember(
      { content: "global", scope: "global" },
      root,
      DEFAULT_CONFIG,
      paths,
    );
    expect(out.written).toContain(join("global", "memory"));
  });

  it("rejects missing content with an Error", async () => {
    await expect(handleToolRemember({ content: "" }, root, DEFAULT_CONFIG, paths)).rejects.toThrow(
      /required/,
    );
  });
});

describe("handleToolRecall", () => {
  it("returns the named entry with its full body (frontmatter stripped)", async () => {
    const skill = makeSkill({ name: "my-skill", type: "skill" });
    const fakeIndex = new FakeSkillIndex(
      [{ skill, score: 0.9, bestQueryIndex: 0 }],
      // The recall handler reads the file from disk, so we need a real file:
    );
    // Recall reads the file from disk; produce a real one in a tmpdir.
    const root = await makeTmpRoot();
    const path = join(root, "SKILL.md");
    const body = "actual content body";
    skill.location = path;
    await writeFile(path, `---\nname: my-skill\ntype: skill\n---\n${body}\n`, "utf-8");
    const out = await handleToolRecall({ name: "my-skill" }, fakeIndex as never);
    expect(out.entries.length).toBe(1);
    expect(out.entries[0].name).toBe("my-skill");
    expect(out.entries[0].content).toBe(body);
    await rm(root, { recursive: true, force: true });
  });

  it("missing entry returns empty entries array", async () => {
    const idx = new FakeSkillIndex();
    const out = await handleToolRecall({ name: "nonexistent" }, idx as never);
    expect(out.entries).toEqual([]);
  });

  it("missing name returns empty entries", async () => {
    const idx = new FakeSkillIndex();
    const out = await handleToolRecall({}, idx as never);
    expect(out.entries).toEqual([]);
  });
});
