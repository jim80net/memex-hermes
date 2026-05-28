import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionState } from "@jim80net/memex-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSessionPath,
  hasRuleBeenShown,
  loadSession,
  markRuleShown,
  saveSession,
} from "../../src/core/session.ts";

describe("session tracker (file-based)", () => {
  let sessionsDir: string;
  beforeEach(async () => {
    sessionsDir = await mkdtemp(join(tmpdir(), "hermes-sessions-"));
  });
  afterEach(async () => {
    await rm(sessionsDir, { recursive: true, force: true });
  });

  it("getSessionPath composes sessionsDir + <id>.json", () => {
    expect(getSessionPath("abc", sessionsDir)).toBe(join(sessionsDir, "abc.json"));
  });

  it("loadSession returns empty state for a missing session", async () => {
    const state = await loadSession("missing", sessionsDir);
    expect(state).toEqual({ sessionId: "missing", shownRules: {} });
  });

  it("loadSession returns empty state for an undefined session id", async () => {
    const state = await loadSession(undefined, sessionsDir);
    expect(state).toEqual({ sessionId: "", shownRules: {} });
  });

  it("round-trips state through save then load", async () => {
    const state: SessionState = { sessionId: "s1", shownRules: { "rules/a.md": 111 } };
    await saveSession(state, sessionsDir);
    const loaded = await loadSession("s1", sessionsDir);
    expect(loaded).toEqual(state);
  });

  it("saveSession is a no-op without a sessionId", async () => {
    await saveSession({ sessionId: "", shownRules: {} }, sessionsDir);
    const loaded = await loadSession("anything", sessionsDir);
    expect(loaded.shownRules).toEqual({});
  });

  it("tolerates a corrupt session file by returning empty state", async () => {
    await writeFile(join(sessionsDir, "corrupt.json"), "{ not valid json");
    const loaded = await loadSession("corrupt", sessionsDir);
    expect(loaded).toEqual({ sessionId: "corrupt", shownRules: {} });
  });

  it("tracks shown rules across save/load", () => {
    const state: SessionState = { sessionId: "s2", shownRules: {} };
    expect(hasRuleBeenShown(state, "skills/my-rule/SKILL.md")).toBe(false);
    markRuleShown(state, "skills/my-rule/SKILL.md");
    expect(hasRuleBeenShown(state, "skills/my-rule/SKILL.md")).toBe(true);
  });

  it("persists shown-rule marks across a subprocess boundary (save/reload)", async () => {
    const state: SessionState = { sessionId: "s3", shownRules: {} };
    markRuleShown(state, "skills/r1/SKILL.md");
    await saveSession(state, sessionsDir);

    const reloaded = await loadSession("s3", sessionsDir);
    expect(hasRuleBeenShown(reloaded, "skills/r1/SKILL.md")).toBe(true);
    expect(hasRuleBeenShown(reloaded, "skills/r2/SKILL.md")).toBe(false);
  });
});
