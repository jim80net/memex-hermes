// main.dispatch routing — each Hermes.* event name must route to the right
// handler. We exercise the dispatch with a fake index/provider so no
// embedding model is loaded.

import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import { HERMES_EVENTS } from "../../src/core/envelope.ts";
import { dispatch } from "../../src/main.ts";
import { resetState } from "../../src/state.ts";
import { FakeEmbeddingProvider, FakeSkillIndex, makeFakePaths, makeTmpRoot } from "./_helpers.ts";

describe("main.dispatch routing", () => {
  let root: string;
  beforeEach(async () => {
    resetState();
    root = await makeTmpRoot();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("routes Hermes.health to handleHealth", async () => {
    const config = { ...DEFAULT_CONFIG };
    const paths = makeFakePaths(root);
    const result = (await dispatch(
      { hook_event_name: HERMES_EVENTS.HEALTH },
      {
        config,
        paths,
        index: new FakeSkillIndex() as never,
        provider: new FakeEmbeddingProvider(),
      },
    )) as { ready: boolean };
    expect(result.ready).toBe(true);
  });

  it("routes Hermes.system-prompt and returns a non-empty block", async () => {
    const config = { ...DEFAULT_CONFIG };
    const paths = makeFakePaths(root);
    const result = (await dispatch(
      { hook_event_name: HERMES_EVENTS.SYSTEM_PROMPT },
      {
        config,
        paths,
        index: new FakeSkillIndex() as never,
        provider: new FakeEmbeddingProvider(),
      },
    )) as { block: string };
    expect(typeof result.block).toBe("string");
    expect(result.block.length).toBeGreaterThan(0);
    expect(result.block).toContain("memex");
  });

  it("routes Hermes.init and returns {ok:true}", async () => {
    const config = { ...DEFAULT_CONFIG };
    const paths = makeFakePaths(root);
    const result = (await dispatch(
      {
        hook_event_name: HERMES_EVENTS.INIT,
        cwd: root,
        session_id: "s-init",
        args: { hermes_home: root, platform: "test", agent_context: "primary" },
      },
      {
        config,
        paths,
        index: new FakeSkillIndex() as never,
        provider: new FakeEmbeddingProvider(),
      },
    )) as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  it("routes Hermes.shutdown", async () => {
    const result = (await dispatch(
      { hook_event_name: HERMES_EVENTS.SHUTDOWN },
      {
        config: { ...DEFAULT_CONFIG },
        paths: makeFakePaths(root),
        index: new FakeSkillIndex() as never,
        provider: new FakeEmbeddingProvider(),
      },
    )) as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  it("routes Hermes.queue-prefetch and returns {}", async () => {
    const result = await dispatch(
      { hook_event_name: HERMES_EVENTS.QUEUE_PREFETCH, args: { query: "abc" } },
      {
        config: { ...DEFAULT_CONFIG },
        paths: makeFakePaths(root),
        index: new FakeSkillIndex() as never,
        provider: new FakeEmbeddingProvider(),
      },
    );
    expect(result).toEqual({});
  });

  it("routes Hermes.session-switch and applies the new session id", async () => {
    const result = (await dispatch(
      {
        hook_event_name: HERMES_EVENTS.SESSION_SWITCH,
        args: { new_session_id: "s2", reset: false },
      },
      {
        config: { ...DEFAULT_CONFIG },
        paths: makeFakePaths(root),
        index: new FakeSkillIndex() as never,
        provider: new FakeEmbeddingProvider(),
      },
    )) as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  it("rejects unknown events with structured error", async () => {
    const result = (await dispatch(
      { hook_event_name: "Hermes.bogus" as never },
      {
        config: { ...DEFAULT_CONFIG },
        paths: makeFakePaths(root),
        index: new FakeSkillIndex() as never,
        provider: new FakeEmbeddingProvider(),
      },
    )) as { error: string };
    expect(result.error).toBe("unknown_event");
  });
});
