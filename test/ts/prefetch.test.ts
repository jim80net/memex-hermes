// Hermes.prefetch — disclosure rules per hermes-engine-events R2:
//   - rule first match: full content
//   - rule subsequent match: one-liner reminder
//   - memory: always full body
//   - skill: name + description teaser
//   - no matches above threshold → {}
//   - top-K cap respected; injected entries recorded for telemetry attribution

import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HermesConfig } from "../../src/core/config.ts";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import { handlePrefetch } from "../../src/hooks/prefetch.ts";
import { getState, resetState } from "../../src/state.ts";
import { FakeSkillIndex, makeFakePaths, makeSkill, makeTmpRoot } from "./_helpers.ts";

describe("handlePrefetch", () => {
  let root: string;
  beforeEach(async () => {
    resetState();
    root = await makeTmpRoot();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns {} when no matches clear the threshold", async () => {
    const idx = new FakeSkillIndex([
      { skill: makeSkill({ name: "low" }), score: 0.1, bestQueryIndex: 0 },
    ]);
    const paths = makeFakePaths(root);
    const out = await handlePrefetch(
      { query: "anything" },
      idx as never,
      DEFAULT_CONFIG,
      paths,
      "s1",
    );
    expect(out).toEqual({});
  });

  it("returns {} when args.query is empty / whitespace", async () => {
    const out = await handlePrefetch(
      { query: "   " },
      new FakeSkillIndex() as never,
      DEFAULT_CONFIG,
      makeFakePaths(root),
      "s1",
    );
    expect(out).toEqual({});
  });

  it("rule first-match in session → full content; second-match → one-liner reminder", async () => {
    const rule = makeSkill({
      name: "code-review-rule",
      type: "rule",
      oneLiner: "Always read source before claiming behavior.",
    });
    const bodies = new Map<string, string>([[rule.location, "FULL RULE BODY"]]);
    const idx = new FakeSkillIndex([{ skill: rule, score: 0.9, bestQueryIndex: 0 }], bodies);
    const paths = makeFakePaths(root);

    const first = await handlePrefetch(
      { query: "code review" },
      idx as never,
      DEFAULT_CONFIG,
      paths,
      "s-rule",
    );
    expect((first as { additionalContext?: string }).additionalContext).toContain("FULL RULE BODY");

    const second = await handlePrefetch(
      { query: "code review again" },
      idx as never,
      DEFAULT_CONFIG,
      paths,
      "s-rule",
    );
    const ctx2 = (second as { additionalContext?: string }).additionalContext ?? "";
    expect(ctx2).toContain("Rule reminder:");
    expect(ctx2).toContain("Always read source");
    expect(ctx2).not.toContain("FULL RULE BODY");
  });

  it("memory entries always inject full body", async () => {
    const memory = makeSkill({ name: "deploy-notes", type: "memory" });
    const bodies = new Map<string, string>([[memory.location, "MEMORY FULL BODY"]]);
    const idx = new FakeSkillIndex([{ skill: memory, score: 0.8, bestQueryIndex: 0 }], bodies);
    const out = await handlePrefetch(
      { query: "deploy" },
      idx as never,
      DEFAULT_CONFIG,
      makeFakePaths(root),
      "s-mem",
    );
    expect((out as { additionalContext: string }).additionalContext).toContain("MEMORY FULL BODY");
    expect((out as { additionalContext: string }).additionalContext).toContain("Recalled Memory:");
  });

  it("skill entries inject name + description teaser, not full body", async () => {
    const skill = makeSkill({
      name: "verify-fix-covers-callers",
      type: "skill",
      description: "Trace all callers before declaring a fix complete.",
    });
    const bodies = new Map<string, string>([[skill.location, "MUST NOT APPEAR"]]);
    const idx = new FakeSkillIndex([{ skill, score: 0.7, bestQueryIndex: 0 }], bodies);
    const out = await handlePrefetch(
      { query: "verify fix" },
      idx as never,
      DEFAULT_CONFIG,
      makeFakePaths(root),
      "s-skill",
    );
    const ctx = (out as { additionalContext?: string }).additionalContext ?? "";
    expect(ctx).toContain("Available Skill:");
    expect(ctx).toContain("verify-fix-covers-callers");
    expect(ctx).toContain("Trace all callers");
    expect(ctx).not.toContain("MUST NOT APPEAR");
  });

  it("caps total injected chars by maxInjectedChars", async () => {
    const bigBody = "x".repeat(5000);
    const a = makeSkill({ name: "a", type: "memory" });
    const b = makeSkill({ name: "b", type: "memory" });
    const c = makeSkill({ name: "c", type: "memory" });
    const idx = new FakeSkillIndex(
      [
        { skill: a, score: 0.9, bestQueryIndex: 0 },
        { skill: b, score: 0.85, bestQueryIndex: 0 },
        { skill: c, score: 0.8, bestQueryIndex: 0 },
      ],
      new Map([
        [a.location, bigBody],
        [b.location, bigBody],
        [c.location, bigBody],
      ]),
    );
    const config: HermesConfig = {
      ...DEFAULT_CONFIG,
      prefetch: { ...DEFAULT_CONFIG.prefetch, maxInjectedChars: 6000, topK: 10 },
    };
    const out = await handlePrefetch(
      { query: "anything" },
      idx as never,
      config,
      makeFakePaths(root),
      "s-cap",
    );
    const ctx = (out as { additionalContext: string }).additionalContext;
    // First entry fits, second doesn't (~5000 each + headers). Only 1 should appear.
    expect(ctx.split("Recalled Memory:").length - 1).toBe(1);
  });

  it("records injected entries on process state for telemetry attribution", async () => {
    const memory = makeSkill({ name: "m1", type: "memory" });
    const bodies = new Map([[memory.location, "body"]]);
    const idx = new FakeSkillIndex([{ skill: memory, score: 0.9, bestQueryIndex: 2 }], bodies);
    await handlePrefetch(
      { query: "m1" },
      idx as never,
      DEFAULT_CONFIG,
      makeFakePaths(root),
      "s-tel",
    );
    expect(getState().lastPrefetchInjections).toEqual([
      { location: memory.location, bestQueryIndex: 2 },
    ]);
  });

  it("respects top-K capping from config.prefetch.topK", async () => {
    const skills = [0.95, 0.9, 0.85, 0.8].map((score, i) => ({
      skill: makeSkill({ name: `m${i}`, type: "memory" }),
      score,
      bestQueryIndex: 0,
    }));
    const bodies = new Map<string, string>();
    for (const s of skills) bodies.set(s.skill.location, "short body");
    const idx = new FakeSkillIndex(skills, bodies);

    const config: HermesConfig = {
      ...DEFAULT_CONFIG,
      prefetch: { ...DEFAULT_CONFIG.prefetch, topK: 2 },
    };
    const out = await handlePrefetch(
      { query: "anything" },
      idx as never,
      config,
      makeFakePaths(root),
      "s-topk",
    );
    const ctx = (out as { additionalContext: string }).additionalContext;
    expect(ctx.split("Recalled Memory:").length - 1).toBe(2);
    expect(idx.lastSearch?.topK).toBe(2);
  });

  it("filters by configured prefetch.types", async () => {
    const idx = new FakeSkillIndex([
      {
        skill: makeSkill({ name: "skill1", type: "skill" }),
        score: 0.9,
        bestQueryIndex: 0,
      },
    ]);
    const config: HermesConfig = {
      ...DEFAULT_CONFIG,
      prefetch: { ...DEFAULT_CONFIG.prefetch, types: ["memory"] },
    };
    await handlePrefetch({ query: "skill1" }, idx as never, config, makeFakePaths(root), "s-types");
    expect(idx.lastSearch?.types).toEqual(["memory"]);
  });
});
