// Hermes.session-switch (R4) — re-scopes session id; reset=true flushes
// per-session buffers.

import { beforeEach, describe, expect, it } from "vitest";
import { handleSessionSwitch } from "../../src/hooks/session-switch.ts";
import {
  cacheQueryEmbedding,
  getState,
  recordPrefetchInjections,
  resetState,
  setSystemPromptBlock,
} from "../../src/state.ts";

describe("handleSessionSwitch", () => {
  beforeEach(() => {
    resetState();
  });

  it("updates state.sessionId to the new value", () => {
    const out = handleSessionSwitch({ new_session_id: "s2" });
    expect(out.ok).toBe(true);
    expect(getState().sessionId).toBe("s2");
  });

  it("reset=false preserves per-session buffers (system prompt block, injections, cache)", () => {
    setSystemPromptBlock("CACHED BLOCK");
    recordPrefetchInjections([{ location: "/a", bestQueryIndex: 0 }]);
    cacheQueryEmbedding("q", [0.1, 0.2], 60_000);

    handleSessionSwitch({ new_session_id: "s3", reset: false });

    expect(getState().systemPromptBlock).toBe("CACHED BLOCK");
    expect(getState().lastPrefetchInjections.length).toBe(1);
    expect(getState().queryEmbeddingCache.has("q")).toBe(true);
  });

  it("reset=true flushes per-session buffers", () => {
    setSystemPromptBlock("CACHED BLOCK");
    recordPrefetchInjections([{ location: "/a", bestQueryIndex: 0 }]);
    cacheQueryEmbedding("q", [0.1, 0.2], 60_000);

    handleSessionSwitch({ new_session_id: "s4", reset: true });

    expect(getState().systemPromptBlock).toBeNull();
    expect(getState().lastPrefetchInjections).toEqual([]);
    expect(getState().queryEmbeddingCache.size).toBe(0);
    expect(getState().sessionId).toBe("s4");
  });

  it("ignores missing args", () => {
    const before = getState().sessionId;
    const out = handleSessionSwitch(undefined);
    expect(out.ok).toBe(true);
    expect(getState().sessionId).toBe(before);
  });
});
